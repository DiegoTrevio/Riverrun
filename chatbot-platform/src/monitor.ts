/**
 * Monitoreo: revisa la salud del sistema (base de datos, Evolution, tareas programadas, respaldos, disco, IA),
 * avisa al operador cuando algo falla (correo y/o webhook) y manda un "latido" a un servicio externo para que,
 * si el servidor entero cae, alguien más se entere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { query, queryOne } from './db.js';
import { logEvent } from './logs.js';
import { sendMail } from './mailer.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'na';
export interface CheckResult {
  name: string;
  label: string;
  status: CheckStatus;
  detail: string;
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

async function checkEvolution(): Promise<CheckResult> {
  const base = { name: 'whatsapp', label: 'Servicio de WhatsApp (Evolution)' };
  try {
    const n = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE type = 'whatsapp' AND active`);
    if (!n?.n) return { ...base, status: 'na', detail: 'No hay canales de WhatsApp' };
    // Cualquier respuesta HTTP (aunque sea 401) indica que el servicio está vivo.
    await fetch(config.evolution.url, { signal: AbortSignal.timeout(4000) });
    const down = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE type = 'whatsapp' AND active AND connection_state = 'close'`);
    return down?.n ? { ...base, status: 'warn', detail: `Evolution responde; ${down.n} WhatsApp desconectado${down.n === 1 ? '' : 's'}` } : { ...base, status: 'ok', detail: `Responde (${n.n} canal${n.n === 1 ? '' : 'es'})` };
  } catch (e: any) {
    return { ...base, status: 'fail', detail: `No responde: ${e?.cause?.code ?? e.message}` };
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

async function checkAi(): Promise<CheckResult> {
  const base = { name: 'ai', label: 'IA (OpenRouter)' };
  if (!config.openai.apiKey) return { ...base, status: 'fail', detail: 'Falta OPENROUTER_API_KEY: el asistente no puede responder' };
  try {
    const r = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM event_logs WHERE source = 'ai' AND level = 'error' AND created_at > now() - interval '15 minutes'`);
    return r?.n && r.n >= 5 ? { ...base, status: 'warn', detail: `${r.n} errores de IA en los últimos 15 minutos` } : { ...base, status: 'ok', detail: 'Sin errores recientes' };
  } catch {
    return { ...base, status: 'na', detail: '' };
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

function checkDisk(): CheckResult {
  const base = { name: 'disk', label: 'Espacio en disco' };
  try {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const s = fs.statfsSync(config.uploadsDir);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    const pct = total ? (free / total) * 100 : 100;
    const gb = (free / 1e9).toFixed(1);
    if (pct < 3 || free < 300e6) return { ...base, status: 'fail', detail: `Casi sin espacio: ${gb} GB libres (${pct.toFixed(0)}%)` };
    if (pct < 10 || free < 1e9) return { ...base, status: 'warn', detail: `Poco espacio: ${gb} GB libres (${pct.toFixed(0)}%)` };
    return { ...base, status: 'ok', detail: `${gb} GB libres (${pct.toFixed(0)}%)` };
  } catch {
    return { ...base, status: 'na', detail: '' };
  }
}

export async function runChecks(now = new Date()): Promise<CheckResult[]> {
  const [db, wa, sch, ai] = await Promise.all([checkDb(), checkEvolution(), checkScheduler(), checkAi()]);
  return [db, wa, sch, ai, checkBackup(now), checkDisk()];
}

export const overall = (checks: CheckResult[]): 'ok' | 'warn' | 'fail' => (checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok');

/* ------------------------------ Alertas ------------------------------ */

export interface AlertState {
  failures: Map<string, number>;
  alertedAt: Map<string, number>;
}
export const newAlertState = (): AlertState => ({ failures: new Map(), alertedAt: new Map() });

export type Sender = (title: string, body: string) => Promise<void>;

export async function sendAlert(title: string, body: string) {
  const text = `${title}\n${body}`;
  const jobs: Promise<unknown>[] = [];
  if (config.signup.superadminEmail) jobs.push(sendMail({ to: config.signup.superadminEmail, subject: title, text: `${body}\n\n${config.publicBaseUrl}/#/sistema` }));
  if (config.monitor.alertWebhookUrl) {
    // ntfy lee el cuerpo como texto; Slack/Mattermost usan "text" y Discord "content".
    const ntfy = /ntfy/i.test(config.monitor.alertWebhookUrl);
    jobs.push(
      fetch(config.monitor.alertWebhookUrl, {
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
/** Un fallo avisa al segundo intento seguido (evita falsas alarmas), repite cada 6 h y avisa cuando se recupera. */
export async function evaluateAlerts(checks: CheckResult[], st: AlertState, send: Sender = sendAlert, now = Date.now(), confirmAfter = 2) {
  for (const c of checks) {
    if (c.status === 'fail') {
      const n = (st.failures.get(c.name) ?? 0) + 1;
      st.failures.set(c.name, n);
      const last = st.alertedAt.get(c.name);
      if (n >= confirmAfter && (!last || now - last >= REALERT_MS)) {
        st.alertedAt.set(c.name, now);
        await logEvent({ level: 'error', source: 'system', message: `Alerta: ${c.label} — ${c.detail}` });
        await send(`🔴 Riverrun: ${c.label}`, `${c.detail}\n\nRevisa el estado completo en el panel (Sistema) o con ./riverrun status.`);
      }
    } else {
      st.failures.delete(c.name);
      if (st.alertedAt.has(c.name)) {
        st.alertedAt.delete(c.name);
        await logEvent({ level: 'info', source: 'system', message: `Recuperado: ${c.label}` });
        await send(`🟢 Riverrun: ${c.label} se recuperó`, c.detail);
      }
    }
  }
}

/** Latido para servicios externos: solo se envía si lo esencial funciona; si deja de llegar, ellos avisan. */
export async function heartbeat(checks: CheckResult[]) {
  if (!config.monitor.heartbeatUrl) return false;
  if (checks.some((c) => ['database', 'scheduler'].includes(c.name) && c.status === 'fail')) return false;
  try {
    const res = await fetch(config.monitor.heartbeatUrl, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function startMonitor(intervalMs = 60_000) {
  const st = newAlertState();
  let tick = 0;
  const run = async () => {
    try {
      const checks = await runChecks();
      await evaluateAlerts(checks, st);
      if (tick++ % 5 === 0) await heartbeat(checks);
    } catch (e: any) {
      console.error('Error en el monitoreo', e?.message ?? e);
    }
  };
  setTimeout(run, 15_000).unref(); // deja que el arranque termine
  setInterval(run, intervalMs).unref();
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
