/**
 * Herramientas del Copiloto para los embudos de oportunidades (fase 2, solo administradores): crearlos y cambiarlos
 * (columnas, qué agentes los usan) es reversible; borrarlos, o quitar una columna que tiene oportunidades, se confirma.
 * Ver y mover tarjetas sigue en `operacion.ts`.
 */
import { z } from 'zod';
import { path, qs, ToolError } from '../executor.js';
import { defineTool, type Ctx, type RiskInfo } from '../registry.js';
import { stableJson } from '../store.js';
import { links } from '../summarize.js';
import { Id, Text } from './common.js';

const KIND = { abierta: 'open', ganada: 'won', perdida: 'lost' } as const;
const KIND_ES: Record<string, string> = { open: 'abierta', won: 'ganada', lost: 'perdida' };

const pipelines = async (ctx: Ctx) => ((await ctx.call.get<any[]>('/api/pipelines')) ?? []) as any[];
async function pipelineOf(ctx: Ctx, id: string) {
  const p = (await pipelines(ctx)).find((x) => x.id === id);
  if (!p) throw new ToolError('no_encontrado', 'Embudo no encontrado');
  return p;
}
const cardsOf = async (ctx: Ctx, id: string) => ((await ctx.call.get<any>(`${path`/api/pipelines/${id}/board`}${qs({ days: 365 })}`))?.cards ?? []) as any[];
const pipelineShape = (p: any) => ({ name: p.name, stages: p.stages ?? [], chatbot_ids: p.chatbot_ids ?? [], allow_backward: !!p.allow_backward, currency: p.currency });
const pipelineOut = (p: any) => ({ embudo_id: p.id, nombre: p.name, columnas: (p.stages ?? []).map((s: any) => ({ id: s.id, nombre: s.name, tipo: KIND_ES[s.kind] ?? s.kind })), agentes: p.chatbot_ids?.length ? p.chatbot_ids : undefined });

const Column = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/).optional().describe('El de una columna que ya existe'),
  nombre: Text(60),
  tipo: z.enum(['abierta', 'ganada', 'perdida']).optional(),
  cuando: z.string().trim().max(500).optional().describe('Situación en palabras: la IA mueve ahí la oportunidad'),
});
type ColumnArgs = z.infer<typeof Column>;

/** Las columnas pedidas, conservando el id, color y eventos de las que ya existían (por id o por nombre). */
function mergeStages(existing: any[], wanted: ColumnArgs[]) {
  return wanted.map((c) => {
    const old = existing.find((s) => (c.id && s.id === c.id) || s.name.trim().toLowerCase() === c.nombre.trim().toLowerCase());
    return {
      ...(old ? { id: old.id, color: old.color, events: old.events ?? [] } : {}),
      name: c.nombre, kind: c.tipo ? KIND[c.tipo] : old?.kind ?? 'open', when: c.cuando ?? old?.when ?? '',
    };
  });
}

const Fields = z.object({
  embudo_id: Id.optional(),
  nombre: Text(80).optional(),
  columnas: z.array(Column).min(2).max(15).optional().describe('La lista completa, en orden; la primera, abierta'),
  agentes: z.array(Id).max(100).optional().describe('Agentes cuyas conversaciones entran a este embudo'),
  permitir_regresar: z.boolean().optional(),
  moneda: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
});
type Args = z.infer<typeof Fields>;

/** ¿El cambio mueve oportunidades o quita agentes de otro embudo? Entonces se confirma. */
async function pipelineRisk(a: Args, ctx: Ctx): Promise<RiskInfo> {
  const reasons: string[] = [];
  const all = await pipelines(ctx);
  if (a.agentes?.length) {
    const others = all.filter((p) => p.id !== a.embudo_id && (p.chatbot_ids ?? []).some((id: string) => a.agentes!.includes(id)));
    if (others.length) reasons.push(`Los agentes elegidos dejan de usar ${others.map((p) => `«${p.name}»`).join(', ')}.`);
  }
  if (a.embudo_id && a.columnas) {
    const p = all.find((x) => x.id === a.embudo_id);
    if (p) {
      const kept = new Set(mergeStages(p.stages ?? [], a.columnas).map((s: any) => s.id).filter(Boolean));
      const gone = (p.stages ?? []).filter((s: any) => !kept.has(s.id));
      const moved = (await cardsOf(ctx, p.id)).filter((c) => gone.some((s: any) => s.id === c.stage_id)).length;
      if (moved) reasons.push(`Quitas columnas con ${moved} oportunidad(es): pasan a la primera columna.`);
    }
  }
  return reasons.length ? { level: 'confirm', reasons } : { level: 'reversible', reasons: [] };
}

export const guardarEmbudo = defineTool({
  name: 'guardar_embudo',
  area: 'oportunidades',
  roles: ['admin'],
  description: 'Crea un embudo de oportunidades (sin embudo_id: nombre y columnas) o cambia uno: nombre, columnas (lista completa en orden), agentes que lo usan, regresar o moneda.',
  schema: Fields.refine((a) => (a.embudo_id ? a.nombre || a.columnas || a.agentes || a.permitir_regresar !== undefined || a.moneda : a.nombre && a.columnas), 'Para crear, indica nombre y columnas'),
  label: (a) => (a.embudo_id ? 'Cambiando el embudo…' : 'Creando el embudo…'),
  risk: pipelineRisk,
  targets: (a) => (a.embudo_id ? [{ kind: 'pipeline', id: a.embudo_id }] : []),
  async preview(a, ctx) {
    const p = a.embudo_id ? await pipelineOf(ctx, a.embudo_id) : null;
    const stages = a.columnas ? mergeStages(p?.stages ?? [], a.columnas) : null;
    return {
      title: p ? `Cambiar el embudo «${p.name}»` : `Crear el embudo «${a.nombre}»`,
      lines: [...(a.nombre && p ? [`Nombre: ${a.nombre}`] : []), ...(stages ? [`Columnas: ${stages.map((s) => `${s.name} (${KIND_ES[s.kind]})`).join(' → ')}`] : [])],
    };
  },
  async execute(a, ctx) {
    const before = a.embudo_id ? await pipelineOf(ctx, a.embudo_id) : null;
    const body = {
      ...(a.nombre ? { name: a.nombre } : {}), ...(a.columnas ? { stages: mergeStages(before?.stages ?? [], a.columnas) } : {}),
      ...(a.agentes ? { chatbot_ids: a.agentes } : {}), ...(a.permitir_regresar !== undefined ? { allow_backward: a.permitir_regresar } : {}),
      ...(a.moneda ? { currency: a.moneda.toUpperCase() } : {}),
    };
    const p = before ? await ctx.call.send<any>('PUT', path`/api/pipelines/${before.id}`, body) : await ctx.call.send<any>('POST', '/api/pipelines', body);
    return {
      title: before ? `Cambié el embudo «${p.name}»` : `Creé el embudo «${p.name}» (${p.stages.length} columnas)`,
      links: [links.pipeline(p.id, 'Ver embudo')],
      before: before ? pipelineShape(before) : null,
      after: pipelineShape(p),
      undo: { label: 'Deshacer', custom: { tool: 'guardar_embudo', params: { id: p.id, before: before ? pipelineShape(before) : null, after: pipelineShape(p) } } },
      data: pipelineOut(p),
    };
  },
  async undo(p: { id: string; before: Record<string, unknown> | null; after: unknown }, ctx) {
    const cur = (await pipelines(ctx)).find((x) => x.id === p.id);
    if (!cur) { if (!p.before) return; throw new ToolError('conflicto', 'El embudo ya no existe.'); }
    if (stableJson(pipelineShape(cur)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El embudo cambió después; para no perder esos cambios, no lo regresé.');
    if (p.before) { await ctx.call.send('PUT', path`/api/pipelines/${p.id}`, p.before); return; }
    if ((await cardsOf(ctx, p.id)).length) throw new ToolError('conflicto', 'El embudo ya tiene oportunidades; para quitarlo, bórralo.');
    await ctx.call.send('DELETE', path`/api/pipelines/${p.id}`);
  },
});

export const borrarEmbudo = defineTool({
  name: 'borrar_embudo',
  area: 'oportunidades',
  roles: ['admin'],
  description: 'Borra un embudo de oportunidades con todas sus oportunidades (requiere confirmación; no se puede deshacer).',
  schema: z.object({ embudo_id: Id }),
  label: () => 'Preparando el borrado del embudo…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const p = await pipelineOf(ctx, a.embudo_id);
    const n = (await cardsOf(ctx, p.id)).length;
    return { title: `Borrar el embudo «${p.name}»`, lines: [n ? `Se borran sus oportunidades (${n} en el último año) y su historial.` : 'No tiene oportunidades.', 'No se puede deshacer.'] };
  },
  async execute(a, ctx) {
    const p = await pipelineOf(ctx, a.embudo_id);
    await ctx.call.send('DELETE', path`/api/pipelines/${p.id}`);
    return { title: `Borré el embudo «${p.name}»`, data: { borrado: true } };
  },
});

export const PIPELINE_TOOLS = [guardarEmbudo, borrarEmbudo];
