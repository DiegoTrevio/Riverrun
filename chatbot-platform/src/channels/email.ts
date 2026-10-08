/**
 * Canal de correo: recibe por IMAP (sondeo cada minuto) y responde por SMTP en el mismo hilo.
 * Sirve con Gmail y Outlook (contraseña de aplicación) o cualquier proveedor. Los servidores de red interna
 * se rechazan para que un cliente no use el canal para explorar la red del servidor.
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
import { imageAbsolutePath, type Transport } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import { ChannelConfigSchemas, type Channel, type ImageAsset } from '../types.js';
import type { ChannelAdapter, InboundMessage } from './types.js';

export interface MailConfig {
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
}

export interface OutMail { from: string; to: string; subject: string; text: string; inReplyTo: string; references: string; attachment?: { path: string; filename: string } }

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

const addressOf = (c: MailConfig) => (c.from_address || c.imap_user).toLowerCase();

/** Límite del texto de un correo que se guarda (lo que no cabe se corta; el resto del hilo sigue en el correo). */
const MAX_MAIL_TEXT = 50_000;

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
              text: p.text || (typeof p.html === 'string' ? htmlToText(p.html) : ''),
              date: p.date ?? new Date(),
              references: [p.references].flat().filter(Boolean).join(' '),
              automated,
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
  kind = 'email' as const;
  constructor(private channel: Channel, private to: string) {}

  private async deliver(text: string, attachment?: OutMail['attachment']) {
    const cfg = cfgOf(this.channel);
    const t = await queryOne<{ subject: string; message_id: string; refs: string }>(`SELECT subject, message_id, refs FROM email_threads WHERE channel_id = $1 AND address = $2`, [this.channel.id, this.to.toLowerCase()]);
    const base = (t?.subject || 'Tu consulta').trim();
    const subject = /^(re|rv):/i.test(base) ? base : `Re: ${base}`;
    const from = cfg.from_name ? `"${cfg.from_name.replace(/["\\\r\n<>]/g, '')}" <${addressOf(cfg)}>` : addressOf(cfg);
    return backend.send(cfg, { from, to: this.to, subject, text, inReplyTo: t?.message_id ?? '', references: [t?.refs, t?.message_id].filter(Boolean).join(' '), attachment });
  }

  async sendText(text: string) {
    return this.deliver(text);
  }

  async sendImage(image: ImageAsset, caption: string) {
    const file = imageAbsolutePath(image);
    await fs.access(file);
    return this.deliver(caption || image.name, { path: file, filename: `${image.code}.${image.mime_type.split('/')[1] ?? 'jpg'}` });
  }

  async notify() {
    throw new Error('El correo no envía avisos internos');
  }
}

export const emailAdapter: ChannelAdapter = {
  type: 'email',
  label: 'Correo electrónico',
  configSchema: ChannelConfigSchemas.email,
  parse: () => ({ messages: [] }), // no hay webhook: se sondea
  transport: (channel, contact) => new EmailTransport(channel, contact.external_id),

  async setup(channel) {
    const cfg = cfgOf(channel);
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
    if (!cfg.imap_host || !cfg.imap_password) return { state: 'not_configured' };
    return { state: (channel.config as any).last_error ? 'error' : 'open', details: { error: (channel.config as any).last_error ?? '' } };
  },
};

export function toInbound(m: RawMail, firstInThread: boolean): InboundMessage {
  const body = stripQuoted(m.text) || m.text.trim().slice(0, MAX_MAIL_TEXT);
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

/** Una pasada de lectura de un canal. Devuelve los mensajes ya normalizados; guarda el avance y el hilo. */
export async function pollEmailChannel(channel: Channel, deliver: (m: InboundMessage) => Promise<void>) {
  const cfg = cfgOf(channel);
  let error = '';
  try {
    const r = await backend.fetchNew(cfg);
    for (const mail of r.mails) {
      try {
        const own = mail.address === addressOf(cfg);
        if (mail.automated || own) continue;
        // Freno de bucles: más de 12 correos por hora de la misma dirección no se contestan (ver abajo).
        const recent = (await queryOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
            WHERE ct.channel_id = $1 AND ct.external_id = $2 AND m.direction = 'in' AND m.created_at > now() - interval '1 hour'`,
          [channel.id, mail.address],
        ))?.n ?? 0;
        if (recent >= 12) {
          // Freno de bucles: se guarda pero no se contesta (nada se pierde del historial del cliente).
          await deliver({ ...toInbound(mail, false), captureOnly: true });
          continue;
        }
        const prior = await queryOne(`SELECT 1 FROM email_threads WHERE channel_id = $1 AND address = $2`, [channel.id, mail.address]);
        await query(
          `INSERT INTO email_threads (channel_id, address, subject, message_id, refs) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (channel_id, address) DO UPDATE SET subject = EXCLUDED.subject, message_id = EXCLUDED.message_id, refs = EXCLUDED.refs, updated_at = now()`,
          [channel.id, mail.address, mail.subject.slice(0, 300), mail.messageId, mail.references.slice(-1500)],
        );
        await deliver(toInbound(mail, !prior));
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
    const rows = await query<Channel>(`SELECT ch.* FROM channels ch JOIN accounts a ON a.id = ch.account_id WHERE ch.type = 'email' AND ch.active AND a.active AND ch.config->>'imap_host' <> '' AND ch.config->>'imap_password' <> ''`);
    let n = 0;
    for (const ch of rows) await pollEmailChannel(ch, async (m) => { n++; await service.handleIncoming(ch, m); });
    return n;
  } finally {
    polling = false;
  }
}
