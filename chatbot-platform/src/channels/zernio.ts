import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { config } from '../config.js';
import { toPlainText } from '../engine/text.js';
import { sleep, type OutgoingFile, type Transport } from '../engine/transport.js';
import { hmac, safeEqual } from '../secret.js';
import { ChannelConfigSchemas, type Channel, type ImageAsset } from '../types.js';
import { signedImageUrl } from './media.js';
import type { ChannelAdapter, InboundMessage, ParseResult, WebhookRequest } from './types.js';
import { platformSecret } from '../platform-secrets.js';

/**
 * Zernio: una sola API para los mensajes directos de varias redes (Instagram, Facebook, WhatsApp Business, Telegram, X,
 * Bluesky y Reddit). La plataforma tiene UNA llave de Zernio (ZERNIO_API_KEY, solo en el servidor); cada negocio tiene su
 * perfil en Zernio y conecta sus redes desde el panel, sin ver llaves ni identificadores.
 *
 * Referencia: SDK oficial @zernio/node y adaptador @zernio/chat-sdk-adapter (eventos planos { event, message,
 * conversation, account }, firma HMAC-SHA256 hexadecimal en X-Zernio-Signature, id del envío en data.messageId).
 */

/** Redes con mensajes directos y cómo se conectan desde el panel. */
export const NETWORKS = [
  { id: 'instagram', label: 'Instagram', flow: 'oauth', media: true, typing: true },
  { id: 'facebook', label: 'Facebook Messenger', flow: 'oauth', media: true, typing: true },
  { id: 'whatsapp', label: 'WhatsApp Business (API oficial)', flow: 'oauth', media: true, typing: true },
  { id: 'telegram', label: 'Telegram', flow: 'code', media: true, typing: true },
  { id: 'twitter', label: 'X (Twitter)', flow: 'oauth', media: true, typing: false },
  { id: 'bluesky', label: 'Bluesky', flow: 'credentials', media: false, typing: false },
  { id: 'reddit', label: 'Reddit', flow: 'oauth', media: false, typing: false },
] as const;
export type Network = (typeof NETWORKS)[number];
export const networkOf = (platform: string): Network | undefined => NETWORKS.find((n) => n.id === platform);

/** Eventos que recibe el webhook de la plataforma. */
export const EVENTS = ['message.received', 'message.sent', 'message.failed', 'account.connected', 'account.disconnected'];

/** Nombre con el que se guarda la llave de Zernio desde el panel (Sistema → Redes sociales). */
export const ZERNIO_SECRET = 'zernio_api_key';
/** De dónde sale la llave de la plataforma: el .env del servidor (manda) o la guardada en el panel. */
export const zernioKeySource = (): 'env' | 'panel' | 'none' => (process.env.ZERNIO_API_KEY ? 'env' : platformSecret(ZERNIO_SECRET) ? 'panel' : 'none');
/** Llave de Zernio: la de la plataforma, una sola para todas las cuentas (o, en canales creados antes, la que se guardó en el canal). */
export const zernioKey = (channel?: Pick<Channel, 'config'> | null) =>
  String(channel?.config?.api_key || process.env.ZERNIO_API_KEY || platformSecret(ZERNIO_SECRET) || '');
export const zernioEnabled = () => zernioKeySource() !== 'none';
/** Secreto con el que Zernio firma el webhook de la plataforma (derivado de la clave del servidor: no se guarda). */
export const platformWebhookSecret = () => hmac('zernio-webhook');
export const platformWebhookUrl = () => `${config.publicBaseUrl}/zernio/events`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Cliente mínimo. No reintenta envíos: uno que Zernio aceptó y luego falló podría duplicarse. */
export class ZernioClient {
  beforeRequest?:()=>Promise<void>;
  constructor(private apiKey: string, private base = config.zernioApiUrl) {}

  async call<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw new Error('Zernio no está configurado en esta instalación (falta ZERNIO_API_KEY)');
    let res = await this.send(method, path, body);
    // 429: la API rechazó la petición sin procesarla, así que repetirla una vez no duplica mensajes.
    if (res.status === 429) {
      const header = res.headers.get('retry-after')?.trim();
      const s = header ? Number(header) : NaN;
      await res.body?.cancel().catch(() => undefined);
      await sleep(Number.isFinite(s) && s >= 0 ? Math.min(s, 10) * 1000 : 2000);
      res = await this.send(method, path, body);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = data?.error?.message ?? data?.message ?? (typeof data?.error === 'string' ? data.error : 'error');
      throw new Error(`Zernio ${path.split('?')[0]} → ${res.status}: ${why}`);
    }
    return data as T;
  }

  private async send(method: Method, path: string, body?: unknown) {
    await this.beforeRequest?.();
    return fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  }

  /** Sube un archivo a Zernio (URL firmada) y devuelve su dirección pública para enviarlo como adjunto. */
  async upload(buffer: Buffer, filename: string, contentType: string): Promise<string> {
    const r = await this.call<any>('POST', '/media/presign', { filename, contentType, size: buffer.length });
    const uploadUrl = r?.uploadUrl ?? r?.data?.uploadUrl;
    const publicUrl = r?.publicUrl ?? r?.data?.publicUrl;
    if (!uploadUrl || !publicUrl) throw new Error('Zernio no devolvió dónde subir el archivo');
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(buffer), signal: AbortSignal.timeout(120000) });
    if (!put.ok) throw new Error(`No se pudo subir el archivo a Zernio (${put.status})`);
    return publicUrl;
  }
}

export const clientFor = (channel?: Pick<Channel, 'config'> | null) => new ZernioClient(zernioKey(channel));

/** Firma de los webhooks: HMAC-SHA256 en hexadecimal del cuerpo crudo. */
export function zernioSignature(rawBody: Buffer, secret: string) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** ¿La firma corresponde a alguno de los secretos (el de la plataforma o el propio de un canal anterior)? */
export function verifySignature(headers: WebhookRequest['headers'], rawBody: Buffer | undefined, secrets: string[]): boolean {
  const got = String(headers['x-zernio-signature'] ?? '');
  if (!rawBody || !got) return false;
  return secrets.filter(Boolean).some((s) => safeEqual(got, zernioSignature(rawBody, s)));
}

function verifyRequest({ channel, headers, rawBody }: WebhookRequest): boolean {
  return verifySignature(headers, rawBody, [channel.config.webhook_secret, platformWebhookSecret()]);
}

/** Tipo de un adjunto (image, video, audio, file; una nota de voz es audio). */
function attachmentType(a: any): InboundMessage['type'] {
  if (a?.payload?.voice) return 'audio';
  const t = String(a?.type ?? a?.mimeType ?? '').toLowerCase();
  if (t.startsWith('image') || t === 'sticker') return 'image';
  if (t.startsWith('video')) return 'video';
  if (t.startsWith('audio') || t === 'voice') return 'audio';
  return 'document';
}

/** Cuenta de Zernio a la que pertenece un evento (mensajes: account.id; conexión: account.accountId; o el formato anterior). */
export function eventAccountId(body: any): string {
  const id = body?.account?.id ?? body?.account?.accountId ?? body?.message?.accountId ?? body?.payload?.accountId ?? body?.payload?.account?.id ?? body?.accountId;
  return id == null ? '' : String(id);
}

/**
 * Evento de Zernio → mensajes normalizados. Formato actual (plano):
 * { event, message: { id, conversationId, platformMessageId, direction, text, attachments[], sender{...}, sentAt },
 *   conversation: { id, participantName, ... }, account: { id, platform, username } }.
 * También acepta el formato anterior con `payload`. Con `accountId`, los eventos de otra cuenta se ignoran.
 */
export function parseZernioEvent(body: any, accountId = ''): ParseResult {
  const event = typeof body?.event === 'string' ? body.event : '';
  const eventAccount = eventAccountId(body);
  if (accountId && eventAccount && eventAccount !== accountId) {
    return { messages: [], notices: [{ level: 'info', message: `Zernio: evento de otra cuenta (${eventAccount}) ignorado` }] };
  }
  if (event === 'account.disconnected') {
    const why = body?.account?.reason ? `: ${String(body.account.reason).slice(0, 200)}` : '';
    return { messages: [], connection: 'close', notices: [{ level: 'warn', message: `Zernio: la cuenta se desconectó${why}; hay que volver a conectarla` }] };
  }
  if (event === 'account.connected') return { messages: [], connection: 'open', notices: [{ level: 'info', message: 'Zernio: la cuenta quedó conectada' }] };
  if (event === 'message.failed') {
    const e = body?.error;
    const why = e?.message ?? e?.title ?? '';
    return { messages: [], notices: [{ level: 'warn', message: `Zernio: un mensaje no se pudo entregar${why ? `: ${String(why).slice(0, 200)}` : ''}` }] };
  }
  if (event !== 'message.received' && event !== 'message.sent') {
    return { messages: [], notices: [{ level: 'info', message: `Zernio: evento ignorado (${event || 'sin nombre'})` }] };
  }
  const legacy = body?.payload && !body?.message;
  const m = (legacy ? body.payload.message : body.message) ?? {};
  const conversationId = String(m.conversationId ?? body?.conversation?.id ?? body?.payload?.conversationId ?? '');
  const messageId = String(m.platformMessageId ?? m.id ?? '');
  if (!conversationId || !messageId) {
    return { messages: [], notices: [{ level: 'warn', message: `Zernio: evento ${event} con forma no reconocida (claves: ${Object.keys((legacy ? body.payload : body) ?? {}).join(', ') || 'ninguna'})` }] };
  }
  const fromMe = event === 'message.sent' || m.direction === 'outgoing';
  const sender = (legacy ? body.payload.sender : m.sender) ?? {};
  const text = typeof m.text === 'string' ? m.text : '';
  const created = Date.parse(String(m.sentAt ?? m.createdAt ?? body?.timestamp ?? ''));
  const files: any[] = Array.isArray(m.attachments) ? m.attachments : m.attachment ? [m.attachment] : m.attachmentUrl ? [{ url: m.attachmentUrl }] : [];
  const file = files[0];
  const type: InboundMessage['type'] = file ? attachmentType(file) : text ? 'text' : 'other';
  const msg: InboundMessage = {
    messageId,
    // La conversación de Zernio identifica al cliente y permite responder en el mismo hilo.
    externalId: conversationId,
    phone: fromMe ? '' : String(sender.phoneNumber ?? '').replace(/\D/g, ''),
    displayName: fromMe ? '' : String(sender.name || sender.username || body?.conversation?.participantName || ''),
    fromMe,
    type,
    text,
    timestamp: Number.isNaN(created) ? Math.floor(Date.now() / 1000) : Math.floor(created / 1000),
    ...(file ? { media: { url: typeof file.url === 'string' ? file.url : undefined, mimeType: file.mimeType, filename: file.name ?? file.filename, size: Number(file.size) || undefined } } : {}),
  };
  return { messages: [msg] };
}

/** Id del mensaje enviado (el de la plataforma), para reconocer el eco que Zernio manda después. */
function messageRef(r: any): string | null {
  const id = r?.data?.messageId ?? r?.messageId ?? r?.id ?? r?.message?.id;
  return id == null ? null : String(id);
}

/** Descarga un adjunto que mandó el cliente. Los servidos por la API de Zernio (p. ej. WhatsApp) piden la llave. */
async function download(channel: Channel, url: string | undefined): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!url) return null;
  const own = url.startsWith(new URL(config.zernioApiUrl).origin);
  if (!own && !url.startsWith('https://')) return null;
  const res = await fetch(url, { headers: own ? { authorization: `Bearer ${zernioKey(channel)}` } : {}, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0] };
}

const ATTACHMENT_TYPE: Record<OutgoingFile['kind'], string> = { image: 'image', video: 'video', audio: 'audio', document: 'file' };

class ZernioTransport implements Transport {
  setDispatchGuard(guard:()=>Promise<void>){this.client.beforeRequest=guard;}
  kind = 'zernio' as const;
  private client: ZernioClient;
  private base: string;
  private network: Network | undefined;

  constructor(private channel: Channel, conversationId: string) {
    this.client = clientFor(channel);
    this.base = `/inbox/conversations/${encodeURIComponent(conversationId)}`;
    this.network = networkOf(channel.config.platform);
  }

  private accountId(): string {
    if (!this.channel.config.account_id) throw new Error('La cuenta de esta red todavía no está conectada');
    return this.channel.config.account_id;
  }

  /** «Escribiendo…» donde la red lo permite; nunca detiene el envío. */
  private async typing(ms: number) {
    if (ms <= 0) return;
    if (this.network?.typing) await this.client.call('POST', `${this.base}/typing`, { accountId: this.accountId() }).catch(() => undefined);
    await sleep(Math.min(ms, 4000));
  }

  private needsMedia(what: string) {
    if (this.network && !this.network.media) throw new Error(`${this.network.label} no permite enviar ${what} por mensaje directo`);
  }

  async sendText(text: string, delayMs: number) {
    await this.typing(delayMs);
    return messageRef(await this.client.call<any>('POST', `${this.base}/messages`, { accountId: this.accountId(), message: toPlainText(text) }));
  }

  async sendImage(image: ImageAsset, caption: string, delayMs: number) {
    this.needsMedia('fotos');
    if (!config.publicBaseUrl.startsWith('https://')) {
      throw new Error('Para enviar imágenes por redes sociales define PUBLIC_BASE_URL con HTTPS (la red descarga la imagen desde esa URL)');
    }
    await this.typing(Math.min(delayMs, 1500));
    return messageRef(await this.client.call<any>('POST', `${this.base}/messages`, {
      accountId: this.accountId(),
      message: caption ? toPlainText(caption) : '',
      attachmentUrl: signedImageUrl(image.id),
      attachmentType: 'image',
    }));
  }

  async sendFile(file: OutgoingFile, caption: string, delayMs: number) {
    this.needsMedia('archivos');
    await this.typing(Math.min(delayMs, 1500));
    const url = await this.client.upload(await fsp.readFile(file.absPath), file.name, file.mime);
    return messageRef(await this.client.call<any>('POST', `${this.base}/messages`, {
      accountId: this.accountId(),
      message: caption ? toPlainText(caption) : '',
      attachmentUrl: url,
      attachmentType: ATTACHMENT_TYPE[file.kind],
      attachmentName: file.name,
    }));
  }

  async notify() {
    throw new Error('Las redes sociales no envían avisos internos');
  }
}

/* ------------------------------ Perfil, cuentas, conexión y webhook de la plataforma ------------------------------ */

const listOf = (r: any, key: string): any[] => (Array.isArray(r) ? r : Array.isArray(r?.[key]) ? r[key] : Array.isArray(r?.data) ? r.data : []);
const idOf = (x: any) => String(x?._id ?? x?.id ?? '');

/** Perfil de Zernio del negocio (uno por cuenta; se crea la primera vez y se reconoce por externalId). */
export async function profileFor(client: ZernioClient, account: { id: string; name: string }): Promise<string> {
  const found = listOf(await client.call('GET', '/profiles?limit=100'), 'profiles').find((p) => p.externalId === account.id);
  if (found) return idOf(found);
  const r = await client.call<any>('POST', '/profiles', { name: (account.name || 'Negocio').slice(0, 100), externalId: account.id });
  const id = idOf(r?.profile ?? r?.data ?? r);
  if (!id) throw new Error('Zernio no devolvió el perfil creado');
  return id;
}

export interface ZernioAccount { id: string; platform: string; username: string; displayName: string; picture: string; active: boolean }

const toAccount = (a: any): ZernioAccount => ({
  id: idOf(a), platform: String(a.platform ?? ''), username: String(a.username ?? ''), displayName: String(a.displayName ?? ''),
  picture: String(a.profilePicture ?? ''), active: a.isActive !== false && !a.needsReconnection,
});

/** Cuenta conectada en Zernio (con su usuario, nombre y foto). */
export async function accountInfo(client: ZernioClient, profileId: string, accountId: string): Promise<ZernioAccount | null> {
  const list = listOf(await client.call('GET', `/accounts?profileId=${encodeURIComponent(profileId)}`), 'accounts');
  const a = list.find((x) => idOf(x) === accountId);
  return a ? toAccount(a) : null;
}

/** Desconecta la cuenta en Zernio (deja de recibir y enviar mensajes por ella). */
export async function disconnectAccount(client: ZernioClient, accountId: string): Promise<void> {
  await client.call('DELETE', `/accounts/${encodeURIComponent(accountId)}`);
}

/**
 * Webhook de la plataforma: uno solo para todos los negocios (Zernio permite 50 por llave). Se crea, o se corrige si
 * está apagado o le faltan eventos. El secreto se vuelve a enviar siempre: se deriva de la clave del servidor.
 */
export async function ensurePlatformWebhook(client: ZernioClient): Promise<void> {
  const url = platformWebhookUrl();
  if (!url.startsWith('https://')) throw new Error('Zernio exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)');
  const hooks = listOf(await client.call('GET', '/webhooks/settings'), 'webhooks');
  const mine = hooks.find((w) => w.url === url);
  const body = { name: 'Panel de chatbots', url, secret: platformWebhookSecret(), events: EVENTS, isActive: true };
  if (!mine) await client.call('POST', '/webhooks/settings', body);
  else if (mine.isActive === false || EVENTS.some((e) => !(mine.events ?? []).includes(e))) {
    await client.call('PUT', '/webhooks/settings', { webhookId: idOf(mine), ...body });
  }
}

/** URL de Zernio donde el negocio autoriza su red (Instagram, Facebook, WhatsApp, X, Reddit). Zernio aloja la selección de página o número. */
export async function zernioAuthUrl(channel: Channel, redirectUrl: string): Promise<string> {
  const platform = String(channel.config.platform ?? '');
  if (networkOf(platform)?.flow !== 'oauth') throw new Error('Esta red se conecta desde el panel, sin salir a otra página');
  const q = new URLSearchParams({ profileId: channel.config.profile_id, redirect_url: redirectUrl });
  if (platform === 'whatsapp') q.set('language', 'es');
  const r = await clientFor(channel).call<any>('GET', `/connect/${encodeURIComponent(platform)}?${q}`);
  const url = r?.authUrl ?? r?.url ?? r?.data?.authUrl;
  if (!url) throw new Error('Zernio no devolvió la URL de autorización');
  return url;
}

/** Telegram: código que el negocio envía a su bot; luego se consulta hasta que queda conectado. */
export async function telegramCode(channel: Channel): Promise<{ code: string; botUsername: string; expiresAt: string; instructions: string[] }> {
  const r = await clientFor(channel).call<any>('GET', `/connect/telegram?profileId=${encodeURIComponent(channel.config.profile_id)}`);
  if (!r?.code) throw new Error('Zernio no devolvió el código de Telegram');
  return { code: String(r.code), botUsername: String(r.botUsername ?? ''), expiresAt: String(r.expiresAt ?? ''), instructions: Array.isArray(r.instructions) ? r.instructions.map(String) : [] };
}

export async function telegramCheck(channel: Channel, code: string): Promise<{ status: 'pending' | 'connected' | 'expired'; account?: ZernioAccount }> {
  const r = await clientFor(channel).call<any>('PATCH', `/connect/telegram?code=${encodeURIComponent(code)}`);
  if (r?.status === 'connected' && r.account) return { status: 'connected', account: toAccount(r.account) };
  return { status: r?.status === 'expired' ? 'expired' : 'pending' };
}

/** Bluesky: usuario y contraseña de aplicación (no la contraseña de la cuenta). */
export async function blueskyConnect(channel: Channel, identifier: string, appPassword: string): Promise<ZernioAccount> {
  const client = clientFor(channel);
  const me = await client.call<any>('GET', '/users');
  const userId = me?.currentUserId ?? me?.data?.currentUserId;
  if (!userId) throw new Error('Zernio no devolvió el usuario de la plataforma');
  const r = await client.call<any>('POST', '/connect/bluesky/credentials', { identifier, appPassword, state: `${userId}-${channel.config.profile_id}` });
  if (!r?.account) throw new Error(r?.message ?? 'Bluesky no aceptó la cuenta');
  return toAccount(r.account);
}

export const zernioAdapter: ChannelAdapter = {
  type: 'zernio',
  label: 'Redes sociales (Zernio)',
  configSchema: ChannelConfigSchemas.zernio,

  verifyRequest,

  parse: ({ body, channel }) => parseZernioEvent(body, channel.config.account_id ?? ''),

  transport: (channel, contact) => new ZernioTransport(channel, contact.external_id),

  async downloadMedia(channel, msg) {
    return download(channel, msg.media?.url);
  },

  async downloadAudio(channel, msg) {
    return download(channel, msg.media?.url);
  },

  /** Revisa la cuenta en Zernio y deja listo el webhook de la plataforma. */
  async setup(channel) {
    if (!channel.config.account_id || !channel.config.profile_id) return { ok: false, message: 'Primero conecta la cuenta de la red' };
    const client = clientFor(channel);
    await ensurePlatformWebhook(client);
    const info = await accountInfo(client, channel.config.profile_id, channel.config.account_id);
    if (!info) return { ok: false, message: 'La cuenta ya no está en Zernio: vuelve a conectarla' };
    return {
      ok: info.active,
      message: info.active ? `Cuenta conectada${info.username ? ` (@${info.username})` : ''}; los mensajes llegan por el webhook de la plataforma` : 'La red pide volver a autorizar la cuenta',
      config: { username: info.username, display_name: info.displayName, picture: info.picture },
    };
  },

  async status(channel) {
    if (!channel.config.account_id || !channel.config.profile_id) return { state: 'close', details: { reason: 'sin conectar' } };
    const info = await accountInfo(clientFor(channel), channel.config.profile_id, channel.config.account_id);
    return {
      state: info?.active ? 'open' : 'close',
      details: info ? { username: info.username, display_name: info.displayName, picture: info.picture } : { reason: 'la cuenta ya no está en Zernio' },
    };
  },
};
