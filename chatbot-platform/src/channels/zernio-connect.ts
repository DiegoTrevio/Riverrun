import { query, queryOne, withTransaction } from '../db.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { mergeChannelConfig } from './index.js';
import { platformSecretInfo } from '../platform-secrets.js';
import {
  accountInfo, blueskyConnect, clientFor, platformWebhookUrl, ZERNIO_SECRET, ZernioClient, zernioEnabled, zernioKey, zernioKeySource, disconnectAccount, ensurePlatformWebhook, networkOf, profileFor, telegramCheck, telegramCode,
  zernioAuthUrl, type ZernioAccount,
} from './zernio.js';

/** Conexión de redes por Zernio desde el panel: el negocio elige la red y autoriza; el servidor hace lo demás. */

const save = async (channel: Channel, values: Record<string, unknown>) =>
  (await store.updateChannel(channel.id, { config: mergeChannelConfig('zernio', channel.config, values) }))!;

/**
 * Perfil de Zernio del negocio: uno por cuenta, guardado en la cuenta. Se crea al dar de alta la cuenta (o la primera vez
 * que se necesita); un candado por cuenta evita crear dos si coinciden el alta y la primera conexión.
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
    return profileId;
  });
}

/** El canal usa el perfil de su cuenta (los canales anteriores conservan el que ya tenían). */
export async function withProfile(channel: Channel): Promise<Channel> {
  if (channel.config.profile_id) return channel;
  return save(channel, { profile_id: await accountProfile(channel.account_id, channel) });
}

/** Cuentas que todavía no tienen perfil (creadas antes de activar Zernio): se crean de una en una, en segundo plano. */
export async function prepareMissingProfiles(limit = 500): Promise<number> {
  if (!zernioEnabled()) return 0;
  const rows = await query<{ id: string }>(`SELECT id FROM accounts WHERE zernio_profile_id = '' ORDER BY created_at LIMIT $1`, [limit]);
  void (async () => {
    for (const r of rows) {
      await accountProfile(r.id).catch((e) =>
        logEvent({ level: 'warn', source: 'channel', message: `Zernio: el perfil se creará al conectar la primera red (${e?.message ?? e})`, accountId: r.id }).catch(() => undefined));
    }
  })();
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
    creating_profiles: 0,
  };
  if (repair && key) {
    try {
      await ensurePlatformWebhook(new ZernioClient(key));
      out.webhook = { ok: true };
    } catch (e: any) {
      out.webhook = { ok: false, error: e?.message ?? String(e) };
    }
    out.creating_profiles = await prepareMissingProfiles();
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

/** Al crear una cuenta: su perfil de Zernio queda listo (si las redes sociales están activadas). No detiene el alta. */
export function prepareAccountProfile(accountId: string) {
  if (!zernioEnabled()) return;
  void accountProfile(accountId).catch((e) =>
    logEvent({ level: 'warn', source: 'channel', message: `Zernio: el perfil se creará al conectar la primera red (${e?.message ?? e})`, accountId }).catch(() => undefined));
}

/** El webhook de la plataforma se revisa en cada conexión; si falla, se registra sin detener la conexión. */
async function webhookReady(channel: Channel) {
  await ensurePlatformWebhook(clientFor(channel)).catch((e) =>
    logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo registrar el webhook de la plataforma: ${e?.message ?? e}`, accountId: channel.account_id, channelId: channel.id }));
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

/** Desconecta la cuenta en Zernio y limpia el canal (sin avisar de una desconexión: la pidió el negocio). */
export async function disconnectZernio(channel: Channel): Promise<Channel> {
  if (channel.config.account_id) {
    await disconnectAccount(clientFor(channel), channel.config.account_id).catch((e) =>
      logEvent({ level: 'warn', source: 'channel', message: `Zernio: no se pudo desconectar la cuenta en Zernio: ${e?.message ?? e}`, accountId: channel.account_id, channelId: channel.id }));
  }
  await query(`UPDATE channels SET connection_state = 'close', connection_state_at = now() WHERE id = $1`, [channel.id]);
  return save(channel, { account_id: '', username: '', display_name: '', picture: '', telegram_code: '', connect_state: '' });
}
