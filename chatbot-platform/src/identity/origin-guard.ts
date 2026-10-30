/**
 * Peticiones de otros sitios: una página ajena (también otro subdominio del mismo dominio, al que la cookie
 * `SameSite=Strict` sí viaja) no puede usar la cookie del panel para cambiar nada. El navegador dice de dónde viene la
 * petición en `Sec-Fetch-Site`; los viejos solo mandan `Origin`. Sin ninguna de las dos (curl, integraciones) no se
 * rechaza.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cookieName } from '../auth.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const MESSAGE = 'Petición rechazada: viene de otro sitio';

export function crossSiteRejected(req: FastifyRequest): boolean {
  if (SAFE.has(req.method)) return false;
  const cookies = req.cookies ?? {};
  if (!cookies[cookieName('cp_session')] && !cookies[cookieName('cp_mfa')]) return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() !== String(req.headers.host ?? '').toLowerCase();
  } catch {
    return true; // `Origin: null` (iframes aislados, redirecciones) u otro valor opaco
  }
}

/** Gancho `onRequest` global (después de leer las cookies). El chat de la web del cliente no usa la cookie del panel. */
export async function originGuard(req: FastifyRequest, reply: FastifyReply) {
  if (req.url.startsWith('/webchat/')) return;
  if (crossSiteRejected(req)) return reply.code(403).send({ error: MESSAGE });
}
