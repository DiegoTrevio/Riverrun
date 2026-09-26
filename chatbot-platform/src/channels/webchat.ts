import crypto from 'node:crypto';
import type { Transport } from '../engine/transport.js';
import { ChannelConfigSchemas } from '../types.js';
import type { ChannelAdapter } from './types.js';

/**
 * Chat web: el widget (public/widget.js) envía mensajes a /webchat/:token y consulta las
 * respuestas. Los mensajes salientes ya quedan guardados por el motor; aquí no hay nada que enviar.
 */
class WebchatTransport implements Transport {
  kind = 'webchat' as const;

  async sendText() {
    return `web-${crypto.randomUUID()}`;
  }

  async sendImage() {
    return `web-${crypto.randomUUID()}`;
  }

  async notify() {
    throw new Error('El chat web no envía avisos internos');
  }
}

export const webchatAdapter: ChannelAdapter = {
  type: 'webchat',
  label: 'Chat web',
  configSchema: ChannelConfigSchemas.webchat,
  parse: () => ({ messages: [] }),
  transport: () => new WebchatTransport(),
  async status(channel) {
    return { state: channel.active ? 'open' : 'close' };
  },
};

export const WEBCHAT_SESSION_RE = /^[a-f0-9]{32}$/;
export const newWebchatSession = () => crypto.randomBytes(16).toString('hex');
