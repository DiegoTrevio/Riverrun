import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { botFor, requireRole } from '../access.js';
import { agentDraft } from '../agent-quality.js';
import { editPrompt } from '../agent-prompt-edit.js';
import { accountAi } from '../ai/budget.js';
import { assertAiAllowed } from '../ai/gate.js';
import type { AiProvider } from '../ai/provider.js';
import { checkAiDesignRate } from '../automation/flow-ai.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { hydrateChatbot } from '../types.js';
import { parse } from './util.js';

const Body = z.object({
  instruction: z.string().trim().min(1, 'Escribe qué quieres cambiar').max(2000, 'Resume el cambio en menos de 2000 caracteres'),
  /** El texto sobre el que se pide el cambio (puede traer cambios aún sin aplicar); sin él, el del agente. */
  prompt: z.string().max(60000).optional(),
  context: z.string().max(4000).default(''),
});

/**
 * Propuesta de cambio a las instrucciones del agente, escrita en palabras. No guarda nada: el panel muestra el antes y
 * el después, y al aplicarlo usa el guardado de siempre (queda en el historial de versiones).
 */
export async function promptEditRoutes(api: FastifyInstance, ai: AiProvider) {
  api.post('/api/chatbots/:id/prompt-edit', { preHandler: requireRole('admin') }, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    await assertAiAllowed(bot.account_id);
    const body = parse(Body, req.body);
    checkAiDesignRate(bot.account_id);
    const prompt = body.prompt ?? hydrateChatbot({ ...bot, ...(await agentDraft(bot)).configuration }).personality.prompt;
    let result;
    try {
      result = await editPrompt(accountAi(ai, bot.account_id, bot.id, 'prompt_edit'), { prompt, instruction: body.instruction, context: body.context, agent: bot.name });
    } catch (e: any) {
      await logEvent({ level: 'warn', source: 'ai', message: `No se pudo preparar el cambio de instrucciones: ${e?.message ?? e}`, accountId: bot.account_id, chatbotId: bot.id });
      throw e;
    }
    const { run } = result;
    await store.insertAiRun({ account_id: bot.account_id, chatbot_id: bot.id, conversation_id: null, kind: 'prompt_edit', model: run.model, input_tokens: run.usage.input_tokens, cached_tokens: run.usage.cached_tokens, output_tokens: run.usage.output_tokens, cost_usd: run.cost_usd, latency_ms: run.latency_ms });
    return { summary: result.summary, question: result.question, prompt: result.prompt, lines: result.lines, changed: result.changed };
  });
}
