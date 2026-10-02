import crypto from 'node:crypto';
import { config } from '../config.js';
import { toPlainText } from '../engine/text.js';
import { sleep, type Transport } from '../engine/transport.js';
import { safeEqual } from '../secret.js';
import { ChannelConfigSchemas, type Channel, type ChannelType, type ImageAsset } from '../types.js';
import { signedImageUrl } from './media.js';
import type { ChannelAdapter, InboundMessage } from './types.js';

/**
 * Messenger e Instagram usan la misma Messenger Platform de Meta (Graph API).
 * https://developers.facebook.com/docs/messenger-platform
 */
class GraphClient {
  constructor(private token: string, private version: string) {}

  async call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new Error('Falta el token de acceso de la página');
    const url = `${config.metaGraphUrl}/${this.version}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token)}`;
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Meta ${path.split('?')[0]} → ${res.status}: ${data.error?.message ?? 'error'}`);
    return data as T;
  }
}

const graphFor = (channel: Channel) => new GraphClient(channel.config.page_access_token, channel.config.graph_version || 'v21.0');

class MetaTransport implements Transport {
  private graph: GraphClient;

  constructor(public kind: ChannelType, channel: Channel, private recipientId: string) {
    this.graph = graphFor(channel);
  }

  private async typing(delayMs: number) {
    if (delayMs <= 0) return;
    await this.graph.call('POST', 'me/messages', { recipient: { id: this.recipientId }, sender_action: 'typing_on' }).catch(() => undefined);
    await sleep(Math.min(delayMs, 4000));
  }

  async sendText(text: string, delayMs: number) {
    await this.typing(delayMs);
    const r = await this.graph.call('POST', 'me/messages', {
      recipient: { id: this.recipientId },
      messaging_type: 'RESPONSE',
      message: { text: toPlainText(text) },
    });
    return r.message_id ?? null;
  }

  async sendImage(image: ImageAsset, caption: string, delayMs: number) {
    if (!config.publicBaseUrl.startsWith('https://')) {
      throw new Error('Para enviar imágenes por Messenger/Instagram define PUBLIC_BASE_URL con HTTPS (Meta descarga la imagen desde esa URL)');
    }
    await this.typing(Math.min(delayMs, 1500));
    const r = await this.graph.call('POST', 'me/messages', {
      recipient: { id: this.recipientId },
      messaging_type: 'RESPONSE',
      message: { attachment: { type: 'image', payload: { url: signedImageUrl(image.id), is_reusable: true } } },
    });
    // Meta no admite pie de foto en imágenes: se manda como texto aparte.
    if (caption) await this.sendText(caption, 0);
    return r.message_id ?? null;
  }

  async notify() {
    throw new Error('Messenger/Instagram no envían avisos internos');
  }
}

const ATTACHMENT_TYPES: Record<string, InboundMessage['type']> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'document',
  location: 'location',
  sticker: 'sticker',
};

function parseEvent(ev: any): InboundMessage | null {
  const timestamp = Math.floor(Number(ev.timestamp ?? Date.now()) / 1000);
  if (ev.message) {
    const m = ev.message;
    if (m.is_deleted || m.is_unsupported) return null;
    const fromMe = !!m.is_echo;
    const base = {
      messageId: String(m.mid),
      // En un eco, el cliente es el destinatario.
      externalId: String(fromMe ? ev.recipient?.id : ev.sender?.id),
      phone: '',
      displayName: '',
      fromMe,
      timestamp,
    };
    if (typeof m.text === 'string' && m.text) return { ...base, type: 'text', text: m.text };
    const att = m.attachments?.[0];
    if (att) {
      const type = ATTACHMENT_TYPES[att.type] ?? 'other';
      return { ...base, type, text: '', media: att.payload?.url ? { url: att.payload.url } : undefined };
    }
    return null;
  }
  if (ev.postback) {
    return {
      messageId: String(ev.postback.mid ?? `pb-${ev.timestamp}`),
      externalId: String(ev.sender?.id),
      phone: '',
      displayName: '',
      fromMe: false,
      type: 'text',
      text: ev.postback.title || ev.postback.payload || '',
      timestamp,
    };
  }
  return null; // lecturas, entregas, reacciones, etc.
}

function metaAdapter(type: 'messenger' | 'instagram', label: string, objectName: string): ChannelAdapter {
  return {
    type,
    label,
    configSchema: ChannelConfigSchemas[type],

    initialConfig: () => ({ verify_token: crypto.randomBytes(16).toString('hex') }),

    handleVerification({ channel, query }) {
      const ok = query['hub.mode'] === 'subscribe' && !!channel.config.verify_token && query['hub.verify_token'] === channel.config.verify_token;
      return ok ? String(query['hub.challenge'] ?? '') : null;
    },

    verifyRequest({ channel, headers, rawBody }) {
      const sig = String(headers['x-hub-signature-256'] ?? '');
      if (!channel.config.app_secret || !rawBody || !sig.startsWith('sha256=')) return false;
      const expected = 'sha256=' + crypto.createHmac('sha256', channel.config.app_secret).update(rawBody).digest('hex');
      return safeEqual(sig, expected);
    },

    parse({ channel, body }) {
      if (body?.object !== objectName) return { messages: [] };
      const ownId = type === 'messenger' ? channel.config.page_id : channel.config.account_id;
      const messages: InboundMessage[] = [];
      for (const entry of body.entry ?? []) {
        if (ownId && String(entry.id) !== String(ownId)) continue; // evento de otra página/cuenta
        for (const ev of entry.messaging ?? []) {
          const m = parseEvent(ev);
          if (m) messages.push(m);
        }
      }
      return { messages };
    },

    transport: (channel, contact) => new MetaTransport(type, channel, contact.external_id),

    async downloadAudio(_channel, msg) {
      if (!msg.media?.url) return null;
      const res = await fetch(msg.media.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') ?? 'audio/mp4' };
    },

    async setup(channel) {
      const graph = graphFor(channel);
      const me = await graph.call('GET', 'me?fields=id,name');
      if (type === 'messenger') {
        const pageId = channel.config.page_id || me.id;
        await graph.call('POST', `${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes`);
        return { ok: true, message: `Página "${me.name}" suscrita a los mensajes`, config: { page_id: pageId } };
      }
      return { ok: true, message: `Token válido (${me.name ?? me.id})`, config: channel.config.account_id ? {} : { account_id: me.id } };
    },

    async status(channel) {
      if (!channel.config.page_access_token) return { state: 'not_configured' };
      const me = await graphFor(channel).call('GET', 'me?fields=id,name');
      return { state: 'open', details: { id: me.id, name: me.name } };
    },
  };
}

export const messengerAdapter = metaAdapter('messenger', 'Facebook Messenger', 'page');
export const instagramAdapter = metaAdapter('instagram', 'Instagram', 'instagram');
