/**
 * El dueño de la cuenta: `accounts.owner_user_id`, siempre un administrador activo de ella. Si el guardado ya no lo es
 * (se fue, cambió de cuenta), lo es el administrador activo más antiguo, y queda guardado. Solo el dueño (o el
 * superadministrador) maneja el dinero, la cuenta y a los demás administradores: las rutas se marcan con `ownerOnly` u
 * `ownerStepUp` y `ownerHook` las revisa antes de pedir la verificación reciente.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../access.js';
import { query, queryOne } from '../db.js';
import type { User } from '../types.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Solo el dueño de la cuenta (o el superadministrador). */
    owner?: boolean;
  }
}

export type AccountOwner = { id: string; name: string; email: string; email_verified_at: Date | null; totp_enabled_at: Date | null };

/** Para marcar una ruta: `api.post(url, { ...admins, ...ownerStepUp }, handler)`. */
export const ownerOnly = { config: { owner: true } };
export const ownerStepUp = { config: { owner: true, stepUp: true } };

const VALID_OWNER = `EXISTS (SELECT 1 FROM users o WHERE o.id = a.owner_user_id AND o.account_id = a.id AND o.role = 'admin' AND o.active)`;

export async function accountOwner(accountId: string): Promise<AccountOwner | null> {
  const row = await queryOne<AccountOwner & { current: boolean }>(
    `SELECT u.id, u.name, u.email, u.email_verified_at, u.totp_enabled_at, coalesce(u.id = a.owner_user_id, false) AS current
       FROM accounts a JOIN users u ON u.account_id = a.id AND u.role = 'admin' AND u.active
      WHERE a.id = $1 ORDER BY coalesce(u.id = a.owner_user_id, false) DESC, u.created_at, u.id LIMIT 1`,
    [accountId],
  );
  if (!row) return null;
  const { current, ...owner } = row;
  if (!current) await query(`UPDATE accounts SET owner_user_id = $2 WHERE id = $1 AND owner_user_id IS DISTINCT FROM $2`, [accountId, owner.id]);
  return owner;
}

/** El superadministrador cuenta como dueño de cualquier cuenta. */
export async function isAccountOwner(user: Pick<User, 'id' | 'role' | 'account_id'>, accountId: string): Promise<boolean> {
  if (user.role === 'superadmin') return true;
  if (user.role !== 'admin' || user.account_id !== accountId) return false;
  return (await accountOwner(accountId))?.id === user.id;
}

async function ownerOnlyError(accountId: string | null): Promise<HttpError> {
  const owner = accountId ? await accountOwner(accountId) : null;
  return new HttpError(403, `Solo el dueño de la cuenta (${owner?.name || owner?.email || 'sin dueño'}) puede hacer esto`, undefined, { code: 'owner_only' });
}

export async function assertOwner(req: FastifyRequest, accountId: string): Promise<void> {
  if (!(await isAccountOwner(req.user, accountId))) throw await ownerOnlyError(accountId);
}

/** El primer administrador de una cuenta sin dueño válido queda como dueño. */
export async function ensureOwner(accountId: string, userId: string): Promise<void> {
  await query(`UPDATE accounts a SET owner_user_id = $2 WHERE a.id = $1 AND NOT ${VALID_OWNER}`, [accountId, userId]);
}

/** Gancho de las rutas con sesión (después de requireAuth y antes de la verificación reciente). */
export async function ownerHook(req: FastifyRequest, reply: FastifyReply) {
  if (!req.routeOptions.config?.owner || req.user.role === 'superadmin') return;
  const accountId = req.user.account_id;
  if (accountId && (await isAccountOwner(req.user, accountId))) return;
  const e = await ownerOnlyError(accountId);
  return reply.code(403).send({ error: e.message, code: 'owner_only' });
}
