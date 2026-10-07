/**
 * Webhooks de eventos: cuando pasa algo en la cuenta (contacto nuevo, datos capturados, cita, baja…), el sistema
 * avisa por POST firmado a las URL que el cliente registró (Zapier, Make, n8n, su CRM…). Cada entrega queda en una
 * bitácora, se reintenta con espera creciente y un endpoint que falla muchas veces seguidas se pausa solo.
 */
import crypto from 'node:crypto';
import { notifyUsers, scheduleJob, getSettings } from '../automation/store.js';
import { postSigned } from '../automation/automator.js';
import type { AutomationEvent } from '../automation/types.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { config } from '../config.js';
import type { Channel, Contact, Conversation } from '../types.js';

/** Eventos públicos y el evento interno del que salen. */
export const EVENT_TYPES = {
  'contact.created': 'Contacto nuevo (primer mensaje)',
  'message.received': 'Mensaje recibido del cliente',
  'contact.data_captured': 'Se capturó un dato del cliente (nombre, correo, fecha…)',
  'contact.tag_added': 'Se agregó una etiqueta al cliente',
  'contact.opted_out': 'El cliente se dio de baja de promociones',
  'conversation.handoff': 'Una conversación pasó a una persona',
  'goal.completed': 'El asistente cumplió el objetivo de la conversación',
  'appointment.booked': 'Se agendó una cita',
  'appointment.cancelled': 'Se canceló una cita',
  ping: 'Prueba de conexión',
} as const;
export type PublicEvent = keyof typeof EVENT_TYPES;

const FROM_INTERNAL: Partial<Record<AutomationEvent['type'], PublicEvent>> = {
  new_contact: 'contact.created',
  message_received: 'message.received',
  data_captured: 'contact.data_captured',
  tag_added: 'contact.tag_added',
  opt_out: 'contact.opted_out',
  handoff: 'conversation.handoff',
  goal_completed: 'goal.completed',
  appointment_booked: 'appointment.booked',
  appointment_cancelled: 'appointment.cancelled',
};

export const MAX_CONSECUTIVE_FAILURES = 20;

export interface Endpoint {
  id: string;
  account_id: string;
  url: string;
  description: string;
  events: string[];
  active: boolean;
  consecutive_failures: number;
  disabled_reason: string;
}

export function publicEventFor(e: AutomationEvent): PublicEvent | null {
  return FROM_INTERNAL[e.type] ?? null;
}

/** "*" = todos los eventos salvo message.received (uno por mensaje es mucho tráfico: se pide expresamente). */
export const subscribed = (ep: Pick<Endpoint, 'events'>, type: string) => ep.events.includes(type) || (ep.events.includes('*') && type !== 'message.received');

/** Lo que se envía del contacto y la conversación (sin datos internos). */
export function eventData(e: AutomationEvent, ctx: { conv: Conversation; contact: Contact; channel: Channel }): Record<string, unknown> {
  const { conv, contact, channel } = ctx;
  return {
    contact: { id: contact.id, name: contact.name || contact.push_name || '', phone: contact.phone, tags: contact.tags, data: contact.data, consent: !!contact.consent_at, opted_out: contact.opted_out },
    conversation: { id: conv.id, status: conv.status, handoff_reason: conv.handoff_reason || null, channel: { id: channel.id, type: channel.type, name: channel.name } },
    ...(e.field ? { field: e.field, value: contact.data?.[e.field] ?? (e.field === 'nombre' ? contact.name : null) } : {}),
    ...(e.tag ? { tag: e.tag } : {}),
    ...(e.text !== undefined ? { message: e.text } : {}),
    ...(e.appointment ? { appointment: e.appointment } : {}),
  };
}

/** Cuerpo estándar de un evento. */
export function eventBody(id: string, type: PublicEvent, accountId: string, data: Record<string, unknown>) {
  return { id, type, created_at: new Date().toISOString(), account_id: accountId, data };
}

/** Programa la entrega del evento a cada endpoint suscrito de la cuenta. */
export async function dispatchEvent(accountId: string, type: PublicEvent, data: Record<string, unknown>) {
  const endpoints = await query<Endpoint>(`SELECT * FROM webhook_endpoints WHERE account_id = $1 AND active`, [accountId]);
  const targets = endpoints.filter((ep) => subscribed(ep, type));
  if (!targets.length) return 0;
  const eventId = crypto.randomUUID();
  const body = eventBody(eventId, type, accountId, data);
  for (const ep of targets) {
    await scheduleJob({ account_id: accountId, type: 'webhook_delivery', payload: { endpoint_id: ep.id, event_id: eventId, event: type, body }, run_at: new Date() });
  }
  return targets.length;
}

/** Tarea programada: una entrega (el planificador la reintenta hasta 3 veces si lanza un error). */
export async function deliver(payload: { endpoint_id: string; event_id: string; event: string; body: unknown }, attempt = 1) {
  const ep = await queryOne<Endpoint>(`SELECT * FROM webhook_endpoints WHERE id = $1`, [payload.endpoint_id]);
  if (!ep || !ep.active) return; // se borró o se pausó mientras esperaba
  const settings = await getSettings(ep.account_id);
  const started = Date.now();
  let status: number | null = null;
  let error = '';
  try {
    const r = await postSigned(ep.url, payload.body, settings.webhook_secret, { 'x-riverrun-event': payload.event, 'x-riverrun-delivery': payload.event_id });
    status = r.status;
    if (status < 200 || status >= 300) error = `La URL respondió ${status}`;
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  const ok = !error;
  await query(
    `INSERT INTO webhook_deliveries (endpoint_id, account_id, event_id, event, ok, status_code, error, attempt, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ep.id, ep.account_id, payload.event_id, payload.event, ok, status, error, attempt, Date.now() - started],
  );
  if (ok) {
    if (ep.consecutive_failures) await query(`UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1`, [ep.id]);
    return;
  }
  // Cada evento cuenta una vez (tras agotar sus reintentos), no una por intento.
  if (attempt < 3) throw new Error(error);
  const failures = (await queryOne<{ consecutive_failures: number }>(`UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures`, [ep.id]))?.consecutive_failures ?? 0;
  if (failures >= MAX_CONSECUTIVE_FAILURES) await pauseEndpoint(ep, `Se pausó tras ${failures} fallos seguidos (último: ${error})`);
  throw new Error(error);
}

async function pauseEndpoint(ep: Endpoint, reason: string) {
  const claimed = await queryOne<{ id: string }>(`UPDATE webhook_endpoints SET active = false, disabled_reason = $2 WHERE id = $1 AND active RETURNING id`, [ep.id, reason]);
  if (!claimed) return;
  await logEvent({ level: 'warn', source: 'system', message: `Webhook pausado: ${ep.url} — ${reason}`, accountId: ep.account_id });
  const admins = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [ep.account_id]);
  const title = 'Pausamos un webhook que no responde';
  const body = `Tu integración hacia ${ep.url} falló muchas veces seguidas y la pausamos para no seguir insistiendo. Revisa que la dirección funcione y vuelve a activarla en Ajustes → Integraciones.`;
  await notifyUsers(ep.account_id, admins.map((a) => a.id), { title, body, link: '#/integraciones', kind: 'integration' });
  for (const a of admins) await sendMail({ to: a.email, subject: title, text: `${body}\n\n${config.publicBaseUrl}/#/integraciones` });
}
