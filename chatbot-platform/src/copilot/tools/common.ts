/** Piezas que comparten las herramientas del Copiloto. */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import type { Ctx } from '../registry.js';

export const Id = z.string().uuid();
export const Text = (max: number) => z.string().trim().min(1).max(max);
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa AAAA-MM-DD');
export const Money = z.number().positive().max(1_000_000_000).describe('En pesos (o la moneda indicada), con hasta 2 decimales');
export const cents = (n: number) => Math.round(n * 100);
export const money = (c: number | string | null | undefined, cur = 'MXN') => (c == null ? 'por confirmar' : `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`);

// --- Horario de la semana (negocio, servicios y equipo) ---------------------------------------------------------------

export const DAYS = { lunes: 'mon', martes: 'tue', miercoles: 'wed', jueves: 'thu', viernes: 'fri', sabado: 'sat', domingo: 'sun' } as const;
export type DayName = keyof typeof DAYS;
export const DAY_OUT: Record<string, string> = Object.fromEntries(Object.entries(DAYS).map(([es, en]) => [en, es]));
const Range = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'Usa HH:MM-HH:MM (ej. 09:00-18:00)');
/** Franjas por día (lista vacía = cerrado); solo los días que se mandan cambian. */
export const Week = z.object(Object.fromEntries(Object.keys(DAYS).map((d) => [d, z.array(Range).max(4).optional()])) as Record<DayName, z.ZodOptional<z.ZodArray<typeof Range>>>);
export type WeekArgs = z.infer<typeof Week>;
type Hours = Record<string, string[][]>;

/** El horario con los días pedidos cambiados (los demás como estaban). */
export function applyWeek(base: Hours, week: WeekArgs): Hours {
  const hours: Hours = { ...base };
  for (const d of Object.keys(week) as DayName[]) if (week[d]) hours[DAYS[d]] = week[d]!.map((r) => r.split('-'));
  return hours;
}
/** Días del horario que se piden cambiar. */
export const weekDays = (week: WeekArgs | null | undefined) => (Object.keys(week ?? {}) as DayName[]).filter((d) => week?.[d]);
/** El horario en palabras: { lunes: ['09:00-18:00'], domingo: 'cerrado' }. */
export const weekOut = (hours: Hours | null | undefined) => (hours ? Object.fromEntries(Object.entries(hours).map(([d, r]) => [DAY_OUT[d] ?? d, r.length ? r.map((x) => x.join('-')) : 'cerrado'])) : null);

export const nameOf = (c: { name?: string | null; push_name?: string | null; phone?: string | null } | null | undefined) =>
  c?.name || c?.push_name || c?.phone || 'Sin nombre';

/** Ficha completa de un contacto (con los permisos de quien pregunta). */
export async function profile(ctx: Ctx, contactId: string) {
  const p = await ctx.call.get<any>(path`/api/contacts/${contactId}/profile`);
  if (!p?.contact) throw new ToolError('no_encontrado', 'Contacto no encontrado');
  return p;
}

/**
 * Versión de los datos del contacto: la que el panel manda para no pisar lo que la IA guardó después. Solo cuentan sus
 * propias conversaciones (la ficha junta también las de otros registros con el mismo teléfono).
 */
export const dataVersion = (p: any): number =>
  Math.max(0, ...((p.conversations ?? []) as any[]).filter((c) => c.contact_id === p.contact.id).map((c) => Number(c.data_version ?? 0)));

/** Conversación con su contacto (con los permisos de quien pregunta). */
export async function conversation(ctx: Ctx, conversationId: string) {
  const c = await ctx.call.get<any>(path`/api/conversations/${conversationId}`);
  if (!c?.conversation) throw new ToolError('no_encontrado', 'Conversación no encontrada');
  return c;
}

export const isAdmin = (ctx: Ctx) => ctx.user.role === 'admin' || ctx.user.role === 'superadmin';

/** Un agente de la cuenta (la lectura también descarta los de otra cuenta para el superadmin). */
export async function botOf(ctx: Ctx, id: string) {
  const b = await ctx.call.get<any>(path`/api/chatbots/${id}`);
  if (!b?.id) throw new ToolError('no_encontrado', 'Agente no encontrado');
  return b;
}

/** Valor en una ruta con puntos («rules.custom_rules»). */
export const getPath = (obj: any, p: string): unknown => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Objeto parcial a partir de rutas con puntos: { 'rules.x': 1 } → { rules: { x: 1 } }. */
export function fromPaths(values: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [p, v] of Object.entries(values)) {
    const keys = p.split('.');
    let o = out;
    keys.slice(0, -1).forEach((k) => { o = o[k] ??= {}; });
    o[keys[keys.length - 1]] = v;
  }
  return out;
}

export const snapshot = (obj: unknown, paths: string[]) => Object.fromEntries(paths.map((p) => [p, getPath(obj, p) ?? null]));

/** Lista con elementos agregados y quitados (sin repetir, sin distinguir mayúsculas al quitar). */
export function editList(list: string[], add: string[] = [], remove: string[] = []): string[] {
  const drop = new Set(remove.map((x) => x.trim().toLowerCase()));
  const kept = list.filter((x) => !drop.has(x.trim().toLowerCase()));
  for (const x of add) if (!kept.some((k) => k.trim().toLowerCase() === x.trim().toLowerCase())) kept.push(x.trim());
  return kept;
}
