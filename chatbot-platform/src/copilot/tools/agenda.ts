/**
 * Herramientas del Copiloto para armar la agenda (fase 2): ver cómo está, los servicios, la disponibilidad de cada
 * persona y los enlaces para reservar. Crear y cambiar es reversible; borrar se confirma. Agendar, mover y cancelar citas
 * siguen en `operacion.ts`.
 */
import { z } from 'zod';
import { path, qs, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { stableJson } from '../store.js';
import { links } from '../summarize.js';
import { applyWeek, cents, DateStr, Id, isAdmin, money, Text, Week, weekDays, weekOut } from './common.js';

const services = async (ctx: Ctx) => (await ctx.call.get<any[]>('/api/services')) ?? [];
async function serviceOf(ctx: Ctx, id: string) {
  const s = (await services(ctx)).find((x) => x.id === id);
  if (!s) throw new ToolError('no_encontrado', 'Servicio no encontrado');
  return s;
}

const serviceOut = (s: any) => ({
  id: s.id, nombre: s.name, tipo: s.kind === 'call' ? 'llamada' : 'cita', duracion_min: s.duration_minutes, activo: s.active,
  atienden: s.assigned_user_ids?.length ? s.assigned_user_ids : undefined, anticipo: Number(s.deposit_cents) > 0 ? money(s.deposit_cents, s.deposit_currency) : undefined,
  horario_propio: s.hours ? weekOut(s.hours) : undefined,
});

export const verAgenda = defineTool({
  name: 'ver_agenda',
  area: 'agenda',
  roles: ['admin', 'agent'],
  description: 'Cómo está armada la agenda: zona horaria, servicios, disponibilidad de cada persona del equipo y enlaces para reservar (con sus ids).',
  schema: z.object({}),
  label: () => 'Revisando la agenda…',
  risk: () => 'read',
  async execute(_a, ctx) {
    const [info, list, team, booking] = await Promise.all([
      ctx.call.get<any>('/api/agenda/info'), services(ctx), ctx.call.get<any[]>('/api/team/agenda'),
      isAdmin(ctx) ? ctx.call.get<any[]>('/api/booking-links') : Promise.resolve(null),
    ]);
    return {
      title: `Revisé la agenda: ${list.length} servicio(s)`,
      links: [links.agendaTab('servicios', 'Ver servicios')],
      data: {
        zona_horaria: info?.timezone,
        servicios: list.map(serviceOut),
        equipo: (team ?? []).map((u) => ({
          id: u.id, nombre: u.name || u.email, horario: u.hours ? weekOut(u.hours) : 'el del negocio', dias_libres: u.time_off?.length ? u.time_off : undefined,
          calendario: u.calendar?.provider ?? undefined, servicios: (u.services ?? []).map((s: any) => s.name),
        })),
        ...(booking ? { enlaces_para_reservar: booking.map((l) => ({ id: l.id, nombre: l.name, url: l.url, activo: l.active, servicios: l.services?.length ? l.services : 'todos', persona: l.person ?? undefined })) } : {}),
      },
    };
  },
});

// --- Servicios -------------------------------------------------------------------------------------------------------

/** Lo que guarda un servicio (para comparar antes de deshacer y para regresarlo como estaba). */
const SERVICE_KEYS = ['name', 'kind', 'description', 'duration_minutes', 'buffer_minutes', 'capacity', 'min_notice_minutes', 'max_days_ahead', 'location', 'hours',
  'reminders', 'reminder_message', 'assigned_user_ids', 'deposit_cents', 'deposit_currency', 'active'] as const;
const serviceShape = (s: any) => Object.fromEntries(SERVICE_KEYS.map((k) => [k, s[k] ?? null]));

export const guardarServicio = defineTool({
  name: 'guardar_servicio',
  area: 'agenda',
  roles: ['admin'],
  description: 'Crea un servicio de la agenda (sin servicio_id) o cambia uno: nombre, duración, horario propio, recordatorios, quién atiende, anticipo, activo.',
  schema: z.object({
    servicio_id: Id.optional(),
    nombre: Text(120).optional(),
    tipo: z.enum(['cita', 'llamada']).optional(),
    descripcion: z.string().max(1000).optional(),
    duracion_min: z.number().int().min(5).max(1440).optional(),
    descanso_min: z.number().int().min(0).max(240).optional().describe('Entre una cita y otra'),
    cupo: z.number().int().min(1).max(100).optional().describe('Citas a la misma hora'),
    anticipacion_min: z.number().int().min(0).max(43200).optional().describe('Mínimo para agendar'),
    dias_adelante: z.number().int().min(1).max(365).optional(),
    lugar: z.string().max(500).optional(),
    horario: Week.nullable().optional().describe('Horario propio (solo los días que cambian); null = el del negocio'),
    recordatorios_min: z.array(z.number().int().min(5).max(20160)).max(5).optional().describe('Minutos antes de la cita'),
    mensaje_recordatorio: z.string().max(1000).optional(),
    atienden: z.array(Id).max(50).optional().describe('Ids del equipo (vacío = cualquiera)'),
    anticipo: z.number().min(0).max(1_000_000_000).optional().describe('En pesos; 0 = sin anticipo'),
    activo: z.boolean().optional(),
  }).refine((a) => a.servicio_id || a.nombre, 'Para crear un servicio, indica su nombre'),
  label: (a) => (a.servicio_id ? 'Cambiando el servicio…' : 'Creando el servicio…'),
  async risk(a, ctx) {
    if (a.anticipo === undefined) return 'reversible';
    const before = a.servicio_id ? Number((await serviceOf(ctx, a.servicio_id)).deposit_cents) : 0;
    return cents(a.anticipo) !== before && a.anticipo > 0
      ? { level: 'confirm', reasons: [`Los clientes pagarán un anticipo de ${money(cents(a.anticipo))} para confirmar su cita.`] }
      : 'reversible';
  },
  async execute(a, ctx) {
    const before = a.servicio_id ? await serviceOf(ctx, a.servicio_id) : null;
    let hours: unknown;
    if (a.horario === null) hours = null;
    else if (a.horario) hours = applyWeek(before?.hours ?? (await ctx.call.get<any>('/api/settings')).business_hours, a.horario);
    const body = {
      ...(a.nombre !== undefined ? { name: a.nombre } : {}), ...(a.tipo ? { kind: a.tipo === 'llamada' ? 'call' : 'appointment' } : {}),
      ...(a.descripcion !== undefined ? { description: a.descripcion } : {}), ...(a.duracion_min !== undefined ? { duration_minutes: a.duracion_min } : {}),
      ...(a.descanso_min !== undefined ? { buffer_minutes: a.descanso_min } : {}), ...(a.cupo !== undefined ? { capacity: a.cupo } : {}),
      ...(a.anticipacion_min !== undefined ? { min_notice_minutes: a.anticipacion_min } : {}), ...(a.dias_adelante !== undefined ? { max_days_ahead: a.dias_adelante } : {}),
      ...(a.lugar !== undefined ? { location: a.lugar } : {}), ...(hours !== undefined ? { hours } : {}),
      ...(a.recordatorios_min ? { reminders: a.recordatorios_min } : {}), ...(a.mensaje_recordatorio !== undefined ? { reminder_message: a.mensaje_recordatorio } : {}),
      ...(a.atienden ? { assigned_user_ids: a.atienden } : {}), ...(a.anticipo !== undefined ? { deposit_cents: cents(a.anticipo) } : {}),
      ...(a.activo !== undefined ? { active: a.activo } : {}),
    };
    const s = before ? await ctx.call.send<any>('PUT', path`/api/services/${before.id}`, body) : await ctx.call.send<any>('POST', '/api/services', body);
    const days = weekDays(a.horario);
    return {
      title: before ? `Cambié el servicio «${s.name}»${days.length ? ` (horario: ${days.join(', ')})` : ''}` : `Creé el servicio «${s.name}» (${s.duration_minutes} min)`,
      links: [links.agendaTab('servicios', 'Ver servicios')],
      before: before ? serviceShape(before) : null,
      after: serviceShape(s),
      undo: { label: 'Deshacer', custom: { tool: 'guardar_servicio', params: { id: s.id, before: before ? serviceShape(before) : null, after: serviceShape(s) } } },
      data: serviceOut(s),
    };
  },
  async undo(p: { id: string; before: Record<string, unknown> | null; after: unknown }, ctx) {
    const s = (await services(ctx)).find((x) => x.id === p.id);
    if (!s) { if (!p.before) return; throw new ToolError('conflicto', 'El servicio ya no existe.'); }
    if (stableJson(serviceShape(s)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El servicio cambió después; para no perder esos cambios, no lo regresé.');
    if (p.before) await ctx.call.send('PUT', path`/api/services/${p.id}`, p.before);
    else await ctx.call.send('DELETE', path`/api/services/${p.id}`);
  },
});

// --- Disponibilidad del equipo ---------------------------------------------------------------------------------------

async function personOf(ctx: Ctx, id: string) {
  const u = ((await ctx.call.get<any[]>('/api/team/agenda')) ?? []).find((x) => x.id === id);
  if (!u) throw new ToolError('no_encontrado', 'Esa persona no está en el equipo (o solo puedes cambiar tu propia disponibilidad).');
  return u;
}
const scheduleShape = (u: any) => ({ hours: u.hours ?? null, time_off: u.time_off ?? [], meeting_url: u.meeting_url ?? '' });
const TimeOff = z.object({ desde: DateStr, hasta: DateStr, nota: z.string().trim().max(120).optional() });

export const cambiarDisponibilidad = defineTool({
  name: 'cambiar_disponibilidad',
  area: 'agenda',
  roles: ['admin', 'agent'],
  description: 'Cambia el horario de una persona del equipo (o el tuyo), sus días libres o su enlace fijo de videollamada. Un agente solo cambia el suyo.',
  schema: z.object({
    persona_id: Id.optional().describe('Sin id: tú'),
    horario: Week.nullable().optional().describe('Solo los días que cambian; null = el del negocio'),
    agregar_dias_libres: z.array(TimeOff).max(20).optional(),
    quitar_dias_libres: z.array(DateStr).max(20).optional().describe('Por su fecha de inicio'),
    enlace_videollamada: z.union([z.literal(''), z.string().trim().url().max(500)]).optional(),
  }).refine((a) => a.horario !== undefined || a.agregar_dias_libres?.length || a.quitar_dias_libres?.length || a.enlace_videollamada !== undefined, 'Indica qué cambiar'),
  label: () => 'Cambiando la disponibilidad…',
  risk: () => 'reversible',
  targets: (a, ctx) => [{ kind: 'user', id: a.persona_id ?? ctx.user.id }],
  async execute(a, ctx) {
    const u = await personOf(ctx, a.persona_id ?? ctx.user.id);
    let hours = u.hours ?? null;
    if (a.horario === null) hours = null;
    else if (a.horario) {
      // Quien sigue el horario del negocio parte de ese; si no se puede leer (un agente), hay que dar los 7 días.
      const base = u.hours ?? (await ctx.call.get<any>('/api/settings').then((s) => s.business_hours).catch(() => null));
      if (!base && weekDays(a.horario).length < 7) throw new ToolError('datos_invalidos', 'Sigues el horario del negocio: indica el horario de los 7 días.');
      hours = applyWeek(base ?? {}, a.horario);
    }
    const drop = new Set(a.quitar_dias_libres ?? []);
    const time_off = [...(u.time_off ?? []).filter((t: any) => !drop.has(t.from)), ...(a.agregar_dias_libres ?? []).map((t) => ({ from: t.desde, to: t.hasta, note: t.nota ?? '' }))];
    const body = { hours, time_off, ...(a.enlace_videollamada !== undefined ? { meeting_url: a.enlace_videollamada } : {}) };
    await ctx.call.send('PUT', path`/api/team/${u.id}/schedule`, body);
    const after = await personOf(ctx, u.id);
    return {
      title: `Cambié ${u.id === ctx.user.id ? 'tu disponibilidad' : `la disponibilidad de ${u.name || u.email}`}`,
      links: [links.agendaTab('equipo', 'Ver disponibilidad')],
      before: scheduleShape(u),
      after: scheduleShape(after),
      undo: { label: 'Deshacer', custom: { tool: 'cambiar_disponibilidad', params: { id: u.id, before: scheduleShape(u), after: scheduleShape(after) } } },
      data: { horario: after.hours ? weekOut(after.hours) : 'el del negocio', dias_libres: after.time_off, enlace_videollamada: after.meeting_url || undefined },
    };
  },
  async undo(p: { id: string; before: any; after: unknown }, ctx) {
    const u = await personOf(ctx, p.id);
    if (stableJson(scheduleShape(u)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La disponibilidad cambió después; para no perder esos cambios, no la regresé.');
    await ctx.call.send('PUT', path`/api/team/${p.id}/schedule`, p.before);
  },
});

// --- Enlaces para reservar -------------------------------------------------------------------------------------------

async function bookingLinkOf(ctx: Ctx, id: string) {
  const l = ((await ctx.call.get<any[]>('/api/booking-links')) ?? []).find((x) => x.id === id);
  if (!l) throw new ToolError('no_encontrado', 'Enlace para reservar no encontrado');
  return l;
}
const linkShape = (l: any) => ({ name: l.name, service_ids: l.service_ids ?? [], user_id: l.user_id ?? null, active: l.active });

export const enlaceParaReservar = defineTool({
  name: 'enlace_para_reservar',
  area: 'agenda',
  roles: ['admin'],
  description: 'Crea (sin enlace_id) o cambia un enlace de la página pública para reservar: nombre, qué servicios ofrece, si es de una persona y si está activo.',
  schema: z.object({
    enlace_id: Id.optional(),
    nombre: Text(120).optional(),
    servicio_ids: z.array(Id).max(50).optional().describe('Vacío = todos los activos'),
    persona_id: Id.nullable().optional().describe('Enlace de una persona: siempre con ella'),
    activo: z.boolean().optional(),
  }).refine((a) => a.enlace_id || a.nombre, 'Para crear un enlace, indica su nombre'),
  label: (a) => (a.enlace_id ? 'Cambiando el enlace para reservar…' : 'Creando el enlace para reservar…'),
  risk: () => 'reversible',
  async execute(a, ctx) {
    const before = a.enlace_id ? await bookingLinkOf(ctx, a.enlace_id) : null;
    const body = {
      ...(a.nombre !== undefined ? { name: a.nombre } : {}), ...(a.servicio_ids ? { service_ids: a.servicio_ids } : {}),
      ...(a.persona_id !== undefined ? { user_id: a.persona_id } : {}), ...(a.activo !== undefined ? { active: a.activo } : {}),
    };
    const l = before ? await ctx.call.send<any>('PUT', path`/api/booking-links/${before.id}`, body) : await ctx.call.send<any>('POST', '/api/booking-links', body);
    return {
      title: before ? `Cambié el enlace para reservar «${l.name}»` : `Creé el enlace para reservar «${l.name}»`,
      links: [links.agendaTab('enlaces', 'Ver enlaces para reservar')],
      before: before ? linkShape(before) : null,
      after: linkShape(l),
      undo: { label: 'Deshacer', custom: { tool: 'enlace_para_reservar', params: { id: l.id, before: before ? linkShape(before) : null, after: linkShape(l) } } },
      data: { enlace_id: l.id, url: l.url, activo: l.active, servicios: l.services?.length ? l.services : 'todos', persona: l.person ?? undefined },
    };
  },
  async undo(p: { id: string; before: Record<string, unknown> | null; after: unknown }, ctx) {
    const l = ((await ctx.call.get<any[]>('/api/booking-links')) ?? []).find((x) => x.id === p.id);
    if (!l) { if (!p.before) return; throw new ToolError('conflicto', 'El enlace ya no existe.'); }
    if (stableJson(linkShape(l)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El enlace cambió después; para no perder esos cambios, no lo regresé.');
    if (p.before) await ctx.call.send('PUT', path`/api/booking-links/${p.id}`, p.before);
    else await ctx.call.send('DELETE', path`/api/booking-links/${p.id}`);
  },
});

// --- Borrar ----------------------------------------------------------------------------------------------------------

export const borrarDeLaAgenda = defineTool({
  name: 'borrar_de_la_agenda',
  area: 'agenda',
  roles: ['admin'],
  description: 'Borra un servicio o un enlace para reservar (requiere confirmación; no se puede deshacer).',
  schema: z.object({ tipo: z.enum(['servicio', 'enlace']), id: Id }),
  label: () => 'Preparando el borrado…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    if (a.tipo === 'enlace') {
      const l = await bookingLinkOf(ctx, a.id);
      return { title: `Borrar el enlace para reservar «${l.name}»`, lines: [`Deja de funcionar: ${l.url}`, 'No se puede deshacer.'] };
    }
    const s = await serviceOf(ctx, a.id);
    const at = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
    const upcoming = ((await ctx.call.get<any[]>(`/api/appointments${qs({ from: at(0), to: at(400), status: 'confirmed' })}`)) ?? []).filter((x) => x.service_id === s.id).length;
    return {
      title: `Borrar el servicio «${s.name}»`,
      lines: [upcoming ? `Tiene ${upcoming} cita(s) próximas: se quedan en la agenda, sin servicio.` : 'No tiene citas próximas.', 'Ya no se ofrece para agendar. No se puede deshacer.'],
    };
  },
  async execute(a, ctx) {
    if (a.tipo === 'enlace') {
      const l = await bookingLinkOf(ctx, a.id);
      await ctx.call.send('DELETE', path`/api/booking-links/${l.id}`);
      return { title: `Borré el enlace para reservar «${l.name}»`, links: [links.agendaTab('enlaces', 'Ver enlaces para reservar')], data: { borrado: true } };
    }
    const s = await serviceOf(ctx, a.id);
    await ctx.call.send('DELETE', path`/api/services/${s.id}`);
    return { title: `Borré el servicio «${s.name}»`, links: [links.agendaTab('servicios', 'Ver servicios')], data: { borrado: true } };
  },
});

export const AGENDA_TOOLS = [verAgenda, guardarServicio, cambiarDisponibilidad, enlaceParaReservar, borrarDeLaAgenda];
