import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { config } from '../config.js';
import { toPlainText } from '../engine/text.js';
import { sleep, type OutgoingFile, type OutgoingTemplate, type Transport } from '../engine/transport.js';
import { decryptSecret, hmac, safeEqual } from '../secret.js';
import { ChannelConfigSchemas, type Channel, type ImageAsset } from '../types.js';
import { signedImageUrl } from './media.js';
import type { ChannelAdapter, InboundMessage, ParseResult, WebhookRequest } from './types.js';
import { platformSecret } from '../platform-secrets.js';
import { drainZernioBudget, noteZernioLimit, takeZernioBudget, type ZernioPriority } from './zernio-budget.js';

/**
 * Zernio: una sola API para los mensajes directos de varias redes (Instagram, Facebook, WhatsApp Business, Telegram, X,
 * Bluesky y Reddit). La plataforma tiene UNA llave de Zernio (ZERNIO_API_KEY, solo en el servidor); cada negocio tiene su
 * perfil en Zernio y conecta sus redes desde el panel, sin ver llaves ni identificadores.
 *
 * Referencia: SDK oficial @zernio/node y adaptador @zernio/chat-sdk-adapter (eventos planos { event, message,
 * conversation, account }, firma HMAC-SHA256 hexadecimal en X-Zernio-Signature, id del envío en data.messageId).
 */

/**
 * Redes de Zernio y lo que permite cada una: mensajes directos (dm), comentarios, reseñas, publicaciones, estadísticas,
 * respuesta privada a un comentario, botones (interactive) y si solo se puede escribir dentro de las 24 h posteriores al
 * último mensaje del cliente (window24h). Las que no tienen mensajes directos sirven para comentarios, posts y estadísticas.
 */
export const NETWORKS = [
  { id: 'instagram', label: 'Instagram', flow: 'oauth', dm: true, media: true, typing: true, comments: true, reviews: false, posts: true, analytics: true, privateReply: true, interactive: true, window24h: true },
  { id: 'facebook', label: 'Facebook Messenger', flow: 'oauth', dm: true, media: true, typing: true, comments: true, reviews: true, posts: true, analytics: true, privateReply: true, interactive: true, window24h: true },
  { id: 'whatsapp', label: 'WhatsApp Business (API oficial)', flow: 'oauth', dm: true, media: true, typing: true, comments: false, reviews: false, posts: false, analytics: false, privateReply: false, interactive: true, window24h: true },
  { id: 'telegram', label: 'Telegram', flow: 'code', dm: true, media: true, typing: true, comments: false, reviews: false, posts: true, analytics: false, privateReply: false, interactive: true, window24h: false },
  { id: 'twitter', label: 'X (Twitter)', flow: 'oauth', dm: true, media: true, typing: false, comments: true, reviews: false, posts: true, analytics: true, privateReply: false, interactive: false, window24h: false },
  { id: 'bluesky', label: 'Bluesky', flow: 'credentials', dm: true, media: false, typing: false, comments: true, reviews: false, posts: true, analytics: false, privateReply: false, interactive: false, window24h: false },
  { id: 'reddit', label: 'Reddit', flow: 'oauth', dm: true, media: false, typing: false, comments: true, reviews: false, posts: true, analytics: false, privateReply: false, interactive: false, window24h: false },
  { id: 'linkedin', label: 'LinkedIn', flow: 'oauth', dm: false, media: true, typing: false, comments: true, reviews: false, posts: true, analytics: true, privateReply: false, interactive: false, window24h: false },
  { id: 'tiktok', label: 'TikTok', flow: 'oauth', dm: false, media: true, typing: false, comments: true, reviews: false, posts: true, analytics: true, privateReply: false, interactive: false, window24h: false },
  { id: 'youtube', label: 'YouTube', flow: 'oauth', dm: false, media: true, typing: false, comments: true, reviews: false, posts: true, analytics: true, privateReply: false, interactive: false, window24h: false },
  { id: 'threads', label: 'Threads', flow: 'oauth', dm: false, media: true, typing: false, comments: true, reviews: false, posts: true, analytics: true, privateReply: false, interactive: false, window24h: false },
  { id: 'pinterest', label: 'Pinterest', flow: 'oauth', dm: false, media: true, typing: false, comments: false, reviews: false, posts: true, analytics: true, privateReply: false, interactive: false, window24h: false },
  { id: 'googlebusiness', label: 'Google (perfil de negocio)', flow: 'oauth', dm: false, media: true, typing: false, comments: false, reviews: true, posts: true, analytics: true, privateReply: false, interactive: false, window24h: false },
] as const;
export type Network = (typeof NETWORKS)[number];
export const networkOf = (platform: string): Network | undefined => NETWORKS.find((n) => n.id === platform);
/** Red que sirve para una conexión de mensajes (las demás solo para comentarios, posts y estadísticas). */
export const dmNetworkOf = (platform: string): Network | undefined => NETWORKS.find((n) => n.id === platform && n.dm);
/** ¿Esta red de Zernio solo permite escribir dentro de las 24 h posteriores al último mensaje del cliente? */
export const zernioNeedsWindow = (platform: string) => networkOf(platform)?.window24h ?? true;

/** Eventos que recibe el webhook de la plataforma. */
export const EVENTS = [
  'message.received', 'message.sent', 'message.failed', 'message.delivered', 'message.read', 'account.connected', 'account.disconnected', 'whatsapp.template.status_updated',
  'comment.received', 'review.new', 'review.updated',
  'post.scheduled', 'post.published', 'post.failed', 'post.partial', 'post.cancelled', 'post.platform.published', 'post.platform.failed', 'post.platform.deleted',
];

/** Nombre con el que se guarda la llave de Zernio desde el panel (Sistema → Redes sociales). */
export const ZERNIO_SECRET = 'zernio_api_key';
/** De dónde sale la llave de la plataforma: el .env del servidor (manda) o la guardada en el panel. */
export const zernioKeySource = (): 'env' | 'panel' | 'none' => (process.env.ZERNIO_API_KEY ? 'env' : platformSecret(ZERNIO_SECRET) ? 'panel' : 'none');
/**
 * Llave de Zernio: la de la plataforma, una sola para todas las cuentas (o, en canales creados antes, la que se guardó en
 * el canal; esas se guardan cifradas desde migrateLegacyZernioKeys).
 */
export const zernioKey = (channel?: Pick<Channel, 'config'> | null) => {
  const own = String(channel?.config?.api_key ?? '');
  const legacy = own.startsWith('v1.') ? decryptSecret(own) ?? '' : own;
  return String(legacy || process.env.ZERNIO_API_KEY || platformSecret(ZERNIO_SECRET) || '');
};
export const zernioEnabled = () => zernioKeySource() !== 'none';
/** Secreto con el que Zernio firma el webhook de la plataforma (derivado de la clave del servidor: no se guarda). */
export const platformWebhookSecret = () => hmac('zernio-webhook');
export const platformWebhookUrl = () => `${config.publicBaseUrl}/zernio/events`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Error de la API de Zernio con su código HTTP y el cuerpo (p. ej. existingProfileId en un 409). */
export class ZernioError extends Error {
  constructor(message: string, public status: number, public data: any) {
    super(message);
  }
}

/**
 * Cliente mínimo. No reintenta envíos: uno que Zernio aceptó y luego falló podría duplicarse. Las consultas (GET) sí se
 * repiten una vez ante un error del servidor, y las altas pueden llevar Idempotency-Key. Cada llamada toma su lugar en
 * el presupuesto compartido de la llave (lo que corre solo, con prioridad baja).
 */
export class ZernioClient {
  beforeRequest?:()=>Promise<void>;
  priority: ZernioPriority = 'interactive';
  constructor(private apiKey: string, private base = config.zernioApiUrl) {}

  async call<T = any>(method: Method, path: string, body?: unknown, opts: { idempotencyKey?: string; timeoutMs?: number; scopedLimits?: boolean } = {}): Promise<T> {
    if (!this.apiKey) throw new Error('Zernio no está configurado en esta instalación (falta ZERNIO_API_KEY)');
    let res = await this.send(method, path, body, opts);
    // Publicaciones: un límite de una cuenta o de la red (p. ej. 25 por hora en una cuenta) trae detalles y no es el de la
    // llave, así que no se frena a todos los negocios ni se repite. Solo quien lo pide (las publicaciones) lo distingue.
    const scoped = !!opts.scopedLimits && res.status === 429 && (await res.clone().json().then((d: any) => !!(d?.details ?? d?.error?.details)).catch(() => false));
    // 429: la API rechazó la petición sin procesarla, así que repetirla una vez no duplica mensajes. Una consulta que
    // falló en el servidor de Zernio tampoco cambia nada al repetirla.
    if ((res.status === 429 && !scoped) || (method === 'GET' && res.status >= 500)) {
      const header = res.headers.get('retry-after')?.trim();
      const s = header ? Number(header) : NaN;
      // Zernio dice que se pasó el límite de la llave: todos los procesos esperan a que se reponga.
      if (res.status === 429) await drainZernioBudget(Number.isFinite(s) && s > 0 ? Math.min(s, 60) : 15);
      await res.body?.cancel().catch(() => undefined);
      await sleep(Number.isFinite(s) && s >= 0 ? Math.min(s, 10) * 1000 : res.status === 429 ? 2000 : 500);
      res = await this.send(method, path, body, opts);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = data?.error?.message ?? data?.message ?? (typeof data?.error === 'string' ? data.error : 'error');
      throw new ZernioError(`Zernio ${path.split('?')[0]} → ${res.status}: ${why}`, res.status, data);
    }
    return data as T;
  }

  /** Todas las páginas de una lista (Zernio pagina con cursor); como máximo `maxPages`. */
  async listAll(path: string, key: string, maxPages = 50): Promise<any[]> {
    return (await this.listPages(path, key, maxPages)).items;
  }

  /**
   * Como listAll, y además dice si la lista está completa: no lo está si se cortó en `maxPages` o si alguna página no
   * traía la lista (forma desconocida). Quien borra lo que "ya no está" solo debe hacerlo con una lista completa.
   */
  async listPages(path: string, key: string, maxPages = 50): Promise<{ items: any[]; complete: boolean }> {
    const items: any[] = [];
    let cursor = '';
    let complete = true;
    for (let page = 0; ; page++) {
      if (page >= maxPages) {
        complete = false;
        break;
      }
      const r = await this.call<any>('GET', cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path);
      if (!Array.isArray(r) && !Array.isArray(r?.[key]) && !Array.isArray(r?.data)) complete = false;
      items.push(...listOf(r, key));
      // Las listas de Zernio dicen la página siguiente de varias formas (los comentarios de un post: pagination.cursor).
      const next = r?.nextCursor ?? r?.pagination?.nextCursor ?? r?.cursor?.next ?? (r?.pagination?.hasMore ? r?.pagination?.cursor : undefined);
      cursor = next == null ? '' : String(next);
      if (!cursor) break;
    }
    return { items, complete };
  }

  private async send(method: Method, path: string, body?: unknown, opts: { idempotencyKey?: string; timeoutMs?: number } = {}) {
    await this.beforeRequest?.();
    await takeZernioBudget(this.priority);
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
    });
    noteZernioLimit(Number(res.headers.get('x-ratelimit-limit')));
    return res;
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

export const clientFor = (channel?: Pick<Channel, 'config'> | null, priority: ZernioPriority = 'interactive') => {
  const client = new ZernioClient(zernioKey(channel));
  client.priority = priority;
  return client;
};

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

/** Perfil de Zernio al que pertenece un evento, si lo dice (account.profileId o profiles[0].id). */
export function eventProfileId(body: any): string {
  const id = body?.account?.profileId ?? body?.message?.profileId ?? (Array.isArray(body?.profiles) ? body.profiles[0]?.id : undefined);
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

  /** Plantilla aprobada de WhatsApp (la única forma de escribir fuera de las 24 h). */
  async sendTemplate(t: OutgoingTemplate) {
    if (this.channel.config.platform !== 'whatsapp') throw new Error('Las plantillas solo existen en WhatsApp');
    return messageRef(await this.client.call<any>('POST', `${this.base}/messages`, {
      accountId: this.accountId(),
      template: { elements: [{ name: t.name, language: t.language, components: t.components }] },
    }));
  }

  async notify() {
    throw new Error('Las redes sociales no envían avisos internos');
  }
}

/* ------------------------------ Perfil, cuentas, conexión y webhook de la plataforma ------------------------------ */

export const listOf = (r: any, key: string): any[] => (Array.isArray(r) ? r : Array.isArray(r?.[key]) ? r[key] : Array.isArray(r?.data) ? r.data : []);
export const idOf = (x: any) => String(x?._id ?? x?.id ?? '');

/**
 * Perfil de Zernio del negocio (uno por cuenta; se reconoce por externalId = id del negocio, sin recorrer la lista de
 * perfiles). Se crea con Idempotency-Key: si dos procesos lo piden a la vez, Zernio responde 409 con el que ya existe.
 */
export async function profileFor(client: ZernioClient, account: { id: string; name: string }): Promise<string> {
  const found = listOf(await client.call('GET', `/profiles?externalId=${encodeURIComponent(account.id)}`), 'profiles').find((p) => p.externalId === account.id);
  if (found) return idOf(found);
  try {
    const r = await client.call<any>('POST', '/profiles', { name: (account.name || 'Negocio').slice(0, 100), externalId: account.id }, { idempotencyKey: `profile-${account.id}` });
    const id = idOf(r?.profile ?? r?.data ?? r);
    if (!id) throw new Error('Zernio no devolvió el perfil creado');
    return id;
  } catch (e) {
    if (e instanceof ZernioError && e.status === 409 && e.data?.existingProfileId) return String(e.data.existingProfileId);
    if (e instanceof ZernioError && e.status === 403 && /PROFILE_OVER_LIMIT|limit/i.test(JSON.stringify(e.data ?? {}))) {
      throw new Error('Tu plan de Zernio no permite más perfiles (uno por negocio). Amplía el plan en zernio.com o pásate a precios por uso.');
    }
    throw e;
  }
}

/** ¿El perfil sigue existiendo en Zernio? (false si se borró o la llave es de otra cuenta de Zernio). */
export async function profileExists(client: ZernioClient, profileId: string): Promise<boolean> {
  try {
    await client.call('GET', `/profiles/${encodeURIComponent(profileId)}`);
    return true;
  } catch (e) {
    if (e instanceof ZernioError && (e.status === 404 || e.status === 403)) return false;
    throw e;
  }
}

/** Borra el perfil en Zernio (Zernio lo impide mientras tenga cuentas conectadas). */
export async function deleteProfile(client: ZernioClient, profileId: string): Promise<void> {
  await client.call('DELETE', `/profiles/${encodeURIComponent(profileId)}`);
}

/** Cuenta de Zernio de la plataforma (para saber si cambió la llave a la de otra cuenta). */
export async function zernioWorkspace(client: ZernioClient): Promise<string> {
  const me = await client.call<any>('GET', '/users');
  return String(me?.currentUserId ?? me?.data?.currentUserId ?? '');
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
 * está apagado o le faltan eventos. Con `force` ("Probar y reparar") se vuelve a enviar siempre, con el secreto actual:
 * si cambió SESSION_SECRET, los avisos vuelven a validar sin tocar nada en Zernio.
 */
export async function ensurePlatformWebhook(client: ZernioClient, { force = false } = {}): Promise<void> {
  const url = platformWebhookUrl();
  if (!url.startsWith('https://')) throw new Error('Zernio exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)');
  const hooks = listOf(await client.call('GET', '/webhooks/settings'), 'webhooks');
  const mine = hooks.find((w) => w.url === url);
  const body = { name: 'Panel de chatbots', url, secret: platformWebhookSecret(), events: EVENTS, isActive: true };
  if (!mine) await client.call('POST', '/webhooks/settings', body);
  else if (force || mine.isActive === false || EVENTS.some((e) => !(mine.events ?? []).includes(e))) {
    await client.call('PUT', '/webhooks/settings', { webhookId: idOf(mine), ...body });
  }
}

/** URL de Zernio donde el negocio autoriza su red (Instagram, Facebook, WhatsApp, X, Reddit). Zernio aloja la selección de página o número. */
export async function zernioAuthUrl(channel: Channel, redirectUrl: string): Promise<string> {
  const platform = String(channel.config.platform ?? '');
  if (networkOf(platform)?.flow !== 'oauth') throw new Error('Esta red se conecta desde el panel, sin salir a otra página');
  const q = new URLSearchParams({ profileId: channel.config.profile_id, redirect_url: redirectUrl });
  // WhatsApp: alta en una página de Zernio (Embedded Signup de Meta), en español; `language` solo se acepta así.
  if (platform === 'whatsapp') {
    q.set('signup', 'hosted');
    q.set('language', 'es');
  }
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
