/**
 * Campañas por correo (docs/campanas-correo.md). Salen por la API de Resend desde <alias>@EMAIL_CAMPAIGN_DOMAIN, un
 * subdominio aparte del que contesta (EMAIL_INBOUND_DOMAIN), y con Reply-To a la dirección de reenvío del canal: la
 * respuesta del cliente cae en su conversación y la contesta el asistente.
 *
 * Lo que las mantiene fuera de spam y dentro de la ley:
 * - Enlace de baja en cada correo y cabeceras List-Unsubscribe y List-Unsubscribe-Post (baja de un clic, RFC 8058).
 * - Lista de bajas por negocio y por correo (email_suppressions): bajas, rebotes definitivos y quejas de spam.
 * - Calentamiento: un tope diario que sube con los días en que el negocio ya envió.
 * - Una campaña con muchos rebotes o quejas se detiene sola y avisa a los administradores.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { hmac, safeEqual } from '../secret.js';
import { notifyUsers } from '../automation/store.js';
import { clearHits, countHit } from '../identity/rate-limit.js';
import type { Channel } from '../types.js';

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sig = (contactId: string) => hmac(`email-unsubscribe:${contactId}`).slice(0, 32);

/** Enlace firmado de baja de un contacto (no caduca: un correo viejo debe seguir sirviendo para darse de baja). */
export const unsubscribeUrl = (contactId: string) => `${config.publicBaseUrl}/email/baja?c=${contactId}&s=${sig(contactId)}`;
export const unsubscribeOk = (contactId: string, s: string) => UUID.test(contactId) && !!s && safeEqual(s, sig(contactId));

/** Pie de baja de un correo de campaña (siempre va, aunque el negocio apague el pie de baja de WhatsApp). */
export function campaignFooter(lang: 'es' | 'en', url: string, business: string): string {
  return lang === 'en'
    ? `You're getting this email from ${business}. To stop receiving these emails, unsubscribe here: ${url}`
    : `Recibes este correo de ${business}. Para dejar de recibir estos correos, date de baja aquí: ${url}`;
}

/** Cabeceras de un correo de campaña: baja de un clic (Gmail y Yahoo la exigen a quien envía correos masivos). */
export const campaignHeaders = (url: string): Record<string, string> => ({
  'List-Unsubscribe': `<${url}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  // Pide a Outlook no mandar respuestas automáticas de «fuera de la oficina».
  'X-Auto-Response-Suppress': 'OOF, AutoReply',
});

/** Dirección desde la que sale una campaña del canal; vacía sin EMAIL_CAMPAIGN_DOMAIN. */
export const campaignAddress = (alias: string) => (alias && config.emailCampaigns.domain ? `${alias}@${config.emailCampaigns.domain}` : '');

/** Tope diario por día de envío: el primer día 50, y sube mientras el negocio sigue enviando. */
export const WARMUP_STEPS = [50, 100, 200, 400, 700, 1000, 1500, 2000, 3000, 5000];
export const warmupCap = (daysSent: number) => Math.min(config.emailCampaigns.dailyMax, WARMUP_STEPS[Math.min(Math.max(0, daysSent), WARMUP_STEPS.length - 1)] ?? config.emailCampaigns.dailyMax);

/** Tope de hoy para las campañas de correo de un negocio, según los días (antes de hoy) en que ya envió alguna. */
export async function emailDailyCap(accountId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(DISTINCT (r.sent_at AT TIME ZONE 'UTC')::date)::int AS n
       FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id JOIN channels ch ON ch.id = c.channel_id
      WHERE c.account_id = $1 AND ch.type = 'email' AND r.status = 'sent' AND r.sent_at < date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [accountId],
  );
  return warmupCap(row?.n ?? 0);
}

/** Por qué una campaña no puede salir por este canal de correo (vacío si puede). */
export function emailCampaignProblem(channel: Pick<Channel, 'config'>, c: { subject: string; kind: string; image_id?: string | null }): string {
  // Sin SESSION_SECRET los enlaces de baja dejarían de servir al reiniciar el servidor: no se envían campañas.
  if (!config.emailCampaigns.domain || !config.emailInbound.domain || !config.mail.resendApiKey || !config.sessionSecret) return 'Las campañas por correo aún no están disponibles en este servidor. Pídele al administrador de la plataforma que las active.';
  if ((channel.config as any).mode !== 'forward' || !(channel.config as any).forward_alias) return 'Las campañas por correo salen por un canal de correo por reenvío: conéctalo así en Canales.';
  if (c.kind !== 'message') return 'Por correo se envía un mensaje, no un flujo.';
  if (c.image_id) return 'Por correo la campaña va solo con texto: quita la foto.';
  if (!c.subject.trim()) return 'Escribe el asunto del correo.';
  return '';
}

/**
 * Pone una dirección en la lista de bajas del negocio y da de baja sus contactos de correo. Una queja de spam queda
 * como queja aunque antes fuera baja o rebote.
 */
export async function suppressAddress(accountId: string, address: string, reason: SuppressionReason, detail = '') {
  const a = address.trim().toLowerCase();
  if (!a) return;
  await query(
    `INSERT INTO email_suppressions (account_id, address, reason, detail) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, address) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail
       WHERE EXCLUDED.reason = 'complained' AND email_suppressions.reason <> 'complained'`,
    [accountId, a, reason, detail.slice(0, 300)],
  );
  await query(
    `UPDATE contacts ct SET opted_out = true, opted_out_at = COALESCE(ct.opted_out_at, now()), updated_at = now()
       FROM channels ch WHERE ch.id = ct.channel_id AND ch.type = 'email' AND ct.account_id = $1 AND lower(ct.external_id) = $2 AND NOT ct.opted_out`,
    [accountId, a],
  );
}

/** Por qué una dirección está en la lista de bajas del negocio (null si no está). */
export async function suppressionOf(accountId: string, address: string): Promise<SuppressionReason | null> {
  const row = await queryOne<{ reason: SuppressionReason }>(`SELECT reason FROM email_suppressions WHERE account_id = $1 AND address = $2`, [accountId, address.trim().toLowerCase()]);
  return row?.reason ?? null;
}

/**
 * El cliente pidió volver a recibir correos (escribió ALTA): sale de la lista si se había dado de baja. Un rebote o una
 * queja no se levantan así. Devuelve false si la dirección debe seguir fuera.
 */
export async function resumeAddress(accountId: string, address: string): Promise<boolean> {
  const reason = await suppressionOf(accountId, address);
  if (!reason) return true;
  if (reason !== 'unsubscribed') return false;
  await query(`DELETE FROM email_suppressions WHERE account_id = $1 AND address = $2 AND reason = 'unsubscribed'`, [accountId, address.trim().toLowerCase()]);
  return true;
}

/** Baja desde el enlace del correo. Devuelve false si el contacto ya no existe. */
export async function unsubscribeContact(contactId: string): Promise<boolean> {
  const ct = await queryOne<{ id: string; account_id: string; external_id: string; channel_id: string; type: string }>(
    `SELECT ct.id, ct.account_id, ct.external_id, ct.channel_id, ch.type FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id WHERE ct.id = $1`,
    [contactId],
  );
  if (!ct) return false;
  if (ct.type === 'email') await suppressAddress(ct.account_id, ct.external_id, 'unsubscribed', 'enlace de baja');
  else await query(`UPDATE contacts SET opted_out = true, opted_out_at = COALESCE(opted_out_at, now()), updated_at = now() WHERE id = $1`, [ct.id]);
  await logEvent({ level: 'info', source: 'channel', message: 'Un cliente se dio de baja de las campañas por correo', accountId: ct.account_id, channelId: ct.channel_id });
  return true;
}

/** Con al menos este número de enviados se revisan los rebotes y las quejas de la campaña. */
export const PAUSE_MIN_SENT = 100;
/** Más de 5 % de rebotes o 0.3 % de quejas detienen la campaña (los límites que piden Gmail y Yahoo). */
export const PAUSE_BOUNCE_RATE = 0.05;
export const PAUSE_COMPLAINT_RATE = 0.003;

export function shouldPause(stats: Record<string, number>): 'bounced' | 'complained' | null {
  const sent = stats.sent ?? 0;
  if (sent < PAUSE_MIN_SENT) return null;
  if ((stats.complained ?? 0) / sent > PAUSE_COMPLAINT_RATE) return 'complained';
  if ((stats.bounced ?? 0) / sent > PAUSE_BOUNCE_RATE) return 'bounced';
  return null;
}

export interface DeliveryHooks {
  /** Detiene la campaña (lo que queda pendiente ya no sale). */
  pauseCampaign(campaignId: string): Promise<void>;
}

export const DELIVERY_EVENTS = new Set(['email.bounced', 'email.complained']);

/**
 * Rebote o queja de un correo que enviamos (evento firmado de Resend). Un rebote temporal (buzón lleno, servidor caído)
 * no da de baja; uno definitivo y una queja sí. Si el correo era de una campaña, se suma a sus estadísticas y, si pasa
 * de los límites, la campaña se detiene.
 */
export async function handleDeliveryEvent(body: any, hooks: DeliveryHooks): Promise<void> {
  const type = String(body?.type ?? '');
  if (!DELIVERY_EVENTS.has(type)) return;
  const d = body.data ?? {};
  const emailId = String(d.email_id ?? '');
  if (!emailId) return;
  const sent = await queryOne<{ account_id: string; channel_id: string; address: string; campaign_id: string | null }>(
    `SELECT cv.account_id, cv.channel_id, ct.external_id AS address, m.meta->>'campaign_id' AS campaign_id
       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id JOIN channels ch ON ch.id = cv.channel_id
      WHERE m.external_message_id = $1 AND m.direction = 'out' AND ch.type = 'email' LIMIT 1`,
    [emailId],
  );
  if (!sent) {
    await logEvent({ level: 'info', source: 'webhook', message: 'Rebote o queja de un correo que no es de ninguna conversación', details: { type } });
    return;
  }
  const bounce = d.bounce ?? {};
  const soft = type === 'email.bounced' && /transient|temporary|soft/i.test(String(bounce.type ?? ''));
  // Resend reintenta el aviso si no respondimos a tiempo: se cuenta una sola vez.
  const key = `email-delivery:${type}:${emailId}`;
  if ((await countHit(key, 7 * 86400_000)) > 1) return;
  try {
    if (soft) {
      await logEvent({ level: 'info', source: 'channel', message: `Rebote temporal de ${sent.address}; se intentará en la siguiente campaña`, accountId: sent.account_id, channelId: sent.channel_id });
      return;
    }
    const reason: SuppressionReason = type === 'email.complained' ? 'complained' : 'bounced';
    await suppressAddress(sent.account_id, sent.address, reason, String(bounce.message ?? bounce.subType ?? '').slice(0, 300));
    await logEvent({ level: 'warn', source: 'channel', message: reason === 'complained' ? `${sent.address} marcó un correo como spam: ya no recibirá campañas` : `El correo ${sent.address} rebotó: ya no recibirá campañas`, accountId: sent.account_id, channelId: sent.channel_id });
    if (sent.campaign_id) await countAndMaybePause(sent.campaign_id, reason, hooks);
  } catch (e) {
    await clearHits(key);
    throw e;
  }
}

async function countAndMaybePause(campaignId: string, reason: 'bounced' | 'complained', hooks: DeliveryHooks) {
  const row = await queryOne<{ account_id: string; name: string; status: string; stats: Record<string, number> }>(
    `UPDATE campaigns SET stats = stats || jsonb_build_object($2::text, coalesce((stats->>$2)::int, 0) + 1), updated_at = now()
      WHERE id = $1 RETURNING account_id, name, status, stats`,
    [campaignId, reason],
  );
  if (!row || row.status !== 'sending') return;
  const why = shouldPause(row.stats);
  if (!why) return;
  await hooks.pauseCampaign(campaignId);
  const what = why === 'complained' ? 'demasiadas personas la marcaron como spam' : 'rebotaron demasiados correos';
  await logEvent({ level: 'warn', source: 'engine', message: `Campaña "${row.name}" detenida: ${what}`, accountId: row.account_id, details: { stats: row.stats } });
  const admins = await query<{ id: string }>(`SELECT id FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [row.account_id]);
  await notifyUsers(row.account_id, admins.map((a) => a.id), {
    title: 'Detuvimos tu campaña de correo',
    body: `La campaña "${row.name}" se detuvo porque ${what}. Así se protege la entrega de tus correos. Revisa de dónde salió la base antes de volver a enviar.`,
    link: `#/automation/campaigns/${campaignId}`, kind: 'channel',
  }).catch(() => undefined);
}
