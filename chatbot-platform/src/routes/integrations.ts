/** Ajustes → Integraciones: webhooks de eventos y llaves de la API pública. */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { EVENT_TYPES, deliver, eventBody, type Endpoint } from '../integrations/webhooks.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { parse } from './util.js';
import { authUrl, connect, disconnect, getLink, googleConfigured, readState } from '../integrations/google.js';

export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

/** "rr_" + 32 caracteres aleatorios. Se muestra una sola vez; en la base solo queda su hash. */
export function newApiKey() {
  const key = `rr_${crypto.randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 9), hash: hashKey(key) };
}

const EndpointBody = z.object({
  url: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'La dirección debe empezar con http:// o https://'),
  description: z.string().max(200).default(''),
  events: z.array(z.string()).min(1).default(['*']).refine((l) => l.every((e) => e === '*' || e in EVENT_TYPES), 'Evento desconocido'),
  active: z.boolean().default(true),
});

export async function integrationRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  api.get('/api/webhook-events', admins, async () => Object.entries(EVENT_TYPES).filter(([k]) => k !== 'ping').map(([type, label]) => ({ type, label, default: type !== 'message.received' })));

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

  /** Envía un evento "ping" ahora mismo y dice qué respondió la otra parte. */
  api.post('/api/webhook-endpoints/:id/test', admins, async (req: any) => {
    const ep = await endpointFor(req.user, req.params.id);
    const eventId = crypto.randomUUID();
    const body = eventBody(eventId, 'ping', ep.account_id, { message: 'Prueba de conexión desde el panel', contact: { id: 'prueba', name: 'Cliente de prueba', phone: '5215500000000', tags: [], data: {} } });
    try {
      await deliver({ endpoint_id: ep.id, event_id: eventId, event: 'ping', body });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  api.get('/api/webhook-endpoints/:id/deliveries', admins, async (req: any) => {
    const ep = await endpointFor(req.user, req.params.id);
    return query(`SELECT id, event_id, event, ok, status_code, error, attempt, duration_ms, created_at FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY id DESC LIMIT 50`, [ep.id]);
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

  api.post('/api/integrations/google/connect', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    if (!googleConfigured()) throw new HttpError(400, 'Esta instalación no tiene Google configurado (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET)');
    return { url: authUrl(accountId) };
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
}

/** Regreso desde Google: no usa la sesión, la cuenta viaja firmada en "state". */
export async function googleCallbackRoute(app: FastifyInstance) {
  app.get('/oauth/google/callback', async (req: any, reply) => {
    const accountId = readState(String(req.query.state ?? ''));
    if (!accountId) return reply.redirect('/#/integraciones?google=error');
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
