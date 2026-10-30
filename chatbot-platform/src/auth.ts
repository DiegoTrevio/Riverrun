import crypto from 'node:crypto';
import net from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { query } from './db.js';
import { logEvent } from './logs.js';
import { HttpError } from './access.js';
import { assertPasswordAllowed } from './identity/passwords.js';
import { hmac, safeEqual } from './secret.js';
import * as store from './store/index.js';
import type { Role, User } from './types.js';


/* ------------------------------ Contraseñas ------------------------------ */

/**
 * scrypt con los parámetros que recomienda OWASP (N=2^15, r=8, p=3: unos 32 MiB por cálculo), guardados dentro del hash
 * para poder subirlos después. Los hashes de antes (`scrypt$sal$hash`, con los parámetros por omisión de Node) se siguen
 * aceptando y se recalculan al entrar. `PASSWORD_HASH_COST=test` baja el costo solo para la suite.
 */
const COST = { standard: { ln: 15, r: 8, p: 3 }, test: { ln: 10, r: 8, p: 1 } } as const;
const LEGACY = { ln: 14, r: 8, p: 1 };
type Cost = { ln: number; r: number; p: number };
const target = (): Cost => COST[config.passwordHashCost];

// A lo más 4 cálculos a la vez y 64 esperando: una avalancha de intentos no agota la memoria del servidor.
const MAX_RUNNING = 4;
const MAX_WAITING = 64;
let running = 0;
const waiting: (() => void)[] = [];
async function scrypt(pw: string, salt: Buffer, len: number, c: Cost): Promise<Buffer> {
  if (running < MAX_RUNNING) running++;
  else {
    if (waiting.length >= MAX_WAITING) throw new HttpError(503, 'Hay muchos intentos, prueba en unos segundos');
    await new Promise<void>((resolve) => waiting.push(resolve)); // el que termina le pasa su lugar
  }
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      crypto.scrypt(pw, salt, len, { N: 2 ** c.ln, r: c.r, p: c.p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** Parámetros y partes de un hash guardado, o null si no es uno válido (o pide un costo fuera de rango). */
function parseHash(stored: string): { cost: Cost; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3) return { cost: LEGACY, salt: Buffer.from(parts[1], 'base64'), hash: Buffer.from(parts[2], 'base64') };
  if (parts.length !== 4) return null;
  const m = /^ln=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]);
  if (!m) return null;
  const cost = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  if (cost.ln < 10 || cost.ln > 20 || cost.r < 1 || cost.r > 16 || cost.p < 1 || cost.p > 16) return null;
  return { cost, salt: Buffer.from(parts[2], 'base64'), hash: Buffer.from(parts[3], 'base64') };
}

export async function hashPassword(password: string): Promise<string> {
  const c = target();
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, c);
  return `scrypt$ln=${c.ln},r=${c.r},p=${c.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored);
  if (!h || !h.salt.length || !h.hash.length) return false;
  const got = await scrypt(password, h.salt, h.hash.length, h.cost);
  return crypto.timingSafeEqual(got, h.hash);
}

/** El hash no usa los parámetros vigentes: se recalcula la próxima vez que la persona entra. */
export function needsRehash(stored: string): boolean {
  const h = parseHash(stored);
  const c = target();
  return !h || stored.split('$').length !== 4 || h.cost.ln !== c.ln || h.cost.r !== c.r || h.cost.p !== c.p;
}

/* ------------------------------ Sesiones ------------------------------ */

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Nombre de una cookie del panel. Con HTTPS lleva el prefijo `__Host-`: el navegador exige Secure, Path=/ y ningún
 * dominio, así otra página del mismo dominio (o un subdominio) no puede ponerla ni pisarla.
 */
export function cookieName(base: 'cp_session' | 'cp_mfa' | 'cp_trust' | 'cp_device', secure = config.secureCookies): string {
  return secure ? `__Host-${base}` : base;
}

/** Cuánto dura una sesión: se cierra tras `idleMs` sin usar el panel y, aunque se use, a los `maxMs`. */
export function sessionLimits(role: Role): { idleMs: number; maxMs: number } {
  return role === 'superadmin' ? { idleMs: 30 * MIN, maxMs: 12 * HOUR } : { idleMs: 12 * HOUR, maxMs: 7 * 24 * HOUR };
}

/** Huella de la contraseña: al cambiarla, las sesiones anteriores dejan de valer. */
export const passwordVersion = (passwordHash: string) => hmac(`pv:${passwordHash}`).slice(0, 16);

/** `sid`: la sesión registrada en `user_sessions`. La firma lleva su prefijo, como el resto de los HMAC. */
export function createSession(userId: string, passwordHash: string, sid: string, exp: number) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, pv: passwordVersion(passwordHash), exp, sid })).toString('base64url');
  return `${payload}.${hmac(`session:${payload}`)}`;
}

/** Una cookie sin `sid` (de antes de registrar sesiones) no se acepta: no se podría cerrar desde el servidor. */
export function readSession(token: string | undefined): { uid: string; pv: string; sid: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(`session:${payload}`))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(data.exp > Date.now() && typeof data.uid === 'string' && typeof data.pv === 'string' && typeof data.sid === 'string')) return null;
    return { uid: data.uid, pv: data.pv, sid: data.sid };
  } catch {
    return null;
  }
}

export type SessionVia = 'password' | 'google' | 'invite' | 'signup' | 'password_change';

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(cookieName('cp_session'), { path: '/' });
}

/** La sesión de esta petición (para cerrarla al salir). */
export const currentSession = (req: FastifyRequest) => readSession(req.cookies?.[cookieName('cp_session')]);

/** Autenticación del panel: carga el usuario en cada petición (si se desactiva, pierde acceso al instante). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const session = currentSession(req);
  const row = session ? await store.getSessionUser(session.uid) : null;
  if (!row || !safeEqual(passwordVersion(row.password_hash), session!.pv)) return reply.code(401).send({ error: 'No autenticado' });
  // La sesión debe seguir abierta: cerrar sesión (aquí o desde otro dispositivo) la invalida al momento, y se cierra sola
  // tras el tiempo sin uso de su rol.
  const state = await store.touchUserSession(session!.sid, row.id, sessionLimits(row.role).idleMs);
  if (state.state === 'idle') return reply.code(401).send({ error: 'Tu sesión se cerró por inactividad', code: 'session_idle' });
  if (state.state !== 'ok') return reply.code(401).send({ error: 'No autenticado' });
  const { password_hash, ...user } = row;
  void password_hash;
  req.user = user;
  req.sessionId = session!.sid;
  req.mfaAt = state.mfaAt;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
    /** Sesión registrada de la petición. */
    sessionId: string | null;
    /** Cuándo escribió el código de verificación por última vez en esta sesión (null: entró con dispositivo recordado). */
    mfaAt: Date | null;
  }
}

// Para un correo que no existe se calcula igual un hash (con los parámetros vigentes): no se nota por tiempos.
const DUMMY_HASH = `scrypt$ln=${target().ln},r=${target().r},p=${target().p}$AAAAAAAAAAAAAAAAAAAAAA==$${'A'.repeat(86)}==`;

export async function login(email: string, password: string): Promise<(User & { password_hash: string }) | null> {
  const u = await store.getUserForLogin(email);
  // Siempre se calcula un hash para no revelar por tiempos si el usuario existe.
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok || !u.active || (u.account_id && !u.account_active)) return null;
  await store.touchLogin(u.id);
  const { account_active, ...user } = u;
  void account_active;
  if (needsRehash(user.password_hash)) {
    user.password_hash = await hashPassword(password);
    await store.updateUser(user.id, { password_hash: user.password_hash });
  }
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
export async function resetSuperadminPassword(email: string, given?: string): Promise<{ password: string; created: boolean }> {
  // Una contraseña escrita pasa por las mismas reglas que en el panel; la generada (24 caracteres aleatorios) no hace falta.
  if (given !== undefined) await assertPasswordAllowed(given, { email });
  const password = given ?? crypto.randomBytes(18).toString('base64url');
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
  await query(`UPDATE user_devices SET trust_hash = NULL, trusted_until = NULL WHERE user_id = $1`, [existing.id]);
  await logEvent({ level: 'warn', source: 'system', message: `Contraseña del superadministrador "${email}" restablecida desde el servidor (./riverrun admin-password); se cerraron sus sesiones` });
  return { password, created: false };
}

/* ------------------------------ Límite de intentos ------------------------------ */

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
  for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
}
setInterval(() => pruneRateLimits(), 60_000).unref();
