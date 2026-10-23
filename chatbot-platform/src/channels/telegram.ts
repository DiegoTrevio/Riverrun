import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { toPlainText } from '../engine/text.js';
import { imageAbsolutePath, sleep, type OutgoingButton, type OutgoingFile, type Transport } from '../engine/transport.js';
import { safeEqual } from '../secret.js';
import { ChannelConfigSchemas, type Channel, type ImageAsset } from '../types.js';
import type { ChannelAdapter, InboundMessage } from './types.js';

/** Cliente mínimo de la Bot API de Telegram. https://core.telegram.org/bots/api */
export class TelegramClient {
  constructor(private token: string, private base = config.telegramApiUrl) {}

  async call<T = any>(method: string, body?: Record<string, unknown> | FormData): Promise<T> {
    if (!this.token) throw new Error('Falta el token del bot de Telegram');
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? body : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Telegram ${method} → ${res.status}: ${data.description ?? 'error'}`);
    return data.result as T;
  }

  async download(filePath: string): Promise<Buffer> {
    const res = await fetch(`${this.base}/file/bot${this.token}/${filePath}`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Telegram: no se pudo descargar el archivo (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Bots que ya reciben los toques de botones (en este proceso). */
const callbacksReady = new Set<string>();
/** Lo que el bot recibe de Telegram: mensajes y toques de botones. */
const UPDATES = ['message', 'callback_query'];

class TelegramTransport implements Transport {
  private dispatchGuard?:()=>Promise<void>;
  setDispatchGuard(guard:()=>Promise<void>){this.dispatchGuard=guard;}
  kind = 'telegram' as const;
  private client: TelegramClient;

  constructor(private channel: Channel, private chatId: string) {
    this.client = new TelegramClient(channel.config.bot_token);
  }

  /**
   * Los bots conectados antes de los botones solo recibían mensajes: antes del primer botón se les pide también los
   * toques (con la misma dirección y secreto). Si falla, el botón igual sale y el cliente puede escribir la opción.
   */
  private async ensureCallbacks() {
    if (callbacksReady.has(this.channel.id)) return;
    try {
      const info = await this.client.call('getWebhookInfo');
      const allowed: string[] | undefined = info.allowed_updates;
      if (info.url && Array.isArray(allowed) && !allowed.includes('callback_query')) {
        await this.client.call('setWebhook', { url: info.url, secret_token: this.channel.config.secret, allowed_updates: [...new Set([...allowed, ...UPDATES])], drop_pending_updates: false });
      }
      callbacksReady.add(this.channel.id);
    } catch { /* se intenta otra vez con el siguiente botón */ }
  }

  private async typing(delayMs: number) {
    if (delayMs <= 0) return;
    await this.client.call('sendChatAction', { chat_id: this.chatId, action: 'typing' }).catch(() => undefined);
    await sleep(Math.min(delayMs, 4000));
  }

  async startTyping() { await this.client.call('sendChatAction',{chat_id:this.chatId,action:'typing'}); }

  async sendText(text: string, delayMs: number) {
    await this.typing(delayMs);
    await this.dispatchGuard?.();
    const r = await this.client.call('sendMessage', { chat_id: this.chatId, text: toPlainText(text) });
    return String(r.message_id);
  }

  async sendImage(image: ImageAsset, caption: string, delayMs: number) {
    await this.typing(Math.min(delayMs, 1500));
    const form = new FormData();
    form.append('chat_id', this.chatId);
    if (caption) form.append('caption', toPlainText(caption));
    const buf = await fs.readFile(imageAbsolutePath(image));
    form.append('photo', new Blob([new Uint8Array(buf)], { type: image.mime_type }), `${image.code}.${image.mime_type.split('/')[1] ?? 'jpg'}`);
    await this.dispatchGuard?.();
    const r = await this.client.call('sendPhoto', form);
    return String(r.message_id);
  }

  /** Video, documento o audio: cada tipo con su método de Telegram (se reproduce o descarga dentro del chat). */
  async sendFile(file: OutgoingFile, caption: string, delayMs: number) {
    await this.typing(Math.min(delayMs, 1500));
    // sendAudio solo acepta MP3/M4A y sendVoice solo OGG/Opus: otro audio va como documento.
    const audio = /^audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac)$/.test(file.mime) ? ['sendAudio', 'audio'] : /^audio\/ogg/.test(file.mime) ? ['sendVoice', 'voice'] : ['sendDocument', 'document'];
    const [method, field] = file.kind === 'video' ? ['sendVideo', 'video'] : file.kind === 'audio' ? audio : file.kind === 'image' ? ['sendPhoto', 'photo'] : ['sendDocument', 'document'];
    const text = caption ? toPlainText(caption) : '';
    // Telegram rechaza pies de más de 1024 caracteres: un texto largo sale como mensaje aparte, después del archivo.
    const inline = text.length <= 1024;
    const form = new FormData();
    form.append('chat_id', this.chatId);
    if (text && inline) form.append('caption', text);
    const buf = await fs.readFile(file.absPath);
    form.append(field, new Blob([new Uint8Array(buf)], { type: file.mime }), file.name);
    await this.dispatchGuard?.();
    const r = await this.client.call(method, form);
    if (text && !inline) await this.sendText(caption, 0);
    return String(r.message_id);
  }

  /** Botones debajo del mensaje (uno por renglón): los de respuesta regresan su identificador al tocarlos. */
  async sendButtons(text: string, buttons: OutgoingButton[], delayMs: number) {
    await this.ensureCallbacks();
    await this.typing(delayMs);
    await this.dispatchGuard?.();
    const r = await this.client.call('sendMessage', {
      chat_id: this.chatId,
      text: toPlainText(text) || '👇',
      reply_markup: { inline_keyboard: buttons.map((b) => [b.kind === 'url' ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.payload }]) },
    });
    return String(r.message_id);
  }

  async notify() {
    throw new Error('Telegram no envía avisos internos');
  }
}

/** Toque de un botón: llega como el texto del botón, con su identificador. */
function parseCallback(q: any): InboundMessage | null {
  const m = q?.message;
  if (!m?.chat || m.chat.type !== 'private' || typeof q.data !== 'string') return null;
  const from = q.from ?? {};
  const keyboard: any[] = (m.reply_markup?.inline_keyboard ?? []).flat();
  const label = keyboard.find((b) => b?.callback_data === q.data)?.text;
  return {
    messageId: `cb-${q.id}`,
    externalId: String(m.chat.id),
    phone: '',
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '',
    fromMe: false,
    type: 'text',
    text: typeof label === 'string' && label ? label : q.data,
    payload: q.data,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function parseMessage(m: any): InboundMessage | null {
  if (!m?.chat || m.chat.type !== 'private') return null; // solo chats privados
  const from = m.from ?? {};
  const base = {
    messageId: String(m.message_id),
    externalId: String(m.chat.id),
    phone: '',
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '',
    fromMe: false,
    timestamp: Number(m.date ?? Math.floor(Date.now() / 1000)),
  };
  if (typeof m.text === 'string') {
    // /start es el primer mensaje al abrir el bot
    const text = m.text.trim() === '/start' ? '[El cliente inició la conversación]' : m.text;
    return { ...base, type: 'text', text };
  }
  if (m.photo) {
    // Telegram manda la foto en varios tamaños: se usa el más grande.
    const p = Array.isArray(m.photo) ? m.photo.at(-1) : null;
    return { ...base, type: 'image', text: m.caption ?? '', ...(p?.file_id ? { media: { id: p.file_id, mimeType: 'image/jpeg', size: Number(p.file_size) || undefined } } : {}) };
  }
  if (m.voice || m.audio) {
    const a = m.voice ?? m.audio;
    return { ...base, type: 'audio', text: '', media: { id: a.file_id, mimeType: a.mime_type ?? 'audio/ogg', seconds: Number(a.duration) || undefined } };
  }
  if (m.video || m.video_note) {
    const v = m.video ?? m.video_note;
    return { ...base, type: 'video', text: m.caption ?? '', media: { id: v.file_id, mimeType: v.mime_type ?? 'video/mp4', filename: v.file_name, size: Number(v.file_size) || undefined } };
  }
  if (m.document) {
    const d = m.document;
    return { ...base, type: 'document', text: m.caption ?? d.file_name ?? '', media: { id: d.file_id, mimeType: d.mime_type ?? 'application/octet-stream', filename: d.file_name, size: Number(d.file_size) || undefined } };
  }
  if (m.sticker) return { ...base, type: 'sticker', text: '' };
  if (m.location) return { ...base, type: 'location', text: `${m.location.latitude},${m.location.longitude}` };
  if (m.contact) return { ...base, type: 'contact', text: [m.contact.first_name, m.contact.phone_number].filter(Boolean).join(' ') };
  return { ...base, type: 'other', text: '' };
}

export const telegramAdapter: ChannelAdapter = {
  type: 'telegram',
  label: 'Telegram',
  configSchema: ChannelConfigSchemas.telegram,

  initialConfig: () => ({ secret: crypto.randomBytes(24).toString('hex') }),

  verifyRequest({ channel, headers }) {
    const got = String(headers['x-telegram-bot-api-secret-token'] ?? '');
    return !!channel.config.secret && safeEqual(got, channel.config.secret);
  },

  parse({ body }) {
    const m = body?.callback_query ? parseCallback(body.callback_query) : parseMessage(body?.message);
    return { messages: m ? [m] : [] };
  },

  /** Telegram muestra un reloj en el botón hasta que se confirma el toque. */
  async acknowledge({ channel, body }) {
    const id = body?.callback_query?.id;
    if (id) await new TelegramClient(channel.config.bot_token).call('answerCallbackQuery', { callback_query_id: String(id) }).catch(() => undefined);
  },

  transport: (channel, contact) => new TelegramTransport(channel, contact.external_id),

  async downloadAudio(channel, msg) {
    if (!msg.media?.id) return null;
    const client = new TelegramClient(channel.config.bot_token);
    const file = await client.call('getFile', { file_id: msg.media.id });
    return { buffer: await client.download(file.file_path), mimeType: msg.media.mimeType ?? 'audio/ogg' };
  },

  /** Foto, documento o video del cliente: Telegram entrega el archivo por su identificador (hasta 20 MB). */
  async downloadMedia(channel, msg) {
    if (!msg.media?.id) return null;
    const client = new TelegramClient(channel.config.bot_token);
    const file = await client.call('getFile', { file_id: msg.media.id });
    return { buffer: await client.download(file.file_path), mimeType: msg.media.mimeType ?? 'application/octet-stream', fileName: msg.media.filename ?? String(file.file_path ?? '').split('/').pop() };
  },

  async setup(channel, webhookUrl) {
    const client = new TelegramClient(channel.config.bot_token);
    const me = await client.call('getMe');
    if (!webhookUrl.startsWith('https://')) {
      return { ok: false, message: 'Telegram exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)', config: { bot_username: me.username } };
    }
    await client.call('setWebhook', { url: webhookUrl, secret_token: channel.config.secret, allowed_updates: UPDATES, drop_pending_updates: false });
    callbacksReady.add(channel.id);
    return { ok: true, message: `Bot @${me.username} conectado`, config: { bot_username: me.username } };
  },

  async status(channel) {
    if (!channel.config.bot_token) return { state: 'not_configured' };
    const info = await new TelegramClient(channel.config.bot_token).call('getWebhookInfo');
    return {
      state: info.url ? (info.last_error_message ? 'error' : 'open') : 'close',
      details: { url: info.url, pending: info.pending_update_count, last_error: info.last_error_message ?? null },
    };
  },
};
