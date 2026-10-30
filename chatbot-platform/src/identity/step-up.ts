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

/** Gancho de las rutas con sesión (después de requireAuth). */
export async function stepUpHook(req: FastifyRequest, reply: FastifyReply) {
  if (req.routeOptions.config?.stepUp && !hasRecentMfa(req)) return reply.code(403).send({ error: MESSAGE, code: 'step_up' });
}

/** Lo mismo dentro de una ruta, cuando solo algunos cambios lo piden. */
export function assertRecentMfa(req: FastifyRequest): void {
  if (!hasRecentMfa(req)) throw new HttpError(403, MESSAGE, undefined, { code: 'step_up' });
}
