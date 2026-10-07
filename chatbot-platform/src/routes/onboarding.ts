/**
 * Asistente de configuración: la empresa que se registró deja su bot funcionando sin ayuda.
 * Pasos: negocio → asistente (con importación automática) → prueba (con fotos opcionales) → WhatsApp.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import * as astore from '../automation/store.js';
import { AccountSettingsSchema, WeeklyHoursSchema } from '../automation/types.js';
import { mergeChannelConfig, publicChannel } from '../channels/index.js';
import { newInstanceName } from '../channels/whatsapp.js';
import { config } from '../config.js';
import { queryOne } from '../db.js';
import { assertWithinLimit } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { alignFixedMessages, BUSINESS_TYPES, chatbotFromTemplate } from '../templates/business.js';
import { DataFieldSchema, FlowSchema, PersonalitySchema, RulesSchema, type User } from '../types.js';
import { sendVerification } from './signup.js';
import { parse } from './util.js';

export const ONBOARDING_STEPS = ['business', 'assistant', 'photos', 'test', 'whatsapp'] as const;

/** Las cuentas del autoregistro deben confirmar su correo antes de conectar canales reales. */
export function assertVerified(user: User) {
  if (user.role === 'superadmin' || user.email_verified_at || !config.signup.requireEmail) return;
  throw new HttpError(403, 'Confirma tu correo para conectar canales: revisa tu bandeja o pide un nuevo enlace desde Inicio.');
}

/** Bot principal de la cuenta (el más antiguo): el que crea y edita el asistente. */
const mainBot = (accountId: string) => queryOne<{ id: string }>(`SELECT id FROM chatbots WHERE account_id = $1 ORDER BY created_at LIMIT 1`, [accountId]);

export const KNOWLEDGE_TITLES = {
  catalog: ['precios', 'Productos, servicios y precios'],
  hours: ['horarios', 'Horarios'],
  location: ['ubicaciones', 'Ubicación y contacto'],
  faq: ['preguntas_frecuentes', 'Preguntas frecuentes'],
  other: ['general', 'Otra información'],
} as const;

export async function onboardingRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  /** Estado del asistente: pasos hechos y lo necesario para continuar. */
  api.get('/api/onboarding', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const acc = (await store.getAccount(accountId))!;
    const bot = await mainBot(accountId);
    const [knowledge, images, wa] = await Promise.all([
      bot ? store.listKnowledge(bot.id) : [],
      bot ? store.listImages(bot.id) : [],
      queryOne<{ id: string }>(`SELECT id FROM channels WHERE account_id = $1 AND type = 'whatsapp' ORDER BY created_at LIMIT 1`, [accountId]),
    ]);
    const done = {
      business: !!acc.onboarding.business,
      assistant: !!bot && knowledge.length > 0,
      photos: images.length > 0 || !!acc.onboarding.photos,
      test: !!acc.onboarding.test,
      whatsapp: !!acc.onboarding.whatsapp,
    };
    // Las fotos son opcionales: no bloquean terminar la configuración.
    const complete = ONBOARDING_STEPS.filter((s) => s !== 'photos').every((s) => done[s]);
    if (complete && !acc.onboarding.done) await store.markOnboarding(accountId, { done: true });
    const settings = await astore.getSettings(accountId);
    const answers = bot ? await store.getChatbot(bot.id) : null;
    return {
      account: acc,
      email_verified: !!req.user.email_verified_at || req.user.role === 'superadmin' || !config.signup.requireEmail,
      steps: done,
      complete,
      chatbot_id: bot?.id ?? null,
      whatsapp_channel_id: wa?.id ?? null,
      business_types: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })),
      business: { timezone: settings.timezone, business_hours: settings.business_hours, alert_phone: req.user.phone ?? '' },
      assistant: answers
        ? {
            assistant_name: answers.personality.assistant_name,
            formality: answers.personality.formality,
            knowledge: Object.fromEntries(
              Object.entries(KNOWLEDGE_TITLES).map(([k, [, title]]) => [k, knowledge.find((i) => i.title === title)?.content ?? '']),
            ),
          }
        : null,
      support_contact: config.signup.supportContact,
    };
  });

  /** Paso 1: zona horaria, horario y teléfono para avisos. */
  api.post('/api/onboarding/business', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const b = parse(
      z.object({
        timezone: z.string().max(60).default('America/Mexico_City'),
        business_hours: WeeklyHoursSchema.optional(),
        alert_phone: z.string().max(30).default(''),
        business_type: z.string().max(40).optional(),
      }),
      req.body,
    );
    try {
      new Intl.DateTimeFormat('es-MX', { timeZone: b.timezone });
    } catch {
      throw new HttpError(400, 'Zona horaria inválida');
    }
    const current = await astore.getSettings(accountId);
    await astore.saveSettings(accountId, AccountSettingsSchema.parse({ ...current, timezone: b.timezone, business_hours: b.business_hours ?? current.business_hours }));
    const phone = b.alert_phone.replace(/\D/g, '');
    if (req.user.account_id === accountId) await store.updateUser(req.user.id, { phone, notify_whatsapp: !!phone });
    if (b.business_type && BUSINESS_TYPES.some((t) => t.key === b.business_type)) await store.updateAccount(accountId, { business_type: b.business_type });
    await store.markOnboarding(accountId, { business: true });
    return { ok: true };
  });

  /** Paso 2: crea (o actualiza) el chatbot a partir de la plantilla del giro y la información del negocio. */
  api.post('/api/onboarding/assistant', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const acc = (await store.getAccount(accountId))!;
    const text = z.string().max(20000).default('');
    const b = parse(
      z.object({
        business_type: z.string().max(40).optional(),
        assistant_name: z.string().trim().max(60).default(''),
        formality: z.enum(['tu', 'usted']).optional(),
        description: z.string().max(2000).default(''),
        knowledge: z.object({ catalog: text, hours: text, location: text, faq: text, other: text }).partial().default({}),
      }),
      req.body,
    );
    const filled = Object.values(b.knowledge).filter((v) => v && v.trim()).length;
    if (!b.knowledge.catalog?.trim() && filled < 2) throw new HttpError(400, 'Escribe al menos tus productos o servicios con precios: el asistente solo responde con lo que le des.');
    const businessType = b.business_type ?? (acc.business_type || 'otro');
    const tpl = chatbotFromTemplate({ business_type: businessType, company: acc.name, assistant_name: b.assistant_name, description: b.description, formality: b.formality });

    const existing = await mainBot(accountId);
    let botId: string;
    if (existing) {
      const bot = (await store.getChatbot(existing.id))!;
      await store.updateChatbot(bot.id, {
        personality: PersonalitySchema.parse({ ...bot.personality, ...tpl.personality }),
        flow: bot.flow.goal ? bot.flow : FlowSchema.parse({ ...bot.flow, ...tpl.flow }),
        rules: alignFixedMessages(
          bot.rules.custom_rules.length ? bot.rules : RulesSchema.parse({ ...bot.rules, ...tpl.rules }),
          tpl.personality.formality ?? 'tu',
        ),
        data_fields: bot.data_fields.length ? bot.data_fields : tpl.data_fields.map((f) => DataFieldSchema.parse(f)),
      });
      botId = bot.id;
    } else {
      await assertWithinLimit(accountId, 'chatbots');
      const bot = await store.createChatbot(accountId, {
        name: tpl.name,
        active: true,
        personality: PersonalitySchema.parse(tpl.personality),
        rules: RulesSchema.parse(tpl.rules),
        flow: FlowSchema.parse(tpl.flow),
        data_fields: tpl.data_fields.map((f) => DataFieldSchema.parse(f)),
      });
      botId = bot.id;
      await logEvent({ level: 'info', source: 'admin', message: `Chatbot creado con el asistente (${businessType})`, accountId, chatbotId: bot.id });
    }

    const items = await store.listKnowledge(botId);
    for (const [k, [category, title]] of Object.entries(KNOWLEDGE_TITLES)) {
      const content = (b.knowledge as Record<string, string | undefined>)[k]?.trim();
      const prev = items.find((i) => i.title === title);
      if (content) await store.upsertKnowledge(botId, { id: prev?.id, category, title, content, active: true, always_include: k !== 'faq' });
      else if (prev) await store.upsertKnowledge(botId, { id: prev.id, category, title, content: prev.content, active: false });
    }
    if (businessType !== acc.business_type) await store.updateAccount(accountId, { business_type: businessType });
    await store.markOnboarding(accountId, { assistant: true });
    return { ok: true, chatbot_id: botId };
  });

  /** Pasos que se marcan a mano: fotos (omitido) y prueba en el simulador. */
  api.post('/api/onboarding/step', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const { step } = parse(z.object({ step: z.enum(['photos', 'test']) }), req.body);
    await store.markOnboarding(accountId, { [step]: true });
    return { ok: true };
  });

  /** Paso 5: crea (o reutiliza) el canal de WhatsApp de la cuenta, ya con su bot. El QR se pide con /whatsapp/connect. */
  api.post('/api/onboarding/whatsapp', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    assertVerified(req.user);
    const bot = await mainBot(accountId);
    if (!bot) throw new HttpError(400, 'Primero configura tu asistente');
    const existing = (await store.listChannels(accountId)).find((c) => c.type === 'whatsapp');
    if (existing) {
      const updated = existing.chatbot_id ? existing : (await store.updateChannel(existing.id, { chatbot_id: bot.id }))!;
      return publicChannel(updated);
    }
    await assertWithinLimit(accountId, 'channels');
    const ch = await store.createChannel({
      account_id: accountId,
      chatbot_id: bot.id,
      type: 'whatsapp',
      name: 'WhatsApp',
      active: true,
      config: mergeChannelConfig('whatsapp', {}, { instance: newInstanceName(accountId) }),
    });
    await logEvent({ level: 'info', source: 'admin', message: 'Canal de WhatsApp creado con el asistente', accountId, channelId: ch.id });
    return publicChannel(ch);
  });

  /** Reenvía el correo de confirmación al usuario actual. */
  api.post('/api/me/resend-verification', async (req: any, reply) => {
    if (req.user.email_verified_at) return { ok: true, already: true };
    const last = await queryOne<{ created_at: Date }>(`SELECT created_at FROM auth_tokens WHERE user_id = $1 AND kind = 'verify_email' ORDER BY id DESC LIMIT 1`, [req.user.id]);
    if (last && Date.now() - new Date(last.created_at).getTime() < 60_000) return reply.code(429).send({ error: 'Espera un minuto antes de pedir otro correo' });
    await sendVerification(req.user);
    return { ok: true };
  });
}
