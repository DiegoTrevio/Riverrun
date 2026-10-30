/**
 * Verificación en dos pasos al entrar. Ninguna puerta (contraseña, Google, registro, invitación) abre la sesión: dejan
 * una cookie de reto (firmada, 15 minutos) y la sesión se abre cuando llega el código de la app o uno de recuperación.
 * La primera vez el reto es para configurar la app. Solo este módulo abre sesiones.
 */
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clearCookieOpts, cookieName, createSession, passwordVersion, sessionLimits, type SessionVia } from '../auth.js';
import { mailBrand } from '../brands.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { decryptSecret, encryptSecret, hmac, safeEqual } from '../secret.js';
import * as store from '../store/index.js';
import type { Role, User } from '../types.js';
import { browserOf, noteDevice, trustDevice, trustedDeviceFor } from './devices.js';
import { notifyUser } from './notices.js';
import { qrDataUri } from './qr.js';
import { countHit, LIMITS } from './rate-limit.js';
import { isRecoveryCodeShape, useRecoveryCode } from './recovery-codes.js';
import { matchTotp, newTotpSecret, otpauthUri } from './totp.js';

const CHALLENGE_MS = 15 * 60_000;

export type ChallengePurpose = 'verify' | 'enroll';
export interface Challenge { uid: string; pv: string; via: SessionVia; purpose: ChallengePurpose; cid: string; exp: number }

/** El usuario del reto con lo que hace falta para verificar (nunca sale en una respuesta). */
export type ChallengeUser = User & {
  password_hash: string;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_pending_at: Date | null;
  totp_enabled_at: Date | null;
  totp_last_step: number;
  mfa_locked_until: Date | null;
};

type SessionUser = { id: string; role: Role; password_hash: string };

const cookieOpts = (maxAgeMs: number) => ({ httpOnly: true, sameSite: 'strict' as const, secure: config.secureCookies, path: '/', maxAge: Math.floor(maxAgeMs / 1000) });

export function readChallenge(req: FastifyRequest): Challenge | null {
  const token = req.cookies?.[cookieName('cp_mfa')];
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(`mfa-challenge:${payload}`))) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(c.exp > Date.now() && typeof c.uid === 'string' && typeof c.pv === 'string' && typeof c.cid === 'string' && ['verify', 'enroll'].includes(c.purpose))) return null;
    return c as Challenge;
  } catch {
    return null;
  }
}

export function clearChallenge(reply: FastifyReply) {
  reply.clearCookie(cookieName('cp_mfa'), clearCookieOpts());
}

/** Abre la sesión (registrada en user_sessions) y pone su cookie. `mfaAt`: cuándo escribió el código (null si no). */
async function openSession(reply: FastifyReply, user: SessionUser, via: SessionVia, mfaAt: Date | null): Promise<string> {
  const req = reply.request;
  const { maxMs } = sessionLimits(user.role);
  const expires = new Date(Date.now() + maxMs);
  const sid = (await store.createUserSession({ userId: user.id, expires, via, mfaAt, userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 300), ip: String(req?.ip ?? '').slice(0, 64) })).id;
  reply.setCookie(cookieName('cp_session'), createSession(user.id, user.password_hash, sid, expires.getTime()), cookieOpts(maxMs));
  return sid;
}

/**
 * La contraseña (o Google) ya se comprobó: deja el reto del segundo paso. Responde `{ mfa: 'verify' }` si la persona ya
 * tiene la app configurada y `{ mfa: 'enroll' }` si todavía no.
 */
export async function beginLogin(reply: FastifyReply, user: SessionUser & { totp_enabled_at?: Date | null }, via: SessionVia): Promise<{ mfa: ChallengePurpose } | { ok: true }> {
  // Dispositivo recordado (nunca el del superadmin): entra sin código, pero sin verificación reciente.
  if (user.totp_enabled_at && (await trustedDeviceFor(reply.request, user))) {
    await openSession(reply, user, via, null);
    return { ok: true };
  }
  const purpose: ChallengePurpose = user.totp_enabled_at ? 'verify' : 'enroll';
  const c: Challenge = { uid: user.id, pv: passwordVersion(user.password_hash), via, purpose, cid: crypto.randomBytes(12).toString('base64url'), exp: Date.now() + CHALLENGE_MS };
  const payload = Buffer.from(JSON.stringify(c)).toString('base64url');
  reply.setCookie(cookieName('cp_mfa'), `${payload}.${hmac(`mfa-challenge:${payload}`)}`, cookieOpts(CHALLENGE_MS));
  return { mfa: purpose };
}

/** El reto vigente y su usuario: activo, con la cuenta activa y con la misma contraseña que cuando empezó. */
export async function challengeUser(req: FastifyRequest): Promise<{ challenge: Challenge; user: ChallengeUser } | null> {
  const challenge = readChallenge(req);
  if (!challenge) return null;
  const user = await loadMfaUser(challenge.uid);
  if (!user || !safeEqual(passwordVersion(user.password_hash), challenge.pv)) return null;
  return { challenge, user };
}

/** El usuario (activo, con su cuenta activa) con sus datos de verificación. Nunca sale en una respuesta. */
export async function loadMfaUser(id: string): Promise<ChallengeUser | null> {
  const base = await store.getSessionUser(id);
  if (!base) return null;
  const extra = await queryOne<{ totp_secret: string | null; totp_pending: string | null; totp_pending_at: Date | null; totp_enabled_at: Date | null; totp_last_step: string; mfa_locked_until: Date | null }>(
    `SELECT totp_secret, totp_pending, totp_pending_at, totp_enabled_at, totp_last_step, mfa_locked_until FROM users WHERE id = $1`,
    [base.id],
  );
  return extra ? { ...base, ...extra, totp_last_step: Number(extra.totp_last_step) } : null;
}

/** Intentos con el código en este reto (5 como máximo; después hay que volver a escribir la contraseña). */
export const challengeKey = (c: Challenge) => `mfa-challenge:${c.cid}`;

/** Un reto que ya abrió sesión no vuelve a servir. */
export async function burnChallenge(c: Challenge) {
  await query(
    `INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (key) DO UPDATE SET hits = $2, expires_at = now() + make_interval(secs => $3)`,
    [challengeKey(c), LIMITS.codePerChallenge, CHALLENGE_MS / 1000],
  );
}

/**
 * ¿El código es bueno? Primero como código de la app (cada paso sirve una sola vez, también con dos peticiones a la vez)
 * y, si tiene la forma de uno de recuperación, como código de recuperación (avisa por correo).
 */
export async function verifyUserCode(user: ChallengeUser, code: string): Promise<{ result: 'ok' | 'bad' | 'locked'; recoveryRemaining?: number }> {
  if (user.mfa_locked_until && new Date(user.mfa_locked_until).getTime() > Date.now()) return { result: 'locked' };
  const secret = user.totp_secret ? decryptSecret(user.totp_secret) : null;
  if (user.totp_secret && !secret) await logEvent({ level: 'error', source: 'system', message: `No se pudo leer el secreto de verificación de ${user.email} (¿cambió SESSION_SECRET sin re-cifrar?)`, accountId: user.account_id ?? undefined });
  const step = secret ? matchTotp(secret, code) : null;
  if (step !== null) {
    const used = await queryOne(`UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2 RETURNING id`, [user.id, step]);
    if (used) return { result: 'ok' };
    return wrongCode(user);
  }
  if (isRecoveryCodeShape(code)) {
    const remaining = await useRecoveryCode(user.id, code);
    if (remaining !== null) {
      void notifyUser(user, 'recovery_used', { remaining });
      return { result: 'ok', recoveryRemaining: remaining };
    }
  }
  return wrongCode(user);
}

/** Un código malo más: con 10 en una hora la verificación se bloquea una hora y la persona se entera por correo. */
async function wrongCode(user: ChallengeUser): Promise<{ result: 'bad' | 'locked' }> {
  const hits = await countHit(`mfa-user:${user.id}`, LIMITS.codePerUser.windowMs);
  if (hits < LIMITS.codePerUser.max) return { result: 'bad' };
  // Bloquea y avisa solo quien llega justo al tope: con muchos códigos a la vez llega un solo correo.
  if (hits === LIMITS.codePerUser.max) {
    await query(`UPDATE users SET mfa_locked_until = now() + make_interval(secs => $2) WHERE id = $1`, [user.id, LIMITS.mfaLockMs / 1000]);
    await logEvent({ level: 'warn', source: 'system', message: `Verificación en dos pasos bloqueada una hora por códigos equivocados: ${user.email}`, accountId: user.account_id ?? undefined });
    void notifyUser(user, 'mfa_locked');
  }
  return { result: 'locked' };
}

/** Cuánto se vuelve a mostrar el mismo secreto pendiente; después se cambia, para que nadie deje uno preparado. */
const PENDING_MS = 60 * 60_000;

/**
 * El secreto que se está configurando: el mismo si hay uno pendiente de la última hora (otra pestaña, recargar, el reto
 * venció mientras instalaba la app); si no, uno nuevo.
 */
export async function startEnrollment(user: ChallengeUser): Promise<{ secret: string; otpauth: string; qr: string }> {
  const fresh = user.totp_pending_at && Date.now() - new Date(user.totp_pending_at).getTime() < PENDING_MS;
  let secret = user.totp_pending && fresh ? decryptSecret(user.totp_pending) : null;
  if (!secret) {
    secret = newTotpSecret();
    await query(`UPDATE users SET totp_pending = $2, totp_pending_at = now() WHERE id = $1`, [user.id, encryptSecret(secret)]);
  }
  const issuer = (await mailBrand(user.account_id)).fromName ?? 'Panel de Chatbots';
  const otpauth = otpauthUri({ issuer, account: user.email, secret });
  return { secret, otpauth, qr: qrDataUri(otpauth) };
}

/** Activa el secreto pendiente si el código es de él. El paso usado queda anotado (no vuelve a servir). */
export async function confirmEnrollment(userId: string, code: string): Promise<boolean> {
  const row = await queryOne<{ totp_pending: string | null }>(`SELECT totp_pending FROM users WHERE id = $1`, [userId]);
  const secret = row?.totp_pending ? decryptSecret(row.totp_pending) : null;
  const step = secret ? matchTotp(secret, code) : null;
  if (step === null) return false;
  const done = await queryOne(
    `UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_pending_at = NULL, totp_enabled_at = now(), totp_last_step = $2, mfa_locked_until = NULL, updated_at = now()
      WHERE id = $1 AND totp_pending = $3 RETURNING id`,
    [userId, step, row!.totp_pending],
  );
  return !!done;
}

/**
 * El código fue bueno: se borra el reto y se abre la sesión con la verificación de este momento. Si entra desde un
 * dispositivo que no había usado, le avisa por correo; con `remember` (nunca el superadmin) lo recuerda 30 días.
 */
export async function finishChallenge(reply: FastifyReply, user: ChallengeUser, challenge: Challenge, o: { remember?: boolean } = {}): Promise<string> {
  clearChallenge(reply);
  await burnChallenge(challenge);
  const device = await noteDevice(reply.request, reply, user.id);
  if (device.isNew && !device.first) void notifyUser(user, 'new_device', { device: browserOf(String(reply.request.headers['user-agent'] ?? '')), ip: reply.request.ip });
  if (o.remember && user.role !== 'superadmin') await trustDevice(reply, user.id, device.deviceHash);
  return openSession(reply, user, challenge.via, new Date());
}

/** Cambió su contraseña en Mi perfil: sesión nueva (las demás ya se cerraron) con la verificación que traía. */
export async function renewSessionAfterPasswordChange(reply: FastifyReply, user: SessionUser, mfaAt: Date | null): Promise<string> {
  return openSession(reply, user, 'password_change', mfaAt);
}
