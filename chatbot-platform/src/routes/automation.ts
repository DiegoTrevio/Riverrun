import { NoticeBody, sendNotice } from '../automation/notices.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, conversationFor, HttpError, notFound, requireRole, scopeAccount, targetAccount } from '../access.js';
import * as astore from '../automation/store.js';
import { AccountSettingsSchema, AutomationBodySchema, SequenceBodySchema, type Action, type AutomationBody } from '../automation/types.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { User } from '../types.js';
import { parse } from './util.js';

/** Todo lo que una regla referencia debe ser de la misma cuenta. */
async function checkReferences(accountId: string, body: { chatbot_id?: string | null; actions?: Action[]; steps?: { image_id: string }[] }) {
  if (body.chatbot_id) {
    const bot = await store.getChatbot(body.chatbot_id);
    if (!bot || bot.account_id !== accountId) throw new HttpError(400, 'El chatbot no pertenece a la cuenta');
  }
  const images = [...(body.actions ?? []).flatMap((a) => (a.type === 'send_message' && a.image_id ? [a.image_id] : [])), ...(body.steps ?? []).map((s) => s.image_id).filter(Boolean)];
  for (const id of images) {
    const img = await store.getImage(id);
    const owner = img ? await store.getChatbot(img.chatbot_id) : null;
    if (!owner || owner.account_id !== accountId) throw new HttpError(400, 'Una imagen no pertenece a la cuenta');
  }
  for (const a of body.actions ?? []) {
    if (a.type === 'start_sequence') {
      const seq = await astore.getSequence(a.sequence_id);
      if (!seq || seq.account_id !== accountId) throw new HttpError(400, 'La secuencia no pertenece a la cuenta');
    }
    if (a.type === 'alert_team' && a.user_ids.length) {
      const team = await astore.teamMembers(accountId);
      if (a.user_ids.some((id) => !team.some((u) => u.id === id))) throw new HttpError(400, 'Un usuario no pertenece a la cuenta');
    }
  }
}

const sequenceFor = async (user: User, id: string) => assertAccount(user, await astore.getSequence(id), 'Secuencia no encontrada');
const automationFor = async (user: User, id: string) => assertAccount(user, await astore.getAutomation(id), 'Regla no encontrada');
const campaignFor = async (user: User, id: string) => assertAccount(user, await astore.getCampaign(id), 'Campaña no encontrada');

const CampaignBody = z.object({
  channel_id: z.string().uuid(),
  /** Números adicionales (mismo tipo de canal) desde los que también sale la campaña. */
  channel_ids: z.array(z.string().uuid()).max(10).default([]),
  name: z.string().trim().min(1).max(120),
  message: z.string().max(4000).default(''),
  image_id: z.string().uuid().nullable().default(null),
  audience: z
    .object({
      tags_any: z.array(z.string()).default([]),
      tags_none: z.array(z.string()).default([]),
      active_within_days: z.number().int().min(0).max(3650).default(0),
      statuses: z.array(z.enum(['bot', 'human', 'closed'])).default([]),
    })
    .default({ tags_any: [], tags_none: [], active_within_days: 0, statuses: [] }),
  scheduled_at: z.string().datetime({ offset: true }).nullable().default(null),
  rate_per_minute: z.number().int().min(1).max(120).default(20),
  business_hours_only: z.boolean().default(true),
});

export async function automationRoutes(api: FastifyInstance, service: ChatService) {
  const admins = { preHandler: requireRole('admin') };

  /* ------------------------------ Configuración de la cuenta ------------------------------ */
  api.get('/api/settings', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const s = await astore.getSettings(accountId);
    return { ...s, ics_url: `${config.publicBaseUrl}/calendar/${s.calendar_token}.ics` };
  });

  api.put('/api/settings', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const current = await astore.getSettings(accountId);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    // Los secretos no se cambian desde aquí (se regeneran con su propia ruta).
    const next = parse(AccountSettingsSchema, { ...current, ...raw, calendar_token: current.calendar_token, webhook_secret: current.webhook_secret });
    await astore.saveSettings(accountId, next);
    await logEvent({ level: 'info', source: 'admin', message: 'Configuración de la cuenta actualizada', accountId });
    return { ...next, ics_url: `${config.publicBaseUrl}/calendar/${next.calendar_token}.ics` };
  });

  api.post('/api/settings/rotate-secrets', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const s = await astore.getSettings(accountId);
    await astore.saveSettings(accountId, { ...s, calendar_token: '', webhook_secret: '' });
    const fresh = await astore.getSettings(accountId);
    return { ...fresh, ics_url: `${config.publicBaseUrl}/calendar/${fresh.calendar_token}.ics` };
  });

  /* ------------------------------ Reglas ------------------------------ */
  api.get('/api/automations', admins, async (req: any) => astore.listAutomations(scopeAccount(req.user, req.query.account_id)));

  api.post('/api/automations', admins, async (req: any) => {
    const body = parse(AutomationBodySchema, req.body);
    const accountId = await targetAccount(req.user, req.body?.account_id);
    await checkReferences(accountId, body);
    return astore.saveAutomation(accountId, body);
  });

  api.put('/api/automations/:id', admins, async (req: any) => {
    const existing = await automationFor(req.user, req.params.id);
    const raw = (req.body ?? {}) as Partial<AutomationBody>;
    const body = parse(AutomationBodySchema, { ...existing, ...raw });
    await checkReferences(existing.account_id, body);
    return astore.saveAutomation(existing.account_id, body, existing.id);
  });

  api.delete('/api/automations/:id', admins, async (req: any) => {
    const a = await automationFor(req.user, req.params.id);
    await astore.deleteAutomation(a.id);
    await astore.cancelJobs('automation_id', a.id);
    return { ok: true };
  });

  /* ------------------------------ Secuencias ------------------------------ */
  api.get('/api/sequences', async (req: any) => {
    const list = await astore.listSequences(scopeAccount(req.user, req.query.account_id));
    const counts = await query<{ sequence_id: string; status: string; n: number }>(
      `SELECT sequence_id, status, count(*)::int AS n FROM sequence_enrollments WHERE sequence_id = ANY($1::uuid[]) GROUP BY 1, 2`,
      [list.map((s) => s.id)],
    );
    return list.map((s) => ({ ...s, enrollments: Object.fromEntries(counts.filter((c) => c.sequence_id === s.id).map((c) => [c.status, c.n])) }));
  });

  api.post('/api/sequences', admins, async (req: any) => {
    const body = parse(SequenceBodySchema, req.body);
    const accountId = await targetAccount(req.user, req.body?.account_id);
    await checkReferences(accountId, body);
    return astore.saveSequence(accountId, body);
  });

  api.put('/api/sequences/:id', admins, async (req: any) => {
    const existing = await sequenceFor(req.user, req.params.id);
    const body = parse(SequenceBodySchema, { ...existing, ...(req.body ?? {}) });
    await checkReferences(existing.account_id, body);
    return astore.saveSequence(existing.account_id, body, existing.id);
  });

  api.delete('/api/sequences/:id', admins, async (req: any) => {
    const seq = await sequenceFor(req.user, req.params.id);
    const active = await query<{ id: string }>(`SELECT id FROM sequence_enrollments WHERE sequence_id = $1 AND status = 'active'`, [seq.id]);
    for (const e of active) await astore.cancelJobs('enrollment_id', e.id);
    await astore.deleteSequence(seq.id);
    return { ok: true };
  });

  /* ------------------------------ Automatización por conversación (también agentes) ------------------------------ */
  api.get('/api/conversations/:cid/automation', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const [enrollments, jobs, appointments] = await Promise.all([
      astore.listEnrollments(conv.id),
      astore.listJobs(conv.account_id, conv.id),
      astore.listAppointments(conv.account_id, { contactId: conv.contact_id }),
    ]);
    return { enrollments, jobs, appointments };
  });

  api.post('/api/conversations/:cid/sequences', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const { sequence_id } = parse(z.object({ sequence_id: z.string().uuid() }), req.body);
    await sequenceFor(req.user, sequence_id);
    try {
      const e = await service.automator.enroll(sequence_id, conv.id, `panel: ${req.user.email}`);
      if (!e) throw new HttpError(409, 'Ya está inscrito en esa secuencia');
      return e;
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.delete('/api/conversations/:cid/sequences/:sid', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const n = await astore.stopEnrollments(conv.id, `detenida por ${req.user.email}`, req.params.sid);
    return { stopped: n };
  });

  /* ------------------------------ Campañas ------------------------------ */
  const checkChannel = async (user: User, accountId: string, channelId: string, imageId: string | null, extraIds: string[] = []) => {
    const ch = await store.getChannel(channelId);
    if (!ch || ch.account_id !== accountId || ch.type === 'playground') throw new HttpError(400, 'El canal no pertenece a la cuenta');
    for (const extra of extraIds) {
      const e = await store.getChannel(extra);
      if (!e || e.account_id !== accountId || e.type !== ch.type) throw new HttpError(400, 'Los números adicionales deben ser canales de la cuenta del mismo tipo (p. ej. otros WhatsApp)');
    }
    if (imageId) await checkReferences(accountId, { steps: [{ image_id: imageId }] });
    void user;
    return ch;
  };

  api.get('/api/campaigns', admins, async (req: any) => astore.listCampaigns(scopeAccount(req.user, req.query.account_id)));

  api.post('/api/campaigns', admins, async (req: any) => {
    const b = parse(CampaignBody, req.body);
    const accountId = await targetAccount(req.user, req.body?.account_id);
    b.channel_ids = [...new Set(b.channel_ids)].filter((x) => x !== b.channel_id);
    await checkChannel(req.user, accountId, b.channel_id, b.image_id, b.channel_ids);
    return astore.saveCampaign(accountId, { ...b, scheduled_at: b.scheduled_at ? new Date(b.scheduled_at) : null });
  });

  api.put('/api/campaigns/:id', admins, async (req: any) => {
    const c = await campaignFor(req.user, req.params.id);
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(400, 'Solo se editan campañas en borrador o programadas');
    const b = parse(CampaignBody, { ...c, scheduled_at: c.scheduled_at ? new Date(c.scheduled_at).toISOString() : null, ...(req.body ?? {}) });
    b.channel_ids = [...new Set(b.channel_ids)].filter((x) => x !== b.channel_id);
    await checkChannel(req.user, c.account_id, b.channel_id, b.image_id, b.channel_ids);
    const saved = await astore.saveCampaign(c.account_id, { ...b, scheduled_at: b.scheduled_at ? new Date(b.scheduled_at) : null }, c.id);
    if (c.status === 'scheduled') {
      // Reprogramar con los datos nuevos.
      await astore.cancelJobs('campaign_id', c.id);
      await astore.setCampaignStatus(c.id, 'draft');
      await service.campaigns.launch(c.id);
    }
    return saved;
  });

  api.delete('/api/campaigns/:id', admins, async (req: any) => {
    const c = await campaignFor(req.user, req.params.id);
    if (c.status === 'sending') throw new HttpError(400, 'Cancela la campaña antes de eliminarla');
    await astore.cancelJobs('campaign_id', c.id);
    await astore.deleteCampaign(c.id);
    return { ok: true };
  });

  api.post('/api/campaigns/:id/preview', admins, async (req: any) => {
    const c = await campaignFor(req.user, req.params.id);
    const settings = await astore.getSettings(c.account_id);
    const requireConsent = settings.consent.require_for_campaigns;
    const audience = await astore.campaignAudience(c, 100000, { requireConsent });
    const ch = await store.getChannel(c.channel_id);
    return {
      count: audience.length,
      excluded_no_consent: requireConsent ? await astore.campaignExcludedNoConsent(c) : 0,
      sample: audience.slice(0, 10).map((a) => a.name || a.push_name || (a.phone ? `+${a.phone}` : 'Cliente')),
      warning:
        ch?.type === 'messenger' || ch?.type === 'instagram'
          ? 'Meta solo permite escribir a quienes enviaron un mensaje en las últimas 24 horas; el resto se omitirá.'
          : ch?.type === 'whatsapp'
            ? 'Envía solo a clientes que esperan saber de ti y con ritmo moderado: WhatsApp puede bloquear números que envían mensajes masivos no deseados.'
            : null,
    };
  });

  api.post('/api/campaigns/:id/launch', admins, async (req: any) => {
    const c = await campaignFor(req.user, req.params.id);
    try {
      const r = await service.campaigns.launch(c.id);
      await logEvent({ level: 'info', source: 'admin', message: `Campaña "${c.name}" ${r.status === 'scheduled' ? 'programada' : 'iniciada'} por ${req.user.email}`, accountId: c.account_id });
      return r;
    } catch (e: any) {
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.post('/api/campaigns/:id/cancel', admins, async (req: any) => {
    const c = await campaignFor(req.user, req.params.id);
    await service.campaigns.cancel(c.id);
    return astore.getCampaign(c.id);
  });

  api.get('/api/campaigns/:id/recipients', admins, async (req: any) => {
    const c = await campaignFor(req.user, req.params.id);
    return query(
      `SELECT r.*, ct.name, ct.push_name, ct.phone FROM campaign_recipients r
         JOIN conversations cv ON cv.id = r.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
       WHERE r.campaign_id = $1 ORDER BY r.sent_at NULLS LAST LIMIT 1000`,
      [c.id],
    );
  });

  /* ------------------------------ Notificaciones (todos los roles) ------------------------------ */
  api.get('/api/notifications', async (req: any) => {
    const [items, unread] = await Promise.all([astore.listNotifications(req.user.id, Math.min(Number(req.query.limit) || 50, 200), scopeAccount(req.user)), astore.unreadCount(req.user.id, scopeAccount(req.user))]);
    return { unread, items };
  });

  api.post('/api/notifications/read', async (req: any) => {
    const { ids } = parse(z.object({ ids: z.array(z.number().int()).optional() }), req.body);
    await astore.markNotificationsRead(req.user.id, ids, scopeAccount(req.user));
    return { ok: true };
  });

  /** Aviso interno manual (a todo el equipo, a un rol, a personas o por turnos). Solo administradores. */
  api.post('/api/notifications/send', { preHandler: requireRole('admin') }, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    const b = parse(NoticeBody, req.body);
    const r = await sendNotice(service, accountId, b);
    await logEvent({ level: 'info', source: 'admin', message: `Aviso interno enviado por ${req.user.email} a ${r.recipients.length} persona(s)${b.round_robin ? ' (por turnos)' : ''}`, accountId });
    return { ok: true, sent_to: r.recipients.length, recipients: r.recipients };
  });

  void notFound;
}
