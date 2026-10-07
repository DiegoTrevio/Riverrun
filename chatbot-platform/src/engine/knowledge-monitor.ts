import { createHash } from 'node:crypto';
import { config, semanticEnabledFor } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { knowledgeIndexStatus } from './knowledge.js';

type Kind = 'pending'|'embedding'|'fallback'|'latency'|'cost'|'delivery'|'configuration';
const labels: Record<Kind,string> = { pending:'Documentos pendientes sin avance', embedding:'Error de embeddings', fallback:'Uso elevado de búsqueda por palabras', latency:'Respuesta semántica lenta', cost:'Revisar costos de IA', delivery:'Mensajes no enviados', configuration:'Búsqueda semántica no disponible' };

export async function accountKnowledgeMetrics(accountId: string, now = new Date()) {
  const account = await store.getAccount(accountId);
  if (!account) throw new Error('Perfil no encontrado');
  const enabled = semanticEnabledFor(accountId) && account.active && account.status !== 'paused' && (account.status !== 'trial' || !!account.trial_ends_at && new Date(account.trial_ends_at)>now);
  const inventory = [];
  for (const bot of await store.listChatbots(accountId)) inventory.push(await knowledgeIndexStatus(bot));
  const pending = enabled ? inventory.reduce((n,r)=>n+r.pending_items,0) : 0;
  const signature = createHash('sha256').update(inventory.filter(r=>r.pending_items).map(r=>r.pending_signature).sort().join('|')).digest('hex');
  const events = await queryOne(`SELECT
    count(*) FILTER (WHERE message='knowledge_embedding')::int AS embedding_attempts,
    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY CASE WHEN message='knowledge_embedding' AND jsonb_typeof(details->'duration_ms')='number' THEN (details->>'duration_ms')::numeric END),0) AS embedding_p95_ms,
    count(*) FILTER (WHERE message='knowledge_embedding' AND details->>'outcome'='error')::int AS embedding_errors,
    count(*) FILTER (WHERE message='knowledge_embedding' AND details->>'outcome'='ok' AND details->>'cost_reported'='false')::int AS unreported_embedding_costs,
    count(*) FILTER (WHERE message='knowledge_search')::int AS attempts,
    count(*) FILTER (WHERE message='knowledge_search' AND details->>'outcome'='fallback')::int AS fallbacks,
    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY CASE WHEN message='knowledge_search' AND jsonb_typeof(details->'duration_ms')='number' THEN (details->>'duration_ms')::numeric END),0) AS p95_ms
    FROM event_logs WHERE account_id=$1 AND message IN ('knowledge_search','knowledge_embedding') AND created_at > $2::timestamptz-interval '1 hour' AND created_at <= $2`,[accountId,now]);
  const usage = await queryOne(`SELECT count(*)::int AS runs, COALESCE(sum(cost_usd),0)::float8 AS recorded_usd,
    count(*) FILTER(WHERE cost_usd=0)::int AS zero_cost_runs FROM ai_runs WHERE account_id=$1 AND created_at > $2::timestamptz-interval '1 hour' AND created_at <= $2`,[accountId,now]);
  const delivery = await queryOne(`SELECT count(*)::int AS failed_messages FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.account_id=$1 AND m.direction='out' AND m.status='failed' AND m.created_at > $2::timestamptz-interval '1 hour' AND m.created_at <= $2`,[accountId,now]);
  return { enabled, available: inventory.every(r=>r.available), key_present: !!config.openai.apiKey, pending_items: pending, pending_signature: signature,
    ...events, fallback_ratio: events!.attempts ? events!.fallbacks/events!.attempts : null, ...usage, ...delivery };
}

/** State, notifications and samples commit together. Row locks deduplicate replicas. */
async function recordAccount(accountId: string, metrics: Awaited<ReturnType<typeof accountKnowledgeMetrics>>, now: Date) {
  return withTransaction(async client => {
    await client.query(`INSERT INTO knowledge_monitor_state(account_id,checked_at) VALUES($1,$2) ON CONFLICT DO NOTHING`,[accountId,now]);
    const previous = (await client.query('SELECT * FROM knowledge_monitor_state WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
    if (new Date(previous.checked_at)>now) return; // Never overwrite a newer snapshot.
    const unchanged = previous.pending_signature===metrics.pending_signature;
    const since = metrics.pending_items ? (unchanged && previous.pending_since ? new Date(previous.pending_since) : now) : null;
    const limits = config.knowledgeMonitor;
    const conditions: Record<Kind,boolean> = {
      pending: !!since && now.getTime()-since.getTime()>=limits.pendingMinutes*60000,
      embedding: metrics.embedding_errors>0,
      fallback: metrics.enabled && metrics.attempts>=limits.minAttempts && metrics.attempts>0 && metrics.fallback_ratio!>limits.fallbackRatio,
      latency: metrics.enabled && ((metrics.attempts>=limits.minAttempts && metrics.attempts>0 && metrics.p95_ms>limits.latencyMs) || (metrics.embedding_attempts>=limits.minAttempts && metrics.embedding_attempts>0 && metrics.embedding_p95_ms>limits.latencyMs)),
      cost: (limits.hourlyUsd>0 && metrics.recorded_usd>limits.hourlyUsd) || metrics.unreported_embedding_costs>0,
      delivery: metrics.failed_messages>0,
      configuration: metrics.enabled && (!metrics.available || !metrics.key_present),
    };
    await client.query(`UPDATE knowledge_monitor_state SET checked_at=$2,pending_since=$3,pending_signature=$4,metrics=$5 WHERE account_id=$1`,[accountId,now,since,metrics.pending_signature,JSON.stringify(metrics)]);
    await client.query('INSERT INTO knowledge_monitor_samples(account_id,observed_at,metrics) VALUES($1,$2,$3)',[accountId,now,JSON.stringify(metrics)]);
    for (const kind of Object.keys(conditions) as Kind[]) {
      await client.query('INSERT INTO knowledge_alerts(account_id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING',[accountId,kind]);
      const prior=(await client.query('SELECT * FROM knowledge_alerts WHERE account_id=$1 AND kind=$2 FOR UPDATE',[accountId,kind])).rows[0];
      const active=conditions[kind];
      const due=active && (!prior.active || !prior.last_notified_at || now.getTime()-new Date(prior.last_notified_at).getTime()>=6*3600000);
      const recovered=!active && prior.active && !!prior.last_notified_at;
      let sent=0;
      if(due || recovered) {
        const title=(recovered?'Resuelto: ':'Aviso: ')+labels[kind];
        const body=recovered ? 'La condición dejó de detectarse en la revisión actual. Consulta la supervisión para verificar el estado.' : `Pendientes: ${metrics.pending_items}. Errores de embeddings (1 h): ${metrics.embedding_errors}. Búsqueda por palabras: ${metrics.fallbacks}/${metrics.attempts}. p95 búsqueda: ${Math.round(metrics.p95_ms)} ms. p95 embeddings: ${Math.round(metrics.embedding_p95_ms)} ms. IA registrada (1 h): US$${Number(metrics.recorded_usd).toFixed(4)}. Embeddings sin costo reportado: ${metrics.unreported_embedding_costs}. Entregas fallidas: ${metrics.failed_messages}.`;
        sent=(await client.query(`INSERT INTO notifications(account_id,user_id,kind,title,body,link)
          SELECT $1,id,'knowledge',$2,$3,$4 FROM users WHERE active AND (role='superadmin' OR (role='admin' AND account_id=$1)) RETURNING id`,[accountId,title,body,`#/logs?account_id=${accountId}`])).rowCount ?? 0;
      }
      await client.query(`UPDATE knowledge_alerts SET active=$3,opened_at=CASE WHEN $3 AND NOT active THEN $4 ELSE opened_at END,
        resolved_at=CASE WHEN NOT $3 AND active THEN $4 WHEN $3 THEN NULL ELSE resolved_at END,
        last_notified_at=CASE WHEN $5 AND $3 THEN $4 ELSE last_notified_at END WHERE account_id=$1 AND kind=$2`,[accountId,kind,active,now,sent>0]);
    }
  });
}

async function recordMonitorFailure(accountId: string, now: Date) {
  await withTransaction(async client => {
    const latest=(await client.query('SELECT checked_at FROM knowledge_monitor_state WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
    if(latest && new Date(latest.checked_at)>now)return;
    await client.query("INSERT INTO knowledge_alerts(account_id,kind) VALUES($1,'configuration') ON CONFLICT DO NOTHING",[accountId]);
    const prior=(await client.query("SELECT * FROM knowledge_alerts WHERE account_id=$1 AND kind='configuration' FOR UPDATE",[accountId])).rows[0];
    const due=!prior.active || !prior.last_notified_at || now.getTime()-new Date(prior.last_notified_at).getTime()>=6*3600000;
    let sent=0;
    if(due)sent=(await client.query(`INSERT INTO notifications(account_id,user_id,kind,title,body,link)
      SELECT $1,id,'knowledge','Aviso: no se pudo completar la supervisión','Revisa PostgreSQL y el inventario de conocimiento. La supervisión no pudo comprobar el estado; el último snapshot puede estar desactualizado.',$2
      FROM users WHERE active AND (role='superadmin' OR (role='admin' AND account_id=$1)) RETURNING id`,[accountId,`#/logs?account_id=${accountId}`])).rowCount ?? 0;
    await client.query(`UPDATE knowledge_alerts SET active=true,opened_at=CASE WHEN NOT active THEN $2 ELSE opened_at END,resolved_at=NULL,
      last_notified_at=CASE WHEN $3 THEN $2 ELSE last_notified_at END WHERE account_id=$1 AND kind='configuration'`,[accountId,now,sent>0]);
  });
}

export async function superviseKnowledge(now = new Date()) {
  if(!config.knowledgeMonitor.enabled) return { checked:0, failed:0 };
  let checked=0,failed=0;
  for(const account of await query<{id:string}>('SELECT id FROM accounts WHERE active ORDER BY id')) {
    try { await recordAccount(account.id,await accountKnowledgeMetrics(account.id,now),now); checked++; }
    catch { failed++; await recordMonitorFailure(account.id,now).catch(()=>undefined); await logEvent({level:'error',source:'system',message:'knowledge_monitor_failed',accountId:account.id,details:{reason:'inventory_or_database'}}).catch(()=>undefined); }
  }
  await query("DELETE FROM knowledge_monitor_samples WHERE observed_at < $1::timestamptz-interval '7 days'",[now]);
  return {checked,failed};
}

export async function knowledgeMonitorReport(accountId: string|null) {
  const accounts=await query(`SELECT a.id,a.name,s.checked_at,s.pending_since,s.metrics,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'opened_at',opened_at,'last_notified_at',last_notified_at)) FROM knowledge_alerts WHERE account_id=a.id AND active),'[]'::jsonb) AS alerts
    FROM accounts a LEFT JOIN knowledge_monitor_state s ON s.account_id=a.id WHERE ($1::uuid IS NULL OR a.id=$1) ORDER BY a.name,a.id`,[accountId]);
  return {enabled:config.knowledgeMonitor.enabled,interval_minutes:5,window_minutes:60,thresholds:config.knowledgeMonitor,accounts};
}

export class KnowledgeMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<unknown>;
  private stopped=true;
  constructor(private run=superviseKnowledge, private intervalMs=300000) {}
  start() {
    if(!this.stopped || !config.knowledgeMonitor.enabled)return;
    this.stopped=false;
    const tick=()=>{
      if(this.stopped)return;
      this.running=this.run().then(result=>{if(result.failed)console.warn('[knowledge] Algunos perfiles no pudieron supervisarse.');}).catch(()=>console.warn('[knowledge] Supervisión incompleta; revisa PostgreSQL.'));
      void this.running.finally(()=>{if(!this.stopped){this.timer=setTimeout(tick,this.intervalMs);this.timer.unref();}});
    };
    tick();
  }
  async stop(){this.stopped=true;clearTimeout(this.timer);await this.running;}
}
