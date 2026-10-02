import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { toPlainText } from '../engine/text.js';
import { imageAbsolutePath, sleep, type Transport } from '../engine/transport.js';
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

class TelegramTransport implements Transport {
  kind = 'telegram' as const;
  private client: TelegramClient;

  constructor(channel: Channel, private chatId: string) {
    this.client = new TelegramClient(channel.config.bot_token);
  }

  private async typing(delayMs: number) {
    if (delayMs <= 0) return;
    await this.client.call('sendChatAction', { chat_id: this.chatId, action: 'typing' }).catch(() => undefined);
    await sleep(Math.min(delayMs, 4000));
  }

  async sendText(text: string, delayMs: number) {
    await this.typing(delayMs);
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
    const r = await this.client.call('sendPhoto', form);
    return String(r.message_id);
  }

  async notify() {
    throw new Error('Telegram no envía avisos internos');
  }
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
  if (m.photo) return { ...base, type: 'image', text: m.caption ?? '' };
  if (m.voice || m.audio) {
    const a = m.voice ?? m.audio;
    return { ...base, type: 'audio', text: '', media: { id: a.file_id, mimeType: a.mime_type ?? 'audio/ogg' } };
  }
  if (m.video || m.video_note) return { ...base, type: 'video', text: m.caption ?? '' };
  if (m.document) return { ...base, type: 'document', text: m.caption ?? m.document.file_name ?? '' };
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
    const m = parseMessage(body?.message);
    return { messages: m ? [m] : [] };
  },

  transport: (channel, contact) => new TelegramTransport(channel, contact.external_id),

  async downloadAudio(channel, msg) {
    if (!msg.media?.id) return null;
    const client = new TelegramClient(channel.config.bot_token);
    const file = await client.call('getFile', { file_id: msg.media.id });
    return { buffer: await client.download(file.file_path), mimeType: msg.media.mimeType ?? 'audio/ogg' };
  },

  async setup(channel, webhookUrl) {
    const client = new TelegramClient(channel.config.bot_token);
    const me = await client.call('getMe');
    if (!webhookUrl.startsWith('https://')) {
      return { ok: false, message: 'Telegram exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)', config: { bot_username: me.username } };
    }
    await client.call('setWebhook', { url: webhookUrl, secret_token: channel.config.secret, allowed_updates: ['message'], drop_pending_updates: false });
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
