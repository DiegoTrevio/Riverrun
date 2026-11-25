/**
 * Canal de correo, de dos formas:
 * - Reenvío (recomendado): el negocio reenvía su correo a la dirección del canal; llega por el webhook de Resend y se
 *   responde por su API (src/channels/email-inbound.ts). No pide contraseñas ni usa SMTP.
 * - IMAP: recibe por IMAP (sondeo cada minuto) y responde por SMTP en el mismo hilo. Sirve con Gmail (contraseña de
 *   aplicación) o cualquier proveedor. Los servidores de red interna se rechazan para que un cliente no use el canal
 *   para explorar la red del servidor.
 * Los dos caminos pasan cada correo por los mismos filtros (processIncomingMail).
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { isPrivateIp } from '../automation/automator.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { htmlToText } from '../knowledge-import.js';
import { clampInbound } from '../engine/text.js';
import { imageAbsolutePath, type MailEnvelope, type OutgoingFile, type Transport } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import { notifyUsers } from '../automation/store.js';
import { hydrateChannel } from '../store/index.js';
import { countHit } from '../identity/rate-limit.js';
import type { ChatService } from '../service.js';
import { ChannelConfigSchemas, type Channel, type ImageAsset } from '../types.js';
import type { ChannelAdapter, InboundMessage } from './types.js';
import { forwardAddress, newForwardAlias, sendViaResend } from './email-inbound.js';
import { campaignAddress } from './email-campaign.js';

export interface MailConfig {
  mode: 'imap' | 'forward'; forward_alias: string;
  imap_host: string; imap_port: number; imap_user: string; imap_password: string;
  smtp_host: string; smtp_port: number; smtp_user: string; smtp_password: string;
  from_address: string; from_name: string; last_uid: number; uid_validity: number;
}

export interface RawMail {
  uid: number;
  messageId: string;
  address: string;
  name: string;
  subject: string;
  text: string;
  date: Date;
  references: string;
  automated: boolean;
  /** El primer encabezado Authentication-Results (el que pone el servidor que recibió el correo). */
  authResults?: string;
  /** Por reenvío: SPF, DKIM y DMARC calculados por el servidor de Resend que lo recibió. */
  authentication?: MailAuthentication;
}

export interface MailAuthentication {
  spf: 'pass' | 'fail' | 'gray' | 'processing_failed' | 'unknown';
  dkim: MailAuthentication['spf'];
  dmarc: MailAuthentication['spf'];
}

/**
 * Servidores cuyo Authentication-Results se cree: el que configuró el canal (`auth_server_id`, separados por coma) o el
 * del proveedor (Gmail: mx.google.com; Outlook: el formato de Microsoft, sin identificador y con compauth=); con otro
 * proveedor, el dominio del servidor IMAP. Sin esto, quien manda podía escribir su propio «dmarc=pass» y, en un servidor
 * que no agrega el suyo, ese era el único (revisión de la 4′).
 */
export function trustedAuthServers(cfg: { provider?: string; imap_host?: string; auth_server_id?: string }): string[] {
  const set = String(cfg.auth_server_id ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (set.length) return set;
  if (cfg.provider === 'gmail' || /(^|\.)gmail\.com$|googlemail\.com$/i.test(cfg.imap_host ?? '')) return ['mx.google.com'];
  if (cfg.provider === 'outlook' || /office365\.com$|outlook\.com$/i.test(cfg.imap_host ?? '')) return ['microsoft'];
  const labels = String(cfg.imap_host ?? '').toLowerCase().split('.').filter(Boolean);
  return labels.length >= 3 ? [labels.slice(1).join('.')] : labels.length === 2 ? [labels.join('.')] : [];
}

/** El Authentication-Results lo escribió un servidor de confianza. */
function fromTrustedServer(ar: string, trusted: string[]): boolean {
  const id = ar.split(';')[0].trim().split(/\s+/)[0].toLowerCase();
  if (trusted.includes('microsoft') && id.includes('=') && /\bcompauth=/.test(ar)) return true;
  if (!id || id.includes('=')) return false;
  return trusted.some((t) => t !== 'microsoft' && (id === t || id.endsWith(`.${t}`)));
}

/** El dominio firmado y el del From son el mismo o uno es subdominio del otro (nadie firma por un dominio que no controla). */
const aligned = (d: string, domain: string) => d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`);

/**
 * ¿El remitente está comprobado (IN-17)? Solo cuenta el primer Authentication-Results, y solo si lo escribió el
 * servidor de tu proveedor (`trusted`): dmarc=pass, o dkim=pass del mismo dominio que el From (header.d o header.i).
 */
export function senderVerified(authResults: string | undefined, from: string, trusted: string[] = []): boolean {
  if (!authResults) return false;
  const domain = from.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return false;
  const ar = authResults.toLowerCase();
  if (!fromTrustedServer(ar, trusted)) return false;
  if (/\bdmarc=pass\b/.test(ar)) return true;
  for (const part of ar.split(';')) {
    if (!/\bdkim=pass\b/.test(part)) continue;
    const d = /header\.d=([a-z0-9.-]+)/.exec(part)?.[1] ?? /header\.i=[^@\s]*@([a-z0-9.-]+)/.exec(part)?.[1];
    if (d && aligned(d.replace(/\.$/, ''), domain)) return true;
  }
  return false;
}
/** Respuestas por hora en un canal de correo: más se guardan sin contestar y se avisa (IN-17). */
export const EMAIL_REPLIES_PER_HOUR = 60;
/**
 * A quien le llegó una campaña en los últimos 30 días se le contesta con su propio tope: una campaña a miles de personas
 * recibe muchas respuestas en poco tiempo, y todas son de gente a la que el negocio escribió.
 */
export const CAMPAIGN_REPLIES_PER_HOUR = 600;

export interface OutMail {
  from: string; to: string; subject: string; text: string; inReplyTo: string; references: string; attachment?: { path: string; filename: string };
  /** Campaña: a dónde va la respuesta del cliente (la dirección de reenvío del canal). */
  replyTo?: string;
  /** Cabeceras extra (las de baja de un clic de una campaña). */
  headers?: Record<string, string>;
  /** Un correo de campaña, no una respuesta: no lleva Auto-Submitted ni In-Reply-To. */
  bulk?: boolean;
}

export interface MailBackend {
  fetchNew(cfg: MailConfig): Promise<{ mails: RawMail[]; lastUid: number; uidValidity: number }>;
  send(cfg: MailConfig, mail: OutMail): Promise<string>;
  verify(cfg: MailConfig): Promise<void>;
}

/** Resuelve el servidor y rechaza redes internas; se conecta por IP para que no cambie entre la revisión y la conexión. */
async function publicAddress(host: string): Promise<string> {
  if (!host) throw new Error('Falta el servidor de correo');
  const ip = net.isIP(host) ? host : (await dns.lookup(host)).address;
  if (!config.allowPrivateWebhooks && isPrivateIp(ip)) throw new Error('El servidor de correo apunta a una red interna; no está permitido');
  return ip;
}

/** Dirección desde la que responde el canal: la de reenvío, o la del buzón IMAP. */
const addressOf = (c: MailConfig) => (c.mode === 'forward' ? forwardAddress(c.forward_alias) : c.from_address || c.imap_user).toLowerCase();
/** Correos propios del canal (no se contestan): su dirección, la de sus campañas y, por reenvío, el buzón que reenvía. */
const ownAddresses = (c: MailConfig) => [addressOf(c), c.mode === 'forward' ? campaignAddress(c.forward_alias) : '', c.from_address.toLowerCase()].filter(Boolean);

/** Límite del texto de un correo que se guarda (lo que no cabe se corta; el resto del hilo sigue en el correo). */
const MAX_MAIL_TEXT = 50_000;
const MAX_MAIL_HTML = 2 * 1024 * 1024;

/** Primera línea no vacía después de la posición i. */
function nextLine(lines: string[], i: number): string {
  for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j].trim();
  return '';
}

/**
 * Quita el texto citado de una respuesta: "El … escribió:", "On … wrote:", líneas con ">" y el bloque de un reenvío
 * ("De: … / Enviado: …"). Una línea normal que empieza con "De:" (p. ej. "De: lunes a viernes") se conserva.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^(on .+ wrote:|el .+ escribi[óo]:|-{2,}\s*(original message|mensaje original)|_{5,}$)/i.test(line)) break;
    if (/^(de|from):\s/i.test(line) && /^(enviado|sent|fecha|date|para|to|asunto|subject|cc):/i.test(nextLine(lines, i))) break;
    if (line.startsWith('>')) continue;
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const MAX_MAIL_BYTES = 10 * 1024 * 1024;
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce|alerts?)[+@._-]/i;

const realBackend: MailBackend = {
  async fetchNew(cfg) {
    const ip = await publicAddress(cfg.imap_host);
    const client = new ImapFlow({ host: ip, port: cfg.imap_port, secure: cfg.imap_port === 993, servername: cfg.imap_host, auth: { user: cfg.imap_user, pass: cfg.imap_password }, logger: false, socketTimeout: 30_000, doSTARTTLS: cfg.imap_port !== 993 ? true : undefined } as any);
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const box: any = client.mailbox;
        const validity = Number(box.uidValidity);
        // Primera vez (o el buzón se reconstruyó): se parte de hoy, sin contestar el historial.
        if (!cfg.uid_validity || cfg.uid_validity !== validity) return { mails: [], lastUid: Math.max(0, Number(box.uidNext) - 1), uidValidity: validity };
        const mails: RawMail[] = [];
        let lastUid = cfg.last_uid;
        // Primero solo tamaños: un correo enorme no se descarga (se salta) y uno dañado no bloquea los siguientes.
        const pending: { uid: number; size: number }[] = [];
        for await (const m of client.fetch(`${cfg.last_uid + 1}:*`, { uid: true, size: true }, { uid: true })) {
          if (m.uid > cfg.last_uid && pending.length < 20) pending.push({ uid: m.uid, size: Number(m.size ?? 0) });
        }
        for (const { uid, size } of pending) {
          lastUid = Math.max(lastUid, uid); // el cursor avanza siempre, aunque este correo falle
          if (size > MAX_MAIL_BYTES) continue;
          try {
            const m: any = await client.fetchOne(String(uid), { source: true }, { uid: true });
            const p = await simpleParser(m.source as Buffer, { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true });
            const from = p.from?.value?.[0];
            if (!from?.address) continue;
            const h = p.headers;
            const auto = String(h.get('auto-submitted') ?? '');
            const automated = (!!auto && auto !== 'no') || /bulk|junk|list/i.test(String(h.get('precedence') ?? '')) || h.has('list-id') || h.has('x-auto-response-suppress') || AUTOMATED_SENDER.test(from.address);
            mails.push({
              uid,
              messageId: p.messageId ?? `uid-${cfg.uid_validity || validity}-${uid}`,
              address: from.address.toLowerCase(),
              name: from.name ?? '',
              subject: p.subject ?? '',
              // Correos solo en HTML: se convierte el HTML a texto en vez de guardar un mensaje vacío.
              // Del texto solo se guardan MAX_MAIL_TEXT caracteres: más de 2 MB de HTML solo gastaría memoria.
              text: p.text || (typeof p.html === 'string' ? htmlToText(p.html.slice(0, MAX_MAIL_HTML)) : ''),
              date: p.date ?? new Date(),
              references: [p.references].flat().filter(Boolean).join(' '),
              automated,
              authResults: firstHeader(h.get('authentication-results')),
            });
          } catch {
            /* correo ilegible: se omite y se sigue */
          }
        }
        return { mails, lastUid, uidValidity: validity };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  },

  async send(cfg, mail) {
    const ip = await publicAddress(cfg.smtp_host);
    const t = nodemailer.createTransport({ host: ip, port: cfg.smtp_port, secure: cfg.smtp_port === 465, requireTLS: cfg.smtp_port !== 465, auth: { user: cfg.smtp_user || cfg.imap_user, pass: cfg.smtp_password || cfg.imap_password }, tls: { servername: cfg.smtp_host }, connectionTimeout: 15_000, socketTimeout: 30_000 });
    const info = await t.sendMail({
      from: mail.from, to: mail.to, subject: mail.subject, text: mail.text,
      inReplyTo: mail.inReplyTo || undefined, references: mail.references || undefined,
      // Evita bucles con otros contestadores automáticos
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
      attachments: mail.attachment ? [mail.attachment] : undefined,
    });
    return String(info.messageId);
  },

  async verify(cfg) {
    const ip = await publicAddress(cfg.imap_host);
    const client = new ImapFlow({ host: ip, port: cfg.imap_port, secure: cfg.imap_port === 993, servername: cfg.imap_host, auth: { user: cfg.imap_user, pass: cfg.imap_password }, logger: false, socketTimeout: 20_000, doSTARTTLS: cfg.imap_port !== 993 ? true : undefined } as any);
    await client.connect();
    await client.logout().catch(() => undefined);
    const sip = await publicAddress(cfg.smtp_host);
    await nodemailer.createTransport({ host: sip, port: cfg.smtp_port, secure: cfg.smtp_port === 465, requireTLS: cfg.smtp_port !== 465, auth: { user: cfg.smtp_user || cfg.imap_user, pass: cfg.smtp_password || cfg.imap_password }, tls: { servername: cfg.smtp_host }, connectionTimeout: 15_000 }).verify();
  },
};

let backend: MailBackend = realBackend;
/** Solo para pruebas. */
export const setMailBackend = (b: MailBackend | null) => { backend = b ?? realBackend; };

/** Si no se indicó el servidor SMTP se deduce del IMAP (imap.x.com → smtp.x.com). */
const cfgOf = (channel: Channel) => {
  const c = ChannelConfigSchemas.email.parse(channel.config ?? {}) as unknown as MailConfig;
  return { ...c, smtp_host: c.smtp_host || c.imap_host.replace(/^imap\./, 'smtp.') };
};

class EmailTransport implements Transport {
  private dispatchGuard?:()=>Promise<void>;
  setDispatchGuard(guard:()=>Promise<void>){this.dispatchGuard=guard;}
  kind = 'email' as const;
  private envelope: MailEnvelope | null = null;
  constructor(private channel: Channel, private to: string) {}

  setMailEnvelope(envelope: MailEnvelope) {
    this.envelope = envelope;
  }

  private async deliver(text: string, attachment?: OutMail['attachment']) {
    const cfg = cfgOf(this.channel);
    if (this.envelope) return this.deliverCampaign(cfg, this.envelope, text, attachment);
    const t = await queryOne<{ subject: string; message_id: string; refs: string }>(`SELECT subject, message_id, refs FROM email_threads WHERE channel_id = $1 AND address = $2`, [this.channel.id, this.to.toLowerCase()]);
    const base = (t?.subject || 'Tu consulta').trim();
    const subject = /^(re|rv):/i.test(base) ? base : `Re: ${base}`;
    const from = cfg.from_name ? `"${cfg.from_name.replace(/["\\\r\n<>]/g, '')}" <${addressOf(cfg)}>` : addressOf(cfg);
    if (!addressOf(cfg)) throw new Error('El canal de correo no tiene dirección de envío (falta EMAIL_INBOUND_DOMAIN en el servidor)');
    await this.dispatchGuard?.();
    const out: OutMail = { from, to: this.to, subject, text, inReplyTo: t?.message_id ?? '', references: [t?.refs, t?.message_id].filter(Boolean).join(' '), attachment };
    return cfg.mode === 'forward' ? sendViaResend(out) : backend.send(cfg, out);
  }

  /**
   * Correo de campaña: sale desde el subdominio de campañas con Reply-To a la dirección de reenvío, así la respuesta
   * llega a la conversación. Su asunto queda como el del hilo: el asistente contesta «Re: <asunto>».
   */
  private async deliverCampaign(cfg: MailConfig, env: MailEnvelope, text: string, attachment?: OutMail['attachment']) {
    const sender = campaignAddress(cfg.forward_alias);
    const replyTo = forwardAddress(cfg.forward_alias);
    if (cfg.mode !== 'forward' || !sender || !replyTo) throw new Error('Las campañas por correo necesitan un canal por reenvío y EMAIL_CAMPAIGN_DOMAIN en el servidor');
    const from = cfg.from_name ? `"${cfg.from_name.replace(/["\\\r\n<>]/g, '')}" <${sender}>` : sender;
    const subject = env.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    await this.dispatchGuard?.();
    const id = await sendViaResend({ from, to: this.to, subject, text, inReplyTo: '', references: '', attachment, replyTo, headers: env.headers, bulk: true });
    // Ya salió: si guardar el hilo falla, solo se anota (el correo no se marca como fallido ni se reenvía). Es un correo
    // nuevo, así que el hilo empieza de cero con su asunto.
    await query(
      `INSERT INTO email_threads (channel_id, address, subject, message_id, refs) VALUES ($1,$2,$3,'','')
       ON CONFLICT (channel_id, address) DO UPDATE SET subject = EXCLUDED.subject, message_id = '', refs = '', updated_at = now()`,
      [this.channel.id, this.to.toLowerCase(), subject],
    ).catch((e) => logEvent({ level: 'warn', source: 'channel', message: `No se guardó el hilo de la campaña: ${String(e?.message ?? e).slice(0, 200)}`, accountId: this.channel.account_id, channelId: this.channel.id }));
    return id;
  }

  async sendText(text: string) {
    return this.deliver(text);
  }

  async sendImage(image: ImageAsset, caption: string) {
    const file = imageAbsolutePath(image);
    await fs.access(file);
    return this.deliver(caption || image.name, { path: file, filename: `${image.code}.${image.mime_type.split('/')[1] ?? 'jpg'}` });
  }

  /** El correo admite cualquier archivo como adjunto. */
  async sendFile(file: OutgoingFile, caption: string) {
    await fs.access(file.absPath);
    return this.deliver(caption || file.name, { path: file.absPath, filename: file.name });
  }

  async notify() {
    throw new Error('El correo no envía avisos internos');
  }
}

/** Por reenvío: crea la dirección del canal (una sola vez) y explica a dónde reenviar. */
async function setupForward(channel: Channel, cfg: MailConfig) {
  if (!config.emailInbound.domain || !config.mail.resendApiKey) return { ok: false, message: 'El correo por reenvío aún no está disponible en este servidor. Pídele al administrador de la plataforma que lo active.' };
  const alias = cfg.forward_alias || newForwardAlias();
  return { ok: true, message: `Listo. Reenvía tu correo a ${forwardAddress(alias)} y el asistente contestará los mensajes nuevos.`, config: { forward_alias: alias } };
}

export const emailAdapter: ChannelAdapter = {
  type: 'email',
  label: 'Correo electrónico',
  configSchema: ChannelConfigSchemas.email,
  parse: () => ({ messages: [] }), // no hay webhook: se sondea
  transport: (channel, contact) => new EmailTransport(channel, contact.external_id),

  async setup(channel) {
    const cfg = cfgOf(channel);
    if (cfg.mode === 'forward') return setupForward(channel, cfg);
    if (!cfg.imap_host || !cfg.imap_user || !cfg.imap_password) return { ok: false, message: 'Completa el servidor, el usuario y la contraseña de correo' };
    try {
      await backend.verify(cfg);
    } catch (e: any) {
      return { ok: false, message: `No se pudo conectar: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    // Se parte desde ahora: el historial del buzón no se contesta.
    return { ok: true, message: `Correo ${addressOf(cfg)} conectado. Empezará a contestar los mensajes nuevos.`, config: { last_uid: 0, uid_validity: 0 } };
  },

  async status(channel) {
    const cfg = cfgOf(channel);
    if (cfg.mode === 'forward') return { state: cfg.forward_alias && forwardAddress(cfg.forward_alias) ? 'open' : 'not_configured', details: { forward_address: forwardAddress(cfg.forward_alias) } };
    if (!cfg.imap_host || !cfg.imap_password) return { state: 'not_configured' };
    return { state: (channel.config as any).last_error ? 'error' : 'open', details: { error: (channel.config as any).last_error ?? '' } };
  },
};

/** El primer valor de un encabezado que puede venir repetido. */
function firstHeader(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  if (first == null) return undefined;
  return typeof first === 'string' ? first : typeof (first as any).value === 'string' ? (first as any).value : String((first as any).text ?? first);
}

export function toInbound(m: RawMail, firstInThread: boolean): InboundMessage {
  // Lo que escribió la persona va al principio: lo citado de más abajo no se revisa (un correo llega a 10 MB).
  const head = m.text.slice(0, MAX_MAIL_TEXT);
  const body = clampInbound(stripQuoted(head) || head.trim());
  return {
    messageId: m.messageId,
    externalId: m.address,
    phone: '',
    displayName: m.name,
    fromMe: false,
    type: 'text',
    text: firstInThread && m.subject ? `[Asunto: ${m.subject}]\n${body}` : body,
    timestamp: Math.floor(m.date.getTime() / 1000),
  };
}

/** ¿El remitente está comprobado? Por reenvío, lo dice Resend (DMARC); por IMAP, el Authentication-Results del proveedor. */
function mailVerified(mail: RawMail, channel: Channel): boolean {
  if (mail.authentication) return mail.authentication.dmarc === 'pass';
  return senderVerified(mail.authResults, mail.address, trustedAuthServers(channel.config as any));
}

/**
 * Un correo nuevo de un canal (por IMAP o por reenvío): descarta automáticos y propios, frena bucles, guarda sin
 * contestar lo de remitentes sin comprobar y lo que pasa del tope por hora, y entrega lo demás al asistente.
 */
export async function processIncomingMail(channel: Channel, mail: RawMail, deliver: (m: InboundMessage) => Promise<void>) {
  const cfg = cfgOf(channel);
  if (mail.automated || ownAddresses(cfg).includes(mail.address)) return;
  // Freno de bucles: más de 12 correos por hora de la misma dirección no se contestan (ver abajo).
  const recent = (await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
      WHERE ct.channel_id = $1 AND ct.external_id = $2 AND m.direction = 'in' AND m.created_at > now() - interval '1 hour'`,
    [channel.id, mail.address],
  ))?.n ?? 0;
  if (recent >= 12) {
    // Freno de bucles: se guarda pero no se contesta (nada se pierde del historial del cliente).
    await deliver({ ...toInbound(mail, false), captureOnly: true });
    return;
  }
  // Remitente sin comprobar: cualquiera escribe «From: cliente@real.com». Se guarda marcado, sin contestar (IN-17).
  // Por reenvío siempre se comprueba: se responde desde el dominio compartido de la plataforma y un remitente falso
  // haría que se escriba a cualquier dirección en nombre del negocio.
  const checkSender = cfg.mode === 'forward' || (channel.config as any).require_sender_auth !== false;
  if (checkSender && !mailVerified(mail, channel)) {
    const msg = toInbound(mail, false);
    await deliver({ ...msg, text: `[Remitente no verificado] ${msg.text}`, captureOnly: true, held: 'remitente_no_verificado' });
    return;
  }
  // Tope del canal: más de 60 respuestas en una hora se guardan sin contestar, con un aviso (IN-17). Las respuestas a
  // una campaña llevan su propio tope, más alto.
  const campaignReply = !!(await queryOne(
    `SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
      WHERE ct.channel_id = $1 AND ct.external_id = $2 AND m.direction = 'out' AND m.meta->>'source' = 'campaign' AND m.created_at > now() - interval '30 days' LIMIT 1`,
    [channel.id, mail.address],
  ));
  const cap = campaignReply ? CAMPAIGN_REPLIES_PER_HOUR : EMAIL_REPLIES_PER_HOUR;
  const replies = await countHit(`${campaignReply ? 'email-campaign-replies' : 'email-replies'}:${channel.id}`, 3600_000);
  if (replies > cap) {
    if (replies === cap + 1) {
      await logEvent({ level: 'warn', source: 'channel', message: `El correo ${addressOf(cfg)} llegó a ${cap} respuestas en una hora: los demás correos se guardan sin contestar hasta la siguiente hora`, accountId: channel.account_id, channelId: channel.id });
      const admins = await query<{ id: string }>(`SELECT id FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [channel.account_id]);
      await notifyUsers(channel.account_id, admins.map((a) => a.id), { title: 'Tu correo contestó demasiados mensajes', body: `El asistente del correo ${addressOf(cfg)} contestó ${cap} correos en una hora. Los siguientes se guardan sin respuesta hasta la siguiente hora; revisa si hay correo masivo.`, link: '#/conversations', kind: 'channel' }).catch(() => undefined);
    }
    await deliver({ ...toInbound(mail, false), captureOnly: true, held: 'limite_del_canal' });
    return;
  }
  const prior = await queryOne(`SELECT 1 FROM email_threads WHERE channel_id = $1 AND address = $2`, [channel.id, mail.address]);
  await query(
    `INSERT INTO email_threads (channel_id, address, subject, message_id, refs) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel_id, address) DO UPDATE SET subject = EXCLUDED.subject, message_id = EXCLUDED.message_id, refs = EXCLUDED.refs, updated_at = now()`,
    [channel.id, mail.address, mail.subject.slice(0, 300), mail.messageId, mail.references.slice(-1500)],
  );
  await deliver(toInbound(mail, !prior));
}

/** Una pasada de lectura de un canal. Devuelve los mensajes ya normalizados; guarda el avance y el hilo. */
export async function pollEmailChannel(channel: Channel, deliver: (m: InboundMessage) => Promise<void>) {
  const cfg = cfgOf(channel);
  let error = '';
  try {
    const r = await backend.fetchNew(cfg);
    for (const mail of r.mails) {
      try {
        await processIncomingMail(channel, mail, deliver);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'channel', message: `Correo de ${mail.address}: ${String(e?.message ?? e).slice(0, 200)}`, accountId: channel.account_id, channelId: channel.id });
      }
    }
    await query(`UPDATE channels SET config = config || $2::jsonb WHERE id = $1`, [channel.id, JSON.stringify({ last_uid: r.lastUid, uid_validity: r.uidValidity, last_error: '' })]);
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 200);
    if (error !== (channel.config as any).last_error) {
      await logEvent({ level: 'warn', source: 'channel', message: `Correo (${addressOf(cfg)}): ${error}`, accountId: channel.account_id, channelId: channel.id });
      await query(`UPDATE channels SET config = config || $2::jsonb WHERE id = $1`, [channel.id, JSON.stringify({ last_error: error })]);
    }
  }
  return error;
}

export const newMessageId = () => `<${crypto.randomUUID()}@riverrun.local>`;

let polling = false;
/** Lee todos los canales de correo activos. Un canal que falla no detiene a los demás. */
export async function pollEmailChannels(service: Pick<ChatService, 'handleIncoming'>) {
  if (polling) return 0;
  polling = true;
  try {
    const rows = await query<Channel>(`SELECT ch.* FROM channels ch JOIN accounts a ON a.id = ch.account_id WHERE ch.type = 'email' AND ch.active AND a.active AND coalesce(ch.config->>'mode', 'imap') = 'imap' AND ch.config->>'imap_host' <> '' AND ch.config->>'imap_password' <> ''`);
    let n = 0;
    for (const ch of rows.map((r) => hydrateChannel(r)!)) await pollEmailChannel(ch, async (m) => { n++; await service.handleIncoming(ch, m); });
    return n;
  } finally {
    polling = false;
  }
}
