/**
 * Activadores y desactivadores del asistente. Los aplica el sistema (no la IA): decide, antes de llamar
 * a la IA, si el asistente responde en esta conversación, y si un mensaje lo enciende o lo apaga.
 */
import type { Activation, Chatbot, Contact, Conversation } from '../types.js';
import { matchKeyword } from './engine.js';

export interface GateResult {
  /** ¿La IA debe responder este mensaje? */
  reply: boolean;
  /** Cambio de estado que provoca el mensaje. */
  change?: 'on' | 'off';
  /** Explicación para Registros y para el probador. */
  reason: string;
  keyword?: string;
}

type ConvState = Pick<Conversation, 'agent_off_at' | 'agent_off_until' | 'agent_off_reason' | 'agent_on_at'>;

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** ¿El asistente está en pausa en esta conversación? (una pausa con fecha de fin ya vencida no cuenta) */
export function agentPaused(conv: ConvState, now = new Date()): boolean {
  if (!conv.agent_off_at) return false;
  const until = time(conv.agent_off_until);
  return until === null || until > now.getTime();
}

/** ¿El asistente atiende esta conversación? (no está en pausa y, en modo "solo con palabras", ya se activó) */
export function agentActive(bot: Pick<Chatbot, 'rules'>, conv: ConvState, now = new Date()): boolean {
  if (agentPaused(conv, now)) return false;
  return bot.rules.activation.mode !== 'keywords' || !!conv.agent_on_at;
}

/** Estado legible: activo, en pausa (motivo) o esperando palabra de activación. */
export function agentStatus(bot: Pick<Chatbot, 'rules'>, conv: ConvState, now = new Date()) {
  if (agentPaused(conv, now)) return { on: false, state: 'paused' as const, reason: conv.agent_off_reason || 'en pausa', until: conv.agent_off_until ?? null };
  if (bot.rules.activation.mode === 'keywords' && !conv.agent_on_at) return { on: false, state: 'waiting' as const, reason: 'esperando una palabra de activación', until: null };
  return { on: true, state: 'on' as const, reason: '', until: null };
}

/** Decide qué pasa con el asistente al llegar un mensaje del cliente. */
export function gate(a: Activation, conv: ConvState, text: string, now = new Date()): GateResult {
  const expired = !!conv.agent_off_at && !agentPaused(conv, now);
  const on = matchKeyword(text, a.on_keywords);
  if (agentPaused(conv, now)) {
    if (on) return { reply: true, change: 'on', reason: `el cliente escribió "${on}"`, keyword: on };
    return { reply: false, reason: `en pausa (${conv.agent_off_reason || 'sin motivo'})` };
  }
  if (a.mode === 'keywords' && !conv.agent_on_at) {
    if (on) return { reply: true, change: 'on', reason: `el cliente escribió "${on}"`, keyword: on };
    return { reply: false, reason: 'esperando una palabra de activación' };
  }
  const off = matchKeyword(text, a.off_keywords);
  if (off) return { reply: false, change: 'off', reason: `el cliente escribió "${off}"`, keyword: off };
  if (expired) return { reply: true, change: 'on', reason: 'terminó el tiempo de pausa' };
  return { reply: true, reason: 'activo' };
}

/** Datos del cliente que cuentan para "ya tiene estos datos" (el nombre puede estar en la ficha). */
function hasField(contact: Pick<Contact, 'name' | 'data'>, key: string) {
  if (key === 'nombre' && contact.name) return true;
  return !!contact.data?.[key];
}

/**
 * Desactivadores que se revisan después de responder. Devuelve el motivo si alguno se cumple.
 * "Ya tiene estos datos" solo cuenta en el turno en que se completan (no en cada mensaje posterior).
 */
export function offAfterReply(
  a: Activation,
  o: { goalReached: boolean; booked: boolean; questionsCompleted?: boolean; before: Pick<Contact, 'name' | 'data'>; after: Pick<Contact, 'name' | 'data'> },
): string | null {
  if (a.off_on_questions && o.questionsCompleted) return 'el cliente respondió todas las preguntas';
  if (a.off_on_goal && o.goalReached) return 'se cumplió el objetivo de la conversación';
  if (a.off_on_booking && o.booked) return 'el cliente agendó una cita';
  const keys = a.off_when_fields.filter(Boolean);
  if (keys.length && keys.every((k) => hasField(o.after, k)) && !keys.every((k) => hasField(o.before, k))) {
    return `el cliente ya dio: ${keys.join(', ')}`;
  }
  return null;
}
