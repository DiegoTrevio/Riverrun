import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

const COOKIE = 'cp_session';
const TTL_MS = 7 * 24 * 3600 * 1000;
const secret = () => config.sessionSecret || 'dev-secret-change-me-please';

function sign(payload: string) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createSession(user: string) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.u : null;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkCredentials(user: string, password: string) {
  if (!config.adminPassword) return false;
  return safeEqual(user, config.adminUser) && safeEqual(password, config.adminPassword);
}

export function setSessionCookie(reply: FastifyReply, user: string) {
  reply.setCookie(COOKIE, createSession(user), {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secureCookies,
    path: '/',
    maxAge: TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const user = verifySession(req.cookies?.[COOKIE]);
  if (!user) return reply.code(401).send({ error: 'No autenticado' });
  (req as any).user = user;
}

/** Límite simple de intentos de login por IP. */
const attempts = new Map<string, { n: number; until: number }>();
export function loginAllowed(ip: string) {
  const a = attempts.get(ip);
  return !a || a.until < Date.now() || a.n < 8;
}
export function registerLoginFailure(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}
