import crypto from 'node:crypto';
import { assertWithinLimit } from '../billing/limits.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { hmac, safeEqual } from '../secret.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { mergeChannelConfig } from './index.js';

/**
 * Facebook Messenger e Instagram con un botón: la plataforma tiene UNA app de Meta (META_APP_ID / META_APP_SECRET).
 * Cada negocio pulsa «Conectar con Facebook», inicia sesión, elige sus páginas (y el Instagram vinculado) y el agente que
 * responde; aquí se guardan los tokens de página (no vencen si vienen de un token de usuario de larga duración) y se
 * suscribe la página a los mensajes. Todos los eventos llegan a un solo webhook de la plataforma: /meta/webhook.
 */

export const META_SCOPES = [
  'pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement',
  'instagram_basic', 'instagram_manage_messages', 'business_management',
];
export const SUBSCRIBED_FIELDS = 'messages,messaging_postbacks,message_echoes';
const SESSION_MINUTES = 30;

export const metaConnectEnabled = () => !!(config.meta.appId && config.meta.appSecret);
/** Token con el que Meta verifica el webhook de la plataforma (META_VERIFY_TOKEN o derivado de la clave del servidor). */
export const metaVerifyToken = () => config.meta.verifyToken || hmac('meta-webhook-verify').slice(0, 32);
export const metaWebhookUrl = () => `${config.publicBaseUrl}/meta/webhook`;
export const metaRedirectUrl = () => `${config.publicBaseUrl}/meta/callback`;

const graphBase = () => `${config.metaGraphUrl}/${config.meta.graphVersion}`;

async function graph<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${graphBase()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, signal: AbortSignal.timeout(30000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const err: any = new Error(`Meta ${path.split('?')[0]} → ${res.status}: ${data?.error?.message ?? 'error'}`);
    err.code = data?.error?.code;
    throw err;
  }
  return data as T;
}

/** Firma de Meta en los webhooks: X-Hub-Signature-256 = sha256=HMAC(cuerpo crudo, META_APP_SECRET). */
export function verifyMetaSignature(header: unknown, rawBody: Buffer | undefined): boolean {
  const sig = String(header ?? '');
  if (!config.meta.appSecret || !rawBody || !sig.startsWith('sha256=')) return false;
  return safeEqual(sig, 'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(rawBody).digest('hex'));
}

export interface MetaPage {
  id: string;
  name: string;
  picture: string;
  access_token: string;
  instagram: { id: string; username: string; picture: string } | null;
}

export const META_NONCE_COOKIE = 'meta_nonce';
const nonceHash = (nonce: string) => crypto.createHash('sha256').update(nonce).digest('hex');
/** Las sesiones abandonadas guardan tokens de páginas: se borran al vencer. */
const purgeExpired = () => query(`DELETE FROM meta_connect_sessions WHERE expires_at < now()`);

/**
 * Inicia la conexión: guarda la sesión (estado de un solo uso, 30 min) y devuelve la URL de Facebook y el nonce que va en
 * una cookie del navegador. El regreso exige esa cookie: un enlace de conexión ajeno no sirve para capturar las páginas
 * de quien lo abra.
 */
export async function startMetaConnect(accountId: string, userId: string, chatbotId: string | null): Promise<{ url: string; nonce: string }> {
  if (!metaConnectEnabled()) throw new Error('Facebook no está activado en esta instalación (faltan META_APP_ID y META_APP_SECRET)');
  if (!config.publicBaseUrl.startsWith('https://')) throw new Error('Facebook exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)');
  await purgeExpired();
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  await query(`INSERT INTO meta_connect_sessions (account_id, chatbot_id, state, nonce_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [accountId, chatbotId, state, nonceHash(nonce), userId, SESSION_MINUTES]);
  const q = new URLSearchParams({ client_id: config.meta.appId, redirect_uri: metaRedirectUrl(), state, response_type: 'code' });
  // Con «Facebook Login for Business» la configuración define los permisos; si no, se piden aquí.
  if (config.meta.configId) q.set('config_id', config.meta.configId);
  else q.set('scope', META_SCOPES.join(','));
  return { url: `${config.meta.dialogUrl}/${config.meta.graphVersion}/dialog/oauth?${q}`, nonce };
}

/**
 * Regreso de Facebook: cambia el código por un token de usuario de larga duración y obtiene las páginas (con sus tokens
 * y el Instagram vinculado). Devuelve la sesión para que el negocio elija qué conectar.
 */
export async function finishMetaConnect(state: string, code: string, nonce: string): Promise<{ sessionId: string; accountId: string } | { error: string }> {
  if (!nonce) return { error: 'Abre la conexión desde el mismo navegador donde pulsaste «Conectar con Facebook».' };
  const session = await queryOne<{ id: string; account_id: string }>(
    `UPDATE meta_connect_sessions SET state = NULL WHERE state = $1 AND nonce_hash = $2 AND expires_at > now() RETURNING id, account_id`, [state, nonceHash(nonce)]);
  if (!session) return { error: 'El enlace de conexión venció o ya se usó. Vuelve a pulsar «Conectar con Facebook».' };
  try {
    const short = await graph('GET', 'oauth/access_token', { client_id: config.meta.appId, client_secret: config.meta.appSecret, redirect_uri: metaRedirectUrl(), code });
    const long = await graph('GET', 'oauth/access_token', { grant_type: 'fb_exchange_token', client_id: config.meta.appId, client_secret: config.meta.appSecret, fb_exchange_token: short.access_token });
    const res = await graph('GET', 'me/accounts', {
      access_token: long.access_token ?? short.access_token,
      fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
      limit: '100',
    });
    const pages: MetaPage[] = (res?.data ?? []).filter((p: any) => p?.id && p?.access_token).map((p: any) => ({
      id: String(p.id),
      name: String(p.name ?? ''),
      picture: String(p.picture?.data?.url ?? ''),
      access_token: String(p.access_token),
      instagram: p.instagram_business_account?.id
        ? { id: String(p.instagram_business_account.id), username: String(p.instagram_business_account.username ?? ''), picture: String(p.instagram_business_account.profile_picture_url ?? '') }
        : null,
    }));
    await query(`UPDATE meta_connect_sessions SET pages = $2 WHERE id = $1`, [session.id, JSON.stringify(pages)]);
    return { sessionId: session.id, accountId: session.account_id };
  } catch (e: any) {
    await logEvent({ level: 'error', source: 'channel', message: `Facebook: no se pudo completar la conexión: ${e?.message ?? e}`, accountId: session.account_id });
    return { error: 'Facebook no completó la conexión. Vuelve a intentarlo y acepta todos los permisos.' };
  }
}

/** Páginas de la sesión, sin tokens, para que el negocio elija. */
export async function sessionPages(sessionId: string, accountId: string) {
  const row = await queryOne<{ pages: MetaPage[]; chatbot_id: string | null }>(
    `SELECT pages, chatbot_id FROM meta_connect_sessions WHERE id = $1 AND account_id = $2 AND expires_at > now()`, [sessionId, accountId]);
  if (!row) return null;
  const existing = await query<{ type: string; page_id: string; account_id_ig: string }>(
    `SELECT type, config->>'page_id' AS page_id, config->>'account_id' AS account_id_ig FROM channels WHERE account_id = $1 AND type IN ('messenger','instagram')`, [accountId]);
  return {
    chatbot_id: row.chatbot_id,
    pages: (row.pages ?? []).map((p) => ({
      id: p.id, name: p.name, picture: p.picture,
      messenger_connected: existing.some((c) => c.type === 'messenger' && c.page_id === p.id),
      instagram: p.instagram ? { ...p.instagram, connected: existing.some((c) => c.type === 'instagram' && c.account_id_ig === p.instagram!.id) } : null,
    })),
  };
}

export interface MetaSelection { page_id: string; messenger: boolean; instagram: boolean }

/**
 * Conecta lo elegido: crea o actualiza los canales de Messenger e Instagram (sin datos que el negocio tenga que copiar),
 * suscribe la página a los mensajes y deja el canal en línea. Una página ya conectada solo renueva su token.
 */
export async function applyMetaSelection(sessionId: string, accountId: string, chatbotId: string | null, picks: MetaSelection[]): Promise<Channel[]> {
  // Se toma la sesión (un doble clic u otra pestaña no la aplica dos veces); si algo falla, vuelve a quedar disponible.
  const row = await queryOne<{ pages: MetaPage[]; expires_at: Date }>(
    `UPDATE meta_connect_sessions s SET expires_at = now() FROM (SELECT id, expires_at FROM meta_connect_sessions WHERE id = $1 AND account_id = $2 AND expires_at > now() FOR UPDATE) old
     WHERE s.id = old.id RETURNING s.pages, old.expires_at`, [sessionId, accountId]);
  if (!row) throw new Error('La sesión de Facebook venció o ya se aplicó. Vuelve a pulsar «Conectar con Facebook».');
  try {
    const out = await applyPages(row.pages ?? [], accountId, chatbotId, picks);
    await query(`DELETE FROM meta_connect_sessions WHERE id = $1`, [sessionId]);
    return out;
  } catch (e) {
    await query(`UPDATE meta_connect_sessions SET expires_at = $2 WHERE id = $1`, [sessionId, row.expires_at]);
    throw e;
  }
}

/**
 * Canal conectado con el botón y con token. La marca `meta_connected_at` solo la pone el servidor al conectar: un canal
 * al que alguien le escribió `connected_via` o la página de otro negocio no la tiene, así que no recibe sus eventos.
 */
const CONNECTED = `config->>'connected_via' = 'facebook' AND coalesce(config->>'meta_connected_at','') <> '' AND coalesce(config->>'page_access_token','') <> ''`;

/** Página o Instagram ya atendido por otro negocio de la plataforma (ambos agentes contestarían). */
async function takenElsewhere(accountId: string, type: string, key: string, id: string) {
  return !!(await queryOne(`SELECT 1 FROM channels WHERE account_id <> $1 AND type = $2 AND config->>$3 = $4 AND ${CONNECTED} LIMIT 1`, [accountId, type, key, id]));
}

async function applyPages(pages: MetaPage[], accountId: string, chatbotId: string | null, picks: MetaSelection[]): Promise<Channel[]> {
  const chosen = picks
    .map((pick) => ({ pick, page: pages.find((p) => p.id === pick.page_id) }))
    .filter((x): x is { pick: MetaSelection; page: MetaPage } => !!x.page && (x.pick.messenger || x.pick.instagram));
  const targets = (pick: MetaSelection, page: MetaPage) => [
    pick.messenger ? { type: 'messenger' as const, key: 'page_id', id: page.id, label: page.name } : null,
    pick.instagram && page.instagram ? { type: 'instagram' as const, key: 'account_id', id: page.instagram.id, label: `@${page.instagram.username || page.name}` } : null,
  ].filter((t): t is NonNullable<typeof t> => !!t);
  const taken = (t: { label: string }) => new Error(`${t.label} ya está conectado en otra cuenta de la plataforma. Desconéctalo allá primero.`);
  // Antes de tocar nada: una página o Instagram atendido por otro negocio de la plataforma no se conecta dos veces.
  for (const { pick, page } of chosen) {
    for (const t of targets(pick, page)) if (await takenElsewhere(accountId, t.type, t.key, t.id)) throw taken(t);
  }
  const out: Channel[] = [];
  for (const { pick, page } of chosen) {
    await graph('POST', `${page.id}/subscribed_apps`, { subscribed_fields: SUBSCRIBED_FIELDS, access_token: page.access_token });
    // Un candado por página: dos conexiones a la vez (otra pestaña u otro negocio) no crean canales repetidos. Si aun así
    // otro negocio la conectó en el mismo instante, el índice único lo detiene y se explica igual.
    await withTransaction(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('meta-page:' || $1))`, [page.id]);
      for (const t of targets(pick, page)) {
        if (await takenElsewhere(accountId, t.type, t.key, t.id)) throw taken(t);
        out.push(await (t.type === 'messenger'
          ? upsertChannel(accountId, chatbotId, 'messenger', page.id, `Messenger · ${page.name}`, {
            page_id: page.id, page_access_token: page.access_token, connected_via: 'facebook', meta_connected_at: new Date().toISOString(), meta_verify: '', page_name: page.name, picture: page.picture,
          })
          : upsertChannel(accountId, chatbotId, 'instagram', page.instagram!.id, `Instagram · @${page.instagram!.username || page.name}`, {
            account_id: page.instagram!.id, page_id: page.id, page_access_token: page.access_token, connected_via: 'facebook', meta_connected_at: new Date().toISOString(), meta_verify: '',
            page_name: page.name, username: page.instagram!.username, picture: page.instagram!.picture,
          })).catch((e: any) => { throw e?.code === '23505' ? taken(t) : e; }));
      }
    });
  }
  return out;
}

async function upsertChannel(accountId: string, chatbotId: string | null, type: 'messenger' | 'instagram', ownId: string, name: string, cfg: Record<string, unknown>): Promise<Channel> {
  const key = type === 'messenger' ? 'page_id' : 'account_id';
  const found = await queryOne<{ id: string }>(`SELECT id FROM channels WHERE account_id = $1 AND type = $2 AND config->>$3 = $4 ORDER BY created_at LIMIT 1`, [accountId, type, key, ownId]);
  let ch: Channel;
  if (found) {
    const current = (await store.getChannel(found.id))!;
    ch = (await store.updateChannel(found.id, { config: mergeChannelConfig(type, current.config, cfg), ...(chatbotId && !current.chatbot_id ? { chatbot_id: chatbotId } : {}) }))!;
  } else {
    await assertWithinLimit(accountId, 'channels');
    ch = await store.createChannel({ account_id: accountId, chatbot_id: chatbotId, type, name: name.slice(0, 120), active: true, config: mergeChannelConfig(type, {}, cfg) });
  }
  await recordConnectionState(ch, 'open');
  await logEvent({ level: 'info', source: 'channel', message: `Facebook: ${name} conectado`, accountId, channelId: ch.id });
  return ch;
}

/**
 * Desconecta el canal y borra su token. La suscripción de la página se quita solo si ningún otro canal la usa (Messenger e
 * Instagram de la misma página comparten suscripción: quitarla dejaría al otro sin mensajes).
 */
export async function disconnectMetaChannel(ch: Channel): Promise<Channel> {
  const pageId = String(ch.config.page_id ?? '');
  const sibling = pageId ? await queryOne(`SELECT 1 FROM channels WHERE id <> $1 AND type IN ('messenger','instagram') AND config->>'page_id' = $2
    AND ${CONNECTED} LIMIT 1`, [ch.id, pageId]) : null;
  if (pageId && ch.config.page_access_token && !sibling) {
    await graph('DELETE', `${pageId}/subscribed_apps`, { access_token: ch.config.page_access_token }).catch((e) =>
      logEvent({ level: 'warn', source: 'channel', message: `Facebook: no se pudo quitar la suscripción de la página: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id }));
  }
  await store.setConnectionStateQuiet(ch.id, 'close');
  return (await store.updateChannel(ch.id, { config: { ...ch.config, page_access_token: '' } }))!;
}

/** Canales conectados con el botón (el webhook es el de la plataforma): dueños de un evento según su objeto e id. */
export async function channelsForEntry(object: string, entryId: string): Promise<Channel[]> {
  const type = object === 'instagram' ? 'instagram' : 'messenger';
  const key = type === 'messenger' ? 'page_id' : 'account_id';
  // Un canal desconectado (sin token) no recibe eventos que no podría contestar.
  const rows = await query<{ id: string }>(`SELECT id FROM channels WHERE type = $1 AND config->>$2 = $3 AND ${CONNECTED}`, [type, key, entryId]);
  const out: Channel[] = [];
  for (const r of rows) { const ch = await store.getChannel(r.id); if (ch) out.push(ch); }
  return out;
}

/**
 * Revisa los tokens de las páginas conectadas con el botón: si Meta los invalidó (contraseña cambiada, permiso retirado),
 * el canal queda desconectado y se avisa según los ajustes del negocio. Si vuelve a funcionar, queda en línea.
 */
export async function checkMetaTokens(): Promise<{ checked: number; lost: number }> {
  const rows = await query<{ id: string }>(`SELECT id FROM channels WHERE type IN ('messenger','instagram') AND active AND ${CONNECTED} LIMIT 500`);
  const r = { checked: 0, lost: 0 };
  for (const { id } of rows) {
    const ch = await store.getChannel(id);
    if (!ch) continue;
    try {
      await graph('GET', 'me', { fields: 'id', access_token: ch.config.page_access_token });
      r.checked++;
      if (ch.connection_state !== 'open') await recordConnectionState(ch, 'open');
    } catch (e: any) {
      r.checked++;
      // 190: token inválido o vencido; 10/200: permiso retirado. Otros errores (red, Meta caído) no cambian nada.
      if ([190, 10, 200].includes(Number(e?.code))) {
        r.lost++;
        await recordConnectionState(ch, 'close', 'token_revoked');
      }
    }
  }
  return r;
}

/**
 * Canales que ya decían «conectado con Facebook» antes de la marca del servidor (migración 084): se confía en ellos solo si
 * su token es de esa página (y, en Instagram, si esa página tiene ese Instagram). Si no, quedan como manuales y sin token.
 * Un error de red o de Meta los deja pendientes para la siguiente vuelta.
 */
export async function verifyPendingMetaChannels(): Promise<{ verified: number; dropped: number }> {
  const rows = await query<{ id: string }>(`SELECT id FROM channels WHERE type IN ('messenger','instagram') AND config->>'meta_verify' = 'pending'
    AND config->>'connected_via' = 'facebook' AND coalesce(config->>'page_access_token','') <> '' LIMIT 200`);
  const r = { verified: 0, dropped: 0 };
  for (const { id } of rows) {
    const ch = await store.getChannel(id);
    if (!ch) continue;
    const token = String(ch.config.page_access_token);
    let owns = false;
    try {
      const me = await graph<{ id: string }>('GET', 'me', { fields: 'id', access_token: token });
      owns = String(me.id) === String(ch.config.page_id);
      if (owns && ch.type === 'instagram') {
        const page = await graph<{ instagram_business_account?: { id: string } }>('GET', String(ch.config.page_id), { fields: 'instagram_business_account', access_token: token });
        owns = String(page.instagram_business_account?.id ?? '') === String(ch.config.account_id);
      }
    } catch (e: any) {
      if (![190, 10, 200, 100].includes(Number(e?.code))) continue;
    }
    if (owns) {
      await store.updateChannel(ch.id, { config: { ...ch.config, meta_verify: '', meta_connected_at: new Date().toISOString() } });
      r.verified++;
    } else {
      await store.updateChannel(ch.id, { config: { ...ch.config, meta_verify: '', connected_via: 'manual', page_access_token: '' } });
      await store.setConnectionStateQuiet(ch.id, 'close');
      await logEvent({ level: 'warn', source: 'channel', message: 'Facebook: este canal decía estar conectado con el botón, pero su token no es de esa página. Se desconectó; vuelve a conectarlo con «Conectar con Facebook».', accountId: ch.account_id, channelId: ch.id });
      r.dropped++;
    }
  }
  return r;
}

export function startMetaTokenWatch(intervalMs = 6 * 3600_000) {
  if (!metaConnectEnabled()) return;
  const run = () => void verifyPendingMetaChannels()
    .catch((e) => logEvent({ level: 'error', source: 'channel', message: `Verificación de canales de Facebook: ${e?.message ?? e}` }))
    .then(() => checkMetaTokens())
    .catch((e) => logEvent({ level: 'error', source: 'channel', message: `Revisión de tokens de Facebook: ${e?.message ?? e}` }));
  setTimeout(() => void verifyPendingMetaChannels().catch(() => undefined), 30_000).unref();
  setTimeout(run, 5 * 60_000).unref();
  setInterval(() => void purgeExpired().catch(() => undefined), 3600_000).unref();
  setInterval(run, intervalMs).unref();
}
