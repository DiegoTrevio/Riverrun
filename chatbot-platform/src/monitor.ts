/**
 * Monitoreo: revisa la salud del sistema (base de datos, Evolution, tareas programadas, respaldos, disco, IA),
 * avisa al operador cuando algo falla (correo y/o webhook) y manda un "latido" a un servicio externo para que,
 * si el servidor entero cae, alguien más se entere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { missingModels } from './ai/models.js';
import { config } from './config.js';
import { pool, query, queryOne } from './db.js';
import { refreshDiagnostics } from './diagnostics.js';
import { EVOLUTION_EXPECTED } from './evolution/compat.js';
import { lastDeepCheck, probeService, recentVersionChange } from './evolution/status.js';
import { functionalReport } from './observability/health.js';
import { dueEscalations, markAlerted, markEscalated, openIncident, pruneIncidents, resolveIncident, type IncidentStatus } from './observability/incidents.js';
import { appendJournal, flushJournal } from './observability/journal.js';
import { isMuted } from './alert-mute.js';
import { type CheckStatus, type ServiceState } from './observability/status.js';
import { logEvent } from './logs.js';
import { sendMail } from './mailer.js';
import { outboundAllowed } from './outbound-guard.js';

export type { CheckStatus } from './observability/status.js';
export interface CheckResult {
  name: string;
  label: string;
  status: CheckStatus;
  /** Solo cuando el estado por defecto (ok→operativo, warn→degradado, fail→no disponible, na→no configurado) no describe el caso. */
  state?: ServiceState;
  detail: string;
  /** Cifras para /metrics y el panel. Nunca texto de mensajes, teléfonos ni nombres. */
  metrics?: Record<string, number | null>;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: sin respuesta en ${ms / 1000}s`)), ms).unref())]);

async function checkDb(): Promise<CheckResult> {
  const base = { name: 'database', label: 'Base de datos' };
  try {
    await withTimeout(query('SELECT 1'), 4000, 'PostgreSQL');
    return { ...base, status: 'ok', detail: 'Responde' };
  } catch (e: any) {
    return { ...base, status: 'fail', detail: e.message };
  }
}

async function whatsappChannels() {
  return (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE type = 'whatsapp' AND active`))?.n ?? 0;
}

/**
 * Recién arrancado el backend, Evolution puede estar arrancando también (al recrearlo con otra imagen aplica sus
 * migraciones antes de escuchar): durante este margen, "no responde" es atención y no falla. Las alertas ya esperan dos
 * fallos seguidos; esto evita además que /health/ready provoque una vuelta atrás mientras Evolution termina de iniciar.
 */
export const monitorTiming = { startupGraceMs: 180_000 };
const starting = () => process.uptime() * 1000 < monitorTiming.startupGraceMs;

/** Servicio de Evolution: responde, acepta la llave y su versión es compatible (no dice nada de las sesiones). */
async function checkEvolution(): Promise<CheckResult> {
  const base = { name: 'whatsapp', label: 'Servicio de WhatsApp (Evolution)' };
  try {
    const n = await whatsappChannels();
    if (!n) return { ...base, status: 'na', detail: 'No hay canales de WhatsApp' };
    const s = await probeService();
    const boot = starting() ? ' (el servidor acaba de arrancar: Evolution puede estar iniciando)' : '';
    if (!s.reachable) return { ...base, status: boot ? 'warn' : 'fail', detail: `No responde${boot}: ${s.error ?? 'sin respuesta'}` };
    if (s.auth === false) return { ...base, status: 'fail', detail: 'Evolution rechaza la llave (EVOLUTION_API_KEY): no se pueden enviar ni recibir mensajes' };
    if (s.blocked) return { ...base, status: 'fail', detail: `${s.error}. Vuelve a la versión verificada (${EVOLUTION_EXPECTED.version}): ver docs/evolution-api.md` };
    // Respondió, pero con error (p. ej. 503 o su base de datos caída): el servicio no está funcionando.
    if (s.auth === null) return { ...base, status: boot ? 'warn' : 'fail', detail: `Evolution responde con error${boot}: ${s.error ?? 'desconocido'}` };
    const v = s.version ? `versión ${s.version}` : 'versión no verificada';
    if (s.assessment.status === 'incompatible') return { ...base, status: 'fail', detail: `Responde, pero ${s.assessment.detail}` };
    if (s.assessment.status !== 'verified') return { ...base, status: 'warn', detail: `Responde (${v}). ${s.assessment.detail}` };
    return { ...base, status: 'ok', detail: `Responde (${v}, verificada; ${n} canal${n === 1 ? '' : 'es'})` };
  } catch (e: any) {
    return { ...base, status: 'fail', detail: `No responde: ${e?.cause?.code ?? e.message}` };
  }
}

/**
 * Funcionamiento real de WhatsApp: sesiones conectadas, instancias que desaparecieron, webhooks y entregas fallidas.
 * Tras un cambio de versión de Evolution (24 h), las desconexiones masivas se tratan como fallo de la actualización.
 */
async function checkWhatsappSessions(now = Date.now()): Promise<CheckResult> {
  const base = { name: 'whatsapp_sessions', label: 'WhatsApp: sesiones y entregas' };
  try {
    const n = await whatsappChannels();
    if (!n) return { ...base, status: 'na', detail: 'No hay canales de WhatsApp' };
    const [down, linked, failed] = await Promise.all([
      queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE type = 'whatsapp' AND active AND connection_state = 'close'`),
      queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE type = 'whatsapp' AND active AND connection_state IN ('open', 'close')`),
      queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM event_logs WHERE source = 'evolution' AND level = 'error' AND message LIKE 'No se pudo enviar%' AND created_at > now() - interval '15 minutes'`),
    ]);
    const deep = lastDeepCheck();
    const change = await recentVersionChange(now);
    const after = change ? ` desde que Evolution cambió a ${change.to}` : '';
    const fail: string[] = [];
    const warn: string[] = [];
    if (deep?.summary.missing) fail.push(`${deep.summary.missing} instancia${deep.summary.missing === 1 ? '' : 's'} ya vinculada${deep.summary.missing === 1 ? '' : 's'} no existe${deep.summary.missing === 1 ? '' : 'n'} en Evolution (sesión perdida: no la recrees sin revisar los respaldos)`);
    const d = down?.n ?? 0;
    if (d) {
      const text = `${d} WhatsApp desconectado${d === 1 ? '' : 's'}${after}`;
      // Con una actualización reciente, la mitad o más de los canales vinculados caídos apunta a la actualización.
      if (change && d >= Math.max(1, Math.ceil((linked?.n ?? 0) * config.whatsappAlerts.downRatio))) fail.push(text);
      else warn.push(text);
    }
    if (deep?.summary.webhook_problems) warn.push(`${deep.summary.webhook_problems} canal${deep.summary.webhook_problems === 1 ? '' : 'es'} con el webhook ausente o distinto (no llegarían los mensajes)`);
    const f = failed?.n ?? 0;
    if (f >= config.whatsappAlerts.sendFailures) (change ? fail : warn).push(`${f} envíos fallidos en 15 min${after}`);
    if (fail.length) return { ...base, status: 'fail', detail: [...fail, ...warn].join('; ') };
    if (warn.length) return { ...base, status: 'warn', detail: warn.join('; ') };
    const sessions = deep ? `${deep.summary.open} de ${deep.summary.total} sesiones abiertas (revisado ${new Date(deep.checked_at).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' })})` : `${n} canal${n === 1 ? '' : 'es'}, sin desconexiones`;
    return { ...base, status: 'ok', detail: sessions };
  } catch (e: any) {
    return { ...base, status: 'na', state: 'no_verificado', detail: e?.message ?? String(e) };
  }
}

async function checkScheduler(): Promise<CheckResult> {
  const base = { name: 'scheduler', label: 'Tareas programadas' };
  try {
    // Si hay tareas vencidas hace más de 5 minutos, el ejecutor está atorado.
    const r = await queryOne<{ n: number; oldest: Date | null }>(`SELECT count(*)::int AS n, min(run_at) AS oldest FROM jobs WHERE status = 'pending' AND run_at < now() - interval '5 minutes'`);
    return r?.n ? { ...base, status: 'fail', detail: `${r.n} tareas atrasadas (la más vieja: ${new Date(r.oldest!).toISOString()})` } : { ...base, status: 'ok', detail: 'Al día' };
  } catch (e: any) {
    return { ...base, status: 'fail', detail: e.message };
  }
}

/** Latencia p95 (ms) a partir de la cual las respuestas de IA se consideran lentas. */
const AI_SLOW_P95_MS = 10_000;

/**
 * Funcionamiento real de la IA: se mide con las llamadas de los últimos 15 minutos (conteo, errores, reintentos y latencia),
 * sin leer prompts ni respuestas. Sin llamadas recientes no hay nada que comprobar: "no verificado", no "operativo".
 */
async function checkAi(): Promise<CheckResult> {
  const base = { name: 'ai', label: 'IA (OpenRouter)' };
  if (!config.openai.apiKey) return { ...base, status: 'fail', detail: 'Falta OPENROUTER_API_KEY: el asistente no puede responder' };
  try {
    const r = await queryOne<{ runs: number; errors: number; retries: number; p95: number | null }>(`
      SELECT (SELECT count(*)::int FROM ai_runs WHERE created_at > now() - interval '15 minutes') AS runs,
             (SELECT count(*)::int FROM event_logs WHERE source = 'ai' AND level = 'error' AND created_at > now() - interval '15 minutes') AS errors,
             (SELECT count(*)::int FROM ai_runs WHERE attempt > 1 AND created_at > now() - interval '15 minutes') AS retries,
             (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int FROM ai_runs WHERE created_at > now() - interval '15 minutes') AS p95`);
    const runs = r?.runs ?? 0;
    const errors = r?.errors ?? 0;
    const metrics = { runs_15m: runs, errors_15m: errors, retries_15m: r?.retries ?? 0, p95_latency_ms_15m: r?.p95 ?? null };
    if (!runs && !errors) return { ...base, status: 'ok', state: 'no_verificado', detail: 'Sin llamadas a la IA en los últimos 15 minutos: no hay forma de comprobarla ahora', metrics };
    // Errores y ninguna respuesta correcta: la clave es inválida o el proveedor no responde. Eso es una caída, no un aviso.
    if (!runs && errors >= 3) return { ...base, status: 'fail', detail: `Ningún intento de la IA funciona: ${errors} errores y 0 respuestas en 15 minutos (¿clave inválida o proveedor caído?)`, metrics };
    if (errors >= 5) return { ...base, status: 'warn', detail: `${errors} errores de IA en los últimos 15 minutos (de ${runs} llamadas)`, metrics };
    if (r?.p95 && r.p95 > AI_SLOW_P95_MS) return { ...base, status: 'warn', detail: `Respuestas lentas: p95 de ${Math.round(r.p95 / 1000)} s en 15 minutos`, metrics };
    return { ...base, status: 'ok', detail: `${runs} llamadas en 15 minutos, ${errors} con error`, metrics };
  } catch {
    return { ...base, status: 'na', state: 'no_verificado', detail: 'No se pudo consultar el registro de IA' };
  }
}

async function checkModels(): Promise<CheckResult> {
  const base = { name: 'models', label: 'Modelos de IA configurados' };
  try {
    const missing = await missingModels();
    if (missing === null) return { ...base, status: 'na', state: 'no_verificado', detail: 'No se pudo consultar el catálogo de OpenRouter' };
    if (!missing.length) return { ...base, status: 'ok', detail: 'Todos existen en OpenRouter' };
    return { ...base, status: 'warn', detail: `No existen en OpenRouter: ${missing.slice(0, 4).map((m) => `${m.id} (${m.where})`).join(', ')}${missing.length > 4 ? '…' : ''}. Cámbialos antes de que dejen de responder.` };
  } catch {
    return { ...base, status: 'na', state: 'no_verificado', detail: 'No se pudo comprobar' };
  }
}

export function readBackupStatus(dir = config.monitor.backupDir): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

function checkBackup(now = new Date()): CheckResult {
  const base = { name: 'backup', label: 'Respaldos' };
  if (!fs.existsSync(config.monitor.backupDir)) return { ...base, status: 'na', detail: 'No hay contenedor de respaldos (modo desarrollo)' };
  const s = readBackupStatus();
  if (!s) return { ...base, status: 'warn', detail: 'Todavía no se ha hecho ningún respaldo' };
  const last = s.last_success_at ? new Date(s.last_success_at) : null;
  const ageH = last ? (now.getTime() - last.getTime()) / 3600_000 : Infinity;
  if (!s.ok && s.error) return { ...base, status: ageH > config.monitor.backupMaxAgeHours ? 'fail' : 'warn', detail: `Último intento falló: ${s.error}` };
  if (ageH > config.monitor.backupMaxAgeHours) return { ...base, status: 'fail', detail: last ? `Último respaldo correcto hace ${Math.round(ageH)} h` : 'Nunca hubo un respaldo correcto' };
  if (s.remote && s.remote_ok === false) return { ...base, status: 'warn', detail: 'Respaldo local correcto pero no se pudo copiar a la nube' };
  return { ...base, status: 'ok', detail: `Último correcto: ${last!.toISOString()}${s.remote ? ' (copiado a la nube)' : ' (solo local: configura la copia en la nube)'}` };
}

/** `statfs` se puede inyectar: las pruebas simulan un disco casi lleno sin llenar uno de verdad. */
export function checkDisk(statfs: typeof fs.statfsSync = fs.statfsSync): CheckResult {
  const base = { name: 'disk', label: 'Espacio en disco' };
  try {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const s = statfs(config.uploadsDir);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    const pct = total ? (free / total) * 100 : 100;
    const gb = (free / 1e9).toFixed(1);
    if (pct < 3 || free < 300e6) return { ...base, status: 'fail', detail: `Casi sin espacio: ${gb} GB libres (${pct.toFixed(0)}%)` };
    if (pct < 10 || free < 1e9) return { ...base, status: 'warn', detail: `Poco espacio: ${gb} GB libres (${pct.toFixed(0)}%)` };
    return { ...base, status: 'ok', detail: `${gb} GB libres (${pct.toFixed(0)}%)` };
  } catch {
    return { ...base, status: 'na', state: 'no_verificado', detail: 'No se pudo medir el espacio libre' };
  }
}

/**
 * Cola: trabajos marcados "en curso" desde hace más de 15 minutos (el ejecutor murió a mitad) y mensajes entrantes que
 * llevan más de 5 minutos sin procesar. El procesamiento normal tarda segundos, así que esto indica un atasco.
 */
async function checkQueue(): Promise<CheckResult> {
  const base = { name: 'queue', label: 'Cola de mensajes y trabajos' };
  try {
    const r = await queryOne<{ pending: number; stuck: number; inbound_waiting: number }>(`
      SELECT (SELECT count(*)::int FROM jobs WHERE status = 'pending') AS pending,
             (SELECT count(*)::int FROM jobs WHERE status = 'running' AND started_at < now() - interval '15 minutes') AS stuck,
             (SELECT count(*)::int FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                JOIN channels ch ON ch.id = c.channel_id
               WHERE m.processed = false AND m.direction = 'in' AND ch.type <> 'playground'
                 AND m.created_at BETWEEN now() - interval '60 minutes' AND now() - interval '5 minutes') AS inbound_waiting`);
    const metrics = { jobs_pending: r?.pending ?? 0, jobs_stuck: r?.stuck ?? 0, inbound_waiting: r?.inbound_waiting ?? 0 };
    const problems: string[] = [];
    if (metrics.jobs_stuck) problems.push(`${metrics.jobs_stuck} trabajo${metrics.jobs_stuck === 1 ? '' : 's'} atascado${metrics.jobs_stuck === 1 ? '' : 's'} (en curso desde hace más de 15 min)`);
    if (metrics.inbound_waiting) problems.push(`${metrics.inbound_waiting} mensaje${metrics.inbound_waiting === 1 ? '' : 's'} entrante${metrics.inbound_waiting === 1 ? '' : 's'} sin procesar desde hace más de 5 min`);
    if (problems.length) return { ...base, status: 'warn', detail: problems.join('; '), metrics };
    return { ...base, status: 'ok', detail: `Sin trabajos atascados; ${metrics.jobs_pending} pendiente${metrics.jobs_pending === 1 ? '' : 's'}`, metrics };
  } catch (e: any) {
    return { ...base, status: 'na', state: 'no_verificado', detail: e?.message ?? 'No se pudo consultar la cola' };
  }
}

/** Memoria del proceso, conexiones a PostgreSQL y tamaño de la base. Sin umbral de memoria, solo mide. */
async function checkResources(): Promise<CheckResult> {
  const base = { name: 'resources', label: 'Recursos del proceso' };
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  let dbMb: number | null = null;
  try {
    const r = await queryOne<{ bytes: number }>('SELECT pg_database_size(current_database())::bigint AS bytes');
    dbMb = r ? Math.round(Number(r.bytes) / 1048576) : null;
  } catch {
    dbMb = null;
  }
  const metrics = { rss_mb: rssMb, db_size_mb: dbMb, pool_total: pool.totalCount, pool_idle: pool.idleCount, pool_waiting: pool.waitingCount };
  const detail = `Memoria ${rssMb} MB · base de datos ${dbMb ?? '?'} MB · conexiones ${pool.totalCount} (${pool.waitingCount} en espera)`;
  if (pool.waitingCount > 0) return { ...base, status: 'warn', detail: `Consultas esperando una conexión a la base de datos: ${detail}`, metrics };
  if (config.monitor.rssWarnMb && rssMb > config.monitor.rssWarnMb) return { ...base, status: 'warn', detail: `Memoria alta: ${detail}`, metrics };
  return { ...base, status: 'ok', detail, metrics };
}

export async function runChecks(now = new Date()): Promise<CheckResult[]> {
  const [db, wa, sessions, sch, ai, models, queue, resources] = await Promise.all([
    checkDb(), checkEvolution(), checkWhatsappSessions(now.getTime()), checkScheduler(), checkAi(), checkModels(), checkQueue(), checkResources(),
  ]);
  return [db, wa, sessions, sch, ai, models, checkBackup(now), checkDisk(), queue, resources];
}

/**
 * Para endpoints que un monitor externo consulta a menudo: reutiliza el resultado unos segundos, así no se repiten las
 * consultas ni las llamadas a Evolution por cada petición. /health/ready siempre mide en el momento.
 */
let cache: { at: number; checks: CheckResult[] } | null = null;
export async function cachedChecks(maxAgeMs = 15_000): Promise<CheckResult[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.checks;
  const checks = await runChecks();
  cache = { at: Date.now(), checks };
  return checks;
}
export function resetChecksCache() {
  cache = null;
}

/** Lo imprescindible para atender peticiones (ver READINESS_CHECKS). Mide en el momento: no usa caché. */
export async function runReadiness(): Promise<CheckResult[]> {
  const [db, sch] = await Promise.all([checkDb(), checkScheduler()]);
  return [db, sch];
}

export const overall = (checks: CheckResult[]): 'ok' | 'warn' | 'fail' => (checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok');

/* ------------------------------ Alertas ------------------------------ */

export interface AlertState {
  /** Fallos seguidos por componente: avisan al confirmarse. */
  failures: Map<string, number>;
  /** Degradados seguidos por componente: se anotan al confirmarse, nunca avisan. */
  warnings: Map<string, number>;
  /** Cuándo salió el último aviso de cada componente, en este proceso. */
  alertedAt: Map<string, number>;
  /** Componentes con incidencia abierta que este proceso registró (para anotar su cierre si la base está caída). */
  open: Set<string>;
}
export const newAlertState = (): AlertState => ({ failures: new Map(), warnings: new Map(), alertedAt: new Map(), open: new Set() });

export type Sender = (title: string, body: string) => Promise<void>;

export async function sendAlert(title: string, body: string) {
  const text = `${title}\n${body}`;
  const jobs: Promise<unknown>[] = [];
  if (config.signup.superadminEmail) jobs.push(sendMail({ to: config.signup.superadminEmail, subject: title, text: `${body}\n\n${config.publicBaseUrl}/#/sistema` }));
  const webhook = config.monitor.alertWebhookUrl;
  // Sandbox: el canal de producción no recibe avisos de pruebas. La incidencia sigue registrada en la base.
  if (webhook && !outboundAllowed(webhook)) {
    console.warn('Aviso al webhook omitido: OUTBOUND_MODE=sandbox y la URL no está en OUTBOUND_SANDBOX_ALLOW');
  } else if (webhook) {
    // ntfy lee el cuerpo como texto; Slack/Mattermost usan "text" y Discord "content".
    const ntfy = /ntfy/i.test(webhook);
    jobs.push(
      fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': ntfy ? 'text/plain; charset=utf-8' : 'application/json' },
        body: ntfy ? text : JSON.stringify({ text, content: text, title, message: body }),
        signal: AbortSignal.timeout(8000),
      }).catch((e) => console.error('No se pudo enviar la alerta al webhook', e?.message)),
    );
  }
  await Promise.allSettled(jobs);
}

const REALERT_MS = 6 * 3600_000;
/** Componentes con ALERT_MUTE: la incidencia se registra, pero no sale ningún aviso (ni de falla, ni de recuperación, ni de escalamiento). */
const muted = (name: string, now = Date.now()) => isMuted(config.monitor.alertMute, name, now);
const toMs = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : undefined);

/**
 * Un fallo avisa al segundo intento seguido (evita falsas alarmas), repite cada 6 h y avisa cuando se recupera.
 * Cada fallo confirmado queda en el historial de incidencias (una abierta por componente), aunque esté silenciado.
 * Un degradado que persiste se anota con severidad baja: no avisa, no escala y no cierra una incidencia de fallo.
 */
export async function evaluateAlerts(checks: CheckResult[], st: AlertState, send: Sender = sendAlert, now = Date.now(), confirmAfter = 2) {
  // Lo anotado mientras la base estaba caída entra primero, para que el historial quede en orden.
  await flushJournal().catch(() => undefined);
  for (const c of checks) {
    if (c.status === 'fail') {
      st.warnings.delete(c.name);
      const n = (st.failures.get(c.name) ?? 0) + 1;
      st.failures.set(c.name, n);
      if (n < confirmAfter) continue;
      const inc = await recordIncident(c, now, 'fail', st);
      // Tras un reinicio no queda memoria del último aviso: el que salió antes está en el historial, así no se repite.
      const last = st.alertedAt.get(c.name) ?? toMs(inc?.alerted_at);
      if (last && now - last < REALERT_MS) continue;
      st.alertedAt.set(c.name, now);
      if (inc) await markAlertedSafe(inc.id, now);
      const silenced = muted(c.name, now);
      await logEvent({ level: 'error', source: 'system', message: `Alerta${silenced ? ' silenciada (ALERT_MUTE)' : ''}: ${c.label} — ${c.detail}` });
      if (!silenced) await send(`🔴 Riverrun: ${c.label}`, `${c.detail}\n\nRevisa el estado completo en el panel (Sistema) o con ./riverrun status.`);
    } else if (c.status === 'warn') {
      st.failures.delete(c.name);
      const n = (st.warnings.get(c.name) ?? 0) + 1;
      st.warnings.set(c.name, n);
      if (n >= confirmAfter) await recordIncident(c, now, 'warn', st);
    } else {
      st.failures.delete(c.name);
      st.warnings.delete(c.name);
      const closed = await closeIncident(c.name, now, st);
      // Se anuncia la recuperación si este proceso avisó, o si la incidencia tenía un aviso anterior a un reinicio.
      const wasAlerted = st.alertedAt.has(c.name) || closed?.alerted_at != null;
      st.alertedAt.delete(c.name);
      if (wasAlerted) {
        await logEvent({ level: 'info', source: 'system', message: `Recuperado: ${c.label}` });
        if (!muted(c.name, now)) await send(`🟢 Riverrun: ${c.label} se recuperó`, c.detail);
      }
    }
  }
}

/** El historial no debe impedir un aviso: si PostgreSQL falla, la incidencia se anota en el diario pendiente y el aviso sale igual. */
async function recordIncident(c: CheckResult, now: number, status: IncidentStatus, st: AlertState) {
  st.open.add(c.name);
  try {
    return await openIncident(c.name, c.label, c.detail, new Date(now), status);
  } catch (e: any) {
    console.error('No se pudo registrar la incidencia; queda en el diario pendiente', e?.message ?? e);
    appendJournal({ op: 'open', component: c.name, title: c.label, detail: c.detail, status, at: new Date(now).toISOString() });
    return null;
  }
}

async function closeIncident(component: string, now: number, st: AlertState) {
  const wasOpen = st.open.has(component);
  st.open.delete(component);
  try {
    return await resolveIncident(component, new Date(now));
  } catch (e: any) {
    console.error('No se pudo cerrar la incidencia', e?.message ?? e);
    if (wasOpen) appendJournal({ op: 'resolve', component, at: new Date(now).toISOString() });
    return null;
  }
}

async function markAlertedSafe(id: number, now: number) {
  await markAlerted(id, new Date(now)).catch((e: any) => console.error('No se pudo anotar el aviso', e?.message ?? e));
}

/**
 * Escalamiento: una incidencia que sigue abierta más de ALERT_ESCALATE_MINUTES se anuncia otra vez, una sola vez, con
 * el aviso marcado. markEscalated es atómico: dos procesos no la envían dos veces.
 */
export async function escalateIncidents(send: Sender = sendAlert, now = Date.now()) {
  const minutes = config.monitor.escalateMinutes;
  for (const inc of await dueEscalations(minutes, new Date(now))) {
    if (muted(inc.component, now)) continue;
    if (!(await markEscalated(inc.id, new Date(now)))) continue;
    await logEvent({ level: 'error', source: 'system', message: `Escalado: ${inc.title} sigue abierta desde hace más de ${minutes} min` });
    await send(`🚨 Riverrun: ESCALADO — ${inc.title}`, `Lleva más de ${minutes} minutos sin resolverse.\n${inc.detail}\n\nRevisa el estado completo en el panel (Sistema) o con ./riverrun status.`);
  }
}

/** Latido para servicios externos: solo se envía si lo esencial funciona; si deja de llegar, ellos avisan. */
export async function heartbeat(checks: CheckResult[]) {
  if (!config.monitor.heartbeatUrl) return false;
  // Sandbox: un latido de pruebas no debe marcar como "vivo" al servidor de producción en el servicio externo.
  if (!outboundAllowed(config.monitor.heartbeatUrl)) return false;
  if (checks.some((c) => ['database', 'scheduler'].includes(c.name) && c.status === 'fail')) return false;
  try {
    const res = await fetch(config.monitor.heartbeatUrl, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function startMonitor(intervalMs = 60_000, deepIntervalMs = 15 * 60_000) {
  const st = newAlertState();
  let tick = 0;
  const run = async () => {
    try {
      const checks = await runChecks();
      await evaluateAlerts(checks, st);
      await escalateIncidents();
      if (tick++ % 5 === 0) await heartbeat(checks);
    } catch (e: any) {
      console.error('Error en el monitoreo', e?.message ?? e);
    }
  };
  setTimeout(run, 15_000).unref(); // deja que el arranque termine
  setInterval(run, intervalMs).unref();
  // Más profundo y menos frecuente: sesiones y webhooks de cada WhatsApp, versión de Evolution y credenciales.
  const deep = () => {
    void refreshDiagnostics({ force: true }).catch((e) => console.error('Error en el diagnóstico de servicios', e?.message ?? e));
    void pruneIncidents().catch((e) => console.error('No se pudo limpiar el historial de incidencias', e?.message ?? e));
  };
  setTimeout(deep, 30_000).unref();
  setInterval(deep, deepIntervalMs).unref();
}

/** Resumen para el panel del superadmin. */
export async function systemStatus() {
  const checks = await runChecks();
  const [errors, accounts, channels, subs] = await Promise.all([
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM event_logs WHERE level = 'error' AND created_at > now() - interval '24 hours'`),
    query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM accounts WHERE active GROUP BY 1`),
    query<{ state: string; n: number }>(`SELECT coalesce(nullif(connection_state, ''), 'sin conectar') AS state, count(*)::int AS n FROM channels WHERE type = 'whatsapp' AND active GROUP BY 1`),
    query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM subscriptions GROUP BY 1`).catch(() => []),
  ]);
  const mem = process.memoryUsage();
  return {
    status: overall(checks),
    functional: functionalReport(checks),
    version: config.monitor.version,
    uptime_seconds: Math.round(process.uptime()),
    memory_mb: Math.round(mem.rss / 1048576),
    checks,
    errors_24h: errors?.n ?? 0,
    accounts,
    whatsapp: channels,
    subscriptions: subs,
    backup: readBackupStatus(),
    heartbeat_configured: !!config.monitor.heartbeatUrl,
    alerts_configured: { email: !!config.signup.superadminEmail && !!config.mail.smtpUrl, webhook: !!config.monitor.alertWebhookUrl },
  };
}
