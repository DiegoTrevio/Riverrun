import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, conversationFor, HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { buildIcs, busyFor, computeSlots } from '../automation/agenda.js';
import * as astore from '../automation/store.js';
import { spanishDate, spanishTime } from '../automation/time.js';
import { ServiceBodySchema, type ServiceBody } from '../automation/types.js';
import { query } from '../db.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { User } from '../types.js';
import { parse } from './util.js';

const serviceFor = async (user: User, id: string) => assertAccount(user, await astore.getService(id), 'Servicio no encontrado');
/** Un agente solo ve sus citas (asignadas a él o de sus conversaciones o contactos); las demás no existen para él. */
const appointmentFor = async (user: User, id: string) => {
  const a = assertAccount(user, await astore.getAppointment(id), 'Cita no encontrada');
  if (user.role === 'agent' && !(await astore.appointmentVisibleTo(a.id, user.id))) throw new HttpError(404, 'Cita no encontrada');
  return a;
};

async function checkUsers(accountId: string, ids: string[]) {
  if (!ids.length) return;
  const team = await astore.teamMembers(accountId);
  if (ids.some((id) => !team.some((u) => u.id === id))) throw new HttpError(400, 'Un usuario asignado no pertenece a la cuenta');
}

const SLOT = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Horario en formato AAAA-MM-DDTHH:MM');

export async function agendaRoutes(api: FastifyInstance, service: ChatService) {
  const admins = { preHandler: requireRole('admin') };

  /* ------------------------------ Servicios ------------------------------ */
  api.get('/api/services', async (req: any) => astore.listServices(scopeAccount(req.user, req.query.account_id)));

  api.post('/api/services', admins, async (req: any) => {
    const body = parse(ServiceBodySchema, req.body);
    const accountId = await targetAccount(req.user, req.body?.account_id);
    await checkUsers(accountId, body.assigned_user_ids);
    return astore.saveService(accountId, body);
  });

  api.put('/api/services/:id', admins, async (req: any) => {
    const existing = await serviceFor(req.user, req.params.id);
    const body = parse(ServiceBodySchema, { ...existing, ...((req.body ?? {}) as Partial<ServiceBody>) });
    await checkUsers(existing.account_id, body.assigned_user_ids);
    return astore.saveService(existing.account_id, body, existing.id);
  });

  api.delete('/api/services/:id', admins, async (req: any) => {
    const s = await serviceFor(req.user, req.params.id);
    await astore.deleteService(s.id);
    return { ok: true };
  });

  /** Horarios libres (para agendar desde el panel). */
  api.get('/api/services/:id/slots', async (req: any) => {
    const s = await serviceFor(req.user, req.params.id);
    const settings = await astore.getSettings(s.account_id);
    const days = Math.min(Number(req.query.days) || 14, s.max_days_ahead);
    const now = new Date();
    const busy = await busyFor(s, now, new Date(now.getTime() + (days + 1) * 86400_000));
    return computeSlots(s, settings, busy, now, { days }).map((x) => ({
      key: x.key,
      date: x.key.slice(0, 10),
      label: `${spanishDate(x.start, settings.timezone)}, ${spanishTime(x.start, settings.timezone)}`,
    }));
  });

  /** Zona horaria de la cuenta (para mostrar la agenda en la hora del negocio, no la del navegador). */
  api.get('/api/agenda/info', async (req: any) => {
    const accountId = req.user.role === 'superadmin' ? req.query.account_id : req.user.account_id;
    if (!accountId) return { timezone: 'America/Mexico_City' };
    const settings = await astore.getSettings(await targetAccount(req.user, accountId));
    return { timezone: settings.timezone };
  });

  /* ------------------------------ Citas (administradores y agentes) ------------------------------ */
  api.get('/api/appointments', async (req: any) => {
    const q = req.query as Record<string, string | undefined>;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 86400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 60 * 86400_000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new HttpError(400, 'Fechas inválidas');
    const visibleTo = req.user.role === 'agent' ? req.user.id : undefined;
    return astore.listAppointments(scopeAccount(req.user, q.account_id), { from, to, status: q.status || undefined, visibleTo });
  });

  api.post('/api/appointments', async (req: any) => {
    const b = parse(
      z.object({
        service_id: z.string().uuid(),
        slot: SLOT,
        conversation_id: z.string().uuid().nullable().default(null),
        customer_name: z.string().max(120).default(''),
        customer_phone: z.string().max(30).default(''),
        notes: z.string().max(2000).default(''),
        notify_customer: z.boolean().default(true),
        force: z.boolean().default(false),
        assigned_user_id: z.string().uuid().nullable().default(null),
      }),
      req.body,
    );
    const svc = await serviceFor(req.user, b.service_id);
    if (b.force && req.user.role === 'agent') throw new HttpError(403, 'Solo un administrador puede agendar fuera de los horarios disponibles');
    // Un agente solo agenda citas para sí mismo: así las ve después.
    if (req.user.role === 'agent' && b.assigned_user_id && b.assigned_user_id !== req.user.id) throw new HttpError(403, 'Solo un administrador asigna citas a otras personas');
    const assignedUserId = req.user.role === 'agent' ? req.user.id : b.assigned_user_id;
    await checkUsers(svc.account_id, assignedUserId ? [assignedUserId] : []);
    const conv = b.conversation_id ? await conversationFor(req.user, b.conversation_id) : null;
    if (conv && conv.account_id !== svc.account_id) throw new HttpError(400, 'La conversación es de otra cuenta');
    const contact = conv ? await store.getContact(conv.contact_id) : null;
    if (!contact && !b.customer_name) throw new HttpError(400, 'Indica el nombre del cliente o elige una conversación');
    const r = await service.agenda.book({
      accountId: svc.account_id,
      serviceId: svc.id,
      slotKey: b.slot,
      conversation: conv,
      contact,
      customerName: b.customer_name || undefined,
      customerPhone: b.customer_phone.replace(/\D/g, '') || undefined,
      notes: b.notes,
      source: 'panel',
      force: b.force,
      assignedUserId,
    });
    if (!r.ok) throw new HttpError(409, `${r.reason}${r.alternatives.length ? `. Disponibles: ${r.alternatives.join('; ')}` : ''}`);
    const confirmation = b.notify_customer && conv ? await service.agenda.sendConfirmation(r.appointment) : null;
    return { ...r.appointment, confirmation };
  });

  api.put('/api/appointments/:id', async (req: any) => {
    const a = await appointmentFor(req.user, req.params.id);
    const b = parse(
      z.object({
        status: z.enum(['confirmed', 'completed', 'no_show']).optional(),
        notes: z.string().max(2000).optional(),
        slot: SLOT.optional(),
        force: z.boolean().default(false),
        assigned_user_id: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    if (b.force && req.user.role === 'agent') throw new HttpError(403, 'Solo un administrador puede forzar un horario');
    if (req.user.role === 'agent' && b.assigned_user_id !== undefined && b.assigned_user_id !== req.user.id) throw new HttpError(403, 'Solo un administrador asigna citas a otras personas');
    if (b.assigned_user_id) await checkUsers(a.account_id, [b.assigned_user_id]);
    // Reactivar una cita cancelada la pondría de nuevo en el horario sin revisar si otra persona ya lo reservó.
    if (b.status === 'confirmed' && a.status === 'cancelled') throw new HttpError(409, 'La cita está cancelada. Para ese horario, crea una nueva reserva.');
    if (b.slot) {
      const r = await service.agenda.reschedule(a.id, b.slot, b.force);
      if (!r.ok) throw new HttpError(409, r.reason);
    }
    await query(
      `UPDATE appointments SET status = COALESCE($2, status), notes = COALESCE($3, notes),
         assigned_user_id = CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_user_id END, updated_at = now() WHERE id = $1`,
      [a.id, b.status ?? null, b.notes ?? null, b.assigned_user_id !== undefined, b.assigned_user_id ?? null],
    );
    if (b.status && b.status !== 'confirmed') await astore.cancelJobs('appointment_id', a.id);
    return astore.getAppointment(a.id);
  });

  api.post('/api/appointments/:id/cancel', async (req: any) => {
    const a = await appointmentFor(req.user, req.params.id);
    const b = parse(z.object({ reason: z.string().max(300).default('Cancelada desde el panel'), notify_customer: z.boolean().default(true) }), req.body);
    const cancelled = await service.agenda.cancel(a.id, b.reason, 'panel');
    if (!cancelled) throw new HttpError(400, 'La cita ya no está confirmada');
    if (b.notify_customer && a.conversation_id) {
      await service.outbound.send(a.conversation_id, {
        text: 'Hola {{nombre}}, tu {{cita.tipo}} de {{cita.servicio}} del {{cita.fecha}} a las {{cita.hora}} fue cancelada. Si quieres agendar otra, respóndenos por aquí.',
        source: 'booking',
        transactional: true,
        allowWhenHuman: true,
        appointment: a,
      });
    }
    return cancelled;
  });
}

/** Calendario suscribible (Google Calendar, Outlook, Apple): URL secreta por cuenta. */
export async function calendarRoutes(app: FastifyInstance) {
  app.get('/calendar/:file', async (req: any, reply) => {
    const token = String(req.params.file).replace(/\.ics$/, '');
    const acc = token ? await astore.accountByCalendarToken(token) : null;
    if (!acc) return reply.code(404).send('not found');
    reply.header('content-type', 'text/calendar; charset=utf-8').header('cache-control', 'private, max-age=300');
    return buildIcs(acc.id, acc.name);
  });
}
