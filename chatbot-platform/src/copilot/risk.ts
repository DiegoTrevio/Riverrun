/**
 * Riesgo final de una acción del Copiloto. Parte del que declara la herramienta y sube a «confirmar» cuando:
 *  1. el cambio dispara una regla activa que manda mensajes, inicia secuencias o llama a otros sistemas;
 *  2. el turno leyó texto escrito por clientes (o lo trae el historial) y el cambio es de configuración, no dice qué
 *     registros toca o toca uno fuera de lo que la persona está viendo, de las acciones a las que se refirió o de lo que
 *     se leyó antes de ese texto (contra instrucciones escondidas en mensajes).
 */
import { query } from '../db.js';
import { normalize } from '../engine/text.js';
import type { Ctx, RiskInfo, Target, ToolDef, TriggerHint } from './registry.js';
import { riskInfo } from './registry.js';

/** Acciones de una regla que llegan a clientes u otros sistemas. */
export const OUTWARD = new Set(['send_message', 'start_sequence', 'webhook', 'send_conversation', 'send_report']);
const CONFIG_AREAS = new Set(['agente', 'automatizacion', 'cuenta']);

interface RuleRow { name: string; trigger: Record<string, any>; actions: { type: string; tag?: string }[] }

function matches(trigger: Record<string, any>, hint: TriggerHint): boolean {
  if (trigger?.type !== hint.type) return false;
  const v = hint.value ?? '';
  switch (hint.type) {
    // Igual que el motor de reglas: sin mayúsculas ni acentos.
    case 'tag_added': return normalize(trigger.tag ?? '') === normalize(v);
    case 'data_captured': return !trigger.field || trigger.field === v;
    case 'appointment_booked': case 'appointment_cancelled': return !trigger.service_id || trigger.service_id === v;
    case 'pipeline_stage': {
      const [pipeline, stage] = v.split(':');
      return (!trigger.pipeline_id || trigger.pipeline_id === pipeline) && (!trigger.stage_id || trigger.stage_id === stage);
    }
    default: return true;
  }
}

/**
 * Reglas activas de la cuenta que se dispararían con estos eventos y que mandan algo hacia afuera. Una regla que agrega
 * una etiqueta dispara a su vez las reglas de esa etiqueta: se siguen hasta tres saltos.
 */
export async function outwardRules(accountId: string, hints: TriggerHint[]): Promise<string[]> {
  if (!hints.length) return [];
  const rules = await query<RuleRow>(`SELECT name, trigger, actions FROM automations WHERE account_id = $1 AND active`, [accountId]);
  const names = new Set<string>();
  const seen = new Set<RuleRow>();
  let wave = hints;
  for (let depth = 0; depth < 3 && wave.length; depth++) {
    const fired = rules.filter((r) => !seen.has(r) && wave.some((h) => matches(r.trigger, h)));
    fired.forEach((r) => seen.add(r));
    for (const r of fired) if ((r.actions ?? []).some((a) => OUTWARD.has(a.type))) names.add(r.name || 'sin nombre');
    wave = fired.flatMap((r) => (r.actions ?? []).filter((a) => a.type === 'add_tag' && a.tag).map((a) => ({ type: 'tag_added', value: a.tag })));
  }
  return [...names];
}

/**
 * Contacto dueño de cada conversación o cita (de esta cuenta). El alcance es por cliente: si la persona buscó a Ana, su
 * conversación y sus citas también son «lo que estaba viendo», aunque el id que se leyó fuera el del contacto.
 */
async function ownerContacts(accountId: string, targets: Target[]): Promise<Map<string, string>> {
  const ids = (kind: string) => targets.filter((t) => t.kind === kind).map((t) => t.id);
  const [conversations, appointments] = [ids('conversation'), ids('appointment')];
  if (!conversations.length && !appointments.length) return new Map();
  const rows = await query<{ id: string; contact_id: string }>(
    `SELECT id, contact_id FROM conversations WHERE account_id = $1 AND id = ANY($2::uuid[])
     UNION ALL SELECT id, contact_id FROM appointments WHERE account_id = $1 AND id = ANY($3::uuid[]) AND contact_id IS NOT NULL`,
    [accountId, conversations, appointments],
  );
  return new Map(rows.map((r) => [r.id, r.contact_id]));
}

export async function assessRisk(def: ToolDef, args: unknown, ctx: Ctx): Promise<RiskInfo> {
  const base = riskInfo(await def.risk(args, ctx));
  if (base.level !== 'reversible') return base;
  const reasons = [...base.reasons];
  const rules = def.events ? await outwardRules(ctx.accountId, await def.events(args, ctx)) : [];
  if (rules.length) reasons.push(`Esto activará ${rules.length === 1 ? 'la regla' : 'las reglas'} ${rules.map((n) => `«${n}»`).join(', ')}, que envía${rules.length === 1 ? '' : 'n'} algo al cliente o a otro sistema.`);
  // La configuración (agente, automatizaciones, horario) cambia cómo se atiende a todos, y una herramienta que no dice qué
  // registros toca no se puede acotar: tras leer texto de clientes, ambas se confirman.
  if (ctx.tainted && (CONFIG_AREAS.has(def.area) || !def.targets)) reasons.push('Antes leí mensajes escritos por clientes; confirma este cambio.');
  else if (ctx.tainted && def.targets) {
    const targets = await def.targets(args, ctx);
    const outside = targets.filter((t) => !ctx.scope.has(t.id));
    const owners = await ownerContacts(ctx.accountId, outside);
    if (outside.some((t) => !ctx.scope.has(owners.get(t.id) ?? ''))) reasons.push('Antes leí mensajes escritos por clientes; confirma este cambio, que toca registros que no estabas viendo.');
  }
  return reasons.length > base.reasons.length ? { level: 'confirm', reasons } : base;
}
