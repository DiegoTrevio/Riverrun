import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { checkCredentials, clearSessionCookie, loginAllowed, registerLoginFailure, requireAuth, setSessionCookie } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { imageAbsolutePath } from '../engine/transport.js';
import { EvolutionClient } from '../evolution/client.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import {
  AiSettingsSchema,
  DataFieldSchema,
  FlowSchema,
  KNOWLEDGE_CATEGORIES,
  PersonalitySchema,
  RulesSchema,
  type Chatbot,
} from '../types.js';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // límite de WhatsApp para imágenes

const ChatbotBody = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  whatsapp_number: z.string().max(30).optional(),
  evolution_instance: z.string().regex(/^[A-Za-z0-9_-]*$/, 'Solo letras, números, guion y guion bajo').max(60).nullable().optional(),
  evolution_url: z.string().max(300).nullable().optional(),
  evolution_api_key: z.string().max(300).nullable().optional(),
  personality: PersonalitySchema.optional(),
  rules: RulesSchema.optional(),
  // Sin .default(): un PUT parcial no debe reiniciar los campos.
  data_fields: z.array(DataFieldSchema).optional(),
  flow: FlowSchema.optional(),
  ai: AiSettingsSchema.optional(),
});

const KnowledgeBody = z.object({
  category: z.string().max(60).optional(),
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(50000).optional(),
  always_include: z.boolean().optional(),
  active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const ImageMeta = z.object({
  code: z.string().regex(/^[a-z0-9_-]+$/, 'ID: solo minúsculas, números, guion y guion bajo').max(60).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  usage_rule: z.string().max(1000).optional(),
  caption: z.string().max(1000).optional(),
  active: z.boolean().optional(),
});

function bad(reply: FastifyReply, error: unknown, code = 400) {
  if (error instanceof z.ZodError) {
    return reply.code(code).send({ error: 'Datos inválidos', issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  return reply.code(code).send({ error: String((error as any)?.message ?? error) });
}

/** Oculta credenciales y agrega la URL del webhook. */
function publicBot(bot: Chatbot) {
  return {
    ...bot,
    evolution_api_key: bot.evolution_api_key ? '••••••' : null,
    webhook_url: `${config.webhookBaseUrl}/webhook/${bot.webhook_token}`,
  };
}

export async function adminRoutes(app: FastifyInstance, service: ChatService) {
  /* ------------------------------ Sesión ------------------------------ */
  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { user?: string; password?: string };
    if (!loginAllowed(req.ip)) return reply.code(429).send({ error: 'Demasiados intentos, espera 15 minutos' });
    if (!checkCredentials(String(body.user ?? ''), String(body.password ?? ''))) {
      registerLoginFailure(req.ip);
      await logEvent({ level: 'warn', source: 'admin', message: 'Intento de acceso fallido', details: { ip: req.ip } });
      return reply.code(401).send({ error: 'Usuario o contraseña incorrectos' });
    }
    setSessionCookie(reply, String(body.user));
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/api/me', async (req) => ({ user: (req as any).user }));

    api.get('/api/meta', async () => ({
      knowledge_categories: KNOWLEDGE_CATEGORIES,
      defaults: {
        personality: PersonalitySchema.parse({}),
        rules: RulesSchema.parse({}),
        flow: FlowSchema.parse({}),
        ai: AiSettingsSchema.parse({}),
      },
      default_model: config.openai.defaultModel,
      webhook_base_url: config.webhookBaseUrl,
    }));

    api.get('/api/stats', async () => {
      const rows = await query(`
        SELECT b.id, b.name, b.active,
          (SELECT count(*)::int FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.chatbot_id = b.id AND ct.channel = 'whatsapp') AS conversations,
          (SELECT count(*)::int FROM conversations c WHERE c.chatbot_id = b.id AND c.status = 'human') AS waiting_human,
          (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.chatbot_id = b.id AND m.created_at > now() - interval '24 hours') AS messages_24h,
          (SELECT coalesce(sum(input_tokens),0)::int FROM ai_runs r WHERE r.chatbot_id = b.id AND r.created_at > now() - interval '30 days') AS input_tokens_30d,
          (SELECT coalesce(sum(cached_tokens),0)::int FROM ai_runs r WHERE r.chatbot_id = b.id AND r.created_at > now() - interval '30 days') AS cached_tokens_30d,
          (SELECT coalesce(sum(output_tokens),0)::int FROM ai_runs r WHERE r.chatbot_id = b.id AND r.created_at > now() - interval '30 days') AS output_tokens_30d,
          (SELECT count(*)::int FROM event_logs l WHERE l.chatbot_id = b.id AND l.level = 'error' AND l.created_at > now() - interval '24 hours') AS errors_24h
        FROM chatbots b ORDER BY b.created_at`);
      return { chatbots: rows };
    });

    /* ------------------------------ Chatbots ------------------------------ */
    api.get('/api/chatbots', async () => (await store.listChatbots()).map(publicBot));

    api.post('/api/chatbots', async (req, reply) => {
      const parsed = ChatbotBody.safeParse(req.body ?? {});
      if (!parsed.success) return bad(reply, parsed.error);
      try {
        const bot = await store.createChatbot({ name: 'Nuevo chatbot', ...parsed.data });
        await logEvent({ level: 'info', source: 'admin', message: `Chatbot creado: ${bot.name}`, chatbotId: bot.id });
        return publicBot(bot);
      } catch (e) {
        return bad(reply, uniqueError(e));
      }
    });

    api.get('/api/chatbots/:id', async (req: any, reply) => {
      const bot = await store.getChatbot(req.params.id);
      return bot ? publicBot(bot) : reply.code(404).send({ error: 'No encontrado' });
    });

    api.put('/api/chatbots/:id', async (req: any, reply) => {
      const parsed = ChatbotBody.safeParse(req.body ?? {});
      if (!parsed.success) return bad(reply, parsed.error);
      const data = { ...parsed.data };
      if (data.evolution_api_key === '••••••') delete data.evolution_api_key;
      try {
        const bot = await store.updateChatbot(req.params.id, data);
        if (!bot) return reply.code(404).send({ error: 'No encontrado' });
        await logEvent({ level: 'info', source: 'admin', message: `Configuración actualizada (${Object.keys(data).join(', ')})`, chatbotId: bot.id });
        return publicBot(bot);
      } catch (e) {
        return bad(reply, uniqueError(e));
      }
    });

    api.delete('/api/chatbots/:id', async (req: any) => {
      const imgs = await store.listImages(req.params.id);
      await store.deleteChatbot(req.params.id);
      for (const i of imgs) await fsp.rm(imageAbsolutePath(i), { force: true });
      return { ok: true };
    });

    /** Duplica un chatbot (configuración, conocimiento e imágenes) para otro negocio. */
    api.post('/api/chatbots/:id/duplicate', async (req: any, reply) => {
      const src = await store.getChatbot(req.params.id);
      if (!src) return reply.code(404).send({ error: 'No encontrado' });
      const copy = await store.createChatbot({
        name: `${src.name} (copia)`,
        active: false,
        personality: src.personality,
        rules: src.rules,
        data_fields: src.data_fields,
        flow: src.flow,
        ai: src.ai,
      });
      for (const k of await store.listKnowledge(src.id)) {
        await store.upsertKnowledge(copy.id, { category: k.category, title: k.title, content: k.content, always_include: k.always_include, active: k.active, sort_order: k.sort_order });
      }
      for (const img of await store.listImages(src.id)) {
        const rel = path.join(copy.id, `${crypto.randomUUID()}${path.extname(img.file_path)}`);
        await fsp.mkdir(path.join(config.uploadsDir, copy.id), { recursive: true });
        await fsp.copyFile(imageAbsolutePath(img), path.join(config.uploadsDir, rel)).catch(() => undefined);
        await store.insertImage({ ...img, chatbot_id: copy.id, file_path: rel });
      }
      return publicBot(copy);
    });

    api.post('/api/chatbots/:id/rotate-token', async (req: any) => {
      const token = await store.rotateWebhookToken(req.params.id);
      return { webhook_url: `${config.webhookBaseUrl}/webhook/${token}` };
    });

    /* ------------------------------ Conocimiento ------------------------------ */
    api.get('/api/chatbots/:id/knowledge', async (req: any) => store.listKnowledge(req.params.id));

    api.post('/api/chatbots/:id/knowledge', async (req: any, reply) => {
      const parsed = KnowledgeBody.safeParse(req.body ?? {});
      if (!parsed.success) return bad(reply, parsed.error);
      if (!parsed.data.title) return bad(reply, 'El título es obligatorio');
      return store.upsertKnowledge(req.params.id, parsed.data);
    });

    api.put('/api/knowledge/:kid', async (req: any, reply) => {
      const parsed = KnowledgeBody.safeParse(req.body ?? {});
      if (!parsed.success) return bad(reply, parsed.error);
      const existing = await store.getKnowledge(req.params.kid);
      if (!existing) return reply.code(404).send({ error: 'No encontrado' });
      return store.upsertKnowledge(existing.chatbot_id, { ...parsed.data, id: existing.id });
    });

    api.delete('/api/knowledge/:kid', async (req: any) => {
      await store.deleteKnowledge(req.params.kid);
      return { ok: true };
    });

    /* ------------------------------- Imágenes ------------------------------- */
    api.get('/api/chatbots/:id/images', async (req: any) => store.listImages(req.params.id));

    api.post('/api/chatbots/:id/images', async (req: any, reply) => {
      const bot = await store.getChatbot(req.params.id);
      if (!bot) return reply.code(404).send({ error: 'Chatbot no encontrado' });
      const upload = await readUpload(req);
      if ('error' in upload) return bad(reply, upload.error);
      const meta = ImageMeta.safeParse(upload.fields);
      if (!meta.success) return bad(reply, meta.error);
      if (!meta.data.code || !meta.data.name) return bad(reply, 'El ID y el nombre son obligatorios');
      if (!upload.file) return bad(reply, 'Falta el archivo de imagen');
      const rel = await saveFile(bot.id, upload.file);
      try {
        const img = await store.insertImage({
          chatbot_id: bot.id,
          code: meta.data.code,
          name: meta.data.name,
          description: meta.data.description ?? '',
          usage_rule: meta.data.usage_rule ?? '',
          caption: meta.data.caption ?? '',
          file_path: rel,
          mime_type: upload.file.mime,
          size_bytes: upload.file.buffer.length,
          active: meta.data.active ?? true,
        });
        await logEvent({ level: 'info', source: 'admin', message: `Imagen agregada: ${img.code}`, chatbotId: bot.id });
        return img;
      } catch (e) {
        await fsp.rm(path.join(config.uploadsDir, rel), { force: true });
        return bad(reply, uniqueError(e));
      }
    });

    api.put('/api/images/:iid', async (req: any, reply) => {
      const img = await store.getImage(req.params.iid);
      if (!img) return reply.code(404).send({ error: 'No encontrada' });
      let fields: Record<string, unknown> = req.body ?? {};
      let file: UploadFile | undefined;
      if (req.isMultipart()) {
        const upload = await readUpload(req);
        if ('error' in upload) return bad(reply, upload.error);
        fields = upload.fields;
        file = upload.file;
      }
      const meta = ImageMeta.safeParse(fields);
      if (!meta.success) return bad(reply, meta.error);
      const patch: Record<string, unknown> = { ...meta.data };
      if (file) {
        patch.file_path = await saveFile(img.chatbot_id, file);
        patch.mime_type = file.mime;
        patch.size_bytes = file.buffer.length;
      }
      try {
        const updated = await store.updateImage(img.id, patch);
        if (file) await fsp.rm(imageAbsolutePath(img), { force: true });
        return updated;
      } catch (e) {
        return bad(reply, uniqueError(e));
      }
    });

    api.delete('/api/images/:iid', async (req: any) => {
      const img = await store.getImage(req.params.iid);
      if (img) {
        await store.deleteImage(img.id);
        await fsp.rm(imageAbsolutePath(img), { force: true });
      }
      return { ok: true };
    });

    api.get('/api/images/:iid/file', async (req: any, reply) => {
      const img = await store.getImage(req.params.iid);
      if (!img) return reply.code(404).send();
      const p = imageAbsolutePath(img);
      if (!fs.existsSync(p)) return reply.code(404).send();
      reply.header('content-type', img.mime_type).header('cache-control', 'private, max-age=300');
      return reply.send(fs.createReadStream(p));
    });

    /* ------------------------------- WhatsApp ------------------------------- */
    const requireInstance = async (id: string) => {
      const bot = await store.getChatbot(id);
      if (!bot) throw new Error('Chatbot no encontrado');
      if (!bot.evolution_instance) throw new Error('Primero define el nombre de la instancia de Evolution');
      return bot;
    };
    const webhookUrl = (bot: Chatbot) => `${config.webhookBaseUrl}/webhook/${bot.webhook_token}`;

    api.get('/api/chatbots/:id/whatsapp/status', async (req: any, reply) => {
      try {
        const bot = await requireInstance(req.params.id);
        const state = await EvolutionClient.forChatbot(bot).connectionState(bot.evolution_instance!);
        return { state };
      } catch (e: any) {
        return reply.code(e?.status === 404 ? 200 : 400).send(e?.status === 404 ? { state: 'not_found' } : { error: e?.message ?? String(e) });
      }
    });

    /** Crea la instancia si no existe, configura el webhook y devuelve el QR. */
    api.post('/api/chatbots/:id/whatsapp/connect', async (req: any, reply) => {
      try {
        const bot = await requireInstance(req.params.id);
        const evo = EvolutionClient.forChatbot(bot);
        let state = 'not_found';
        try {
          state = await evo.connectionState(bot.evolution_instance!);
        } catch (e: any) {
          if (e?.status !== 404) throw e;
        }
        if (state === 'not_found') {
          const created = await evo.createInstance(bot.evolution_instance!, webhookUrl(bot), bot.whatsapp_number.replace(/\D/g, '') || undefined);
          await logEvent({ level: 'info', source: 'evolution', message: `Instancia creada: ${bot.evolution_instance}`, chatbotId: bot.id });
          const qr = created?.qrcode;
          if (qr?.base64) return { state: 'connecting', qr: qr.base64, pairingCode: qr.pairingCode ?? null };
        } else {
          await evo.setWebhook(bot.evolution_instance!, webhookUrl(bot));
        }
        if (state === 'open') return { state };
        const c = await evo.connect(bot.evolution_instance!);
        return { state: c.state ?? 'connecting', qr: c.base64 ?? null, pairingCode: c.pairingCode ?? null };
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'evolution', message: `Error al conectar WhatsApp: ${e?.message ?? e}`, chatbotId: req.params.id });
        return bad(reply, e);
      }
    });

    api.post('/api/chatbots/:id/whatsapp/webhook', async (req: any, reply) => {
      try {
        const bot = await requireInstance(req.params.id);
        await EvolutionClient.forChatbot(bot).setWebhook(bot.evolution_instance!, webhookUrl(bot));
        return { ok: true, webhook_url: webhookUrl(bot) };
      } catch (e) {
        return bad(reply, e);
      }
    });

    api.post('/api/chatbots/:id/whatsapp/logout', async (req: any, reply) => {
      try {
        const bot = await requireInstance(req.params.id);
        await EvolutionClient.forChatbot(bot).logout(bot.evolution_instance!);
        return { ok: true };
      } catch (e) {
        return bad(reply, e);
      }
    });

    api.post('/api/chatbots/:id/whatsapp/test', async (req: any, reply) => {
      const { number, text } = (req.body ?? {}) as { number?: string; text?: string };
      try {
        const bot = await requireInstance(req.params.id);
        await EvolutionClient.forChatbot(bot).sendText(bot.evolution_instance!, String(number ?? '').replace(/\D/g, ''), text || 'Mensaje de prueba ✅');
        return { ok: true };
      } catch (e) {
        return bad(reply, e);
      }
    });

    /* ------------------------------- Simulador ------------------------------- */
    api.post('/api/chatbots/:id/playground', async (req: any, reply) => {
      const bot = await store.getChatbot(req.params.id);
      if (!bot) return reply.code(404).send({ error: 'No encontrado' });
      const { session, text } = (req.body ?? {}) as { session?: string; text?: string };
      if (!text?.trim()) return bad(reply, 'Escribe un mensaje');
      const sid = String(session || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default';
      return service.playground(bot, sid, text.trim());
    });

    api.get('/api/chatbots/:id/playground/:session', async (req: any, reply) => {
      const bot = await store.getChatbot(req.params.id);
      if (!bot) return reply.code(404).send({ error: 'No encontrado' });
      const messages = await query(
        `SELECT m.*, i.code AS image_code FROM messages m
           JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
           LEFT JOIN images i ON i.id = m.image_id
         WHERE ct.chatbot_id = $1 AND ct.jid = $2 ORDER BY m.id`,
        [bot.id, `playground:${req.params.session}`],
      );
      return { messages };
    });

    api.delete('/api/chatbots/:id/playground/:session', async (req: any, reply) => {
      const bot = await store.getChatbot(req.params.id);
      if (!bot) return reply.code(404).send({ error: 'No encontrado' });
      await service.resetPlayground(bot, req.params.session);
      return { ok: true };
    });

    /* ----------------------------- Conversaciones ----------------------------- */
    api.get('/api/conversations', async (req: any) => {
      const q = req.query as { chatbot_id?: string; status?: string; search?: string; include_playground?: string; limit?: string };
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.chatbot_id) {
        params.push(q.chatbot_id);
        where.push(`c.chatbot_id = $${params.length}`);
      }
      if (q.status) {
        params.push(q.status);
        where.push(`c.status = $${params.length}`);
      }
      if (q.include_playground !== 'true') where.push(`ct.channel = 'whatsapp'`);
      if (q.search) {
        params.push(`%${q.search}%`);
        where.push(`(ct.name ILIKE $${params.length} OR ct.push_name ILIKE $${params.length} OR ct.phone ILIKE $${params.length})`);
      }
      params.push(Math.min(Number(q.limit) || 100, 500));
      return query(
        `SELECT c.id, c.chatbot_id, c.status, c.handoff_reason, c.last_message_at, c.created_at,
                ct.id AS contact_id, ct.name, ct.push_name, ct.phone, ct.channel, b.name AS chatbot_name,
                (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
                (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN chatbots b ON b.id = c.chatbot_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY c.last_message_at DESC LIMIT $${params.length}`,
        params,
      );
    });

    api.get('/api/conversations/:cid', async (req: any, reply) => {
      const conv = await store.getConversation(req.params.cid);
      if (!conv) return reply.code(404).send({ error: 'No encontrada' });
      const [contact, messages, bot] = await Promise.all([
        store.getContact(conv.contact_id),
        query(`SELECT m.*, i.code AS image_code, i.name AS image_name FROM messages m LEFT JOIN images i ON i.id = m.image_id WHERE m.conversation_id = $1 ORDER BY m.id DESC LIMIT 500`, [conv.id]),
        store.getChatbot(conv.chatbot_id),
      ]);
      return { conversation: conv, contact, messages: messages.reverse(), chatbot: bot ? { id: bot.id, name: bot.name, data_fields: bot.data_fields } : null };
    });

    api.post('/api/conversations/:cid/takeover', async (req: any, reply) => {
      const conv = await store.setConversationStatus(req.params.cid, 'human', 'Tomada manualmente desde el panel');
      if (!conv) return reply.code(404).send({ error: 'No encontrada' });
      await store.markAllProcessed(conv.id);
      await logEvent({ level: 'info', source: 'admin', message: 'Conversación tomada manualmente', chatbotId: conv.chatbot_id, conversationId: conv.id });
      return conv;
    });

    api.post('/api/conversations/:cid/release', async (req: any, reply) => {
      // Los mensajes que llegaron mientras atendía un humano no se responden en automático.
      await store.markAllProcessed(req.params.cid);
      const conv = await store.setConversationStatus(req.params.cid, 'bot', '');
      if (!conv) return reply.code(404).send({ error: 'No encontrada' });
      await logEvent({ level: 'info', source: 'admin', message: 'Conversación devuelta al bot', chatbotId: conv.chatbot_id, conversationId: conv.id });
      return conv;
    });

    api.post('/api/conversations/:cid/close', async (req: any, reply) => {
      const conv = await store.setConversationStatus(req.params.cid, 'closed', 'Cerrada desde el panel');
      return conv ?? reply.code(404).send({ error: 'No encontrada' });
    });

    api.post('/api/conversations/:cid/send', async (req: any, reply) => {
      const { text, takeover } = (req.body ?? {}) as { text?: string; takeover?: boolean };
      if (!text?.trim()) return bad(reply, 'Mensaje vacío');
      try {
        if (takeover !== false) {
          const conv = await store.getConversation(req.params.cid);
          if (conv?.status === 'bot') {
            await store.setConversationStatus(conv.id, 'human', 'Una persona respondió desde el panel');
            await store.markAllProcessed(conv.id);
          }
        }
        return await service.sendManual(req.params.cid, text.trim());
      } catch (e) {
        return bad(reply, e);
      }
    });

    api.post('/api/conversations/:cid/reset-memory', async (req: any, reply) => {
      const conv = await store.getConversation(req.params.cid);
      if (!conv) return reply.code(404).send({ error: 'No encontrada' });
      await store.updateSummary(conv.id, '', 0);
      await store.updateContact(conv.contact_id, { data: {}, notes: [], name: '' });
      return { ok: true };
    });

    api.put('/api/contacts/:id', async (req: any, reply) => {
      const body = z
        .object({ name: z.string().max(100).optional(), data: z.record(z.string(), z.string()).optional(), notes: z.array(z.string()).optional() })
        .safeParse(req.body ?? {});
      if (!body.success) return bad(reply, body.error);
      const c = await store.updateContact(req.params.id, body.data);
      return c ?? reply.code(404).send({ error: 'No encontrado' });
    });

    /* ---------------------------------- Logs ---------------------------------- */
    api.get('/api/logs', async (req: any) => {
      const q = req.query as { chatbot_id?: string; level?: string; source?: string; conversation_id?: string; limit?: string };
      const params: unknown[] = [];
      const where: string[] = [];
      for (const k of ['chatbot_id', 'level', 'source', 'conversation_id'] as const) {
        if (q[k]) {
          params.push(q[k]);
          where.push(`${k} = $${params.length}`);
        }
      }
      params.push(Math.min(Number(q.limit) || 200, 1000));
      return query(`SELECT * FROM event_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
    });

    api.get('/api/ai-runs', async (req: any) => {
      const q = req.query as { conversation_id?: string; chatbot_id?: string };
      if (q.conversation_id) return query(`SELECT * FROM ai_runs WHERE conversation_id = $1 ORDER BY id DESC LIMIT 100`, [q.conversation_id]);
      if (q.chatbot_id) return query(`SELECT * FROM ai_runs WHERE chatbot_id = $1 ORDER BY id DESC LIMIT 100`, [q.chatbot_id]);
      return query(`SELECT * FROM ai_runs ORDER BY id DESC LIMIT 100`);
    });

    api.get('/api/health/deep', async () => {
      const db = await queryOne('SELECT 1 AS ok').then(() => true).catch(() => false);
      return { db, openai_configured: !!config.openai.apiKey, evolution_configured: !!config.evolution.apiKey, queue: service.queue.size };
    });
  });
}

/* ------------------------------ Utilidades ------------------------------ */

interface UploadFile {
  buffer: Buffer;
  mime: string;
  ext: string;
}

async function readUpload(req: any): Promise<{ fields: Record<string, unknown>; file?: UploadFile } | { error: string }> {
  const fields: Record<string, unknown> = {};
  let file: UploadFile | undefined;
  for await (const part of req.parts({ limits: { fileSize: MAX_IMAGE_BYTES } })) {
    if (part.type === 'file') {
      const buffer: Buffer = await part.toBuffer();
      if (part.file.truncated) return { error: 'La imagen supera 5 MB' };
      const mime = sniffImage(buffer);
      if (!mime || !ALLOWED_MIME.includes(mime)) return { error: 'Formato no válido: usa JPG, PNG o WEBP' };
      file = { buffer, mime, ext: mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg' };
    } else {
      const v = part.value;
      fields[part.fieldname] = v === 'true' ? true : v === 'false' ? false : v;
    }
  }
  return { fields, file };
}

/** Detecta el tipo real por la firma del archivo (no confiar en la extensión). */
function sniffImage(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function saveFile(chatbotId: string, file: UploadFile) {
  const dir = path.join(config.uploadsDir, chatbotId);
  await fsp.mkdir(dir, { recursive: true });
  const rel = path.join(chatbotId, `${crypto.randomUUID()}${file.ext}`);
  await fsp.writeFile(path.join(config.uploadsDir, rel), file.buffer);
  return rel;
}

function uniqueError(e: any) {
  if (e?.code === '23505') {
    if (String(e.constraint).includes('evolution_instance')) return new Error('Ese nombre de instancia ya lo usa otro chatbot');
    if (String(e.constraint).includes('code')) return new Error('Ya existe una imagen con ese ID en este chatbot');
    return new Error('Valor duplicado');
  }
  return e;
}
