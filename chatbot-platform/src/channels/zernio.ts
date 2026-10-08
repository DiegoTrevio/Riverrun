import crypto from 'node:crypto';
import { config } from '../config.js';
import { toPlainText } from '../engine/text.js';
import { sleep, type Transport } from '../engine/transport.js';
import { safeEqual } from '../secret.js';
import { ChannelConfigSchemas, type Channel, type ImageAsset } from '../types.js';
import { signedImageUrl } from './media.js';
import type { ChannelAdapter, InboundMessage, ParseResult, WebhookRequest } from './types.js';

/**
 * Zernio: API unificada de mensajes directos para varias redes (https://docs.zernio.com).
 * Las credenciales viven solo en el servidor; el navegador nunca recibe la API key.
 *
 * VERIFICAR antes de producción: los nombres de campos marcados con VERIFICAR se tomaron de
 * documentación resumida, no de la referencia completa. Confirmarlos con un evento real.
 */

const EVENTS = ['message.received', 'message.sent'];

/** Cliente mínimo. No reintenta: un envío que Zernio aceptó y luego falló podría duplicarse. */
export class ZernioClient {
  constructor(private apiKey: string, private base = config.zernioApiUrl) {}

  async call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw new Error('Falta la API key de Zernio');
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Zernio ${path.split('?')[0]} → ${res.status}: ${data?.error?.message ?? data?.message ?? 'error'}`);
    return data as T;
  }
}

const clientFor = (channel: Channel) => new ZernioClient(channel.config.api_key);

/** Firma de los webhooks: HMAC-SHA256 en hexadecimal del cuerpo crudo, con el secreto del suscriptor. */
export function zernioSignature(rawBody: Buffer, secret: string) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyRequest({ channel, headers, rawBody }: WebhookRequest): boolean {
  const secret = channel.config.webhook_secret;
  const got = String(headers['x-zernio-signature'] ?? '');
  if (!secret || !rawBody || !got) return false;
  return safeEqual(got, zernioSignature(rawBody, secret));
}

/**
 * VERIFICAR: forma del evento. Se espera { event, payload: { id, conversationId, message: { id, text, createdAt }, sender: { id, name } } }.
 * Un evento con otra forma no se descarta en silencio: queda un aviso con las claves recibidas.
 */
export function parseZernioEvent(body: any): ParseResult {
  const event = typeof body?.event === 'string' ? body.event : '';
  if (!EVENTS.includes(event)) {
    return { messages: [], notices: [{ level: 'info', message: `Zernio: evento ignorado (${event || 'sin nombre'})` }] };
  }
  const p = body?.payload ?? {};
  const m = p.message ?? {};
  const conversationId = p.conversationId != null ? String(p.conversationId) : '';
  const messageId = m.id != null ? String(m.id) : '';
  if (!conversationId || !messageId) {
    return { messages: [], notices: [{ level: 'warn', message: `Zernio: evento ${event} con forma no reconocida (claves: ${Object.keys(p).join(', ') || 'ninguna'})` }] };
  }
  const fromMe = event === 'message.sent';
  const text = typeof m.text === 'string' ? m.text : '';
  const created = Date.parse(typeof m.createdAt === 'string' ? m.createdAt : '');
  const msg: InboundMessage = {
    messageId,
    // La conversación de Zernio identifica al cliente y permite responder en el mismo hilo.
    externalId: conversationId,
    phone: '',
    displayName: fromMe ? '' : String(p.sender?.name ?? ''),
    fromMe,
    type: text ? 'text' : 'other',
    text,
    timestamp: Number.isNaN(created) ? Math.floor(Date.now() / 1000) : Math.floor(created / 1000),
  };
  return { messages: [msg] };
}

/** Id del mensaje enviado, para conciliar el eco que Zernio manda después. VERIFICAR nombre del campo. */
function messageRef(r: any): string | null {
  const id = r?.id ?? r?.message?.id;
  return id == null ? null : String(id);
}

class ZernioTransport implements Transport {
  kind = 'zernio' as const;
  private client: ZernioClient;
  private path: string;

  constructor(private channel: Channel, conversationId: string) {
    this.client = clientFor(channel);
    this.path = `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`;
  }

  private accountId(): string {
    if (!this.channel.config.account_id) throw new Error('La cuenta de Zernio no está conectada');
    return this.channel.config.account_id;
  }

  private async pause(ms: number) {
    if (ms > 0) await sleep(Math.min(ms, 4000));
  }

  async sendText(text: string, delayMs: number) {
    await this.pause(delayMs);
    const r = await this.client.call<any>('POST', this.path, { accountId: this.accountId(), message: toPlainText(text) });
    return messageRef(r);
  }

  async sendImage(image: ImageAsset, caption: string, delayMs: number) {
    if (!config.publicBaseUrl.startsWith('https://')) {
      throw new Error('Para enviar imágenes por Zernio define PUBLIC_BASE_URL con HTTPS (Zernio descarga la imagen desde esa URL)');
    }
    await this.pause(Math.min(delayMs, 1500));
    const r = await this.client.call<any>('POST', this.path, {
      accountId: this.accountId(),
      message: caption ? toPlainText(caption) : '',
      attachmentUrl: signedImageUrl(image.id),
    });
    return messageRef(r);
  }

  async notify() {
    throw new Error('Zernio no envía avisos internos');
  }
}

/**
 * Inicia la conexión de la cuenta social. Zernio devuelve la URL de autorización y, tras aprobarla,
 * redirige a redirectUrl con los datos de la cuenta conectada.
 */
export async function zernioAuthUrl(channel: Channel, redirectUrl: string): Promise<string> {
  const platform = channel.config.platform;
  const profileId = channel.config.profile_id;
  if (!platform || !profileId) throw new Error('Indica la red y el perfil de Zernio antes de conectar la cuenta');
  const qs = new URLSearchParams({ profileId, redirect_url: redirectUrl });
  const r = await clientFor(channel).call<{ authUrl?: string }>('GET', `/connect/${encodeURIComponent(platform)}?${qs}`);
  if (!r?.authUrl) throw new Error('Zernio no devolvió la URL de autorización');
  return r.authUrl;
}

export const zernioAdapter: ChannelAdapter = {
  type: 'zernio',
  label: 'Zernio',
  configSchema: ChannelConfigSchemas.zernio,

  initialConfig: () => ({ webhook_secret: crypto.randomBytes(24).toString('hex') }),

  verifyRequest,

  parse: ({ body }) => parseZernioEvent(body),

  transport: (channel, contact) => new ZernioTransport(channel, contact.external_id),

  async setup(channel, webhookUrl) {
    if (!webhookUrl.startsWith('https://')) {
      return { ok: false, message: 'Zernio exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)' };
    }
    if (!channel.config.webhook_secret) return { ok: false, message: 'Falta el secreto del webhook; vuelve a crear el canal' };
    // VERIFICAR: nombres de campos de POST /v1/webhooks/settings.
    await clientFor(channel).call('POST', '/webhooks/settings', { url: webhookUrl, secret: channel.config.webhook_secret, events: EVENTS });
    return { ok: true, message: 'Webhook registrado en Zernio' };
  },
};
