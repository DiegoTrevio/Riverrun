/**
 * Varios números de WhatsApp por cuenta: un enlace público (wa.me) que reparte a los clientes nuevos entre los
 * números conectados, para poner en la web, en redes o en anuncios. Cada número sigue siendo un canal independiente.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

interface PoolRow {
  id: string;
  account_id: string;
  name: string;
  token: string;
  strategy: 'round_robin' | 'least_busy';
  channel_ids: string[];
  message: string;
  active: boolean;
}

const PoolBody = z.object({
  name: z.string().trim().min(1).max(80),
  strategy: z.enum(['round_robin', 'least_busy']).default('least_busy'),
  channel_ids: z.array(z.string().uuid()).min(1).max(20),
  /** Mensaje con el que se abre el chat (el cliente solo pulsa enviar). */
  message: z.string().max(300).default(''),
  active: z.boolean().default(true),
});

const digits = (n: unknown) => String(n ?? '').replace(/\D/g, '');

export async function poolAdminRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };
  const link = (p: Pick<PoolRow, 'token'>) => `${config.publicBaseUrl}/wa/${p.token}`;

  const poolFor = async (user: any, id: string) => {
    const p = await queryOne<PoolRow>(`SELECT * FROM wa_pools WHERE id = $1`, [id]);
    const accountId = p ? scopeAccount(user, p.account_id) : null;
    if (!p || (accountId && accountId !== p.account_id)) throw new HttpError(404, 'No encontrado');
    return p;
  };
  const checkChannels = async (accountId: string, ids: string[]) => {
    for (const id of ids) {
      const ch = await store.getChannel(id);
      if (!ch || ch.account_id !== accountId || ch.type !== 'whatsapp') throw new HttpError(400, 'Solo puedes repartir entre canales de WhatsApp de tu cuenta');
    }
  };

  api.get('/api/wa-pools', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const pools = await query<PoolRow>(`SELECT * FROM wa_pools WHERE account_id = $1 ORDER BY created_at`, [accountId]);
    const hits = await query<{ pool_id: string; channel_id: string; today: number; total: number }>(
      `SELECT pool_id, channel_id, sum(CASE WHEN day = current_date THEN hits ELSE 0 END)::int AS today, sum(hits)::int AS total FROM wa_pool_hits WHERE pool_id = ANY($1) GROUP BY 1, 2`,
      [pools.map((p) => p.id)],
    );
    return pools.map((p) => ({ ...p, url: link(p), hits: hits.filter((h) => h.pool_id === p.id).map(({ channel_id, today, total }) => ({ channel_id, today, total })) }));
  });

  api.post('/api/wa-pools', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query.account_id);
    const b = parse(PoolBody, req.body);
    await checkChannels(accountId, b.channel_ids);
    const p = await queryOne<PoolRow>(
      `INSERT INTO wa_pools (account_id, name, token, strategy, channel_ids, message, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [accountId, b.name, crypto.randomBytes(9).toString('base64url'), b.strategy, JSON.stringify([...new Set(b.channel_ids)]), b.message, b.active],
    );
    await logEvent({ level: 'info', source: 'admin', message: `Enlace de reparto creado: ${b.name}`, accountId });
    return { ...p!, url: link(p!), hits: [] };
  });

  api.put('/api/wa-pools/:id', admins, async (req: any) => {
    const cur = await poolFor(req.user, req.params.id);
    const b = parse(PoolBody, { ...cur, ...(req.body ?? {}) });
    await checkChannels(cur.account_id, b.channel_ids);
    const p = await queryOne<PoolRow>(
      `UPDATE wa_pools SET name = $2, strategy = $3, channel_ids = $4, message = $5, active = $6 WHERE id = $1 RETURNING *`,
      [cur.id, b.name, b.strategy, JSON.stringify([...new Set(b.channel_ids)]), b.message, b.active],
    );
    return { ...p!, url: link(p!) };
  });

  api.delete('/api/wa-pools/:id', admins, async (req: any) => {
    const p = await poolFor(req.user, req.params.id);
    await query(`DELETE FROM wa_pools WHERE id = $1`, [p.id]);
    return { ok: true };
  });
}

/** Enlace público: elige un número conectado y abre el chat en WhatsApp. */
export async function poolPublicRoutes(app: FastifyInstance) {
  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;max-width:420px;margin:15vh auto;padding:0 20px;text-align:center"><h2>${title}</h2><p>${body}</p>`;

  app.get('/wa/:token', async (req: any, reply) => {
    if (rateLimited(`wa-pool:${req.ip}`, 120, 60_000)) return reply.code(429).type('text/html').send(page('Demasiadas visitas', 'Intenta de nuevo en un minuto.'));
    const pool = await queryOne<PoolRow & { account_active: boolean; account_status: string }>(
      `SELECT p.*, a.active AS account_active, a.status AS account_status FROM wa_pools p JOIN accounts a ON a.id = p.account_id WHERE p.token = $1`,
      [String(req.params.token).slice(0, 40)],
    );
    if (!pool || !pool.active || !pool.account_active || pool.account_status === 'paused') return reply.code(404).type('text/html').send(page('Enlace no disponible', 'Este enlace ya no está activo.'));
    // Solo números conectados ahora, con teléfono conocido.
    const eligible = (
      await query<{ id: string; number: string; n24: number; hits_today: number }>(
        `SELECT ch.id, ch.config->>'number' AS number,
                (SELECT count(*)::int FROM conversations cv WHERE cv.channel_id = ch.id AND cv.created_at > now() - interval '24 hours') AS n24,
                COALESCE((SELECT hits FROM wa_pool_hits h WHERE h.pool_id = $1 AND h.channel_id = ch.id AND h.day = current_date), 0) AS hits_today
           FROM channels ch WHERE ch.id = ANY($2::uuid[]) AND ch.account_id = $3 AND ch.type = 'whatsapp' AND ch.active AND ch.connection_state = 'open'`,
        [pool.id, pool.channel_ids, pool.account_id],
      )
    ).filter((c) => digits(c.number).length >= 8);
    if (!eligible.length) return reply.code(503).header('retry-after', '120').type('text/html').send(page('Estamos conectando nuestros números', 'Por ahora no hay un número disponible. Intenta de nuevo en unos minutos.'));

    // Orden estable por canal para que el turno rotativo sea predecible.
    eligible.sort((a, b) => a.id.localeCompare(b.id));
    let pick = eligible[0];
    if (pool.strategy === 'round_robin') {
      const r = await queryOne<{ rr_counter: number }>(`UPDATE wa_pools SET rr_counter = rr_counter + 1 WHERE id = $1 RETURNING rr_counter`, [pool.id]);
      pick = eligible[((r?.rr_counter ?? 1) - 1) % eligible.length];
    } else {
      // Menos enviados por este enlace hoy; si empatan, el que menos conversaciones nuevas lleva en 24 h.
      pick = [...eligible].sort((a, b) => a.hits_today - b.hits_today || a.n24 - b.n24 || a.id.localeCompare(b.id))[0];
    }
    await query(
      `INSERT INTO wa_pool_hits (pool_id, channel_id, day, hits) VALUES ($1,$2,current_date,1) ON CONFLICT (pool_id, channel_id, day) DO UPDATE SET hits = wa_pool_hits.hits + 1`,
      [pool.id, pick.id],
    );
    const text = pool.message.trim() ? `?text=${encodeURIComponent(pool.message.trim())}` : '';
    return reply.header('cache-control', 'no-store').redirect(`https://wa.me/${digits(pick.number)}${text}`, 302);
  });
}
