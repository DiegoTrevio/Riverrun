/**
 * Permiso de un solo uso para que el Copiloto haga una acción delicada (las que piden el código de verificación), solo
 * después de que la persona escribió su código en la tarjeta de esa propuesta.
 *
 * - Se crea al confirmar, con el código ya revisado, y vive en memoria: las rutas lo revisan sin `await` y la herramienta
 *   corre en el mismo proceso que recibió la confirmación (`app.inject`).
 * - Está atado a la persona, a su sesión, a la acción y a la lista de rutas que esa herramienta declara (`grants`).
 * - Dura 120 s, se gasta en una sola petición (aunque esa petición pase por varios ganchos) y se revoca al terminar.
 * - Nunca llega al modelo, a la base ni a los registros: viaja en la cabecera `x-copilot-grant` que solo pone el servidor.
 * - No hace dueño a nadie: solo quita el bloqueo «el Copiloto no hace esto»; las demás reglas (dueño, rol) siguen.
 * - Hay rutas que nunca abre (`NEVER_FROM_COPILOT`): cobro, la cuenta entera, tu perfil y seguridad, llaves y secretos,
 *   planes, marcas, sistema y precios de IA.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const GRANT_HEADER = 'x-copilot-grant';
const TTL_MS = 120_000;

interface Grant { userId: string; sessionId: string; actionId: string; routes: Set<string>; uses: number; expiresAt: number }
const grants = new Map<string, Grant>();
const MEMO = Symbol('copilotGrant');

/**
 * Lo que el permiso nunca abre. Un prefijo de ruta (`/api/me` cubre `/api/me` y `/api/me/…`) o «MÉTODO /ruta» exacta.
 * Además, cualquier ruta que rote un secreto (`rotate` en la ruta).
 */
export const NEVER_FROM_COPILOT: string[] = [
  '/api/billing', '/api/account', '/api/me', '/api/2fa', '/api/api-keys', '/api/settings/secrets', '/api/settings/rotate-secrets',
  '/api/plans', '/api/brands', '/api/system', '/api/ai-prices', 'DELETE /api/accounts/:id', 'POST /api/users/:id/2fa/reset',
];

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** «MÉTODO /ruta/:param» de una petición (la ruta registrada, no la URL con ids). */
export const routeKey = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

/** ¿Esta ruta la puede abrir un permiso del Copiloto? */
export function grantable(key: string): boolean {
  const [method, url = ''] = key.split(' ');
  if (!method || !url.startsWith('/api/') || /rotate/i.test(url)) return false;
  return !NEVER_FROM_COPILOT.some((p) => (p.includes(' ') ? key === p : url === p || url.startsWith(`${p}/`)));
}

export function mintCopilotGrant(o: { userId: string; sessionId: string; actionId: string; routes: string[]; uses?: number }): string {
  const token = randomBytes(32).toString('base64url');
  grants.set(hash(token), {
    userId: o.userId, sessionId: o.sessionId, actionId: o.actionId, routes: new Set(o.routes.filter(grantable)),
    uses: Math.max(1, o.uses ?? 1), expiresAt: Date.now() + TTL_MS,
  });
  // Limpieza de los vencidos (pocos: uno por confirmación con código).
  for (const [k, g] of grants) if (g.expiresAt < Date.now()) grants.delete(k);
  return token;
}

export function revokeCopilotGrant(token: string | undefined) {
  if (token) grants.delete(hash(token));
}

/**
 * ¿Esta petición del Copiloto trae un permiso válido para esta ruta? Se gasta una vez por petición (el resultado se
 * guarda en la petición: varios ganchos de la misma ruta no gastan dos usos).
 */
export function copilotGranted(req: FastifyRequest): boolean {
  const memo = (req as any)[MEMO];
  if (memo !== undefined) return memo;
  const ok = check(req);
  (req as any)[MEMO] = ok;
  return ok;
}

function check(req: FastifyRequest): boolean {
  const raw = req.headers[GRANT_HEADER];
  const token = typeof raw === 'string' ? raw : '';
  if (!token || token.length > 100) return false;
  const key = hash(token);
  const g = grants.get(key);
  if (!g) return false;
  if (g.expiresAt < Date.now() || g.uses <= 0) { grants.delete(key); return false; }
  const route = routeKey(req.method, req.routeOptions?.url ?? '');
  if (!g.routes.has(route) || !grantable(route)) return false;
  if (g.userId !== req.user?.id || !req.sessionId || g.sessionId !== req.sessionId) return false;
  if (g.actionId !== req.headers['x-copilot-action']) return false;
  g.uses--;
  if (g.uses <= 0) grants.delete(key);
  return true;
}

/** Para las pruebas: cuántos permisos vivos hay. */
export const liveGrants = () => grants.size;
