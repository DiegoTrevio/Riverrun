import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, botFor, HttpError, notFound, requireRole, scopeAccount, targetAccount } from '../access.js';
import { publicChannel } from '../channels/index.js';
import { config } from '../config.js';
import { OpenAiProvider } from '../ai/provider.js';
import { indexKnowledge, knowledgeIndexStatus } from '../engine/knowledge.js';
import { imageAbsolutePath } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import { AiSettingsSchema, DataFieldSchema, FlowSchema, ImageSendWhenSchema, PersonalitySchema, RulesSchema, type Chatbot, type User } from '../types.js';
import { alignFixedMessages, chatbotFromTemplate } from '../templates/business.js';
import { parse, readUpload, saveFile, type UploadFile } from './util.js';

const ChatbotBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
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
  // En un formulario con archivo llega como texto JSON.
  send_when: z
    .preprocess((v) => {
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }, ImageSendWhenSchema)
    .optional(),
});

/** Los agentes solo ven nombre y estado (para filtros); la configuración es de administradores. */
function visibleBot(user: User, bot: Chatbot) {
  if (user.role === 'agent') return { id: bot.id, account_id: bot.account_id, name: bot.name, active: bot.active };
  return bot;
}

export async function chatbotRoutes(api: FastifyInstance, service: ChatService) {
  const admins = { preHandler: requireRole('admin') };

  /* ------------------------------ Chatbots ------------------------------ */
  api.get('/api/chatbots', async (req: any) => (await store.listChatbots(scopeAccount(req.user, req.query.account_id))).map((b) => visibleBot(req.user, b)));

  api.post('/api/chatbots', admins, async (req: any) => {
    const b = parse(ChatbotBody.extend({ account_id: z.string().uuid().optional(), template: z.string().max(40).optional() }), req.body);
    const accountId = await targetAccount(req.user, b.account_id);
    const { template, account_id, ...input } = b;
    void account_id;
    let base: Record<string, unknown> = {};
    if (template) {
      // Nace con la plantilla del giro: personalidad, reglas, flujo y datos a pedir ya listos para ajustar.
      const acc = await store.getAccount(accountId);
      const tpl = chatbotFromTemplate({ business_type: template, company: input.name || acc!.name, assistant_name: '', description: '' });
      base = {
        personality: PersonalitySchema.parse(tpl.personality),
        rules: RulesSchema.parse(tpl.rules),
        flow: FlowSchema.parse(tpl.flow),
        data_fields: tpl.data_fields.map((f) => DataFieldSchema.parse(f)),
      };
    }
    const bot = await store.createChatbot(accountId, { name: 'Nuevo chatbot', ...base, ...input });
    await logEvent({ level: 'info', source: 'admin', message: `Chatbot creado: ${bot.name}`, accountId, chatbotId: bot.id });
    return bot;
  });

  api.get('/api/chatbots/:id', async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    const channels = (await store.listChannels(bot.account_id, { chatbotId: bot.id })).map(publicChannel);
    return { ...visibleBot(req.user, bot), channels };
  });

  api.put('/api/chatbots/:id', admins, async (req: any) => {
    const existing = await botFor(req.user, req.params.id);
    const raw = (req.body ?? {}) as Record<string, any>;
    const data: Record<string, any> = { ...parse(ChatbotBody, raw) };
    // Las secciones se fusionan con lo guardado: enviar solo un campo no reinicia los demás.
    const sections = { personality: PersonalitySchema, rules: RulesSchema, flow: FlowSchema, ai: AiSettingsSchema } as const;
    for (const [key, schema] of Object.entries(sections)) {
      if (raw[key] && typeof raw[key] === 'object') {
        const merged = { ...(existing as any)[key], ...raw[key] };
        if (key === 'rules' && raw.rules.activation) {
          merged.activation = { ...existing.rules.activation, ...raw.rules.activation };
        }
        data[key] = schema.parse(merged);
      }
    }
    // Al cambiar el trato (tú/usted), los mensajes fijos de fábrica se ajustan para no mezclar tratos.
    const formality = data.personality?.formality;
    if (formality && formality !== existing.personality.formality) data.rules = alignFixedMessages(data.rules ?? existing.rules, formality);
    const bot = await store.updateChatbot(existing.id, data);
    await logEvent({ level: 'info', source: 'admin', message: `Configuración actualizada (${Object.keys(data).join(', ')})`, accountId: existing.account_id, chatbotId: existing.id });
    return bot;
  });

  api.delete('/api/chatbots/:id', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    const imgs = await store.listImages(bot.id);
    await store.deleteChatbot(bot.id);
    for (const i of imgs) await fsp.rm(imageAbsolutePath(i), { force: true });
    await logEvent({ level: 'warn', source: 'admin', message: `Chatbot eliminado: ${bot.name}`, accountId: bot.account_id });
    return { ok: true };
  });

  /** Duplica un chatbot (configuración, conocimiento e imágenes), opcionalmente en otra cuenta. */
  api.post('/api/chatbots/:id/duplicate', admins, async (req: any) => {
    const src = await botFor(req.user, req.params.id);
    const { account_id } = parse(z.object({ account_id: z.string().uuid().optional() }), req.body);
    const accountId = await targetAccount(req.user, account_id ?? src.account_id);
    const copy = await store.createChatbot(accountId, {
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
    return copy;
  });

  /* ------------------------------ Conocimiento ------------------------------ */
  const knowledgeFor = async (user: User, id: string) => {
    const k = await store.getKnowledge(id);
    if (!k) throw notFound();
    await botFor(user, k.chatbot_id);
    return k;
  };

  api.get('/api/chatbots/:id/knowledge', admins, async (req: any) => store.listKnowledge((await botFor(req.user, req.params.id)).id));
  api.get('/api/chatbots/:id/knowledge/index', admins, async (req: any) => knowledgeIndexStatus(await botFor(req.user, req.params.id)));
  api.post('/api/chatbots/:id/knowledge/index', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    if (!config.knowledgeSearch.enabled) throw new HttpError(400, 'Activa KNOWLEDGE_SEARCH_ENABLED para indexar conocimiento.');
    const status = await knowledgeIndexStatus(bot);
    if (!status.available) throw new HttpError(400, 'Instala la extensión pgvector y reinicia el backend.');
    await indexKnowledge(bot, new OpenAiProvider());
    return knowledgeIndexStatus(bot);
  });

  api.post('/api/chatbots/:id/knowledge', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    const b = parse(KnowledgeBody, req.body);
    if (!b.title) throw new HttpError(400, 'El título es obligatorio');
    return store.upsertKnowledge(bot.id, b);
  });

  api.put('/api/knowledge/:kid', admins, async (req: any) => {
    const k = await knowledgeFor(req.user, req.params.kid);
    return store.upsertKnowledge(k.chatbot_id, { ...parse(KnowledgeBody, req.body), id: k.id });
  });

  api.delete('/api/knowledge/:kid', admins, async (req: any) => {
    const k = await knowledgeFor(req.user, req.params.kid);
    await store.deleteKnowledge(k.id);
    return { ok: true };
  });

  /* ------------------------------- Imágenes ------------------------------- */
  const imageFor = async (user: User, id: string) => {
    const img = await store.getImage(id);
    if (!img) throw notFound('Imagen no encontrada');
    const bot = await store.getChatbot(img.chatbot_id);
    assertAccount(user, bot, 'Imagen no encontrada');
    return img;
  };

  // Los agentes también la consultan (para enviar fotos a mano desde una conversación); editar es solo de administradores.
  api.get('/api/chatbots/:id/images', async (req: any) => store.listImages((await botFor(req.user, req.params.id)).id));

  api.post('/api/chatbots/:id/images', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    const upload = await readUpload(req);
    const meta = parse(ImageMeta, upload.fields);
    if (!meta.code || !meta.name) throw new HttpError(400, 'El ID y el nombre son obligatorios');
    if (!upload.file) throw new HttpError(400, 'Falta el archivo de imagen');
    const rel = await saveFile(bot.id, upload.file);
    try {
      const img = await store.insertImage({
        chatbot_id: bot.id,
        code: meta.code,
        name: meta.name,
        description: meta.description ?? '',
        usage_rule: meta.usage_rule ?? '',
        caption: meta.caption ?? '',
        file_path: rel,
        mime_type: upload.file.mime,
        size_bytes: upload.file.buffer.length,
        active: meta.active ?? true,
        send_when: meta.send_when ?? {},
      });
      await logEvent({ level: 'info', source: 'admin', message: `Imagen agregada: ${img.code}`, accountId: bot.account_id, chatbotId: bot.id });
      return img;
    } catch (e) {
      await fsp.rm(path.join(config.uploadsDir, rel), { force: true });
      throw e;
    }
  });

  api.put('/api/images/:iid', admins, async (req: any) => {
    const img = await imageFor(req.user, req.params.iid);
    let fields: Record<string, unknown> = req.body ?? {};
    let file: UploadFile | undefined;
    if (req.isMultipart()) ({ fields, file } = await readUpload(req));
    const patch: Record<string, unknown> = { ...parse(ImageMeta, fields) };
    if (file) {
      patch.file_path = await saveFile(img.chatbot_id, file);
      patch.mime_type = file.mime;
      patch.size_bytes = file.buffer.length;
    }
    const updated = await store.updateImage(img.id, patch);
    if (file) await fsp.rm(imageAbsolutePath(img), { force: true });
    return updated;
  });

  api.delete('/api/images/:iid', admins, async (req: any) => {
    const img = await imageFor(req.user, req.params.iid);
    await store.deleteImage(img.id);
    await fsp.rm(imageAbsolutePath(img), { force: true });
    return { ok: true };
  });

  // Los agentes también ven las imágenes (aparecen en las conversaciones).
  api.get('/api/images/:iid/file', async (req: any, reply) => {
    const img = await imageFor(req.user, req.params.iid);
    const p = imageAbsolutePath(img);
    if (!fs.existsSync(p)) throw notFound();
    reply.header('content-type', img.mime_type).header('cache-control', 'private, max-age=300');
    return reply.send(fs.createReadStream(p));
  });

  /* ------------------------------- Simulador ------------------------------- */
  const session = (s: unknown) => String(s || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default';

  api.post('/api/chatbots/:id/playground', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    const { session: sid, text } = (req.body ?? {}) as { session?: string; text?: string };
    if (!text?.trim()) throw new HttpError(400, 'Escribe un mensaje');
    return service.playground(bot, session(sid), text.trim().slice(0, 4000));
  });

  // Probador de palabras: qué reglas, activadores y desactivadores se dispararían, sin IA y sin enviar nada.
  const TestMessageBody = z.object({
    text: z.string().trim().min(1, 'Escribe un mensaje').max(4000),
    first_message: z.boolean().default(false),
    channel_type: z.string().max(20).default('whatsapp'),
    agent: z.enum(['on', 'paused', 'waiting']).optional(),
    tags: z.array(z.string().max(60)).max(20).default([]),
  });
  api.post('/api/chatbots/:id/test-message', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    const b = parse(TestMessageBody, req.body);
    const agent = b.agent ?? (bot.rules.activation.mode === 'keywords' ? 'waiting' : 'on');
    return service.automator.testMessage(bot, { text: b.text, firstMessage: b.first_message, channelType: b.channel_type, agent, tags: b.tags });
  });

  api.get('/api/chatbots/:id/playground/:session', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    return { messages: await service.playgroundMessages(bot, session(req.params.session)) };
  });

  api.delete('/api/chatbots/:id/playground/:session', admins, async (req: any) => {
    const bot = await botFor(req.user, req.params.id);
    await service.resetPlayground(bot, session(req.params.session));
    return { ok: true };
  });
}
