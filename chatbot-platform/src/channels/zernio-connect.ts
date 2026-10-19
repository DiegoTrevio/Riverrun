import { assertWithinLimit } from '../billing/limits.js';
import { query, queryOne, withTransaction } from '../db.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { mergeChannelConfig } from './index.js';
import { platformSecretInfo } from '../platform-secrets.js';
import { encryptSecret } from '../secret.js';
import {
  accountInfo, blueskyConnect, clientFor, deleteProfile, platformWebhookUrl, profileExists, ZERNIO_SECRET, ZernioClient, ZernioError, zernioEnabled, zernioKey, zernioKeySource, zernioWorkspace,
  disconnectAccount, ensurePlatformWebhook, networkOf, profileFor, telegramCheck, telegramCode, zernioAuthUrl, type ZernioAccount,
} from './zernio.js';

/** Conexión de redes por Zernio desde el panel: el negocio elige la red y autoriza; el servidor hace lo demás. */

const save = async (channel: Channel, values: Record<string, unknown>) =>
  (await store.updateChannel(channel.id, { config: mergeChannelConfig('zernio', channel.config, values) }))!;

/**
 * Perfil de Zernio del negocio: uno por cuenta, guardado en la cuenta (y en zernio_profiles). Se crea la primera vez que
 * el negocio conecta una red, no al darse de alta: así solo existen perfiles de quien usa las redes. Un candado por
 * cuenta evita crear dos si coinciden dos conexiones.
 */
export async function accountProfile(accountId: string, channel?: Pick<Channel, 'config'>): Promise<string> {
  return withTransaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('zernio-profile:' || $1))`, [accountId]);
    const acc = (await db.query(`SELECT name, zernio_profile_id FROM accounts WHERE id = $1`, [accountId])).rows[0];
    if (!acc) throw new Error('La cuenta no existe');
    if (acc.zernio_profile_id) return String(acc.zernio_profile_id);
    // Cuentas anteriores: el perfil que ya usan sus canales (sin buscarlo en Zernio ni crear otro).
    const legacy = (await db.query(`SELECT config->>'profile_id' AS p FROM channels WHERE account_id = $1 AND type = 'zernio' AND coalesce(config->>'profile_id','') <> '' ORDER BY created_at LIMIT 1`, [accountId])).rows[0]?.p;
    // La llamada a Zernio tiene límite de 30 s; el candado de la cuenta evita crear dos perfiles si coinciden el alta y la primera conexión.
    const profileId = legacy || await profileFor(clientFor(channel), { id: accountId, name: String(acc.name ?? '') });
    await db.query(`UPDATE accounts SET zernio_profile_id = $2 WHERE id = $1`, [accountId, profileId]);
    await db.query(`INSERT INTO zernio_profiles (profile_id, account_id, external_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [profileId, accountId, accountId]);
    return profileId;
  });
}

/** El canal usa el perfil de su cuenta (los canales anteriores conservan el que ya tenían). */
export async function withProfile(channel: Channel): Promise<Channel> {
  if (channel.config.profile_id) return channel;
  return save(channel, { profile_id: await accountProfile(channel.account_id, channel) });
}

/**
 * Un perfil que ya no existe en Zernio (se borró allá o la llave es de otra cuenta de Zernio): el negocio queda sin
 * perfil y sus redes, desconectadas y por reconectar (se le avisa como a cualquier desconexión).
 */
export async function forgetProfile(accountId: string, profileId: string, reason: string) {
  await query(`UPDATE accounts SET zernio_profile_id = '' WHERE id = $1 AND zernio_profile_id = $2`, [accountId, profileId]);
  await query(`DELETE FROM zernio_profiles WHERE profile_id = $1`, [profileId]);
  await query(`UPDATE social_accounts SET status = 'stale', updated_at = now() WHERE account_id = $1 AND profile_id = $2`, [accountId, profileId]);
  const channels = await query<{ id: string }>(`SELECT id FROM channels WHERE account_id = $1 AND type = 'zernio' AND config->>'profile_id' = $2`, [accountId, profileId]);
  for (const { id } of channels) {
    const ch = await store.getChannel(id);
    if (!ch) continue;
    await save(ch, { profile_id: '', account_id: '', username: '', display_name: '', picture: '', telegram_code: '', connect_state: '' });
    await recordConnectionState(ch, 'close', reason);
  }
}

/** "Probar y reparar": revisa en Zernio que sigan existiendo los perfiles de los negocios (en segundo plano). */
export async function verifyProfiles(limit = 500): Promise<number> {
  if (!zernioEnabled()) return 0;
  const rows = await query<{ id: string; zernio_profile_id: string }>(`SELECT id, zernio_profile_id FROM accounts WHERE zernio_profile_id <> '' ORDER BY created_at LIMIT $1`, [limit]);
  void (async () => {
    const client = clientFor(null, 'background');
    for (const r of rows) {
      try {
        if (!(await profileExists(client, r.zernio_profile_id))) {
          await forgetProfile(r.id, r.zernio_profile_id, 'zernio_profile_missing');
          await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: el perfil del negocio ya no existe en Zernio; sus redes deben volver a conectarse', accountId: r.id });
        }
      } catch (e: any) {
        await logEvent({ level: 'warn', source: 'channel', message: `Zernio: no se pudo revisar el perfil del negocio (${e?.message ?? e})`, accountId: r.id }).catch(() => undefined);
      }
    }
  })();
  return rows.length;
}

/**
 * La llave nueva es de otra cuenta de Zernio: los perfiles y cuentas de antes no existen allá. Devuelve cuántos negocios
 * tienen redes (para pedir confirmación) y, con `apply`, los deja sin perfil y con sus redes por reconectar.
 */
export async function workspaceChange(newKey: string, apply: boolean): Promise<{ changed: boolean; affected: number; workspace: string }> {
  const workspace = await zernioWorkspace(new ZernioClient(newKey)).catch(() => '');
  const prev = (await queryOne<{ value: { id?: string } }>(`SELECT value FROM system_state WHERE key = 'zernio_workspace'`))?.value?.id ?? '';
  const changed = !!workspace && !!prev && workspace !== prev;
  const affected = changed ? (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE zernio_profile_id <> ''`))?.n ?? 0 : 0;
  if (apply) {
    if (changed) {
      const rows = await query<{ id: string; zernio_profile_id: string }>(`SELECT id, zernio_profile_id FROM accounts WHERE zernio_profile_id <> ''`);
      for (const r of rows) await forgetProfile(r.id, r.zernio_profile_id, 'zernio_workspace_changed');
      await query(`UPDATE social_accounts SET status = 'stale', updated_at = now()`);
    }
    if (workspace) await query(`INSERT INTO system_state (key, value, updated_at) VALUES ('zernio_workspace', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [{ id: workspace }]);
  }
  return { changed, affected, workspace };
}

/**
 * Al borrar un negocio: sus cuentas y su perfil se quitan de Zernio (para no seguir pagando por ellas). Se hace en un
 * trabajo aparte, sin cuenta (la cuenta ya no existe), con reintentos.
 */
export async function zernioCleanup(p: { accounts?: string[]; profiles?: string[]; posts?: string[] }) {
  if (!zernioEnabled()) return;
  const client = clientFor(null, 'background');
  const gone = (e: unknown) => e instanceof ZernioError && e.status === 404;
  // Lo programado de un negocio borrado no debe salir.
  for (const id of p.posts ?? []) await client.call('DELETE', `/posts/${encodeURIComponent(id)}`).catch((e) => { if (!gone(e) && !(e instanceof ZernioError && e.status === 400)) throw e; });
  for (const id of p.accounts ?? []) await disconnectAccount(client, id).catch((e) => { if (!gone(e)) throw e; });
  for (const id of p.profiles ?? []) await deleteProfile(client, id).catch((e) => { if (!gone(e)) throw e; });
}

/** Lo que hay en Zernio de un negocio (antes de borrarlo). */
export async function zernioFootprint(accountId: string): Promise<{ accounts: string[]; profiles: string[]; posts: string[] }> {
  const accounts = await query<{ id: string }>(
    `SELECT zernio_account_id AS id FROM social_accounts WHERE account_id = $1
     UNION SELECT config->>'account_id' FROM channels WHERE account_id = $1 AND type = 'zernio' AND coalesce(config->>'account_id', '') <> ''`, [accountId]);
  const profiles = await query<{ id: string }>(
    `SELECT profile_id AS id FROM zernio_profiles WHERE account_id = $1 UNION SELECT zernio_profile_id FROM accounts WHERE id = $1 AND zernio_profile_id <> ''`, [accountId]);
  const posts = await query<{ id: string }>(
    `SELECT zernio_post_id AS id FROM social_publications WHERE account_id = $1 AND zernio_post_id IS NOT NULL AND status IN ('enviando', 'programada', 'publicando')`, [accountId]);
  return { accounts: accounts.map((r) => r.id), profiles: profiles.map((r) => r.id), posts: posts.map((r) => r.id) };
}

/**
 * Canales de antes con su propia llave de Zernio guardada en texto: se cifran (o se quitan si es la misma de la
 * plataforma). Se corre al arrancar; es idempotente.
 */
export async function migrateLegacyZernioKeys(): Promise<number> {
  const rows = await query<{ id: string; key: string; account_id: string }>(
    `SELECT id, config->>'api_key' AS key, account_id FROM channels WHERE type = 'zernio' AND coalesce(config->>'api_key', '') <> '' AND config->>'api_key' NOT LIKE 'v1.%'`).catch(() => []);
  const platform = String(process.env.ZERNIO_API_KEY || '');
  for (const r of rows) {
    const value = platform && r.key === platform ? '' : encryptSecret(r.key);
    await query(`UPDATE channels SET config = jsonb_set(config, '{api_key}', to_jsonb($2::text)) WHERE id = $1`, [r.id, value]);
    if (value) await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: este canal usa una llave propia (de antes); conviene volver a conectarlo con la llave de la plataforma', accountId: r.account_id, channelId: r.id });
  }
  return rows.length;
}

/**
 * Estado de la llave de la plataforma para Sistema. Con `repair`, además registra (o corrige) el webhook único y crea los
 * perfiles que falten. Nunca devuelve la llave: solo sus últimos 4 caracteres.
 */
export async function zernioSystemStatus(repair = false) {
  const source = zernioKeySource();
  const key = zernioKey();
  const counts = await queryOne<{ total: number; with_profile: number; channels: number }>(`SELECT
      (SELECT count(*)::int FROM accounts) AS total,
      (SELECT count(*)::int FROM accounts WHERE zernio_profile_id <> '') AS with_profile,
      (SELECT count(*)::int FROM channels WHERE type = 'zernio' AND coalesce(config->>'account_id','') <> '') AS channels`);
  const out = {
    enabled: source !== 'none',
    source,
    hint: key ? key.slice(-4) : '',
    updated_at: source === 'panel' ? (await platformSecretInfo(ZERNIO_SECRET)).updated_at : null,
    webhook_url: platformWebhookUrl(),
    webhook: null as null | { ok: boolean; error?: string },
    accounts_total: counts?.total ?? 0,
    accounts_with_profile: counts?.with_profile ?? 0,
    connected_channels: counts?.channels ?? 0,
    checking_profiles: 0,
  };
  if (repair && key) {
    try {
      // Se vuelve a enviar todo (también el secreto): repara un webhook apagado, sin eventos o con otro secreto.
      await ensurePlatformWebhook(new ZernioClient(key), { force: true });
      out.webhook = { ok: true };
    } catch (e: any) {
      out.webhook = { ok: false, error: e?.message ?? String(e) };
    }
    out.checking_profiles = await verifyProfiles();
  }
  return out;
}

/** Comprueba la llave con Zernio antes de guardarla (una llave equivocada no apaga las redes que ya funcionan). */
export async function verifyZernioKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await new ZernioClient(key).call('GET', '/profiles?limit=1');
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return { ok: false, error: /→ 40[13]/.test(msg) ? 'Zernio rechazó la llave. Cópiala de nuevo desde zernio.com → API Keys.' : `No se pudo comprobar la llave con Zernio: ${msg}` };
  }
}

/** El webhook de la plataforma se revisa en cada conexión; si falla, se registra sin detener la conexión. */
async function webhookReady(channel: Channel) {
  await ensurePlatformWebhook(clientFor(channel)).catch((e) =>
    logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo registrar el webhook de la plataforma: ${e?.message ?? e}`, accountId: channel.account_id, channelId: channel.id }));
}

/**
 * Una cuenta nueva para el negocio respeta el límite de redes de su plan (la que ya tiene, al reconectarse, no cuenta).
 * Si no cabe, se quita de Zernio para no pagar por ella, y falla con el aviso del plan.
 */
export async function assertSocialRoom(accountId: string, zernioAccountId: string) {
  const known = await queryOne(`SELECT 1 FROM social_accounts WHERE zernio_account_id = $1 AND account_id = $2 AND status <> 'disconnected'`, [zernioAccountId, accountId]);
  if (known) return;
  try {
    await assertWithinLimit(accountId, 'social_accounts');
  } catch (e) {
    await disconnectAccount(clientFor(), zernioAccountId).catch(() => undefined);
    await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: la red no se conectó porque el plan no permite más redes sociales; se quitó de Zernio', accountId });
    throw e;
  }
}

/** Zernio no quitó la cuenta: no se marca como desconectada. */
export class ZernioDisconnectError extends Error {
  constructor(cause: unknown) {
    super(`No se pudo desconectar en Zernio; inténtalo de nuevo en unos minutos (${(cause as any)?.message ?? cause})`);
  }
}

/** La cuenta conectada no es de este negocio, o ya la usa otro canal: no se guarda. */
export class ZernioOwnershipError extends Error {
  constructor(public code: 'not_yours' | 'in_use', message: string) {
    super(message);
  }
}

/**
 * Guarda la cuenta recién conectada (con su usuario, nombre y foto) y deja el canal en línea. Solo si Zernio confirma que
 * la cuenta está en el perfil de ESTE negocio (leído de la base, nunca de la URL) y es de la red del canal: así nadie
 * puede quedarse con la cuenta de otro negocio, aunque arme el enlace de retorno a mano.
 */
export async function saveZernioAccount(channel: Channel, acc: Partial<ZernioAccount> & { id: string }): Promise<Channel> {
  const own = await withProfile(channel);
  const info = await accountInfo(clientFor(own), own.config.profile_id, acc.id);
  if (!info || (info.platform && own.config.platform && info.platform !== own.config.platform)) {
    await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: la cuenta devuelta no pertenece al perfil de este negocio; no se conectó', accountId: channel.account_id, channelId: channel.id, details: { account: acc.id } });
    throw new ZernioOwnershipError('not_yours', 'Esa cuenta no pertenece a este negocio. Vuelve a pulsar "Conectar" e inicia sesión con la cuenta correcta.');
  }
  await assertSocialRoom(own.account_id, acc.id);
  const username = info.username || acc.username || '';
  let updated: Channel;
  try {
    updated = await save(own, {
      account_id: acc.id, username, display_name: info.displayName || acc.displayName || '', picture: info.picture || acc.picture || '',
      connect_state: '', telegram_code: '',
    });
  } catch (e: any) {
    // Índice único: una cuenta de Zernio solo puede estar en un canal.
    if (e?.code === '23505') throw new ZernioOwnershipError('in_use', 'Esta cuenta ya está conectada en otra conexión. Desconéctala ahí primero.');
    throw e;
  }
  // La cuenta queda registrada como del negocio (y enlazada a esta conexión de mensajes).
  await query(`UPDATE social_accounts SET channel_id = NULL WHERE channel_id = $1 AND zernio_account_id <> $2`, [own.id, acc.id]);
  const owned = await query(
    `INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name, picture, status, channel_id, chatbot_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
     ON CONFLICT (zernio_account_id) DO UPDATE SET profile_id = $3, platform = $4, username = $5, display_name = $6, picture = $7, status = 'active',
       channel_id = $8, chatbot_id = $9, updated_at = now()
     WHERE social_accounts.account_id = $1 RETURNING id`,
    [own.account_id, acc.id, own.config.profile_id, info.platform || own.config.platform, username, info.displayName || '', info.picture || '', own.id, own.chatbot_id]);
  if (!owned.length) await logEvent({ level: 'error', source: 'channel', message: 'Zernio: la cuenta conectada figura como de otro negocio; revisa en Sistema → Zernio', accountId: own.account_id, channelId: own.id });
  await recordConnectionState(updated, 'open');
  await logEvent({ level: 'info', source: 'channel', message: `Zernio: ${networkOf(channel.config.platform)?.label ?? 'cuenta'} conectada${username ? ` (@${username})` : ''}`, accountId: channel.account_id, channelId: channel.id });
  await webhookReady(updated);
  return updated;
}

export type ConnectResult =
  | { kind: 'oauth'; authUrl: string }
  | { kind: 'code'; code: string; botUsername: string; expiresAt: string; instructions: string[] }
  | { kind: 'connected'; channel: Channel };

/**
 * Inicia la conexión según la red: OAuth (Instagram, Facebook, WhatsApp, X, Reddit) devuelve la página de autorización;
 * Telegram, un código para el bot; Bluesky se conecta en el momento con usuario y contraseña de aplicación.
 */
export async function startConnect(channel: Channel, redirectFor: (state: string) => string, state: string, input: { identifier?: string; app_password?: string }): Promise<ConnectResult> {
  const network = networkOf(channel.config.platform);
  if (!network) throw new Error('Elige una red válida para este canal');
  const ch = await withProfile(channel);
  if (network.flow === 'oauth') {
    const saved = await save(ch, { connect_state: state });
    return { kind: 'oauth', authUrl: await zernioAuthUrl(saved, redirectFor(state)) };
  }
  if (network.flow === 'code') {
    const t = await telegramCode(ch);
    await save(ch, { telegram_code: t.code });
    return { kind: 'code', ...t };
  }
  const identifier = String(input.identifier ?? '').trim();
  const password = String(input.app_password ?? '').trim();
  if (!identifier || !password) throw new Error('Escribe tu usuario de Bluesky y una contraseña de aplicación');
  const acc = await blueskyConnect(ch, identifier, password);
  return { kind: 'connected', channel: await saveZernioAccount(ch, acc) };
}

/** Telegram: ¿ya se envió el código al bot? */
export async function checkTelegram(channel: Channel): Promise<{ status: 'pending' | 'connected' | 'expired'; channel: Channel }> {
  const code = channel.config.telegram_code;
  if (!code) return { status: channel.config.account_id ? 'connected' : 'expired', channel };
  const r = await telegramCheck(channel, code);
  if (r.status === 'connected' && r.account) return { status: 'connected', channel: await saveZernioAccount(channel, r.account) };
  if (r.status === 'expired') return { status: 'expired', channel: await save(channel, { telegram_code: '' }) };
  return { status: 'pending', channel };
}

/**
 * Desconecta la cuenta en Zernio y limpia el canal (sin avisar de una desconexión: la pidió el negocio). `strict`: si
 * Zernio falla (salvo que ya no exista), no se toca nada y falla, para no decir "desconectada" de una cuenta que sigue
 * activa (y cobrándose). `skip`: quien llama ya la quitó de Zernio.
 */
export async function disconnectZernio(channel: Channel, remote: 'best_effort' | 'strict' | 'skip' = 'best_effort'): Promise<Channel> {
  if (channel.config.account_id && remote !== 'skip') {
    await disconnectAccount(clientFor(channel), channel.config.account_id).catch((e) => {
      if (e instanceof ZernioError && e.status === 404) return;
      if (remote === 'strict') throw new ZernioDisconnectError(e);
      return logEvent({ level: 'warn', source: 'channel', message: `Zernio: no se pudo desconectar la cuenta en Zernio: ${e?.message ?? e}`, accountId: channel.account_id, channelId: channel.id });
    });
  }
  await query(`UPDATE channels SET connection_state = 'close', connection_state_at = now() WHERE id = $1`, [channel.id]);
  if (channel.config.account_id) await query(`DELETE FROM social_accounts WHERE zernio_account_id = $1 AND account_id = $2`, [channel.config.account_id, channel.account_id]);
  return save(channel, { account_id: '', username: '', display_name: '', picture: '', telegram_code: '', connect_state: '' });
}
