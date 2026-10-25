/**
 * Cobros de la cuenta (panel): lo que deben los clientes, sus recordatorios de pago y la configuración de cobro.
 * Admin y agentes ven y registran cobros y los marcan pagados; solo un admin borra o cambia la configuración.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, HttpError, notFound, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import * as astore from '../automation/store.js';
import { WaTemplateRefSchema } from '../automation/types.js';
import {
  getReceivable, getReceivableSettings, listReceivables, RECEIVABLE_COLS, saveReceivableSettings, todayIn, type Receivable,
} from '../receivables/index.js';
import type { ChatService } from '../service.js';
import { parse } from './util.js';

const Day = z.number().int().min(-60).max(120);
const Days = z.array(Day).max(20).transform((d) => [...new Set(d)].sort((a, b) => a - b));
const Link = z.union([z.literal(''), z.string().trim().max(500).url().refine((u) => /^https:\/\//i.test(u), 'El enlace de pago debe empezar con https://')]);

export const ReceivableBody = z.object({
  contact_id: z.string().uuid(),
  conversation_id: z.string().uuid().nullable().optional(),
  concept: z.string().trim().min(1).max(200),
  amount_cents: z.number().int().min(1).max(100_000_000_000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('MXN'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Fecha inválida'),
  payment_link: Link.default(''),
  reference: z.string().trim().max(100).default(''),
  /** null = los días de la cuenta. */
  reminders: Days.nullable().default(null),
});
const ReceivablePatch = ReceivableBody.omit({ contact_id: true }).partial();

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

export const receivableOut = (r: Receivable & { contact_name?: string; contact_phone?: string | null }) => ({
  id: r.id, contact_id: r.contact_id, conversation_id: r.conversation_id, contact_name: r.contact_name ?? undefined, contact_phone: r.contact_phone ?? undefined,
  concept: r.concept, amount_cents: Number(r.amount_cents), currency: r.currency, due_date: r.due_date, status: r.status,
  paid_at: r.paid_at, paid_note: r.paid_note, payment_link: r.payment_link, reference: r.reference, source: r.source, reminders: r.reminders,
  reminders_sent: r.reminders_sent, last_reminded_at: r.last_reminded_at, paused_until: r.paused_until, created_at: r.created_at,
});

/** Alta de un cobro (panel o API): el contacto es de la cuenta y la conversación, si se da, también. */
export async function createReceivable(service: ChatService, accountId: string, b: z.infer<typeof ReceivableBody>, o: { userId: string | null; source: 'manual' | 'api'; actor: string }) {
  if (b.reminders && b.reminders.length > config.receivables.maxReminders) throw new HttpError(400, `Hasta ${config.receivables.maxReminders} recordatorios por cobro`);
  const contact = await queryOne<{ id: string }>(`SELECT id FROM contacts WHERE id = $1 AND account_id = $2`, [b.contact_id, accountId]);
  if (!contact) throw new HttpError(400, 'El cliente no existe en esta cuenta');
  if (b.conversation_id) {
    const conv = await queryOne(`SELECT 1 FROM conversations WHERE id = $1 AND account_id = $2 AND contact_id = $3`, [b.conversation_id, accountId, contact.id]);
    if (!conv) throw new HttpError(400, 'La conversación no es de este cliente');
  }
  const r = (await queryOne<Receivable>(
    `INSERT INTO receivables (account_id, contact_id, conversation_id, concept, amount_cents, currency, due_date, payment_link, reference, reminders, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${RECEIVABLE_COLS}`,
    [accountId, contact.id, b.conversation_id ?? null, b.concept, b.amount_cents, b.currency, b.due_date, b.payment_link, b.reference,
      b.reminders ? JSON.stringify(b.reminders) : null, o.source, o.userId],
  ))!;
  const scheduled = await service.receivables.schedule(r);
  await logEvent({ level: 'info', source: 'admin', message: `Cobro registrado por ${o.actor}: ${r.concept} (${r.currency} ${(Number(r.amount_cents) / 100).toFixed(2)}, vence ${r.due_date}); ${scheduled} recordatorio(s) programado(s)`, accountId });
  return { receivable: r, scheduled };
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
    const { rows, totals } = await listReceivables(accountId, { status: q.status, contactId: q.contact_id, search: q.search }, today);
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
