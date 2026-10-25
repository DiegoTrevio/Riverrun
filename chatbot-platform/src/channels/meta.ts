import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchPublic } from '../knowledge-import.js';
import { toPlainText } from '../engine/text.js';
import { sleep, type OutgoingButton, type OutgoingFile, type Transport } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import { safeEqual } from '../secret.js';
import { ChannelConfigSchemas, type Channel, type ChannelType, type ImageAsset } from '../types.js';
import { INBOUND_MEDIA_MAX_BYTES, signedImageUrl } from './media.js';
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

/** Instagram rechaza textos de más de 1000 bytes (UTF-8): se dividen en partes por palabras. */
const INSTAGRAM_TEXT_BYTES = 1000;

export function splitByBytes(text: string, max: number): string[] {
  if (Buffer.byteLength(text) <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/(?<=\s)/)) {
    if (Buffer.byteLength(cur + word) <= max) {
      cur += word;
      continue;
    }
    if (cur.trim()) out.push(cur.trim());
    cur = '';
    // Una "palabra" más larga que el límite se corta por caracteres.
    let rest = word;
    while (Buffer.byteLength(rest) > max) {
      let n = rest.length;
      while (Buffer.byteLength(rest.slice(0, n)) > max) n--;
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    cur = rest;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const graphFor = (channel: Channel) => new GraphClient(channel.config.page_access_token, channel.config.graph_version || 'v21.0');

class MetaTransport implements Transport {
  private dispatchGuard?:()=>Promise<void>;
  setDispatchGuard(guard:()=>Promise<void>){this.dispatchGuard=guard;}
  private graph: GraphClient;

  constructor(public kind: ChannelType, private channel: Channel, private recipientId: string) {
    this.graph = graphFor(channel);
  }

  private async typing(delayMs: number) {
    if (delayMs <= 0) return;
    await this.graph.call('POST', 'me/messages', { recipient: { id: this.recipientId }, sender_action: 'typing_on' }).catch(() => undefined);
    await sleep(Math.min(delayMs, 4000));
  }

  async startTyping() { await this.graph.call('POST','me/messages',{recipient:{id:this.recipientId},sender_action:'typing_on'}); }

  async sendText(text: string, delayMs: number) {
    await this.typing(delayMs);
    const plain = toPlainText(text);
    const parts = this.kind === 'instagram' ? splitByBytes(plain, INSTAGRAM_TEXT_BYTES) : [plain];
    let first: string | null = null;
    for (const part of parts) {
      await this.dispatchGuard?.();
      const r = await this.graph.call('POST', 'me/messages', {
        recipient: { id: this.recipientId },
        messaging_type: 'RESPONSE',
        message: { text: part },
      });
      first ??= r.message_id ?? null;
    }
    return first;
  }

  async sendImage(image: ImageAsset, caption: string, delayMs: number) {
    if (!config.publicBaseUrl.startsWith('https://')) {
      throw new Error('Para enviar imágenes por Messenger/Instagram define PUBLIC_BASE_URL con HTTPS (Meta descarga la imagen desde esa URL)');
    }
    await this.typing(Math.min(delayMs, 1500));
    await this.dispatchGuard?.();
    const r = await this.graph.call('POST', 'me/messages', {
      recipient: { id: this.recipientId },
      messaging_type: 'RESPONSE',
      message: { attachment: { type: 'image', payload: { url: signedImageUrl(image.id), is_reusable: true } } },
    });
    // Meta no admite pie de foto en imágenes: se manda como texto aparte. La foto ya llegó: si el texto falla, se registra
    // pero la foto no cuenta como fallida (si no, se reintentaría y el cliente la recibiría repetida).
    if (caption) {
      await this.sendText(caption, 0).catch((e: any) =>
        logEvent({ level: 'warn', source: 'channel', message: `Foto entregada, pero su texto no se pudo enviar (${this.kind})`, accountId: this.channel.account_id, channelId: this.channel.id }),
      );
    }
    return r.message_id ?? null;
  }

  /**
   * Video, documento o audio: Meta lo descarga desde su dirección firmada (necesita HTTPS). Sin dirección pública (un
   * archivo que no tiene enlace firmado) el canal no lo puede enviar y el motor manda el aviso o el enlace que corresponda.
   */
  async sendFile(file: OutgoingFile, caption: string, delayMs: number) {
    if (!file.url || !config.publicBaseUrl.startsWith('https://')) throw new Error('unsupported_file');
    await this.typing(Math.min(delayMs, 1500));
    await this.dispatchGuard?.();
    const type = file.kind === 'video' ? 'video' : file.kind === 'audio' ? 'audio' : file.kind === 'image' ? 'image' : 'file';
    const r = await this.graph.call('POST', 'me/messages', {
      recipient: { id: this.recipientId },
      messaging_type: 'RESPONSE',
      message: { attachment: { type, payload: { url: file.url, is_reusable: true } } },
    });
    // Como en las fotos, el texto va aparte; si falla, el archivo ya llegó y no cuenta como fallido.
    if (caption) {
      await this.sendText(caption, 0).catch(() =>
        logEvent({ level: 'warn', source: 'channel', message: `Archivo entregado, pero su texto no se pudo enviar (${this.kind})`, accountId: this.channel.account_id, channelId: this.channel.id }),
      );
    }
    return r.message_id ?? null;
  }

  /**
   * Hasta 3 botones con el texto en una sola burbuja (de máximo 640): de respuesta o de enlace. Más, o con un texto
   * largo, van como respuestas rápidas (solo de respuesta; los enlaces ya van en el texto).
   */
  async sendButtons(text: string, buttons: OutgoingButton[], delayMs: number) {
    await this.typing(delayMs);
    const plain = toPlainText(text);
    const template = buttons.length <= 3 && plain.length <= 640 && !!plain;
    // No debería pasar (buttons.ts lo evita): se trata como rechazado, no como "sin confirmar".
    if (!template && buttons.some((b) => b.kind === 'url')) throw new Error('unsupported_buttons');
    await this.dispatchGuard?.();
    const message = template
      ? { attachment: { type: 'template', payload: { template_type: 'button', text: plain, buttons: buttons.map((b) => (b.kind === 'url' ? { type: 'web_url', title: b.label, url: b.url } : { type: 'postback', title: b.label, payload: b.payload })) } } }
      : { text: plain, quick_replies: buttons.map((b) => ({ content_type: 'text', title: b.label, payload: b.payload })) };
    const r = await this.graph.call('POST', 'me/messages', { recipient: { id: this.recipientId }, messaging_type: 'RESPONSE', message });
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
    // Respuesta rápida tocada: el texto es su etiqueta y el identificador viene aparte (solo del cliente, no de un eco).
    const payload = !fromMe && typeof m.quick_reply?.payload === 'string' ? { payload: m.quick_reply.payload } : {};
    if (typeof m.text === 'string' && m.text) return { ...base, type: 'text', text: m.text, ...payload };
    const att = m.attachments?.[0];
    // Eco de un mensaje con botones (plantilla): su texto, para reconocerlo como propio.
    if (att?.type === 'template' && typeof att.payload?.text === 'string' && att.payload.text) return { ...base, type: 'text', text: att.payload.text };
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
      ...(typeof ev.postback.payload === 'string' && ev.postback.payload ? { payload: ev.postback.payload } : {}),
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
      if (!msg.media?.url?.startsWith('https://')) return null;
      // La URL viene en el webhook: se revisa cada salto para no llegar a la red interna del servidor.
      const r = await fetchPublic(msg.media.url, { maxBytes: INBOUND_MEDIA_MAX_BYTES, accept: '*/*' }).catch(() => null);
      return r ? { buffer: r.body, mimeType: r.mime || 'audio/mp4' } : null;
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
