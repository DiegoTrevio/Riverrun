import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, conversationFor, HttpError, scopeAccount } from '../access.js';
import { query } from '../db.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

/** Conversaciones y contactos: disponible para administradores y agentes de la cuenta. */
export async function conversationRoutes(api: FastifyInstance, service: ChatService) {
  api.get('/api/conversations', async (req: any) => {
    const q = req.query as Record<string, string | undefined>;
    const params: unknown[] = [];
    const where: string[] = [];
    const account = scopeAccount(req.user, q.account_id);
    if (account) {
      params.push(account);
      where.push(`c.account_id = $${params.length}`);
    }
    for (const [key, col] of [['chatbot_id', 'c.chatbot_id'], ['channel_id', 'c.channel_id'], ['status', 'c.status'], ['channel_type', 'ch.type']] as const) {
      if (q[key]) {
        params.push(q[key]);
        where.push(`${col} = $${params.length}`);
      }
    }
    if (q.include_playground !== 'true') where.push(`ch.type <> 'playground'`);
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(ct.name ILIKE $${params.length} OR ct.push_name ILIKE $${params.length} OR ct.phone ILIKE $${params.length})`);
    }
    params.push(Math.min(Number(q.limit) || 100, 500));
    return query(
      `SELECT c.id, c.account_id, c.chatbot_id, c.channel_id, c.status, c.handoff_reason, c.last_message_at, c.created_at,
              ct.id AS contact_id, ct.name, ct.push_name, ct.phone, ct.external_id,
              ch.type AS channel_type, ch.name AS channel_name, b.name AS chatbot_name, a.name AS account_name,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         JOIN channels ch ON ch.id = c.channel_id
         JOIN accounts a ON a.id = c.account_id
         LEFT JOIN chatbots b ON b.id = c.chatbot_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.last_message_at DESC LIMIT $${params.length}`,
      params,
    );
  });

  api.get('/api/conversations/:cid', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const [contact, messages, bot, channel] = await Promise.all([
      store.getContact(conv.contact_id),
      query(
        `SELECT m.*, i.code AS image_code, i.name AS image_name FROM messages m LEFT JOIN images i ON i.id = m.image_id
         WHERE m.conversation_id = $1 ORDER BY m.id DESC LIMIT 500`,
        [conv.id],
      ),
      conv.chatbot_id ? store.getChatbot(conv.chatbot_id) : null,
      store.getChannel(conv.channel_id),
    ]);
    return {
      conversation: conv,
      contact,
      messages: messages.reverse(),
      chatbot: bot ? { id: bot.id, name: bot.name, data_fields: bot.data_fields } : null,
      channel: channel ? { id: channel.id, name: channel.name, type: channel.type } : null,
    };
  });

  const log = (conv: { account_id: string; chatbot_id: string | null; channel_id: string; id: string }, message: string) =>
    logEvent({ level: 'info', source: 'admin', message, accountId: conv.account_id, chatbotId: conv.chatbot_id, channelId: conv.channel_id, conversationId: conv.id });

  api.post('/api/conversations/:cid/takeover', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const updated = await store.setConversationStatus(conv.id, 'human', `Tomada por ${req.user.name || req.user.email}`);
    await store.markAllProcessed(conv.id);
    await log(conv, `Conversación tomada por ${req.user.email}`);
    return updated;
  });

  api.post('/api/conversations/:cid/release', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    // Los mensajes que llegaron mientras atendía una persona no se responden en automático.
    await store.markAllProcessed(conv.id);
    const updated = await store.setConversationStatus(conv.id, 'bot', '');
    await log(conv, `Conversación devuelta al bot por ${req.user.email}`);
    return updated;
  });

  api.post('/api/conversations/:cid/close', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    return store.setConversationStatus(conv.id, 'closed', `Cerrada por ${req.user.name || req.user.email}`);
  });

  api.post('/api/conversations/:cid/send', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const b = parse(z.object({ text: z.string().trim().min(1, 'Mensaje vacío').max(4000), takeover: z.boolean().default(true) }), req.body);
    if (b.takeover && conv.status === 'bot') {
      await store.setConversationStatus(conv.id, 'human', `${req.user.name || req.user.email} respondió desde el panel`);
      await store.markAllProcessed(conv.id);
    }
    try {
      return await service.sendManual(conv.id, b.text);
    } catch (e: any) {
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.post('/api/conversations/:cid/reset-memory', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    await store.updateSummary(conv.id, '', 0);
    await store.updateContact(conv.contact_id, { data: {}, notes: [], name: '' });
    return { ok: true };
  });

  api.put('/api/contacts/:id', async (req: any) => {
    const contact = assertAccount(req.user, await store.getContact(req.params.id), 'Contacto no encontrado');
    const b = parse(
      z.object({ name: z.string().max(100).optional(), data: z.record(z.string(), z.string().max(500)).optional(), notes: z.array(z.string().max(300)).max(50).optional() }),
      req.body,
    );
    return store.updateContact(contact.id, b);
  });
}
