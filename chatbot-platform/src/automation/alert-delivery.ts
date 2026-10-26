/**
 * Entrega de los avisos al equipo por WhatsApp y correo. Cada entrega queda registrada (alert_receipts) con su resultado:
 * - si falla, se reintenta sola (1, 5 y 15 minutos después; al cuarto intento queda como fallida);
 * - en los avisos urgentes, si el primer intento falla, el aviso sale también por el otro canal de esa persona;
 * - si a una persona no le llega por ningún lado, su aviso del panel lo dice y los administradores se enteran.
 * El panel muestra qué llegó y qué no (Notificaciones), y un administrador puede reintentar.
 */
import crypto from 'node:crypto';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { deliverMail } from '../mailer.js';
import { OutboundBlockedError } from '../outbound-guard.js';
import { IMPORTANT_KINDS } from './alert-groups.js';
import { claimAlertDeliveries, notifyUsers, teamMembers } from './store.js';

/** Los importantes llevan respaldo entre canales (ver IMPORTANT_KINDS). */
export const isImportantAlert = (kind: string | undefined) => IMPORTANT_KINDS.includes(kind ?? '');

/** Minutos de espera después de cada intento fallido; al agotarse, la entrega queda como fallida. */
const BACKOFF_MIN = [1, 5, 15];
export const MAX_ALERT_ATTEMPTS = BACKOFF_MIN.length + 1;
/** Minutos que se reserva una entrega mientras se intenta (si el proceso muere, otra revisión la retoma). */
const LEASE_MIN = 2;
const UNDELIVERED_NOTE = '⚠️ No se pudo entregar por WhatsApp ni por correo.';

/** `excludeChannelId`: el WhatsApp que no se usa para mandarlo (p. ej. el que se acaba de desconectar). */
export interface AlertPayload { title: string; body: string; url?: string; excludeChannelId?: string }
export interface Receipt {
  id: string;
  account_id: string;
  notification_id: string | null;
  user_id: string | null;
  alert_key: string;
  kind: string;
  channel: 'whatsapp' | 'email';
  destination: string;
  payload: AlertPayload;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  last_error: string;
  fallback_of: string | null;
}

type WhatsappSender = (accountId: string, phone: string, text: string, excludeChannelId?: string) => Promise<void>;
let sendWhatsapp: WhatsappSender = async () => { throw new Error('El WhatsApp de avisos no está configurado'); };
/** El servicio dice cómo mandar un WhatsApp interno (por un WhatsApp conectado de la cuenta). */
export function configureAlertDelivery(o: { sendWhatsapp: WhatsappSender }) {
  sendWhatsapp = o.sendWhatsapp;
}

/** No toca mandarlo por ese canal (sin servidor de correo, o el destino no está permitido en sandbox): no se reintenta. */
class SkipDelivery extends Error {}

export const newAlertKey = () => crypto.randomUUID();
const whatsappText = (p: AlertPayload) => `*${p.title}*\n${p.body}${p.url ? `\n${p.url}` : ''}`;
const emailSubject = (p: AlertPayload) => p.title.replace(/^[^\p{L}\p{N}]+/u, '');

/** Registra una entrega. Queda reservada unos minutos para quien la va a intentar enseguida. */
export async function queueDelivery(d: { accountId: string; notificationId?: string | null; userId?: string | null; alertKey: string; kind?: string; channel: 'whatsapp' | 'email'; destination: string; payload: AlertPayload; fallbackOf?: string | null }) {
  return (await queryOne<Receipt>(
    `INSERT INTO alert_receipts (account_id, notification_id, user_id, alert_key, kind, channel, destination, payload, fallback_of, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(mins => $10)) RETURNING *`,
    [d.accountId, d.notificationId ?? null, d.userId ?? null, d.alertKey, d.kind ?? 'alert', d.channel, d.destination, JSON.stringify(d.payload), d.fallbackOf ?? null, LEASE_MIN],
  ))!;
}

/** Intenta una entrega y anota el resultado. Nunca lanza: lo que falla queda para reintentarse. */
export async function attemptDelivery(r: Receipt): Promise<Receipt['status']> {
  const attempts = r.attempts + 1;
  let failure: any = null;
  try {
    if (r.channel === 'whatsapp') {
      await sendWhatsapp(r.account_id, r.destination, whatsappText(r.payload), r.payload.excludeChannelId);
    } else {
      const res = await deliverMail({ to: r.destination, subject: emailSubject(r.payload), text: `${r.payload.body}${r.payload.url ? `\n${r.payload.url}` : ''}` });
      if (res === 'skipped') throw new SkipDelivery('no hay servidor de correo configurado (o el destino no está permitido)');
      if (res === 'failed') throw new Error('el servidor de correo no lo aceptó');
    }
  } catch (e) {
    failure = e;
  }
  // Solo anota quien tiene la reserva: si este intento tardó de más y otra revisión la retomó, el resultado es de esa.
  // Si anotar falla (la base no responde), la entrega sigue pendiente y se retoma al vencer la reserva.
  try {
    return await recordAttempt(r, attempts, failure);
  } catch (e: any) {
    await logEvent({ level: 'error', source: 'channel', message: `No se pudo anotar el resultado de un aviso: ${e?.message ?? e}`, accountId: r.account_id, details: { receipt_id: r.id } }).catch(() => undefined);
    return failure ? 'pending' : 'sent';
  }
}

async function recordAttempt(r: Receipt, attempts: number, failure: any): Promise<Receipt['status']> {
  const mine = `id = $1 AND status = 'pending' AND attempts = $2`;
  if (!failure) {
    await query(`UPDATE alert_receipts SET status = 'sent', attempts = $3, sent_at = now(), last_error = '' WHERE ${mine}`, [r.id, r.attempts, attempts]);
    return 'sent';
  }
  const skipped = failure instanceof SkipDelivery || failure instanceof OutboundBlockedError;
  const final = skipped || attempts >= MAX_ALERT_ATTEMPTS;
  const status: Receipt['status'] = final ? (skipped ? 'skipped' : 'failed') : 'pending';
  const error = String(failure?.message ?? failure).slice(0, 500);
  const updated = await queryOne(
    `UPDATE alert_receipts SET status = $3, attempts = $4, last_error = $5, next_attempt_at = now() + make_interval(mins => $6) WHERE ${mine} RETURNING id`,
    [r.id, r.attempts, status, attempts, error, BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]],
  );
  if (!updated) return status;
  const now = { ...r, attempts, status, last_error: error };
  if (attempts === 1 || final) {
    await logEvent({ level: final ? 'error' : 'warn', source: 'channel', message: `Aviso no entregado por ${r.channel === 'whatsapp' ? 'WhatsApp' : 'correo'} a ${r.destination}${final ? '' : ' (se reintenta)'}: ${error}`, accountId: r.account_id, details: { receipt_id: r.id, kind: r.kind } });
  }
  // Lo urgente no espera los reintentos: sale también por el otro canal.
  if (attempts === 1) await addFallback(now).catch((err) => logEvent({ level: 'error', source: 'channel', message: `No se pudo preparar el respaldo de un aviso: ${err?.message ?? err}`, accountId: r.account_id }));
  if (final) await checkUndelivered(now).catch((err) => logEvent({ level: 'error', source: 'channel', message: `No se pudo revisar un aviso sin entregar: ${err?.message ?? err}`, accountId: r.account_id }));
  return status;
}

/** Respaldo de un aviso urgente: el mismo aviso por el otro canal de la persona (si lo tiene y no lo está recibiendo ya). */
async function addFallback(r: Receipt) {
  if (!r.user_id || r.fallback_of || !isImportantAlert(r.kind)) return;
  const u = await queryOne<{ email: string; phone: string; notify_whatsapp: boolean; active: boolean }>(`SELECT email, phone, notify_whatsapp, active FROM users WHERE id = $1`, [r.user_id]);
  if (!u?.active) return;
  const channel = r.channel === 'whatsapp' ? 'email' : 'whatsapp';
  const destination = channel === 'email' ? u.email : u.notify_whatsapp ? u.phone.replace(/\D/g, '') : '';
  if (!destination) {
    // Sin otro canal: si esta era la única vía, ya no hay a dónde mandarlo (solo queda el panel).
    if (r.status !== 'pending') await checkUndelivered(r);
    return;
  }
  const already = await queryOne(`SELECT 1 FROM alert_receipts WHERE alert_key = $1 AND user_id = $2 AND channel = $3`, [r.alert_key, r.user_id, channel]);
  if (already) return;
  const fb = await queueDelivery({ accountId: r.account_id, notificationId: r.notification_id, userId: r.user_id, alertKey: r.alert_key, kind: r.kind, channel, destination, payload: r.payload, fallbackOf: r.id });
  await attemptDelivery(fb);
}

/**
 * Una entrega se dio por perdida: si a esa persona ya no le va a llegar por ningún canal, su aviso del panel lo dice y
 * los administradores se enteran (una vez al día por persona) para revisar su teléfono o su correo.
 */
async function checkUndelivered(r: Receipt) {
  if (!r.user_id) return;
  // Perdido de verdad: nada pendiente ni entregado y al menos un envío que falló (solo omitido, p. ej. sin servidor de
  // correo, no cuenta: el panel sigue siendo su vía).
  const s = await queryOne<{ alive: boolean; failed: boolean }>(
    `SELECT bool_or(status IN ('pending', 'sent')) AS alive, bool_or(status = 'failed') AS failed FROM alert_receipts WHERE alert_key = $1 AND user_id = $2`,
    [r.alert_key, r.user_id]);
  if (s?.alive || !s?.failed) return;
  if (r.notification_id) {
    await query(`UPDATE notifications SET body = left(body || E'\\n\\n' || $2, 2100) WHERE id = $1 AND position($2 in body) = 0`, [r.notification_id, UNDELIVERED_NOTE]);
  }
  // Sin aviso en el panel, o urgente: alguien tiene que saberlo.
  if (r.notification_id && !isImportantAlert(r.kind)) return;
  const day = new Date().toISOString().slice(0, 10);
  if (!(await claimAlertDeliveries([r.user_id], 'undelivered', '#/notifications', day, 24 * 60)).size) return;
  const who = await queryOne<{ name: string; email: string }>(`SELECT name, email FROM users WHERE id = $1`, [r.user_id]);
  const admins = (await teamMembers(r.account_id, ['admin'])).map((a) => a.id);
  await notifyUsers(r.account_id, admins, {
    title: `⚠️ Un aviso no le llegó a ${who?.name || who?.email || 'una persona del equipo'}`,
    body: `«${r.payload.title}» no se pudo entregar por WhatsApp ni por correo (${r.last_error || 'falló el envío'}). Revisa su teléfono y su correo en Mi equipo; en Notificaciones puedes reintentarlo.`,
    link: '#/notifications',
    kind: 'alert',
  });
}

/** Revisión periódica: reintenta las entregas pendientes cuyo turno llegó, una a la vez. */
export async function processAlertReceipts(limit = 20) {
  let done = 0;
  while (done < limit) {
    const r = await queryOne<Receipt>(
      `UPDATE alert_receipts SET next_attempt_at = now() + make_interval(mins => $1)
       WHERE id = (SELECT id FROM alert_receipts WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [LEASE_MIN],
    );
    if (!r) break;
    await attemptDelivery(r);
    done++;
  }
  return done;
}

/** Reintento pedido desde el panel: empieza de nuevo (con sus intentos). Devuelve el resultado, o null si no es de la cuenta. */
export async function retryDelivery(id: string, accountId: string) {
  const r = await queryOne<Receipt>(
    `UPDATE alert_receipts SET status = 'pending', attempts = 0, next_attempt_at = now() + make_interval(mins => $3)
     WHERE id = $1 AND account_id = $2 AND status IN ('failed', 'skipped') RETURNING *`,
    [id, accountId, LEASE_MIN],
  );
  if (!r) return null;
  return attemptDelivery(r);
}

/** Entregas de los avisos del panel de una persona (para mostrar qué llegó por WhatsApp y correo). */
export async function deliveriesFor(notificationIds: (string | number)[]) {
  const out = new Map<string, { channel: string; status: string; error: string; fallback: boolean }[]>();
  if (!notificationIds.length) return out;
  const rows = await query<{ notification_id: string; channel: string; status: string; last_error: string; fallback_of: string | null }>(
    `SELECT notification_id, channel, status, last_error, fallback_of FROM alert_receipts WHERE notification_id = ANY($1::bigint[]) ORDER BY id`,
    [notificationIds.map(String)],
  );
  for (const r of rows) {
    const list = out.get(String(r.notification_id)) ?? [];
    list.push({ channel: r.channel, status: r.status, error: r.status === 'sent' ? '' : r.last_error, fallback: !!r.fallback_of });
    out.set(String(r.notification_id), list);
  }
  return out;
}

/** Las entregas que no llegaron en los últimos días (para el administrador de la cuenta). */
export async function failedDeliveries(accountId: string, days = 7) {
  return query<{ id: string; channel: string; destination: string; status: string; last_error: string; attempts: number; kind: string; title: string; created_at: Date; user_id: string | null; user_name: string | null }>(
    `SELECT r.id, r.channel, r.destination, r.status, r.last_error, r.attempts, r.kind, r.payload->>'title' AS title, r.created_at, r.user_id,
            COALESCE(NULLIF(u.name, ''), u.email) AS user_name
     FROM alert_receipts r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.account_id = $1 AND r.status = 'failed' AND r.created_at > now() - make_interval(days => $2)
     ORDER BY r.created_at DESC LIMIT 200`,
    [accountId, days],
  );
}

/** Si las últimas entregas por WhatsApp de una persona fallaron todas (para avisarle en Mis avisos que revise su número). */
export async function whatsappFailing(userId: string, last = 3) {
  const rows = await query<{ status: string }>(
    `SELECT status FROM alert_receipts WHERE user_id = $1 AND channel = 'whatsapp' AND status IN ('sent', 'failed') ORDER BY id DESC LIMIT $2`,
    [userId, last],
  );
  return rows.length >= last && rows.every((r) => r.status === 'failed');
}
