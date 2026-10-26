/**
 * Correos que no deben perderse si el servidor de correo falla un momento (avisos de prueba y de cobro): si el envío
 * falla, quedan como trabajo `mail_retry` y el scheduler los reintenta con espera (hasta 3 intentos). La marca de
 * «ya avisado» de quien lo manda no se toca, así el aviso en el panel no se repite; solo se reintenta el correo.
 */
import { scheduleJob } from './automation/store.js';
import { logEvent } from './logs.js';
import { deliverMail, type Mail, type MailResult } from './mailer.js';

type RetryMail = Pick<Mail, 'to' | 'subject' | 'text' | 'fromName' | 'replyTo'>;

/** Manda el correo y, si el servidor de correo falla, lo deja para reintentarlo. Sin SMTP o en sandbox, no se reintenta. */
export async function sendMailDurable(mail: RetryMail, accountId: string | null): Promise<MailResult> {
  const r = await deliverMail(mail);
  if (r === 'failed') {
    // Si ni siquiera se puede guardar el reintento, se registra y sigue: quien manda el correo no debe caerse por esto.
    await scheduleJob({ account_id: accountId, type: 'mail_retry', payload: { mail }, run_at: new Date(Date.now() + 60_000) })
      .catch((e) => logEvent({ level: 'error', source: 'system', message: `No se pudo guardar el reintento del correo «${mail.subject}»: ${e?.message ?? e}`, accountId }));
  }
  return r;
}

/** Trabajo `mail_retry`: si vuelve a fallar, lanza para que el scheduler lo reintente más tarde. */
export async function runMailRetry(payload: Record<string, any>) {
  const mail = payload.mail as RetryMail | undefined;
  if (!mail?.to) return;
  if ((await deliverMail(mail)) === 'failed') throw new Error(`El servidor de correo sigue fallando (${mail.subject})`);
}
