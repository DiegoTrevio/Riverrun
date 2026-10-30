/**
 * Dispositivos de cada persona. El conocido (cookie `cp_device`, 1 año) sirve para avisar cuando alguien entra desde uno
 * nuevo. El recordado (cookie `cp_trust`, 30 días, aparte) salta el código al entrar, nunca la contraseña, y nunca para
 * el superadministrador. Solo se guardan hashes de las cookies.
 */
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cookieName } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import type { Role } from '../types.js';

const DAY = 86_400_000;
const DEVICE_MS = 365 * DAY;
const TRUST_MS = 30 * DAY;

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const opts = (ms: number) => ({ httpOnly: true, sameSite: 'strict' as const, secure: config.secureCookies, path: '/', maxAge: Math.floor(ms / 1000) });

/** «Chrome en Windows»: suficiente para reconocer el dispositivo, sin guardar ni mostrar el navegador completo. */
export function browserOf(ua: string): string {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone o iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} en ${os}` : b;
}

/**
 * Anota el dispositivo de esta petición (y pone su cookie si no la tenía). `isNew`: esa persona no lo había usado;
 * `first`: es el primero que usa (al configurar la verificación), del que no tiene caso avisar.
 */
export async function noteDevice(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<{ isNew: boolean; first: boolean; deviceHash: string }> {
  let token = req.cookies?.[cookieName('cp_device')];
  if (!token || !/^[\w-]{43}$/.test(token)) {
    token = crypto.randomBytes(32).toString('base64url');
    reply.setCookie(cookieName('cp_device'), token, opts(DEVICE_MS));
  }
  const deviceHash = sha(token);
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
  const ip = String(req.ip ?? '').slice(0, 64);
  const row = await queryOne<{ inserted: boolean; others: number }>(
    `WITH others AS (SELECT count(*)::int AS n FROM user_devices WHERE user_id = $1 AND device_hash <> $2)
     INSERT INTO user_devices (user_id, device_hash, user_agent, ip) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen_at = now(), user_agent = EXCLUDED.user_agent, ip = EXCLUDED.ip
     RETURNING (xmax = 0) AS inserted, (SELECT n FROM others) AS others`,
    [userId, deviceHash, ua, ip],
  );
  return { isNew: !!row?.inserted, first: !!row?.inserted && row.others === 0, deviceHash };
}

/** Recuerda este dispositivo 30 días (la persona lo pidió al escribir el código). */
export async function trustDevice(reply: FastifyReply, userId: string, deviceHash: string): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`UPDATE user_devices SET trust_hash = $3, trusted_until = now() + make_interval(secs => $4) WHERE user_id = $1 AND device_hash = $2`, [userId, deviceHash, sha(token), TRUST_MS / 1000]);
  reply.setCookie(cookieName('cp_trust'), token, opts(TRUST_MS));
}

/** ¿El navegador trae un dispositivo recordado vigente de esta persona? Siempre no para el superadministrador. */
export async function trustedDeviceFor(req: FastifyRequest, user: { id: string; role: Role }): Promise<boolean> {
  if (user.role === 'superadmin') return false;
  const token = req.cookies?.[cookieName('cp_trust')];
  if (!token || !/^[\w-]{43}$/.test(token)) return false;
  const row = await queryOne(`UPDATE user_devices SET last_seen_at = now() WHERE user_id = $1 AND trust_hash = $2 AND trusted_until > now() RETURNING id`, [user.id, sha(token)]);
  return !!row;
}

/** Olvida los dispositivos recordados de una persona (o uno). Devuelve cuántos olvidó. */
export async function forgetTrustedDevices(userId: string, o: { only?: string } = {}): Promise<number> {
  const rows = await query(
    `UPDATE user_devices SET trust_hash = NULL, trusted_until = NULL WHERE user_id = $1 AND trust_hash IS NOT NULL AND ($2::uuid IS NULL OR id = $2) RETURNING id`,
    [userId, o.only ?? null],
  );
  return rows.length;
}

export async function listTrustedDevices(userId: string): Promise<{ id: string; device: string; last_seen_at: Date; trusted_until: Date }[]> {
  const rows = await query<{ id: string; user_agent: string; last_seen_at: Date; trusted_until: Date }>(
    `SELECT id, user_agent, last_seen_at, trusted_until FROM user_devices WHERE user_id = $1 AND trusted_until > now() ORDER BY last_seen_at DESC LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, device: browserOf(r.user_agent), last_seen_at: r.last_seen_at, trusted_until: r.trusted_until }));
}
