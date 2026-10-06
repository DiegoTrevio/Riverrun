import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { prepareKnowledge } from './knowledge-preparation.js';
import { knowledgeReadiness } from './knowledge-readiness.js';

/** Read-only operator snapshot. Never sends customer text or probes the provider. */
export async function operationalStatus(windowMinutes = 60) {
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) throw new Error('La ventana debe ser de 1 a 1440 minutos.');
  const readiness = await knowledgeReadiness();
  const inventory = await prepareKnowledge({ all: true });
  const search = await queryOne(`SELECT count(*)::int AS attempts,
    count(*) FILTER (WHERE details->>'outcome'='fallback')::int AS fallbacks,
    count(*) FILTER (WHERE details->>'outcome'='selected')::int AS selected,
    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY CASE WHEN jsonb_typeof(details->'duration_ms')='number' THEN (details->>'duration_ms')::numeric END),0) AS p95_ms
    FROM event_logs WHERE source='engine' AND message='knowledge_search' AND created_at >= now()-($1::int * interval '1 minute')`, [windowMinutes]);
  const usage = await queryOne(`SELECT count(*)::int AS runs, COALESCE(sum(cost_usd),0)::float8 AS recorded_usd,
    count(*) FILTER (WHERE cost_usd=0)::int AS zero_cost_runs FROM ai_runs WHERE created_at >= now()-($1::int * interval '1 minute')`, [windowMinutes]);
  const failures = await queryOne(`SELECT count(*)::int AS failed_messages FROM messages WHERE direction='out' AND status='failed' AND created_at >= now()-($1::int * interval '1 minute')`, [windowMinutes]);
  const pilot = inventory.results.filter(r => r.enabled);
  const known = config.knowledgeSearch.accountIds.length ? await query<{id:string}>('SELECT id FROM accounts WHERE id=ANY($1::uuid[])', [config.knowledgeSearch.accountIds]) : [];
  const unknown = config.knowledgeSearch.accountIds.filter(id => !known.some(account => account.id===id));
  return { observed_at: new Date().toISOString(), window_minutes: windowMinutes,
    database_ready: readiness.database_ready, provider: 'not_checked', key_present: readiness.key_present, issues: readiness.issues,
    rollout: { enabled: config.knowledgeSearch.enabled, mode: config.knowledgeSearch.accountIds.length ? 'pilot' : 'all', account_ids: config.knowledgeSearch.accountIds, valid: !unknown.length, unknown_account_ids: unknown },
    knowledge: { agents: inventory.agents, enabled_agents: pilot.length, pending_items: pilot.reduce((n,r)=>n+r.pending_items,0), complete: readiness.database_ready && !unknown.length && pilot.every(r=>r.complete) },
    search: { ...search, fallback_ratio: search!.attempts ? search!.fallbacks/search!.attempts : null }, usage, delivery: failures };
}
