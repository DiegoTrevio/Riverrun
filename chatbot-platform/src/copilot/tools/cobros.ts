/**
 * Herramientas del Copiloto para el resto de cobros (fase 2): aprobar o borrar un cobro, los pagos recurrentes y los
 * ajustes de cobros. Lo que empieza a cobrarle a un cliente, cambia cuánto o a dónde paga, o borra, se confirma.
 * Ver, registrar, corregir y cerrar cobros sigue en `operacion.ts`.
 */
import { z } from 'zod';
import { config } from '../../config.js';
import { path, qs, ToolError } from '../executor.js';
import { defineTool, type Ctx, type RiskInfo } from '../registry.js';
import { stableJson } from '../store.js';
import { links } from '../summarize.js';
import { cents, DateStr, Id, isAdmin, money, Money, nameOf, profile, Text } from './common.js';

const receivablesOn = () => config.receivables.enabled;

async function receivableOf(ctx: Ctx, id: string) {
  const r = (await ctx.call.get<any>(path`/api/receivables/${id}`))?.receivable;
  if (!r) throw new ToolError('no_encontrado', 'Cobro no encontrado');
  return { r, contact: (await profile(ctx, r.contact_id)).contact };
}
const domain = (link: string) => { try { return new URL(link).hostname; } catch { return ''; } };
const receivableLines = (r: any) => [`Vence el ${String(r.due_date).slice(0, 10)}.`, ...(r.payment_link ? [`Enlace de pago: ${domain(r.payment_link)}`] : [])];

export const aprobarCobro = defineTool({
  name: 'aprobar_cobro',
  area: 'cobros',
  roles: ['admin'],
  description: 'Aprueba un cobro que registró un agente: desde ahí salen sus recordatorios al cliente. Se confirma.',
  schema: z.object({ cobro_id: Id }),
  label: () => 'Preparando la aprobación del cobro…',
  risk: () => 'confirm',
  available: receivablesOn,
  async targets(a, ctx) { return [{ kind: 'contact', id: (await receivableOf(ctx, a.cobro_id)).r.contact_id }]; },
  async preview(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    if (!r.needs_approval) throw new ToolError('datos_invalidos', 'Ese cobro ya está aprobado.');
    return { title: `Aprobar el cobro a ${nameOf(contact)}: ${r.concept} (${money(r.amount_cents, r.currency)})`, lines: [...receivableLines(r), 'Desde que lo apruebes, se le recuerda al cliente por WhatsApp.'], meta: { amount: r.amount_cents, link: r.payment_link } };
  },
  async execute(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    const seen = ctx.proposal?.meta as { amount?: number; link?: string } | undefined;
    if (seen && (seen.amount !== r.amount_cents || seen.link !== r.payment_link)) throw new ToolError('conflicto', 'El cobro cambió después de la propuesta; pídemelo de nuevo para revisarlo.');
    const out = await ctx.call.send<any>('POST', path`/api/receivables/${r.id}/approve`, {});
    return { title: `Aprobé el cobro a ${nameOf(contact)}: ${r.concept}`, links: [links.receivables(contact.id)], contactIds: [contact.id], data: { aprobado: true, recordatorios_programados: out?.scheduled ?? undefined } };
  },
});

export const borrarCobro = defineTool({
  name: 'borrar_cobro',
  area: 'cobros',
  roles: ['admin'],
  description: 'Borra un cobro (se cancelan sus recordatorios y no queda en el historial; para conservarlo, mejor cancélalo con cerrar_cobro). Se confirma.',
  schema: z.object({ cobro_id: Id }),
  label: () => 'Preparando el borrado del cobro…',
  risk: () => 'confirm',
  available: receivablesOn,
  async targets(a, ctx) { return [{ kind: 'contact', id: (await receivableOf(ctx, a.cobro_id)).r.contact_id }]; },
  async preview(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    return { title: `Borrar el cobro a ${nameOf(contact)}: ${r.concept} (${money(r.amount_cents, r.currency)})`, lines: [...receivableLines(r), 'Se cancelan sus recordatorios y no queda en el historial.'], warning: 'No se puede deshacer.' };
  },
  async execute(a, ctx) {
    const { r, contact } = await receivableOf(ctx, a.cobro_id);
    await ctx.call.send('DELETE', path`/api/receivables/${r.id}`);
    return { title: `Borré el cobro a ${nameOf(contact)}: ${r.concept}`, links: [links.receivables(contact.id)], contactIds: [contact.id], data: { borrado: true } };
  },
});

// --- Pagos recurrentes -----------------------------------------------------------------------------------------------

const FREQ = { semanal: 'weekly', quincenal: 'biweekly', mensual: 'monthly' } as const;
const FREQ_ES: Record<string, string> = Object.fromEntries(Object.entries(FREQ).map(([es, en]) => [en, es]));
const PLAN_KEYS = ['concept', 'amount_cents', 'currency', 'payment_link', 'reference', 'reminders', 'frequency', 'day', 'starts_on', 'ends_on', 'max_payments', 'active'] as const;
const planShape = (p: any) => Object.fromEntries(PLAN_KEYS.map((k) => [k, p[k] ?? null]));
const planOut = (p: any) => ({
  id: p.id, contacto: p.contact_name || undefined, concepto: p.concept, monto: money(p.amount_cents, p.currency), frecuencia: FREQ_ES[p.frequency] ?? p.frequency, dia: p.day,
  desde: p.starts_on, hasta: p.ends_on ?? undefined, siguiente: p.next_due ?? undefined, activo: p.active, por_aprobar: p.needs_approval || undefined, cobros_creados: p.payments_created || undefined,
});
async function planOf(ctx: Ctx, id: string) {
  const p = (((await ctx.call.get<any>('/api/receivable-plans'))?.data ?? []) as any[]).find((x) => x.id === id);
  if (!p) throw new ToolError('no_encontrado', 'Pago recurrente no encontrado');
  return p;
}

export const verPagosRecurrentes = defineTool({
  name: 'ver_pagos_recurrentes',
  area: 'cobros',
  roles: ['admin', 'agent'],
  description: 'Los pagos recurrentes (semanales, quincenales o mensuales) de la cuenta o de un contacto: monto, siguiente cobro y si están activos o por aprobar.',
  schema: z.object({ contacto_id: Id.optional() }),
  label: () => 'Revisando los pagos recurrentes…',
  risk: () => 'read',
  available: receivablesOn,
  async execute(a, ctx) {
    const list = ((await ctx.call.get<any>(`/api/receivable-plans${qs({ contact_id: a.contacto_id })}`))?.data ?? []) as any[];
    return {
      title: `Revisé los pagos recurrentes: ${list.length}`,
      links: [links.receivablesTab('recurrentes', 'Ver pagos recurrentes')],
      untrusted: list.length > 0,
      contactIds: [...new Set(list.map((p) => p.contact_id))],
      data: { pagos: list.slice(0, 30).map(planOut) },
    };
  },
});

const PlanFields = z.object({
  pago_id: Id.optional(),
  contacto_id: Id.optional().describe('Al crear'),
  concepto: Text(200).optional(),
  monto: Money.optional(),
  moneda: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  frecuencia: z.enum(['semanal', 'quincenal', 'mensual']).optional(),
  dia: z.number().int().min(0).max(31).optional().describe('Mensual: día del mes (31 = el último). Semanal o quincenal: 0 domingo … 6 sábado'),
  desde: DateStr.optional(),
  hasta: DateStr.nullable().optional(),
  max_pagos: z.number().int().min(1).max(600).nullable().optional(),
  enlace_de_pago: z.string().trim().max(500).optional(),
  activo: z.boolean().optional(),
});
type PlanArgs = z.infer<typeof PlanFields>;

function planRisk(a: PlanArgs, ctx: Ctx, current: any | null): RiskInfo {
  const reasons: string[] = [];
  if (!current) {
    if (!isAdmin(ctx)) reasons.push('Queda por aprobar: les llega un aviso a los administradores.');
    else if (a.activo !== false) reasons.push('Empieza a cobrarle al cliente: se crean sus cobros con recordatorios por WhatsApp.');
  } else {
    if (a.monto !== undefined || a.moneda !== undefined || a.enlace_de_pago !== undefined) reasons.push('Cambia cuánto o a dónde paga el cliente: confírmalo antes de guardarlo.');
    if (a.activo === true && !current.active) reasons.push('Lo reanudas: vuelve a crear cobros con recordatorios.');
    if (ctx.tainted && a.concepto !== undefined) reasons.push('Antes leí mensajes escritos por clientes y el concepto lo repiten los recordatorios: confírmalo.');
  }
  return reasons.length ? { level: 'confirm', reasons } : { level: 'reversible', reasons: [] };
}
const planBody = (a: PlanArgs) => ({
  ...(a.concepto !== undefined ? { concept: a.concepto } : {}), ...(a.monto !== undefined ? { amount_cents: cents(a.monto) } : {}), ...(a.moneda ? { currency: a.moneda.toUpperCase() } : {}),
  ...(a.frecuencia ? { frequency: FREQ[a.frecuencia] } : {}), ...(a.dia !== undefined ? { day: a.dia } : {}), ...(a.desde ? { starts_on: a.desde } : {}),
  ...(a.hasta !== undefined ? { ends_on: a.hasta } : {}), ...(a.max_pagos !== undefined ? { max_payments: a.max_pagos } : {}),
  ...(a.enlace_de_pago !== undefined ? { payment_link: a.enlace_de_pago } : {}), ...(a.activo !== undefined ? { active: a.activo } : {}),
});

export const guardarPagoRecurrente = defineTool({
  name: 'guardar_pago_recurrente',
  area: 'cobros',
  roles: ['admin', 'agent'],
  description: 'Crea un pago recurrente a un contacto (sin pago_id: contacto, concepto, monto, frecuencia, día y desde) o cambia uno, también pausarlo (activo false).',
  schema: PlanFields.refine((a) => (a.pago_id ? Object.keys(planBody(a)).length : a.contacto_id && a.concepto && a.monto && a.frecuencia && a.dia !== undefined && a.desde), 'Para crear: contacto, concepto, monto, frecuencia, día y desde'),
  label: (a) => (a.pago_id ? 'Cambiando el pago recurrente…' : 'Preparando el pago recurrente…'),
  async risk(a, ctx) { return planRisk(a, ctx, a.pago_id ? await planOf(ctx, a.pago_id) : null); },
  available: receivablesOn,
  async targets(a, ctx) { return [{ kind: 'contact', id: a.contacto_id ?? (await planOf(ctx, a.pago_id!)).contact_id }]; },
  async preview(a, ctx) {
    const p = a.pago_id ? await planOf(ctx, a.pago_id) : null;
    const c = (await profile(ctx, p?.contact_id ?? a.contacto_id!)).contact;
    const cur = (a.moneda ?? p?.currency ?? 'MXN').toUpperCase();
    return {
      title: p ? `Cambiar el pago recurrente de ${nameOf(c)}: ${p.concept}` : `Cobrarle a ${nameOf(c)} ${money(cents(a.monto!), cur)} ${a.frecuencia === 'mensual' ? 'cada mes' : a.frecuencia === 'quincenal' ? 'cada quince días' : 'cada semana'}: ${a.concepto}`,
      lines: [
        ...(p && a.monto !== undefined ? [`Monto: ${money(p.amount_cents, p.currency)} → ${money(cents(a.monto), cur)}`] : []),
        ...(a.frecuencia || a.dia !== undefined ? [`Frecuencia: ${a.frecuencia ?? FREQ_ES[p?.frequency]}, día ${a.dia ?? p?.day}`] : []),
        ...(a.desde ? [`Desde el ${a.desde}${a.hasta ? ` hasta el ${a.hasta}` : ''}.`] : []),
        ...(a.enlace_de_pago !== undefined ? [`Enlace de pago: ${a.enlace_de_pago || '(ninguno)'}`] : []),
        ...(a.activo === false ? ['Queda en pausa: no crea cobros.'] : a.activo ? ['Activo: crea los cobros que toquen, con recordatorios.'] : []),
      ],
    };
  },
  async execute(a, ctx) {
    if (!a.pago_id) {
      const c = (await profile(ctx, a.contacto_id!)).contact;
      const r = await ctx.call.send<any>('POST', '/api/receivable-plans', { contact_id: c.id, ...planBody(a) });
      const p = r.plan;
      return {
        title: `Registré el pago recurrente de ${nameOf(c)}: ${p.concept} (${money(p.amount_cents, p.currency)}, ${FREQ_ES[p.frequency]})`,
        links: [links.receivablesTab('recurrentes', 'Ver pagos recurrentes')],
        contactIds: [p.contact_id],
        after: planShape(p),
        // Deshacer: pausarlo (los cobros que ya creó se quedan; se cancelan desde Cobros).
        undo: { label: p.active ? 'Pausarlo' : 'Deshacer', custom: { tool: 'guardar_pago_recurrente', params: { id: p.id, before: null, after: planShape(p) } } },
        data: { pago_id: p.id, siguiente: p.next_due ?? undefined, cobros_creados: r.created || undefined, por_aprobar: p.needs_approval || undefined },
      };
    }
    const before = await planOf(ctx, a.pago_id);
    const r = await ctx.call.send<any>('PUT', path`/api/receivable-plans/${before.id}`, planBody(a));
    const p = r.plan;
    return {
      title: `Cambié el pago recurrente de ${before.contact_name || 'el cliente'}: ${p.concept}${p.active ? '' : ' (en pausa)'}`,
      links: [links.receivablesTab('recurrentes', 'Ver pagos recurrentes')],
      contactIds: [p.contact_id],
      before: planShape(before), after: planShape(p),
      undo: { label: 'Deshacer', custom: { tool: 'guardar_pago_recurrente', params: { id: p.id, before: planShape(before), after: planShape(p) } } },
      data: planOut({ ...p, contact_name: before.contact_name }),
    };
  },
  async undo(p: { id: string; before: Record<string, unknown> | null; after: unknown }, ctx) {
    const cur = await planOf(ctx, p.id);
    if (stableJson(planShape(cur)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El pago recurrente cambió después; para no perder esos cambios, no lo regresé.');
    if (p.before) { await ctx.call.send('PUT', path`/api/receivable-plans/${p.id}`, p.before); return; }
    // Uno que se acaba de crear: si no ha creado cobros y quien deshace es administrador, se borra; si no, se pausa.
    if (!cur.payments_created && isAdmin(ctx)) await ctx.call.send('DELETE', path`/api/receivable-plans/${p.id}`);
    else if (cur.active) await ctx.call.send('PUT', path`/api/receivable-plans/${p.id}`, { active: false });
  },
});

export const decidirPagoRecurrente = defineTool({
  name: 'decidir_pago_recurrente',
  area: 'cobros',
  roles: ['admin'],
  description: 'Aprueba un pago recurrente que registró un agente (empieza a crear cobros) o lo borra (los cobros que ya creó se quedan). Se confirma.',
  schema: z.object({ pago_id: Id, accion: z.enum(['aprobar', 'borrar']) }),
  label: () => 'Preparando la decisión sobre el pago recurrente…',
  risk: () => 'confirm',
  available: receivablesOn,
  async targets(a, ctx) { return [{ kind: 'contact', id: (await planOf(ctx, a.pago_id)).contact_id }]; },
  async preview(a, ctx) {
    const p = await planOf(ctx, a.pago_id);
    if (a.accion === 'aprobar' && !p.needs_approval) throw new ToolError('datos_invalidos', 'Ese pago recurrente ya está aprobado.');
    const what = `${p.concept} (${money(p.amount_cents, p.currency)}, ${FREQ_ES[p.frequency]})`;
    return a.accion === 'aprobar'
      ? { title: `Aprobar el pago recurrente de ${p.contact_name || 'el cliente'}: ${what}`, lines: [p.active ? 'Desde ahora crea los cobros que toquen, con recordatorios al cliente.' : 'Está en pausa: no crea cobros hasta reanudarlo.', ...(p.payment_link ? [`Enlace de pago: ${domain(p.payment_link)}`] : [])], meta: { shape: stableJson(planShape(p)) } }
      : { title: `Borrar el pago recurrente de ${p.contact_name || 'el cliente'}: ${what}`, lines: ['Deja de crear cobros; los que ya creó se quedan.'], warning: 'No se puede deshacer.' };
  },
  async execute(a, ctx) {
    const p = await planOf(ctx, a.pago_id);
    if (a.accion === 'aprobar') {
      const seen = ctx.proposal?.meta?.shape;
      if (seen !== undefined && seen !== stableJson(planShape(p))) throw new ToolError('conflicto', 'El pago recurrente cambió después de la propuesta; pídemelo de nuevo para revisarlo.');
      const r = await ctx.call.send<any>('POST', path`/api/receivable-plans/${p.id}/approve`, {});
      return { title: `Aprobé el pago recurrente de ${p.contact_name || 'el cliente'}: ${p.concept}`, links: [links.receivablesTab('recurrentes', 'Ver pagos recurrentes')], contactIds: [p.contact_id], data: { aprobado: true, cobros_creados: r?.created || undefined } };
    }
    await ctx.call.send('DELETE', path`/api/receivable-plans/${p.id}`);
    return { title: `Borré el pago recurrente de ${p.contact_name || 'el cliente'}: ${p.concept}`, links: [links.receivablesTab('recurrentes', 'Ver pagos recurrentes')], contactIds: [p.contact_id], data: { borrado: true } };
  },
});

// --- Ajustes de cobros -----------------------------------------------------------------------------------------------

const settingsOut = (s: any) => ({
  instrucciones_de_pago: s.payment_instructions || undefined, recordatorios_dias: s.default_reminders, hora: s.send_at, respetar_horario: s.respect_business_hours,
  mensaje_antes: s.message_before || undefined, mensaje_al_vencer: s.message_due || undefined, mensaje_vencido: s.message_overdue || undefined, avisar_al_equipo_si_vence: s.notify_team_on_overdue,
});

const SettingsArgs = z.object({
  instrucciones_de_pago: z.string().max(2000).optional().describe('Cómo y a dónde pagar (va en los recordatorios)'),
  recordatorios_dias: z.array(z.number().int().min(-60).max(120)).max(20).optional().describe('Días respecto al vencimiento (-3 = tres días antes)'),
  hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  respetar_horario: z.boolean().optional(),
  mensaje_antes: z.string().max(1500).optional(),
  mensaje_al_vencer: z.string().max(1500).optional(),
  mensaje_vencido: z.string().max(1500).optional(),
  avisar_al_equipo_si_vence: z.boolean().optional(),
});
const SETTINGS_MAP = {
  instrucciones_de_pago: 'payment_instructions', recordatorios_dias: 'default_reminders', hora: 'send_at', respetar_horario: 'respect_business_hours',
  mensaje_antes: 'message_before', mensaje_al_vencer: 'message_due', mensaje_vencido: 'message_overdue', avisar_al_equipo_si_vence: 'notify_team_on_overdue',
} as const;

export const ajustesDeCobro = defineTool({
  name: 'ajustes_de_cobro',
  area: 'cobros',
  roles: ['admin'],
  description: 'Sin cambios, muestra los ajustes de cobros; con cambios, los guarda: instrucciones de pago, días y hora de los recordatorios, sus mensajes y el aviso al equipo.',
  schema: SettingsArgs,
  label: () => 'Revisando los ajustes de cobros…',
  risk: (a) => (a.instrucciones_de_pago !== undefined
    ? { level: 'confirm', reasons: ['Cambia a dónde y cómo paga el cliente: confírmalo antes de guardarlo.'] }
    : Object.values(a).some((v) => v !== undefined) ? 'reversible' : 'read'),
  available: receivablesOn,
  async execute(a, ctx) {
    const before = (await ctx.call.get<any>('/api/receivables/settings'))?.settings;
    const changes = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => [SETTINGS_MAP[k as keyof typeof SETTINGS_MAP], v]));
    if (!Object.keys(changes).length) return { title: 'Revisé los ajustes de cobros', links: [links.receivablesTab('ajustes', 'Ver ajustes de cobros')], data: settingsOut(before) };
    const saved = (await ctx.call.send<any>('PUT', '/api/receivables/settings', { ...before, ...changes }))?.settings;
    return {
      title: `Cambié los ajustes de cobros (${Object.keys(changes).length} dato(s))`,
      links: [links.receivablesTab('ajustes', 'Ver ajustes de cobros')],
      before, after: saved,
      undo: { label: 'Deshacer', custom: { tool: 'ajustes_de_cobro', params: { before, after: saved } } },
      data: settingsOut(saved),
    };
  },
  async undo(p: { before: any; after: unknown }, ctx) {
    const cur = (await ctx.call.get<any>('/api/receivables/settings'))?.settings;
    if (stableJson(cur) !== stableJson(p.after)) throw new ToolError('conflicto', 'Los ajustes de cobros cambiaron después; para no perder esos cambios, no los regresé.');
    await ctx.call.send('PUT', '/api/receivables/settings', p.before);
  },
});

export const RECEIVABLE_TOOLS = [aprobarCobro, borrarCobro, verPagosRecurrentes, guardarPagoRecurrente, decidirPagoRecurrente, ajustesDeCobro];
