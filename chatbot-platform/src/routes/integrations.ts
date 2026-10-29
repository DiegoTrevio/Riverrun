/** Ajustes → Integraciones: webhooks de eventos y llaves de la API pública. */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { config } from '../config.js';
import { ALL_EVENTS_SET, EVENT_TYPES, deliverOnce, eventBody, redeliver, sampleEventData, type Endpoint, type PublicEvent } from '../integrations/webhooks.js';
import * as astore from '../automation/store.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { parse } from './util.js';
import { authUrl, connect, disconnect, getLink, googleConfigured, readState } from '../integrations/google.js';
import * as outlook from '../integrations/outlook.js';
import * as staffCal from '../integrations/staff-calendars.js';

export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

/** "rr_" + 32 caracteres aleatorios. Se muestra una sola vez; en la base solo queda su hash. */
export function newApiKey() {
  const key = `rr_${crypto.randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 9), hash: hashKey(key) };
}

const EndpointBody = z.object({
  url: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'La dirección debe empezar con http:// o https://'),
  description: z.string().max(200).default(''),
  events: z.array(z.string()).min(1).default(['*']).refine((l) => l.every((e) => e === '*' || Object.hasOwn(EVENT_TYPES, e)), 'Evento desconocido'),
  active: z.boolean().default(true),
});

export async function integrationRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  // in_all: lo incluye «todos los eventos» ("*"); default: va marcado al crear un webhook.
  api.get('/api/webhook-events', admins, async () => Object.entries(EVENT_TYPES).filter(([k]) => k !== 'ping').map(([type, label]) => ({ type, label, default: type !== 'message.received', in_all: ALL_EVENTS_SET.has(type) })));

  const endpointFor = async (user: any, id: string) => {
    const ep = await queryOne<Endpoint>(`SELECT * FROM webhook_endpoints WHERE id = $1`, [id]);
    if (!ep) throw new HttpError(404, 'No encontrado');
    const only = scopeAccount(user, ep.account_id);
    if (only && only !== ep.account_id) throw new HttpError(404, 'No encontrado');
    return ep;
  };

  api.get('/api/webhook-endpoints', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    return query(
      `SELECT e.*, (SELECT row_to_json(d) FROM (SELECT ok, status_code, error, created_at FROM webhook_deliveries WHERE endpoint_id = e.id ORDER BY id DESC LIMIT 1) d) AS last_delivery
         FROM webhook_endpoints e WHERE e.account_id = $1 ORDER BY e.created_at`,
      [accountId],
    );
  });

  api.post('/api/webhook-endpoints', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    const b = parse(EndpointBody, req.body);
    const n = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_endpoints WHERE account_id = $1`, [accountId]))?.n ?? 0;
    if (n >= 10) throw new HttpError(400, 'Máximo 10 webhooks por cuenta');
    const ep = await queryOne(`INSERT INTO webhook_endpoints (account_id, url, description, events, active) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [accountId, b.url, b.description, JSON.stringify(b.events), b.active]);
    await logEvent({ level: 'info', source: 'admin', message: `Webhook creado hacia ${new URL(b.url).host}`, accountId });
    return ep;
  });

  api.put('/api/webhook-endpoints/:id', admins, async (req: any) => {
    const cur = await endpointFor(req.user, req.params.id);
    const b = parse(EndpointBody, { ...cur, ...(req.body ?? {}) });
    // Volver a activarlo borra el motivo de la pausa y la cuenta de fallos.
    return queryOne(
      `UPDATE webhook_endpoints SET url = $2, description = $3, events = $4, active = $5,
         disabled_reason = CASE WHEN $5 THEN '' ELSE disabled_reason END, consecutive_failures = CASE WHEN $5 AND NOT active THEN 0 ELSE consecutive_failures END WHERE id = $1 RETURNING *`,
      [cur.id, b.url, b.description, JSON.stringify(b.events), b.active],
    );
  });

  api.delete('/api/webhook-endpoints/:id', admins, async (req: any) => {
    const ep = await endpointFor(req.user, req.params.id);
    await query(`DELETE FROM webhook_endpoints WHERE id = $1`, [ep.id]);
    return { ok: true };
  });

  /**
   * Envía una prueba ahora mismo y dice qué respondió la otra parte. Con `event`, un ejemplo con la forma real de ese
   * evento (con la conversación más reciente de la cuenta), marcado `test: true`, para mapear los campos en Zapier o Make.
   */
  api.post('/api/webhook-endpoints/:id/test', admins, async (req: any) => {
    const ep = await endpointFor(req.user, req.params.id);
    const b = parse(z.object({ event: z.string().refine((e) => Object.hasOwn(EVENT_TYPES, e), 'Evento desconocido').default('ping') }), req.body ?? {});
    const event = b.event as PublicEvent;
    const eventId = crypto.randomUUID();
    const body = eventBody(eventId, event, ep.account_id, await sampleEventData(ep.account_id, event), { test: true });
    const r = await deliverOnce(ep, eventId, event, body, 1);
    return r.ok ? { ok: true, event, status_code: r.status } : { ok: false, event, status_code: r.status, error: r.error };
  });

  // redeliverable: su evento sigue guardado (30 días) y se puede reenviar.
  api.get('/api/webhook-endpoints/:id/deliveries', admins, async (req: any) => {
    const ep = await endpointFor(req.user, req.params.id);
    return query(
      `SELECT d.id, d.event_id, d.event, d.ok, d.status_code, d.error, d.attempt, d.duration_ms, d.created_at, (ev.id IS NOT NULL) AS redeliverable
         FROM webhook_deliveries d LEFT JOIN webhook_events ev ON ev.id = d.event_id WHERE d.endpoint_id = $1 ORDER BY d.id DESC LIMIT 50`,
      [ep.id],
    );
  });

  const deliveryFor = async (req: any) => {
    const ep = await endpointFor(req.user, req.params.id);
    const d = /^\d{1,18}$/.test(String(req.params.deliveryId)) ? await queryOne<{ id: string; event_id: string; event: string }>(`SELECT id, event_id, event, ok, status_code, error, attempt, created_at FROM webhook_deliveries WHERE id = $1 AND endpoint_id = $2`, [req.params.deliveryId, ep.id]) : null;
    if (!d) throw new HttpError(404, 'Entrega no encontrada');
    return { ep, d };
  };

  /** Lo que se envió en una entrega (el cuerpo del evento, si sigue guardado). */
  api.get('/api/webhook-endpoints/:id/deliveries/:deliveryId', admins, async (req: any) => {
    const { d } = await deliveryFor(req);
    const ev = await queryOne<{ body: unknown }>(`SELECT body FROM webhook_events WHERE id = $1`, [d.event_id]);
    return { delivery: d, body: ev?.body ?? null };
  });

  /** Vuelve a enviar el evento de esa entrega (por si tu sistema lo perdió). */
  api.post('/api/webhook-endpoints/:id/deliveries/:deliveryId/redeliver', admins, async (req: any) => {
    const { ep, d } = await deliveryFor(req);
    if (!ep.active) throw new HttpError(409, 'El webhook está apagado: enciéndelo para reenviar');
    const event = await redeliver(ep, d.event_id);
    if (!event) throw new HttpError(410, 'Ese evento ya no está guardado (se guardan 30 días)');
    await logEvent({ level: 'info', source: 'admin', message: `Webhook: ${req.user.email} reenvió ${event} a ${new URL(ep.url).host}`, accountId: ep.account_id });
    return { ok: true, event };
  });

  /** Cambia solo el secreto de webhooks (el enlace del calendario se queda igual). Las firmas viejas dejan de valer. */
  api.post('/api/settings/rotate-webhook-secret', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    const s = await astore.getSettings(accountId);
    await astore.saveSettings(accountId, { ...s, webhook_secret: crypto.randomBytes(24).toString('hex') });
    await logEvent({ level: 'info', source: 'admin', message: `Secreto de webhooks cambiado por ${req.user.email}`, accountId });
    return { webhook_secret: (await astore.getSettings(accountId)).webhook_secret };
  });

  /* ------------------------------ Llaves de la API ------------------------------ */
  api.get('/api/api-keys', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    return query(`SELECT id, name, prefix, scope, created_at, last_used_at, revoked_at FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]);
  });

  api.post('/api/api-keys', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), scope: z.enum(['read', 'write']).default('read') }), req.body);
    const active = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL`, [accountId]))?.n ?? 0;
    if (active >= 10) throw new HttpError(400, 'Máximo 10 llaves activas: revoca alguna que ya no uses');
    const k = newApiKey();
    const row = await queryOne<{ id: string }>(`INSERT INTO api_keys (account_id, name, prefix, key_hash, scope, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [accountId, b.name, k.prefix, k.hash, b.scope, req.user.id]);
    await logEvent({ level: 'info', source: 'admin', message: `Llave de API creada: ${b.name} (${b.scope === 'write' ? 'lectura y escritura' : 'solo lectura'})`, accountId });
    // La llave completa solo se devuelve aquí.
    return { id: row!.id, name: b.name, scope: b.scope, prefix: k.prefix, key: k.key };
  });

  api.delete('/api/api-keys/:id', admins, async (req: any) => {
    const k = await queryOne<{ id: string; account_id: string; name: string }>(`SELECT id, account_id, name FROM api_keys WHERE id = $1`, [req.params.id]);
    const only = k ? scopeAccount(req.user, k.account_id) : null;
    if (!k || (only && only !== k.account_id)) throw new HttpError(404, 'No encontrado');
    await query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [k.id]);
    await logEvent({ level: 'info', source: 'admin', message: `Llave de API revocada: ${k.name}`, accountId: k.account_id });
    return { ok: true };
  });

  /* ------------------------------ Google Calendar ------------------------------ */
  api.get('/api/integrations/google', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const link = await getLink(accountId);
    return { available: googleConfigured(), connected: !!link, email: link?.google_email ?? '', block_busy: link?.block_busy ?? true, last_error: link?.last_error ?? '', connected_at: link?.connected_at ?? null };
  });

  api.post('/api/integrations/google/connect', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    if (!googleConfigured()) throw new HttpError(400, 'Esta instalación no tiene Google configurado (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET)');
    const nonce = crypto.randomBytes(16).toString('hex');
    reply.setCookie('g_cal_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/oauth/google', maxAge: 900 });
    return { url: authUrl(accountId, nonce) };
  });

  api.put('/api/integrations/google', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    const b = parse(z.object({ block_busy: z.boolean() }), req.body);
    const r = await query(`UPDATE google_calendar SET block_busy = $2 WHERE account_id = $1 RETURNING 1`, [accountId, b.block_busy]);
    if (!r.length) throw new HttpError(404, 'Google Calendar no está conectado');
    return { ok: true };
  });

  api.delete('/api/integrations/google', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    await disconnect(accountId);
    return { ok: true };
  });

  /* ------------------------------ Outlook (Microsoft 365 / Outlook.com) ------------------------------ */
  api.get('/api/integrations/outlook', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const link = await outlook.getLink(accountId);
    return { available: outlook.outlookConfigured(), connected: !!link, email: link?.email ?? '', block_busy: link?.block_busy ?? true, last_error: link?.last_error ?? '', connected_at: link?.connected_at ?? null };
  });

  api.post('/api/integrations/outlook/connect', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    if (!outlook.outlookConfigured()) throw new HttpError(400, 'Esta instalación no tiene Microsoft configurado (MICROSOFT_CLIENT_ID y MICROSOFT_CLIENT_SECRET)');
    const nonce = crypto.randomBytes(16).toString('hex');
    reply.setCookie('o_cal_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/oauth/outlook', maxAge: 900 });
    return { url: outlook.authUrl(accountId, nonce) };
  });

  api.put('/api/integrations/outlook', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    const b = parse(z.object({ block_busy: z.boolean() }), req.body);
    const r = await query(`UPDATE outlook_calendar SET block_busy = $2 WHERE account_id = $1 RETURNING 1`, [accountId, b.block_busy]);
    if (!r.length) throw new HttpError(404, 'Outlook no está conectado');
    outlook.clearBusyCache(accountId);
    return { ok: true };
  });

  api.delete('/api/integrations/outlook', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    await outlook.disconnect(accountId);
    return { ok: true };
  });
}

/**
 * Mi calendario: cada persona del equipo conecta su propio Google u Outlook. Sus eventos ocupados bloquean sus horarios en
 * la agenda y las citas que se le asignan aparecen en su calendario.
 */
export async function myCalendarRoutes(api: FastifyInstance) {
  const mine = (req: any) => {
    if (!req.user.account_id) throw new HttpError(400, 'Tu usuario no pertenece a una cuenta');
    return req.user.id as string;
  };
  api.get('/api/me/calendar', async (req: any) => ({
    ...staffCal.publicView(await staffCal.getStaffCalendar(mine(req))),
    available: { google: googleConfigured(), outlook: outlook.outlookConfigured() },
  }));

  api.post('/api/me/calendar/connect', async (req: any, reply) => {
    const userId = mine(req);
    const { provider } = parse(z.object({ provider: z.enum(['google', 'outlook']) }), req.body);
    if (provider === 'google' && !googleConfigured()) throw new HttpError(400, 'Esta instalación no tiene Google configurado (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET)');
    if (provider === 'outlook' && !outlook.outlookConfigured()) throw new HttpError(400, 'Esta instalación no tiene Microsoft configurado (MICROSOFT_CLIENT_ID y MICROSOFT_CLIENT_SECRET)');
    const nonce = crypto.randomBytes(16).toString('hex');
    const [cookie, path] = provider === 'google' ? ['g_cal_nonce', '/oauth/google'] : ['o_cal_nonce', '/oauth/outlook'];
    reply.setCookie(cookie, nonce, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path, maxAge: 900 });
    return { url: staffCal.authUrl(provider, userId, nonce) };
  });

  api.put('/api/me/calendar', async (req: any) => {
    const b = parse(z.object({ block_busy: z.boolean() }), req.body);
    if (!(await staffCal.setBlockBusy(mine(req), b.block_busy))) throw new HttpError(404, 'No tienes un calendario conectado');
    return { ok: true };
  });

  api.delete('/api/me/calendar', async (req: any) => {
    await staffCal.disconnectStaff(mine(req));
    return { ok: true };
  });
}

/** Regreso de OAuth para el calendario de una persona del equipo (el «state» empieza con u_). */
async function staffCallback(provider: staffCal.Provider, target: string, req: any, reply: any) {
  const userId = target.slice(staffCal.STATE_PREFIX.length);
  const back = (q: string) => reply.redirect(`/#/agenda/equipo?calendario=${q}`);
  if (req.query.error || !req.query.code) return back('cancelado');
  try {
    await staffCal.connectStaff(provider, userId, String(req.query.code));
    return back('ok');
  } catch (e: any) {
    await logEvent({ level: 'error', source: 'admin', message: `Calendario de una persona (${provider}): ${e.message}` });
    return reply.redirect(`/#/agenda/equipo?calendario=error&msg=${encodeURIComponent(e.message.slice(0, 120))}`);
  }
}

/** Regreso desde Google: no usa la sesión, la cuenta (o la persona) viaja firmada en "state". */
export async function googleCallbackRoute(app: FastifyInstance) {
  app.get('/oauth/google/callback', async (req: any, reply) => {
    const nonce = String(req.cookies?.g_cal_nonce ?? '');
    reply.clearCookie('g_cal_nonce', { path: '/oauth/google' });
    const accountId = readState(String(req.query.state ?? ''), nonce);
    if (!accountId) return reply.redirect('/#/integraciones?google=error');
    if (accountId.startsWith(staffCal.STATE_PREFIX)) return staffCallback('google', accountId, req, reply);
    if (req.query.error || !req.query.code) return reply.redirect('/#/integraciones?google=cancelado');
    try {
      await connect(accountId, String(req.query.code));
      return reply.redirect('/#/integraciones?google=ok');
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'admin', message: `Google Calendar: ${e.message}`, accountId });
      return reply.redirect(`/#/integraciones?google=error&msg=${encodeURIComponent(e.message.slice(0, 120))}`);
    }
  });
}

/** Regreso desde Microsoft: no usa la sesión, la cuenta viaja firmada en "state". */
export async function outlookCallbackRoute(app: FastifyInstance) {
  app.get('/oauth/outlook/callback', async (req: any, reply) => {
    const nonce = String(req.cookies?.o_cal_nonce ?? '');
    reply.clearCookie('o_cal_nonce', { path: '/oauth/outlook' });
    const accountId = outlook.readState(String(req.query.state ?? ''), nonce);
    if (!accountId) return reply.redirect('/#/integraciones?outlook=error');
    if (accountId.startsWith(staffCal.STATE_PREFIX)) return staffCallback('outlook', accountId, req, reply);
    if (req.query.error || !req.query.code) return reply.redirect('/#/integraciones?outlook=cancelado');
    try {
      await outlook.connect(accountId, String(req.query.code));
      return reply.redirect('/#/integraciones?outlook=ok');
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'admin', message: `Outlook: ${e.message}`, accountId });
      return reply.redirect(`/#/integraciones?outlook=error&msg=${encodeURIComponent(e.message.slice(0, 120))}`);
    }
  });
}
