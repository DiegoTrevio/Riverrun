/**
 * La cuenta, su dueño y el correo de cada quien. Cambiar el correo: se pide desde Mi perfil (con verificación
 * reciente) y se aplica al abrir el enlace que llega al correo nuevo. Transferir: el dueño (o el superadministrador con `?account_id`) la pasa a otro administrador
 * activo de la cuenta con su correo verificado y su verificación en dos pasos. El cambio es una sola escritura
 * condicionada: si el destino dejó de cumplir o la cuenta cambió de dueño mientras tanto, no se aplica.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, notFound, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { mailBrand } from '../brands.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { notifyUser } from '../identity/notices.js';
import { accountOwner, ownerStepUp } from '../identity/ownership.js';
import { stepUp } from '../identity/step-up.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { DISPOSABLE_MESSAGE, isDisposableEmail } from '../signup-guard.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

const NOT_ELIGIBLE = 'Solo puedes transferirla a un administrador con su correo verificado y su verificación en dos pasos activa';
const EMAIL_TAKEN = 'Ese correo ya tiene una cuenta';
const LINK_GONE = 'Este enlace ya no sirve. Pide el cambio otra vez desde Mi perfil.';
const HOUR = 3600_000;
const EMAIL_CHANGE_HOURS = 24;

export async function accountRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  api.put('/api/me/email', stepUp, async (req: any, reply) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email('correo inválido').max(200) }), req.body);
    if (email === req.user.email.toLowerCase()) throw new HttpError(400, 'Ese ya es tu correo');
    if (isDisposableEmail(email)) throw new HttpError(400, DISPOSABLE_MESSAGE);
    if (await store.getUserForLogin(email)) throw new HttpError(409, EMAIL_TAKEN);
    if (rateLimited(`email-change:${req.user.id}`, 5, HOUR)) return reply.code(429).send({ error: 'Ya pediste varios cambios de correo: espera una hora' });
    const token = await store.createAuthToken(req.user.id, 'change_email', EMAIL_CHANGE_HOURS * 60, email);
    const { fromName } = await mailBrand(req.user.account_id);
    await sendMail({
      fromName,
      to: email,
      subject: 'Confirma tu correo nuevo',
      text: `Hola ${req.user.name || ''},\n\nPediste que el correo de tu cuenta sea ${email}. Para confirmarlo, abre este enlace:\n\n${config.publicBaseUrl}/#/cambiar-correo/${token}\n\nEl enlace vence en ${EMAIL_CHANGE_HOURS} horas. Si no lo pediste, ignora este mensaje: tu correo no cambia.`,
    });
    await logEvent({ level: 'info', source: 'admin', message: `${req.user.email} pidió cambiar su correo a ${email}`, accountId: req.user.account_id ?? undefined });
    return { ok: true, pending: email };
  });

  api.post('/api/account/transfer', { ...admins, ...ownerStepUp }, async (req: any) => {
    const { user_id } = parse(z.object({ user_id: z.string().uuid() }), req.body);
    const accountId = await targetAccount(req.user, req.query.account_id);
    const [acc, owner, target] = await Promise.all([store.getAccount(accountId), accountOwner(accountId), store.getUser(user_id)]);
    if (!acc || !target || target.account_id !== accountId) throw notFound('Usuario no encontrado');
    if (owner?.id === target.id) throw new HttpError(400, target.id === req.user.id ? 'Ya eres el dueño' : 'Ya es el dueño de la cuenta');
    const moved = await query(
      `UPDATE accounts a SET owner_user_id = $2, updated_at = now()
        WHERE a.id = $1 AND a.owner_user_id IS NOT DISTINCT FROM $3
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.account_id = a.id AND u.role = 'admin' AND u.active
                        AND u.totp_enabled_at IS NOT NULL AND u.email_verified_at IS NOT NULL)
        RETURNING a.id`,
      [accountId, target.id, owner?.id ?? null],
    );
    if (!moved.length) {
      if ((await accountOwner(accountId))?.id !== owner?.id) throw new HttpError(409, 'La cuenta cambió de dueño mientras tanto: recarga la página');
      throw new HttpError(400, NOT_ELIGIBLE);
    }
    const actor = req.user.name || req.user.email;
    await logEvent({ level: 'info', source: 'admin', message: `${req.user.email} transfirió la cuenta a ${target.email}${owner && owner.id !== req.user.id ? ` (antes de ${owner.email})` : ''}`, accountId });
    const to = target.name || target.email;
    // Se espera a los dos avisos (nunca lanzan): es raro y así ambos salen antes de responder.
    await Promise.all([
      owner ? notifyUser({ ...owner, account_id: accountId }, 'ownership_transferred', { account: acc.name, to, by: owner.id === req.user.id ? undefined : actor }) : null,
      notifyUser(target, 'ownership_received', { account: acc.name, from: actor }),
    ]);
    return { ok: true, owner: { id: target.id, name: to } };
  });
}

/** Rutas públicas: abrir el enlace del cambio de correo (llega sin sesión, desde el correo nuevo). */
export async function accountPublicRoutes(app: FastifyInstance) {
  app.post('/api/email-change/confirm', async (req, reply) => {
    if (rateLimited(`email-change-confirm:${req.ip}`, 20, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, espera un momento' });
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), req.body);
    const changed = await withTransaction(async (client) => {
      const change = await store.lockEmailChange(token, client);
      if (!change) throw new HttpError(400, LINK_GONE);
      // Se revisa otra vez: alguien pudo tomar ese correo desde que se pidió (entonces no cambia nada).
      if ((await client.query(`SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2`, [change.email, change.user_id])).rows.length) throw new HttpError(409, EMAIL_TAKEN);
      const before = (await client.query(`SELECT id, email, name, account_id FROM users WHERE id = $1 FOR UPDATE`, [change.user_id])).rows[0];
      if (!before) throw new HttpError(400, LINK_GONE);
      await client.query(`UPDATE users SET email = $2, email_verified_at = now(), updated_at = now() WHERE id = $1`, [change.user_id, change.email]);
      // Ningún enlace de antes sirve ya (restablecer, verificar, otro cambio): todos iban al correo anterior.
      await store.invalidateAuthTokens(change.user_id, client);
      return { before, email: change.email as string };
    }).catch((e: any) => {
      if (e?.code === '23505') throw new HttpError(409, EMAIL_TAKEN); // lo tomaron en el mismo instante
      throw e;
    });
    await logEvent({ level: 'info', source: 'admin', message: `${changed.before.email} cambió su correo a ${changed.email}`, accountId: changed.before.account_id ?? undefined });
    await notifyUser(changed.before, 'email_changed', { to: changed.email }); // nunca lanza
    return { ok: true, email: changed.email };
  });
}
