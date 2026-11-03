/**
 * Etapa 7 (detección): bitácora de seguridad y avisos.
 *
 * Cada acceso y cada movimiento sensible (entrar o fallar al entrar, cambios de contraseña, 2FA, rol o dueño, llaves de
 * la API, descargas y borrados de datos) queda en `security_events`: aparte de la bitácora general, que se depura y se
 * borra con la cuenta. Se conserva `SECURITY_LOG_DAYS` (365) aunque la cuenta o la persona ya no existan.
 *
 * Al anotar, unas reglas sencillas buscan lo que no es normal y avisan al superadmin por el canal de las alertas del
 * sistema (correo y ALERT_WEBHOOK_URL), una vez por hora por regla y objetivo:
 *  - muchas contraseñas fallidas desde una IP, contra varias personas (alguien prueba listas de contraseñas);
 *  - muchas contraseñas fallidas contra una persona (alguien intenta adivinar la suya);
 *  - un superadmin que entra desde un dispositivo nuevo, o cuyo 2FA se bloquea por intentos;
 *  - muchas descargas de datos o muchos borrados de contactos de una misma persona en una hora.
 *
 * Nunca lanza: anotar o avisar no puede romper lo que se estaba haciendo.
 */
import { query, queryOne } from './db.js';
import { config } from './config.js';
import { logEvent } from './logs.js';

export type SecurityKind =
  | 'login.failed' | 'login.blocked' | 'login.ok' | 'mfa.failed'
  | `notice.${string}`
  | `export.${string}`
  | 'contact.erased' | 'account.deleted'
  | 'apikey.created' | 'apikey.revoked' | 'webhook_secret.rotated'
  | `alert.${string}`;

export interface SecurityEvent {
  kind: SecurityKind;
  accountId?: string | null;
  userId?: string | null;
  email?: string;
  ip?: string;
  userAgent?: string;
  /** Sobre qué fue (un contacto, una llave, otra persona): un id o un nombre corto. */
  target?: string;
  details?: Record<string, unknown>;
}

/** Umbrales de las reglas (en una ventana de 15 minutos para el acceso y de 1 hora para los datos). */
export const RULES = {
  stuffingFailures: 20, stuffingEmails: 5,
  bruteForceFailures: 10,
  exportsPerHour: 5,
  erasuresPerHour: 25,
};

/** Solo lo que parece un correo se guarda como correo (quien escribe su contraseña en ese campo no la deja aquí). */
const asEmail = (v: string | undefined) => (v && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v.slice(0, 200).toLowerCase() : '');

export async function recordSecurity(e: SecurityEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO security_events (kind, account_id, user_id, email, ip, user_agent, target, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.kind.slice(0, 60), e.accountId ?? null, e.userId ?? null, asEmail(e.email), String(e.ip ?? '').slice(0, 64), String(e.userAgent ?? '').slice(0, 200), String(e.target ?? '').slice(0, 200), JSON.stringify(e.details ?? {})],
    );
    await detect(e);
  } catch (err: any) {
    console.error('No se pudo anotar en la bitácora de seguridad', err?.message ?? err);
  }
}

/** Un aviso por regla y objetivo por hora (entre varios procesos también). true si toca avisar. */
async function claimAlert(key: string): Promise<boolean> {
  const row = await queryOne(
    `INSERT INTO security_alerts (key, alerted_at) VALUES ($1, now())
     ON CONFLICT (key) DO UPDATE SET alerted_at = now() WHERE security_alerts.alerted_at < now() - interval '1 hour'
     RETURNING key`,
    [key.slice(0, 300)],
  );
  return !!row;
}

async function alert(rule: string, target: string, title: string, body: string, e: SecurityEvent) {
  if (!(await claimAlert(`${rule}:${target}`))) return;
  await query(
    `INSERT INTO security_events (kind, account_id, email, ip, target, details) VALUES ($1, $2, $3, $4, $5, $6)`,
    [`alert.${rule}`, e.accountId ?? null, asEmail(e.email), String(e.ip ?? '').slice(0, 64), target.slice(0, 200), JSON.stringify({ title, body })],
  );
  await logEvent({ level: 'warn', source: 'security', message: `${title}: ${body}`, accountId: e.accountId ?? null });
  const { sendAlert } = await import('./monitor.js');
  await sendAlert(`🔐 ${title}`, `${body}\n\nRevisa la bitácora de seguridad en Sistema → Seguridad.`);
}

async function detect(e: SecurityEvent) {
  if (e.kind === 'login.failed' || e.kind === 'login.blocked') {
    if (e.ip) {
      const r = await queryOne<{ n: number; people: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT lower(email))::int AS people FROM security_events
          WHERE kind IN ('login.failed', 'login.blocked') AND ip = $1 AND at > now() - interval '15 minutes'`,
        [e.ip],
      );
      if (r && r.n >= RULES.stuffingFailures && r.people >= RULES.stuffingEmails) {
        await alert('stuffing', e.ip, 'Muchos accesos fallidos desde una IP',
          `${r.n} contraseñas fallidas en 15 minutos desde ${e.ip}, contra ${r.people} correos distintos: alguien está probando listas de contraseñas. El límite por IP ya lo frena; si sigue, bloquéala en el firewall.`, e);
      }
    }
    const email = asEmail(e.email);
    if (email) {
      const r = await queryOne<{ n: number; ips: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT ip)::int AS ips FROM security_events
          WHERE kind IN ('login.failed', 'login.blocked') AND lower(email) = $1 AND at > now() - interval '15 minutes'`,
        [email],
      );
      if (r && r.n >= RULES.bruteForceFailures) {
        await alert('bruteforce', email, 'Intentan adivinar la contraseña de una persona',
          `${r.n} contraseñas fallidas en 15 minutos para ${email} (desde ${r.ips} IP). Su cuenta ya solo entra desde su dispositivo recordado; conviene avisarle.`, e);
      }
    }
    return;
  }
  // Los superadmin entran a todas las cuentas: un dispositivo nuevo o un 2FA bloqueado se avisa al momento.
  if (e.kind === 'notice.new_device' || e.kind === 'notice.mfa_locked') {
    const u = e.userId ? await queryOne<{ role: string; email: string }>(`SELECT role, email FROM users WHERE id = $1`, [e.userId]) : null;
    if (u?.role === 'superadmin') {
      const what = e.kind === 'notice.new_device' ? 'entró desde un dispositivo nuevo' : 'tuvo su verificación en dos pasos bloqueada por intentos fallidos (alguien conoce su contraseña)';
      await alert(e.kind === 'notice.new_device' ? 'superadmin_device' : 'superadmin_mfa', `${u.email}:${e.ip ?? ''}`, 'Acceso de superadmin para revisar',
        `El superadmin ${u.email} ${what}${e.ip ? ` (IP ${e.ip})` : ''}${e.userAgent ? `, ${e.userAgent}` : ''}. Si no fue esa persona, cierra sus sesiones y cambia su contraseña.`, { ...e, email: u.email });
    }
    return;
  }
  if (e.kind.startsWith('export.') && e.userId) {
    const r = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_events WHERE kind LIKE 'export.%' AND user_id = $1 AND at > now() - interval '1 hour'`, [e.userId]);
    if (r && r.n >= RULES.exportsPerHour) {
      await alert('exports', e.userId, 'Muchas descargas de datos de una persona',
        `${e.email || 'Alguien'} descargó datos ${r.n} veces en la última hora (lo último: ${e.kind.slice(7)}). Si no es normal para esa cuenta, revisa quién es y cierra sus sesiones.`, e);
    }
    return;
  }
  if (e.kind === 'contact.erased' && e.userId) {
    const r = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_events WHERE kind = 'contact.erased' AND user_id = $1 AND at > now() - interval '1 hour'`, [e.userId]);
    if (r && r.n >= RULES.erasuresPerHour) {
      await alert('erasures', e.userId, 'Muchos contactos borrados por una persona',
        `${e.email || 'Alguien'} borró ${r.n} contactos (con su historial) en la última hora. Lo borrado no se recupera salvo desde un respaldo.`, e);
    }
  }
}

/** Lo que se muestra: el superadmin todo; un administrador, lo de su cuenta. */
export async function listSecurityEvents(o: { accountId?: string | null; kind?: string; email?: string; ip?: string; before?: number; limit?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (o.accountId) add('account_id = ?', o.accountId);
  if (o.kind) add('kind LIKE ?', `${o.kind.replace(/[%_\\]/g, '')}%`);
  if (o.email) add('lower(email) = ?', o.email.toLowerCase());
  if (o.ip) add('ip = ?', o.ip);
  if (o.before) add('id < ?', o.before);
  params.push(Math.min(Math.max(o.limit ?? 100, 1), 500));
  return query<{ id: number; at: Date; kind: string; account_id: string | null; user_id: string | null; email: string; ip: string; user_agent: string; target: string; details: Record<string, unknown> }>(
    `SELECT id, at, kind, account_id, user_id, email, ip, user_agent, target, details FROM security_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
}

/** Mantenimiento: lo de más de SECURITY_LOG_DAYS se borra; los avisos viejos, también. */
export async function pruneSecurityEvents(): Promise<number> {
  const rows = await query(`DELETE FROM security_events WHERE at < now() - make_interval(days => $1) RETURNING 1`, [config.securityLogDays]);
  await query(`DELETE FROM security_alerts WHERE alerted_at < now() - interval '2 days'`);
  return rows.length;
}

/** Quién hizo la petición (para anotar sin repetir): la persona con sesión, su IP y su navegador. */
export const actor = (req: { user?: { id?: string; email?: string; account_id?: string | null }; ip?: string; headers?: Record<string, unknown> }) => ({
  userId: req.user?.id ?? null,
  email: req.user?.email ?? '',
  ip: String(req.ip ?? ''),
  userAgent: String(req.headers?.['user-agent'] ?? ''),
});
