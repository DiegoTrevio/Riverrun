import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { botFor, channelFor, HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { adapterFor, mergeChannelConfig, publicChannel, webhookUrl } from '../channels/index.js';
import { evolutionFor, newInstanceName, releaseWhatsapp } from '../channels/whatsapp.js';
import { SessionError, whatsappSession } from '../channels/whatsapp-session.js';
import { networkOf, zernioKey } from '../channels/zernio.js';
import { checkTelegram, disconnectZernio, startConnect } from '../channels/zernio-connect.js';
import { config } from '../config.js';
import { query,withTransaction } from '../db.js';
import { coordinated } from '../engine/coordination.js';
import { recordConnectionState, startAgentOnConnect } from '../lifecycle.js';
import { assertWithinLimit } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import { outboundAllowed } from '../outbound-guard.js';
import * as store from '../store/index.js';
import { CHANNEL_TYPES, type Channel, type User } from '../types.js';
import { assertVerified } from './onboarding.js';
import { parse } from './util.js';
import { applyMetaSelection, disconnectMetaChannel, META_NONCE_COOKIE, sessionPages, startMetaConnect } from '../channels/meta-connect.js';

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

/** Redes sociales: el negocio solo elige la red; perfil, cuenta y llave los pone el servidor al conectar. */
const ZERNIO_CLIENT_FIELDS = ['platform'];

/** Perfil y cuenta de Zernio: solo los escribe el servidor al conectar (nadie los puede poner desde el panel). */
const ZERNIO_SERVER_FIELDS = ['profile_id', 'account_id', 'username', 'display_name', 'picture', 'telegram_code', 'connect_state', 'webhook_secret', 'connected'];

function clientConfig(user: User, type: string, cfg: Record<string, unknown> | undefined) {
  if (cfg && type === 'zernio' && user.role === 'superadmin') return Object.fromEntries(Object.entries(cfg).filter(([k]) => !ZERNIO_SERVER_FIELDS.includes(k)));
  if (!cfg || user.role === 'superadmin') return cfg;
  if (type === 'zernio') return Object.fromEntries(Object.entries(cfg).filter(([k]) => ZERNIO_CLIENT_FIELDS.includes(k)));
  if (type !== 'whatsapp') return cfg;
  // El formulario reenvía la configuración completa: estos campos se ignoran en silencio.
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => !INFRA_FIELDS.includes(k)));
}

function configError(e: any): never {
  if (e?.issues) throw new HttpError(400, 'Configuración inválida', e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`));
  throw e;
}

export async function channelRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };
  api.get('/api/channels/:id/receipts',admins,async(req:any)=>{
    const channel=await channelFor(req.user,req.params.id);
    return query(`SELECT id,state,attempts,reason,created_at,run_at FROM inbound_receipts WHERE channel_id=$1 AND state IN ('pending','running','dead') ORDER BY created_at DESC LIMIT 50`,[channel.id]);
  });
  api.post('/api/channels/:id/receipts/:receipt/recover',admins,async(req:any)=>{
    const channel=await channelFor(req.user,req.params.id);
    const id=parse(z.coerce.number().int().positive(),req.params.receipt);
    const body=parse(z.object({action:z.enum(['retry','acknowledge'])}),req.body);
    const row=(await query('SELECT external_id FROM inbound_receipts WHERE id=$1 AND channel_id=$2',[id,channel.id]))[0];
    if(!row) throw new HttpError(404,'Recepción no encontrada.');
    const result=await coordinated(`inbound:${channel.id}:${row.external_id}`,`receipt-review:${id}`,()=>withTransaction(async client=>{
      const receipt=(await client.query('SELECT * FROM inbound_receipts WHERE id=$1 AND channel_id=$2 FOR UPDATE',[id,channel.id])).rows[0];
      if(receipt?.state!=='dead') throw new HttpError(409,'La recepción ya no está pendiente de revisión.');
      if(body.action==='retry') {
        if(receipt.reason!=='receipt_processing') throw new HttpError(409,'Una recepción interrumpida debe revisarse y atenderse a mano.');
        await client.query(`UPDATE inbound_receipts SET state='pending',attempts=0,reason=NULL,run_at=now() WHERE id=$1`,[id]);
      } else await client.query(`UPDATE inbound_receipts SET state='done',payload='{}',reason='reviewed_by_admin' WHERE id=$1`,[id]);
    }));
    if(!result.acquired) throw new HttpError(409,'La recepción todavía está en curso.');
    return {ok:true};
  });

  api.get('/api/channels', async (req: any) => {
    const channels = await store.listChannels(scopeAccount(req.user, req.query.account_id), { chatbotId: req.query.chatbot_id });
    if (req.user.role === 'agent') return channels.map(({ id, account_id, chatbot_id, type, name, active }) => ({ id, account_id, chatbot_id, type, name, active }));
    return channels.map((c) => publicChannel(c, req.user));
  });

  api.post('/api/channels', admins, async (req: any) => {
    const b = parse(ChannelBody.extend({ type: z.enum(CHANNEL_TYPES), account_id: z.string().uuid().optional() }), req.body);
    const accountId = await targetAccount(req.user, b.account_id);
    await checkBot(req.user, accountId, b.chatbot_id);
    await assertWithinLimit(accountId, 'channels');
    const adapter = adapterFor(b.type);
    const given = clientConfig(req.user, b.type, b.config) ?? {};
    if (b.type === 'whatsapp' && !given.instance) given.instance = newInstanceName(accountId);
    if (b.type === 'zernio') {
      if (!networkOf(String(given.platform ?? ''))) throw new HttpError(400, 'Elige la red que quieres conectar');
      if (!zernioKey({ config: given })) throw new HttpError(400, 'Las redes sociales no están activadas en esta instalación (falta ZERNIO_API_KEY)');
    }
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
    return publicChannel(ch, req.user);
  });

  api.get('/api/channels/:id', admins, async (req: any) => publicChannel(await channelFor(req.user, req.params.id), req.user));

  api.put('/api/channels/:id', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    const b = parse(ChannelBody, req.body);
    await checkBot(req.user, ch.account_id, b.chatbot_id);
    const given = clientConfig(req.user, ch.type, b.config);
    if (ch.type === 'zernio' && given?.platform !== undefined && given.platform !== ch.config.platform) {
      if (!networkOf(String(given.platform))) throw new HttpError(400, 'Elige la red que quieres conectar');
      if (ch.config.account_id) throw new HttpError(400, 'Desconecta la cuenta antes de cambiar de red');
    }
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
    // Una conexión que ya estaba conectada y ahora atiende a un agente nuevo lo enciende (si espera su primera conexión).
    if (b.chatbot_id || b.active) {
      await startAgentOnConnect(updated!).catch((e) => logEvent({ level: 'error', source: 'channel', message: `No se pudo encender el agente al conectar: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id }));
    }
    return publicChannel(updated!, req.user);
  });

  api.delete('/api/channels/:id', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    await store.deleteChannel(ch.id);
    await releaseWhatsapp(ch);
    if (ch.type === 'zernio' && ch.config.account_id) {
      const shared = await query(`SELECT 1 FROM channels WHERE type = 'zernio' AND config->>'account_id' = $1 LIMIT 1`, [ch.config.account_id]);
      if (!shared.length) await disconnectZernio(ch);
    }
    await logEvent({ level: 'warn', source: 'admin', message: `Canal eliminado: ${ch.name}`, accountId: ch.account_id });
    return { ok: true };
  });

  api.post('/api/channels/:id/rotate-token', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    await store.rotateChannelToken(ch.id);
    return publicChannel((await store.getChannel(ch.id))!, req.user);
  });

  /** Conecta el canal con su plataforma (webhook, validación de credenciales). */
  api.post('/api/channels/:id/setup', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    const adapter = adapterFor(ch.type);
    if (adapter.setup) assertVerified(req.user);
    if (!adapter.setup) return { ok: true, message: 'Este canal no requiere conexión', channel: publicChannel(ch, req.user) };
    try {
      const r = await adapter.setup(ch, webhookUrl(ch));
      let updated: Channel = ch;
      if (r.config && Object.keys(r.config).length) updated = (await store.updateChannel(ch.id, { config: mergeChannelConfig(ch.type, ch.config, r.config) }))!;
      await logEvent({ level: r.ok ? 'info' : 'warn', source: 'channel', message: `${adapter.label}: ${r.message}`, accountId: ch.account_id, channelId: ch.id });
      return { ...r, channel: publicChannel(updated, req.user) };
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'channel', message: `${adapter.label}: no se pudo conectar: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  /* ------------------------------ Facebook e Instagram con un botón ------------------------------ */
  /** Devuelve la URL de Facebook donde el negocio inicia sesión y elige sus páginas. */
  api.post('/api/meta/connect', admins, async (req: any, reply) => {
    assertVerified(req.user);
    const b = parse(z.object({ account_id: z.string().uuid().optional(), chatbot_id: z.string().uuid().nullable().optional() }), req.body ?? {});
    const accountId = await targetAccount(req.user, b.account_id);
    await checkBot(req.user, accountId, b.chatbot_id);
    try {
      const { url, nonce } = await startMetaConnect(accountId, req.user.id, b.chatbot_id ?? null);
      reply.setCookie(META_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/meta', maxAge: 30 * 60 });
      return { url };
    } catch (e: any) {
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  const metaSession = async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const s = await sessionPages(req.params.id, accountId);
    if (!s) throw new HttpError(404, 'La sesión de Facebook venció. Vuelve a pulsar «Conectar con Facebook».');
    return { accountId, s };
  };
  api.get('/api/meta/sessions/:id', admins, async (req: any) => (await metaSession(req)).s);

  /** Conecta las páginas e Instagram elegidos al agente indicado. */
  api.post('/api/meta/sessions/:id/apply', admins, async (req: any) => {
    const { accountId, s } = await metaSession(req);
    const b = parse(z.object({
      chatbot_id: z.string().uuid().nullable().optional(),
      pages: z.array(z.object({ page_id: z.string().min(1).max(60), messenger: z.boolean().default(false), instagram: z.boolean().default(false) })).min(1).max(50),
    }), req.body);
    const chatbotId = b.chatbot_id === undefined ? s.chatbot_id : b.chatbot_id;
    await checkBot(req.user, accountId, chatbotId);
    try {
      const channels = await applyMetaSelection(req.params.id, accountId, chatbotId ?? null, b.pages);
      return { channels: channels.map((c) => publicChannel(c, req.user)) };
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.post('/api/channels/:id/meta/disconnect', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    if (ch.type !== 'messenger' && ch.type !== 'instagram') throw new HttpError(400, 'Este canal no es de Facebook ni de Instagram');
    const updated = await disconnectMetaChannel(ch);
    await logEvent({ level: 'warn', source: 'admin', message: `Facebook: ${ch.name} desconectado desde el panel`, accountId: ch.account_id, channelId: ch.id });
    return { ok: true, channel: publicChannel(updated, req.user) };
  });

  /* ------------------------------ Redes sociales (Zernio) ------------------------------ */
  const zernio = async (user: User, id: string) => {
    const ch = await channelFor(user, id);
    if (ch.type !== 'zernio') throw new HttpError(400, 'Este canal no es de redes sociales');
    return ch;
  };
  const zernioError = async (ch: Channel, what: string, e: any): Promise<never> => {
    await logEvent({ level: 'error', source: 'channel', message: `Zernio: ${what}: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
    throw new HttpError(400, e?.message ?? String(e));
  };

  /**
   * Conecta la red del canal. Instagram, Facebook, WhatsApp, X y Reddit: devuelve la página donde el negocio autoriza
   * (Zernio vuelve a /zernio/callback). Telegram: devuelve el código para el bot. Bluesky: conecta con usuario y
   * contraseña de aplicación.
   */
  api.post('/api/channels/:id/zernio/connect', admins, async (req: any) => {
    assertVerified(req.user);
    const ch = await zernio(req.user, req.params.id);
    const network = networkOf(ch.config.platform);
    if (network?.flow === 'oauth' && !config.publicBaseUrl.startsWith('https://')) throw new HttpError(400, 'Zernio exige HTTPS: define PUBLIC_BASE_URL con tu dominio (https://...)');
    // El estado lleva la hora en que se generó: el retorno solo vale durante ZERNIO_CONNECT_TTL_MS.
    const state = `${Date.now().toString(36)}.${crypto.randomBytes(24).toString('base64url')}`;
    const b = parse(z.object({ identifier: z.string().max(200).optional(), app_password: z.string().max(200).optional() }), req.body ?? {});
    try {
      const r = await startConnect(ch, (st) => `${config.publicBaseUrl}/zernio/callback/${ch.webhook_token}/${st}`, state, b);
      if (r.kind === 'connected') return { kind: r.kind, channel: publicChannel(r.channel, req.user) };
      return r;
    } catch (e: any) {
      return zernioError(ch, 'no se pudo iniciar la conexión', e);
    }
  });

  /** Telegram: el panel pregunta cada pocos segundos si el código ya llegó al bot. */
  api.post('/api/channels/:id/zernio/telegram-check', admins, async (req: any) => {
    const ch = await zernio(req.user, req.params.id);
    try {
      const r = await checkTelegram(ch);
      return { status: r.status, channel: publicChannel(r.channel, req.user) };
    } catch (e: any) {
      return zernioError(ch, 'no se pudo revisar la conexión de Telegram', e);
    }
  });

  api.post('/api/channels/:id/zernio/disconnect', admins, async (req: any) => {
    const ch = await zernio(req.user, req.params.id);
    const updated = await disconnectZernio(ch);
    await logEvent({ level: 'warn', source: 'admin', message: `Zernio: cuenta desconectada desde el panel (${ch.name})`, accountId: ch.account_id, channelId: ch.id });
    return { ok: true, channel: publicChannel(updated, req.user) };
  });

  api.get('/api/channels/:id/status', admins, async (req: any) => {
    const ch = await channelFor(req.user, req.params.id);
    const adapter = adapterFor(ch.type);
    if (!adapter.status) return { state: 'unknown' };
    try {
      const st = await adapter.status(ch);
      if ((ch.type === 'whatsapp' || ch.type === 'zernio') && st.state && st.state !== 'not_configured') await recordConnectionState(ch, st.state);
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
    const digits = number.replace(/\D/g, '');
    if (!outboundAllowed(digits)) throw new HttpError(403, 'Envío bloqueado: este entorno es de pruebas (OUTBOUND_MODE=sandbox) y el número no está en OUTBOUND_SANDBOX_ALLOW.');
    await evolutionFor(ch).sendText(ch.config.instance, digits, text).catch((e) => {
      throw new HttpError(400, e?.message ?? String(e));
    });
    return { ok: true };
  });
}
