import type { FastifyInstance } from 'fastify';
import { parseWebhook } from '../evolution/parse.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';

export async function webhookRoutes(app: FastifyInstance, service: ChatService) {
  // Evolution puede agregar el nombre del evento al final de la URL (webhook_by_events); lo aceptamos.
  const handler = async (req: any, reply: any) => {
    const bot = await store.getChatbotByToken(req.params.token);
    if (!bot) {
      await logEvent({ level: 'warn', source: 'webhook', message: 'Webhook con token inválido', details: { ip: req.ip } });
      return reply.code(404).send({ ok: false });
    }
    // Responder rápido a Evolution y procesar en segundo plano.
    reply.send({ ok: true });
    try {
      const { event, messages } = parseWebhook(req.body);
      if (event === 'connection.update') {
        const state = req.body?.data?.state;
        await logEvent({ level: state === 'open' ? 'info' : 'warn', source: 'evolution', message: `Estado de conexión de WhatsApp: ${state}`, chatbotId: bot.id });
        return;
      }
      for (const m of messages) {
        await service.handleIncoming(bot, m);
      }
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'webhook', message: `Error procesando webhook: ${e?.message ?? e}`, chatbotId: bot.id, details: e });
    }
  };
  app.post('/webhook/:token', handler);
  app.post('/webhook/:token/:event', handler);
}
