/**
 * Herramientas del Copiloto para automatizar (solo administradores): flujos del lienzo (con IA), reglas, secuencias y
 * campañas. Armar y cambiar es reversible; publicar, reanudar, lanzar, cancelar, borrar y dejar activo algo que manda
 * mensajes se confirma.
 */
import { z } from 'zod';
import { ActionSchema, ConditionSchema, TriggerSchema } from '../../automation/types.js';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx, type RiskInfo } from '../registry.js';
import { OUTWARD } from '../risk.js';
import { stableJson } from '../store.js';
import { links, when } from '../summarize.js';
import { Id } from './common.js';

const Text = (max: number) => z.string().trim().min(1).max(max);
const quote = (s: string, n = 60) => `«${s.length > n ? `${s.slice(0, n)}…` : s}»`;

// --- Cómo se describe una regla en palabras ----------------------------------------------------------------------

export function describeTrigger(t: any): string {
  if (!t) return 'lo inicias tú (desde una conversación o una campaña)';
  const words = (list: string[]) => list.slice(0, 4).map((k) => `«${k}»`).join(' o ');
  switch (t.type) {
    case 'message_received':
      return (t.match === 'any' || !t.keywords?.length ? 'llega un mensaje' : `el cliente escribe ${words(t.keywords)}`) + (t.first_message_only ? ' (solo el primero)' : '');
    case 'new_contact': return 'escribe un cliente nuevo';
    case 'intent': return `el asistente detecta «${t.intent}»`;
    case 'data_captured': return t.field ? `se guarda el dato «${t.field}»` : 'se guarda un dato del cliente';
    case 'tag_added': return `se agrega la etiqueta «${t.tag}»`;
    case 'handoff': return 'la conversación pasa a una persona';
    case 'no_reply': return `el cliente no responde en ${t.minutes} min`;
    case 'appointment_booked': return 'se agenda una cita';
    case 'appointment_cancelled': return 'se cancela una cita';
    case 'opt_out': return 'el cliente se da de baja';
    case 'goal_completed': return 'se cumple el objetivo del agente';
    case 'quote_sent': return 'se envía una cotización';
    case 'quote_pending_approval': return 'una cotización espera aprobación';
    case 'quote_rejected': return 'se rechaza una cotización';
    case 'quote_accepted': return 'el cliente acepta una cotización';
    case 'payment_due': return 'vence un cobro hoy';
    case 'payment_overdue': return 'un cobro venció sin pagarse';
    case 'payment_paid': return 'se marca un cobro como pagado';
    case 'stage_reached': return t.step ? `la conversación llega a la etapa ${t.step}` : 'la conversación cambia de etapa';
    case 'agent_off': return 'el asistente se apaga en la conversación';
    case 'pipeline_stage': return 'una oportunidad cambia de columna';
    default: return String(t.type ?? 'otro evento');
  }
}

export function describeAction(a: any): string {
  switch (a.type) {
    case 'send_message': return `envía ${quote(a.text || (a.wa_template ? 'una plantilla de WhatsApp' : 'un mensaje'))}${a.delay_minutes ? ` a los ${a.delay_minutes} min` : ''}`;
    case 'add_tag': return `agrega la etiqueta «${a.tag}»`;
    case 'remove_tag': return `quita la etiqueta «${a.tag}»`;
    case 'set_field': return `guarda «${a.field}» = ${quote(a.value, 30)}`;
    case 'alert_team': return a.phones?.length ? `avisa al equipo (también por WhatsApp a ${a.phones.length} número(s))` : 'avisa al equipo';
    case 'assign': return a.take_over ? 'asigna la conversación y la pasa a una persona' : 'asigna la conversación a alguien del equipo';
    case 'handoff': return 'pasa la conversación a una persona';
    case 'resume_bot': return 'reactiva al asistente';
    case 'pause_bot': return a.hours ? `pausa al asistente ${a.hours} h` : 'pausa al asistente';
    case 'close_conversation': return 'cierra la conversación';
    case 'create_task': return `${a.kind === 'nota' ? 'crea la nota' : 'crea el pendiente'} ${quote(a.body, 40)}`;
    case 'start_sequence': return 'inicia una secuencia de mensajes';
    case 'stop_sequences': return 'detiene sus secuencias';
    default: return String(a.type);
  }
}

// --- Reglas ---------------------------------------------------------------------------------------------------------

/** Acciones que el Copiloto puede poner en una regla (las que mandan datos a otros sistemas o correos quedan fuera). */
const RULE_ACTIONS = (ActionSchema.options as any[]).filter((o) => !['webhook', 'send_conversation', 'send_report'].includes(o.shape.type.value));
const RuleAction = z.discriminatedUnion('type', RULE_ACTIONS as any) as unknown as z.ZodType<any>;

const RuleFields = {
  nombre: Text(120),
  cuando: TriggerSchema.describe('Disparador: qué hace que corra la regla'),
  condiciones: z.array(ConditionSchema).max(10).optional().describe('Solo corre si se cumplen todas'),
  acciones: z.array(RuleAction).min(1).max(10),
  activa: z.boolean().optional().describe('Por omisión queda activa'),
  agente_id: Id.nullable().optional().describe('Solo para las conversaciones de este agente (vacío = todos)'),
  detener_asistente: z.boolean().optional().describe('Si se cumple, el asistente no contesta ese mensaje'),
  una_vez_por_conversacion: z.boolean().optional(),
};
const ruleBody = (a: any) => ({
  ...(a.nombre !== undefined ? { name: a.nombre } : {}),
  ...(a.cuando !== undefined ? { trigger: a.cuando } : {}),
  ...(a.condiciones !== undefined ? { conditions: a.condiciones } : {}),
  ...(a.acciones !== undefined ? { actions: a.acciones } : {}),
  ...(a.activa !== undefined ? { active: a.activa } : {}),
  ...(a.agente_id !== undefined ? { chatbot_id: a.agente_id } : {}),
  ...(a.detener_asistente !== undefined ? { stop_ai: a.detener_asistente } : {}),
  ...(a.una_vez_por_conversacion !== undefined ? { once_per_conversation: a.una_vez_por_conversacion } : {}),
});
const RULE_KEYS = ['name', 'active', 'chatbot_id', 'trigger', 'conditions', 'actions', 'stop_ai', 'once_per_conversation'];
const ruleShape = (r: any) => Object.fromEntries(RULE_KEYS.map((k) => [k, r[k] ?? null]));

/** ¿La regla, como quedaría, manda algo afuera o calla al asistente? Entonces se confirma. */
function ruleRisk(rule: { active?: boolean; actions?: any[]; stop_ai?: boolean }): RiskInfo {
  const reasons: string[] = [];
  if (rule.active !== false) {
    if ((rule.actions ?? []).some((x) => OUTWARD.has(x.type) || (x.type === 'alert_team' && x.phones?.length))) reasons.push('La regla queda activa y envía mensajes a clientes o a otros números.');
    if (rule.stop_ai) reasons.push('La regla queda activa y hace que el asistente no conteste cuando se cumple.');
  }
  return reasons.length ? { level: 'confirm', reasons } : { level: 'reversible', reasons: [] };
}

/** Una acción completa para quien confirma: el texto entero de lo que se envía y a qué números. */
function actionDetail(a: any): string {
  if (a.type === 'send_message') return `→ Envía al cliente${a.delay_minutes ? ` (a los ${a.delay_minutes} min)` : ''}: «${a.text || (a.wa_template ? 'una plantilla de WhatsApp' : '')}»`;
  if (a.type === 'alert_team') return `→ Avisa al equipo${a.phones?.length ? ` y por WhatsApp a ${a.phones.join(', ')}` : ''}: «${a.message}»`;
  return `→ ${describeAction(a)}`;
}

function rulePreview(title: string, rule: any) {
  const msg = (rule.actions ?? []).find((x: any) => x.type === 'send_message' && x.text);
  return {
    title,
    lines: [
      `Cuando ${describeTrigger(rule.trigger)}${rule.conditions?.length ? ` (con ${rule.conditions.length} condición(es))` : ''}:`,
      ...(rule.actions ?? []).map(actionDetail),
      ...(rule.stop_ai ? ['El asistente no contesta ese mensaje.'] : []),
      ...(rule.once_per_conversation ? ['Una sola vez por conversación.'] : []),
      ...(rule.chatbot_id ? [] : ['Para las conversaciones de todos los agentes.']),
    ],
    ...(msg ? { quote: msg.text } : {}),
  };
}

async function findRule(ctx: Ctx, id: string) {
  const rule = ((await ctx.call.get<any[]>('/api/automations')) ?? []).find((r) => r.id === id);
  if (!rule) throw new ToolError('no_encontrado', 'Regla no encontrada');
  if (rule.board_id) throw new ToolError('no_disponible', 'Esta regla es parte de un flujo del lienzo: cámbiala con cambiar_flujo o pausa el flujo.');
  return rule;
}

export const crearRegla = defineTool({
  name: 'crear_regla',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Crea una regla: cuando pasa algo, hace acciones (etiquetar, avisar al equipo, asignar, crear un pendiente, enviar un mensaje…). Activa y con envíos, se confirma. Para varios mensajes o botones, crear_flujo.',
  schema: z.object(RuleFields),
  label: (a) => `Creando la regla «${a.nombre}»…`,
  risk: (a) => ruleRisk({ active: a.activa, actions: a.acciones, stop_ai: a.detener_asistente }),
  preview: (a) => rulePreview(`Crear la regla «${a.nombre}»${a.activa === false ? ' (en pausa)' : ' (activa)'}`, ruleBody(a)),
  async execute(a, ctx) {
    const r = await ctx.call.send<any>('POST', '/api/automations', { active: true, ...ruleBody(a) });
    return {
      title: `Creé la regla «${r.name}»${r.active ? '' : ' (en pausa)'}: cuando ${describeTrigger(r.trigger)}`,
      links: [links.rule(r.id)],
      after: ruleShape(r),
      undo: { label: 'Deshacer', custom: { tool: 'crear_regla', params: { id: r.id, after: ruleShape(r) } } },
      data: { regla_id: r.id, activa: r.active, hace: r.actions.map(describeAction) },
    };
  },
  async undo(p: { id: string; after: unknown }, ctx) {
    const rule = ((await ctx.call.get<any[]>('/api/automations')) ?? []).find((r) => r.id === p.id);
    if (!rule) return;
    if (stableJson(ruleShape(rule)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La regla cambió después; para no perder esos cambios, no la borré.');
    await ctx.call.send('DELETE', path`/api/automations/${p.id}`);
  },
});

const CambiarRegla = z.object({ regla_id: Id, ...Object.fromEntries(Object.entries(RuleFields).map(([k, v]) => [k, (v as z.ZodType).optional()])) } as any)
  .refine((a: any) => Object.keys(RuleFields).some((k) => a[k] !== undefined), 'Indica qué cambiar') as unknown as z.ZodType<any>;

/** Lo que ve el modelo: sin repetir el esquema largo de crear_regla (el servidor valida con el completo). */
const sameAs = (field: string) => `Misma forma que «${field}» en crear_regla`;
const CambiarReglaParaModelo = z.object({
  regla_id: Id,
  ...Object.fromEntries(Object.entries(RuleFields).map(([k, v]) => [k, (v as z.ZodType).optional()])),
  cuando: z.looseObject({}).optional().describe(sameAs('cuando')),
  condiciones: z.array(z.looseObject({})).max(10).optional().describe(sameAs('condiciones')),
  acciones: z.array(z.looseObject({})).min(1).max(10).optional().describe(sameAs('acciones')),
  activa: z.boolean().optional().describe('false la pausa; true la activa'),
});

export const cambiarRegla = defineTool({
  name: 'cambiar_regla',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Cambia una regla existente: nombre, disparador, condiciones, acciones (la lista completa nueva), pausarla (activa: false) o activarla. Activarla o cambiar lo que hace se confirma si envía mensajes.',
  schema: CambiarRegla,
  modelSchema: CambiarReglaParaModelo,
  label: () => 'Cambiando la regla…',
  async risk(a: any, ctx) {
    const rule = await findRule(ctx, a.regla_id);
    // Solo renombrar o pausar no cambia lo que la regla manda; lo demás (incluido a qué agente aplica o cuántas veces) sí.
    const material = Object.keys(RuleFields).some((k) => a[k] !== undefined && k !== 'nombre' && !(k === 'activa' && a[k] === false));
    return material ? ruleRisk({ ...rule, ...ruleBody(a) }) : 'reversible';
  },
  async preview(a: any, ctx) {
    const rule = await findRule(ctx, a.regla_id);
    const next = { ...rule, ...ruleBody(a) };
    return rulePreview(`Cambiar la regla «${rule.name}»${next.active ? ' (activa)' : ' (en pausa)'}`, next);
  },
  async execute(a: any, ctx) {
    const rule = await findRule(ctx, a.regla_id);
    const body = ruleBody(a);
    const r = await ctx.call.send<any>('PUT', path`/api/automations/${rule.id}`, body);
    const onlyActive = Object.keys(body).length === 1 && a.activa !== undefined;
    return {
      title: `${onlyActive ? (a.activa ? 'Activé' : 'Pausé') : 'Cambié'} la regla «${r.name}»`,
      links: [links.rule(r.id)],
      before: ruleShape(rule),
      after: ruleShape(r),
      undo: { label: 'Deshacer', custom: { tool: 'cambiar_regla', params: { id: r.id, before: ruleShape(rule), after: ruleShape(r) } } },
      data: { regla_id: r.id, activa: r.active, cuando: describeTrigger(r.trigger), hace: r.actions.map(describeAction) },
    };
  },
  async undo(p: { id: string; before: any; after: unknown }, ctx) {
    const rule = await findRule(ctx, p.id);
    if (stableJson(ruleShape(rule)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La regla cambió después; para no perder esos cambios, no la regresé.');
    await ctx.call.send('PUT', path`/api/automations/${p.id}`, p.before);
  },
});

// --- Secuencias -----------------------------------------------------------------------------------------------------

async function findSequence(ctx: Ctx, id: string) {
  const seq = ((await ctx.call.get<any[]>('/api/sequences')) ?? []).find((s) => s.id === id);
  if (!seq) throw new ToolError('no_encontrado', 'Secuencia no encontrada');
  if (seq.board_id) throw new ToolError('no_disponible', 'Esta secuencia es parte de un flujo del lienzo: cámbiala con cambiar_flujo.');
  return seq;
}
const SEQ_KEYS = ['name', 'active', 'steps', 'stop_on_reply', 'business_hours_only'];
const seqShape = (s: any) => Object.fromEntries(SEQ_KEYS.map((k) => [k, s[k] ?? null]));

const EditarSecuencia = z.object({
  secuencia_id: Id,
  nombre: Text(120).optional(),
  activa: z.boolean().optional(),
  pasos: z.array(z.object({
    numero: z.number().int().min(1).max(30).describe('Paso que cambia (1 = el primero)'),
    texto: z.string().trim().max(4000).optional(),
    espera: z.object({ valor: z.number().int().min(0).max(10000), unidad: z.enum(['minutes', 'hours', 'days']) }).optional().describe('Espera desde el paso anterior'),
  })).max(30).optional().describe('Solo los pasos que cambian'),
}).refine((a) => a.nombre !== undefined || a.activa !== undefined || a.pasos?.length, 'Indica qué cambiar');

export const editarSecuencia = defineTool({
  name: 'editar_secuencia',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Cambia el nombre de una secuencia, la pausa o activa, o cambia el texto o la espera de algunos de sus pasos. Si hay personas en ella y cambian los mensajes, se confirma.',
  schema: EditarSecuencia,
  label: () => 'Editando la secuencia…',
  async risk(a, ctx) {
    const seq = await findSequence(ctx, a.secuencia_id);
    const people = Number(seq.enrollments?.active ?? 0);
    if (people && (a.pasos?.length || a.activa === true)) return { level: 'confirm', reasons: [`${people} persona(s) van en esta secuencia: el cambio les llega en sus próximos mensajes.`] };
    return 'reversible';
  },
  async preview(a, ctx) {
    const seq = await findSequence(ctx, a.secuencia_id);
    return {
      title: `Cambiar la secuencia «${seq.name}»`,
      lines: [
        ...(a.activa !== undefined ? [a.activa ? 'Se activa.' : 'Se pausa.'] : []),
        ...(a.pasos ?? []).map((p) => `Paso ${p.numero}: ${p.texto !== undefined ? `«${p.texto}»` : ''}${p.espera ? ` (espera ${p.espera.valor} ${p.espera.unidad})` : ''}`),
      ],
    };
  },
  async execute(a, ctx) {
    const seq = await findSequence(ctx, a.secuencia_id);
    const steps = (seq.steps as any[]).map((s) => ({ ...s }));
    for (const p of a.pasos ?? []) {
      const st = steps[p.numero - 1];
      if (!st) throw new ToolError('datos_invalidos', `La secuencia tiene ${steps.length} paso(s); no hay paso ${p.numero}.`);
      if (p.texto !== undefined) st.text = p.texto;
      if (p.espera) { st.delay_value = p.espera.valor; st.delay_unit = p.espera.unidad; }
    }
    const s = await ctx.call.send<any>('PUT', path`/api/sequences/${seq.id}`, {
      ...(a.nombre !== undefined ? { name: a.nombre } : {}), ...(a.activa !== undefined ? { active: a.activa } : {}), ...(a.pasos?.length ? { steps } : {}),
    });
    const verb = a.pasos?.length || a.nombre !== undefined ? 'Cambié' : a.activa ? 'Activé' : 'Pausé';
    return {
      title: `${verb} la secuencia «${s.name}»`,
      links: [links.sequence(s.id)],
      before: seqShape(seq),
      after: seqShape(s),
      undo: { label: 'Deshacer', custom: { tool: 'editar_secuencia', params: { id: s.id, before: seqShape(seq), after: seqShape(s) } } },
      data: { secuencia_id: s.id, activa: s.active, pasos: s.steps.length },
    };
  },
  async undo(p: { id: string; before: any; after: unknown }, ctx) {
    const seq = await findSequence(ctx, p.id);
    if (stableJson(seqShape(seq)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La secuencia cambió después; para no perder esos cambios, no la regresé.');
    await ctx.call.send('PUT', path`/api/sequences/${p.id}`, p.before);
  },
});

// --- Flujos del lienzo ----------------------------------------------------------------------------------------------

async function boardOf(ctx: Ctx, id: string) {
  const b = await ctx.call.get<any>(path`/api/flow-boards/${id}`);
  if (!b?.id) throw new ToolError('no_encontrado', 'Flujo no encontrado');
  return b;
}
const errorsOf = (problems: any[] = []) => problems.filter((p) => !p.warning).map((p) => p.message);
const WAIT_UNIT: Record<string, string> = { minutes: 'min', hours: 'h', days: 'día(s)' };

/** El lienzo en pocas palabras: su inicio y sus mensajes, en el orden en que se ven. */
function boardOutline(board: any) {
  const nodes = [...(board?.nodes ?? [])].sort((x, y) => x.y - y.y || x.x - y.x);
  return nodes.flatMap((n): Record<string, unknown>[] => {
    if (n.type === 'trigger') return [{ inicio: describeTrigger(n.data.trigger) }];
    if (n.type === 'message') return [{ mensaje: n.data.text, botones: (n.data.buttons ?? []).map((b: any) => b.label) }];
    if (n.type === 'wait') return [{ espera: `${n.data.value} ${WAIT_UNIT[n.data.unit] ?? n.data.unit}${n.data.at_time ? ` a las ${n.data.at_time}` : ''}` }];
    if (n.type === 'action') return [{ accion: n.data.action === 'tag' ? `etiqueta «${n.data.tag}»` : n.data.action }];
    return [];
  });
}

export const verFlujo = defineTool({
  name: 'ver_flujo',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Un flujo del lienzo: cómo empieza, sus mensajes y botones, si está publicado o en pausa y qué le falta para publicarse.',
  schema: z.object({ flujo_id: Id }),
  label: () => 'Revisando el flujo…',
  risk: () => 'read',
  async execute(a, ctx) {
    const b = await boardOf(ctx, a.flujo_id);
    return {
      title: `Revisé el flujo «${b.name}»`,
      links: [links.board(b.id)],
      read: [{ kind: 'board', id: b.id }],
      data: {
        id: b.id, nombre: b.name, publicado: b.published_revision != null, en_pausa: b.paused || undefined, cambios_sin_publicar: b.pending || undefined,
        le_falta: errorsOf(b.problems), avisos: (b.problems ?? []).filter((p: any) => p.warning).map((p: any) => p.message), pasos: boardOutline(b.board),
      },
    };
  },
});

export const crearFlujo = defineTool({
  name: 'crear_flujo',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Arma con IA un flujo nuevo en el lienzo (mensajes con botones, esperas, etiquetas) a partir de la idea descrita. Queda como borrador: no se envía nada hasta publicarlo.',
  schema: z.object({ idea: Text(4000).describe('Qué debe hacer el flujo, cuándo empieza y qué mensajes manda'), nombre: Text(120).optional() }),
  label: () => 'Armando el flujo con IA…',
  risk: () => 'reversible',
  async execute(a, ctx) {
    const design = await ctx.call.send<any>('POST', '/api/flow-boards/ai', { idea: a.idea, ...(a.nombre ? { name: a.nombre } : {}) });
    const row = await ctx.call.send<any>('POST', '/api/flow-boards', { name: (a.nombre || design.name || 'Flujo nuevo').slice(0, 120), board: design.board });
    return {
      title: `Armé el flujo «${row.name}» (borrador, sin publicar)`,
      links: [links.board(row.id, 'Abrir en el lienzo')],
      after: { revision: row.revision },
      undo: { label: 'Deshacer', custom: { tool: 'crear_flujo', params: { id: row.id, revision: row.revision } } },
      data: { flujo_id: row.id, resumen: design.summary, revisar: design.review, le_falta: errorsOf(row.problems), pasos: boardOutline(design.board) },
    };
  },
  async undo(p: { id: string; revision: number }, ctx) {
    let b;
    try { b = await boardOf(ctx, p.id); } catch (e) { if (e instanceof ToolError && e.code === 'no_encontrado') return; throw e; }
    if (b.published_revision != null) throw new ToolError('conflicto', 'El flujo ya se publicó; para quitarlo, bórralo o páusalo.');
    if (b.revision !== p.revision) throw new ToolError('conflicto', 'El flujo cambió después; para no perder esos cambios, no lo borré.');
    await ctx.call.send('DELETE', path`/api/flow-boards/${p.id}`);
  },
});

export const cambiarFlujo = defineTool({
  name: 'cambiar_flujo',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Cambia con IA un flujo del lienzo según lo que se pide en palabras. Si ya estaba publicado, el cambio queda pendiente hasta volver a publicarlo.',
  schema: z.object({ flujo_id: Id, cambio: Text(4000).describe('Qué cambiar («agrega un botón para hablar con alguien», «espera 2 días en vez de 1»)') }),
  label: () => 'Cambiando el flujo con IA…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'board', id: a.flujo_id }],
  async execute(a, ctx) {
    const b = await boardOf(ctx, a.flujo_id);
    const design = await ctx.call.send<any>('POST', '/api/flow-boards/ai', { idea: a.cambio, name: b.name, board: b.board });
    const saved = await ctx.call.send<any>('PUT', path`/api/flow-boards/${b.id}`, { revision: b.revision, board: design.board });
    const published = b.published_revision != null;
    return {
      title: `Cambié el flujo «${b.name}»${published ? ' (falta publicar el cambio)' : ''}`,
      links: [links.board(b.id, 'Abrir en el lienzo')],
      after: { revision: saved.revision },
      undo: { label: 'Deshacer', custom: { tool: 'cambiar_flujo', params: { id: b.id, board: b.board, revision: saved.revision } } },
      data: { resumen: design.summary, revisar: design.review, le_falta: errorsOf(saved.problems), pendiente_de_publicar: published || undefined, pasos: boardOutline(design.board) },
    };
  },
  async undo(p: { id: string; board: unknown; revision: number }, ctx) {
    const b = await boardOf(ctx, p.id);
    if (b.revision !== p.revision) throw new ToolError('conflicto', 'El flujo cambió después; para no perder esos cambios, no lo regresé.');
    await ctx.call.send('PUT', path`/api/flow-boards/${p.id}`, { revision: b.revision, board: p.board });
  },
});

export const publicarFlujo = defineTool({
  name: 'publicar_flujo',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Publica un flujo del lienzo: empieza a funcionar con los clientes (requiere confirmación).',
  schema: z.object({ flujo_id: Id }),
  label: () => 'Preparando la publicación del flujo…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const b = await boardOf(ctx, a.flujo_id);
    const check = await ctx.call.send<any>('POST', path`/api/flow-boards/${b.id}/check`, {});
    const errors = errorsOf(check.problems);
    if (errors.length) throw new ToolError('datos_invalidos', 'Antes de publicar falta resolver esto en el lienzo', errors);
    const start = (b.board?.nodes ?? []).find((n: any) => n.type === 'trigger');
    const messages = (check.sequences ?? []).reduce((n: number, s: any) => n + s.messages, 0);
    const warnings = (check.problems ?? []).filter((p: any) => p.warning).map((p: any) => p.message).join(' ');
    return {
      title: `Publicar el flujo «${b.name}»`,
      lines: [
        `Empieza cuando ${describeTrigger(start?.data?.trigger)}.`,
        `${messages} mensaje(s) en ${(check.sequences ?? []).length} rama(s).`,
        ...(b.paused ? ['Está en pausa: se publica, pero no corre hasta reanudarlo.'] : []),
      ],
      ...(warnings ? { warning: warnings } : {}),
      meta: { revision: b.revision },
    };
  },
  async execute(a, ctx) {
    const b = await boardOf(ctx, a.flujo_id);
    const seen = ctx.proposal?.meta?.revision;
    if (seen !== undefined && seen !== b.revision) throw new ToolError('conflicto', 'El flujo cambió después de la propuesta; pídemelo de nuevo para revisar la versión actual.');
    const r = await ctx.call.send<any>('POST', path`/api/flow-boards/${b.id}/publish`, { revision: b.revision });
    return {
      title: `Publiqué el flujo «${b.name}»`,
      links: [links.board(b.id, 'Abrir en el lienzo')],
      data: { publicado: true, en_pausa: r.paused || undefined, ramas: (r.sequences ?? []).length, nota: 'Para detenerlo, se puede pausar.' },
    };
  },
});

export const pausarReanudarFlujo = defineTool({
  name: 'pausar_o_reanudar_flujo',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Pausa un flujo publicado (deja de iniciar y quienes van en él se detienen en su siguiente mensaje) o lo reanuda (requiere confirmación).',
  schema: z.object({ flujo_id: Id, pausar: z.boolean() }),
  label: (a) => (a.pausar ? 'Pausando el flujo…' : 'Preparando la reanudación del flujo…'),
  risk: (a) => (a.pausar ? 'reversible' : 'confirm'),
  targets: (a) => [{ kind: 'board', id: a.flujo_id }],
  async preview(a, ctx) {
    const b = await boardOf(ctx, a.flujo_id);
    if (a.pausar) return { title: `Pausar el flujo «${b.name}»`, lines: ['Deja de iniciar y quienes van en él se detienen en su siguiente mensaje.'] };
    return { title: `Reanudar el flujo «${b.name}»`, lines: ['Vuelve a iniciar con los clientes y quienes iban en él siguen recibiendo sus mensajes.'] };
  },
  async execute(a, ctx) {
    const b = await boardOf(ctx, a.flujo_id);
    if (b.published_revision == null) throw new ToolError('datos_invalidos', 'Ese flujo no está publicado: no hay nada que pausar o reanudar.');
    if (!!b.paused === a.pausar) return { title: `El flujo «${b.name}» ya estaba ${a.pausar ? 'en pausa' : 'funcionando'}`, links: [links.board(b.id)], undo: null, data: { sin_cambios: true } };
    await ctx.call.send('POST', path`/api/flow-boards/${b.id}/pause`, { paused: a.pausar });
    return {
      title: `${a.pausar ? 'Pausé' : 'Reanudé'} el flujo «${b.name}»`,
      links: [links.board(b.id)],
      undo: { label: a.pausar ? 'Reanudarlo' : 'Volver a pausarlo', custom: { tool: 'pausar_o_reanudar_flujo', params: { id: b.id, paused: a.pausar } } },
      data: { en_pausa: a.pausar },
    };
  },
  async undo(p: { id: string; paused: boolean }, ctx) {
    const b = await boardOf(ctx, p.id);
    if (!!b.paused !== p.paused) throw new ToolError('conflicto', `El flujo ya está ${b.paused ? 'en pausa' : 'funcionando'}.`);
    await ctx.call.send('POST', path`/api/flow-boards/${p.id}/pause`, { paused: !p.paused });
  },
});

// --- Campañas -------------------------------------------------------------------------------------------------------

/** Una campaña de la cuenta (el panel solo las lista todas). */
async function campaignOf(ctx: Ctx, id: string) {
  const c = ((await ctx.call.get<any[]>('/api/campaigns')) ?? []).find((x) => x.id === id);
  if (!c) throw new ToolError('no_encontrado', 'Campaña no encontrada');
  return c;
}
const CAMPAIGN_KEYS = ['name', 'message', 'channel_id', 'kind', 'sequence_id', 'audience', 'scheduled_at', 'status'];
const campaignShape = (c: any) => Object.fromEntries(CAMPAIGN_KEYS.map((k) => [k, k === 'scheduled_at' && c[k] ? new Date(c[k]).toISOString() : c[k] ?? null]));
const STATUS: Record<string, string> = { draft: 'borrador', scheduled: 'programada', sending: 'enviándose', sent: 'enviada', cancelled: 'cancelada' };

/** El canal de la campaña: el indicado o, si la cuenta tiene uno solo, ese. */
async function campaignChannel(ctx: Ctx, id?: string) {
  const channels = ((await ctx.call.get<any[]>('/api/channels')) ?? []).filter((c) => c.type !== 'playground');
  if (id) {
    const ch = channels.find((c) => c.id === id);
    if (!ch) throw new ToolError('no_encontrado', 'Ese canal no es de la cuenta');
    return ch;
  }
  if (channels.length === 1) return channels[0];
  throw new ToolError('datos_invalidos', channels.length ? 'Indica desde qué canal sale la campaña' : 'La cuenta no tiene canales para enviar campañas', channels.map((c) => `${c.name} (${c.type}): ${c.id}`));
}

export const crearCampana = defineTool({
  name: 'crear_campana',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Deja lista una campaña en borrador (un mensaje o una secuencia para un grupo de contactos por etiquetas o actividad) y dice a cuántas personas llegaría. No se envía nada: lanzarla se confirma aparte.',
  schema: z.object({
    nombre: Text(120),
    mensaje: z.string().trim().max(4000).optional().describe('El mensaje (o usa secuencia_id para enviar una secuencia)'),
    secuencia_id: Id.optional(),
    canal_id: Id.optional().describe('Desde qué canal sale (si la cuenta tiene uno solo, ese)'),
    etiquetas: z.array(Text(60)).max(10).optional().describe('Contactos con alguna de estas etiquetas (vacío = todos)'),
    excluir_etiquetas: z.array(Text(60)).max(10).optional(),
    activos_en_dias: z.number().int().min(0).max(3650).optional().describe('Solo quienes escribieron en los últimos N días'),
    programar: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Usa AAAA-MM-DDTHH:MM (hora del negocio)').optional(),
  }).refine((a) => !!a.mensaje || !!a.secuencia_id, 'Escribe el mensaje o elige la secuencia'),
  label: (a) => `Preparando la campaña «${a.nombre}»…`,
  risk: () => 'reversible',
  async execute(a, ctx) {
    const ch = await campaignChannel(ctx, a.canal_id);
    const c = await ctx.call.send<any>('POST', '/api/campaigns', {
      name: a.nombre, channel_id: ch.id, message: a.mensaje ?? '', kind: a.secuencia_id ? 'sequence' : 'message', sequence_id: a.secuencia_id ?? null,
      audience: { tags_any: a.etiquetas ?? [], tags_none: a.excluir_etiquetas ?? [], active_within_days: a.activos_en_dias ?? 0, statuses: [] },
      ...(a.programar ? { scheduled_local: a.programar } : {}),
    });
    const p = await ctx.call.send<any>('POST', path`/api/campaigns/${c.id}/preview`, {});
    return {
      title: `Dejé en borrador la campaña «${c.name}» (${p.count} persona(s))`,
      links: [links.campaign(c.id)],
      after: campaignShape(c),
      undo: { label: 'Deshacer', custom: { tool: 'crear_campana', params: { id: c.id, after: campaignShape(c) } } },
      data: { campana_id: c.id, canal: ch.name, personas: p.count, mensajes: p.total_messages, sin_consentimiento: p.excluded_no_consent || undefined, aviso: p.warning ?? undefined, programada_para: c.scheduled_at ? when(c.scheduled_at, ctx.timezone) : undefined },
    };
  },
  async undo(p: { id: string; after: unknown }, ctx) {
    let c;
    try { c = await campaignOf(ctx, p.id); } catch (e) { if (e instanceof ToolError && e.code === 'no_encontrado') return; throw e; }
    if (c.status !== 'draft') throw new ToolError('conflicto', `La campaña ya está ${STATUS[c.status] ?? c.status}; no la borré.`);
    if (stableJson(campaignShape(c)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La campaña cambió después; para no perder esos cambios, no la borré.');
    await ctx.call.send('DELETE', path`/api/campaigns/${p.id}`);
  },
});

export const lanzarCampana = defineTool({
  name: 'lanzar_campana',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Lanza (o programa, si tiene fecha) una campaña en borrador. Requiere confirmación con la audiencia y el mensaje a la vista.',
  schema: z.object({ campana_id: Id }),
  label: () => 'Preparando el lanzamiento de la campaña…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const c = await campaignOf(ctx, a.campana_id);
    if (c.status !== 'draft') throw new ToolError('datos_invalidos', `La campaña está ${STATUS[c.status] ?? c.status}; solo se lanzan las que están en borrador.`);
    const p = await ctx.call.send<any>('POST', path`/api/campaigns/${c.id}/preview`, {});
    if (!p.count) throw new ToolError('datos_invalidos', 'Nadie cumple con la audiencia de esta campaña; cámbiala antes de lanzarla.');
    return {
      title: c.scheduled_at ? `Programar la campaña «${c.name}» para ${when(c.scheduled_at, ctx.timezone)}` : `Lanzar ahora la campaña «${c.name}»`,
      lines: [
        `Llega a ${p.count} persona(s) · ${p.total_messages} mensaje(s).`,
        ...(p.excluded_no_consent ? [`${p.excluded_no_consent} sin consentimiento para promociones quedan fuera.`] : []),
        ...(p.sample?.length ? [`Por ejemplo: ${p.sample.slice(0, 5).join(', ')}.`] : []),
      ],
      ...(c.kind === 'message' && c.message ? { quote: c.message } : {}),
      ...(p.warning ? { warning: p.warning } : {}),
      meta: { shape: stableJson(campaignShape(c)) },
    };
  },
  async execute(a, ctx) {
    const c = await campaignOf(ctx, a.campana_id);
    const seen = ctx.proposal?.meta?.shape;
    if (seen !== undefined && seen !== stableJson(campaignShape(c))) throw new ToolError('conflicto', 'La campaña cambió después de la propuesta; pídemelo de nuevo para revisarla.');
    const r = await ctx.call.send<any>('POST', path`/api/campaigns/${c.id}/launch`, {});
    return {
      title: `${r?.status === 'scheduled' ? 'Programé' : 'Lancé'} la campaña «${c.name}»`,
      links: [links.campaign(c.id)],
      data: { estado: STATUS[r?.status] ?? r?.status, nota: 'Se puede cancelar mientras no termine.' },
    };
  },
});

export const cancelarCampana = defineTool({
  name: 'cancelar_campana',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Cancela una campaña programada o que se está enviando (requiere confirmación).',
  schema: z.object({ campana_id: Id }),
  label: () => 'Preparando la cancelación de la campaña…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const c = await campaignOf(ctx, a.campana_id);
    if (!['scheduled', 'sending'].includes(c.status)) throw new ToolError('datos_invalidos', `La campaña está ${STATUS[c.status] ?? c.status}; no hay envío que cancelar.`);
    const sent = Number(c.stats?.sent ?? 0);
    return { title: `Cancelar la campaña «${c.name}»`, lines: [`Está ${STATUS[c.status]}.${sent ? ` Ya salieron ${sent} mensaje(s); esos no se pueden retirar.` : ''}`, 'Los envíos pendientes se detienen.'] };
  },
  async execute(a, ctx) {
    const c = await campaignOf(ctx, a.campana_id);
    const r = await ctx.call.send<any>('POST', path`/api/campaigns/${c.id}/cancel`, {});
    return { title: `Cancelé la campaña «${c.name}»`, links: [links.campaign(c.id)], data: { estado: STATUS[r?.status] ?? r?.status } };
  },
});

// --- Listar y borrar ------------------------------------------------------------------------------------------------

export const listarAutomatizaciones = defineTool({
  name: 'listar_automatizaciones',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Flujos del lienzo, reglas, secuencias y campañas de la cuenta, con su estado y sus ids.',
  schema: z.object({ tipo: z.enum(['todo', 'flujos', 'reglas', 'secuencias', 'campanas']).default('todo') }),
  label: () => 'Revisando las automatizaciones…',
  risk: () => 'read',
  async execute(a, ctx) {
    const want = (t: string) => a.tipo === 'todo' || a.tipo === t;
    const list = (url: string, on: boolean) => (on ? ctx.call.get<any[]>(url) : Promise.resolve([] as any[]));
    const [boards, rules, seqs, camps] = await Promise.all([
      list('/api/flow-boards', want('flujos')), list('/api/automations', want('reglas')), list('/api/sequences', want('secuencias')), list('/api/campaigns', want('campanas')),
    ]);
    const data = {
      ...(want('flujos') ? { flujos: boards.map((b) => ({ id: b.id, nombre: b.name, estado: b.published_revision == null ? 'borrador' : b.paused ? 'en pausa' : 'publicado', cambios_sin_publicar: b.pending || undefined, empieza: b.summary?.trigger ? describeTrigger(b.summary.trigger) : undefined, personas_en_curso: b.people?.active || undefined })) } : {}),
      ...(want('reglas') ? { reglas: rules.filter((r) => !r.board_id).map((r) => ({ id: r.id, nombre: r.name, activa: r.active, cuando: describeTrigger(r.trigger), hace: r.actions.map(describeAction), veces: r.run_count || undefined })) } : {}),
      ...(want('secuencias') ? { secuencias: seqs.filter((s) => !s.board_id).map((s) => ({ id: s.id, nombre: s.name, activa: s.active, pasos: s.steps.length, personas_en_curso: s.enrollments?.active || undefined })) } : {}),
      ...(want('campanas') ? { campanas: camps.map((c) => ({ id: c.id, nombre: c.name, estado: STATUS[c.status] ?? c.status, programada_para: c.scheduled_at ? when(c.scheduled_at, ctx.timezone) : undefined, enviados: c.stats?.sent || undefined })) } : {}),
    };
    const n = Object.values(data).reduce((s: number, l: any) => s + l.length, 0);
    return { title: `Revisé las automatizaciones (${n})`, data };
  },
});

const KIND_LABEL = { flujo: 'el flujo', regla: 'la regla', secuencia: 'la secuencia', campana: 'la campaña' } as const;

/** Qué se va a borrar y qué pasa con quienes van en ello. */
async function deletionOf(ctx: Ctx, tipo: keyof typeof KIND_LABEL, id: string) {
  if (tipo === 'flujo') {
    const b = await boardOf(ctx, id);
    return { name: b.name, url: path`/api/flow-boards/${id}`, lines: ['Se borra el lienzo y lo que publicó (su regla y sus mensajes); quienes van en él se detienen.'] };
  }
  if (tipo === 'regla') {
    const r = await findRule(ctx, id);
    return { name: r.name, url: path`/api/automations/${id}`, lines: [`Cuando ${describeTrigger(r.trigger)} ya no pasará nada; sus envíos programados se cancelan.`] };
  }
  if (tipo === 'secuencia') {
    const s = await findSequence(ctx, id);
    const people = Number(s.enrollments?.active ?? 0);
    return { name: s.name, url: path`/api/sequences/${id}`, lines: [people ? `${people} persona(s) van en ella y se detienen.` : 'Nadie va en ella ahora.'] };
  }
  const c = await campaignOf(ctx, id);
  if (c.status === 'sending') throw new ToolError('datos_invalidos', 'La campaña se está enviando: cancélala antes de borrarla.');
  return { name: c.name, url: path`/api/campaigns/${id}`, lines: [`Está ${STATUS[c.status] ?? c.status}.`] };
}

export const borrarAutomatizacion = defineTool({
  name: 'borrar_automatizacion',
  area: 'automatizacion',
  roles: ['admin'],
  description: 'Borra un flujo del lienzo, una regla, una secuencia o una campaña (requiere confirmación; no se puede deshacer).',
  schema: z.object({ tipo: z.enum(['flujo', 'regla', 'secuencia', 'campana']), id: Id }),
  label: () => 'Preparando el borrado…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const d = await deletionOf(ctx, a.tipo, a.id);
    return { title: `Borrar ${KIND_LABEL[a.tipo]} «${d.name}»`, lines: [...d.lines, 'No se puede deshacer.'] };
  },
  async execute(a, ctx) {
    const d = await deletionOf(ctx, a.tipo, a.id);
    await ctx.call.send('DELETE', d.url);
    return { title: `Borré ${KIND_LABEL[a.tipo]} «${d.name}»`, data: { borrado: true } };
  },
});

export const AUTOMATION_TOOLS = [listarAutomatizaciones, verFlujo, crearFlujo, cambiarFlujo, publicarFlujo, pausarReanudarFlujo, crearRegla, cambiarRegla, editarSecuencia, crearCampana, lanzarCampana, cancelarCampana, borrarAutomatizacion];
