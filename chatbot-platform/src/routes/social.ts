import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { botFor, HttpError, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { assertWithinLimit, effectiveLimits, usageOf, assertWithinLimitLocked } from '../billing/limits.js';
import { mergeChannelConfig } from '../channels/index.js';
import { metaConnectEnabled } from '../channels/meta-connect.js';
import { clientFor, networkOf, ZernioError, zernioEnabled } from '../channels/zernio.js';
import { checkZernioHealth, zernioHealthSummary } from '../social/health.js';
import {
  connectAuthUrl, connectSession, createConnectSession, disconnectAllTenant, disconnectSocialAccount, finishConnect, listSocialAccounts, orphanProfiles,
  redeliverWebhook, setSocialAgent, syncTenant, webhookLogs, zernioHandlesDm, zernioTenants, type FinishCode,
} from '../channels/zernio-accounts.js';
import { ZernioBusyError, zernioBudgetStatus } from '../channels/zernio-budget.js';
import { accountProfile } from '../channels/zernio-connect.js';
import { createTemplate, deleteTemplate, listTemplates, registerWhatsappPin, syncTemplates, TemplateInputSchema } from '../channels/zernio-templates.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { User } from '../types.js';
import { assertVerified } from './onboarding.js';
import { parse } from './util.js';

/**
 * Redes sociales por Zernio: "Redes sociales" del negocio, la página de Zernio del administrador de la plataforma, el
 * retorno de la autorización y el enlace de conexión que el administrador le manda a un cliente.
 */

const zernioOn = () => {
  if (!zernioEnabled()) throw new HttpError(400, 'Las redes sociales no están activadas en esta instalación. Pide al administrador que configure Zernio.');
};

/** Un error de Zernio llega como un aviso claro (no como "error interno"). */
async function viaZernio<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof ZernioBusyError) throw new HttpError(503, 'Zernio está ocupado en este momento; inténtalo de nuevo en un minuto.');
    if (e instanceof ZernioError) throw new HttpError(502, `Zernio respondió con un error: ${e.message}`);
    throw e;
  }
}

const idParam = (req: any) => parse(z.object({ id: z.string().uuid() }), req.params).id;

/** El agente elegido debe ser del mismo negocio. */
async function checkBot(user: User, accountId: string, chatbotId: string | null | undefined) {
  if (!chatbotId) return;
  const bot = await botFor(user, chatbotId);
  if (bot.account_id !== accountId) throw new HttpError(400, 'El agente pertenece a otro negocio');
}

export async function socialRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };
  const superadmin = { preHandler: requireRole('superadmin') };

  /* ------------------------------ Redes sociales del negocio ------------------------------ */

  api.get('/api/social-accounts', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query?.account_id);
    const [accounts, limits, usage] = await Promise.all([listSocialAccounts(accountId), effectiveLimits(accountId), usageOf(accountId)]);
    return { accounts, meta_direct: metaConnectEnabled(), limit: { used: usage.social_accounts, max: limits.limits.social_accounts ?? null } };
  });

  /**
   * Conectar una red. Las que se autorizan en su página (Instagram, Facebook, WhatsApp, X, Reddit, LinkedIn…) devuelven
   * esa página; Telegram y Bluesky se terminan en su conexión de mensajes (código para el bot o contraseña de aplicación).
   */
  api.post('/api/social-accounts/connect', admins, async (req: any) => {
    assertVerified(req.user);
    zernioOn();
    const b = parse(z.object({
      platform: z.string().max(40), chatbot_id: z.string().uuid().nullable().optional(), reconnect: z.string().uuid().optional(), account_id: z.string().uuid().optional(),
      /** WhatsApp: business_app = seguir usando la app WhatsApp Business en el teléfono; api = solo por la plataforma. */
      onboarding: z.enum(['api', 'business_app']).optional(),
    }), req.body ?? {});
    const accountId = await targetAccount(req.user, b.account_id ?? req.query?.account_id);
    await checkBot(req.user, accountId, b.chatbot_id);
    const network = networkOf(b.platform);
    if (!network) throw new HttpError(400, 'Elige una red válida');
    if (network.flow !== 'oauth') {
      if (!zernioHandlesDm(network.id)) throw new HttpError(400, `${network.label} no se puede conectar aquí`);
      // Reconectar: se vuelve a su misma conexión de mensajes (no cuenta como una red nueva).
      if (b.reconnect) {
        const own = (await query<{ channel_id: string | null; platform: string }>(`SELECT channel_id, platform FROM social_accounts WHERE id = $1 AND account_id = $2`, [b.reconnect, accountId]))[0];
        if (!own || own.platform !== network.id) throw new HttpError(404, 'Esa red no está en este negocio');
        if (own.channel_id) return { kind: 'channel', channel_id: own.channel_id };
      } else {
        await assertWithinLimit(accountId, 'social_accounts');
      }
      // Una conexión de esa red que espera cuenta se reutiliza; si no, se crea.
      const waiting = await query<{ id: string }>(
        `SELECT id FROM channels WHERE account_id = $1 AND type = 'zernio' AND config->>'platform' = $2 AND coalesce(config->>'account_id', '') = '' ORDER BY created_at LIMIT 1`, [accountId, network.id]);
      let channelId = waiting[0]?.id;
      if (channelId && b.chatbot_id) await store.updateChannel(channelId, { chatbot_id: b.chatbot_id });
      if (!channelId) {
        await assertWithinLimit(accountId, 'channels');
        const ch = await store.createChannel({ account_id: accountId, chatbot_id: b.chatbot_id ?? null, type: 'zernio', name: network.label, active: true, config: mergeChannelConfig('zernio', {}, { platform: network.id }) },
          { beforeInsert: (client) => assertWithinLimitLocked(client, accountId, 'channels') });
        channelId = ch.id;
      }
      return { kind: 'channel', channel_id: channelId };
    }
    const { token } = await viaZernio(() => createConnectSession(accountId, network.id, { kind: 'panel', chatbotId: b.chatbot_id ?? null, userId: req.user.id, reconnect: b.reconnect, onboarding: b.onboarding }));
    const session = (await connectSession(token))!;
    try {
      return { kind: 'oauth', authUrl: await viaZernio(() => connectAuthUrl(session, token)) };
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo iniciar la conexión de ${network.label}: ${e?.message ?? e}`, accountId });
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.put('/api/social-accounts/:id', admins, async (req: any) => {
    const b = parse(z.object({ chatbot_id: z.string().uuid().nullable(), account_id: z.string().uuid().optional() }), req.body ?? {});
    const accountId = await targetAccount(req.user, b.account_id ?? req.query?.account_id);
    await checkBot(req.user, accountId, b.chatbot_id);
    await setSocialAgent(accountId, idParam(req), b.chatbot_id);
    return { ok: true };
  });

  api.post('/api/social-accounts/:id/disconnect', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query?.account_id);
    await viaZernio(() => disconnectSocialAccount(accountId, idParam(req)));
    return { ok: true };
  });

  /** WhatsApp: PIN de verificación en dos pasos del número (si tiene uno propio, sin él Meta no deja enviar). */
  api.post('/api/social-accounts/:id/whatsapp-pin', admins, async (req: any) => {
    const b = parse(z.object({ pin: z.string().regex(/^\d{6}$/, 'El PIN tiene 6 dígitos'), account_id: z.string().uuid().optional() }), req.body ?? {});
    const accountId = await targetAccount(req.user, b.account_id ?? req.query?.account_id);
    await viaZernio(() => registerWhatsappPin(accountId, idParam(req), b.pin));
    return { ok: true };
  });

  /* ------------------------------ Plantillas de WhatsApp ------------------------------ */

  // Quien atiende conversaciones (también el agente) puede ver las plantillas para enviarlas.
  api.get('/api/wa-templates', { preHandler: requireRole('agent') }, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query?.account_id);
    const social = req.query?.social_account_id ? parse(z.string().uuid(), req.query.social_account_id) : undefined;
    return listTemplates(accountId, social);
  });

  api.post('/api/wa-templates', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query?.account_id);
    zernioOn();
    const { account_id: _, ...body } = req.body ?? {};
    return viaZernio(() => createTemplate(accountId, parse(TemplateInputSchema, body)));
  });

  /** Trae de Meta las plantillas del número (las creadas en Meta o en Zernio también aparecen). */
  api.post('/api/wa-templates/sync', admins, async (req: any) => {
    const b = parse(z.object({ social_account_id: z.string().uuid(), account_id: z.string().uuid().optional() }), req.body ?? {});
    const accountId = await targetAccount(req.user, b.account_id ?? req.query?.account_id);
    zernioOn();
    const n = await viaZernio(() => syncTemplates(accountId, b.social_account_id));
    return { templates: n };
  });

  api.delete('/api/wa-templates/:id', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query?.account_id);
    await viaZernio(() => deleteTemplate(accountId, idParam(req)));
    return { ok: true };
  });

  /* ------------------------------ Zernio del administrador de la plataforma ------------------------------ */

  const tenant = async (req: any) => {
    const acc = await store.getAccount(idParam(req));
    if (!acc) throw new HttpError(404, 'Negocio no encontrado');
    zernioOn();
    return acc;
  };

  api.get('/api/system/zernio/tenants', superadmin, async () => zernioTenants());

  /** Salud de las redes de todos los negocios y del webhook de la plataforma; "Revisar ahora" no espera la vuelta de 6 h. */
  api.get('/api/system/zernio/health', superadmin, async () => zernioHealthSummary());
  api.post('/api/system/zernio/health/check', superadmin, async () => {
    zernioOn();
    if (rateLimited('zernio-health-check', 6, 60_000)) throw new HttpError(429, 'Espera un minuto antes de volver a revisar.');
    const r = await viaZernio(() => checkZernioHealth({ force: true, client: clientFor(null) }));
    return { ...r, summary: await zernioHealthSummary() };
  });

  api.post('/api/system/zernio/tenants/:id/profile', superadmin, async (req: any) => {
    const acc = await tenant(req);
    const profileId = await viaZernio(() => accountProfile(acc.id));
    await logEvent({ level: 'info', source: 'admin', message: `Zernio: perfil del negocio listo (lo pidió ${req.user.email})`, accountId: acc.id });
    return { profile_id: profileId };
  });

  api.post('/api/system/zernio/tenants/:id/sync', superadmin, async (req: any) => {
    const acc = await tenant(req);
    return viaZernio(() => syncTenant(acc.id));
  });

  api.post('/api/system/zernio/tenants/:id/disconnect-all', superadmin, async (req: any) => {
    const acc = await tenant(req);
    const n = await viaZernio(() => disconnectAllTenant(acc.id));
    await logEvent({ level: 'warn', source: 'admin', message: `Zernio: ${n} red(es) del negocio desconectadas por ${req.user.email}`, accountId: acc.id });
    return { disconnected: n };
  });

  /** Enlace para que el cliente conecte su red sin entrar al panel (7 días; deja de servir en cuanto la conecta). */
  api.post('/api/system/zernio/tenants/:id/connect-link', superadmin, async (req: any) => {
    const acc = await tenant(req);
    const b = parse(z.object({ platform: z.string().max(40) }), req.body ?? {});
    const s = await createConnectSession(acc.id, b.platform, { kind: 'link', userId: req.user.id });
    await logEvent({ level: 'info', source: 'admin', message: `Zernio: enlace para conectar ${networkOf(b.platform)?.label} creado por ${req.user.email}`, accountId: acc.id });
    return { url: `${config.publicBaseUrl}/conectar-red/${s.token}`, expires_at: s.expires_at };
  });

  api.get('/api/system/zernio/webhook-logs', superadmin, async (req: any) => {
    zernioOn();
    return viaZernio(() => webhookLogs({ failed: req.query?.failed === '1' }));
  });

  api.post('/api/system/zernio/webhook-logs/:id/redeliver', superadmin, async (req: any) => {
    zernioOn();
    const b = parse(z.object({ webhook_id: z.string().min(1).max(100) }), req.body ?? {});
    await viaZernio(() => redeliverWebhook(b.webhook_id, String(req.params.id).slice(0, 200)));
    return { ok: true };
  });

  api.get('/api/system/zernio/orphans', superadmin, async () => {
    zernioOn();
    return viaZernio(() => orphanProfiles());
  });

  api.get('/api/system/zernio/budget', superadmin, async () => zernioBudgetStatus());
}

/* ------------------------------ Retorno de Zernio y enlace del cliente (sin sesión) ------------------------------ */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (reply: FastifyReply, code: number, title: string, body: string) =>
  reply.code(code).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html').send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:440px;margin:15vh auto;padding:0 20px;text-align:center"><h2>${esc(title)}</h2><p>${esc(body)}</p>`);

/** Lo que ve el cliente que usó un enlace de conexión. */
const LINK_RESULT: Record<Exclude<FinishCode, 'ok'>, [string, string]> = {
  not_yours: ['No se conectó', 'Esa cuenta no se pudo confirmar para tu negocio. Vuelve a abrir el enlace e inicia sesión con la cuenta correcta.'],
  in_use: ['Esa cuenta ya está conectada', 'Esa cuenta ya está conectada en otro lugar. Avísale a quien te mandó el enlace.'],
  cancelled: ['No se terminó la autorización', 'Puedes volver a abrir el enlace para intentarlo de nuevo.'],
  expired: ['El enlace venció', 'Pide un enlace nuevo a quien te lo mandó.'],
  limit: ['Tu plan no permite más redes', 'Avísale a quien te mandó el enlace para ampliar tu plan.'],
  error: ['No se pudo completar la conexión', 'Vuelve a abrir el enlace en unos minutos; si sigue fallando, avísale a quien te lo mandó.'],
  invalid: ['Enlace no disponible', 'Este enlace ya se usó o no es válido. Pide uno nuevo a quien te lo mandó.'],
};

export async function socialPublicRoutes(app: FastifyInstance) {
  /** Zernio vuelve aquí al terminar de autorizar (desde "Redes sociales" o desde un enlace para el cliente). */
  app.get('/zernio/return/:state', async (req: any, reply) => {
    if (rateLimited(`zernio-return:${req.ip}`, 60, 60_000)) return page(reply, 429, 'Demasiadas visitas', 'Intenta de nuevo en un minuto.');
    const { code, session } = await finishConnect(String(req.params.state), req.query ?? {});
    if (!session || (code === 'invalid' && session.kind === 'panel')) {
      await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: retorno de conexión con estado inválido o ya usado; se rechaza', details: { ip: req.ip } });
      return reply.code(403).send('forbidden');
    }
    if (session.kind === 'link') {
      if (code === 'ok') {
        const label = networkOf(session.platform)?.label ?? 'tu red';
        return page(reply, 200, '¡Listo!', `Tu cuenta de ${label} quedó conectada. Ya puedes cerrar esta ventana.`);
      }
      const [title, body] = LINK_RESULT[code];
      return page(reply, 200, title, body);
    }
    return reply.redirect(`${config.publicBaseUrl}/#/redes?zernio=${code}`);
  });

  /** Enlace que el administrador le manda al cliente: lo lleva directo a autorizar su red, sin iniciar sesión. */
  app.get('/conectar-red/:token', async (req: any, reply) => {
    if (rateLimited(`zernio-link:${req.ip}`, 30, 60_000)) return page(reply, 429, 'Demasiadas visitas', 'Intenta de nuevo en un minuto.');
    const token = String(req.params.token);
    const session = await connectSession(token);
    if (!session || session.kind !== 'link' || session.used_at) return page(reply, 404, ...LINK_RESULT.invalid);
    if (!session.fresh) return page(reply, 410, ...LINK_RESULT.expired);
    if (!zernioEnabled()) return page(reply, 503, 'No disponible por ahora', 'Las redes sociales no están activas en este momento. Inténtalo más tarde.');
    try {
      return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(await connectAuthUrl(session, token));
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo abrir el enlace de conexión: ${e?.message ?? e}`, accountId: session.account_id });
      return page(reply, 502, ...LINK_RESULT.error);
    }
  });
}
