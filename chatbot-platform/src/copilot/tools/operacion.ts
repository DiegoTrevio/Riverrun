/**
 * Herramientas del Copiloto para operar el día a día: agenda, oportunidades, cobros, cotizaciones y estadísticas.
 * Lo que avisa al cliente, cobra, envía o cancela se confirma; mover, reagendar y corregir es reversible.
 */
import { z } from 'zod';
import { localParts } from '../../automation/time.js';
import { config } from '../../config.js';
import { path, qs, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { stableJson } from '../store.js';
import { day, links, when } from '../summarize.js';
import { Id, nameOf, profile } from './common.js';

const Text = (max: number) => z.string().trim().min(1).max(max);
const Slot = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Usa AAAA-MM-DDTHH:MM (hora del negocio)');
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa AAAA-MM-DD');
const Money = z.number().positive().max(1_000_000_000).describe('En pesos (o la moneda indicada), con hasta 2 decimales');
const cents = (n: number) => Math.round(n * 100);
const money = (c: number | string | null | undefined, cur = 'MXN') => (c == null ? 'por confirmar' : `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`);

// --- Agenda ---------------------------------------------------------------------------------------------------------

async function serviceOf(ctx: Ctx, id: string) {
  const s = ((await ctx.call.get<any[]>('/api/services')) ?? []).find((x) => x.id === id);
  if (!s) throw new ToolError('no_encontrado', 'Servicio no encontrado');
  return s;
}

/**
 * Una cita visible para quien pregunta. El panel solo las lista por fechas (hasta mil): primero las próximas y, si no
 * está, las de los últimos 90 días.
 */
async function appointmentOf(ctx: Ctx, id: string) {
  const at = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
  for (const [from, to] of [[at(-1), at(400)], [at(-90), at(0)]]) {
    const a = ((await ctx.call.get<any[]>(`/api/appointments${qs({ from, to })}`)) ?? []).find((x) => x.id === id);
    if (a) return a;
  }
  throw new ToolError('no_encontrado', 'Cita no encontrada');
}
const slotOf = (a: any, tz: string) => { const p = localParts(new Date(a.starts_at), tz); return `${p.date}T${p.time}`; };
const apptShape = (a: any, tz: string) => ({ slot: slotOf(a, tz), notes: a.notes ?? '', status: a.status, assigned_user_id: a.assigned_user_id ?? null });
const STATUS_ES: Record<string, string> = { confirmed: 'confirmada', completed: 'completada', no_show: 'no asistió', cancelled: 'cancelada' };
const apptOut = (a: any, tz: string) => ({
  id: a.id, servicio: a.service_name, cliente: a.customer_name || undefined, inicio: when(a.starts_at, tz), estado: STATUS_ES[a.status] ?? a.status,
  atiende: a.assigned_user_name ?? undefined, conversacion_id: a.conversation_id ?? undefined,
});

export const horariosLibres = defineTool({
  name: 'horarios_libres',
  area: 'agenda',
  roles: ['admin', 'agent'],
  description: 'Horarios libres de un servicio de la agenda (con quién atiende cada uno): en los próximos días, un día (fecha) o a partir de un día (desde).',
  schema: z.object({ servicio_id: Id, dias: z.number().int().min(1).max(60).optional(), fecha: DateStr.optional().describe('Solo ese día'), desde: DateStr.optional().describe('A partir de ese día') }),
  label: () => 'Buscando horarios libres…',
  risk: () => 'read',
  async execute(a, ctx) {
    const s = await serviceOf(ctx, a.servicio_id);
    // Los horarios se cuentan desde hoy: para un día más adelante se piden también los días hasta él.
    const start = a.fecha ?? a.desde;
    const ahead = start ? Math.max(0, Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${localParts(new Date(), ctx.timezone).date}T00:00:00Z`)) / 86400_000)) : 0;
    const days = Math.min(60, ahead + (a.fecha ? 1 : a.dias ?? 14));
    const slots = (await ctx.call.get<any[]>(`${path`/api/services/${s.id}/slots`}${qs({ days })}`)) ?? [];
    const shown = slots.filter((x) => (a.fecha ? x.date === a.fecha : !a.desde || x.date >= a.desde)).slice(0, 30);
    return { title: `Busqué horarios libres de ${s.name}: ${shown.length}`, links: [links.agenda()], data: { servicio: s.name, horarios: shown.map((x) => ({ horario: x.key, texto: x.label })), hay_mas: slots.length > shown.length || undefined } };
  },
});

export const buscarCitas = defineTool({
  name: 'buscar_citas',
  area: 'agenda',
  roles: ['admin', 'agent'],
  description: 'Citas entre dos fechas (por omisión, de hoy a 14 días), opcionalmente por estado.',
  schema: z.object({ desde: DateStr.optional(), hasta: DateStr.optional(), estado: z.enum(['confirmed', 'completed', 'cancelled', 'no_show']).optional() }),
  label: () => 'Revisando la agenda…',
  risk: () => 'read',
  async execute(a, ctx) {
    const from = a.desde ? new Date(`${a.desde}T00:00:00Z`).getTime() - 86400_000 : Date.now() - 3600_000;
    const to = a.hasta ? new Date(`${a.hasta}T23:59:59Z`).getTime() + 86400_000 : Date.now() + 14 * 86400_000;
    const list = (await ctx.call.get<any[]>(`/api/appointments${qs({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), status: a.estado })}`)) ?? [];
    const inRange = list.filter((x) => { const d = localParts(new Date(x.starts_at), ctx.timezone).date; return (!a.desde || d >= a.desde) && (!a.hasta || d <= a.hasta); });
    // El nombre de quien reserva en la página pública lo escribe cualquiera.
    return { title: `Revisé la agenda: ${inRange.length} cita(s)`, links: [links.agenda()], untrusted: inRange.length > 0, contactIds: inRange.map((x) => x.contact_id).filter(Boolean), data: { citas: inRange.slice(0, 40).map((x) => apptOut(x, ctx.timezone)) } };
  },
});

const CrearCita = z.object({
  servicio_id: Id,
  horario: Slot,
  conversacion_id: Id.optional().describe('La conversación del cliente'),
  contacto_id: Id.optional().describe('O el contacto (se usa su conversación)'),
  nombre_cliente: Text(120).optional().describe('Solo si el cliente no está en contactos'),
  telefono: z.string().trim().max(30).optional(),
  notas: z.string().trim().max(2000).optional(),
  avisar_al_cliente: z.boolean().default(true).describe('Mandarle la confirmación'),
  atiende: Id.optional().describe('Id de la persona del equipo que atiende'),
}).refine((a) => a.conversacion_id || a.contacto_id || a.nombre_cliente, 'Indica la conversación, el contacto o el nombre del cliente');

/**
 * La conversación del cliente para la cita: la indicada, la del contacto o, con solo nombre y teléfono, la del cliente que
 * ya tiene ese número. Así la cita no queda suelta en la agenda, sin la ficha del cliente.
 */
async function citaConversation(a: z.infer<typeof CrearCita>, ctx: Ctx): Promise<string | null> {
  if (a.conversacion_id) return a.conversacion_id;
  if (a.contacto_id) {
    const id = (await profile(ctx, a.contacto_id)).conversations?.[0]?.id;
    if (!id) throw new ToolError('no_encontrado', 'Ese contacto no tiene conversación; da su nombre y teléfono.');
    return id;
  }
  const digits = (a.telefono ?? '').replace(/\D/g, '').slice(-10);
  if (digits.length < 8) return null;
  const rows = (await ctx.call.get<any[]>(`/api/conversations${qs({ search: digits, limit: 5 })}`)) ?? [];
  const same = rows.filter((r) => String(r.phone ?? '').replace(/\D/g, '').endsWith(digits));
  return same.length === 1 ? same[0].id : null;
}

export const crearCita = defineTool({
  name: 'crear_cita',
  area: 'agenda',
  roles: ['admin', 'agent'],
  description: 'Agenda una cita en un horario libre. Si se avisa al cliente o el servicio pide anticipo, se confirma antes.',
  schema: CrearCita,
  label: () => 'Agendando la cita…',
  async risk(a, ctx) {
    const s = await serviceOf(ctx, a.servicio_id);
    const reasons = [
      ...(a.avisar_al_cliente ? ['Al cliente le llega la confirmación de la cita.'] : []),
      ...(Number(s.deposit_cents) > 0 ? [`El servicio pide un anticipo de ${money(s.deposit_cents, s.deposit_currency)}.`] : []),
    ];
    return reasons.length ? { level: 'confirm', reasons } : 'reversible';
  },
  async targets(a, ctx) {
    const conv = await citaConversation(a, ctx);
    return conv ? [{ kind: 'conversation', id: conv }] : [];
  },
  events: (a) => [{ type: 'appointment_booked', value: a.servicio_id }],
  async preview(a, ctx) {
    const s = await serviceOf(ctx, a.servicio_id);
    const conv = await citaConversation(a, ctx);
    const who = conv ? nameOf((await ctx.call.get<any>(path`/api/conversations/${conv}`))?.contact) : a.nombre_cliente;
    return {
      title: `Agendar ${s.name} para ${who} el ${a.horario.replace('T', ' a las ')}`,
      lines: [a.avisar_al_cliente ? 'Le mandamos la confirmación al cliente.' : 'No se le avisa al cliente.', ...(a.notas ? [`Notas: ${a.notas}`] : [])],
    };
  },
  async execute(a, ctx) {
    const s = await serviceOf(ctx, a.servicio_id);
    const conv = await citaConversation(a, ctx);
    const r = await ctx.call.send<any>('POST', '/api/appointments', {
      service_id: s.id, slot: a.horario, conversation_id: conv, customer_name: a.nombre_cliente ?? '', customer_phone: a.telefono ?? '',
      notes: a.notas ?? '', notify_customer: a.avisar_al_cliente, assigned_user_id: a.atiende ?? null,
    });
    return {
      title: `Agendé ${s.name} para ${r.customer_name || 'el cliente'} el ${when(r.starts_at, ctx.timezone)}`,
      links: [links.agenda(), ...(r.conversation_id ? [links.conversation(r.conversation_id)] : [])],
      contactIds: r.contact_id ? [r.contact_id] : [],
      after: apptShape(r, ctx.timezone),
      // Si ya se le avisó al cliente, deshacer en silencio lo confundiría: se cancela con cancelar_cita.
      undo: a.avisar_al_cliente ? null : { label: 'Deshacer', custom: { tool: 'crear_cita', params: { id: r.id, after: apptShape(r, ctx.timezone) } } },
      data: { cita_id: r.id, inicio: when(r.starts_at, ctx.timezone), aviso_al_cliente: r.confirmation?.sent ?? false, motivo_sin_aviso: r.confirmation?.reason },
    };
  },
  async undo(p: { id: string; after: unknown }, ctx) {
    const a = await appointmentOf(ctx, p.id);
    if (a.status === 'cancelled') return;
    if (stableJson(apptShape(a, ctx.timezone)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La cita cambió después; para no perder esos cambios, no la cancelé.');
    await ctx.call.send('POST', path`/api/appointments/${p.id}/cancel`, { reason: 'Deshecha desde el Copiloto', notify_customer: false });
  },
});

const STATUS_IN = { confirmada: 'confirmed', completada: 'completed', no_asistio: 'no_show' } as const;

export const cambiarCita = defineTool({
  name: 'cambiar_cita',
  area: 'agenda',
  roles: ['admin', 'agent'],
  description: 'Reagenda una cita a otro horario libre, cambia sus notas, quién atiende o la marca como completada o «no asistió».',
  schema: z.object({
    cita_id: Id,
    horario: Slot.optional(),
    notas: z.string().trim().max(2000).optional(),
    estado: z.enum(['confirmada', 'completada', 'no_asistio']).optional(),
    atiende: Id.nullable().optional(),
  }).refine((a) => a.horario || a.notas !== undefined || a.estado || a.atiende !== undefined, 'Indica qué cambiar'),
  label: (a) => (a.horario ? 'Reagendando la cita…' : 'Actualizando la cita…'),
  risk: () => 'reversible',
  async targets(a, ctx) {
    const ap = await appointmentOf(ctx, a.cita_id);
    return ap.conversation_id ? [{ kind: 'conversation', id: ap.conversation_id }] : [{ kind: 'appointment', id: ap.id }];
  },
  async execute(a, ctx) {
    const before = await appointmentOf(ctx, a.cita_id);
    if (before.status === 'cancelled') throw new ToolError('datos_invalidos', 'La cita está cancelada; para ese horario, agenda una nueva.');
    const r = await ctx.call.send<any>('PUT', path`/api/appointments/${before.id}`, {
      ...(a.horario ? { slot: a.horario } : {}), ...(a.notas !== undefined ? { notes: a.notas } : {}),
      ...(a.estado ? { status: STATUS_IN[a.estado] } : {}), ...(a.atiende !== undefined ? { assigned_user_id: a.atiende } : {}),
    });
    return {
      title: a.horario ? `Reagendé ${r.service_name} de ${r.customer_name || 'el cliente'} para el ${when(r.starts_at, ctx.timezone)}` : `Actualicé la cita de ${r.customer_name || 'el cliente'} (${STATUS_ES[r.status] ?? r.status})`,
      links: [links.agenda()],
      contactIds: r.contact_id ? [r.contact_id] : [],
      before: apptShape(before, ctx.timezone),
      after: apptShape(r, ctx.timezone),
      undo: { label: 'Deshacer', custom: { tool: 'cambiar_cita', params: { id: r.id, before: apptShape(before, ctx.timezone), after: apptShape(r, ctx.timezone) } } },
      data: apptOut(r, ctx.timezone),
    };
  },
  async undo(p: { id: string; before: any; after: any }, ctx) {
    const a = await appointmentOf(ctx, p.id);
    if (stableJson(apptShape(a, ctx.timezone)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La cita cambió después; para no perder esos cambios, no la regresé.');
    await ctx.call.send('PUT', path`/api/appointments/${p.id}`, {
      ...(p.before.slot !== p.after.slot ? { slot: p.before.slot } : {}), notes: p.before.notes, status: p.before.status,
      ...(p.before.assigned_user_id !== p.after.assigned_user_id ? { assigned_user_id: p.before.assigned_user_id } : {}),
    });
  },
});

export const cancelarCita = defineTool({
  name: 'cancelar_cita',
  area: 'agenda',
  roles: ['admin', 'agent'],
  description: 'Cancela una cita y, si se indica, le avisa al cliente (requiere confirmación).',
  schema: z.object({ cita_id: Id, motivo: z.string().trim().max(300).optional(), avisar_al_cliente: z.boolean().default(true) }),
  label: () => 'Preparando la cancelación de la cita…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const ap = await appointmentOf(ctx, a.cita_id);
    if (ap.status !== 'confirmed') throw new ToolError('datos_invalidos', `La cita está ${STATUS_ES[ap.status] ?? ap.status}; no se puede cancelar.`);
    return {
      title: `Cancelar la cita de ${ap.customer_name || 'el cliente'} (${ap.service_name}, ${when(ap.starts_at, ctx.timezone)})`,
      lines: [a.avisar_al_cliente ? 'Le avisamos al cliente que se canceló.' : 'No se le avisa al cliente.', ...(a.motivo ? [`Motivo: ${a.motivo}`] : [])],
    };
  },
  async execute(a, ctx) {
    const ap = await appointmentOf(ctx, a.cita_id);
    await ctx.call.send('POST', path`/api/appointments/${ap.id}/cancel`, { reason: a.motivo || 'Cancelada desde el Copiloto', notify_customer: a.avisar_al_cliente });
    return { title: `Cancelé la cita de ${ap.customer_name || 'el cliente'} (${ap.service_name})`, links: [links.agenda()], contactIds: ap.contact_id ? [ap.contact_id] : [], data: { cancelada: true, aviso_al_cliente: a.avisar_al_cliente } };
  },
});

// --- Oportunidades --------------------------------------------------------------------------------------------------

const CardId = z.string().regex(/^\d{1,18}$/, 'Id de la oportunidad (número)');

const pipelines = async (ctx: Ctx) => (await ctx.call.get<any[]>('/api/pipelines')) ?? [];
/** Una oportunidad de la cuenta (buscándola en los tableros que quien pregunta puede ver). */
async function cardOf(ctx: Ctx, id: string) {
  for (const p of await pipelines(ctx)) {
    const board = await ctx.call.get<any>(`${path`/api/pipelines/${p.id}/board`}${qs({ days: 365 })}`);
    const card = (board?.cards ?? []).find((c: any) => String(c.id) === id);
    if (card) return { pipeline: p, card };
  }
  throw new ToolError('no_encontrado', 'Oportunidad no encontrada');
}
const stageOf = (p: any, idOrName: string) => (p.stages ?? []).find((s: any) => s.id === idOrName || String(s.name).toLowerCase() === idOrName.trim().toLowerCase());
const cardShape = (c: any) => ({ stage_id: c.stage_id, value: Number(c.value ?? 0) });

export const verOportunidades = defineTool({
  name: 'ver_oportunidades',
  area: 'oportunidades',
  roles: ['admin', 'agent'],
  description: 'El tablero de oportunidades: cuántas hay en cada columna, su valor y quién las atiende. Sin id, usa el único embudo o lista los que hay.',
  schema: z.object({ embudo_id: Id.optional(), columna: z.string().trim().max(60).optional() }),
  label: () => 'Revisando las oportunidades…',
  risk: () => 'read',
  async execute(a, ctx) {
    const list = await pipelines(ctx);
    const p = a.embudo_id ? list.find((x) => x.id === a.embudo_id) : list.length === 1 ? list[0] : null;
    if (!p) {
      if (a.embudo_id) throw new ToolError('no_encontrado', 'Embudo no encontrado');
      return { title: `Revisé los embudos (${list.length})`, data: { embudos: list.map((x) => ({ id: x.id, nombre: x.name, columnas: (x.stages ?? []).map((s: any) => s.name) })) } };
    }
    const board = await ctx.call.get<any>(`${path`/api/pipelines/${p.id}/board`}${qs({ days: 30 })}`);
    const cards: any[] = board?.cards ?? [];
    const stages = (p.stages ?? []).filter((s: any) => !a.columna || stageOf(p, a.columna)?.id === s.id);
    return {
      title: `Revisé el tablero ${p.name}: ${cards.length} oportunidad(es)`,
      links: [links.pipeline(p.id)],
      untrusted: cards.length > 0,
      contactIds: [...new Set(cards.map((c) => c.contact_id))],
      data: {
        embudo: p.name,
        columnas: stages.map((s: any) => {
          const mine = cards.filter((c) => c.stage_id === s.id);
          return {
            id: s.id, nombre: s.name, cuantas: mine.length, valor: mine.reduce((n, c) => n + Number(c.value ?? 0), 0),
            oportunidades: mine.slice(0, 8).map((c) => ({ id: String(c.id), contacto: c.contact_name, valor: Number(c.value ?? 0) || undefined, atiende: c.assigned_name ?? undefined, desde: day(c.stage_entered_at, ctx.timezone) })),
          };
        }),
      },
    };
  },
});

export const actualizarOportunidad = defineTool({
  name: 'actualizar_oportunidad',
  area: 'oportunidades',
  roles: ['admin', 'agent'],
  description: 'Mueve una oportunidad a otra columna del tablero (por id o nombre de columna) y/o cambia su valor.',
  schema: z.object({ oportunidad_id: CardId, columna: z.string().trim().min(1).max(60).optional(), valor: z.number().min(0).max(999_999_999_999).optional(), nota: z.string().trim().max(300).optional() })
    .refine((a) => a.columna || a.valor !== undefined, 'Indica la columna o el valor'),
  label: () => 'Actualizando la oportunidad…',
  risk: () => 'reversible',
  async preview(a, ctx) {
    const { pipeline, card } = await cardOf(ctx, a.oportunidad_id);
    const st = a.columna ? stageOf(pipeline, a.columna) : null;
    return { title: `Actualizar la oportunidad de ${card.contact_name}`, lines: [...(a.columna ? [`Columna: «${st?.name ?? a.columna}»`] : []), ...(a.valor !== undefined ? [`Valor: ${a.valor}`] : [])] };
  },
  async targets(a, ctx) {
    const { card } = await cardOf(ctx, a.oportunidad_id);
    return [{ kind: 'conversation', id: card.conversation_id }];
  },
  async events(a, ctx) {
    if (!a.columna) return [];
    const { pipeline } = await cardOf(ctx, a.oportunidad_id);
    const st = stageOf(pipeline, a.columna);
    return st ? [{ type: 'pipeline_stage', value: `${pipeline.id}:${st.id}` }] : [];
  },
  async execute(a, ctx) {
    const { pipeline, card } = await cardOf(ctx, a.oportunidad_id);
    const st = a.columna ? stageOf(pipeline, a.columna) : null;
    if (a.columna && !st) throw new ToolError('datos_invalidos', `No hay una columna «${a.columna}» en ${pipeline.name}`, (pipeline.stages ?? []).map((s: any) => s.name));
    if (st && st.id !== card.stage_id) await ctx.call.send('POST', path`/api/pipeline-cards/${String(card.id)}/move`, { stage_id: st.id, note: a.nota ?? '' });
    if (a.valor !== undefined) await ctx.call.send('PATCH', path`/api/pipeline-cards/${String(card.id)}`, { value: a.valor });
    const { card: after } = await cardOf(ctx, a.oportunidad_id);
    const stageName = (id: string) => (pipeline.stages ?? []).find((s: any) => s.id === id)?.name ?? id;
    return {
      title: `${st ? `Moví la oportunidad de ${card.contact_name} a «${stageName(after.stage_id)}»` : `Cambié el valor de la oportunidad de ${card.contact_name}`}${a.valor !== undefined ? ` (valor ${a.valor})` : ''}`,
      links: [links.pipeline(pipeline.id)],
      contactIds: [card.contact_id],
      before: cardShape(card),
      after: cardShape(after),
      undo: { label: 'Deshacer', custom: { tool: 'actualizar_oportunidad', params: { id: String(card.id), before: cardShape(card), after: cardShape(after) } } },
      data: { columna: stageName(after.stage_id), valor: Number(after.value ?? 0) },
    };
  },
  async undo(p: { id: string; before: { stage_id: string; value: number }; after: unknown }, ctx) {
    const { card } = await cardOf(ctx, p.id);
    if (stableJson(cardShape(card)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La oportunidad cambió después; para no perder esos cambios, no la regresé.');
    if (card.stage_id !== p.before.stage_id) await ctx.call.send('POST', path`/api/pipeline-cards/${p.id}/move`, { stage_id: p.before.stage_id, note: 'Deshecho desde el Copiloto' });
    if (Number(card.value ?? 0) !== p.before.value) await ctx.call.send('PATCH', path`/api/pipeline-cards/${p.id}`, { value: p.before.value });
  },
});

// --- Cobros ---------------------------------------------------------------------------------------------------------

const receivablesOn = () => config.receivables.enabled;
/** Un cobro de la cuenta (su contacto confirma que es de la cuenta del hilo). */
async function receivableOf(ctx: Ctx, id: string) {
  const r = (await ctx.call.get<any>(path`/api/receivables/${id}`))?.receivable;
  if (!r) throw new ToolError('no_encontrado', 'Cobro no encontrado');
  const contact = (await profile(ctx, r.contact_id)).contact;
  return { r, contact };
}
const RECEIVABLE_ES: Record<string, string> = { pending: 'pendiente', paid: 'pagado', canceled: 'cancelado', overdue: 'vencido' };
const receivableShape = (r: any) => ({ concept: r.concept, amount_cents: Number(r.amount_cents), currency: r.currency, due_date: String(r.due_date).slice(0, 10), payment_link: r.payment_link ?? '', status: r.status });
const receivableOut = (r: any) => ({ id: r.id, contacto: r.contact_name ?? undefined, concepto: r.concept, monto: money(r.amount_cents, r.currency), vence: String(r.due_date).slice(0, 10), estado: RECEIVABLE_ES[r.status] ?? r.status, recordatorios_enviados: r.reminders_sent || undefined });

export const verCobros = defineTool({
  name: 'ver_cobros',
  area: 'cobros',
  roles: ['admin', 'agent'],
  description: 'Cobros de la cuenta (pendientes, vencidos, pagados o cancelados), de un contacto o por concepto, con sus totales.',
  schema: z.object({ estado: z.enum(['pending', 'overdue', 'paid', 'canceled']).optional(), contacto_id: Id.optional(), buscar: z.string().trim().max(100).optional() }),
  label: () => 'Revisando los cobros…',
  risk: () => 'read',
  available: receivablesOn,
  async execute(a, ctx) {
    const r = await ctx.call.get<any>(`/api/receivables${qs({ status: a.estado, contact_id: a.contacto_id, search: a.buscar })}`);
    const rows: any[] = r?.data ?? [];
    return { title: `Revisé los cobros: ${rows.length}`, links: [links.receivables(a.contacto_id)], untrusted: rows.length > 0, contactIds: [...new Set(rows.map((x) => x.contact_id))], data: { totales: r?.totals, cobros: rows.slice(0, 30).map(receivableOut) } };
  },
});

export const crearCobro = defineTool({
  name: 'crear_cobro',
  area: 'cobros',
  roles: ['admin', 'agent'],
  description: 'Registra un cobro a un contacto con su fecha límite; se le recuerda por WhatsApp según los ajustes de cobros (requiere confirmación).',
  schema: z.object({ contacto_id: Id, concepto: Text(200), monto: Money, vence: DateStr, moneda: z.string().regex(/^[A-Za-z]{3}$/).optional(), enlace_de_pago: z.string().trim().max(500).optional(), conversacion_id: Id.optional() }),
  label: () => 'Preparando el cobro…',
  risk: () => 'confirm',
  available: receivablesOn,
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  async preview(a, ctx) {
    const c = (await profile(ctx, a.contacto_id)).contact;
    const cur = (a.moneda ?? 'MXN').toUpperCase();
    return {
      title: `Cobrar ${money(cents(a.monto), cur)} a ${nameOf(c)}: ${a.concepto}`,
      lines: [`Vence el ${a.vence}.`, 'Se le recuerda por WhatsApp según los días de recordatorio de la cuenta.', ...(a.enlace_de_pago ? [`Enlace de pago: ${a.enlace_de_pago}`] : [])],
    };
  },
  async execute(a, ctx) {
    const c = (await profile(ctx, a.contacto_id)).contact;
    const r = (await ctx.call.send<any>('POST', '/api/receivables', {
      contact_id: c.id, concept: a.concepto, amount_cents: cents(a.monto), due_date: a.vence, ...(a.moneda ? { currency: a.moneda.toUpperCase() } : {}),
      ...(a.enlace_de_pago ? { payment_link: a.enlace_de_pago } : {}), ...(a.conversacion_id ? { conversation_id: a.conversacion_id } : {}),
    })).receivable;
    return {
      title: `Registré el cobro a ${nameOf(c)}: ${r.concept} por ${money(r.amount_cents, r.currency)}`,
      links: [links.receivables(c.id)],
      contactIds: [c.id],
      after: receivableShape(r),
      undo: { label: 'Cancelar el cobro', custom: { tool: 'crear_cobro', params: { id: r.id, after: receivableShape(r) } } },
      data: { cobro_id: r.id, vence: String(r.due_date).slice(0, 10) },
    };
  },
  async undo(p: { id: string; after: unknown }, ctx) {
    const { r } = await receivableOf(ctx, p.id);
    if (stableJson(receivableShape(r)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El cobro cambió después (o ya se pagó); no lo cancelé.');
    await ctx.call.send('POST', path`/api/receivables/${p.id}/cancel`, { note: 'Deshecho desde el Copiloto' });
  },
});

export const editarCobro = defineTool({
  name: 'editar_cobro',
  area: 'cobros',
  roles: ['admin', 'agent'],
  description: 'Corrige el concepto, el monto, la fecha límite o el enlace de pago de un cobro pendiente.',
  schema: z.object({ cobro_id: Id, concepto: Text(200).optional(), monto: Money.optional(), vence: DateStr.optional(), enlace_de_pago: z.string().trim().max(500).optional() })
    .refine((a) => a.concepto || a.monto || a.vence || a.enlace_de_pago !== undefined, 'Indica qué cambiar'),
  label: () => 'Corrigiendo el cobro…',
  // El monto y el enlace deciden cuánto y a dónde paga el cliente (los repiten el asistente y los recordatorios): un
  // enlace cambiado sin que nadie lo vea desvía los pagos, aunque luego se pueda deshacer.
  risk: (a) => (a.monto !== undefined || a.enlace_de_pago !== undefined
    ? { level: 'confirm', reasons: ['Cambia cuánto o a dónde paga el cliente: confírmalo antes de guardarlo.'] }
    : 'reversible'),
  available: receivablesOn,
  async targets(a, ctx) { return [{ kind: 'contact', id: (await receivableOf(ctx, a.cobro_id)).r.contact_id }]; },
  async execute(a, ctx) {
    const { r: before, contact } = await receivableOf(ctx, a.cobro_id);
    const r = (await ctx.call.send<any>('PUT', path`/api/receivables/${before.id}`, {
      ...(a.concepto ? { concept: a.concepto } : {}), ...(a.monto ? { amount_cents: cents(a.monto) } : {}), ...(a.vence ? { due_date: a.vence } : {}), ...(a.enlace_de_pago !== undefined ? { payment_link: a.enlace_de_pago } : {}),
    })).receivable;
    return {
      title: `Corregí el cobro de ${nameOf(contact)}: ${r.concept} por ${money(r.amount_cents, r.currency)}, vence ${String(r.due_date).slice(0, 10)}`,
      links: [links.receivables(contact.id)],
      contactIds: [contact.id],
      before: receivableShape(before),
      after: receivableShape(r),
      undo: { label: 'Deshacer', custom: { tool: 'editar_cobro', params: { id: r.id, before: receivableShape(before), after: receivableShape(r) } } },
      data: receivableOut(r),
    };
  },
  async undo(p: { id: string; before: any; after: unknown }, ctx) {
    const { r } = await receivableOf(ctx, p.id);
    if (stableJson(receivableShape(r)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El cobro cambió después (o ya se pagó); no lo regresé.');
    await ctx.call.send('PUT', path`/api/receivables/${p.id}`, { concept: p.before.concept, amount_cents: p.before.amount_cents, currency: p.before.currency, due_date: p.before.due_date, payment_link: p.before.payment_link });
  },
});

export const cerrarCobro = defineTool({
  name: 'cerrar_cobro',
  area: 'cobros',
  roles: ['admin', 'agent'],
  description: 'Marca un cobro como pagado o lo cancela; deja de recordarse (requiere confirmación).',
  schema: z.object({ cobro_id: Id, como: z.enum(['pagado', 'cancelado']), nota: z.string().trim().max(500).optional() }),
  label: () => 'Preparando el cierre del cobro…',
  risk: () => 'confirm',
  available: receivablesOn,
  async targets(a, ctx) { return [{ kind: 'contact', id: (await receivableOf(ctx, a.cobro_id)).r.contact_id }]; },
  async preview(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    if (r.status !== 'pending') throw new ToolError('datos_invalidos', `El cobro ya está ${RECEIVABLE_ES[r.status] ?? r.status}.`);
    return { title: `${a.como === 'pagado' ? 'Marcar como pagado' : 'Cancelar'} el cobro de ${nameOf(contact)}: ${r.concept} (${money(r.amount_cents, r.currency)})`, lines: ['Deja de recordarse al cliente.', ...(a.nota ? [`Nota: ${a.nota}`] : [])] };
  },
  async execute(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    await ctx.call.send('POST', path`/api/receivables/${r.id}/${a.como === 'pagado' ? 'paid' : 'cancel'}`, { note: a.nota ?? '' });
    return { title: `${a.como === 'pagado' ? 'Marqué como pagado' : 'Cancelé'} el cobro de ${nameOf(contact)}: ${r.concept}`, links: [links.receivables(contact.id)], contactIds: [contact.id], data: { estado: a.como } };
  },
});

export const recordarCobro = defineTool({
  name: 'recordar_cobro',
  area: 'cobros',
  roles: ['admin', 'agent'],
  description: 'Le manda ahora al cliente el recordatorio de un cobro pendiente (requiere confirmación).',
  schema: z.object({ cobro_id: Id }),
  label: () => 'Preparando el recordatorio…',
  risk: () => 'confirm',
  available: receivablesOn,
  async targets(a, ctx) { return [{ kind: 'contact', id: (await receivableOf(ctx, a.cobro_id)).r.contact_id }]; },
  async preview(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    if (r.status !== 'pending') throw new ToolError('datos_invalidos', `El cobro ya está ${RECEIVABLE_ES[r.status] ?? r.status}.`);
    return { title: `Recordarle a ${nameOf(contact)} el cobro ${r.concept} (${money(r.amount_cents, r.currency)})`, lines: [`Vence el ${String(r.due_date).slice(0, 10)}.`, 'Le llega ahora por WhatsApp.'] };
  },
  async execute(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    await ctx.call.send('POST', path`/api/receivables/${r.id}/remind`, {});
    return { title: `Le recordé a ${nameOf(contact)} el cobro ${r.concept}`, links: [links.receivables(contact.id)], contactIds: [contact.id], data: { enviado: true } };
  },
});

// --- Cotizaciones ---------------------------------------------------------------------------------------------------

async function quoteOf(ctx: Ctx, id: string) {
  const q = await ctx.call.get<any>(path`/api/quotes/${id}`);
  if (!q?.id) throw new ToolError('no_encontrado', 'Cotización no encontrada');
  return q;
}
const QUOTE_ES: Record<string, string> = { draft: 'borrador', pending_approval: 'por aprobar', approved: 'aprobada', sent: 'enviada', accepted: 'aceptada', rejected: 'rechazada', expired: 'vencida', failed: 'con error' };
const totalOf = (q: any) => (q.open_ended ? `desde ${money(q.total_min, q.currency)}` : q.total_min === q.total_max ? money(q.total_min, q.currency) : `${money(q.total_min, q.currency)} a ${money(q.total_max, q.currency)}`);
/** Los renglones como los recibe el panel al corregir una cotización. */
const lineBody = (l: any) => ({ price_item_id: l.price_item_id ?? null, code: l.code ?? '', name: l.name, description: l.description ?? '', unit: l.unit ?? 'servicio', qty: Number(l.qty), price_mode: l.price_mode, price_min: l.price_min == null ? null : Number(l.price_min), price_max: l.price_max == null ? null : Number(l.price_max), iva_mode: l.iva_mode ?? 'plus' });
const quoteShape = (q: any) => ({ lines: (q.lines ?? []).map(lineBody), notes: q.notes ?? '', kind: q.kind });

export const verCotizaciones = defineTool({
  name: 'ver_cotizaciones',
  area: 'cotizaciones',
  roles: ['admin'],
  description: 'Con id: una cotización con sus renglones. Sin id: las cotizaciones (por estado, contacto o folio).',
  schema: z.object({ cotizacion_id: Id.optional(), estado: z.enum(['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'failed']).optional(), contacto_id: Id.optional(), buscar: z.string().trim().max(100).optional() }),
  label: () => 'Revisando las cotizaciones…',
  risk: () => 'read',
  async execute(a, ctx) {
    if (a.cotizacion_id) {
      const q = await quoteOf(ctx, a.cotizacion_id);
      return {
        title: `Revisé la cotización ${q.folio}`,
        links: [links.quote(q.id)],
        contactIds: q.contact_id ? [q.contact_id] : [],
        untrusted: true,
        read: [{ kind: 'quote', id: q.id }],
        data: {
          id: q.id, folio: q.folio, estado: QUOTE_ES[q.status] ?? q.status, tipo: q.kind === 'final' ? 'final' : 'aproximada', total: totalOf(q), vence: q.valid_until,
          renglones: (q.lines ?? []).map((l: any, i: number) => ({ n: i + 1, concepto: l.name, cantidad: Number(l.qty), precio: l.price_mode === 'tbd' ? 'por confirmar' : money(l.price_min, q.currency) })),
          datos_del_cliente: { cliente: q.customer_snapshot, notas: q.notes },
        },
      };
    }
    const list = (await ctx.call.get<any[]>(`/api/quotes${qs({ status: a.estado, contact_id: a.contacto_id, search: a.buscar, limit: 30 })}`)) ?? [];
    return { title: `Revisé las cotizaciones: ${list.length}`, untrusted: list.length > 0, contactIds: [...new Set(list.map((q) => q.contact_id).filter(Boolean))], links: [{ label: 'Ver cotizaciones', href: '#/cotizaciones/historial' }], data: { cotizaciones: list.map((q) => ({ id: q.id, folio: q.folio, estado: QUOTE_ES[q.status] ?? q.status, total: totalOf(q), cliente: q.customer_snapshot?.nombre ?? q.contact_name ?? undefined })) } };
  },
});

export const editarCotizacion = defineTool({
  name: 'editar_cotizacion',
  area: 'cotizaciones',
  roles: ['admin'],
  description: 'Corrige una cotización aún no enviada: cantidad o precio de un renglón, quitar renglones, agregar conceptos de la lista de precios o libres, y notas.',
  schema: z.object({
    cotizacion_id: Id,
    cambiar: z.array(z.object({ renglon: z.number().int().min(1), cantidad: z.number().positive().optional(), precio: Money.optional() })).max(20).optional(),
    quitar: z.array(z.number().int().min(1)).max(20).optional().describe('Números de renglón'),
    agregar: z.array(z.object({ concepto_id: Id.optional(), nombre: Text(200).optional(), cantidad: z.number().positive(), precio: Money.optional() })).max(20).optional(),
    notas: z.string().max(2000).optional(),
  }).refine((a) => a.cambiar?.length || a.quitar?.length || a.agregar?.length || a.notas !== undefined, 'Indica qué cambiar'),
  label: () => 'Corrigiendo la cotización…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'quote', id: a.cotizacion_id }],
  async execute(a, ctx) {
    const q = await quoteOf(ctx, a.cotizacion_id);
    const lines: ReturnType<typeof lineBody>[] = (q.lines ?? []).map(lineBody);
    for (const c of a.cambiar ?? []) {
      const l = lines[c.renglon - 1];
      if (!l) throw new ToolError('datos_invalidos', `La cotización tiene ${lines.length} renglón(es); no hay renglón ${c.renglon}.`);
      if (c.cantidad !== undefined) l.qty = c.cantidad;
      if (c.precio !== undefined) Object.assign(l, { price_mode: 'exact', price_min: cents(c.precio), price_max: null });
    }
    const drop = new Set(a.quitar ?? []);
    const kept = lines.filter((_, i) => !drop.has(i + 1));
    const items = a.agregar?.some((x) => x.concepto_id) ? (await ctx.call.get<any[]>('/api/price-items')) ?? [] : [];
    for (const x of a.agregar ?? []) {
      const item = x.concepto_id ? items.find((i) => i.id === x.concepto_id) : null;
      if (x.concepto_id && !item) throw new ToolError('no_encontrado', 'Ese concepto no está en la lista de precios');
      if (!item && (!x.nombre || x.precio === undefined)) throw new ToolError('datos_invalidos', 'Para un concepto libre indica nombre y precio');
      kept.push(item
        ? { ...lineBody({ ...item, price_item_id: item.id }), qty: x.cantidad, ...(x.precio !== undefined ? { price_mode: 'exact', price_min: cents(x.precio), price_max: null } : {}) }
        : { price_item_id: null, code: '', name: x.nombre!, description: '', unit: 'servicio', qty: x.cantidad, price_mode: 'exact', price_min: cents(x.precio!), price_max: null, iva_mode: 'plus' });
    }
    if (!kept.length) throw new ToolError('datos_invalidos', 'La cotización necesita al menos un renglón');
    const saved = await ctx.call.send<any>('PATCH', path`/api/quotes/${q.id}`, { lines: kept, ...(a.notas !== undefined ? { notes: a.notas } : {}) });
    return {
      title: `Corregí la cotización ${q.folio}: ${totalOf(saved)}`,
      links: [links.quote(q.id)],
      contactIds: q.contact_id ? [q.contact_id] : [],
      before: quoteShape(q),
      after: quoteShape(saved),
      undo: { label: 'Deshacer', custom: { tool: 'editar_cotizacion', params: { id: q.id, before: quoteShape(q), after: quoteShape(saved) } } },
      data: { total: totalOf(saved), renglones: (saved.lines ?? []).length },
    };
  },
  async undo(p: { id: string; before: any; after: unknown }, ctx) {
    const q = await quoteOf(ctx, p.id);
    if (stableJson(quoteShape(q)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La cotización cambió después; para no perder esos cambios, no la regresé.');
    await ctx.call.send('PATCH', path`/api/quotes/${p.id}`, { lines: p.before.lines, notes: p.before.notes });
  },
});

export const decidirCotizacion = defineTool({
  name: 'decidir_cotizacion',
  area: 'cotizaciones',
  roles: ['admin'],
  description: 'Aprueba y envía al cliente una cotización, la rechaza (con mensaje opcional al cliente) o la marca como aceptada por el cliente (requiere confirmación).',
  schema: z.object({ cotizacion_id: Id, decision: z.enum(['aprobar_y_enviar', 'rechazar', 'marcar_aceptada']), motivo: z.string().trim().max(500).optional(), mensaje_al_cliente: z.string().trim().max(1000).optional() }),
  label: () => 'Preparando la decisión sobre la cotización…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const q = await quoteOf(ctx, a.cotizacion_id);
    const who = q.customer_snapshot?.nombre ?? 'el cliente';
    if (a.decision === 'aprobar_y_enviar') return { title: `Aprobar y enviar la cotización ${q.folio} a ${who} (${totalOf(q)})`, lines: ['Le llega al cliente la cotización (PDF o enlace) por su conversación.'], meta: { shape: stableJson(quoteShape(q)) } };
    if (a.decision === 'rechazar') return { title: `Rechazar la cotización ${q.folio}`, lines: [a.motivo ? `Motivo: ${a.motivo}` : 'Sin motivo.', a.mensaje_al_cliente ? 'Se le manda este mensaje al cliente:' : 'No se le avisa al cliente.'], ...(a.mensaje_al_cliente ? { quote: a.mensaje_al_cliente } : {}) };
    return { title: `Marcar la cotización ${q.folio} como aceptada por ${who}`, lines: ['Ya no vence. No se crean cobros (eso se hace desde la cotización o con crear_cobro).'] };
  },
  async execute(a, ctx) {
    const q = await quoteOf(ctx, a.cotizacion_id);
    if (a.decision === 'aprobar_y_enviar') {
      const seen = ctx.proposal?.meta?.shape;
      if (seen !== undefined && seen !== stableJson(quoteShape(q))) throw new ToolError('conflicto', 'La cotización cambió después de la propuesta; pídemelo de nuevo para revisarla.');
      await ctx.call.send('POST', path`/api/quotes/${q.id}/approve`, {});
    } else if (a.decision === 'rechazar') await ctx.call.send('POST', path`/api/quotes/${q.id}/reject`, { reason: a.motivo ?? '', message: a.mensaje_al_cliente ?? '' });
    else await ctx.call.send('POST', path`/api/quotes/${q.id}/accept`, {});
    const verb = { aprobar_y_enviar: 'Aprobé y envié', rechazar: 'Rechacé', marcar_aceptada: 'Marqué como aceptada' }[a.decision];
    return { title: `${verb} la cotización ${q.folio}`, links: [links.quote(q.id)], contactIds: q.contact_id ? [q.contact_id] : [], data: { hecho: a.decision } };
  },
});

const PRICE_MODE = { exacto: 'exact', desde: 'from', rango: 'range', por_confirmar: 'tbd' } as const;
const itemShape = (i: any) => ({ code: i.code, name: i.name, description: i.description ?? '', unit: i.unit, price_mode: i.price_mode, price_min: i.price_min == null ? null : Number(i.price_min), price_max: i.price_max == null ? null : Number(i.price_max), iva_mode: i.iva_mode, active: i.active });

export const editarListaDePrecios = defineTool({
  name: 'editar_lista_de_precios',
  area: 'cotizaciones',
  roles: ['admin'],
  description: 'Agrega un concepto a la lista de precios (sin id) o cambia uno (con id): nombre, precio, tipo de precio, unidad o si está activo.',
  schema: z.object({
    concepto_id: Id.optional(),
    codigo: z.string().trim().min(1).max(40).optional(),
    nombre: Text(200).optional(),
    descripcion: z.string().max(1000).optional(),
    unidad: Text(40).optional(),
    tipo_de_precio: z.enum(['exacto', 'desde', 'rango', 'por_confirmar']).optional(),
    precio: Money.optional().describe('Precio (o el mínimo, en «desde» y «rango»)'),
    precio_maximo: Money.optional(),
    activo: z.boolean().optional(),
  }).refine((a) => a.concepto_id || (a.codigo && a.nombre && (a.precio !== undefined || a.tipo_de_precio === 'por_confirmar')), 'Para agregar indica código, nombre y precio'),
  label: (a) => (a.concepto_id ? 'Cambiando la lista de precios…' : 'Agregando a la lista de precios…'),
  risk: () => 'reversible',
  async execute(a, ctx) {
    const body = {
      ...(a.codigo ? { code: a.codigo } : {}), ...(a.nombre ? { name: a.nombre } : {}), ...(a.descripcion !== undefined ? { description: a.descripcion } : {}),
      ...(a.unidad ? { unit: a.unidad } : {}), ...(a.tipo_de_precio ? { price_mode: PRICE_MODE[a.tipo_de_precio] } : {}),
      ...(a.precio !== undefined ? { price_min: cents(a.precio) } : {}), ...(a.precio_maximo !== undefined ? { price_max: cents(a.precio_maximo) } : {}),
      ...(a.activo !== undefined ? { active: a.activo } : {}),
    };
    if (!a.concepto_id) {
      const item = await ctx.call.send<any>('POST', '/api/price-items', { price_mode: 'exact', ...body });
      return {
        title: `Agregué «${item.name}» a la lista de precios`,
        links: [links.prices()],
        after: itemShape(item),
        undo: { label: 'Deshacer', custom: { tool: 'editar_lista_de_precios', params: { id: item.id, before: null, after: itemShape(item) } } },
        data: { concepto_id: item.id },
      };
    }
    const before = ((await ctx.call.get<any[]>('/api/price-items')) ?? []).find((i) => i.id === a.concepto_id);
    if (!before) throw new ToolError('no_encontrado', 'Ese concepto no está en la lista de precios');
    const item = await ctx.call.send<any>('PUT', path`/api/price-items/${before.id}`, body);
    return {
      title: `Cambié «${item.name}» en la lista de precios`,
      links: [links.prices()],
      before: itemShape(before),
      after: itemShape(item),
      undo: { label: 'Deshacer', custom: { tool: 'editar_lista_de_precios', params: { id: item.id, before: itemShape(before), after: itemShape(item) } } },
      data: { concepto_id: item.id, precio: item.price_mode === 'tbd' ? 'por confirmar' : money(item.price_min) },
    };
  },
  async undo(p: { id: string; before: any; after: unknown }, ctx) {
    const item = ((await ctx.call.get<any[]>('/api/price-items')) ?? []).find((i) => i.id === p.id);
    if (!item) { if (!p.before) return; throw new ToolError('conflicto', 'Ese concepto ya no existe.'); }
    if (stableJson(itemShape(item)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El concepto cambió después; para no perder esos cambios, no lo regresé.');
    if (p.before) await ctx.call.send('PUT', path`/api/price-items/${p.id}`, p.before);
    else await ctx.call.send('DELETE', path`/api/price-items/${p.id}`);
  },
});

// --- Estadísticas ---------------------------------------------------------------------------------------------------

const RANGE = { hoy: 'today', semana: 'week', '7': '7', '15': '15', '30': '30', '60': '60', '90': '90' } as const;

export const estadisticas = defineTool({
  name: 'estadisticas',
  area: 'datos',
  roles: ['admin'],
  description: 'Números del negocio en un periodo (y el anterior para comparar): conversaciones, mensajes, citas, tiempos de respuesta, equipo, canales y gasto de IA.',
  schema: z.object({ periodo: z.enum(['hoy', 'semana', '7', '15', '30', '60', '90']).default('7').describe('hoy, semana (desde el lunes) o los últimos N días') }),
  label: () => 'Revisando las estadísticas…',
  risk: () => 'read',
  async execute(a, ctx) {
    const s = await ctx.call.get<any>(`/api/analytics${qs({ range: RANGE[a.periodo] })}`);
    const budget = await ctx.call.get<any>('/api/ai-budget').catch(() => null);
    return {
      title: `Revisé las estadísticas (${a.periodo === 'hoy' ? 'hoy' : a.periodo === 'semana' ? 'esta semana' : `${a.periodo} días`})`,
      links: [links.stats()],
      data: {
        periodo: s.period, totales: s.totals, periodo_anterior: s.previous, equipo: s.team, canales: s.channels, servicios: s.services, ia_por_uso: s.ai_by_kind,
        gasto_ia: budget?.usage ?? undefined,
      },
    };
  },
});

export const OPERATION_TOOLS = [
  horariosLibres, buscarCitas, crearCita, cambiarCita, cancelarCita, verOportunidades, actualizarOportunidad,
  verCobros, crearCobro, editarCobro, cerrarCobro, recordarCobro, verCotizaciones, editarCotizacion, decidirCotizacion, editarListaDePrecios, estadisticas,
];
