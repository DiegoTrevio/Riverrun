/**
 * Cobros de cada negocio a sus clientes y sus recordatorios de pago por WhatsApp.
 *
 * El dinero no pasa por la plataforma: el cliente paga con las instrucciones del negocio (o el enlace del cobro) y el
 * equipo marca el cobro como pagado. Los recordatorios son mensajes de servicio: salen aunque el cliente se haya dado de
 * baja de promociones, pero no si el cobro ya se pagó o se canceló. Si el cliente dice que ya pagó o manda su
 * comprobante, el asistente no lo confirma: avisa al equipo y se deja de insistir unos días.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { normalize } from '../engine/text.js';
import { logEvent } from '../logs.js';
import { formatMoney } from '../quotes/format.js';
import type { ChatService } from '../service.js';
import * as astore from '../automation/store.js';
import { addDays, isOpen, localParts, nextOpen, spanishDate, zonedToUtc } from '../automation/time.js';
import type { WaTemplateRef } from '../automation/types.js';
import type { Contact, Conversation, Message } from '../types.js';

const DAY = 86400_000;
/** Al reportar un pago, cuánto se deja de insistir mientras el equipo lo verifica. */
export const PAUSE_ON_REPORT_MS = 2 * DAY;

export const DEFAULT_MESSAGES = {
  before: 'Hola {{nombre}}, te recordamos que tu pago de {{pago.concepto}} por {{pago.monto}} vence el {{pago.vencimiento}}.',
  due: 'Hola {{nombre}}, hoy vence tu pago de {{pago.concepto}} por {{pago.monto}}.',
  overdue: 'Hola {{nombre}}, tu pago de {{pago.concepto}} por {{pago.monto}} venció el {{pago.vencimiento}}. Si ya pagaste, envíanos tu comprobante por aquí.',
};

export interface Receivable {
  id: string;
  account_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  concept: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  status: 'pending' | 'paid' | 'canceled';
  paid_at: string | null;
  paid_by: string | null;
  paid_note: string;
  payment_link: string;
  reference: string;
  source: 'manual' | 'api' | 'recurring' | 'appointment' | 'quote';
  source_id: string;
  reminders: number[] | null;
  reminders_sent: number;
  last_reminded_at: string | null;
  paused_until: string | null;
  overdue_notified_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceivableSettings {
  payment_instructions: string;
  default_reminders: number[];
  send_at: string;
  respect_business_hours: boolean;
  message_before: string;
  message_due: string;
  message_overdue: string;
  wa_template: WaTemplateRef | null;
  notify_team_on_overdue: boolean;
}

/** Columnas de un cobro (el monto como número y el vencimiento como YYYY-MM-DD). */
const cols = (p = '') => `${p}id, ${p}account_id, ${p}contact_id, ${p}conversation_id, ${p}concept, ${p}amount_cents::float8 AS amount_cents, ${p}currency,
  to_char(${p}due_date, 'YYYY-MM-DD') AS due_date, ${p}status, ${p}paid_at, ${p}paid_by, ${p}paid_note, ${p}payment_link, ${p}reference, ${p}source, ${p}source_id,
  ${p}reminders, ${p}reminders_sent, ${p}last_reminded_at, ${p}paused_until, ${p}overdue_notified_at, ${p}created_by, ${p}created_at, ${p}updated_at`;
export const RECEIVABLE_COLS = cols();

/* ------------------------------ Datos ------------------------------ */

export async function getReceivableSettings(accountId: string): Promise<ReceivableSettings> {
  const row = await queryOne<any>(`SELECT * FROM receivable_settings WHERE account_id = $1`, [accountId]);
  return {
    payment_instructions: row?.payment_instructions ?? '',
    default_reminders: Array.isArray(row?.default_reminders) ? row.default_reminders : config.receivables.defaultReminders,
    send_at: row?.send_at ?? config.receivables.defaultSendAt,
    respect_business_hours: row?.respect_business_hours ?? true,
    message_before: row?.message_before ?? '',
    message_due: row?.message_due ?? '',
    message_overdue: row?.message_overdue ?? '',
    wa_template: row?.wa_template ?? null,
    notify_team_on_overdue: row?.notify_team_on_overdue ?? true,
  };
}

export async function saveReceivableSettings(accountId: string, s: ReceivableSettings) {
  await query(
    `INSERT INTO receivable_settings (account_id, payment_instructions, default_reminders, send_at, respect_business_hours, message_before, message_due, message_overdue, wa_template, notify_team_on_overdue, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (account_id) DO UPDATE SET payment_instructions = $2, default_reminders = $3, send_at = $4, respect_business_hours = $5, message_before = $6,
       message_due = $7, message_overdue = $8, wa_template = $9, notify_team_on_overdue = $10, updated_at = now()`,
    [accountId, s.payment_instructions, JSON.stringify(s.default_reminders), s.send_at, s.respect_business_hours, s.message_before, s.message_due, s.message_overdue,
      s.wa_template ? JSON.stringify(s.wa_template) : null, s.notify_team_on_overdue],
  );
}

export const getReceivable = (id: string) => queryOne<Receivable>(`SELECT ${RECEIVABLE_COLS} FROM receivables WHERE id = $1`, [id]);

export interface ReceivableFilter {
  status?: 'pending' | 'paid' | 'canceled' | 'overdue' | '';
  contactId?: string;
  search?: string;
  limit?: number;
}

/** Lista de la cuenta con el nombre y teléfono del cliente, y los totales por cobrar, vencido y cobrado este mes. */
export async function listReceivables(accountId: string, f: ReceivableFilter, today: string) {
  const where: string[] = ['r.account_id = $1'];
  const args: unknown[] = [accountId];
  const arg = (v: unknown) => `$${args.push(v)}`;
  if (f.status === 'overdue') where.push(`r.status = 'pending' AND r.due_date < ${arg(today)}`);
  else if (f.status) where.push(`r.status = ${arg(f.status)}`);
  if (f.contactId) where.push(`r.contact_id = ${arg(f.contactId)}`);
  if (f.search) {
    const p = arg(`%${f.search}%`);
    where.push(`(r.concept ILIKE ${p} OR r.reference ILIKE ${p} OR c.name ILIKE ${p} OR c.push_name ILIKE ${p} OR c.phone LIKE ${p})`);
  }
  const rows = await query<Receivable & { contact_name: string; contact_phone: string | null }>(
    `SELECT ${cols('r.')}, COALESCE(NULLIF(c.name, ''), NULLIF(c.push_name, ''), '') AS contact_name, c.phone AS contact_phone
       FROM receivables r LEFT JOIN contacts c ON c.id = r.contact_id
      WHERE ${where.join(' AND ')}
      ORDER BY (r.status = 'pending') DESC, r.due_date, r.created_at LIMIT ${Math.min(500, Math.max(1, f.limit ?? 200))}`,
    args,
  );
  const totals = await query<{ currency: string; pending: string; overdue: string; paid_month: string }>(
    `SELECT currency,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'pending'), 0)::text AS pending,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'pending' AND due_date < $2), 0)::text AS overdue,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('month', now())), 0)::text AS paid_month
       FROM receivables WHERE account_id = $1 GROUP BY currency ORDER BY currency`,
    [accountId, today],
  );
  return { rows, totals: totals.map((t) => ({ currency: t.currency, pending_cents: Number(t.pending), overdue_cents: Number(t.overdue), paid_month_cents: Number(t.paid_month) })) };
}

/** Cobros pendientes de un contacto (los del asistente, la ficha y el aviso de comprobante). */
export const pendingForContact = (accountId: string, contactId: string) =>
  query<Receivable>(`SELECT ${RECEIVABLE_COLS} FROM receivables WHERE account_id = $1 AND contact_id = $2 AND status = 'pending' ORDER BY due_date LIMIT 20`, [accountId, contactId]);

/** La conversación más reciente del contacto (por donde va el recordatorio si el cobro no tiene una). */
export async function latestConversationOf(contactId: string) {
  return (await queryOne<{ id: string }>(
    `SELECT cv.id FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id WHERE cv.contact_id = $1 AND ch.type <> 'playground'
      ORDER BY cv.last_message_at DESC NULLS LAST, cv.created_at DESC LIMIT 1`, [contactId]))?.id ?? null;
}

/* ------------------------------ Variables ------------------------------ */

/** Hoy en la zona del negocio (YYYY-MM-DD). */
export const todayIn = (tz: string, now = new Date()) => localParts(now, tz).date;

/** Días de `from` a `to` (fechas YYYY-MM-DD). */
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/** Las variables del cobro para los mensajes: {{pago.concepto}}, {{pago.monto}}, {{pago.vencimiento}}… */
export function paymentVars(r: Pick<Receivable, 'concept' | 'amount_cents' | 'currency' | 'due_date' | 'payment_link' | 'reference'>, s: Pick<ReceivableSettings, 'payment_instructions'>, tz: string, now = new Date()): Record<string, string> {
  const late = daysBetween(r.due_date, todayIn(tz, now));
  return {
    'pago.concepto': r.concept,
    'pago.monto': formatMoney(Number(r.amount_cents), r.currency),
    // A mediodía: el día no cambia por la zona horaria.
    'pago.vencimiento': spanishDate(zonedToUtc(r.due_date, '12:00', tz), tz),
    'pago.dias_atraso': late > 0 ? String(late) : '0',
    'pago.dias_para_vencer': late < 0 ? String(-late) : '0',
    'pago.link': r.payment_link,
    'pago.instrucciones': s.payment_instructions.trim(),
    'pago.referencia': r.reference,
  };
}

export const reminderKind = (daysFromDue: number): 'before' | 'due' | 'overdue' => (daysFromDue < 0 ? 'before' : daysFromDue === 0 ? 'due' : 'overdue');

/** El texto del recordatorio: el del momento (antes, el día o vencido) más cómo pagar, si el texto no lo trae ya. */
export function reminderText(kind: 'before' | 'due' | 'overdue', s: ReceivableSettings, r: Pick<Receivable, 'payment_link' | 'reference'>) {
  const base = (kind === 'before' ? s.message_before : kind === 'due' ? s.message_due : s.message_overdue).trim() || DEFAULT_MESSAGES[kind];
  const has = (v: string) => new RegExp(`\\{\\{\\s*pago\\.${v}\\s*\\}\\}`, 'i').test(base);
  const extra: string[] = [];
  if (r.payment_link && !has('link')) extra.push('Paga aquí: {{pago.link}}');
  if (s.payment_instructions.trim() && !has('instrucciones')) extra.push('Cómo pagar:\n{{pago.instrucciones}}');
  if (r.reference && !has('referencia')) extra.push('Referencia: {{pago.referencia}}');
  return extra.length ? `${base}\n\n${extra.join('\n')}` : base;
}

/** ¿El cliente dice que ya pagó? (también la descripción de una foto o documento que mandó). */
const PAID_WORDS = /\b(ya (te |les )?(pague|pagamos|deposite|depositamos|transferi|transferimos|realice el pago|hice el pago|quedo (el )?pago)|comprobante|ficha de deposito|te (mande|envie|paso) (el )?(pago|comprobante|deposito)|pago realizado|ya esta pagado)\b/;
export const saysPaid = (text: string) => PAID_WORDS.test(normalize(text));

export interface ReceivableContext {
  items: { concept: string; amount: string; due: string; overdueDays: number; link: string; reference: string }[];
  instructions: string;
}

/* ------------------------------ Recordatorios ------------------------------ */

export class Receivables {
  constructor(private chat: ChatService) {}

  /** Programa (o reprograma) los recordatorios de un cobro pendiente y la revisión de vencido. Devuelve cuántos quedaron. */
  async schedule(r: Receivable, now = new Date()) {
    await astore.cancelJobs('receivable_id', r.id);
    if (r.status !== 'pending' || !config.receivables.enabled) return 0;
    const [s, st] = await Promise.all([getReceivableSettings(r.account_id), astore.getSettings(r.account_id)]);
    const offsets = (r.reminders ?? s.default_reminders).slice(0, config.receivables.maxReminders);
    const hasHours = Object.values(st.business_hours).some((w) => w.length > 0);
    let n = 0;
    for (const offset of offsets) {
      let at = zonedToUtc(addDays(r.due_date, offset), s.send_at, st.timezone);
      if (s.respect_business_hours && hasHours && !isOpen(st.business_hours, st.holidays, at, st.timezone)) at = nextOpen(st.business_hours, st.holidays, at, st.timezone);
      if (at.getTime() < now.getTime() + 60_000) continue;
      await astore.scheduleJob({ account_id: r.account_id, type: 'receivable_reminder', payload: { receivable_id: r.id, offset }, run_at: at, dedupe_key: `payrem:${r.id}:${offset}` });
      n++;
    }
    // Al día siguiente del vencimiento: aviso al equipo y evento «pago vencido» (una vez), aunque no haya recordatorio ese día.
    const overdueAt = zonedToUtc(addDays(r.due_date, 1), s.send_at, st.timezone);
    if (!r.overdue_notified_at && overdueAt.getTime() > now.getTime()) {
      await astore.scheduleJob({ account_id: r.account_id, type: 'receivable_overdue', payload: { receivable_id: r.id }, run_at: overdueAt, dedupe_key: `payover:${r.id}` });
    }
    return n;
  }

  /** Reprograma los pendientes de una cuenta que usan sus días (al cambiar los días o la hora de envío). */
  async rescheduleAccount(accountId: string) {
    const rows = await query<Receivable>(`SELECT ${RECEIVABLE_COLS} FROM receivables WHERE account_id = $1 AND status = 'pending'`, [accountId]);
    for (const r of rows) await this.schedule(r);
  }

  /** Envía el recordatorio de un cobro (programado o «Enviar recordatorio ahora»). Devuelve si salió y, si no, por qué. */
  async remind(r: Receivable, o: { manual?: boolean; now?: Date } = {}): Promise<{ sent: boolean; reason?: string; conversationId?: string | null }> {
    const now = o.now ?? new Date();
    if (r.status !== 'pending') return { sent: false, reason: 'el cobro ya no está pendiente' };
    if (!o.manual && r.reminders_sent >= config.receivables.maxReminders) return { sent: false, reason: 'se alcanzó el máximo de recordatorios de este cobro' };
    const conversationId = r.conversation_id ?? (r.contact_id ? await latestConversationOf(r.contact_id) : null);
    if (!conversationId) return { sent: false, reason: 'el cliente no tiene una conversación por donde escribirle' };
    // Quien escribió la palabra de baja no recibe recordatorios automáticos (el equipo lo contacta por otro medio).
    const optedOut = r.contact_id ? (await queryOne<{ opted_out: boolean }>(`SELECT opted_out FROM contacts WHERE id = $1`, [r.contact_id]))?.opted_out : false;
    if (optedOut) {
      await logEvent({ level: 'info', source: 'engine', message: `Recordatorio de pago no enviado (${r.concept}): el cliente se dio de baja de los mensajes`, accountId: r.account_id, conversationId });
      return { sent: false, reason: 'el cliente se dio de baja de los mensajes', conversationId };
    }
    const [s, st] = await Promise.all([getReceivableSettings(r.account_id), astore.getSettings(r.account_id)]);
    // El texto según el día real (un recordatorio movido por el horario puede salir otro día).
    const kind = reminderKind(daysBetween(r.due_date, todayIn(st.timezone, now)));
    const vars = paymentVars(r, s, st.timezone, now);
    const res = await this.chat.outbound.send(conversationId, {
      text: reminderText(kind, s, r),
      source: 'payment_reminder',
      transactional: true,
      allowWhenHuman: true,
      waTemplate: s.wa_template,
      vars,
      meta: { receivable_id: r.id },
    });
    if (!res.sent) {
      await logEvent({ level: 'warn', source: 'engine', message: `Recordatorio de pago no enviado (${r.concept}): ${res.reason}`, accountId: r.account_id, conversationId });
      return { sent: false, reason: res.reason, conversationId };
    }
    await query(`UPDATE receivables SET reminders_sent = reminders_sent + 1, last_reminded_at = $2, conversation_id = COALESCE(conversation_id, $3), updated_at = now() WHERE id = $1`, [r.id, now, conversationId]);
    if (kind === 'due' && !o.manual) this.chat.automator.emit({ type: 'payment_due', conversationId, payment: vars });
    return { sent: true, conversationId };
  }

  /** Tarea programada: el recordatorio de un día. Vuelve a revisar el cobro (pudo pagarse o cancelarse). */
  async runReminder(payload: { receivable_id: string; offset: number }) {
    const r = await getReceivable(payload.receivable_id);
    if (!r || r.status !== 'pending') return;
    // El cliente reportó su pago: se espera a que el equipo lo verifique; si después sigue pendiente, sale.
    if (r.paused_until && new Date(r.paused_until).getTime() > Date.now()) {
      await astore.scheduleJob({ account_id: r.account_id, type: 'receivable_reminder', payload, run_at: new Date(r.paused_until), dedupe_key: `payrem:${r.id}:${payload.offset}:pausa` });
      return;
    }
    await this.remind(r);
  }

  /** Tarea programada: al día siguiente del vencimiento, aviso al equipo y evento «pago vencido» (una vez por cobro). */
  async runOverdue(payload: { receivable_id: string }) {
    const r = await queryOne<Receivable>(
      `UPDATE receivables SET overdue_notified_at = now() WHERE id = $1 AND status = 'pending' AND overdue_notified_at IS NULL RETURNING ${RECEIVABLE_COLS}`, [payload.receivable_id]);
    if (!r) return;
    const [s, st] = await Promise.all([getReceivableSettings(r.account_id), astore.getSettings(r.account_id)]);
    const vars = paymentVars(r, s, st.timezone);
    const conversationId = r.conversation_id ?? (r.contact_id ? await latestConversationOf(r.contact_id) : null);
    if (s.notify_team_on_overdue) {
      const who = r.contact_id ? await queryOne<{ name: string }>(`SELECT COALESCE(NULLIF(name, ''), NULLIF(push_name, ''), '+' || phone, 'Un cliente') AS name FROM contacts WHERE id = $1`, [r.contact_id]) : null;
      await this.chat.automator.alertTeam(r.account_id, {
        title: `⏰ Pago vencido: ${who?.name ?? 'un cliente'}`,
        body: `${r.concept} por ${vars['pago.monto']} venció el ${vars['pago.vencimiento']} y sigue pendiente.`,
        link: `#/cobros?id=${r.id}`,
        kind: 'payment',
        conversationId: conversationId ?? undefined,
      });
    }
    if (conversationId) this.chat.automator.emit({ type: 'payment_overdue', conversationId, payment: vars });
  }

  /** Marcar pagado o cancelar: ya no se insiste. «Pagado» dispara el evento «pago recibido» para las reglas. */
  async settle(r: Receivable, status: 'paid' | 'canceled', by: { userId: string | null; note?: string }) {
    const updated = await queryOne<Receivable>(
      `UPDATE receivables SET status = $2, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE NULL END, paid_by = CASE WHEN $2 = 'paid' THEN $3::uuid ELSE NULL END,
              paid_note = $4, paused_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING ${RECEIVABLE_COLS}`,
      [r.id, status, by.userId, (by.note ?? '').slice(0, 500)],
    );
    if (!updated) return null;
    await astore.cancelJobs('receivable_id', r.id);
    if (status === 'paid') {
      const conversationId = updated.conversation_id ?? (updated.contact_id ? await latestConversationOf(updated.contact_id) : null);
      if (conversationId) {
        const [s, st] = await Promise.all([getReceivableSettings(r.account_id), astore.getSettings(r.account_id)]);
        this.chat.automator.emit({ type: 'payment_paid', conversationId, payment: paymentVars(updated, s, st.timezone) });
      }
    }
    return updated;
  }

  /**
   * Mensaje del cliente: si tiene cobros pendientes y dice que ya pagó (o manda una foto o documento con un cobro por
   * vencer), se avisa al equipo para que lo verifique y se dejan de mandar recordatorios unos días. No se confirma nada.
   */
  async onCustomerMessage(conv: Conversation, contact: Contact, message: Pick<Message, 'type'>, text: string) {
    if (!config.receivables.enabled) return false;
    const media = message.type === 'image' || message.type === 'document';
    const said = saysPaid(text);
    if (!media && !said) return false;
    const pending = await pendingForContact(conv.account_id, contact.id);
    if (!pending.length) return false;
    const st = await astore.getSettings(conv.account_id);
    const today = todayIn(st.timezone);
    // Una foto sin palabras de pago solo cuenta si algún cobro vence en los próximos 7 días o ya venció.
    if (!said && !pending.some((r) => daysBetween(today, r.due_date) <= 7)) return false;
    const fresh = await query<{ id: string }>(
      `UPDATE receivables SET paused_until = $3, conversation_id = COALESCE(conversation_id, $4), updated_at = now()
        WHERE account_id = $1 AND contact_id = $2 AND status = 'pending' AND (paused_until IS NULL OR paused_until < now()) RETURNING id`,
      [conv.account_id, contact.id, new Date(Date.now() + PAUSE_ON_REPORT_MS), conv.id],
    );
    // Ya se avisó por este reporte (varias fotos seguidas): no se repite el aviso.
    if (!fresh.length) return true;
    const s = await getReceivableSettings(conv.account_id);
    const list = pending.map((r) => { const v = paymentVars(r, s, st.timezone); return `• ${r.concept}: ${v['pago.monto']} (vence el ${v['pago.vencimiento']})`; }).join('\n');
    const name = contact.name || contact.push_name || (contact.phone ? `+${contact.phone}` : 'Un cliente');
    await this.chat.automator.alertTeam(conv.account_id, {
      title: `💳 ${name} dice que ya pagó`,
      body: `${media ? 'Mandó un archivo y' : 'Escribió que'} ya pagó. Verifica el pago y márcalo como pagado en Cobros:\n${list}`,
      link: `#/conversation/${conv.id}`,
      kind: 'payment',
      conversationId: conv.id,
    });
    await logEvent({ level: 'info', source: 'engine', message: `El cliente reportó un pago: se avisó al equipo y se pausan los recordatorios ${PAUSE_ON_REPORT_MS / DAY} días`, accountId: conv.account_id, conversationId: conv.id });
    return true;
  }

  /** Lo que el asistente sabe de lo que el cliente debe (para contestar «¿cuánto debo?» y «¿cómo pago?»). */
  async contextFor(conv: Conversation): Promise<ReceivableContext | null> {
    if (!config.receivables.enabled) return null;
    const pending = await pendingForContact(conv.account_id, conv.contact_id);
    if (!pending.length) return null;
    const [s, st] = await Promise.all([getReceivableSettings(conv.account_id), astore.getSettings(conv.account_id)]);
    return {
      items: pending.map((r) => {
        const v = paymentVars(r, s, st.timezone);
        return { concept: r.concept, amount: v['pago.monto'], due: v['pago.vencimiento'], overdueDays: Number(v['pago.dias_atraso']), link: r.payment_link, reference: r.reference };
      }),
      instructions: s.payment_instructions.trim(),
    };
  }
}
