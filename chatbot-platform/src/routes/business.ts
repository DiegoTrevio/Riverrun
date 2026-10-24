/**
 * Tablero del superadmin (`#/negocio`): las cifras del negocio y lo que falta para cobrar de verdad.
 */
import type { FastifyInstance } from 'fastify';
import { requireRole } from '../access.js';
import { validateConfig } from '../config-check.js';
import { businessMetrics } from '../platform/digest.js';

export async function businessRoutes(api: FastifyInstance) {
  api.get('/api/platform/business', { preHandler: requireRole('superadmin') }, async () => {
    const report = validateConfig(process.env);
    // Solo el mensaje y cómo corregirlo (nunca valores): lo de cobro, facturas y avisos al superadmin.
    const golive = report.issues
      .filter((i) => i.level !== 'optional' && (i.area === 'billing' || i.vars.includes('SUPERADMIN_EMAIL')))
      .map((i) => ({ id: i.id, level: i.level, message: i.message, fix: i.fix }));
    return { metrics: await businessMetrics(), golive, env: report.env };
  });
}
