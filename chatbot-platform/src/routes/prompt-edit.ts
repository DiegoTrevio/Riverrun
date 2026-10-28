import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { botFor, requireRole } from '../access.js';
import { agentDraft } from '../agent-quality.js';
import { editPrompt, promptChanges } from '../agent-prompt-edit.js';
import { accountAi } from '../ai/budget.js';
import type { AiProvider } from '../ai/provider.js';
import { checkAiDesignRate } from '../automation/flow-ai.js';
import { query } from '../db.js';
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
 * Cambio a las instrucciones del agente, escrito en palabras. Aquí no se guarda nada: el panel lo aplica con el guardado
 * de siempre (queda en el historial de versiones, con lo que se pidió como motivo). La IA recibe los cambios anteriores
 * de ese historial para poder volver a lo que ya se agregó o se quitó.
 */
export async function promptEditRoutes(api: FastifyInstance, ai: AiProvider) {
  api.post('/api/chatbots/:id/prompt-edit', { preHandler: requireRole('admin') }, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    const body = parse(Body, req.body);
    checkAiDesignRate(bot.account_id);
    const draft = hydrateChatbot({ ...bot, ...(await agentDraft(bot)).configuration });
    const prompt = body.prompt ?? draft.personality.prompt;
    const releases = await query<{ prompt: string | null; reason: string; created_at: Date }>(
      `SELECT configuration->'personality'->>'prompt' AS prompt, reason, created_at FROM agent_releases WHERE chatbot_id = $1 ORDER BY id DESC LIMIT 30`, [bot.id]);
    const history = promptChanges(releases.map((r) => ({ prompt: r.prompt ?? '', at: r.created_at, reason: r.reason })));
    let result;
    try {
      result = await editPrompt(accountAi(ai, bot.account_id, bot.id, 'prompt_edit'), { prompt, instruction: body.instruction, context: body.context, agent: bot.name, history, timeZone: draft.ai.timezone });
    } catch (e: any) {
      await logEvent({ level: 'warn', source: 'ai', message: `No se pudo preparar el cambio de instrucciones: ${e?.message ?? e}`, accountId: bot.account_id, chatbotId: bot.id });
      throw e;
    }
    const { run } = result;
    await store.insertAiRun({ account_id: bot.account_id, chatbot_id: bot.id, conversation_id: null, kind: 'prompt_edit', model: run.model, input_tokens: run.usage.input_tokens, cached_tokens: run.usage.cached_tokens, output_tokens: run.usage.output_tokens, cost_usd: run.cost_usd, latency_ms: run.latency_ms });
    return { summary: result.summary, question: result.question, prompt: result.prompt, lines: result.lines, changed: result.changed };
  });
}
