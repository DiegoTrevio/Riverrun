/**
 * Riesgo final de una acción del Copiloto. Parte del que declara la herramienta y sube a «confirmar» cuando:
 *  1. el cambio dispara una regla activa que manda mensajes, inicia secuencias o llama a otros sistemas;
 *  2. el turno leyó texto escrito por clientes y el cambio toca un registro fuera de lo que la persona está viendo,
 *     de las acciones a las que se refirió o de lo que se leyó (contra instrucciones escondidas en mensajes).
 */
import { query } from '../db.js';
import type { Ctx, RiskInfo, ToolDef, TriggerHint } from './registry.js';
import { riskInfo } from './registry.js';

/** Acciones de una regla que llegan a clientes u otros sistemas. */
const OUTWARD = new Set(['send_message', 'start_sequence', 'webhook', 'send_conversation', 'send_report']);

interface RuleRow { name: string; trigger: Record<string, any>; actions: { type: string }[] }

function matches(trigger: Record<string, any>, hint: TriggerHint): boolean {
  if (trigger?.type !== hint.type) return false;
  const v = hint.value ?? '';
  switch (hint.type) {
    case 'tag_added': return trigger.tag === v;
    case 'data_captured': return !trigger.field || trigger.field === v;
    case 'appointment_booked': case 'appointment_cancelled': return !trigger.service_id || trigger.service_id === v;
    case 'pipeline_stage': {
      const [pipeline, stage] = v.split(':');
      return (!trigger.pipeline_id || trigger.pipeline_id === pipeline) && (!trigger.stage_id || trigger.stage_id === stage);
    }
    default: return true;
  }
}

/** Reglas activas de la cuenta que se dispararían con estos eventos y que mandan algo hacia afuera. */
export async function outwardRules(accountId: string, hints: TriggerHint[]): Promise<string[]> {
  if (!hints.length) return [];
  const rules = await query<RuleRow>(`SELECT name, trigger, actions FROM automations WHERE account_id = $1 AND active`, [accountId]);
  const names = rules
    .filter((r) => hints.some((h) => matches(r.trigger, h)) && (r.actions ?? []).some((a) => OUTWARD.has(a.type)))
    .map((r) => r.name || 'sin nombre');
  return [...new Set(names)];
}

export async function assessRisk(def: ToolDef, args: unknown, ctx: Ctx): Promise<RiskInfo> {
  const base = riskInfo(await def.risk(args, ctx));
  if (base.level !== 'reversible') return base;
  const reasons = [...base.reasons];
  const rules = def.events ? await outwardRules(ctx.accountId, await def.events(args, ctx)) : [];
  if (rules.length) reasons.push(`Esto activará ${rules.length === 1 ? 'la regla' : 'las reglas'} ${rules.map((n) => `«${n}»`).join(', ')}, que envía${rules.length === 1 ? '' : 'n'} algo al cliente o a otro sistema.`);
  if (ctx.tainted && def.targets) {
    const targets = await def.targets(args, ctx);
    const outside = targets.filter((t) => !ctx.scope.has(t.id));
    if (outside.length) reasons.push('En este pedido leí mensajes escritos por clientes; confirma este cambio, que toca registros que no estabas viendo.');
  }
  return reasons.length > base.reasons.length ? { level: 'confirm', reasons } : base;
}
