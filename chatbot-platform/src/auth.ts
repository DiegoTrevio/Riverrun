import crypto from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { logEvent } from './logs.js';
import { hmac, safeEqual } from './secret.js';
import * as store from './store/index.js';
import type { User } from './types.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = 'cp_session';
const TTL_MS = 7 * 24 * 3600 * 1000;

/* ------------------------------ Contraseñas ------------------------------ */

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  return null;
}

/* ------------------------------ Sesiones ------------------------------ */

/** Huella de la contraseña: al cambiarla, las sesiones anteriores dejan de valer. */
const passwordVersion = (passwordHash: string) => hmac(`pv:${passwordHash}`).slice(0, 16);

/** `sid`: la sesión registrada en `user_sessions` (las cookies de antes no lo traen y valen hasta vencer). */
export function createSession(userId: string, passwordHash: string, sid?: string, exp = Date.now() + TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, pv: passwordVersion(passwordHash), exp, ...(sid ? { sid } : {}) })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function readSession(token: string | undefined): { uid: string; pv: string; sid?: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(data.exp > Date.now() && typeof data.uid === 'string' && typeof data.pv === 'string')) return null;
    return { uid: data.uid, pv: data.pv, ...(typeof data.sid === 'string' ? { sid: data.sid } : {}) };
  } catch {
    return null;
  }
}

export type SessionVia = 'password' | 'google' | 'invite' | 'signup' | 'password_change';

/** Inicia una sesión: queda registrada (se puede cerrar desde Mi perfil o al cerrar sesión) y se pone la cookie. */
export async function setSessionCookie(reply: FastifyReply, userId: string, passwordHash: string, via: SessionVia = 'password') {
  const req = reply.request;
  const expires = new Date(Date.now() + TTL_MS);
  const sid = (await store.createUserSession({ userId, expires, via, userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 300), ip: String(req?.ip ?? '').slice(0, 64) })).id;
  reply.setCookie(COOKIE, createSession(userId, passwordHash, sid, expires.getTime()), { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/', maxAge: TTL_MS / 1000 });
  return sid;
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' });
}

/** La sesión de esta petición (para cerrarla al salir). */
export const currentSession = (req: FastifyRequest) => readSession(req.cookies?.[COOKIE]);

/** Autenticación del panel: carga el usuario en cada petición (si se desactiva, pierde acceso al instante). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const session = readSession(req.cookies?.[COOKIE]);
  const row = session ? await store.getSessionUser(session.uid) : null;
  if (!row || !safeEqual(passwordVersion(row.password_hash), session!.pv)) return reply.code(401).send({ error: 'No autenticado' });
  // Una sesión registrada debe seguir abierta: cerrar sesión (aquí o desde otro dispositivo) la invalida al momento.
  if (session!.sid && !(await store.touchUserSession(session!.sid, row.id))) return reply.code(401).send({ error: 'No autenticado' });
  const { password_hash, ...user } = row;
  void password_hash;
  req.user = user;
  req.sessionId = session!.sid ?? null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
    /** Sesión registrada de la petición (null en las cookies de antes de registrar sesiones). */
    sessionId: string | null;
  }
}

export async function login(email: string, password: string): Promise<(User & { password_hash: string }) | null> {
  const u = await store.getUserForLogin(email);
  // Siempre se calcula un hash para no revelar por tiempos si el usuario existe.
  const ok = await verifyPassword(password, u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!u || !ok || !u.active || (u.account_id && !u.account_active)) return null;
  await store.touchLogin(u.id);
  const { account_active, ...user } = u;
  void account_active;
  return user;
}

/**
 * Crea el superadministrador definido en .env si todavía no existe. ADMIN_PASSWORD solo sirve para esa primera vez: si
 * cada arranque la volviera a imponer, la contraseña inicial (que quedó en .env y se vio al instalar) regresaría aunque
 * se cambiara en el panel. Para recuperar el acceso está `./riverrun admin-password` (`resetSuperadminPassword`).
 */
export async function bootstrapSuperadmin() {
  if (!config.adminPassword) return;
  // En un servidor público no se acepta la contraseña de ejemplo de .env.example.
  if (config.adminPassword.startsWith('cambia-') && config.publicBaseUrl.startsWith('https://')) {
    await logEvent({ level: 'error', source: 'system', message: 'ADMIN_PASSWORD sigue siendo la de ejemplo ("cambia-…"): no se crea el superadministrador. Cámbiala en .env (o usa ./riverrun install).' });
    return;
  }
  if (await store.getUserForLogin(config.adminUser)) return;
  await store.createUser({ account_id: null, role: 'superadmin', name: 'Administrador', email: config.adminUser, password_hash: await hashPassword(config.adminPassword) });
  await logEvent({ level: 'info', source: 'system', message: `Superadministrador "${config.adminUser}" creado desde la configuración` });
}

/**
 * Recupera el acceso del superadministrador desde el servidor: contraseña nueva (generada si no se da), cuenta activa y
 * todas sus sesiones cerradas. Si no existe, lo crea. Nunca convierte en superadministrador a otro usuario.
 */
export async function resetSuperadminPassword(email: string, password = crypto.randomBytes(18).toString('base64url')): Promise<{ password: string; created: boolean }> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const existing = await store.getUserForLogin(email);
  if (existing && existing.role !== 'superadmin') throw new Error(`${email} no es superadministrador: su contraseña no se cambia desde aquí.`);
  const hash = await hashPassword(password);
  if (!existing) {
    await store.createUser({ account_id: null, role: 'superadmin', name: 'Administrador', email, password_hash: hash });
    await logEvent({ level: 'warn', source: 'system', message: `Superadministrador "${email}" creado desde el servidor (./riverrun admin-password)` });
    return { password, created: true };
  }
  await store.updateUser(existing.id, { password_hash: hash, active: true });
  await store.revokeUserSessions(existing.id);
  await logEvent({ level: 'warn', source: 'system', message: `Contraseña del superadministrador "${email}" restablecida desde el servidor (./riverrun admin-password); se cerraron sus sesiones` });
  return { password, created: false };
}

/* ------------------------------ Límite de intentos ------------------------------ */

const attempts = new Map<string, { n: number; until: number }>();
export function loginAllowed(ip: string) {
  const a = attempts.get(ip);
  return !a || a.until < Date.now() || a.n < 8;
}
export function registerLoginFailure(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.until < now) attempts.set(ip, { n: 1, until: now + 15 * 60_000 });
  else a.n++;
}

/** Límite genérico por clave (registro, recuperación de contraseña): `max` intentos por ventana. */
const buckets = new Map<string, { n: number; until: number }>();
export function rateLimited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.until < now) {
    buckets.set(key, { n: 1, until: now + windowMs });
    return false;
  }
  b.n++;
  return b.n > max;
}

/**
 * Clave de una conexión para los límites. Una IPv6 se agrupa por su /64: quien tiene una suele tener millones, y contarlas
 * por separado deja saltarse cualquier límite cambiando de dirección.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return mapped;
  if (!net.isIPv6(ip)) return ip;
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

/** Olvida los intentos y límites cuya ventana ya pasó. Corre cada minuto (antes solo al llegar a 10,000 claves). */
export function pruneRateLimits(now = Date.now()) {
  for (const m of [attempts, buckets]) for (const [k, v] of m) if (v.until < now) m.delete(k);
}
setInterval(() => pruneRateLimits(), 60_000).unref();
