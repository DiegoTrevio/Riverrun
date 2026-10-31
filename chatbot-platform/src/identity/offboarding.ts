/**
 * Bajas: al desactivar o borrar a alguien se va con esa persona lo que creó y sigue abierto. Sus llaves de API se
 * revocan, sus webhooks se pausan con el motivo y sus invitaciones pendientes se cancelan. Nada de eso revive si la
 * reactivan. Se llama antes de borrarla: después, `created_by` e `invited_by` quedan en nulo.
 */
import { query, queryOne, withTransaction } from '../db.js';
import { disconnectStaff, syncStaffEvent } from '../integrations/staff-calendars.js';
import { logEvent } from '../logs.js';

export type OffboardingSummary = { api_keys: number; webhooks: number; invitations: number; appointments?: number };

/** Lo que creó y sigue activo: lo que se iría con la baja. */
export async function offboardingSummary(userId: string): Promise<OffboardingSummary> {
  return (await queryOne<OffboardingSummary>(
    `SELECT (SELECT count(*)::int FROM api_keys WHERE created_by = $1 AND revoked_at IS NULL) AS api_keys,
            (SELECT count(*)::int FROM webhook_endpoints WHERE created_by = $1 AND active) AS webhooks,
            (SELECT count(*)::int FROM account_invitations WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL) AS invitations`,
    [userId],
  ))!;
}

/**
 * `leaving`: deja la cuenta (desactivada, borrada o movida a otra): además, su calendario personal se desconecta y sus
 * citas futuras quedan sin asignar (ID-17), para que su Google u Outlook ya no reciba las citas del negocio. Al bajarle el
 * rol sigue en el equipo y su calendario se queda.
 */
export async function offboardUser(userId: string, name: string, o: { leaving?: boolean } = {}): Promise<OffboardingSummary> {
  const summary = await withTransaction(async (client) => {
    const keys = await client.query(`UPDATE api_keys SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL`, [userId]);
    const hooks = await client.query(`UPDATE webhook_endpoints SET active = false, disabled_reason = $2 WHERE created_by = $1 AND active`, [
      userId,
      `Lo creó ${name}, que ya no está en el equipo`,
    ]);
    const invites = await client.query(`UPDATE account_invitations SET revoked_at = now() WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [userId]);
    return { api_keys: keys.rowCount ?? 0, webhooks: hooks.rowCount ?? 0, invitations: invites.rowCount ?? 0, appointments: 0 };
  });
  if (o.leaving !== false) summary.appointments = await releaseCalendar(userId);
  return summary;
}

/** Quita sus citas futuras de su calendario personal, las deja sin asignar y desconecta el calendario. */
async function releaseCalendar(userId: string): Promise<number> {
  const future = await query<{ id: string; account_id: string }>(
    `UPDATE appointments SET assigned_user_id = NULL WHERE assigned_user_id = $1 AND starts_at > now() RETURNING id, account_id`, [userId]);
  // Lo que ya estaba copiado en su calendario se borra de ahí mientras todavía hay permiso (sin asignar, la cita se quita).
  for (const a of future.slice(0, 200)) {
    await syncStaffEvent({ appointment_id: a.id }).catch((e) =>
      logEvent({ level: 'warn', source: 'admin', message: `No se pudo quitar una cita del calendario de quien dejó el equipo: ${e?.message ?? e}`, accountId: a.account_id }));
  }
  await disconnectStaff(userId).catch(async (e) => {
    // Revocar el permiso en Google falló: igual se borra aquí, para que ya no se use.
    await query('DELETE FROM staff_calendars WHERE user_id = $1', [userId]);
    await logEvent({ level: 'warn', source: 'admin', message: `No se pudo revocar el calendario de quien dejó el equipo (se desconectó aquí): ${e?.message ?? e}` });
  });
  return future.length;
}
