import crypto from 'node:crypto';
import { HttpError } from '../access.js';
import { assertWithinLimit } from '../billing/limits.js';
import { brandOfAccount, DEFAULT_BRAND } from '../brands.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { mergeChannelConfig } from './index.js';
import { metaConnectEnabled } from './meta-connect.js';
import { accountInfo, clientFor, disconnectAccount, dmNetworkOf, ensurePlatformWebhook, idOf, networkOf, profileFor, ZernioError } from './zernio.js';
import { accountProfile, assertSocialRoom, disconnectZernio, FRESH_CONNECTION, ZernioDisconnectError, ZernioOwnershipError } from './zernio-connect.js';
import { publicHealth } from '../social/health.js';

/**
 * Redes sociales del negocio (por Zernio), sin pasar por una conexión de mensajes: el negocio conecta su red desde
 * "Redes sociales", o el administrador le manda un enlace. La cuenta solo se guarda si Zernio confirma que está en el
 * perfil de ese negocio. Si la red tiene mensajes directos, se crea (o reutiliza) su conexión para que el agente conteste.
 */

const PANEL_TTL_MS = 30 * 60_000;
export const LINK_TTL_DAYS = 7;
const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Con "Conectar con Facebook" directo activo, Facebook e Instagram por Zernio no contestan mensajes (evita respuestas dobles). */
const META_DIRECT = new Set(['facebook', 'instagram']);
/** ¿Los mensajes directos de esta red los atiende la plataforma por Zernio? */
export const zernioHandlesDm = (platform: string) => !!dmNetworkOf(platform) && !(metaConnectEnabled() && META_DIRECT.has(platform));

/** Opciones de la conexión: WhatsApp elige el perfil (uno por número) y si sigue usando la app en el teléfono. */
export interface ConnectOptions {
  profile_id?: string;
  onboarding?: 'api' | 'business_app';
}

export interface ConnectSession {
  id: string;
  account_id: string;
  platform: string;
  chatbot_id: string | null;
  kind: 'panel' | 'link';
  reconnect_account_id: string;
  options: ConnectOptions;
  expires_at: string;
  used_at: string | null;
  fresh: boolean;
}

/**
 * Abre una conexión de red para el negocio y devuelve el token del retorno (panel: 30 minutos y un solo uso; enlace
 * para el cliente: 7 días, hasta que conecte). Solo redes que se autorizan en su propia página (OAuth).
 */
export async function createConnectSession(
  accountId: string,
  platform: string,
  opts: { kind: 'panel' | 'link'; chatbotId?: string | null; userId?: string | null; reconnect?: string; onboarding?: 'api' | 'business_app' },
): Promise<{ token: string; expires_at: string }> {
  const network = networkOf(platform);
  if (!network) throw new HttpError(400, 'Elige una red válida');
  if (network.flow !== 'oauth') throw new HttpError(400, `${network.label} se conecta desde su conexión de mensajes (con código o contraseña de aplicación), no con un enlace`);
  if (!config.publicBaseUrl.startsWith('https://')) throw new HttpError(400, 'Zernio exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)');
  let reconnect = '';
  const options: ConnectOptions = {};
  if (opts.reconnect) {
    const row = await queryOne<{ zernio_account_id: string; platform: string; profile_id: string }>(`SELECT zernio_account_id, platform, profile_id FROM social_accounts WHERE id = $1 AND account_id = $2`, [opts.reconnect, accountId]);
    if (!row || row.platform !== platform) throw new HttpError(404, 'Esa red no está en este negocio');
    reconnect = row.zernio_account_id;
    // Se reconecta en el perfil donde ya está (WhatsApp puede estar en un perfil adicional del negocio).
    if (await tenantProfile(accountId, row.profile_id)) options.profile_id = row.profile_id;
  } else {
    await assertWithinLimit(accountId, 'social_accounts');
    if (platform === 'whatsapp') options.profile_id = await whatsappProfileFor(accountId);
  }
  if (platform === 'whatsapp' && opts.onboarding) options.onboarding = opts.onboarding;
  await query(`DELETE FROM zernio_connect_sessions WHERE expires_at < now() - interval '1 day'`);
  const token = crypto.randomBytes(24).toString('base64url');
  const ttl = opts.kind === 'link' ? LINK_TTL_DAYS * 86400_000 : PANEL_TTL_MS;
  const row = await queryOne<{ expires_at: string }>(
    `INSERT INTO zernio_connect_sessions (state_hash, account_id, platform, chatbot_id, created_by, kind, reconnect_account_id, options, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9)) RETURNING expires_at`,
    [hashOf(token), accountId, platform, opts.chatbotId ?? null, opts.userId ?? null, opts.kind, reconnect, JSON.stringify(options), ttl / 1000]);
  return { token, expires_at: new Date(row!.expires_at).toISOString() };
}

/** La sesión del token (sin gastarla). */
export async function connectSession(token: string): Promise<ConnectSession | null> {
  if (!token || token.length > 100) return null;
  return queryOne<ConnectSession>(`SELECT *, expires_at > now() AS fresh FROM zernio_connect_sessions WHERE state_hash = $1`, [hashOf(token)]);
}

/** Página de Zernio donde se autoriza la red. Con un enlace para el cliente, Zernio muestra antes la marca del negocio. */
export async function connectAuthUrl(session: ConnectSession, token: string): Promise<string> {
  const profileId = session.options?.profile_id || (await accountProfile(session.account_id));
  const q = new URLSearchParams({ profileId, redirect_url: `${config.publicBaseUrl}/zernio/return/${token}` });
  if (session.reconnect_account_id) q.set('reconnectAccountId', session.reconnect_account_id);
  const brand = await brandOfAccount(session.account_id);
  q.set('brandName', (brand?.name || DEFAULT_BRAND.name).slice(0, 60));
  if (/^#[0-9a-f]{6}$/i.test(brand?.color ?? '')) q.set('primaryColor', brand!.color);
  if (session.platform === 'whatsapp') {
    // Alta de WhatsApp en una página de Zernio (Embedded Signup de Meta), en español.
    q.set('signup', 'hosted');
    q.set('language', 'es');
    // business_app: el número sigue funcionando en la app WhatsApp Business del teléfono (coexistencia).
    if (session.options?.onboarding) q.set('onboarding', session.options.onboarding);
  } else if (session.kind === 'link') {
    q.set('welcome', 'true');
    if (brand?.logo_type && config.publicBaseUrl.startsWith('https://')) q.set('logoUrl', `${config.publicBaseUrl}/brand/${brand.id}/logo?v=${brand.logo_version}`);
  }
  const r = await clientFor().call<any>('GET', `/connect/${encodeURIComponent(session.platform)}?${q}`);
  const url = r?.authUrl ?? r?.url ?? r?.data?.authUrl;
  if (!url) throw new Error('Zernio no devolvió la URL de autorización');
  return url;
}

/** ¿El perfil de Zernio es de este negocio (el principal o uno adicional)? */
async function tenantProfile(accountId: string, profileId: string): Promise<boolean> {
  if (!profileId) return false;
  return !!(await queryOne(`SELECT 1 FROM zernio_profiles WHERE profile_id = $1 AND account_id = $2 UNION SELECT 1 FROM accounts WHERE id = $2 AND zernio_profile_id = $1`, [profileId, accountId]));
}

/**
 * Perfil donde se conecta un número de WhatsApp: Zernio permite uno por perfil, así que el segundo número de un negocio
 * va en un perfil adicional suyo (externalId "<negocio>:wa2"…). Se usa el primero que no tenga WhatsApp.
 */
export async function whatsappProfileFor(accountId: string): Promise<string> {
  const primary = await accountProfile(accountId);
  return withTransaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('zernio-wa-profile:' || $1))`, [accountId]);
    const profiles = (await db.query<{ profile_id: string }>(
      `SELECT $2::text AS profile_id, 0 AS ord UNION ALL SELECT profile_id, 1 FROM zernio_profiles WHERE account_id = $1 AND profile_id <> $2 ORDER BY ord, profile_id`, [accountId, primary])).rows;
    for (const p of profiles) {
      const busy = await db.query(`SELECT 1 FROM social_accounts WHERE account_id = $1 AND profile_id = $2 AND platform = 'whatsapp' AND status <> 'disconnected' LIMIT 1`, [accountId, p.profile_id]);
      if (!busy.rowCount) return p.profile_id;
    }
    const n = profiles.length + 1;
    const name = (await db.query<{ name: string }>(`SELECT name FROM accounts WHERE id = $1`, [accountId])).rows[0]?.name ?? 'Negocio';
    const externalId = `${accountId}:wa${n}`;
    const profileId = await profileFor(clientFor(), { id: externalId, name: `${name} · WhatsApp ${n}` });
    await db.query(`INSERT INTO zernio_profiles (profile_id, account_id, external_id, is_primary) VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING`, [profileId, accountId, externalId]);
    return profileId;
  });
}

export type FinishCode = 'ok' | 'not_yours' | 'in_use' | 'cancelled' | 'expired' | 'limit' | 'error' | 'invalid';

/**
 * Zernio regresó del permiso. El estado del panel sirve una vez (salga bien o no); el enlace del cliente sirve hasta que
 * conecta (si cancela, puede volver a abrirlo). La cuenta de la URL no se cree: se confirma con Zernio en el perfil.
 */
export async function finishConnect(token: string, q: Record<string, string | undefined>): Promise<{ code: FinishCode; session: ConnectSession | null }> {
  const session = await connectSession(token);
  if (!session || session.used_at) return { code: 'invalid', session };
  if (session.kind === 'panel') {
    const claimed = await query(`UPDATE zernio_connect_sessions SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [session.id]);
    if (!claimed.length) return { code: 'invalid', session };
  }
  if (!session.fresh) return { code: 'expired', session };
  if (q.error || !q.accountId) {
    await logEvent({ level: 'warn', source: 'channel', message: `Zernio: la conexión de ${networkOf(session.platform)?.label ?? session.platform} no se completó${q.error ? ` (${String(q.error).slice(0, 80)})` : ''}`, accountId: session.account_id });
    return { code: q.error ? 'cancelled' : 'error', session };
  }
  try {
    await adoptAccount(session.account_id, session.platform, String(q.accountId), { chatbotId: session.chatbot_id, via: session.kind, profileId: session.options?.profile_id });
  } catch (e: any) {
    if (e instanceof ZernioOwnershipError) return { code: e.code, session };
    if (e instanceof HttpError && e.issues?.includes('limit_reached')) return { code: 'limit', session };
    await logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo guardar la red conectada: ${e?.message ?? e}`, accountId: session.account_id });
    return { code: 'error', session };
  }
  if (session.kind === 'link') await query(`UPDATE zernio_connect_sessions SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [session.id]);
  return { code: 'ok', session };
}

/**
 * Guarda una cuenta conectada como del negocio (si Zernio confirma que está en su perfil y es de esa red) y, si la red
 * tiene mensajes directos, la deja en una conexión para que el agente conteste.
 */
export async function adoptAccount(accountId: string, platform: string, zernioAccountId: string, opts: { chatbotId?: string | null; via: 'panel' | 'link' | 'sync'; profileId?: string }) {
  const profileId = opts.profileId && (await tenantProfile(accountId, opts.profileId)) ? opts.profileId : await accountProfile(accountId);
  const info = await accountInfo(clientFor(), profileId, zernioAccountId);
  if (!info || (info.platform && info.platform !== platform)) {
    await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: la cuenta devuelta no pertenece al perfil de este negocio; no se conectó', accountId, details: { account: zernioAccountId } });
    throw new ZernioOwnershipError('not_yours', 'Esa cuenta no pertenece a este negocio. Vuelve a pulsar "Conectar" e inicia sesión con la cuenta correcta.');
  }
  await assertSocialRoom(accountId, zernioAccountId);
  const row = await queryOne<{ id: string; channel_id: string | null; chatbot_id: string | null }>(
    `INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name, picture, status, chatbot_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
     ON CONFLICT (zernio_account_id) DO UPDATE SET profile_id = $3, platform = $4, username = $5, display_name = $6, picture = $7, status = 'active',
       chatbot_id = COALESCE($8, social_accounts.chatbot_id), updated_at = now(), ${FRESH_CONNECTION}
     WHERE social_accounts.account_id = $1 RETURNING id, channel_id, chatbot_id`,
    [accountId, zernioAccountId, profileId, platform, info.username, info.displayName, info.picture, opts.chatbotId ?? null]);
  if (!row) throw new ZernioOwnershipError('in_use', 'Esta cuenta ya está conectada en otro negocio.');
  const label = networkOf(platform)?.label ?? platform;
  if (zernioHandlesDm(platform)) await linkChannel(accountId, row, { platform, zid: zernioAccountId, profileId, info, chatbotId: opts.chatbotId ?? row.chatbot_id });
  await ensurePlatformWebhook(clientFor()).catch((e) =>
    logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo registrar el webhook de la plataforma: ${e?.message ?? e}`, accountId }));
  // Comentarios y reseñas de los últimos días: se traen en segundo plano (no retrasan la conexión).
  const net = networkOf(platform);
  if (net?.comments || net?.reviews) {
    await query(`INSERT INTO jobs (account_id, type, payload, run_at, dedupe_key) VALUES ($1, 'social_sync', $2, now() + interval '1 minute', $3) ON CONFLICT DO NOTHING`,
      [accountId, JSON.stringify({ social_account_id: row.id }), `social_sync:${row.id}`]);
  }
  const how = opts.via === 'link' ? ' con el enlace de conexión' : opts.via === 'sync' ? ' (sincronizada desde Zernio)' : '';
  await logEvent({ level: 'info', source: 'channel', message: `Zernio: ${label} conectada${info.username ? ` (@${info.username})` : ''}${how}`, accountId });
  return row.id;
}

/**
 * Conexión de mensajes de la cuenta: la que ya tenía, una de esa red que espera cuenta (p. ej. tras desconectarla), o una
 * nueva. Si el plan no permite más conexiones, la red queda guardada sin mensajes y se avisa.
 */
async function linkChannel(
  accountId: string,
  row: { id: string; channel_id: string | null },
  a: { platform: string; zid: string; profileId: string; info: { username: string; displayName: string; picture: string }; chatbotId: string | null },
): Promise<Channel | null> {
  const values = { platform: a.platform, profile_id: a.profileId, account_id: a.zid, username: a.info.username, display_name: a.info.displayName, picture: a.info.picture, connect_state: '', telegram_code: '' };
  let ch = row.channel_id ? await store.getChannel(row.channel_id) : null;
  if (!ch) {
    const id = (await queryOne<{ id: string }>(
      `SELECT id FROM channels WHERE account_id = $1 AND type = 'zernio' AND (config->>'account_id' = $2
         OR (config->>'platform' = $3 AND coalesce(config->>'account_id', '') = '' AND NOT EXISTS (SELECT 1 FROM social_accounts s WHERE s.channel_id = channels.id)))
       ORDER BY (config->>'account_id' = $2) DESC, created_at LIMIT 1`, [accountId, a.zid, a.platform]))?.id;
    ch = id ? await store.getChannel(id) : null;
  }
  try {
    if (ch) {
      ch = (await store.updateChannel(ch.id, { config: mergeChannelConfig('zernio', ch.config, values), ...(a.chatbotId ? { chatbot_id: a.chatbotId } : {}) }))!;
    } else {
      try {
        await assertWithinLimit(accountId, 'channels');
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        await logEvent({ level: 'warn', source: 'channel', message: `Zernio: ${networkOf(a.platform)?.label} quedó conectada sin mensajes: tu plan no permite más conexiones`, accountId });
        return null;
      }
      ch = await store.createChannel({
        account_id: accountId, chatbot_id: a.chatbotId, type: 'zernio', active: true,
        name: `${networkOf(a.platform)?.label ?? a.platform}${a.info.username ? ` @${a.info.username}` : ''}`.slice(0, 120),
        config: mergeChannelConfig('zernio', {}, values),
      });
    }
  } catch (e: any) {
    if (e?.code === '23505') throw new ZernioOwnershipError('in_use', 'Esta cuenta ya está conectada en otra conexión. Desconéctala ahí primero.');
    throw e;
  }
  await query(`UPDATE social_accounts SET channel_id = NULL WHERE channel_id = $1 AND id <> $2`, [ch.id, row.id]);
  await query(`UPDATE social_accounts SET channel_id = $2, chatbot_id = $3 WHERE id = $1`, [row.id, ch.id, ch.chatbot_id]);
  await recordConnectionState(ch, 'open');
  return ch;
}

/** Redes del negocio para "Redes sociales" (sin identificadores de Zernio). */
export async function listSocialAccounts(accountId: string) {
  const rows = await query<any>(
    `SELECT s.id, s.platform, s.username, s.display_name, s.picture, s.status, s.channel_id, COALESCE(c.chatbot_id, s.chatbot_id) AS chatbot_id, s.comment_settings, s.connected_at,
            s.health, s.token_expires_at
       FROM social_accounts s LEFT JOIN channels c ON c.id = s.channel_id WHERE s.account_id = $1 ORDER BY s.connected_at, s.id`, [accountId]);
  return rows.map(({ health, token_expires_at, ...r }) => ({ ...r, dm: zernioHandlesDm(r.platform), health: publicHealth({ platform: r.platform, status: r.status, health, token_expires_at }) }));
}

const socialRow = async (accountId: string, id: string) => {
  const row = await queryOne<{ id: string; zernio_account_id: string; profile_id: string; platform: string; username: string; display_name: string; picture: string; channel_id: string | null; chatbot_id: string | null }>(
    `SELECT * FROM social_accounts WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!row) throw new HttpError(404, 'Red no encontrada');
  return row;
};

/** Quién contesta los mensajes de la red: crea o actualiza su conexión de mensajes. */
export async function setSocialAgent(accountId: string, id: string, chatbotId: string | null) {
  const row = await socialRow(accountId, id);
  if (!zernioHandlesDm(row.platform)) throw new HttpError(400, 'Los mensajes de esta red no se contestan desde aquí');
  if (row.channel_id) {
    const ch = await store.updateChannel(row.channel_id, { chatbot_id: chatbotId });
    await query(`UPDATE social_accounts SET chatbot_id = $2, updated_at = now() WHERE id = $1`, [row.id, chatbotId]);
    if (ch?.connection_state === 'open') await recordConnectionState(ch, 'open');
    return;
  }
  // linkChannel reutiliza una conexión que espera cuenta o crea otra (y ahí revisa el límite de conexiones del plan).
  const ch = await linkChannel(accountId, row, { platform: row.platform, zid: row.zernio_account_id, profileId: row.profile_id, info: { username: row.username, displayName: row.display_name, picture: row.picture }, chatbotId });
  if (!ch) throw new HttpError(403, 'Tu plan no permite más conexiones de mensajes', ['limit_reached']);
}

/**
 * Desconecta la red en Zernio. Primero se quita allá: si Zernio falla, no se toca nada (no se dice "desconectada" de una
 * cuenta que sigue activa y cobrándose). Su conexión de mensajes se conserva, con su historial, para cuando vuelva.
 */
export async function disconnectSocialAccount(accountId: string, id: string) {
  const row = await socialRow(accountId, id);
  await disconnectAccount(clientFor(), row.zernio_account_id).catch((e) => {
    if (e instanceof ZernioError && e.status === 404) return;
    throw new HttpError(502, new ZernioDisconnectError(e).message);
  });
  const ch = row.channel_id ? await store.getChannel(row.channel_id) : null;
  if (ch && ch.config.account_id === row.zernio_account_id) await disconnectZernio(ch, 'skip');
  await query(`DELETE FROM social_accounts WHERE id = $1 AND account_id = $2`, [row.id, accountId]);
  await logEvent({ level: 'warn', source: 'admin', message: `Zernio: ${networkOf(row.platform)?.label ?? row.platform}${row.username ? ` (@${row.username})` : ''} desconectada desde Redes sociales`, accountId });
}

/* ------------------------------ Administrador de la plataforma ------------------------------ */

/** Negocios con su perfil, sus redes y los mensajes que enviaron este mes por Zernio (lo que cobra Zernio). */
export async function zernioTenants() {
  const rows = await query<any>(
    `SELECT a.id AS account_id, a.name, a.active, a.status, a.zernio_profile_id AS profile_id,
            COALESCE((SELECT json_agg(json_build_object('id', s.id, 'platform', s.platform, 'username', s.username, 'status', s.status) ORDER BY s.connected_at)
                        FROM social_accounts s WHERE s.account_id = a.id), '[]'::json) AS accounts
       FROM accounts a ORDER BY lower(a.name), a.id LIMIT 2000`);
  const out = await query<{ account_id: string; n: number }>(
    `SELECT ch.account_id, count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.type = 'zernio' AND m.direction = 'out' AND m.created_at >= date_trunc('month', now()) GROUP BY ch.account_id`);
  const sent = new Map(out.map((r) => [r.account_id, r.n]));
  return rows.map((r) => ({ ...r, outbound_month: sent.get(r.account_id) ?? 0 }));
}

/**
 * Trae de Zernio las cuentas del perfil del negocio: adopta las que se conectaron allá y marca desconectadas las que ya
 * no están (avisando en su conexión de mensajes).
 */
export async function syncTenant(accountId: string): Promise<{ accounts: number }> {
  const primary = await accountProfile(accountId);
  // Todos sus perfiles: el principal y los adicionales (un número de WhatsApp por perfil).
  const profiles = [primary, ...(await query<{ profile_id: string }>(`SELECT profile_id FROM zernio_profiles WHERE account_id = $1 AND profile_id <> $2`, [accountId, primary])).map((r) => r.profile_id)];
  // Lo pide una persona desde el panel: prioridad normal.
  const client = clientFor();
  const startedAt = (await queryOne<{ now: string }>(`SELECT now() AS now`))!.now;
  let complete = true;
  const remote: { a: any; profileId: string }[] = [];
  for (const profileId of profiles) {
    const page = await client.listPages(`/accounts?profileId=${encodeURIComponent(profileId)}`, 'accounts', 10);
    complete &&= page.complete;
    remote.push(...page.items.map((a) => ({ a, profileId })));
  }
  const ids = new Set<string>();
  for (const { a, profileId } of remote) {
    const zid = idOf(a);
    const platform = String(a.platform ?? '');
    if (!zid || !networkOf(platform)) continue;
    ids.add(zid);
    const active = a.isActive !== false && !a.needsReconnection;
    const known = await queryOne<{ id: string; account_id: string; status: string; channel_id: string | null }>(`SELECT id, account_id, status, channel_id FROM social_accounts WHERE zernio_account_id = $1`, [zid]);
    if (known && known.account_id !== accountId) continue;
    if (known) {
      // Al volver a estar activa se olvida la salud de la caída (la próxima revisión la vuelve a leer).
      await query(`UPDATE social_accounts SET username = $2, display_name = $3, picture = $4, status = $5, last_checked_at = now(), updated_at = now(),
          health = CASE WHEN status <> 'active' AND $5 = 'active' THEN '{}'::jsonb ELSE health END,
          down_since = CASE WHEN $5 = 'active' THEN NULL WHEN status = 'needs_reconnect' THEN coalesce(down_since, now()) ELSE now() END,
          down_notified_at = CASE WHEN $5 = 'active' THEN NULL ELSE down_notified_at END
        WHERE id = $1`,
        [known.id, String(a.username ?? ''), String(a.displayName ?? ''), String(a.profilePicture ?? ''), active ? 'active' : 'needs_reconnect']);
      // Volvió a aparecer en Zernio: su conexión de mensajes vuelve a quedar en línea.
      const ch = known.status !== 'active' && active && known.channel_id ? await store.getChannel(known.channel_id) : null;
      if (ch && ch.config.account_id === zid) await recordConnectionState(ch, 'open');
    } else {
      await query(
        `INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name, picture, status, last_checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) ON CONFLICT (zernio_account_id) DO NOTHING`,
        [accountId, zid, profileId, platform, String(a.username ?? ''), String(a.displayName ?? ''), String(a.profilePicture ?? ''), active ? 'active' : 'needs_reconnect']);
    }
  }
  // Lo que ya no está en Zernio queda desconectado, solo con la lista completa y sin tocar lo que cambió mientras tanto
  // (p. ej. una red que el cliente terminó de conectar durante la sincronización).
  if (!complete) return { accounts: ids.size };
  const gone = await query<{ id: string; channel_id: string | null }>(
    `UPDATE social_accounts SET status = 'disconnected', updated_at = now()
      WHERE account_id = $1 AND profile_id = ANY($2::text[]) AND status <> 'disconnected' AND NOT (zernio_account_id = ANY($3::text[])) AND updated_at < $4
     RETURNING id, channel_id`, [accountId, profiles, [...ids], startedAt]);
  for (const g of gone) {
    const ch = g.channel_id ? await store.getChannel(g.channel_id) : null;
    if (ch) await recordConnectionState(ch, 'close', 'zernio_account_missing');
  }
  return { accounts: ids.size };
}

/** Desconecta en Zernio todas las redes del negocio (p. ej. si dejó de pagar). Su perfil se conserva. */
export async function disconnectAllTenant(accountId: string): Promise<number> {
  const rows = await query<{ id: string }>(`SELECT id FROM social_accounts WHERE account_id = $1`, [accountId]);
  for (const r of rows) await disconnectSocialAccount(accountId, r.id);
  return rows.length;
}

/** Entregas del webhook de la plataforma en los últimos 30 días (el registro lo guarda Zernio). */
export async function webhookLogs(filter: { failed?: boolean } = {}) {
  const client = clientFor();
  const hooks = (await client.call<any>('GET', '/webhooks/settings'))?.webhooks ?? [];
  const mine = (Array.isArray(hooks) ? hooks : []).find((w: any) => w.url === `${config.publicBaseUrl}/zernio/events`);
  if (!mine) return [];
  const q = new URLSearchParams({ webhookId: idOf(mine), limit: '50' });
  if (filter.failed) q.set('status', 'failed');
  const r = await client.call<any>('GET', `/webhooks/logs?${q}`);
  return (Array.isArray(r?.logs) ? r.logs : []).map((l: any) => ({
    id: String(l.eventId ?? ''), webhook_id: String(l.webhookId ?? idOf(mine)), created_at: l.createdAt ?? null, event: String(l.event ?? ''),
    ok: l.status === 'success', status_code: l.statusCode ?? null, error: String(l.errorMessage ?? '').slice(0, 200), attempt: l.attemptNumber ?? null,
  }));
}

/** Vuelve a enviar un evento del registro (el id se conserva: si ya se había procesado, no se repite). */
export async function redeliverWebhook(webhookId: string, eventId: string) {
  try {
    await clientFor().call('POST', '/webhooks/logs/redeliver', { webhookId, eventId });
  } catch (e) {
    if (e instanceof ZernioError && e.status === 422) throw new HttpError(400, 'Ese evento ya no se puede reenviar (Zernio lo guarda 30 días).');
    if (e instanceof ZernioError && e.status === 502) throw new HttpError(502, `Zernio lo reenvió, pero tu servidor volvió a fallar: ${String(e.data?.message ?? '').slice(0, 200)}`);
    throw e;
  }
}

/** Perfiles de la cuenta de Zernio que no son de ningún negocio (de negocios borrados o creados a mano en Zernio). */
export async function orphanProfiles() {
  const client = clientFor();
  const profiles = await client.listAll('/profiles', 'profiles', 20);
  const known = new Set((await query<{ id: string }>(`SELECT profile_id AS id FROM zernio_profiles UNION SELECT zernio_profile_id FROM accounts WHERE zernio_profile_id <> ''`)).map((r) => r.id));
  const accounts = new Set((await query<{ id: string }>(`SELECT id::text AS id FROM accounts`)).map((r) => r.id));
  const orphans = profiles.filter((p) => !known.has(idOf(p)) && !accounts.has(String(p.externalId ?? '')));
  const out = [];
  for (const p of orphans.slice(0, 20)) {
    const n = await client.call<any>('GET', `/accounts?profileId=${encodeURIComponent(idOf(p))}`).then((r) => (Array.isArray(r?.accounts) ? r.accounts.length : 0)).catch(() => null);
    out.push({ id: idOf(p), name: String(p.name ?? ''), external_id: String(p.externalId ?? ''), accounts: n });
  }
  return { profiles: out, total: orphans.length };
}
