/**
 * Peticiones lentas: cuánto tarda cada respuesta del backend, agrupado por sección de la API, y un aviso en el registro
 * cuando una pasa de SLOW_REQUEST_MS. Es la parte de «rastrear peticiones lentas» que sirve en un solo servidor, sin
 * agregar un recolector aparte (OpenTelemetry) que gastaría memoria del Droplet.
 *
 * Solo se guarda la ruta como está escrita en el código (`/api/conversations/:id`), nunca la URL real: los enlaces
 * públicos llevan su token en la ruta.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HttpGroupStats {
  group: string;
  requests: number;
  slow: number;
  durationMsSum: number;
}

const stats = new Map<string, HttpGroupStats>();

/** Rutas que no se miden: las consulta el monitoreo cada pocos segundos y solo harían ruido. */
const SKIP = new Set(['/health', '/health/db', '/health/ready', '/health/functional', '/metrics']);

/** Sección de la petición a partir de la ruta del código: `/api/quotes/:id` → quotes; `/webhook/:token` → webhook. */
export function routeGroup(route: string | undefined): string {
  if (!route) return 'sin_ruta';
  if (route === '/*') return 'archivos';
  const parts = route.split('/').filter(Boolean);
  if (parts[0] === 'api') return parts[1] === 'v1' ? 'api_v1' : (parts[1] ?? 'api').replace(/^:.*/, 'api');
  return (parts[0] ?? 'inicio').replace(/^:.*/, 'otro');
}

export function recordHttpTiming(route: string | undefined, durationMs: number, slowMs: number): boolean {
  const group = routeGroup(route);
  const s = stats.get(group) ?? { group, requests: 0, slow: 0, durationMsSum: 0 };
  const slow = slowMs > 0 && durationMs >= slowMs;
  stats.set(group, { group, requests: s.requests + 1, slow: s.slow + (slow ? 1 : 0), durationMsSum: s.durationMsSum + durationMs });
  return slow;
}

export function httpTimingStats(): HttpGroupStats[] {
  return [...stats.values()].sort((a, b) => a.group.localeCompare(b.group));
}

/** Para pruebas. */
export function resetHttpTiming(): void {
  stats.clear();
}

export function registerHttpTiming(app: FastifyInstance, slowMs: number): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions?.url;
    if (route && SKIP.has(route)) return;
    const ms = Math.round(reply.elapsedTime);
    if (recordHttpTiming(route, ms, slowMs)) {
      req.log.warn({ route: route ?? null, method: req.method, status: reply.statusCode, ms }, `Petición lenta: ${req.method} ${route ?? '(sin ruta)'} tardó ${ms} ms`);
    }
  });
}
