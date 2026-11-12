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
 *  - muchas contraseñas fallidas contra una persona (alguien intenta adivinar la suya), o en toda la plataforma;
 *  - un superadmin que entra desde un dispositivo nuevo, o cuyo 2FA se bloquea por intentos;
 *  - muchas descargas de datos o muchos borrados de contactos de una misma persona en una hora.
 *
 * Nunca lanza: anotar o avisar no puede romper lo que se estaba haciendo.
 */
import { createHmac } from 'node:crypto';
import { query, queryOne } from './db.js';
import { config } from './config.js';
import { ipKey } from './auth.js';
import { logEvent } from './logs.js';

export type SecurityKind =
  | 'login.failed' | 'login.blocked' | 'login.ok' | 'mfa.failed'
  | `notice.${string}`
  | `export.${string}`
  | 'login.google_rejected'
  | `session.${string}` | `user.${string}` | `invite.${string}` | `password_reset.${string}`
  | 'ip.blocked' | 'ip.unblocked'
  | 'contact.erased' | 'account.deleted' | 'account.entered'
  | 'apikey.created' | 'apikey.revoked' | 'webhook_secret.rotated'
  | 'copilot.code_confirmed'
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

/**
 * Umbrales de las reglas (en una ventana de 15 minutos para el acceso y de 1 hora para los datos), ajustables en .env
 * (`SECURITY_*`). Por omisión: el límite por IP deja pasar 8 intentos cada 15 minutos, así que 8 contra 5 correos
 * distintos ya es probar una lista; 100 fallidas en la plataforma son una lista desde muchas IP; el tope de avisos
 * enviados por hora evita que quien elige la IP o el correo inunde al superadmin.
 */
export const RULES = config.securityRules;

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

/**
 * Anota solo la primera vez por `key` cada `minutes` (p. ej. los intentos frenados por el límite: una ráfaga de miles
 * deja una fila, no miles). Nunca lanza.
 */
export async function recordSecurityOnce(key: string, minutes: number, e: SecurityEvent): Promise<void> {
  try {
    if (await claimOnce(`once:${key}`, minutes)) await recordSecurity(e);
  } catch (err: any) {
    console.error('No se pudo anotar en la bitácora de seguridad', err?.message ?? err);
  }
}

/**
 * Lo que alguien escribió como usuario y no es una cuenta: no se guarda (puede ser su contraseña), solo una huella con
 * llave para contar cuántos «correos» distintos se probaron desde una IP.
 */
export const loginFingerprint = (who: string) =>
  createHmac('sha256', config.sessionSecret || 'riverrun').update(`login:${who.trim().toLowerCase()}`).digest('hex').slice(0, 16);

/** Una vez por `key` cada `minutes` (entre varios procesos también). true si toca. */
async function claimOnce(key: string, minutes: number): Promise<boolean> {
  const row = await queryOne(
    `INSERT INTO security_alerts (key, alerted_at) VALUES ($1, now())
     ON CONFLICT (key) DO UPDATE SET alerted_at = now() WHERE security_alerts.alerted_at < now() - make_interval(mins => $2)
     RETURNING key`,
    [key.slice(0, 300), minutes],
  );
  return !!row;
}

const releaseClaim = (key: string) => query(`DELETE FROM security_alerts WHERE key = $1`, [key.slice(0, 300)]).catch(() => undefined);

/** Envíos de avisos en curso: no detienen la petición que cruzó el umbral (las pruebas esperan con settleSecurityAlerts). */
const inflight = new Set<Promise<void>>();
export async function settleSecurityAlerts() {
  await Promise.all([...inflight]);
}

async function alert(rule: string, target: string, title: string, body: string, e: SecurityEvent) {
  const key = `${rule}:${target}`;
  if (!(await claimOnce(key, 60))) return;
  await query(
    `INSERT INTO security_events (kind, account_id, email, ip, target, details) VALUES ($1, $2, $3, $4, $5, $6)`,
    [`alert.${rule}`, e.accountId ?? null, asEmail(e.email), String(e.ip ?? '').slice(0, 64), target.slice(0, 200), JSON.stringify({ title, body })],
  );
  // Quien controla el objetivo (otra IP, otro correo) abre un aviso nuevo cada vez: un tope global evita que eso inunde
  // el correo del superadmin. Pasado el tope todo queda en la bitácora y se manda un solo aviso de que hay demasiados.
  const sent = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM security_events WHERE kind LIKE 'alert.%' AND kind <> 'alert.flood' AND at > now() - interval '1 hour'`);
  let send: [string, string] | null = [title, body];
  let claimed = key;
  if ((sent?.n ?? 0) > RULES.alertsPerHour) {
    send = null;
    if (await claimOnce('flood', 60)) {
      const flood = `Más de ${RULES.alertsPerHour} avisos de seguridad en la última hora: los siguientes solo quedan en la bitácora durante una hora. Puede ser un ataque desde muchas IP o contra muchas personas.`;
      await query(`INSERT INTO security_events (kind, details) VALUES ('alert.flood', $1)`, [JSON.stringify({ title: 'Demasiados avisos de seguridad', body: flood })]);
      send = ['Demasiados avisos de seguridad', flood];
      claimed = 'flood';
    }
  }
  await logEvent({ level: 'warn', source: 'security', message: `${title}: ${body}`, accountId: e.accountId ?? null });
  if (!send) return;
  const [t, b] = send;
  const job = (async () => {
    try {
      const { sendAlert } = await import('./monitor.js');
      await sendAlert(`🔐 ${t}`, `${b}\n\nRevisa la bitácora de seguridad en Sistema → Seguridad.`);
    } catch (err: any) {
      // Si no salió, la siguiente vez vuelve a intentar (no queda callado una hora sin haber avisado).
      await releaseClaim(claimed);
      console.error('No se pudo mandar el aviso de seguridad', err?.message ?? err);
    }
  })();
  inflight.add(job);
  void job.finally(() => inflight.delete(job));
}

async function detect(e: SecurityEvent) {
  if (e.kind === 'login.failed' || e.kind === 'login.blocked') {
    if (e.ip) {
      const r = await queryOne<{ n: number; people: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT COALESCE(NULLIF(lower(email), ''), details->>'who'))::int AS people FROM security_events
          WHERE kind IN ('login.failed', 'login.blocked') AND ip = $1 AND at > now() - interval '15 minutes'`,
        [e.ip],
      );
      if (r && r.n >= RULES.stuffingFailures && r.people >= RULES.stuffingEmails) {
        const blocked = await blockIp(e.ip, RULES.autoblockMinutes, { failures: r.n, people: r.people });
        await alert('stuffing', e.ip, 'Muchos accesos fallidos desde una IP',
          `${r.n} intentos fallidos en 15 minutos desde ${e.ip}, contra ${r.people} correos distintos: alguien está probando listas de contraseñas. ${blocked
            ? `Esa IP ya no puede entrar durante ${RULES.autoblockMinutes} minutos (se desbloquea en Sistema → Seguridad). Si sigue después, bloquéala en el firewall.`
            : 'El límite por IP ya lo frena; si sigue, bloquéala en el firewall.'}`, e);
      }
    }
    if (e.kind === 'login.failed') {
      // Acotada: cuenta hasta el umbral, no toda la ráfaga.
      const g = await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM security_events WHERE kind = 'login.failed' AND at > now() - interval '15 minutes' LIMIT $1) x`,
        [RULES.globalFailures]);
      if ((g?.n ?? 0) >= RULES.globalFailures) {
        await alert('failures', 'plataforma', 'Muchos accesos fallidos en la plataforma',
          `Más de ${RULES.globalFailures} contraseñas fallidas en 15 minutos, repartidas entre varias IP: puede ser una lista de contraseñas probada desde muchas máquinas. Revisa la bitácora de seguridad (filtro Accesos).`, { ...e, email: '', accountId: null });
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
    if (r && r.n >= RULES.exportsPerHour && r.n >= 2 * (await usualPerHour(`kind LIKE 'export.%'`, e.userId))) {
      await alert('exports', e.userId, 'Muchas descargas de datos de una persona',
        `${e.email || 'Alguien'} descargó datos ${r.n} veces en la última hora (lo último: ${e.kind.slice(7)}). Si no es normal para esa cuenta, revisa quién es y cierra sus sesiones.`, e);
    }
    return;
  }
  if (e.kind === 'contact.erased' && e.userId) {
    const r = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_events WHERE kind = 'contact.erased' AND user_id = $1 AND at > now() - interval '1 hour'`, [e.userId]);
    if (r && r.n >= RULES.erasuresPerHour && r.n >= 2 * (await usualPerHour(`kind = 'contact.erased'`, e.userId))) {
      await alert('erasures', e.userId, 'Muchos contactos borrados por una persona',
        `${e.email || 'Alguien'} borró ${r.n} contactos (con su historial) en la última hora. Lo borrado no se recupera salvo desde un respaldo.`, e);
    }
  }
}

/**
 * Lo normal de una persona: su hora con más eventos de ese tipo en los 30 días anteriores (sin contar la última hora).
 * Quien descarga mucho todos los días no dispara el aviso por hacer lo de siempre; se avisa al doble de lo habitual.
 * Solo se calcula cuando ya se pasó el umbral fijo (no cuesta nada en lo normal).
 */
async function usualPerHour(kindSql: string, userId: string): Promise<number> {
  const r = await queryOne<{ n: number | null }>(
    `SELECT max(n)::int AS n FROM (SELECT count(*) AS n FROM security_events
       WHERE ${kindSql} AND user_id = $1 AND at > now() - interval '30 days' AND at <= now() - interval '1 hour'
       GROUP BY date_trunc('hour', at)) x`, [userId]);
  return r?.n ?? 0;
}

/**
 * Bloquea el acceso desde una IP (o su /64 en IPv6) por `minutes`, con el mismo contador del límite por IP: la petición
 * que llegue desde ahí recibe el mismo «demasiados intentos». Queda en la bitácora (`ip.blocked`). false si está apagado.
 */
async function blockIp(ip: string, minutes: number, details: Record<string, unknown>): Promise<boolean> {
  if (!minutes) return false;
  // Una vez por IP y ventana: los intentos que siguen llegando ya están bloqueados (no se anota ni se alarga de nuevo).
  if (!(await claimOnce(`block:${ipKey(ip)}`, minutes))) return true;
  await query(
    `INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, 100000, now() + make_interval(mins => $2))
     ON CONFLICT (key) DO UPDATE SET hits = 100000, expires_at = GREATEST(rate_limits.expires_at, now() + make_interval(mins => $2))`,
    [`login-ip:${ipKey(ip)}`, minutes]);
  await query(`INSERT INTO security_events (kind, ip, target, details) VALUES ('ip.blocked', $1, $2, $3)`,
    [ip.slice(0, 64), ipKey(ip).slice(0, 200), JSON.stringify({ ...details, minutes })]);
  return true;
}

/** Superadmin: vuelve a dejar entrar desde una IP bloqueada (por la regla o por el límite normal). */
export async function unblockIp(ip: string, by: { userId?: string | null; email?: string; ip?: string }): Promise<boolean> {
  const r = await query(`DELETE FROM rate_limits WHERE key = $1 RETURNING 1`, [`login-ip:${ipKey(ip)}`]);
  // Si vuelve a probar listas después, se vuelve a bloquear.
  await releaseClaim(`block:${ipKey(ip)}`);
  await recordSecurity({ kind: 'ip.unblocked', userId: by.userId ?? null, email: by.email, ip: by.ip, target: ipKey(ip) });
  return r.length > 0;
}

/** Lo que se muestra: el superadmin todo; un administrador, lo de su cuenta. */
export async function listSecurityEvents(o: { accountId?: string | null; kind?: string; email?: string; ip?: string; before?: number; limit?: number; excludeAlerts?: boolean }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (o.accountId) add('account_id = ?', o.accountId);
  if (o.excludeAlerts) where.push(`kind NOT LIKE 'alert.%'`);
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
