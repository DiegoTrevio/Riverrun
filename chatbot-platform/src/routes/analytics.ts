/** Estadísticas del panel: conversaciones, mensajes, citas, costo de IA y reparto por persona (solo administradores). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, targetAccount } from '../access.js';
import { overview, RANGE_KEYS } from '../analytics.js';
import { parse } from './util.js';

export async function analyticsRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  /** range: today | week (desde el lunes) | 7 | 15 | 30 | 60 | 90 (días, contando hoy) | custom (con from y to). */
  api.get('/api/analytics', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const q = parse(
      z.object({
        range: z.enum(RANGE_KEYS).default('7'),
        from: z.string().max(10).optional(),
        to: z.string().max(10).optional(),
      }),
      req.query,
    );
    return overview(accountId, q.range, q.from, q.to);
  });
}
