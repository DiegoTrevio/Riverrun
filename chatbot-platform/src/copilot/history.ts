/**
 * El historial que ve el modelo: los últimos turnos completos (con sus herramientas) y, de los anteriores, solo lo que
 * pidió la persona y lo que respondió el Copiloto. Cada llamada a una herramienta queda con su resultado (si un turno
 * se cortó a la mitad, se completa con «sin resultado»), porque los proveedores rechazan llamadas sin respuesta.
 */
import type { AnyMessage } from '../ai/provider.js';
import { actionLine, tidy } from './prompt.js';
import type { Action, Message } from './store.js';

/** Turnos que se repiten completos (con los resultados de sus herramientas). */
export const FULL_TURNS = 6;
const MAX_CHARS = 40000;
const MAX_TOOL = 3000;

function userText(m: Message, actions: Map<string, Action>): string {
  const text = m.redacted ? '(mensaje borrado)' : m.content;
  const refs = (m.refs ?? []).map((id) => actions.get(id)).filter((a): a is Action => !!a);
  return refs.length ? `${text}\n\n[Se refiere a estas acciones]\n${refs.map(actionLine).join('\n')}` : text;
}

function toModel(m: Message, actions: Map<string, Action>): AnyMessage | null {
  if (m.role === 'user') return { role: 'user', content: userText(m, actions) };
  if (m.role === 'event') return { role: 'user', content: `${NOTICE} ${m.redacted ? '(borrado)' : tidy(m.content, 300)}` };
  if (m.role === 'assistant') {
    if (m.tool_calls?.length) return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
    return m.content ? { role: 'assistant', content: m.content } : null;
  }
  return { role: 'tool', tool_call_id: m.tool_call_id ?? '', content: (m.redacted ? '(borrado)' : m.content).slice(0, MAX_TOOL) };
}

const NOTICE = '[Aviso del panel]';
const isNotice = (m: AnyMessage) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(NOTICE);

/**
 * Cada llamada con su resultado, en orden; los resultados sueltos se quitan. Un aviso del panel que cayó entre una
 * llamada y su resultado (se confirmó una tarjeta mientras el Copiloto trabajaba) va después de los resultados.
 */
function repair(list: AnyMessage[]): AnyMessage[] {
  const out: AnyMessage[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role === 'tool') continue; // los resultados se colocan junto a su llamada
    out.push(m);
    if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls?.length) {
      const results = new Map<string, AnyMessage>();
      const notices: AnyMessage[] = [];
      let j = i + 1;
      for (; j < list.length && (list[j].role === 'tool' || isNotice(list[j])); j++) {
        if (list[j].role === 'tool') results.set((list[j] as any).tool_call_id, list[j]);
        else notices.push(list[j]);
      }
      for (const c of m.tool_calls) out.push(results.get(c.id) ?? { role: 'tool', tool_call_id: c.id, content: '{"error":"sin_resultado","mensaje":"Se interrumpió antes de terminar."}' });
      out.push(...notices);
      i = j - 1;
    }
  }
  return out;
}

export function buildHistory(messages: Message[], actions: Action[]): AnyMessage[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  // Cada mensaje de la persona abre un turno; lo demás (pasos, resultados, avisos de confirmación) va con el turno abierto.
  const turns: Message[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1].push(m);
  }
  const rendered = turns.map((t, i) => {
    const full = i >= turns.length - FULL_TURNS;
    const kept = full ? t : t.filter((m) => m.role === 'user' || m.role === 'event' || (m.role === 'assistant' && !m.tool_calls?.length && !!m.content));
    return repair(kept.map((m) => toModel(m, byId)).filter((m): m is AnyMessage => !!m));
  });
  // Tope de tamaño: se quitan los turnos más viejos (siempre queda el último).
  const size = (t: AnyMessage[]) => t.reduce((n, m) => n + JSON.stringify(m).length, 0);
  let total = rendered.reduce((n, t) => n + size(t), 0);
  while (rendered.length > 1 && total > MAX_CHARS) total -= size(rendered.shift()!);
  return rendered.flat();
}
