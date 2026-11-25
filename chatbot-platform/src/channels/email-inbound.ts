/**
 * Canal de correo por reenvío (Resend). El negocio reenvía su correo a <alias>@EMAIL_INBOUND_DOMAIN; Resend lo recibe y
 * avisa a /email/resend con un evento firmado (Svix) que solo trae los datos del correo. El texto y el resultado de
 * SPF/DKIM/DMARC (calculado por el servidor de Resend: el remitente no puede falsearlo) se piden a su API. Las respuestas
 * salen por la API HTTPS de Resend: no usan los puertos de SMTP que DigitalOcean bloquea.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { htmlToText } from '../knowledge-import.js';
import { logEvent } from '../logs.js';
import { notifyUsers } from '../automation/store.js';
import { hydrateChannel } from '../store/index.js';
import { clearHits, countHit } from '../identity/rate-limit.js';
import type { Channel } from '../types.js';
import type { MailAuthentication, OutMail, RawMail } from './email.js';
import { resendTurn } from './resend-pace.js';

const RESEND_API = 'https://api.resend.com';
/** Un aviso firmado hace más de 5 minutos (o en el futuro) se rechaza: así no se puede repetir uno viejo. */
const SIGNATURE_TOLERANCE_S = 5 * 60;
const MAX_MAIL_HTML = 2 * 1024 * 1024;
const AUTH_VALUES = ['pass', 'fail', 'gray', 'processing_failed', 'unknown'] as const;

/** Lo que devuelve GET /emails/receiving/{id} (solo lo que se usa). */
export interface ReceivedEmail {
  id: string;
  from: string;
  to?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  message_id?: string;
  created_at?: string;
  headers?: Record<string, unknown> | { name: string; value: string }[];
  authentication?: Partial<Record<'spf' | 'dkim' | 'dmarc', string>> | null;
}

export interface ResendBackend {
  getReceived(id: string): Promise<ReceivedEmail>;
  send(payload: Record<string, unknown>): Promise<string>;
}

async function resendFetch(path: string, init: RequestInit = {}): Promise<any> {
  if (!config.mail.resendApiKey) throw new Error('Falta RESEND_API_KEY en el servidor');
  const res = await fetch(`${RESEND_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend respondió ${res.status}: ${String(body?.message ?? body?.name ?? '').slice(0, 200)}`);
  return body;
}

const realBackend: ResendBackend = {
  getReceived: (id) => resendFetch(`/emails/receiving/${encodeURIComponent(id)}`),
  async send(payload) {
    const r = await resendFetch('/emails', { method: 'POST', body: JSON.stringify(payload) });
    return String(r?.id ?? '');
  },
};

let backend: ResendBackend = realBackend;
/** Solo para pruebas. */
export const setResendBackend = (b: ResendBackend | null) => { backend = b ?? realBackend; };

/**
 * Firma de Svix (la que usa Resend): HMAC-SHA256 de «id.timestamp.cuerpo» con el secreto (whsec_ + base64). El
 * encabezado svix-signature puede traer varias firmas separadas por espacio («v1,<base64>»); basta una válida.
 */
export function verifyResendSignature(headers: Record<string, unknown>, rawBody: Buffer | undefined, secret: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const id = String(headers['svix-id'] ?? '');
  const ts = String(headers['svix-timestamp'] ?? '');
  const sigs = String(headers['svix-signature'] ?? '');
  if (!secret || !rawBody || !id || !/^\d+$/.test(ts) || !sigs) return false;
  if (Math.abs(nowS - Number(ts)) > SIGNATURE_TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.`).update(rawBody).digest();
  return sigs.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const got = Buffer.from(value, 'base64');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

/** Parte antes de la @ de una dirección de reenvío: una letra y 16 hexadecimales (la genera el sistema). */
export const newForwardAlias = () => `c${crypto.randomBytes(8).toString('hex')}`;

/** Dirección de reenvío de un canal; vacía si el servidor no tiene EMAIL_INBOUND_DOMAIN. */
export const forwardAddress = (alias: string) => (alias && config.emailInbound.domain ? `${alias}@${config.emailInbound.domain}` : '');

const PLAIN_ADDRESS = /^[^\s@<>",;]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** «Nombre <correo@x.com>» → { address, name }. Algo que no es una sola dirección válida deja address vacío. */
export function parseAddress(v: string): { address: string; name: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
  const address = (m ? m[2] : v).trim().toLowerCase();
  return { address: PLAIN_ADDRESS.test(address) ? address : '', name: m ? m[1].trim().slice(0, 200) : '' };
}

/** Un encabezado que sale en la respuesta: sin saltos de línea y con tope. */
const oneLine = (v: string, max = 2000) => v.replace(/[\r\n]+/g, ' ').slice(0, max);

/**
 * Alias de los destinatarios que son de nuestro dominio de reenvío o del de campañas (quien contesta una campaña sin
 * respetar el Reply-To le escribe al remitente de la campaña).
 */
export function aliasesIn(addresses: unknown[]): string[] {
  const domain = config.emailInbound.domain;
  if (!domain) return [];
  const domains = [domain, config.emailCampaigns.domain].filter(Boolean);
  const out = new Set<string>();
  for (const a of addresses) {
    const { address } = parseAddress(String(a ?? ''));
    const [local, host] = address.split('@');
    if (domains.includes(host) && /^[a-z0-9]{4,40}$/.test(local ?? '')) out.add(local);
  }
  return [...out];
}

/** Valor de un encabezado sin importar mayúsculas. Resend los da como objeto; también se acepta una lista de {name, value}. */
function header(h: unknown, name: string): string {
  if (!h || typeof h !== 'object') return '';
  if (Array.isArray(h)) {
    const item = h.find((x: any) => String(x?.name ?? '').toLowerCase() === name);
    return item ? String((item as any).value ?? '') : '';
  }
  const rec = h as Record<string, unknown>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v);
}

const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce|alerts?)[+@._-]/i;

function authOf(a: ReceivedEmail['authentication']): MailAuthentication | undefined {
  if (!a) return undefined;
  const pick = (v: unknown) => ((AUTH_VALUES as readonly string[]).includes(String(v)) ? String(v) : 'unknown') as MailAuthentication['dmarc'];
  return { spf: pick(a.spf), dkim: pick(a.dkim), dmarc: pick(a.dmarc) };
}

/** El correo de Resend en el formato que ya usa el canal (pasa por los mismos filtros que la lectura por IMAP). */
export function receivedToRaw(e: ReceivedEmail): RawMail {
  const from = parseAddress(e.from ?? '');
  const h = e.headers;
  const auto = header(h, 'auto-submitted');
  const automated = (!!auto && auto !== 'no') || /bulk|junk|list/i.test(header(h, 'precedence')) || !!header(h, 'list-id') || !!header(h, 'x-auto-response-suppress') || AUTOMATED_SENDER.test(from.address);
  return {
    uid: 0,
    messageId: e.message_id || `<resend-${e.id}@resend>`,
    address: from.address,
    name: from.name,
    subject: e.subject ?? '',
    text: e.text || (typeof e.html === 'string' ? htmlToText(e.html.slice(0, MAX_MAIL_HTML)) : ''),
    date: e.created_at ? new Date(e.created_at) : new Date(),
    references: [header(h, 'references'), header(h, 'in-reply-to')].filter(Boolean).join(' '),
    automated,
    authentication: authOf(e.authentication),
  };
}

/** Correo con el que Gmail pide confirmar el reenvío: de forwarding-noreply@google.com y comprobado (DMARC). */
export const isForwardingConfirmation = (m: Pick<RawMail, 'address' | 'authentication'>) =>
  m.address === 'forwarding-noreply@google.com' && m.authentication?.dmarc === 'pass';

/** Guarda el correo de confirmación para mostrarlo en el panel y avisa a los administradores. */
async function saveForwardingConfirmation(channel: Channel, m: RawMail) {
  const code = /\b(\d{6,12})\b/.exec(`${m.subject} ${m.text}`)?.[1] ?? '';
  const link = /https:\/\/mail(-settings)?\.google\.com\/[^\s)>"]+/.exec(m.text)?.[0] ?? '';
  // Solo el código y el enlace de Google: nunca texto libre del correo.
  const summary = [code && `Código: ${code}`, link && `Enlace: ${link}`].filter(Boolean).join('\n');
  if (!summary || summary === channel.config.forward_confirmation) return;
  await query(`UPDATE channels SET config = config || $2::jsonb WHERE id = $1`, [channel.id, JSON.stringify({ forward_confirmation: summary.slice(0, 1000) })]);
  const admins = await query<{ id: string }>(`SELECT id FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [channel.account_id]);
  await notifyUsers(channel.account_id, admins.map((a) => a.id), {
    title: 'Confirma el reenvío de tu correo',
    body: code ? `Gmail pide confirmar el reenvío. Tu código es ${code}; también lo ves en Canales → ${channel.name}.` : `Gmail pide confirmar el reenvío; lo ves en Canales → ${channel.name}.`,
    link: '#/channels', kind: 'channel',
  }).catch((e) => logEvent({ level: 'warn', source: 'channel', message: `No se pudo avisar de la confirmación de reenvío: ${String(e?.message ?? e).slice(0, 200)}`, accountId: channel.account_id, channelId: channel.id }));
  await logEvent({ level: 'info', source: 'channel', message: 'Llegó la confirmación de reenvío de Gmail', accountId: channel.account_id, channelId: channel.id });
}

/** ¿Ya se guardó este correo en el canal? Resend reintenta un aviso si no respondimos a tiempo. */
async function alreadyReceived(channelId: string, address: string, messageId: string): Promise<boolean> {
  return !!(await queryOne(
    `SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
      WHERE ct.channel_id = $1 AND ct.external_id = $2 AND m.direction = 'in' AND m.external_message_id = $3 LIMIT 1`,
    [channelId, address, messageId],
  ));
}

export type MailProcessor = (channel: Channel, mail: RawMail) => Promise<void>;

/**
 * Un evento de Resend ya firmado. Termina sin error si se procesó o no es para ningún canal (Resend no debe
 * reintentarlo); lanza si algo falló de nuestro lado (la ruta responde 503 y Resend lo reintenta).
 */
export async function handleResendEvent(body: any, process: MailProcessor): Promise<void> {
  if (body?.type !== 'email.received') return;
  const d = body.data ?? {};
  // Solo los destinatarios del sobre: un remitente puede poner en Cc las direcciones de otros canales.
  const aliases = aliasesIn([...(d.to ?? []), ...(d.received_for ?? [])]);
  if (!aliases.length || !d.email_id) return;
  const rows = await query<Channel>(
    `SELECT ch.* FROM channels ch JOIN accounts a ON a.id = ch.account_id
      WHERE ch.type = 'email' AND ch.active AND a.active AND ch.config->>'mode' = 'forward' AND ch.config->>'forward_alias' = ANY($1::text[])`,
    [aliases],
  );
  if (!rows.length) {
    await logEvent({ level: 'info', source: 'webhook', message: 'Correo para una dirección de reenvío que no es de ningún canal activo', details: { count: aliases.length } });
    return;
  }
  const mail = receivedToRaw(await backend.getReceived(String(d.email_id)));
  if (!mail.address) {
    await logEvent({ level: 'warn', source: 'webhook', message: 'Correo reenviado con un remitente que no es una dirección válida; se omite' });
    return;
  }
  // Cada canal por separado: uno que falla no bloquea a los demás; si falló alguno, se pide reintento (los que ya
  // terminaron no se repiten).
  let failed: unknown = null;
  for (const channel of rows.map((r) => hydrateChannel(r)!)) {
    try {
      if (isForwardingConfirmation(mail)) await saveForwardingConfirmation(channel, mail);
      else await processOnce(channel, mail, process);
    } catch (e: any) {
      failed = e;
      await logEvent({ level: 'error', source: 'channel', message: `Correo reenviado de ${mail.address}: ${String(e?.message ?? e).slice(0, 200)}`, accountId: channel.account_id, channelId: channel.id });
    }
  }
  if (failed) throw failed;
}

/** Ventana en la que un mismo correo se toma una sola vez (dos avisos de Resend a la vez no lo contestan dos veces). */
const CLAIM_MS = 15 * 60_000;

/** Procesa un correo una sola vez por canal: lo reclama primero; si falla, suelta el reclamo para que el reintento entre. */
async function processOnce(channel: Channel, mail: RawMail, process: MailProcessor) {
  const key = `email-in:${channel.id}:${crypto.createHash('sha256').update(`${mail.address}|${mail.messageId}`).digest('hex')}`;
  if ((await countHit(key, CLAIM_MS)) > 1) return;
  if (await alreadyReceived(channel.id, mail.address, mail.messageId)) return;
  try {
    await process(channel, mail);
  } catch (e) {
    await clearHits(key);
    throw e;
  }
}

/** Envía una respuesta del canal por la API de Resend, desde su dirección de reenvío. */
export async function sendViaResend(mail: OutMail): Promise<string> {
  const attachments = mail.attachment
    ? [{ filename: mail.attachment.filename, content: (await fs.readFile(mail.attachment.path)).toString('base64') }]
    : undefined;
  // Una respuesta lleva Auto-Submitted (evita bucles con otros contestadores); una campaña no, pero sí sus cabeceras de baja.
  const headers: Record<string, string> = mail.bulk ? {} : { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' };
  for (const [k, v] of Object.entries(mail.headers ?? {})) if (/^[A-Za-z0-9-]{1,60}$/.test(k)) headers[k] = oneLine(v);
  if (mail.inReplyTo) headers['In-Reply-To'] = oneLine(mail.inReplyTo, 500);
  if (mail.references) headers.References = oneLine(mail.references);
  await resendTurn();
  return backend.send({ from: mail.from, to: [mail.to], subject: oneLine(mail.subject, 300), text: mail.text, headers, attachments, ...(mail.replyTo ? { reply_to: [oneLine(mail.replyTo, 300)] } : {}) });
}
