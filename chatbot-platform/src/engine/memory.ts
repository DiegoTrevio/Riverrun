import { config } from '../config.js';
import type { AiProvider } from '../ai/provider.js';
import * as store from '../store/index.js';
import type { Chatbot } from '../types.js';

const running = new Set<string>();

/**
 * Mantiene un resumen acumulado de los mensajes que ya salieron de la ventana reciente.
 * Así la IA recuerda toda la conversación sin enviar el historial completo (menos costo).
 */
export async function maybeSummarize(ai: AiProvider, bot: Chatbot, conversationId: string): Promise<boolean> {
  if (running.has(conversationId)) return false;
  running.add(conversationId);
  try {
    const conv = await store.getConversation(conversationId);
    if (!conv) return false;
    const window = bot.ai.recent_messages;
    const pendingCount = await store.countMessagesAfter(conv.id, conv.summary_until_id);
    if (pendingCount <= window + bot.ai.summary_batch) return false;

    const recent = await store.recentMessages(conv.id, window);
    if (!recent.length) return false;
    const toSummarize = await store.messagesBetween(conv.id, conv.summary_until_id, recent[0].id - 1);
    if (!toSummarize.length) return false;

    const transcript = toSummarize
      .map((m) => {
        const who = m.direction === 'in' ? 'Cliente' : m.sender === 'human' ? 'Asesor' : 'Negocio';
        return `${who}: ${m.type === 'image' && m.direction === 'out' ? `[imagen enviada] ${m.content}` : m.content}`;
      })
      .join('\n');

    const model = config.openai.summaryModel || bot.ai.model || config.openai.defaultModel;
    const res = await ai.complete({
      model,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente que mantiene la memoria de una conversación de WhatsApp entre un negocio y un cliente. ' +
            'Actualiza el resumen existente integrando los mensajes nuevos. Escribe en español, en viñetas breves, máximo 180 palabras. Incluye: ' +
            'qué busca el cliente y sus intereses, preguntas que hizo y lo que se le respondió (con datos concretos como precios o fechas mencionados), ' +
            'datos que dio, acuerdos o compromisos, objeciones y pendientes. No inventes nada que no esté en los mensajes.',
        },
        {
          role: 'user',
          content: `Resumen actual:\n${conv.summary || '(vacío)'}\n\nMensajes nuevos a integrar:\n${transcript}`,
        },
      ],
    });
    await store.insertAiRun({
      chatbot_id: bot.id,
      conversation_id: conv.id,
      kind: 'summary',
      model: res.model,
      input_tokens: res.usage.input_tokens,
      cached_tokens: res.usage.cached_tokens,
      output_tokens: res.usage.output_tokens,
      latency_ms: res.latency_ms,
    });
    await store.updateSummary(conv.id, res.content.trim(), toSummarize[toSummarize.length - 1].id);
    return true;
  } finally {
    running.delete(conversationId);
  }
}
