/**
 * La cuenta y su dueño. Transferir: el dueño (o el superadministrador con `?account_id`) la pasa a otro administrador
 * activo de la cuenta con su correo verificado y su verificación en dos pasos. El cambio es una sola escritura
 * condicionada: si el destino dejó de cumplir o la cuenta cambió de dueño mientras tanto, no se aplica.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, notFound, requireRole, targetAccount } from '../access.js';
import { query } from '../db.js';
import { notifyUser } from '../identity/notices.js';
import { accountOwner, ownerStepUp } from '../identity/ownership.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

const NOT_ELIGIBLE = 'Solo puedes transferirla a un administrador con su correo verificado y su verificación en dos pasos activa';

export async function accountRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

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
