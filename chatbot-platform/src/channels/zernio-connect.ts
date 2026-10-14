import { query } from '../db.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { mergeChannelConfig } from './index.js';
import {
  accountInfo, blueskyConnect, clientFor, disconnectAccount, ensurePlatformWebhook, networkOf, profileFor, telegramCheck, telegramCode,
  zernioAuthUrl, type ZernioAccount,
} from './zernio.js';

/** Conexión de redes por Zernio desde el panel: el negocio elige la red y autoriza; el servidor hace lo demás. */

const save = async (channel: Channel, values: Record<string, unknown>) =>
  (await store.updateChannel(channel.id, { config: mergeChannelConfig('zernio', channel.config, values) }))!;

/** Perfil de Zernio del negocio: se crea la primera vez y se guarda en el canal. */
export async function withProfile(channel: Channel): Promise<Channel> {
  if (channel.config.profile_id) return channel;
  const account = await store.getAccount(channel.account_id);
  const profileId = await profileFor(clientFor(channel), { id: channel.account_id, name: account?.name ?? channel.name });
  return save(channel, { profile_id: profileId });
}

/** El webhook de la plataforma se revisa en cada conexión; si falla, se registra sin detener la conexión. */
async function webhookReady(channel: Channel) {
  await ensurePlatformWebhook(clientFor(channel)).catch((e) =>
    logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo registrar el webhook de la plataforma: ${e?.message ?? e}`, accountId: channel.account_id, channelId: channel.id }));
}

/** Guarda la cuenta recién conectada (con su usuario, nombre y foto) y deja el canal en línea. */
export async function saveZernioAccount(channel: Channel, acc: Partial<ZernioAccount> & { id: string }): Promise<Channel> {
  const info = await accountInfo(clientFor(channel), channel.config.profile_id, acc.id).catch(() => null);
  const username = info?.username || acc.username || '';
  const updated = await save(channel, {
    account_id: acc.id, username, display_name: info?.displayName || acc.displayName || '', picture: info?.picture || acc.picture || '',
    connect_state: '', telegram_code: '',
  });
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
