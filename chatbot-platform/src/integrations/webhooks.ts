/**
 * Webhooks de eventos: cuando pasa algo en la cuenta (contacto nuevo, datos capturados, cita, cobro, baja…), el sistema
 * avisa por POST firmado a las URL que el cliente registró (Zapier, Make, n8n, su CRM…). Cada entrega queda en una
 * bitácora, se reintenta con espera creciente (6 intentos en unas 8 h) y un endpoint que falla muchas veces seguidas se
 * pausa solo. El cuerpo de cada evento se guarda 30 días para poder reenviarlo desde el panel.
 *
 * El contacto, la cita y el cobro llegan con la misma forma que en la API v1, para usar el mismo código con ambas.
 */
import crypto from 'node:crypto';
import { notifyUsers, scheduleJob, getSettings } from '../automation/store.js';
import { postSigned } from '../automation/automator.js';
import type { Appointment, AutomationEvent } from '../automation/types.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { config } from '../config.js';
import * as store from '../store/index.js';
import { receivableOut, type Receivable } from '../receivables/index.js';
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
  'appointment.booked': 'Se agendó una cita (en el chat, el panel o la página de reservas)',
  'appointment.rescheduled': 'Se cambió la fecha u hora de una cita',
  'appointment.cancelled': 'Se canceló una cita',
  'payment.due': 'Hoy vence un cobro (al enviarse su recordatorio)',
  'payment.overdue': 'Un cobro venció sin pagarse',
  'payment.paid': 'Se marcó un cobro como pagado',
  'quote.sent': 'Se envió una cotización al cliente',
  'quote.accepted': 'El cliente aceptó una cotización',
  'quote.rejected': 'El equipo rechazó una cotización por aprobar',
  'pipeline.stage_changed': 'Una solicitud cambió de columna en un pipeline',
  'conversation.sent': 'Conversación enviada a tu app (resumen o completa, por una regla, el equipo o la API)',
  ping: 'Prueba de conexión',
} as const;
export type PublicEvent = keyof typeof EVENT_TYPES;

/**
 * Lo que recibe «todos los eventos» ("*"): los que existían cuando se creó esa opción. Los eventos nuevos se eligen
 * uno por uno, así un Zap que ya funciona no empieza a recibir avisos de otro tipo. message.received tampoco va: uno
 * por mensaje es mucho tráfico.
 */
export const ALL_EVENTS_SET: ReadonlySet<string> = new Set<PublicEvent>([
  'contact.created', 'contact.data_captured', 'contact.tag_added', 'contact.opted_out', 'conversation.handoff', 'goal.completed',
  'appointment.booked', 'appointment.cancelled', 'pipeline.stage_changed', 'conversation.sent',
]);

/** Versión del formato del cuerpo: cambia solo si algo deja de ser compatible. */
export const API_VERSION = 1;

/** Las citas y los cobros avisan por su cuenta (también sin conversación); aquí solo lo que pasa en una conversación. */
const FROM_INTERNAL: Partial<Record<AutomationEvent['type'], PublicEvent>> = {
  new_contact: 'contact.created',
  message_received: 'message.received',
  data_captured: 'contact.data_captured',
  tag_added: 'contact.tag_added',
  opt_out: 'contact.opted_out',
  handoff: 'conversation.handoff',
  goal_completed: 'goal.completed',
  pipeline_stage: 'pipeline.stage_changed',
  quote_sent: 'quote.sent',
  quote_accepted: 'quote.accepted',
  quote_rejected: 'quote.rejected',
};

export const MAX_CONSECUTIVE_FAILURES = 20;
/** Espera antes de cada reintento: 6 intentos en unas 8 h, para aguantar una caída de tu sistema de una tarde. */
export const RETRY_MINUTES = [1, 5, 30, 120, 360];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

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

/** Quién lo provocó: tu sistema por la API (para que no le respondas a tu propio cambio) o Riverrun. */
export type EventOrigin = 'api' | 'riverrun';

export function publicEventFor(e: AutomationEvent): PublicEvent | null {
  return FROM_INTERNAL[e.type] ?? null;
}

export const subscribed = (ep: Pick<Endpoint, 'events'>, type: string) => ep.events.includes(type) || (ep.events.includes('*') && ALL_EVENTS_SET.has(type));

/* ------------------------------ Forma de los datos ------------------------------ */

/** El contacto como lo ve tu sistema (los mismos campos de siempre, más su canal, su nombre de perfil y su alta). */
export function contactPayload(contact: Contact, channel: Pick<Channel, 'id' | 'type' | 'name'>) {
  return {
    id: contact.id, name: contact.name || contact.push_name || '', profile_name: contact.push_name || null, phone: contact.phone,
    channel: { id: channel.id, type: channel.type, name: channel.name },
    tags: contact.tags, data: contact.data, consent: !!contact.consent_at, opted_out: contact.opted_out, created_at: (contact as any).created_at ?? null,
  };
}

function conversationPayload(conv: Conversation, channel: Pick<Channel, 'id' | 'type' | 'name'>) {
  return {
    id: conv.id, status: conv.status, handoff_reason: conv.handoff_reason || null, channel: { id: channel.id, type: channel.type, name: channel.name },
    // Todo lo capturado hasta ahora (el resumen y el análisis se generan antes de avisar al cumplirse el objetivo o transferir).
    summary: conv.report_summary || null, analysis: conv.report_analysis ?? {}, data: conv.data ?? {}, flow_step: conv.flow_step ?? 0, goal_completed_at: conv.goal_completed_at ?? null,
    url: `${config.publicBaseUrl}/#/conversation/${conv.id}`,
  };
}

/**
 * La cita como la devuelve GET /api/v1/appointments: todos sus campos con sus valores tal cual (los mismos que traía el
 * aviso antes, para no romper a quien ya los usa), más el nombre de la persona asignada.
 */
export function appointmentPayload(a: Appointment) {
  return { ...a, meeting_url: a.meeting_url ?? null, customer_email: a.customer_email ?? null, assigned_user_name: a.assigned_user_name ?? null };
}

/** Lo que se envía del contacto y la conversación (sin datos internos). */
export function eventData(e: AutomationEvent, ctx: { conv: Conversation; contact: Contact; channel: Channel }): Record<string, unknown> {
  const { conv, contact, channel } = ctx;
  return {
    contact: contactPayload(contact, channel),
    conversation: conversationPayload(conv, channel),
    ...(e.field ? { field: e.field, value: contact.data?.[e.field] ?? (e.field === 'nombre' ? contact.name : null) } : {}),
    ...(e.tag ? { tag: e.tag } : {}),
    ...(e.step ? { stage: e.step } : {}),
    ...(e.text !== undefined ? { message: e.text } : {}),
    ...(e.pipeline ? { pipeline: e.pipeline } : {}),
    ...(e.quote ? { quote: e.quote } : {}),
  };
}

/** El contacto y la conversación de un registro (cita, cobro). playground: es del simulador, no se avisa. */
async function contextOf(ref: { conversationId?: string | null; contactId?: string | null }) {
  const conv = ref.conversationId ? await store.getConversation(ref.conversationId) : null;
  const contactId = conv?.contact_id ?? ref.contactId ?? null;
  const contact = contactId ? await store.getContact(contactId) : null;
  const channel = contact ? await store.getChannel(contact.channel_id) : null;
  if (!contact || !channel) return { contact: null, conversation: null, playground: false };
  return { contact: contactPayload(contact, channel), conversation: conv && conv.contact_id === contact.id ? conversationPayload(conv, channel) : null, playground: channel.type === 'playground' };
}

/** Cuerpo estándar de un evento. */
export function eventBody(id: string, type: PublicEvent, accountId: string, data: Record<string, unknown>, o: { origin?: EventOrigin; test?: boolean } = {}) {
  return { id, type, api_version: API_VERSION, created_at: new Date().toISOString(), account_id: accountId, origin: o.origin ?? 'riverrun', ...(o.test ? { test: true } : {}), data };
}

/* ------------------------------ Envío ------------------------------ */

const targetsFor = async (accountId: string, type: PublicEvent, endpointId?: string) => {
  const endpoints = await query<Endpoint>(`SELECT * FROM webhook_endpoints WHERE account_id = $1 AND active`, [accountId]);
  return endpointId ? endpoints.filter((ep) => ep.id === endpointId) : endpoints.filter((ep) => subscribed(ep, type));
};

/**
 * Programa la entrega del evento a cada endpoint suscrito de la cuenta. Con `endpointId` va solo a ese (si está activo),
 * aunque no esté suscrito al evento: se eligió a propósito.
 */
export async function dispatchEvent(accountId: string, type: PublicEvent, data: Record<string, unknown>, o: { endpointId?: string; origin?: EventOrigin } = {}) {
  const targets = await targetsFor(accountId, type, o.endpointId);
  if (!targets.length) return 0;
  const eventId = crypto.randomUUID();
  const body = eventBody(eventId, type, accountId, data, { origin: o.origin });
  // Se guarda una vez para entregarlo, reintentarlo y reenviarlo; cada entrega lo lee de aquí.
  await query(`INSERT INTO webhook_events (id, account_id, type, body) VALUES ($1, $2, $3, $4)`, [eventId, accountId, type, JSON.stringify(body)]);
  for (const ep of targets) {
    await scheduleJob({ account_id: accountId, type: 'webhook_delivery', payload: { endpoint_id: ep.id, event_id: eventId, event: type, attempt: 1 }, run_at: new Date() });
  }
  return targets.length;
}

/**
 * Eventos de registros que no siempre tienen conversación (citas de la página de reservas, cobros): llevan el contacto
 * y la conversación si los hay. Un error aquí no detiene lo que lo provocó: queda en la bitácora.
 */
export async function dispatchRecordEvent(accountId: string, type: PublicEvent, record: Record<string, unknown>, ref: { conversationId?: string | null; contactId?: string | null }, o: { origin?: EventOrigin } = {}) {
  try {
    if (!(await targetsFor(accountId, type)).length) return 0;
    const ctx = await contextOf(ref);
    if (ctx.playground) return 0;
    return await dispatchEvent(accountId, type, { ...record, contact: ctx.contact, conversation: ctx.conversation }, o);
  } catch (e: any) {
    await logEvent({ level: 'error', source: 'system', message: `Webhooks de eventos (${type}): ${e?.message ?? e}`, accountId });
    return 0;
  }
}

export const appointmentEvent = (type: 'appointment.booked' | 'appointment.rescheduled' | 'appointment.cancelled', a: Appointment) =>
  a.source === 'simulador' ? Promise.resolve(0) : dispatchRecordEvent(a.account_id, type, { appointment: appointmentPayload(a) }, { conversationId: a.conversation_id, contactId: a.contact_id });

export const paymentEvent = (type: 'payment.due' | 'payment.overdue' | 'payment.paid', r: Receivable, o: { conversationId?: string | null; origin?: EventOrigin } = {}) =>
  dispatchRecordEvent(r.account_id, type, { receivable: receivableOut(r) }, { conversationId: o.conversationId ?? r.conversation_id, contactId: r.contact_id }, { origin: o.origin });

/** Un intento de entrega: lo anota en la bitácora y dice cómo le fue. */
export async function deliverOnce(ep: Endpoint, eventId: string, event: string, body: unknown, attempt: number): Promise<{ ok: boolean; status: number | null; error: string }> {
  const settings = await getSettings(ep.account_id);
  const started = Date.now();
  let status: number | null = null;
  let error = '';
  try {
    const r = await postSigned(ep.url, body, settings.webhook_secret, { 'x-riverrun-event': event, 'x-riverrun-delivery': eventId });
    status = r.status;
    if (status < 200 || status >= 300) error = `La URL respondió ${status}`;
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  const ok = !error;
  await query(
    `INSERT INTO webhook_deliveries (endpoint_id, account_id, event_id, event, ok, status_code, error, attempt, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ep.id, ep.account_id, eventId, event, ok, status, error, attempt, Date.now() - started],
  );
  if (ok && ep.consecutive_failures) await query(`UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1`, [ep.id]);
  return { ok, status, error };
}

/**
 * Tarea programada: una entrega. Si falla, programa el siguiente intento; tras el último cuenta un fallo del endpoint.
 * Las tareas de antes traen el cuerpo y su intento en la tarea (`body`, el número de intento del planificador).
 */
export async function deliver(payload: { endpoint_id: string; event_id: string; event: string; body?: unknown; attempt?: number }, jobAttempt = 1) {
  const ep = await queryOne<Endpoint>(`SELECT * FROM webhook_endpoints WHERE id = $1`, [payload.endpoint_id]);
  if (!ep || !ep.active) return; // se borró o se pausó mientras esperaba
  const body = payload.body ?? (await queryOne<{ body: unknown }>(`SELECT body FROM webhook_events WHERE id = $1`, [payload.event_id]))?.body;
  if (!body) return; // el evento ya no existe (se borraron los datos del cliente o pasó su plazo)
  const legacy = payload.attempt === undefined;
  const attempt = payload.attempt ?? jobAttempt;
  const r = await deliverOnce(ep, payload.event_id, payload.event, body, attempt);
  if (r.ok) return;
  // Las tareas de antes las reintenta el planificador (3 intentos), como cuando se programaron.
  if (legacy && attempt < 3) throw new Error(r.error);
  if (!legacy && attempt < MAX_ATTEMPTS) {
    // Con dedupe_key: si el proceso se reinicia justo aquí y la tarea corre otra vez, no quedan dos reintentos.
    await scheduleJob({ account_id: ep.account_id, type: 'webhook_delivery', payload: { endpoint_id: ep.id, event_id: payload.event_id, event: payload.event, attempt: attempt + 1 }, run_at: new Date(Date.now() + RETRY_MINUTES[attempt - 1] * 60_000), dedupe_key: `whdel:${ep.id}:${payload.event_id}:${attempt + 1}` });
    return;
  }
  // Cada evento cuenta una vez (tras agotar sus intentos), no una por intento.
  const failures = (await queryOne<{ consecutive_failures: number }>(`UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures`, [ep.id]))?.consecutive_failures ?? 0;
  if (failures >= MAX_CONSECUTIVE_FAILURES) await pauseEndpoint(ep, `Se pausó tras ${failures} fallos seguidos (último: ${r.error})`);
  // Una tarea de antes termina como fallida, igual que antes (el planificador ya no la reintenta: es su tercer intento).
  if (legacy) throw new Error(r.error);
}

/** Reenvía un evento guardado a un endpoint (desde «Ver entregas»). null si ya no está guardado. */
export async function redeliver(ep: Endpoint, eventId: string) {
  const ev = await queryOne<{ type: string }>(`SELECT type FROM webhook_events WHERE id = $1 AND account_id = $2`, [eventId, ep.account_id]);
  if (!ev) return null;
  await scheduleJob({ account_id: ep.account_id, type: 'webhook_delivery', payload: { endpoint_id: ep.id, event_id: eventId, event: ev.type, attempt: 1 }, run_at: new Date() });
  return ev.type;
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

/* ------------------------------ Ejemplos para «Enviar prueba» ------------------------------ */

const SAMPLE_CONTACT = { id: '00000000-0000-4000-8000-000000000001', name: 'Ana López', profile_name: 'Ana', phone: '5215512345678', channel: { id: '00000000-0000-4000-8000-000000000002', type: 'whatsapp', name: 'WhatsApp' }, tags: ['vip'], data: { correo: 'ana@ejemplo.com' }, consent: true, opted_out: false, created_at: '2026-10-01T15:00:00.000Z' };
const SAMPLE_CONVERSATION = { id: '00000000-0000-4000-8000-000000000003', status: 'bot', handoff_reason: null, channel: SAMPLE_CONTACT.channel, summary: 'Ana quiere una cita para el lunes.', analysis: {}, data: {}, flow_step: 0, goal_completed_at: null, url: `${config.publicBaseUrl}/#/conversation/00000000-0000-4000-8000-000000000003` };

/**
 * Un ejemplo con la forma real del evento, para mapear los campos en Zapier o Make: con la conversación, la cita y el
 * cobro más recientes de la cuenta si los hay; si no, con datos de ejemplo.
 */
export async function sampleEventData(accountId: string, type: PublicEvent): Promise<Record<string, unknown>> {
  const recent = await queryOne<{ id: string }>(
    `SELECT cv.id FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id WHERE cv.account_id = $1 AND ch.type <> 'playground' ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1`, [accountId]);
  const ctx = recent ? await contextOf({ conversationId: recent.id }) : null;
  const base = { contact: ctx?.contact ?? SAMPLE_CONTACT, conversation: ctx?.conversation ?? SAMPLE_CONVERSATION };
  const contact = base.contact as { data: Record<string, string>; tags: string[] };
  if (type.startsWith('appointment.')) {
    const a = await queryOne<Appointment>(`SELECT * FROM appointments WHERE account_id = $1 AND source <> 'simulador' ORDER BY created_at DESC LIMIT 1`, [accountId]);
    return { ...base, appointment: a ? appointmentPayload(a) : { id: '00000000-0000-4000-8000-000000000004', service_id: null, service_name: 'Limpieza dental', kind: 'appointment', status: type === 'appointment.cancelled' ? 'cancelled' : 'confirmed', starts_at: '2026-11-03T16:00:00.000Z', ends_at: '2026-11-03T17:00:00.000Z', customer_name: 'Ana López', customer_phone: '5215512345678', customer_email: null, notes: '', source: 'bot', contact_id: SAMPLE_CONTACT.id, conversation_id: SAMPLE_CONVERSATION.id, assigned_user_id: null, meeting_url: null, cancel_reason: null } };
  }
  if (type.startsWith('payment.')) {
    const r = await queryOne<Receivable>(`SELECT * FROM receivables WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`, [accountId]);
    return { ...base, receivable: r ? receivableOut(r) : { id: '00000000-0000-4000-8000-000000000005', contact_id: SAMPLE_CONTACT.id, conversation_id: SAMPLE_CONVERSATION.id, concept: 'Mensualidad de noviembre', amount_cents: 150000, currency: 'MXN', due_date: '2026-11-05', status: type === 'payment.paid' ? 'paid' : 'pending', paid_at: null, paid_note: '', payment_link: '', reference: 'F-1024', source: 'api', reminders: null, reminders_sent: 1, last_reminded_at: null, paused_until: null, created_at: '2026-10-28T15:00:00.000Z', source_id: '', installment: '' } };
  }
  switch (type) {
    case 'message.received': return { ...base, message: 'Hola, ¿tienen disponibilidad mañana?' };
    case 'contact.data_captured': {
      const [field, value] = Object.entries(contact.data ?? {})[0] ?? ['correo', 'ana@ejemplo.com'];
      return { ...base, field, value };
    }
    case 'contact.tag_added': return { ...base, tag: contact.tags?.[0] ?? 'vip' };
    case 'quote.sent': case 'quote.accepted': case 'quote.rejected':
      return { ...base, quote: { id: '00000000-0000-4000-8000-000000000006', folio: 'COT-0001', kind: 'final', total: '$1,500.00', valid_until: '2026-11-15' } };
    case 'pipeline.stage_changed':
      return { ...base, pipeline: { id: '00000000-0000-4000-8000-000000000007', name: 'Ventas', stage_id: 'interesado', stage_name: 'Interesado', stage_kind: 'open', from_stage_id: 'nuevo', from_stage_name: 'Nuevo', reason: 'El cliente pidió precios', value: 0, currency: 'MXN' } };
    case 'conversation.sent':
      return { content: 'summary', reason: 'prueba desde el panel', trigger: { event: 'manual' }, ...base, summary: { text: (base.conversation as { summary: string | null }).summary, analysis: {}, generated_at: null, stale: false, warning: null } };
    // La prueba de conexión no lleva datos de clientes: puede ir a una dirección que todavía no está verificada.
    case 'ping': return { message: 'Prueba de conexión desde el panel', contact: SAMPLE_CONTACT };
    default: return base;
  }
}
