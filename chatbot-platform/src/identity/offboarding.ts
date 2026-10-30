/**
 * Bajas: al desactivar o borrar a alguien se va con esa persona lo que creó y sigue abierto. Sus llaves de API se
 * revocan, sus webhooks se pausan con el motivo y sus invitaciones pendientes se cancelan. Nada de eso revive si la
 * reactivan. Se llama antes de borrarla: después, `created_by` e `invited_by` quedan en nulo.
 */
import { queryOne, withTransaction } from '../db.js';

export type OffboardingSummary = { api_keys: number; webhooks: number; invitations: number };

/** Lo que creó y sigue activo: lo que se iría con la baja. */
export async function offboardingSummary(userId: string): Promise<OffboardingSummary> {
  return (await queryOne<OffboardingSummary>(
    `SELECT (SELECT count(*)::int FROM api_keys WHERE created_by = $1 AND revoked_at IS NULL) AS api_keys,
            (SELECT count(*)::int FROM webhook_endpoints WHERE created_by = $1 AND active) AS webhooks,
            (SELECT count(*)::int FROM account_invitations WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL) AS invitations`,
    [userId],
  ))!;
}

export async function offboardUser(userId: string, name: string): Promise<OffboardingSummary> {
  return withTransaction(async (client) => {
    const keys = await client.query(`UPDATE api_keys SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL`, [userId]);
    const hooks = await client.query(`UPDATE webhook_endpoints SET active = false, disabled_reason = $2 WHERE created_by = $1 AND active`, [
      userId,
      `Lo creó ${name}, que ya no está en el equipo`,
    ]);
    const invites = await client.query(`UPDATE account_invitations SET revoked_at = now() WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [userId]);
    return { api_keys: keys.rowCount ?? 0, webhooks: hooks.rowCount ?? 0, invitations: invites.rowCount ?? 0 };
  });
}
