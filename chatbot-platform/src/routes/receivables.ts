/**
 * Cobros de la cuenta (panel): lo que deben los clientes, sus recordatorios de pago y la configuración de cobro.
 * Admin y agentes ven y registran cobros y los marcan pagados; solo un admin borra o cambia la configuración.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateStr } from '../dates.js';
import { assertAccount, HttpError, notFound, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import * as astore from '../automation/store.js';
import { WaTemplateRefSchema } from '../automation/types.js';
import {
  getReceivable, getReceivableSettings, listReceivables, RECEIVABLE_COLS, receivableOut, saveReceivableSettings, todayIn, type Receivable,
} from '../receivables/index.js';
import { getPlan, nextDue, PLAN_COLS, planCols, runPlans, type ReceivablePlan } from '../receivables/plans.js';
import type { ChatService } from '../service.js';
import { parse } from './util.js';

const Day = z.number().int().min(-60).max(120);
const Days = z.array(Day).max(20).transform((d) => [...new Set(d)].sort((a, b) => a - b));
const Link = z.union([z.literal(''), z.string().trim().max(500).url().refine((u) => /^https:\/\//i.test(u), 'El enlace de pago debe empezar con https://')]);

const fields = {
  conversation_id: z.string().uuid().nullable().optional(),
  concept: z.string().trim().min(1).max(200),
  amount_cents: z.number().int().min(1).max(100_000_000_000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  due_date: dateStr(),
  payment_link: Link,
  reference: z.string().trim().max(100),
  /** null = los días de la cuenta. */
  reminders: Days.nullable(),
};
export const ReceivableBody = z.object({
  ...fields,
  contact_id: z.string().uuid(),
  currency: fields.currency.default('MXN'),
  payment_link: Link.default(''),
  reference: fields.reference.default(''),
  reminders: fields.reminders.default(null),
  /** Folio del sistema que lo da de alta (API): un reintento con el mismo folio no duplica el cobro. */
  source_id: z.string().trim().max(100).default(''),
});
/** Sin valores por defecto: lo que no viene no se toca (editar el concepto no cambia la moneda ni el enlace). */
const ReceivablePatch = z.object(fields).partial();

const DateStr = dateStr();
const planFields = {
  conversation_id: fields.conversation_id,
  concept: fields.concept,
  amount_cents: fields.amount_cents,
  currency: fields.currency,
  payment_link: fields.payment_link,
  reference: fields.reference,
  reminders: fields.reminders,
  frequency: z.enum(['weekly', 'biweekly', 'monthly']),
  /** Semanal y quincenal: día de la semana (0 = domingo). Mensual: día del mes (31 = el último). */
  day: z.number().int().min(0).max(31),
  starts_on: DateStr,
  ends_on: DateStr.nullable(),
  max_payments: z.number().int().min(1).max(600).nullable(),
  active: z.boolean(),
};
const dayOk = (p: { frequency?: string; day?: number }) => p.frequency === undefined || p.day === undefined || (p.frequency === 'monthly' ? p.day >= 1 && p.day <= 31 : p.day <= 6);
const DAY_MSG = { message: 'El día no corresponde a la frecuencia: del 1 al 31 si es mensual; de 0 (domingo) a 6 (sábado) si es semanal o quincenal', path: ['day'] };
export const PlanBody = z.object({
  ...planFields,
  contact_id: z.string().uuid(),
  currency: fields.currency.default('MXN'),
  payment_link: Link.default(''),
  reference: fields.reference.default(''),
  reminders: fields.reminders.default(null),
  ends_on: planFields.ends_on.default(null),
  max_payments: planFields.max_payments.default(null),
  active: z.boolean().default(true),
}).refine(dayOk, DAY_MSG).refine((p) => !p.ends_on || p.ends_on >= p.starts_on, { message: 'La fecha de fin es antes del inicio', path: ['ends_on'] });
const PlanPatch = z.object(planFields).partial().refine(dayOk, DAY_MSG);

const SettingsBody = z.object({
  payment_instructions: z.string().max(2000).default(''),
  default_reminders: Days.default([-3, 0, 3, 7]),
  send_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM').default('10:00'),
  respect_business_hours: z.boolean().default(true),
  message_before: z.string().max(1500).default(''),
  message_due: z.string().max(1500).default(''),
  message_overdue: z.string().max(1500).default(''),
  wa_template: WaTemplateRefSchema.nullable().default(null),
  notify_team_on_overdue: z.boolean().default(true),
});

export { receivableOut };

export const planOut = (p: ReceivablePlan & { contact_name?: string; contact_phone?: string | null }, today: string) => ({
  id: p.id, contact_id: p.contact_id, conversation_id: p.conversation_id, contact_name: p.contact_name ?? undefined, contact_phone: p.contact_phone ?? undefined,
  concept: p.concept, amount_cents: Number(p.amount_cents), currency: p.currency, payment_link: p.payment_link, reference: p.reference, reminders: p.reminders,
  frequency: p.frequency, day: p.day, starts_on: p.starts_on, ends_on: p.ends_on, max_payments: p.max_payments, payments_created: p.payments_created,
  last_due: p.last_due, next_due: nextDue(p, today), active: p.active, created_at: p.created_at,
});

/** Planes de pago recurrente de una cuenta, con el nombre del cliente. */
export async function listPlans(accountId: string, contactId?: string) {
  return query<ReceivablePlan & { contact_name: string; contact_phone: string | null }>(
    `SELECT ${planCols('p.')}, COALESCE(NULLIF(c.name, ''), NULLIF(c.push_name, ''), '') AS contact_name, c.phone AS contact_phone
       FROM receivable_plans p JOIN contacts c ON c.id = p.contact_id
      WHERE p.account_id = $1 AND ($2::uuid IS NULL OR p.contact_id = $2) ORDER BY p.active DESC, p.created_at DESC LIMIT 500`, [accountId, contactId ?? null]);
}

/** Alta de un pago recurrente (panel o API): el cliente es de la cuenta. Crea de una vez el cobro que ya toque. */
export async function createPlan(service: ChatService, accountId: string, b: z.infer<typeof PlanBody>, o: { userId: string | null; actor: string }) {
  if (b.reminders && b.reminders.length > config.receivables.maxReminders) throw new HttpError(400, `Hasta ${config.receivables.maxReminders} recordatorios por cobro`);
  const contact = await queryOne<{ id: string }>(`SELECT id FROM contacts WHERE id = $1 AND account_id = $2`, [b.contact_id, accountId]);
  if (!contact) throw new HttpError(400, 'El cliente no existe en esta cuenta');
  if (b.conversation_id) {
    const conv = await queryOne(`SELECT 1 FROM conversations WHERE id = $1 AND account_id = $2 AND contact_id = $3`, [b.conversation_id, accountId, contact.id]);
    if (!conv) throw new HttpError(400, 'La conversación no es de este cliente');
  }
  const p = (await queryOne<ReceivablePlan>(
    `INSERT INTO receivable_plans (account_id, contact_id, conversation_id, concept, amount_cents, currency, payment_link, reference, reminders, frequency, day, starts_on, ends_on, max_payments, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${PLAN_COLS}`,
    [accountId, contact.id, b.conversation_id ?? null, b.concept, b.amount_cents, b.currency, b.payment_link, b.reference, b.reminders ? JSON.stringify(b.reminders) : null,
      b.frequency, b.day, b.starts_on, b.ends_on, b.max_payments, b.active, o.userId],
  ))!;
  await logEvent({ level: 'info', source: 'admin', message: `Pago recurrente registrado por ${o.actor}: ${p.concept} (${p.frequency})`, accountId });
  const created = p.active ? await runPlans(service.receivables, new Date(), p.id) : 0;
  return { plan: (await getPlan(p.id))!, created };
}

/** Alta de un cobro (panel o API): el contacto es de la cuenta y la conversación, si se da, también. */
export async function createReceivable(service: ChatService, accountId: string, b: z.infer<typeof ReceivableBody>, o: { userId: string | null; source: 'manual' | 'api'; actor: string }): Promise<{ receivable: Receivable; scheduled: number; existed?: boolean }> {
  if (b.reminders && b.reminders.length > config.receivables.maxReminders) throw new HttpError(400, `Hasta ${config.receivables.maxReminders} recordatorios por cobro`);
  const contact = await queryOne<{ id: string }>(`SELECT id FROM contacts WHERE id = $1 AND account_id = $2`, [b.contact_id, accountId]);
  if (!contact) throw new HttpError(400, 'El cliente no existe en esta cuenta');
  if (b.conversation_id) {
    const conv = await queryOne(`SELECT 1 FROM conversations WHERE id = $1 AND account_id = $2 AND contact_id = $3`, [b.conversation_id, accountId, contact.id]);
    if (!conv) throw new HttpError(400, 'La conversación no es de este cliente');
  }
  return service.receivables.create({
    accountId, contactId: contact.id, conversationId: b.conversation_id ?? null, concept: b.concept, amountCents: b.amount_cents, currency: b.currency,
    dueDate: b.due_date, paymentLink: b.payment_link, reference: b.reference, reminders: b.reminders, source: o.source, sourceId: b.source_id,
    createdBy: o.userId, actor: o.actor,
  });
}

export async function receivableRoutes(api: FastifyInstance, service: ChatService) {
  const team = { preHandler: requireRole('agent') };
  const admins = { preHandler: requireRole('admin') };
  const enabled = () => { if (!config.receivables.enabled) throw new HttpError(404, 'Los cobros no están activados en esta plataforma'); };
  const owned = async (user: any, id: string) => assertAccount(user, await getReceivable(id), 'Cobro no encontrado');

  api.get('/api/receivables', team, async (req: any) => {
    enabled();
    const accountId = await targetAccount(req.user, req.query.account_id);
    const q = parse(z.object({ status: z.enum(['', 'pending', 'overdue', 'paid', 'canceled']).default(''), contact_id: z.string().uuid().optional(), search: z.string().trim().max(100).optional(), account_id: z.string().optional() }), req.query);
    const st = await astore.getSettings(accountId);
    const today = todayIn(st.timezone);
    const { rows, totals } = await listReceivables(accountId, { status: q.status, contactId: q.contact_id, search: q.search }, today, st.timezone);
    return { today, data: rows.map(receivableOut), totals };
  });

  api.get('/api/receivables/settings', team, async (req: any) => {
    enabled();
    const accountId = await targetAccount(req.user, req.query.account_id);
    return { settings: await getReceivableSettings(accountId), max_reminders: config.receivables.maxReminders };
  });

  api.put('/api/receivables/settings', admins, async (req: any) => {
    enabled();
    const accountId = await targetAccount(req.user, req.query.account_id);
    const b = parse(SettingsBody, req.body);
    if (b.default_reminders.length > config.receivables.maxReminders) throw new HttpError(400, `Hasta ${config.receivables.maxReminders} recordatorios por cobro`);
    await saveReceivableSettings(accountId, b);
    // Los días o la hora cambiaron: los cobros pendientes se reprograman con lo nuevo.
    await service.receivables.rescheduleAccount(accountId);
    await logEvent({ level: 'info', source: 'admin', message: `Configuración de cobros actualizada por ${req.user.email}`, accountId });
    return { settings: await getReceivableSettings(accountId) };
  });

  api.post('/api/receivables', team, async (req: any, reply) => {
    enabled();
    const accountId = await targetAccount(req.user, req.query.account_id);
    const b = parse(ReceivableBody, req.body);
    const { receivable, scheduled } = await createReceivable(service, accountId, b, { userId: req.user.id, source: 'manual', actor: req.user.email });
    return reply.code(201).send({ receivable: receivableOut(receivable), scheduled });
  });

  api.get('/api/receivables/:id', team, async (req: any) => {
    enabled();
    return { receivable: receivableOut(await owned(req.user, req.params.id)) };
  });

  api.put('/api/receivables/:id', team, async (req: any) => {
    enabled();
    const r = await owned(req.user, req.params.id);
    if (r.status !== 'pending') throw new HttpError(409, 'Solo se puede editar un cobro pendiente');
    const b = parse(ReceivablePatch, req.body);
    if (b.reminders && b.reminders.length > config.receivables.maxReminders) throw new HttpError(400, `Hasta ${config.receivables.maxReminders} recordatorios por cobro`);
    if (b.conversation_id) {
      const conv = await queryOne(`SELECT 1 FROM conversations WHERE id = $1 AND account_id = $2 AND contact_id = $3`, [b.conversation_id, r.account_id, r.contact_id]);
      if (!conv) throw new HttpError(400, 'La conversación no es de este cliente');
    }
    const updated = await queryOne<Receivable>(
      `UPDATE receivables SET concept = COALESCE($2, concept), amount_cents = COALESCE($3, amount_cents), currency = COALESCE($4, currency), due_date = COALESCE($5::date, due_date),
              payment_link = COALESCE($6, payment_link), reference = COALESCE($7, reference), reminders = CASE WHEN $8::boolean THEN $9::jsonb ELSE reminders END,
              conversation_id = COALESCE($10, conversation_id),
              overdue_notified_at = CASE WHEN $5::date IS NOT NULL AND $5::date <> due_date THEN NULL ELSE overdue_notified_at END, updated_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING ${RECEIVABLE_COLS}`,
      [r.id, b.concept ?? null, b.amount_cents ?? null, b.currency ?? null, b.due_date ?? null, b.payment_link ?? null, b.reference ?? null,
        b.reminders !== undefined, b.reminders ? JSON.stringify(b.reminders) : null, b.conversation_id ?? null],
    );
    if (!updated) throw new HttpError(409, 'El cobro ya no está pendiente');
    // Otra fecha o días: los recordatorios se vuelven a programar (y el aviso de vencido, si vence de nuevo).
    const scheduled = await service.receivables.schedule(updated);
    return { receivable: receivableOut(updated), scheduled };
  });

  for (const [path, status, verb] of [['paid', 'paid', 'marcado pagado'], ['cancel', 'canceled', 'cancelado']] as const) {
    api.post(`/api/receivables/:id/${path}`, team, async (req: any) => {
      enabled();
      const r = await owned(req.user, req.params.id);
      const b = parse(z.object({ note: z.string().trim().max(500).default('') }), req.body ?? {});
      const updated = await service.receivables.settle(r, status, { userId: req.user.id, note: b.note });
      if (!updated) throw new HttpError(409, 'El cobro ya no está pendiente');
      await logEvent({ level: 'info', source: 'admin', message: `Cobro ${verb} por ${req.user.email}: ${r.concept}`, accountId: r.account_id });
      return { receivable: receivableOut(updated) };
    });
  }

  api.post('/api/receivables/:id/remind', team, async (req: any) => {
    enabled();
    const r = await owned(req.user, req.params.id);
    if (r.status !== 'pending') throw new HttpError(409, 'El cobro ya no está pendiente');
    if (rateLimited(`receivable-remind:${r.id}`, config.receivables.manualRemindPerDay, 86400_000)) throw new HttpError(429, 'Ya se le recordó varias veces hoy: espera a mañana.');
    const res = await service.receivables.remind(r, { manual: true });
    if (!res.sent) throw new HttpError(422, `No se pudo enviar: ${res.reason}`);
    return { sent: true, receivable: receivableOut((await getReceivable(r.id))!) };
  });

  api.delete('/api/receivables/:id', admins, async (req: any) => {
    enabled();
    const r = await owned(req.user, req.params.id);
    await astore.cancelJobs('receivable_id', r.id);
    await query(`DELETE FROM receivables WHERE id = $1`, [r.id]);
    await logEvent({ level: 'warn', source: 'admin', message: `Cobro borrado por ${req.user.email}: ${r.concept}`, accountId: r.account_id });
    return { ok: true };
  });

  /* ------------------------------ Pagos recurrentes ------------------------------ */
  const ownedPlan = async (user: any, id: string) => assertAccount(user, await getPlan(id), 'Pago recurrente no encontrado');
  const todayOf = async (accountId: string) => todayIn((await astore.getSettings(accountId)).timezone);

  api.get('/api/receivable-plans', team, async (req: any) => {
    enabled();
    const accountId = await targetAccount(req.user, req.query.account_id);
    const q = parse(z.object({ contact_id: z.string().uuid().optional(), account_id: z.string().optional() }), req.query);
    const today = await todayOf(accountId);
    return { data: (await listPlans(accountId, q.contact_id)).map((p) => planOut(p, today)) };
  });

  api.post('/api/receivable-plans', team, async (req: any, reply) => {
    enabled();
    const accountId = await targetAccount(req.user, req.query.account_id);
    const { plan, created } = await createPlan(service, accountId, parse(PlanBody, req.body), { userId: req.user.id, actor: req.user.email });
    return reply.code(201).send({ plan: planOut(plan, await todayOf(accountId)), created });
  });

  api.put('/api/receivable-plans/:id', team, async (req: any) => {
    enabled();
    const p = await ownedPlan(req.user, req.params.id);
    const b = parse(PlanPatch, req.body);
    const merged = { ...p, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as ReceivablePlan;
    if (!dayOk(merged)) throw new HttpError(400, DAY_MSG.message);
    if (merged.ends_on && merged.ends_on < merged.starts_on) throw new HttpError(400, 'La fecha de fin es antes del inicio');
    if (merged.reminders && merged.reminders.length > config.receivables.maxReminders) throw new HttpError(400, `Hasta ${config.receivables.maxReminders} recordatorios por cobro`);
    if (b.conversation_id) {
      const conv = await queryOne(`SELECT 1 FROM conversations WHERE id = $1 AND account_id = $2 AND contact_id = $3`, [b.conversation_id, p.account_id, p.contact_id]);
      if (!conv) throw new HttpError(400, 'La conversación no es de este cliente');
    }
    await query(
      `UPDATE receivable_plans SET conversation_id = $2, concept = $3, amount_cents = $4, currency = $5, payment_link = $6, reference = $7, reminders = $8,
              frequency = $9, day = $10, starts_on = $11, ends_on = $12, max_payments = $13, active = $14, updated_at = now() WHERE id = $1`,
      [p.id, merged.conversation_id, merged.concept, merged.amount_cents, merged.currency, merged.payment_link, merged.reference,
        merged.reminders ? JSON.stringify(merged.reminders) : null, merged.frequency, merged.day, merged.starts_on, merged.ends_on, merged.max_payments, merged.active],
    );
    // Lo ya cobrado no cambia: los cambios aplican a los cobros que se creen de aquí en adelante.
    const created = merged.active ? await runPlans(service.receivables, new Date(), p.id) : 0;
    await logEvent({ level: 'info', source: 'admin', message: `Pago recurrente actualizado por ${req.user.email}: ${merged.concept}${merged.active ? '' : ' (pausado)'}`, accountId: p.account_id });
    return { plan: planOut((await getPlan(p.id))!, await todayOf(p.account_id)), created };
  });

  api.delete('/api/receivable-plans/:id', admins, async (req: any) => {
    enabled();
    const p = await ownedPlan(req.user, req.params.id);
    // Los cobros que ya creó se quedan (pendientes o pagados); solo deja de crear nuevos.
    await query(`DELETE FROM receivable_plans WHERE id = $1`, [p.id]);
    await logEvent({ level: 'warn', source: 'admin', message: `Pago recurrente borrado por ${req.user.email}: ${p.concept}`, accountId: p.account_id });
    return { ok: true };
  });

  /** Cobros de un contacto (ficha del cliente y conversación). */
  api.get('/api/contacts/:id/receivables', team, async (req: any) => {
    enabled();
    const c = assertAccount(req.user, await queryOne<{ id: string; account_id: string }>(`SELECT id, account_id FROM contacts WHERE id = $1`, [req.params.id]), 'Cliente no encontrado');
    if (!c) throw notFound('Cliente no encontrado');
    const st = await astore.getSettings(c.account_id);
    const { rows } = await listReceivables(c.account_id, { contactId: c.id, limit: 50 }, todayIn(st.timezone));
    return { data: rows.map(receivableOut) };
  });
}
