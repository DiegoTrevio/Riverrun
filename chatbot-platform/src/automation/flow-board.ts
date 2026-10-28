import { z } from 'zod';
import { ConditionSchema, normalizeLabel, TriggerSchema, type Action, type Condition, type FlowButton, type SequenceStep, type Trigger } from './types.js';

/*
 * Lienzo de flujos: lo que la persona dibuja (como en una pizarra) y cómo se convierte en lo que el sistema ya ejecuta.
 *
 *   inicio ──► [acciones] ──► mensaje ──► espera ──► mensaje …        la línea principal = un flujo (secuencia)
 *                               └─ botón ──► mensaje ──► …          cada rama de un botón = otro flujo
 *                               └─ botón ──► etiqueta / persona / fin / otro flujo existente
 *
 * El inicio se publica como una regla (cuándo empieza, sus condiciones y las acciones antes del primer mensaje) que
 * inicia el flujo principal. Las notas, los textos sueltos y las fotos de referencia solo viven en el lienzo.
 */

const NodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Identificador de elemento inválido');
const Coord = z.number().finite().min(-200_000).max(200_000);
const Uuid = z.union([z.string().uuid(), z.literal('')]).default('');
const HHMM = z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.literal('')]).default('');

export const BoardButtonSchema = z.object({
  id: NodeId,
  label: z.string().max(40).default(''),
  kind: z.enum(['reply', 'url']).default('reply'),
  url: z.string().trim().max(1000).default(''),
  /** Lo que se contesta al tocarlo, antes de seguir a donde lleva su línea. */
  reply: z.string().max(1000).default(''),
});
export type BoardButton = z.infer<typeof BoardButtonSchema>;

const base = { id: NodeId, x: Coord, y: Coord };

/**
 * El inicio mientras se edita: uno completo, o uno a medio llenar (por ejemplo «se le pone una etiqueta» sin la etiqueta
 * todavía). Así el lienzo se sigue guardando; lo que falta sale en los pendientes y no se publica hasta completarlo.
 */
const DraftTriggerSchema = z.union([
  TriggerSchema,
  z.object({ type: z.string().trim().min(1).max(40) }).catchall(z.union([z.string().max(300), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(50)])),
]);
/** El inicio ya completo, o null si aún falta algo (o si lo inicia la persona: `trigger` null). */
export const completeTrigger = (t: unknown): Trigger | null => { const r = TriggerSchema.safeParse(t); return r.success ? r.data : null; };

export const BoardNodeSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('trigger'),
    data: z.object({
      /** null = «lo inicio yo» (desde una conversación o enviándolo a un grupo): no se crea regla. */
      trigger: DraftTriggerSchema.nullable().default(null),
      conditions: z.array(ConditionSchema).max(20).default([]),
      chatbot_id: z.union([z.string().uuid(), z.null()]).default(null),
      stop_ai: z.boolean().default(false),
      once_per_conversation: z.boolean().default(false),
    }).default(() => ({ trigger: null, conditions: [], chatbot_id: null, stop_ai: false, once_per_conversation: false })),
  }),
  z.object({
    ...base,
    type: z.literal('message'),
    data: z.object({
      text: z.string().max(4000).default(''),
      image_id: Uuid,
      attachment_id: Uuid,
      /** La foto que falta (la deja la IA al armar el flujo): se muestra en la tarjeta hasta que se elige una. */
      photo_hint: z.string().max(200).default(''),
      buttons: z.array(BoardButtonSchema).max(5).default([]),
      wait_for_choice: z.boolean().default(false),
      if_no_choice: z.enum(['end', 'continue']).default('end'),
    }).default(() => ({ text: '', image_id: '', attachment_id: '', photo_hint: '', buttons: [], wait_for_choice: false, if_no_choice: 'end' as const })),
  }),
  z.object({
    ...base,
    type: z.literal('wait'),
    data: z.object({
      value: z.number().int().min(0).max(10000).default(1),
      unit: z.enum(['minutes', 'hours', 'days']).default('days'),
      at_time: HHMM,
    }).default(() => ({ value: 1, unit: 'days' as const, at_time: '' })),
  }),
  z.object({
    ...base,
    type: z.literal('action'),
    data: z.object({
      action: z.enum(['tag', 'handoff', 'alert', 'end', 'flow']).default('tag'),
      tag: z.string().trim().max(60).default(''),
      message: z.string().max(2000).default(''),
      reason: z.string().max(300).default(''),
      sequence_id: Uuid,
    }).default(() => ({ action: 'tag' as const, tag: '', message: '', reason: '', sequence_id: '' })),
  }),
  z.object({
    ...base,
    type: z.literal('note'),
    data: z.object({
      text: z.string().max(2000).default(''),
      color: z.enum(['sun', 'leaf', 'sky', 'rose', 'sand']).default('sun'),
      w: z.number().min(120).max(800).default(220),
      h: z.number().min(80).max(800).default(160),
    }).default(() => ({ text: '', color: 'sun' as const, w: 220, h: 160 })),
  }),
  z.object({
    ...base,
    type: z.literal('text'),
    data: z.object({
      text: z.string().max(400).default(''),
      size: z.enum(['title', 'body']).default('title'),
    }).default(() => ({ text: '', size: 'title' as const })),
  }),
  z.object({
    ...base,
    type: z.literal('image'),
    data: z.object({
      attachment_id: Uuid,
      caption: z.string().max(200).default(''),
      w: z.number().min(80).max(1200).default(280),
    }).default(() => ({ attachment_id: '', caption: '', w: 280 })),
  }),
]);
export type BoardNode = z.infer<typeof BoardNodeSchema>;

export const BoardEdgeSchema = z.object({
  id: NodeId,
  from: NodeId,
  /** 'out' = la línea principal del elemento; 'b:<id>' = la de un botón de un mensaje. */
  port: z.string().regex(/^(out|b:[A-Za-z0-9_-]{1,40})$/),
  to: NodeId,
});
export type BoardEdge = z.infer<typeof BoardEdgeSchema>;

export const BoardSchema = z.object({
  nodes: z.array(BoardNodeSchema).max(300, 'El lienzo admite hasta 300 elementos').default([]),
  edges: z.array(BoardEdgeSchema).max(600).default([]),
  viewport: z.object({ x: Coord, y: Coord, zoom: z.number().min(0.1).max(4) }).default({ x: 0, y: 0, zoom: 1 }),
  settings: z.object({
    stop_on_reply: z.boolean().default(true),
    business_hours_only: z.boolean().default(true),
  }).default({ stop_on_reply: true, business_hours_only: true }),
});
export type Board = z.infer<typeof BoardSchema>;

/** Un pendiente del lienzo: `node` señala el elemento para resaltarlo; `warning` no impide publicar. */
export interface BoardProblem { node?: string; message: string; warning?: boolean }

/** Botón ya resuelto: a dónde lleva su línea (`target` = otro flujo de este mismo lienzo, por su elemento de entrada). */
export type CompiledButton = FlowButton & { target?: string };
export type CompiledStep = Omit<SequenceStep, 'buttons'> & { buttons: CompiledButton[]; node: string };
export interface CompiledSequence { key: string; name: string; steps: CompiledStep[] }
export interface CompiledFlow {
  /** null = sin regla («lo inicio yo»). */
  rule: null | {
    trigger: Trigger;
    conditions: Condition[];
    chatbot_id: string | null;
    stop_ai: boolean;
    once_per_conversation: boolean;
    /** Acciones antes del primer mensaje (sin el inicio del flujo, que se agrega al publicar). */
    actions: Action[];
  };
  /** Flujo principal (el que arranca el inicio; su clave es MAIN_KEY), o null si el inicio solo hace acciones. */
  main: string | null;
  sequences: CompiledSequence[];
  problems: BoardProblem[];
}

const MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
/** Un hueco por llenar, como «[precio]» o «[enlace de pago]» (palabras en minúsculas): no debe llegar así al cliente. */
const PLACEHOLDER_HOLE = /\[[a-záéíóúüñ][a-záéíóúüñ ]{1,40}\]/;
/** Clave fija del flujo principal en lo publicado: sigue siendo el mismo aunque cambie su primer mensaje. */
export const MAIN_KEY = ':main';
/** Si un mensaje espera a que elijan y no hay una Espera después, este es el tiempo que tienen para elegir. */
export const CHOICE_WINDOW_MINUTES = 1440;
const FLOW_TYPES = new Set(['trigger', 'message', 'wait', 'action']);

/** Espera total en la unidad más grande que la expresa exacta (el editor de flujos admite hasta 10000 de cada una). */
export function delayOf(totalMinutes: number): { delay_value: number; delay_unit: 'minutes' | 'hours' | 'days' } {
  if (totalMinutes > 0 && totalMinutes % 1440 === 0) return { delay_value: Math.min(totalMinutes / 1440, 10000), delay_unit: 'days' };
  if (totalMinutes > 0 && totalMinutes % 60 === 0 && totalMinutes / 60 <= 10000) return { delay_value: totalMinutes / 60, delay_unit: 'hours' };
  if (totalMinutes <= 10000) return { delay_value: totalMinutes, delay_unit: 'minutes' };
  return { delay_value: Math.min(Math.round(totalMinutes / 60), 10000), delay_unit: 'hours' };
}

/** Texto corto para nombrar el flujo de una rama («Promo · Te cuento los precios…»). */
const snippet = (s: string, n = 40) => {
  const one = s.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

/**
 * Convierte el lienzo en la regla y los flujos que se publican. No consulta la base: lo que depende de la cuenta (fotos,
 * archivos, flujos existentes, palabras reservadas) se revisa al publicar.
 */
export function compileBoard(board: Board, name: string, opts: { reserved?: string[] } = {}): CompiledFlow {
  const reserved = new Set((opts.reserved ?? []).map(normalizeLabel).filter(Boolean));
  const problems: BoardProblem[] = [];
  const nodes = new Map(board.nodes.map((n) => [n.id, n]));
  const out = new Map<string, BoardEdge>();
  for (const e of board.edges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to || !FLOW_TYPES.has(from.type) || !FLOW_TYPES.has(to.type)) continue;
    if (to.type === 'trigger') { problems.push({ node: from.id, message: 'Ninguna línea puede llegar al inicio.' }); continue; }
    if (e.port !== 'out' && (from.type !== 'message' || !from.data.buttons.some((b) => `b:${b.id}` === e.port && b.kind === 'reply'))) continue;
    out.set(`${e.from}|${e.port}`, e);
  }
  const next = (id: string, port = 'out') => {
    const e = out.get(`${id}|${port}`);
    return e ? nodes.get(e.to) : undefined;
  };

  const triggers = board.nodes.filter((n) => n.type === 'trigger');
  if (!triggers.length) problems.push({ message: 'Agrega el inicio: cuándo empieza el flujo.' });
  for (const t of triggers.slice(1)) problems.push({ node: t.id, message: 'Un lienzo tiene un solo inicio. Quita este o haz otro lienzo.' });
  const start = triggers[0];

  const sequences: CompiledSequence[] = [];
  const queue: string[] = [];
  const queued = new Set<string>();
  const reached = new Set<string>();
  const want = (key: string) => { if (!queued.has(key)) { queued.add(key); queue.push(key); } };

  // 1) Inicio: acciones en orden hasta el primer mensaje o espera.
  let rule: CompiledFlow['rule'] = null;
  let main: string | null = null;
  if (start?.type === 'trigger') {
    reached.add(start.id);
    const actions: Action[] = [];
    let cur = next(start.id);
    const seen = new Set<string>();
    while (cur?.type === 'action') {
      if (seen.has(cur.id)) { problems.push({ node: cur.id, message: 'Las acciones del inicio forman un círculo.' }); cur = undefined; break; }
      seen.add(cur.id); reached.add(cur.id);
      const a = cur.data;
      const ends = a.action === 'handoff' || a.action === 'flow' || a.action === 'end';
      if (a.action === 'tag') {
        if (!a.tag) problems.push({ node: cur.id, message: 'Escribe la etiqueta que se agrega.' });
        else actions.push({ type: 'add_tag', tag: a.tag });
      } else if (a.action === 'alert') {
        actions.push({ type: 'alert_team', message: a.message.trim() || `{{cliente}} entró al flujo «${name}»: "{{mensaje}}"`, roles: ['admin', 'agent'], user_ids: [], phones: [], round_robin: false });
      } else if (a.action === 'handoff') {
        actions.push({ type: 'handoff', reason: a.reason.trim() || `Flujo «${name}»` });
      } else if (a.action === 'flow') {
        if (!a.sequence_id) problems.push({ node: cur.id, message: 'Elige el flujo que empieza.' });
        else actions.push({ type: 'start_sequence', sequence_id: a.sequence_id });
      }
      if (ends) {
        if (next(cur.id)) problems.push({ node: cur.id, message: a.action === 'handoff' ? 'Después de pasar con una persona el flujo ya no envía mensajes: quita la línea que sale de aquí.' : 'Aquí termina el flujo: quita la línea que sale de aquí.' });
        cur = undefined;
        break;
      }
      cur = next(cur.id);
    }
    if (cur) { main = cur.id; want(cur.id); }
    const t = start.data;
    const trig = completeTrigger(t.trigger);
    if (t.trigger && !trig) {
      const type = String((t.trigger as { type?: unknown }).type ?? '');
      problems.push({ node: start.id, message: type === 'tag_added' ? 'Escribe la etiqueta que inicia el flujo.' : type === 'intent' ? 'Escribe la intención que detecta la IA (un nombre corto) y cómo la reconoce (máximo 300 caracteres).' : 'Revisa cuándo empieza el flujo: le falta un dato.' });
    } else if (trig) {
      if (trig.type === 'message_received' && trig.match !== 'any' && !trig.keywords.length) problems.push({ node: start.id, message: 'Escribe al menos una palabra o frase que inicia el flujo (o elige «Cualquier mensaje»).' });
      if (trig.type === 'intent' && t.stop_ai) problems.push({ node: start.id, message: 'Con «La IA detecta una intención» el agente ya respondió: desmarca «El agente no contesta ese mensaje».' });
      if (!actions.length && !main) problems.push({ node: start.id, message: 'Conecta el inicio a un mensaje o a una acción.' });
      rule = { trigger: trig, conditions: t.conditions, chatbot_id: t.chatbot_id, stop_ai: t.stop_ai, once_per_conversation: t.once_per_conversation, actions };
    } else {
      if (actions.length) problems.push({ node: start.id, message: 'Un flujo que inicias tú no puede empezar con acciones: conéctalo directo a un mensaje.' });
      if (!main) problems.push({ node: start.id, message: 'Conecta el inicio al primer mensaje.' });
    }
  }

  // 2) Cada entrada (la principal y cada rama de un botón) es un flujo: sus mensajes en orden, con las esperas.
  while (queue.length) {
    const key = queue.shift()!;
    const steps: CompiledStep[] = [];
    const messages: (BoardNode & { type: 'message' })[] = [];
    let waited = 0;
    let atTime = '';
    let hadWait = false;
    const seen = new Set<string>();
    for (let cur = nodes.get(key); cur; cur = next(cur.id)) {
      if (seen.has(cur.id)) { problems.push({ node: cur.id, message: 'La línea principal regresa a un mensaje anterior. Para repetirlo, usa un botón.' }); break; }
      seen.add(cur.id); reached.add(cur.id);
      if (cur.type === 'wait') {
        waited += cur.data.value * MINUTES[cur.data.unit];
        if (cur.data.at_time) atTime = cur.data.at_time;
        hadWait = true;
        continue;
      }
      if (cur.type === 'action') {
        if (cur.data.action !== 'end') problems.push({ node: cur.id, message: 'Después de un mensaje solo siguen mensajes y esperas. Las acciones salen de un botón o del inicio.' });
        break;
      }
      if (cur.type !== 'message') break;
      const m = cur.data;
      if (!m.text.trim() && !m.image_id && !m.attachment_id) problems.push({ node: cur.id, message: 'Este mensaje está vacío: escribe un texto o agrega una foto o un archivo.' });
      const hole = [m.text, ...m.buttons.map((b) => b.reply)].join('\n').match(PLACEHOLDER_HOLE);
      if (hole) problems.push({ node: cur.id, message: `Completa lo que está entre corchetes: «${hole[0]}».` });
      if (m.photo_hint && !m.image_id && !m.attachment_id) problems.push({ node: cur.id, warning: true, message: `Falta la foto: ${m.photo_hint}.` });
      const replies = m.buttons.filter((b) => b.kind === 'reply');
      if (replies.length > 3) problems.push({ node: cur.id, message: 'Máximo 3 botones de respuesta por mensaje.' });
      if (m.buttons.length - replies.length > 2) problems.push({ node: cur.id, message: 'Máximo 2 botones de enlace por mensaje.' });
      if (m.buttons.length && !m.text.trim()) problems.push({ node: cur.id, message: 'Escribe el texto que acompaña a los botones.' });
      const labels = m.buttons.map((b) => normalizeLabel(b.label)).filter(Boolean);
      if (new Set(labels).size !== labels.length) problems.push({ node: cur.id, message: 'Dos botones no pueden decir lo mismo.' });
      for (const b of m.buttons) {
        const label = b.label.trim();
        if (!label) problems.push({ node: cur.id, message: 'Un botón no tiene texto.' });
        else if (label.length > 20) problems.push({ node: cur.id, message: `El botón «${label}» pasa de 20 caracteres.` });
        else if (!normalizeLabel(label)) problems.push({ node: cur.id, message: `El botón «${label}» necesita letras o números.` });
        else if (/^\d+$/.test(normalizeLabel(label))) problems.push({ node: cur.id, message: `El botón «${label}» no puede ser solo un número: se confunde con elegir por número.` });
        else if (reserved.has(normalizeLabel(label))) problems.push({ node: cur.id, message: `El botón «${label}» se confunde con la palabra para darse de baja, volver a recibir mensajes o aceptar promociones. Usa otro texto.` });
        if (b.kind === 'url' && !/^https:\/\/\S+$/.test(b.url)) problems.push({ node: cur.id, message: `El enlace del botón «${b.label.trim() || 'sin texto'}» debe empezar con https://` });
      }
      // «Esperar a que elija» sin una Espera después: el siguiente sale cuando elige o, si no elige, después de un día.
      const before = steps.at(-1);
      if (before && !hadWait && before.wait_for_choice) waited = CHOICE_WINDOW_MINUTES;
      steps.push({
        node: cur.id,
        ...delayOf(waited),
        at_time: atTime,
        text: m.text,
        image_id: m.image_id,
        attachment_id: m.attachment_id,
        wa_template: null,
        conditions: [],
        buttons: [],
        wait_for_choice: replies.length > 0 && m.wait_for_choice,
        if_no_choice: m.if_no_choice,
      });
      messages.push(cur);
      waited = 0; atTime = ''; hadWait = false;
    }
    if (!steps.length) problems.push({ node: key, message: 'Esta rama no tiene ningún mensaje.' });
    if (steps.length > 30) problems.push({ node: key, message: 'Un flujo admite hasta 30 mensajes seguidos.' });

    // Los botones: seguir (si su línea va a lo que sigue en esta misma línea), otro flujo, etiqueta, persona o fin.
    messages.forEach((node, i) => {
      const step = steps[i];
      const ahead = new Set<string>();
      for (let n = next(node.id), guard = 0; n && guard < 50; n = next(n.id), guard++) {
        ahead.add(n.id);
        if (n.type !== 'wait') break;
      }
      for (const b of node.data.buttons) {
        const label = b.label.trim();
        if (b.kind === 'url') { step.buttons.push({ label, kind: 'url', url: b.url, action: 'next', sequence_id: null, tag: '', reply: '' }); continue; }
        const btn: CompiledButton = { label, kind: 'reply', url: '', action: 'end', sequence_id: null, tag: '', reply: b.reply };
        const to = next(node.id, `b:${b.id}`);
        if (!to) { /* sin línea: el flujo termina al tocarlo */ }
        else if (ahead.has(to.id)) {
          btn.action = 'next';
          const after = steps[i + 1];
          if (!node.data.wait_for_choice && after && after.delay_value === 0 && !after.at_time) problems.push({ node: node.id, message: `El botón «${label || 'sin texto'}» sigue con el mensaje siguiente, pero ese mensaje sale enseguida: activa «Esperar a que elija».` });
        }
        else if (to.type === 'message' || to.type === 'wait') { btn.action = 'start_sequence'; btn.target = to.id; want(to.id); }
        else if (to.type === 'action') {
          reached.add(to.id);
          const a = to.data;
          if (a.action === 'tag') { btn.action = 'tag'; btn.tag = a.tag; if (!a.tag) problems.push({ node: to.id, message: 'Escribe la etiqueta que se agrega.' }); }
          else if (a.action === 'handoff') btn.action = 'handoff';
          else if (a.action === 'end') btn.action = 'end';
          else if (a.action === 'flow') {
            btn.action = 'start_sequence'; btn.sequence_id = a.sequence_id || null;
            if (!a.sequence_id) problems.push({ node: to.id, message: 'Elige el flujo que empieza.' });
          } else problems.push({ node: to.id, message: 'Un botón no puede avisar al equipo. Usa «Pasar con una persona» o una etiqueta.' });
          if (next(to.id)) problems.push({ node: to.id, message: 'Lo que sale de un botón termina en su acción: quita la línea que sale de aquí.' });
        }
        step.buttons.push(btn);
      }
    });
    sequences.push({
      key,
      name: key === main ? name : `${name} · ${snippet(steps[0]?.text || '') || 'rama'}`.slice(0, 120),
      steps,
    });
  }

  for (const n of board.nodes) {
    if ((n.type === 'message' || n.type === 'wait' || n.type === 'action') && !reached.has(n.id)) {
      problems.push({ node: n.id, warning: true, message: 'No está conectado al flujo: no se publicará.' });
    }
  }
  // El flujo principal se publica con una clave fija (las ramas, con la de su primer elemento): al cambiar o agregar el
  // primer mensaje se actualiza el mismo flujo, y quienes van en él no pierden su lugar.
  if (main) {
    for (const seq of sequences) {
      if (seq.key === main) seq.key = MAIN_KEY;
      for (const st of seq.steps) for (const b of st.buttons) if (b.target === main) b.target = MAIN_KEY;
    }
  }
  return { rule, main: main ? MAIN_KEY : null, sequences, problems };
}

/** Resumen para la lista de lienzos: cuántos mensajes y botones tiene, y cuándo empieza. */
export function boardSummary(board: Board) {
  const count = (type: string) => board.nodes.filter((n) => n.type === type).length;
  const start = board.nodes.find((n) => n.type === 'trigger');
  return {
    messages: count('message'),
    buttons: board.nodes.reduce((n, x) => n + (x.type === 'message' ? x.data.buttons.length : 0), 0),
    notes: count('note') + count('text') + count('image'),
    trigger: start?.type === 'trigger' ? completeTrigger(start.data.trigger) : null,
  };
}
