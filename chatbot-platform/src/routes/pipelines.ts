import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, conversationFor, HttpError, notFound, requireRole, scopeAccount, targetAccount } from '../access.js';
import { DEFAULT_STAGES, PipelineBodySchema, withStageIds } from '../automation/pipelines.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import * as pstore from '../store/pipelines.js';
import type { User } from '../types.js';
import { parse } from './util.js';

const MoveBody = z.object({ stage_id: z.string().min(1).max(40), note: z.string().trim().max(300).default('') });

/** Pipelines de la cuenta: columnas personalizables por las que avanzan las solicitudes de los clientes. */
export async function pipelineRoutes(api: FastifyInstance, service: ChatService) {
  const admins = { preHandler: requireRole('admin') };
  const pipelineFor = async (user: User, id: string) => assertAccount(user, await pstore.getPipeline(id), 'Pipeline no encontrado');
  const checkBots = async (accountId: string, ids: string[]) => {
    for (const id of ids) {
      const bot = await store.getChatbot(id);
      if (!bot || bot.account_id !== accountId) throw new HttpError(400, 'Un agente no pertenece a la cuenta');
    }
  };

  // Quien atiende conversaciones también ve el tablero (solo con las suyas).
  api.get('/api/pipelines', async (req: any) => pstore.listPipelines(scopeAccount(req.user, req.query.account_id)));

  api.get('/api/pipelines/template', admins, async () => ({ name: 'Ventas', stages: withStageIds(DEFAULT_STAGES), allow_backward: false }));

  api.post('/api/pipelines', admins, async (req: any) => {
    const body = parse(PipelineBodySchema, req.body);
    const accountId = await targetAccount(req.user, req.body?.account_id);
    await checkBots(accountId, body.chatbot_ids);
    return pstore.savePipeline(accountId, { ...body, stages: withStageIds(body.stages) });
  });

  api.put('/api/pipelines/:id', admins, async (req: any) => {
    const existing = await pipelineFor(req.user, req.params.id);
    const body = parse(PipelineBodySchema, { ...existing, ...(req.body ?? {}) });
    await checkBots(existing.account_id, body.chatbot_ids);
    return pstore.savePipeline(existing.account_id, { ...body, stages: withStageIds(body.stages) }, existing.id);
  });

  api.delete('/api/pipelines/:id', admins, async (req: any) => {
    const existing = await pipelineFor(req.user, req.params.id);
    await pstore.deletePipeline(existing.id);
    return { ok: true };
  });

  api.get('/api/pipelines/:id/board', async (req: any) => {
    const pipeline = await pipelineFor(req.user, req.params.id);
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const cards = await pstore.boardCards(pipeline, { days, assignedTo: req.user.role === 'agent' ? req.user.id : null });
    return { pipeline, days, cards };
  });

  api.post('/api/pipeline-cards/:id/move', async (req: any) => {
    if (!/^\d+$/.test(String(req.params.id))) throw notFound('Tarjeta no encontrada');
    const card = await pstore.getCard(req.params.id);
    if (!card) throw notFound('Tarjeta no encontrada');
    await conversationFor(req.user, card.conversation_id); // mismo permiso que la conversación
    const b = parse(MoveBody, req.body);
    const pipeline = await pstore.getPipeline(card.pipeline_id);
    if (!pipeline?.stages.some((s) => s.id === b.stage_id)) throw new HttpError(400, 'Esa columna no existe en el pipeline');
    const moved = await service.pipelines.moveManually(card, b.stage_id, req.user.id, b.note);
    if (!moved) throw new HttpError(409, 'La tarjeta cambió mientras la movías: actualiza el tablero');
    return moved;
  });

  api.get('/api/conversations/:cid/pipeline', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    return pstore.cardsOfConversation(conv.id);
  });
}
