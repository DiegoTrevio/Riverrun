import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { botFor, channelFor, HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { adapterFor, mergeChannelConfig, publicChannel, webhookUrl } from '../channels/index.js';
import { evolutionFor } from '../channels/whatsapp.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { CHANNEL_TYPES, type Channel, type User } from '../types.js';
import { parse } from './util.js';

const ChannelBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
  chatbot_id: z.string().uuid().nullable().optional(),
  config: z.record(z.string(), z.any()).optional(),
});

/** El chatbot asignado debe ser de la misma cuenta que el canal. */
async function checkBot(user: User, accountId: string, chatbotId: string | null | undefined) {
  if (!chatbotId) return;
  const bot = await botFor(user, chatbotId);
  if (bot.account_id !== accountId) throw new HttpError(400, 'El chatbot pertenece a otra cuenta');
}

function configError(e: any): never {
  if (e?.issues) throw new HttpError(400, 'Configuración inválida', e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`));
  throw e;
}

export async function channelRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  api.get('/api/channels', async (req: any) => {
    const channels = await store.listChannels(scopeAccount(req.user, req.query.account_id), { chatbotId: req.query.chatbot_id });
    if (req.user.role === 'agent') return channels.map(({ id, account_id, chatbot_id, type, name, active }) => ({ id, account_id, chatbot_id, type, name, active }));
    return channels.map(publicChannel);
  });

  api.post('/api/channels', admins, async (req: any) => {
    const b = parse(ChannelBody.extend({ type: z.enum(CHANNEL_TYPES), account_id: z.string().uuid().optional() }), req.body);
    const accountId = await targetAccount(req.user, b.account_id);
    await checkBot(req.user, accountId, b.chatbot_id);
    const adapter = adapterFor(b.type);
    let cfg: Record<string, unknown>;
    try {
      cfg = mergeChannelConfig(b.type, adapter.initialConfig?.() ?? {}, b.config ?? {});
    } catch (e) {
      configError(e);
    }
    const ch = await store.createChannel({
      account_id: accountId,
      chatbot_id: b.chatbot_id ?? null,
      type: b.type,
      name: b.name ?? adapter.label,
      active: b.active ?? true,
      config: cfg!,
    });
    await logEvent({ level: 'info', source: 'admin', message: `Canal creado: ${ch.name} (${adapter.label})`, accountId, channelId: ch.id });
    return publicChannel(ch);
  });

  api.get('/api/channels/:id', admins, async (req: any) => publicChannel(await channelFor(req.user, req.params.id)));

  api.put('/api/channels/:id', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    const b = parse(ChannelBody, req.body);
    await checkBot(req.user, ch.account_id, b.chatbot_id);
    let cfg: Record<string, unknown> | undefined;
    if (b.config) {
      try {
        cfg = mergeChannelConfig(ch.type, ch.config, b.config);
      } catch (e) {
        configError(e);
      }
    }
    const updated = await store.updateChannel(ch.id, { name: b.name, active: b.active, chatbot_id: b.chatbot_id, config: cfg });
    await logEvent({ level: 'info', source: 'admin', message: `Canal actualizado: ${updated!.name}`, accountId: ch.account_id, channelId: ch.id });
    return publicChannel(updated!);
  });

  api.delete('/api/channels/:id', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    await store.deleteChannel(ch.id);
    await logEvent({ level: 'warn', source: 'admin', message: `Canal eliminado: ${ch.name}`, accountId: ch.account_id });
    return { ok: true };
  });

  api.post('/api/channels/:id/rotate-token', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    await store.rotateChannelToken(ch.id);
    return publicChannel((await store.getChannel(ch.id))!);
  });

  /** Conecta el canal con su plataforma (webhook, validación de credenciales). */
  api.post('/api/channels/:id/setup', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    const adapter = adapterFor(ch.type);
    if (!adapter.setup) return { ok: true, message: 'Este canal no requiere conexión', channel: publicChannel(ch) };
    try {
      const r = await adapter.setup(ch, webhookUrl(ch));
      let updated: Channel = ch;
      if (r.config && Object.keys(r.config).length) updated = (await store.updateChannel(ch.id, { config: mergeChannelConfig(ch.type, ch.config, r.config) }))!;
      await logEvent({ level: r.ok ? 'info' : 'warn', source: 'channel', message: `${adapter.label}: ${r.message}`, accountId: ch.account_id, channelId: ch.id });
      return { ...r, channel: publicChannel(updated) };
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'channel', message: `${adapter.label}: no se pudo conectar: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.get('/api/channels/:id/status', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    const adapter = adapterFor(ch.type);
    if (!adapter.status) return { state: 'unknown' };
    try {
      return await adapter.status(ch);
    } catch (e: any) {
      return { state: 'error', details: { error: e?.message ?? String(e) } };
    }
  });

  /* ------------------------------ WhatsApp (Evolution) ------------------------------ */
  const whatsapp = async (user: User, id: string) => {
    const ch = await channelFor(user, id);
    if (ch.type !== 'whatsapp') throw new HttpError(400, 'Este canal no es de WhatsApp');
    if (!ch.config.instance) throw new HttpError(400, 'Primero define el nombre de la instancia de Evolution');
    return ch;
  };

  /** Crea la instancia si no existe, configura el webhook y devuelve el QR. */
  api.post('/api/channels/:id/whatsapp/connect', admins, async (req: any) => {
    const ch = await whatsapp(req.user, req.params.id);
    const evo = evolutionFor(ch);
    const url = webhookUrl(ch);
    try {
      let state = 'not_found';
      try {
        state = await evo.connectionState(ch.config.instance);
      } catch (e: any) {
        if (e?.status !== 404) throw e;
      }
      if (state === 'not_found') {
        const created = await evo.createInstance(ch.config.instance, url, ch.config.number.replace(/\D/g, '') || undefined);
        await logEvent({ level: 'info', source: 'evolution', message: `Instancia creada: ${ch.config.instance}`, accountId: ch.account_id, channelId: ch.id });
        const qr = created?.qrcode;
        if (qr?.base64) return { state: 'connecting', qr: qr.base64, pairingCode: qr.pairingCode ?? null };
      } else {
        await evo.setWebhook(ch.config.instance, url);
      }
      if (state === 'open') return { state };
      const c = await evo.connect(ch.config.instance);
      return { state: c.state ?? 'connecting', qr: c.base64 ?? null, pairingCode: c.pairingCode ?? null };
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'evolution', message: `Error al conectar WhatsApp: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.post('/api/channels/:id/whatsapp/logout', admins, async (req: any) => {
    const ch = await whatsapp(req.user, req.params.id);
    await evolutionFor(ch).logout(ch.config.instance).catch((e) => {
      throw new HttpError(400, e?.message ?? String(e));
    });
    return { ok: true };
  });

  api.post('/api/channels/:id/whatsapp/test', admins, async (req: any) => {
    const ch = await whatsapp(req.user, req.params.id);
    const { number, text } = parse(z.object({ number: z.string().min(8), text: z.string().max(1000).default('Mensaje de prueba ✅') }), req.body);
    await evolutionFor(ch).sendText(ch.config.instance, number.replace(/\D/g, ''), text).catch((e) => {
      throw new HttpError(400, e?.message ?? String(e));
    });
    return { ok: true };
  });
}
