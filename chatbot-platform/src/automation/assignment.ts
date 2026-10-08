/**
 * Reparto por turnos (round robin) de conversaciones y avisos entre las personas del equipo.
 * El turno se guarda por cuenta y por "reparto" (transferencias, cada regla…): se le da a quien sigue después de la
 * última persona elegida, así que si alguien se desactiva o se ausenta el orden no se descompone.
 */
import { query, queryOne, withTransaction } from '../db.js';
import { logEvent } from '../logs.js';

export interface Candidate {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string;
  notify_whatsapp: boolean;
}

/** Personas del equipo que pueden recibir: activas y disponibles, del rol y (si se pidió) de la lista. */
export async function eligibleUsers(accountId: string, o: { roles?: string[]; userIds?: string[] } = {}): Promise<Candidate[]> {
  return query<Candidate>(
    `SELECT id, name, email, role, phone, notify_whatsapp FROM users
      WHERE account_id = $1 AND active AND available AND role = ANY($2::text[]) AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      ORDER BY id`,
    [accountId, o.roles?.length ? o.roles : ['agent', 'admin'], o.userIds?.length ? o.userIds : null],
  );
}

/** Siguiente persona en el turno. Seguro con varios procesos: el puntero se bloquea mientras se decide. */
export async function nextInTurn(accountId: string, scope: string, candidates: Candidate[]): Promise<Candidate | null> {
  if (!candidates.length) return null;
  return withTransaction(async (client) => {
    await client.query(`INSERT INTO round_robin (account_id, scope) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [accountId, scope]);
    const row = (await client.query<{ last_user_id: string | null }>(`SELECT last_user_id FROM round_robin WHERE account_id = $1 AND scope = $2 FOR UPDATE`, [accountId, scope])).rows[0];
    const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
    const pick = (row?.last_user_id && sorted.find((c) => c.id.localeCompare(row.last_user_id!) > 0)) || sorted[0];
    await client.query(`UPDATE round_robin SET last_user_id = $3, updated_at = now() WHERE account_id = $1 AND scope = $2`, [accountId, scope, pick.id]);
    return pick;
  });
}

/** Cómo llegó la conversación a la persona (se guarda en el historial para las estadísticas por persona). */
export type AssignSource = 'round_robin' | 'manual' | 'takeover' | 'api';

/**
 * Deja la conversación asignada a esa persona. Solo cuenta cuando cambia de persona: cada cambio queda en el historial
 * (quién, cuándo y cómo), así las estadísticas incluyen también las conversaciones que se reasignaron.
 */
export async function setAssignee(conversationId: string, userId: string | null, source: AssignSource = 'manual', reason = '') {
  return withTransaction(async (client) => {
    const row = (await client.query<{ id: string; account_id: string; assigned_user_id: string | null }>(
      `UPDATE conversations SET assigned_user_id = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END
        WHERE id = $1 AND assigned_user_id IS DISTINCT FROM $2::uuid
        RETURNING id, account_id, assigned_user_id`,
      [conversationId, userId],
    )).rows[0] ?? null;
    if (row?.assigned_user_id) {
      await client.query(
        `INSERT INTO conversation_assignments (account_id, conversation_id, user_id, source, reason) VALUES ($1, $2, $3, $4, $5)`,
        [row.account_id, row.id, row.assigned_user_id, source, reason.slice(0, 200)],
      );
    }
    return row;
  });
}

/** Asigna por turnos. Devuelve a la persona (o null si no hay nadie disponible). */
export async function assignRoundRobin(conv: { id: string; account_id: string }, o: { scope: string; roles?: string[]; userIds?: string[]; reason: string }): Promise<Candidate | null> {
  const user = await nextInTurn(conv.account_id, o.scope, await eligibleUsers(conv.account_id, { roles: o.roles, userIds: o.userIds }));
  if (!user) {
    await logEvent({ level: 'warn', source: 'engine', message: `Sin nadie disponible para asignar (${o.reason})`, accountId: conv.account_id, conversationId: conv.id });
    return null;
  }
  await setAssignee(conv.id, user.id, 'round_robin', o.reason);
  await logEvent({ level: 'info', source: 'engine', message: `Conversación asignada a ${user.name || user.email} por turnos (${o.reason})`, accountId: conv.account_id, conversationId: conv.id });
  return user;
}
