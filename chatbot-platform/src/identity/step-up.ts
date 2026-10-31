/**
 * Verificación reciente: las acciones delicadas piden el código otra vez si pasaron más de 15 minutos desde el último
 * en esta sesión. Una ruta se marca con `config: { stepUp: true }`; las que dependen de lo que cambian llaman a
 * `assertRecentMfa`. El panel responde a `code: 'step_up'` pidiendo el código y repitiendo la acción.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../access.js';

export const STEP_UP_MS = 15 * 60_000;
const MESSAGE = 'Escribe tu código de verificación para continuar';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** La acción pide el código si el último tiene más de 15 minutos. */
    stepUp?: boolean;
  }
}

/** Para marcar una ruta: `api.post(url, { ...admins, ...stepUp }, handler)`. */
export const stepUp = { config: { stepUp: true } };

export function hasRecentMfa(req: FastifyRequest): boolean {
  return !!req.mfaAt && Date.now() - new Date(req.mfaAt).getTime() < STEP_UP_MS;
}

/**
 * La petición la hace el Copiloto con la sesión de la persona (bajos de la 2c): una acción delicada o del dueño nunca la
 * hace él, aunque la persona haya escrito su código hace un momento. Marcarse como Copiloto solo puede quitar permisos.
 */
export const fromCopilot = (req: FastifyRequest) => !!(req.headers['x-copilot'] || req.headers['x-copilot-action']);
export const COPILOT_BLOCKED = 'El Copiloto no hace esta acción: hazla tú desde el panel.';

/** Gancho de las rutas con sesión (después de requireAuth). */
export async function stepUpHook(req: FastifyRequest, reply: FastifyReply) {
  if (!req.routeOptions.config?.stepUp) return;
  if (fromCopilot(req)) return reply.code(403).send({ error: COPILOT_BLOCKED, code: 'copilot_blocked' });
  if (!hasRecentMfa(req)) return reply.code(403).send({ error: MESSAGE, code: 'step_up' });
}

/** Lo mismo dentro de una ruta, cuando solo algunos cambios lo piden. */
export function assertRecentMfa(req: FastifyRequest): void {
  if (fromCopilot(req)) throw new HttpError(403, COPILOT_BLOCKED, undefined, { code: 'copilot_blocked' });
  if (!hasRecentMfa(req)) throw new HttpError(403, MESSAGE, undefined, { code: 'step_up' });
}
