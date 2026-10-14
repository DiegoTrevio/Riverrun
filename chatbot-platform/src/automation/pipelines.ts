/**
 * Pipelines personalizables: el negocio define sus columnas (Nuevo → Interesado → Cotizado → Ganado / Perdido) y qué
 * hace que una solicitud entre a cada una: una situación descrita en sus palabras (la IA la detecta en la conversación)
 * o un evento (objetivo cumplido, cita agendada, pasó con una persona, dato capturado…). Las tarjetas avanzan solas; las
 * de ganadas o perdidas ya no se mueven solas, y regresar a una columna anterior solo pasa si el negocio lo permite (a
 * mano, desde el tablero, siempre se puede).
 */
import { z } from 'zod';
import { logEvent } from '../logs.js';
import { normalize } from '../engine/text.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import * as pstore from '../store/pipelines.js';
import type { Pipeline, PipelineCard, Stage } from '../store/pipelines.js';
import type { Conversation } from '../types.js';
import type { AutomationEvent } from './types.js';

const StageEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goal_completed') }),
  z.object({ type: z.literal('appointment_booked') }),
  z.object({ type: z.literal('appointment_cancelled') }),
  z.object({ type: z.literal('handoff') }),
  z.object({ type: z.literal('data_captured'), field: z.string().trim().max(60).default('') }),
  z.object({ type: z.literal('stage_reached'), step: z.number().int().min(1).max(30) }),
  z.object({ type: z.literal('tag_added'), tag: z.string().trim().min(1).max(60) }),
]);

const StageSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  name: z.string().trim().min(1, 'Ponle nombre a cada columna').max(60),
  kind: z.enum(['open', 'won', 'lost']).default('open'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #RRGGBB').default('#64748b'),
  when: z.string().trim().max(500).default(''),
  events: z.array(StageEventSchema).max(10).default([]),
});

export const PipelineBodySchema = z
  .object({
    name: z.string().trim().min(1, 'Ponle nombre al pipeline').max(80),
    stages: z.array(StageSchema).min(2, 'Un pipeline necesita al menos dos columnas').max(15, 'Máximo 15 columnas'),
    chatbot_ids: z.array(z.string().uuid()).max(100).default([]),
    allow_backward: z.boolean().default(false),
  })
  .superRefine((b, ctx) => {
    if (b.stages[0].kind !== 'open') ctx.addIssue({ code: 'custom', path: ['stages', 0, 'kind'], message: 'La primera columna es donde entran las solicitudes nuevas: no puede ser de ganadas ni perdidas' });
  });
export type PipelineBody = z.infer<typeof PipelineBodySchema>;

/** Identificador estable de cada columna (se conserva al renombrarla): de su nombre, sin acentos ni espacios. */
export function withStageIds(stages: PipelineBody['stages']): Stage[] {
  const used = new Set<string>();
  const out: Stage[] = [];
  for (const s of stages) {
    let id = s.id && !used.has(s.id) ? s.id : '';
    if (!id) {
      const base = normalize(s.name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'columna';
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    }
    used.add(id);
    out.push({ id, name: s.name, kind: s.kind, color: s.color, when: s.when, events: s.events as Stage['events'] });
  }
  return out;
}

/** Plantilla para empezar: un embudo de ventas típico. */
export const DEFAULT_STAGES: PipelineBody['stages'] = [
  { name: 'Nuevo', kind: 'open', color: '#64748b', when: '', events: [] },
  { name: 'Interesado', kind: 'open', color: '#0ea5e9', when: 'El cliente muestra interés concreto en un producto o servicio (pregunta precios, disponibilidad o detalles para contratar).', events: [] },
  { name: 'Cotizado', kind: 'open', color: '#f59e0b', when: 'Ya se le dio al cliente un precio o una cotización de lo que quiere.', events: [] },
  { name: 'Ganado', kind: 'won', color: '#16a34a', when: '', events: [{ type: 'goal_completed' }, { type: 'appointment_booked' }] },
  { name: 'Perdido', kind: 'lost', color: '#dc2626', when: 'El cliente dice claramente que ya no le interesa, que lo contrató en otro lado o que no seguirá.', events: [] },
];

/** Intención que la IA marca cuando se da la situación de una columna. */
export const stageIntent = (s: Pick<Stage, 'id'>) => `etapa_${s.id}`;

/** Lo que la IA necesita saber del pipeline de su agente. */
export interface PipelineContext {
  name: string;
  /** Columna en la que va la solicitud. */
  current: string;
  /** Ya está en ganadas o perdidas: no se mueve sola. */
  finished: boolean;
  /** Columnas que se detectan por contexto (las mismas en cada turno: van en la configuración del agente). */
  stages: { intent: string; name: string; when: string }[];
}

const EVENT_REASON: Partial<Record<AutomationEvent['type'], string>> = {
  goal_completed: 'Se cumplió el objetivo',
  appointment_booked: 'Agendó una cita',
  appointment_cancelled: 'Canceló su cita',
  handoff: 'Pasó con una persona',
  data_captured: 'Se capturó un dato',
  stage_reached: 'Llegó a una etapa del recorrido',
  tag_added: 'Se agregó una etiqueta',
};

function eventMatches(s: Stage, e: AutomationEvent): boolean {
  return s.events.some((x) => {
    if (x.type !== e.type) return false;
    if (x.type === 'data_captured') return !x.field || x.field === e.field;
    if (x.type === 'stage_reached') return x.step === e.step;
    if (x.type === 'tag_added') return normalize(x.tag) === normalize(e.tag ?? '');
    return true;
  });
}

type Target = { stage: Stage; reason: string; source: 'ia' | 'evento' };

/**
 * Columna a la que se mueve la tarjeta con este evento (null = se queda). Ganadas y perdidas no se mueven solas; hacia
 * adelante sí, y hacia atrás solo si el pipeline lo permite. Si varias aplican, la que va más adelante.
 */
export function targetStage(pipeline: Pick<Pipeline, 'stages' | 'allow_backward'>, currentId: string, e: AutomationEvent): Target | null {
  const stages = pipeline.stages;
  const cur = stages.findIndex((s) => s.id === currentId);
  if (cur >= 0 && stages[cur].kind !== 'open') return null;
  const intents = new Set((e.intents ?? []).map((i) => normalize(i)));
  let best: Target | null = null;
  stages.forEach((s, i) => {
    if (i === cur) return;
    const byContext = e.type === 'intent' && !!s.when && intents.has(normalize(stageIntent(s)));
    if (!byContext && !eventMatches(s, e)) return;
    if (s.kind === 'open' && i < cur && !pipeline.allow_backward) return;
    const detail = e.field ? ` (${e.field})` : e.tag ? ` (${e.tag})` : e.step ? ` (${e.step})` : '';
    best = { stage: s, source: byContext ? 'ia' : 'evento', reason: byContext ? `La IA detectó: ${s.when}` : `${EVENT_REASON[e.type] ?? e.type}${detail}` };
  });
  return best;
}

export class Pipelines {
  constructor(private chat: ChatService) {}

  /** Para la IA: las columnas que se detectan por contexto y en cuál va la solicitud. Null si el agente no usa pipeline. */
  async contextFor(conv: Pick<Conversation, 'id' | 'chatbot_id'>): Promise<PipelineContext | null> {
    if (!conv.chatbot_id) return null;
    const pipeline = await pstore.pipelineForBot(conv.chatbot_id);
    if (!pipeline?.stages.length) return null;
    const card = await pstore.openCardOf(conv.id);
    const current = pipeline.stages.find((s) => card?.pipeline_id === pipeline.id && s.id === card.stage_id) ?? pipeline.stages[0];
    const stages = pipeline.stages.filter((s) => s.when).map((s) => ({ intent: stageIntent(s), name: s.name, when: s.when }));
    return { name: pipeline.name, current: current.name, finished: current.kind !== 'open', stages };
  }

  /** Un evento de la conversación (desde la automatización): crea la tarjeta si falta y la mueve si corresponde. */
  async onEvent(e: AutomationEvent, conv: Conversation, channelType: string) {
    if (e.type === 'pipeline_stage' || channelType === 'playground' || !conv.chatbot_id) return;
    const pipeline = await pstore.pipelineForBot(conv.chatbot_id);
    if (!pipeline?.stages.length) return;
    let { card } = await pstore.ensureCard(pipeline, conv);
    // Otro evento de la misma conversación puede moverla al mismo tiempo: se vuelve a leer y se decide de nuevo.
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = targetStage(pipeline, card.stage_id, e);
      if (!target) return;
      if (await pstore.moveCard(card.id, card.stage_id, target.stage.id, { source: target.source, reason: target.reason })) {
        this.moved(pipeline, card, target.stage, target.reason, conv, e.depth ?? 0);
        return;
      }
      const fresh = await pstore.getCard(card.id);
      if (!fresh || fresh.closed_at) return;
      card = fresh;
    }
  }

  /** Movimiento a mano desde el tablero (a cualquier columna). */
  async moveManually(card: PipelineCard, stageId: string, userId: string, note = ''): Promise<PipelineCard | null> {
    const pipeline = await pstore.getPipeline(card.pipeline_id);
    const stage = pipeline?.stages.find((s) => s.id === stageId);
    if (!pipeline || !stage) return null;
    if (card.stage_id === stageId) return card;
    const reason = note || 'Movida a mano';
    if (!(await pstore.moveCard(card.id, card.stage_id, stageId, { source: 'manual', reason, userId }))) return null;
    const conv = await store.getConversation(card.conversation_id);
    if (conv) this.moved(pipeline, card, stage, reason, conv, 0);
    return pstore.getCard(card.id);
  }

  private moved(pipeline: Pipeline, card: PipelineCard, to: Stage, reason: string, conv: Conversation, depth: number) {
    const from = pipeline.stages.find((s) => s.id === card.stage_id);
    void logEvent({ level: 'info', source: 'engine', message: `Pipeline «${pipeline.name}»: ${from?.name ?? '—'} → ${to.name} (${reason})`, accountId: conv.account_id, chatbotId: conv.chatbot_id, conversationId: conv.id });
    // Avisos al equipo, reglas y webhooks pueden reaccionar al cambio de columna (con tope, como las demás cadenas de reglas).
    if (depth >= 3) return;
    this.chat.automator.emit({
      type: 'pipeline_stage',
      conversationId: conv.id,
      depth: depth + 1,
      pipeline: { id: pipeline.id, name: pipeline.name, stage_id: to.id, stage_name: to.name, stage_kind: to.kind, from_stage_id: from?.id ?? null, from_stage_name: from?.name ?? null, reason },
    });
  }
}
