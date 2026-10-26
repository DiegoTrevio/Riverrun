import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { logEvent } from './logs.js';
import { outboundAllowed } from './outbound-guard.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Nombre del remitente (la marca del cliente). La dirección sigue siendo la del servidor. */
  fromName?: string;
  /** Archivos adjuntos (p. ej. el PDF y el XML de una factura). */
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  /** A quién se responde (p. ej. quien escribió en el formulario de contacto). */
  replyTo?: string;
}

/** Correos enviados en memoria (solo sin SMTP: desarrollo y pruebas). */
export const outbox: Mail[] = [];

let transporter: Transporter | null | undefined;
function transport() {
  // Tiempos límite: un SMTP que no responde no debe detener a quien manda el correo (cobros, avisos, la cola).
  if (transporter === undefined) {
    transporter = config.mail.smtpUrl
      ? nodemailer.createTransport({ url: config.mail.smtpUrl, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 })
      : null;
  }
  return transporter;
}

export const mailEnabled = () => !!config.mail.smtpUrl;

/** "Mi Agencia <correo@dominio>": cambia solo el nombre, nunca la dirección (el SPF/DKIM es del servidor). */
export function fromFor(name?: string) {
  if (!name) return config.mail.from;
  const addr = /<([^>]+)>/.exec(config.mail.from)?.[1] ?? config.mail.from;
  return `"${name.replace(/["\\\r\n<>]/g, '')}" <${addr}>`;
}

/** Qué pasó con un correo: salió, no tocaba mandarlo (sin SMTP o en sandbox) o el servidor de correo falló. */
export type MailResult = 'sent' | 'skipped' | 'failed';

/**
 * Envía un correo de texto. Sin SMTP configurado, se guarda en el registro (para poder copiar el enlace en desarrollo).
 * Nunca lanza: un fallo de correo no debe romper el registro ni las tareas. Quien necesita saber si falló (para
 * reintentarlo) mira el resultado.
 */
export async function deliverMail(mail: Mail): Promise<MailResult> {
  // Sandbox: solo a destinos de prueba. El registro no incluye el destinatario ni el asunto (pueden llevar datos de clientes).
  if (!outboundAllowed(mail.to)) {
    await logEvent({ level: 'warn', source: 'system', message: 'Correo bloqueado (OUTBOUND_MODE=sandbox): el destino no está permitido' });
    return 'skipped';
  }
  const t = transport();
  if (!t) {
    outbox.push(mail);
    if (outbox.length > 100) outbox.shift();
    await logEvent({ level: 'info', source: 'system', message: `Correo (sin SMTP) para ${mail.to}: ${mail.subject}`, details: { text: mail.text } });
    return 'skipped';
  }
  try {
    await t.sendMail({ from: fromFor(mail.fromName), to: mail.to, subject: mail.subject, text: mail.text, attachments: mail.attachments, replyTo: mail.replyTo });
    return 'sent';
  } catch (e: any) {
    await logEvent({ level: 'error', source: 'system', message: `No se pudo enviar el correo a ${mail.to}: ${e?.message ?? e}` });
    return 'failed';
  }
}

/** Como `deliverMail`, pero solo dice si el correo salió. */
export async function sendMail(mail: Mail): Promise<boolean> {
  return (await deliverMail(mail)) === 'sent';
}
