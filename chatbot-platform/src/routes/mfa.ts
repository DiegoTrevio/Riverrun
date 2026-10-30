/**
 * Rutas del segundo paso al entrar: escribir el código (o uno de recuperación) y, la primera vez, configurar la app. Solo
 * funcionan con la cookie de reto que deja la contraseña o Google; nunca con una sesión.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notifyUser } from '../identity/notices.js';
import { challengeKey, challengeUser, confirmEnrollment, finishChallenge, loadMfaUser, startEnrollment, verifyUserCode } from '../identity/mfa.js';
import { hasRecentMfa } from '../identity/step-up.js';
import { query } from '../db.js';
import { countHit, hitsFor, LIMITS } from '../identity/rate-limit.js';
import { replaceRecoveryCodes } from '../identity/recovery-codes.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

const CHALLENGE_WINDOW_MS = 15 * 60_000;
const Code = z.object({ code: z.string().trim().min(1, 'Escribe el código').max(40) });
const expired = (reply: FastifyReply) => reply.code(401).send({ error: 'Vuelve a escribir tu contraseña para continuar', code: 'challenge_expired' });
export const LOCKED = 'Bloqueamos la verificación por una hora por demasiados intentos. Si no fuiste tú, cambia tu contraseña.';
const wrongCode = (reply: FastifyReply) => reply.code(400).send({ error: 'El código no es correcto' });

export async function mfaPublicRoutes(app: FastifyInstance) {
  app.post('/api/login/2fa', async (req, reply) => {
    const b = parse(Code.extend({ remember: z.boolean().optional() }), req.body);
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'verify' || !found.user.totp_enabled_at) return expired(reply);
    const key = challengeKey(found.challenge);
    if ((await hitsFor(key)) >= LIMITS.codePerChallenge) return expired(reply);
    const check = await verifyUserCode(found.user, b.code);
    if (check.result === 'locked') return reply.code(429).send({ error: LOCKED });
    if (check.result !== 'ok') {
      await countHit(key, CHALLENGE_WINDOW_MS);
      return wrongCode(reply);
    }
    await finishChallenge(reply, found.user, found.challenge, { remember: b.remember });
    return { ok: true, user: await store.getUser(found.user.id), ...(check.recoveryRemaining !== undefined ? { recovery_remaining: check.recoveryRemaining } : {}) };
  });

  /** Qué pide el reto vigente (la pantalla del código no ofrece «recordar» al superadmin). */
  app.get('/api/2fa/challenge', async (req, reply) => {
    const found = await challengeUser(req);
    if (!found) return expired(reply);
    return { purpose: found.challenge.purpose, superadmin: found.user.role === 'superadmin' };
  });

  /** El QR (y la clave para escribirla a mano). Recargar o abrir otra pestaña devuelve el mismo secreto. */
  app.get('/api/2fa/enroll', async (req, reply) => {
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'enroll' || found.user.totp_enabled_at) return expired(reply);
    return { ...(await startEnrollment(found.user)), account: found.user.email };
  });

  app.post('/api/2fa/enroll', async (req, reply) => {
    const b = parse(Code, req.body);
    const found = await challengeUser(req);
    if (!found || found.challenge.purpose !== 'enroll' || found.user.totp_enabled_at) return expired(reply);
    const key = challengeKey(found.challenge);
    if ((await hitsFor(key)) >= LIMITS.codePerChallenge) return expired(reply);
    if (!(await confirmEnrollment(found.user.id, b.code))) {
      await countHit(key, CHALLENGE_WINDOW_MS);
      return wrongCode(reply);
    }
    const codes = await replaceRecoveryCodes(found.user.id);
    void notifyUser(found.user, 'mfa_enabled');
    await finishChallenge(reply, found.user, found.challenge);
    return { ok: true, user: await store.getUser(found.user.id), recovery_codes: codes };
  });
}

/** Rutas con sesión: confirmar con el código (verificación reciente) y saber si hace falta. */
export async function mfaRoutes(api: FastifyInstance) {
  api.post('/api/2fa/step-up', async (req, reply) => {
    const b = parse(Code, req.body);
    const user = await loadMfaUser(req.user.id);
    if (!user) return reply.code(401).send({ error: 'No autenticado' });
    const check = await verifyUserCode(user, b.code);
    if (check.result === 'locked') return reply.code(429).send({ error: LOCKED });
    if (check.result !== 'ok') return wrongCode(reply);
    await query(`UPDATE user_sessions SET mfa_at = now() WHERE id = $1 AND user_id = $2`, [req.sessionId, req.user.id]);
    return { ok: true, ...(check.recoveryRemaining !== undefined ? { recovery_remaining: check.recoveryRemaining } : {}) };
  });

  api.get('/api/2fa/recent', async (req) => ({ recent: hasRecentMfa(req) }));
}
