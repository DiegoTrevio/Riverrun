/**
 * Rutas del segundo paso al entrar: escribir el código (o uno de recuperación) y, la primera vez, configurar la app. Solo
 * funcionan con la cookie de reto que deja la contraseña o Google; nunca con una sesión.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notifyUser } from '../identity/notices.js';
import { challengeKey, challengeUser, confirmEnrollment, finishChallenge, loadMfaUser, sendEnrollLink, startEnrollment, useEnrollLink, verifyUserCode } from '../identity/mfa.js';
import { forgetTrustedDevices, listTrustedDevices } from '../identity/devices.js';
import { hasRecentMfa, stepUp } from '../identity/step-up.js';
import { notFound } from '../access.js';
import { query } from '../db.js';
import { logEvent } from '../logs.js';
import { countHit, LIMITS, releaseHit } from '../identity/rate-limit.js';
import { remainingRecoveryCodes, replaceRecoveryCodes } from '../identity/recovery-codes.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

const CHALLENGE_WINDOW_MS = 15 * 60_000;
const Code = z.object({ code: z.string().trim().min(1, 'Escribe el código').max(40) });
const expired = (reply: FastifyReply) => reply.code(401).send({ error: 'Vuelve a escribir tu contraseña para continuar', code: 'challenge_expired' });
export const LOCKED = 'Bloqueamos la verificación por una hora por demasiados intentos. Si no fuiste tú, cambia tu contraseña.';
/** Primer enrolamiento con solo la contraseña: hay que abrir el enlace del correo (ID-16). */
const emailRequired = (reply: FastifyReply, sent: boolean, email: string) =>
  reply.code(403).send({ error: `Te mandamos un enlace a ${maskEmail(email)} para configurar la verificación. Ábrelo en este mismo navegador.`, code: 'email_required', sent });
const maskEmail = (email: string) => email.replace(/^(.)(.*)(@.*)$/, (_, a: string, b: string, c: string) => `${a}${'•'.repeat(Math.min(b.length, 6))}${c}`);
const TOO_MANY = 'Demasiados códigos equivocados. Espera 15 minutos e inténtalo de nuevo.';
const wrongCode = (reply: FastifyReply) => reply.code(400).send({ error: 'El código no es correcto' });

export async function mfaPublicRoutes(app: FastifyInstance) {
  app.post('/api/login/2fa', async (req, reply) => {
    const b = parse(Code.extend({ remember: z.boolean().optional() }), req.body);
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'verify' || !found.user.totp_enabled_at) return expired(reply);
    // Se cuenta antes de revisar (ID-15): muchos códigos a la vez en un reto revisan como máximo 5.
    const key = challengeKey(found.challenge);
    if ((await countHit(key, CHALLENGE_WINDOW_MS)) > LIMITS.codePerChallenge) return expired(reply);
    const check = await verifyUserCode(found.user, b.code);
    if (check.result === 'locked') return reply.code(429).send({ error: LOCKED });
    if (check.result !== 'ok') return wrongCode(reply);
    await finishChallenge(reply, found.user, found.challenge, { remember: b.remember });
    return { ok: true, user: await store.getUser(found.user.id), ...(check.recoveryRemaining !== undefined ? { recovery_remaining: check.recoveryRemaining } : {}) };
  });

  /** Qué pide el reto vigente (la pantalla del código no ofrece «recordar» al superadmin). */
  app.get('/api/2fa/challenge', async (req, reply) => {
    const found = await challengeUser(req);
    if (!found) return expired(reply);
    return { purpose: found.challenge.purpose, superadmin: found.user.role === 'superadmin' };
  });

  /**
   * El QR (y la clave para escribirla a mano). Recargar o abrir otra pestaña devuelve el mismo secreto. Si el correo no se
   * ha comprobado en este reto (entró solo con la contraseña), primero manda el enlace al correo (ID-16).
   */
  app.get('/api/2fa/enroll', async (req, reply) => {
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'enroll' || found.user.totp_enabled_at) return expired(reply);
    if (!found.challenge.ev) return emailRequired(reply, await sendEnrollLink(found.user), found.user.email);
    return { ...(await startEnrollment(found.user)), account: found.user.email };
  });

  /** «Mandar otro enlace». */
  app.post('/api/2fa/enroll/resend', async (req, reply) => {
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'enroll' || found.user.totp_enabled_at) return expired(reply);
    if (found.challenge.ev) return { ok: true, sent: false };
    return { ok: true, sent: await sendEnrollLink(found.user) };
  });

  /** El enlace del correo, abierto en el navegador que tiene el reto: desde ahí se configura la app. */
  app.post('/api/2fa/enroll/link', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.body);
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'enroll' || found.user.totp_enabled_at) {
      return reply.code(400).send({ error: 'Abre el enlace en el mismo navegador donde escribiste tu contraseña (o vuelve a entrar ahí y pide otro).', code: 'other_browser' });
    }
    if (!(await useEnrollLink(reply, found.challenge, token))) return reply.code(400).send({ error: 'El enlace no es válido o ya venció. Pide uno nuevo.' });
    return { ok: true };
  });

  app.post('/api/2fa/enroll', async (req, reply) => {
    const b = parse(Code, req.body);
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'enroll' || found.user.totp_enabled_at) return expired(reply);
    if (!found.challenge.ev) return emailRequired(reply, false, found.user.email);
    const key = challengeKey(found.challenge);
    if ((await countHit(key, CHALLENGE_WINDOW_MS)) > LIMITS.codePerChallenge) return expired(reply);
    if (!(await confirmEnrollment(found.user.id, b.code, { emailConfirmed: true }))) return wrongCode(reply);
    const codes = await replaceRecoveryCodes(found.user.id);
    void notifyUser(found.user, 'mfa_enabled');
    await finishChallenge(reply, found.user, found.challenge);
    return { ok: true, user: await store.getUser(found.user.id), recovery_codes: codes };
  });
}

/** Rutas con sesión: confirmar con el código (verificación reciente), saber si hace falta y Mi perfil → seguridad. */
export async function mfaRoutes(api: FastifyInstance) {
  api.post('/api/2fa/step-up', async (req, reply) => {
    const b = parse(Code, req.body);
    const user = await loadMfaUser(req.user.id);
    if (!user) return reply.code(401).send({ error: 'No autenticado' });
    // 5 códigos por sesión en 15 minutos, contados antes de revisarlos (ID-15); además del tope por persona.
    const key = `mfa-session:${req.sessionId}`;
    if ((await countHit(key, LIMITS.codePerSession.windowMs)) > LIMITS.codePerSession.max) return reply.code(429).send({ error: TOO_MANY });
    const check = await verifyUserCode(user, b.code);
    if (check.result === 'locked') return reply.code(429).send({ error: LOCKED });
    if (check.result !== 'ok') return wrongCode(reply);
    await releaseHit(key);
    await query(`UPDATE user_sessions SET mfa_at = now() WHERE id = $1 AND user_id = $2`, [req.sessionId, req.user.id]);
    return { ok: true, ...(check.recoveryRemaining !== undefined ? { recovery_remaining: check.recoveryRemaining } : {}) };
  });

  api.get('/api/2fa/recent', async (req) => ({ recent: hasRecentMfa(req) }));

  const me = async (id: string) => {
    const user = await loadMfaUser(id);
    if (!user) throw notFound('Usuario no encontrado');
    return user;
  };

  api.get('/api/me/security', async (req) => {
    const user = await me(req.user.id);
    return { totp_enabled_at: user.totp_enabled_at, recovery_remaining: await remainingRecoveryCodes(user.id), devices: await listTrustedDevices(user.id) };
  });

  /** «Generar códigos nuevos»: los anteriores dejan de servir. */
  api.post('/api/me/2fa/recovery-codes', stepUp, async (req) => {
    const user = await me(req.user.id);
    const codes = await replaceRecoveryCodes(user.id);
    void notifyUser(user, 'recovery_regenerated');
    return { recovery_codes: codes };
  });

  /** «Cambiar de app»: un secreto pendiente (el mismo si ya había uno); la app actual sirve hasta confirmar el nuevo. */
  api.post('/api/me/2fa/authenticator', stepUp, async (req) => {
    const { secret, otpauth, qr } = await startEnrollment(await me(req.user.id));
    return { secret, otpauth, qr };
  });

  api.post('/api/me/2fa/authenticator/confirm', stepUp, async (req, reply) => {
    const b = parse(Code, req.body);
    const user = await me(req.user.id);
    const key = `mfa-session:${req.sessionId}`;
    if ((await countHit(key, LIMITS.codePerSession.windowMs)) > LIMITS.codePerSession.max) return reply.code(429).send({ error: TOO_MANY });
    if (!(await confirmEnrollment(user.id, b.code))) return wrongCode(reply);
    await releaseHit(key);
    await logEvent({ level: 'info', source: 'admin', message: `${user.email} cambió su app de verificación`, accountId: user.account_id ?? undefined });
    void notifyUser(user, 'mfa_changed');
    return { ok: true };
  });

  api.delete('/api/me/devices/:id', stepUp, async (req: any) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !(await forgetTrustedDevices(req.user.id, { only: req.params.id }))) throw notFound('Dispositivo no encontrado');
    return { ok: true };
  });
}
