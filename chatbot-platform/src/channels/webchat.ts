import crypto from 'node:crypto';
import type { OutgoingFile, Transport } from '../engine/transport.js';
import { hmac, safeEqual } from '../secret.js';
import { ChannelConfigSchemas } from '../types.js';
import type { ChannelAdapter } from './types.js';

/**
 * Chat web: el widget (public/widget.js) envía mensajes a /webchat/:token y consulta las
 * respuestas. Los mensajes salientes ya quedan guardados por el motor; aquí no hay nada que enviar.
 */
class WebchatTransport implements Transport {
  kind = 'webchat' as const;
  libraryFilesOnly = true;

  async sendText() {
    return `web-${crypto.randomUUID()}`;
  }

  async sendImage() {
    return `web-${crypto.randomUUID()}`;
  }

  /** El archivo queda en el mensaje guardado: el widget muestra el video o el enlace para descargar el documento. */
  async sendFile(file: OutgoingFile) {
    // Solo los archivos con dirección firmada (los de la biblioteca del agente) se pueden mostrar en el widget.
    if (!file.url) throw new Error('unsupported_file');
    return `web-${crypto.randomUUID()}`;
  }

  /** Los botones quedan en el mensaje guardado y el widget los muestra. */
  async sendButtons() {
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

/**
 * Sesión del widget: la entrega el servidor y va firmada para ese canal. Una inventada creaba un cliente y una respuesta
 * de IA en cada mensaje, y el límite de sesiones nuevas por conexión no servía de nada.
 */
const sessionSignature = (channelId: string, id: string) => hmac(`webchat:${channelId}:${id}`).slice(0, 22);
export const newWebchatSession = (channelId: string) => {
  const id = crypto.randomBytes(16).toString('hex');
  return `${id}.${sessionSignature(channelId, id)}`;
};
/** La sesión si la entregó el servidor para este canal; null si es inventada, alterada o de otro canal. */
export function readWebchatSession(channelId: string, session: unknown): string | null {
  const m = /^([a-f0-9]{32})\.([\w-]{22})$/.exec(String(session ?? ''));
  return m && safeEqual(m[2], sessionSignature(channelId, m[1])) ? m[0] : null;
}
