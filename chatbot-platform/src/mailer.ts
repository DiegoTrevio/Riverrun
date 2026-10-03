import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { logEvent } from './logs.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Correos enviados en memoria (solo sin SMTP: desarrollo y pruebas). */
export const outbox: Mail[] = [];

let transporter: Transporter | null | undefined;
function transport() {
  if (transporter === undefined) transporter = config.mail.smtpUrl ? nodemailer.createTransport(config.mail.smtpUrl) : null;
  return transporter;
}

export const mailEnabled = () => !!config.mail.smtpUrl;

/**
 * Envía un correo de texto. Sin SMTP configurado, se guarda en el registro (para poder copiar el enlace en desarrollo).
 * Nunca lanza: un fallo de correo no debe romper el registro ni las tareas.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  const t = transport();
  if (!t) {
    outbox.push(mail);
    if (outbox.length > 100) outbox.shift();
    await logEvent({ level: 'info', source: 'system', message: `Correo (sin SMTP) para ${mail.to}: ${mail.subject}`, details: { text: mail.text } });
    return false;
  }
  try {
    await t.sendMail({ from: config.mail.from, to: mail.to, subject: mail.subject, text: mail.text });
    return true;
  } catch (e: any) {
    await logEvent({ level: 'error', source: 'system', message: `No se pudo enviar el correo a ${mail.to}: ${e?.message ?? e}` });
    return false;
  }
}
