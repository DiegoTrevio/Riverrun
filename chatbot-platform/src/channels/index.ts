import { config } from '../config.js';
import { PlaygroundTransport } from '../engine/transport.js';
import { ChannelConfigSchemas, MASK, SECRET_FIELDS, type Channel, type ChannelType } from '../types.js';
import { instagramAdapter, messengerAdapter } from './meta.js';
import { telegramAdapter } from './telegram.js';
import type { ChannelAdapter } from './types.js';
import { webchatAdapter } from './webchat.js';
import { whatsappAdapter } from './whatsapp.js';

const playgroundAdapter: ChannelAdapter = {
  type: 'playground',
  label: 'Simulador',
  configSchema: ChannelConfigSchemas.playground,
  parse: () => ({ messages: [] }),
  transport: () => new PlaygroundTransport(),
};

const ADAPTERS: Record<ChannelType, ChannelAdapter> = {
  whatsapp: whatsappAdapter,
  telegram: telegramAdapter,
  messenger: messengerAdapter,
  instagram: instagramAdapter,
  webchat: webchatAdapter,
  playground: playgroundAdapter,
};

export function adapterFor(type: ChannelType): ChannelAdapter {
  return ADAPTERS[type];
}

/** URL a la que la plataforma envía los eventos. Evolution va por la red interna; el resto, por la URL pública. */
export function webhookUrl(channel: Pick<Channel, 'type' | 'webhook_token'>) {
  const base = channel.type === 'whatsapp' ? config.webhookBaseUrl : config.publicBaseUrl;
  return `${base}/webhook/${channel.webhook_token}`;
}

/** Versión del canal apta para el panel: secretos enmascarados e información de conexión. */
export function publicChannel(channel: Channel) {
  const cfg: Record<string, unknown> = { ...channel.config };
  for (const k of SECRET_FIELDS) if (cfg[k]) cfg[k] = MASK;
  const { webhook_token, account_active, ...rest } = channel;
  void account_active;
  return {
    ...rest,
    config: cfg,
    label: adapterFor(channel.type).label,
    webhook_url: webhookUrl(channel),
    webhook_token,
    embed_code:
      channel.type === 'webchat'
        ? `<script src="${config.publicBaseUrl}/widget.js" data-channel="${webhook_token}" async></script>`
        : undefined,
  };
}

/** Fusiona la configuración recibida del panel con la guardada (los secretos enmascarados no se sobrescriben). */
export function mergeChannelConfig(type: ChannelType, current: Record<string, any>, incoming: Record<string, any>) {
  const next = { ...current };
  for (const [k, v] of Object.entries(incoming ?? {})) {
    if (SECRET_FIELDS.includes(k) && v === MASK) continue;
    next[k] = v;
  }
  return adapterFor(type).configSchema.parse(next);
}

export { describeInbound, type InboundMessage } from './types.js';
