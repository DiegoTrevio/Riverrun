import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { recordConnectionState, notifySocialAccounts } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { sendAlert } from '../monitor.js';
import { markAlerted, openIncident, resolveIncident } from '../observability/incidents.js';
import * as store from '../store/index.js';
import { clientFor, ensurePlatformWebhook, listOf, networkOf, platformWebhookUrl, zernioEnabled, type ZernioClient } from '../channels/zernio.js';

/**
 * Salud de las redes conectadas por Zernio (cada 6 h): qué cuentas hay que reconectar, cuándo vence su permiso y si el
 * webhook de la plataforma sigue activo (Zernio lo apaga tras 3 días fallando). Avisa una vez por caída y por fecha de
 * vencimiento; nunca marca como caída una cuenta que Zernio no mencionó.
 */

export interface HealthSnap {
  level: 'ok' | 'warning' | 'error';
  reconnect: boolean;
  tokenValid: boolean | null;
  tokenExpiresAt: string | null;
  canPost: boolean | null;
  canFetchAnalytics: boolean | null;
  issues: string[];
}

const bool = (v: unknown) => (v === true ? true : v === false ? false : null);

/** Lo que dice Zernio de una cuenta (acepta la forma de /accounts/health y la de /accounts/{id}/health). */
export function parseHealth(raw: any): HealthSnap {
  const status = String(raw?.status ?? raw?.overallStatus ?? '').toLowerCase();
  const tokenValid = bool(raw?.tokenValid ?? raw?.tokenStatus?.valid);
  const expires = raw?.tokenExpiresAt ?? raw?.tokenStatus?.expiresAt ?? null;
  const reconnect = raw?.needsReconnect === true || raw?.needsReconnection === true || String(raw?.platformConnection?.status ?? '') === 'disconnected';
  const issues = (Array.isArray(raw?.issues) ? raw.issues : []).map((x: any) => String(typeof x === 'string' ? x : x?.message ?? x?.code ?? '')).filter(Boolean).slice(0, 5);
  return {
    level: reconnect || status === 'error' ? 'error' : status === 'warning' || tokenValid === false ? 'warning' : 'ok',
    reconnect,
    tokenValid,
    tokenExpiresAt: expires && !Number.isNaN(Date.parse(String(expires))) ? new Date(String(expires)).toISOString() : null,
    canPost: bool(raw?.canPost ?? raw?.permissions?.canPost),
    canFetchAnalytics: bool(raw?.canFetchAnalytics ?? raw?.permissions?.canFetchAnalytics),
    issues,
  };
}

/** Redes cuyo permiso vence y hay que renovar (las demás lo renuevan solas). */
const EXPIRY_WARN = new Set(['instagram', 'facebook', 'threads', 'linkedin']);

interface Row { id: string; account_id: string; zernio_account_id: string; platform: string; username: string; display_name: string; status: string; channel_id: string | null; health: any; token_expires_at: string | null; token_warned_for: string | null }

const label = (r: Pick<Row, 'platform' | 'username' | 'display_name'>) => `${networkOf(r.platform)?.label ?? r.platform}${r.username ? ` (@${r.username})` : r.display_name ? ` (${r.display_name})` : ''}`;

/** Canal de mensajes que de verdad usa esta cuenta de Zernio (si lo hay). */
async function channelOf(r: Row) {
  if (!r.channel_id) return null;
  const ch = await store.getChannel(r.channel_id);
  return ch && ch.type === 'zernio' && String(ch.config.account_id ?? '') === r.zernio_account_id ? ch : null;
}

/** Una réplica por vuelta: la que aparta la vuelta en system_state. */
async function claimRun(key: string, minutes: number) {
  const row = await queryOne(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, '{}', now())
     ON CONFLICT (key) DO UPDATE SET updated_at = now() WHERE system_state.updated_at < now() - ($2::int * interval '1 minute') RETURNING key`, [key, minutes]);
  return !!row;
}

/**
 * Revisa todas las cuentas en una sola llamada. `force` (botón "Revisar ahora") no espera la vuelta de 6 h.
 * Devuelve cuántas cuentas cayeron y cuántas volvieron.
 */
export async function checkZernioHealth(o: { force?: boolean; client?: ZernioClient } = {}) {
  if (!zernioEnabled()) return { down: 0, back: 0, warned: 0, mass: false, skipped: true };
  if (!o.force && !(await claimRun('zernio_health_run', 350))) return { down: 0, back: 0, warned: 0, mass: false, skipped: true };
  const client = o.client ?? clientFor(null, 'background');
  let r: any;
  try {
    r = await client.call<any>('GET', '/accounts/health');
  } catch (e) {
    // Sin respuesta de Zernio la vuelta no cuenta: la siguiente (en una hora) lo vuelve a intentar.
    if (!o.force) await query(`UPDATE system_state SET updated_at = now() - interval '300 minutes' WHERE key = 'zernio_health_run'`);
    throw e;
  }
  const list = listOf(r, 'accounts');
  const byId = new Map(list.map((x: any) => [String(x?.accountId ?? x?.id ?? x?._id ?? ''), x]));
  const rows = await query<Row>(`SELECT * FROM social_accounts WHERE status IN ('active', 'needs_reconnect')`);
  const plan: { row: Row; snap: HealthSnap; invalid: number; broken: boolean }[] = [];
  for (const row of rows) {
    const raw = byId.get(row.zernio_account_id);
    // Zernio no la mencionó: no se sabe nada de ella (no se marca como caída).
    if (!raw) continue;
    const snap = parseHealth(raw);
    // Meta a veces dice que el permiso venció sin que sea cierto: hace falta verlo dos veces seguidas.
    const invalid = snap.tokenValid === false ? Number(row.health?.token_invalid_count ?? 0) + 1 : 0;
    plan.push({ row, snap, invalid, broken: snap.reconnect || invalid >= 2 });
  }
  const active = plan.filter((p) => p.row.status === 'active');
  const newlyBroken = active.filter((p) => p.broken);
  // Si cae más de la mitad de golpe, es más probable un problema de Zernio que de cada negocio: no se cambia nada y se
  // avisa al administrador de la plataforma.
  const mass = newlyBroken.length > 5 && newlyBroken.length > active.length / 2;
  if (mass) {
    const inc = await openIncident('zernio_health_mass', 'Zernio: muchas cuentas aparecen desconectadas a la vez', `${newlyBroken.length} de ${active.length} cuentas activas. No se marcaron como caídas; revisa el estado de Zernio.`);
    if (inc.created || !inc.alerted_at) {
      await sendAlert('Zernio: muchas cuentas aparecen desconectadas a la vez', `${newlyBroken.length} de ${active.length} cuentas activas. No se marcaron como caídas; revisa el estado de Zernio.`).catch(() => undefined);
      await markAlerted(inc.id);
    }
  } else {
    const was = await resolveIncident('zernio_health_mass');
    if (was?.alerted_at) await sendAlert('Zernio: las cuentas volvieron a la normalidad', 'La revisión de salud ya no ve caídas masivas.').catch(() => undefined);
  }
  let down = 0;
  let back = 0;
  const notices = new Map<string, Row[]>();
  for (const p of plan) {
    // En una caída masiva no se cree lo que dice Zernio: no se guarda nada (el negocio no ve avisos falsos).
    if (mass) continue;
    await query(`UPDATE social_accounts SET health = $2, token_expires_at = coalesce($3::timestamptz, token_expires_at), last_checked_at = now() WHERE id = $1`,
      [p.row.id, JSON.stringify({ level: p.snap.level, reconnect: p.snap.reconnect, token_valid: p.snap.tokenValid, token_invalid_count: p.invalid, can_post: p.snap.canPost, can_fetch_analytics: p.snap.canFetchAnalytics, issues: p.snap.issues }), p.snap.tokenExpiresAt]);
    if (p.broken && p.row.status === 'active') {
      const claimed = await queryOne(`UPDATE social_accounts SET status = 'needs_reconnect', down_since = now(), updated_at = now() WHERE id = $1 AND status = 'active' RETURNING id`, [p.row.id]);
      if (!claimed) continue;
      down++;
      const ch = await channelOf(p.row);
      if (ch) await recordConnectionState(ch, 'close', 'zernio_needs_reconnect');
      else notices.set(p.row.account_id, [...(notices.get(p.row.account_id) ?? []), p.row]);
    } else if (!p.broken && p.row.status === 'needs_reconnect' && p.snap.level !== 'error') {
      const claimed = await queryOne(`UPDATE social_accounts SET status = 'active', down_since = NULL, down_notified_at = NULL, updated_at = now() WHERE id = $1 AND status = 'needs_reconnect' RETURNING id`, [p.row.id]);
      if (!claimed) continue;
      back++;
      const ch = await channelOf(p.row);
      if (ch) await recordConnectionState(ch, 'open');
    }
  }
  for (const [accountId, list] of notices) await notifyDown(accountId, list);
  const warned = await warnExpiring();
  await checkPlatformWebhook(client).catch((e) => logEvent({ level: 'warn', source: 'channel', message: `Zernio: no se pudo revisar el webhook de la plataforma: ${e?.message ?? e}` }));
  return { down, back, warned, mass, skipped: false };
}

/** Un aviso por negocio con sus redes caídas (sin canal de mensajes); una vez por caída. */
export async function notifyDown(accountId: string, list: Pick<Row, 'id' | 'platform' | 'username' | 'display_name'>[]) {
  const claimed = await query<{ id: string }>(
    `UPDATE social_accounts SET down_notified_at = now() WHERE id = ANY($1::uuid[]) AND (down_notified_at IS NULL OR down_notified_at < down_since) RETURNING id`, [list.map((x) => x.id)]);
  const mine = list.filter((x) => claimed.some((c) => c.id === x.id));
  if (!mine.length) return;
  await notifySocialAccounts(accountId, mine.length === 1 ? `Hay que volver a conectar ${label(mine[0])}` : `Hay que volver a conectar ${mine.length} redes`,
    `${mine.map(label).join(', ')} ${mine.length === 1 ? 'dejó' : 'dejaron'} de estar conectada${mine.length === 1 ? '' : 's'}: no llegan sus comentarios, publicaciones ni estadísticas. Vuelve a conectarla${mine.length === 1 ? '' : 's'} en Redes sociales.`);
}

/** Permisos que vencen en 1 a 7 días: un aviso por fecha de vencimiento. */
async function warnExpiring() {
  const rows = await query<Row>(
    `UPDATE social_accounts SET token_warned_for = token_expires_at
      WHERE status = 'active' AND platform = ANY($1::text[]) AND token_expires_at BETWEEN now() + interval '1 day' AND now() + interval '7 days'
        AND token_warned_for IS DISTINCT FROM token_expires_at RETURNING *`, [[...EXPIRY_WARN]]);
  const byAccount = new Map<string, Row[]>();
  for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r]);
  for (const [accountId, list] of byAccount) {
    const days = Math.max(1, Math.ceil((Math.min(...list.map((r) => Date.parse(r.token_expires_at!))) - Date.now()) / 86400_000));
    await notifySocialAccounts(accountId, `El permiso de ${list.length === 1 ? label(list[0]) : `${list.length} redes`} vence en ${days} día${days === 1 ? '' : 's'}`,
      `Para no perder la conexión de ${list.map(label).join(', ')}, vuelve a conectar${list.length === 1 ? 'la' : 'las'} en Redes sociales antes de que venza (es un momento: inicias sesión y autorizas otra vez).`);
  }
  return rows.length;
}

/**
 * ¿Sigue activo el webhook de la plataforma? Si Zernio lo apagó (3 días fallando) o tiene muchas fallas, se repara y
 * se avisa al administrador de la plataforma (una vez por incidencia).
 */
export async function checkPlatformWebhook(client: ZernioClient) {
  const hooks = listOf(await client.call('GET', '/webhooks/settings'), 'webhooks');
  const mine = hooks.find((w: any) => w.url === platformWebhookUrl());
  const state = { exists: !!mine, active: mine?.isActive !== false && !!mine, failure_count: Number(mine?.failureCount ?? 0), last_fired_at: mine?.lastFiredAt ?? null, repaired: false, checked_at: new Date().toISOString() };
  if (!state.active) {
    await ensurePlatformWebhook(client, { force: true });
    state.repaired = true;
  } else {
    // Le faltan eventos nuevos (instalaciones anteriores): se ponen al día.
    await ensurePlatformWebhook(client);
  }
  await query(`INSERT INTO system_state (key, value, updated_at) VALUES ('zernio_webhook_health', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [state]);
  const problem = !state.exists ? 'no existía y se volvió a crear' : !state.active ? 'Zernio lo había apagado (por fallas de entrega) y se volvió a activar' : state.failure_count >= 5 ? `tiene ${state.failure_count} entregas fallidas seguidas` : '';
  if (problem) {
    const title = 'Zernio: el webhook de la plataforma tiene problemas';
    const detail = `El webhook (${platformWebhookUrl()}) ${problem}. Mientras falla no llegan mensajes, comentarios ni avisos de las redes. Revisa que el servidor responda en ${config.publicBaseUrl}.`;
    // Ya reparado (o solo con fallas) es un aviso; no se escala como si siguiera caído.
    const inc = await openIncident('zernio_webhook', title, detail, new Date(), state.active || state.repaired ? 'warn' : 'fail');
    if (inc.created || !inc.alerted_at) {
      await sendAlert(title, detail).catch(() => undefined);
      await markAlerted(inc.id);
    }
  } else {
    const was = await resolveIncident('zernio_webhook');
    if (was?.alerted_at) await sendAlert('Zernio: el webhook de la plataforma volvió a la normalidad', 'Las entregas de Zernio llegan otra vez.').catch(() => undefined);
  }
  return state;
}

/** Resumen para el administrador de la plataforma (sin ids de Zernio). */
export async function zernioHealthSummary() {
  const counts = await query<{ level: string; n: number }>(
    `SELECT CASE WHEN status <> 'active' THEN 'error' ELSE coalesce(health->>'level', 'ok') END AS level, count(*)::int AS n
       FROM social_accounts WHERE status IN ('active', 'needs_reconnect') GROUP BY 1`);
  const broken = await query<{ business: string; platform: string; username: string; since: string | null }>(
    `SELECT a.name AS business, s.platform, s.username, s.down_since AS since FROM social_accounts s JOIN accounts a ON a.id = s.account_id
      WHERE s.status = 'needs_reconnect' ORDER BY s.down_since NULLS LAST LIMIT 100`);
  const hook = (await queryOne<{ value: any }>(`SELECT value FROM system_state WHERE key = 'zernio_webhook_health'`))?.value ?? null;
  const analytics = (await queryOne<{ value: any }>(`SELECT value FROM system_state WHERE key = 'zernio_analytics'`))?.value ?? null;
  return {
    counts: Object.fromEntries(counts.map((c) => [c.level, c.n])),
    broken,
    webhook: hook ? { active: hook.active, failure_count: hook.failure_count, last_fired_at: hook.last_fired_at, repaired: hook.repaired, checked_at: hook.checked_at } : null,
    analytics_available: analytics ? analytics.available !== false : null,
  };
}

/** Lo que ve el negocio de la salud de una cuenta (en palabras). */
export function publicHealth(r: { platform: string; status: string; health: any; token_expires_at: string | null }) {
  const h = r.health ?? {};
  // Solo avisan las redes cuyo permiso hay que renovar a mano, y el de estadísticas solo donde hay estadísticas.
  const soon = EXPIRY_WARN.has(r.platform) && r.token_expires_at && Date.parse(r.token_expires_at) - Date.now() < 7 * 86400_000 && Date.parse(r.token_expires_at) > Date.now();
  const problem = r.status !== 'active' ? 'Hay que volver a conectarla'
    : h.level === 'error' ? 'Zernio reporta un problema con la cuenta'
      : soon ? 'Su permiso vence pronto: vuelve a conectarla'
        : h.can_fetch_analytics === false && networkOf(r.platform)?.analytics ? 'Falta el permiso de estadísticas: vuelve a conectarla'
          : h.level === 'warning' ? 'Zernio reporta un aviso' : '';
  return { level: r.status !== 'active' ? 'error' : h.level ?? 'ok', problem, reconnect: !!problem && problem !== 'Zernio reporta un aviso', token_expires_at: r.token_expires_at };
}

/** Cada 6 h (la primera, 5 minutos después de arrancar). */
export function startZernioHealthWatch(intervalMs = 6 * 3600_000) {
  const run = () => void checkZernioHealth().catch((e) => logEvent({ level: 'error', source: 'channel', message: `Revisión de salud de Zernio: ${e?.message ?? e}` }));
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, intervalMs).unref();
}
