import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { botFor, channelFor, HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { adapterFor, mergeChannelConfig, publicChannel, webhookUrl } from '../channels/index.js';
import { evolutionFor, newInstanceName, releaseWhatsapp } from '../channels/whatsapp.js';
import { SessionError, whatsappSession } from '../channels/whatsapp-session.js';
import { zernioAuthUrl } from '../channels/zernio.js';
import { config } from '../config.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { CHANNEL_TYPES, type Channel, type User } from '../types.js';
import { assertVerified } from './onboarding.js';
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

/** Campos de infraestructura de WhatsApp: solo el superadmin los define (el cliente no elige servidor, llave ni instancia). */
const INFRA_FIELDS = ['url', 'api_key', 'instance', 'profile_name'];

function clientConfig(user: User, type: string, cfg: Record<string, unknown> | undefined) {
  if (!cfg || type !== 'whatsapp' || user.role === 'superadmin') return cfg;
  // El formulario reenvía la configuración completa: estos campos se ignoran en silencio.
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => !INFRA_FIELDS.includes(k)));
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
    const given = clientConfig(req.user, b.type, b.config) ?? {};
    if (b.type === 'whatsapp' && !given.instance) given.instance = newInstanceName(accountId);
    let cfg: Record<string, unknown>;
    try {
      cfg = mergeChannelConfig(b.type, adapter.initialConfig?.() ?? {}, given);
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
    const given = clientConfig(req.user, ch.type, b.config);
    let cfg: Record<string, unknown> | undefined;
    if (given) {
      try {
        cfg = mergeChannelConfig(ch.type, ch.config, given);
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
    await releaseWhatsapp(ch);
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
    if (adapter.setup) assertVerified(req.user);
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

  /** Zernio: genera el estado de un solo uso y devuelve la URL donde el usuario autoriza su cuenta. */
  api.post('/api/channels/:id/zernio/connect', admins, async (req: any) => {
    assertVerified(req.user);
    const ch = await channelFor(req.user, req.params.id);
    if (ch.type !== 'zernio') throw new HttpError(400, 'Este canal no es de Zernio');
    if (!config.publicBaseUrl.startsWith('https://')) throw new HttpError(400, 'Zernio exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)');
    const state = crypto.randomBytes(24).toString('base64url');
    const saved = (await store.updateChannel(ch.id, { config: mergeChannelConfig('zernio', ch.config, { connect_state: state }) }))!;
    try {
      const authUrl = await zernioAuthUrl(saved, `${config.publicBaseUrl}/zernio/callback/${saved.webhook_token}/${state}`);
      return { authUrl };
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo iniciar la conexión: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.get('/api/channels/:id/status', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    const adapter = adapterFor(ch.type);
    if (!adapter.status) return { state: 'unknown' };
    try {
      const st = await adapter.status(ch);
      if (ch.type === 'whatsapp' && st.state && st.state !== 'not_configured') await recordConnectionState(ch, st.state);
      return st;
    } catch (e: any) {
      return { state: 'error', details: { error: e?.message ?? String(e) } };
    }
  });

  /* ------------------------------ WhatsApp (Evolution) ------------------------------ */
  const whatsapp = async (user: User, id: string) => {
    const ch = await channelFor(user, id);
    if (ch.type !== 'whatsapp') throw new HttpError(400, 'Este canal no es de WhatsApp');
    if (ch.config.instance) return ch;
    // Canales anteriores sin instancia: se le asigna una generada.
    return (await store.updateChannel(ch.id, { config: mergeChannelConfig('whatsapp', ch.config, { instance: newInstanceName(ch.account_id) }) }))!;
  };

  /** Crea la instancia si no existe, configura el webhook y devuelve el QR. */
  api.post('/api/channels/:id/whatsapp/connect', admins, async (req: any) => {
    assertVerified(req.user);
    const ch = await whatsapp(req.user, req.params.id);
    try {
      return await whatsappSession(ch, { mode: 'qr' });
    } catch (e: any) {
      if (e instanceof SessionError) throw new HttpError(400, e.message);
      throw e;
    }
  });

  /**
   * Sesión de conexión (el panel la consulta cada pocos segundos): crea la instancia si hace falta y
   * devuelve un QR vigente o el código para vincular con número; al conectar, el número vinculado.
   */
  api.post('/api/channels/:id/whatsapp/session', admins, async (req: any) => {
    assertVerified(req.user);
    const ch = await whatsapp(req.user, req.params.id);
    const b = parse(z.object({ mode: z.enum(['qr', 'code']).default('qr'), number: z.string().max(30).optional(), refresh: z.boolean().default(false) }), req.body ?? {});
    try {
      return await whatsappSession(ch, b);
    } catch (e: any) {
      if (e instanceof SessionError) throw new HttpError(400, e.message);
      throw e;
    }
  });

  api.post('/api/channels/:id/whatsapp/logout', admins, async (req: any) => {
    const ch = await whatsapp(req.user, req.params.id);
    await evolutionFor(ch).logout(ch.config.instance).catch((e) => {
      throw new HttpError(400, e?.message ?? String(e));
    });
    await store.clearConnectionCodes(ch.id);
    await store.setConnectionStateQuiet(ch.id, 'close'); // desconexión a propósito: sin alerta
    return { ok: true };
  });

  api.post('/api/channels/:id/whatsapp/test', admins, async (req: any) => {
    assertVerified(req.user);
    const ch = await whatsapp(req.user, req.params.id);
    const { number, text } = parse(z.object({ number: z.string().min(8), text: z.string().max(1000).default('Mensaje de prueba ✅') }), req.body);
    await evolutionFor(ch).sendText(ch.config.instance, number.replace(/\D/g, ''), text).catch((e) => {
      throw new HttpError(400, e?.message ?? String(e));
    });
    return { ok: true };
  });
}
