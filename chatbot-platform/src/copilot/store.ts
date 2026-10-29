/**
 * Copiloto: hilos, turnos, mensajes y acciones en la base (migración 092). `rev` crece con cada alta o cambio y es el
 * cursor con el que el panel pide solo lo nuevo.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { deleteInBatches, query, queryOne } from '../db.js';
import { config } from '../config.js';

export type TurnStatus = 'running' | 'done' | 'stopped' | 'failed' | 'interrupted';
export type Risk = 'read' | 'reversible' | 'confirm';
export type ActionStatus = 'proposed' | 'executing' | 'done' | 'failed' | 'declined' | 'expired' | 'undoing' | 'undone' | 'unknown';

export interface Thread { id: string; account_id: string; user_id: string; title: string; created_at: Date; updated_at: Date; rev: string }
export interface Page { hash?: string; kind?: string; id?: string; label?: string; area?: string }
export interface Turn {
  id: string; thread_id: string; account_id: string; user_id: string; status: TurnStatus; page: Page; step_label: string; model: string;
  steps: number; tool_calls: number; input_tokens: number; cached_tokens: number; output_tokens: number; cost_usd: string;
  tainted: boolean; contact_ids: string[]; error: string; cancel_requested_at: Date | null; heartbeat_at: Date;
  started_at: Date; finished_at: Date | null; rev: string;
}
export interface StoredToolCall { id: string; name: string; arguments: string }
export interface Message {
  id: string; thread_id: string; turn_id: string | null; role: 'user' | 'assistant' | 'tool' | 'event'; content: string;
  tool_calls: StoredToolCall[] | null; tool_call_id: string | null; refs: string[]; redacted: boolean; created_at: Date; rev: string;
}
export interface Link { label: string; href: string }
/** Lo que ve quien revisa o confirma una acción: lo arma el servidor, nunca el modelo. */
export interface Preview {
  title: string; lines: string[]; quote?: string; diff?: { state: 'same' | 'removed' | 'new'; text: string }[]; warning?: string;
  /** Solo para el servidor: cómo estaba el registro al proponer (p. ej. su revisión), para no ejecutar sobre otra versión. */
  meta?: Record<string, unknown>;
}
export interface UndoStep { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; body?: unknown }
/** Receta para deshacer: comprueba que el registro siga como lo dejó la acción y aplica los pasos inversos. */
export interface UndoRecipe {
  label: string;
  check?: { url: string; pick: string[]; expect: unknown };
  steps?: UndoStep[];
  /** Deshacer especial de una herramienta (p. ej. etiquetas por contacto), con sus parámetros. */
  custom?: { tool: string; params: unknown };
}
export interface Action {
  id: string; thread_id: string; turn_id: string; account_id: string; user_id: string; tool_call_id: string; tool: string;
  args: Record<string, unknown>; args_hash: string; risk: Risk; risk_reasons: string[]; status: ActionStatus; title: string;
  preview: Preview | null; result: unknown; links: Link[]; before: unknown; after: unknown; undo: UndoRecipe | null;
  undo_until: Date | null; contact_ids: string[]; error: string; expires_at: Date | null; confirmed_at: Date | null;
  executed_at: Date | null; undone_at: Date | null; created_at: Date; updated_at: Date; rev: string;
}

type Db = Pick<pg.PoolClient, 'query'>;

/** JSON con las claves en orden: dos objetos iguales dan el mismo texto (y el mismo hash). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().filter((k) => (value as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Huella de lo que se mostró al confirmar: herramienta, argumentos y vista previa. */
export function argsHash(tool: string, args: unknown, preview: unknown): string {
  return createHash('sha256').update(stableJson({ tool, args, preview })).digest('hex').slice(0, 32);
}

// --- Hilos -----------------------------------------------------------------------------------------------------------

export async function createThread(accountId: string, userId: string, title = ''): Promise<Thread> {
  return (await queryOne<Thread>(`INSERT INTO copilot_threads (account_id, user_id, title) VALUES ($1, $2, $3) RETURNING *`, [accountId, userId, title.slice(0, 120)]))!;
}

/** Hilo de esa persona en esa cuenta; de otra persona o de otra cuenta no existe. */
export async function ownThread(id: string, userId: string, accountId: string): Promise<Thread | null> {
  return queryOne<Thread>(`SELECT * FROM copilot_threads WHERE id = $1 AND user_id = $2 AND account_id = $3`, [id, userId, accountId]);
}

export async function listThreads(userId: string, accountId: string, limit = 30) {
  return query<Thread & { status: TurnStatus | null }>(
    `SELECT t.*, (SELECT status FROM copilot_turns u WHERE u.thread_id = t.id ORDER BY started_at DESC LIMIT 1) AS status
       FROM copilot_threads t WHERE t.user_id = $1 AND t.account_id = $2 ORDER BY t.updated_at DESC LIMIT $3`,
    [userId, accountId, limit],
  );
}

export async function renameThread(id: string, title: string) {
  await query(`UPDATE copilot_threads SET title = $2, updated_at = now() WHERE id = $1`, [id, title.slice(0, 120)]);
}

export async function touchThread(id: string, title?: string) {
  await query(`UPDATE copilot_threads SET updated_at = now(), title = CASE WHEN $2::text IS NOT NULL AND title = '' THEN $2 ELSE title END WHERE id = $1`, [id, title?.slice(0, 120) ?? null]);
}

export async function deleteThread(id: string) {
  await query(`DELETE FROM copilot_threads WHERE id = $1`, [id]);
}

// --- Turnos ----------------------------------------------------------------------------------------------------------

/** Abre un turno; `null` si ya hay uno en curso en ese hilo o de esa persona (índices únicos parciales). */
export async function startTurn(thread: Thread, page: Page, model: string): Promise<Turn | null> {
  try {
    return await queryOne<Turn>(
      `INSERT INTO copilot_turns (thread_id, account_id, user_id, page, model) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [thread.id, thread.account_id, thread.user_id, JSON.stringify(page), model],
    );
  } catch (e: any) {
    if (e?.code === '23505') return null;
    throw e;
  }
}

export async function getTurn(id: string): Promise<Turn | null> {
  return queryOne<Turn>(`SELECT * FROM copilot_turns WHERE id = $1`, [id]);
}

export async function currentTurn(threadId: string): Promise<Turn | null> {
  return queryOne<Turn>(`SELECT * FROM copilot_turns WHERE thread_id = $1 ORDER BY started_at DESC LIMIT 1`, [threadId]);
}

/** Latido del turno: la etiqueta del paso en curso y la prueba de que el proceso sigue vivo. */
export async function heartbeat(id: string, label?: string) {
  await query(`UPDATE copilot_turns SET heartbeat_at = now(), step_label = COALESCE($2, step_label) WHERE id = $1 AND status = 'running'`, [id, label ?? null]);
}

export async function addUsage(id: string, u: { input: number; cached: number; output: number; cost: number }) {
  await query(
    `UPDATE copilot_turns SET steps = steps + 1, input_tokens = input_tokens + $2, cached_tokens = cached_tokens + $3, output_tokens = output_tokens + $4, cost_usd = cost_usd + $5, heartbeat_at = now() WHERE id = $1`,
    [id, u.input, u.cached, u.output, u.cost],
  );
}

export async function countToolCall(id: string) {
  await query(`UPDATE copilot_turns SET tool_calls = tool_calls + 1 WHERE id = $1`, [id]);
}

/** Marca que el turno leyó texto de clientes y qué contactos tocó (para la privacidad y el alcance). */
export async function markTurn(id: string, o: { tainted?: boolean; contactIds?: string[] }) {
  await query(
    `UPDATE copilot_turns SET tainted = tainted OR $2, contact_ids = ARRAY(SELECT DISTINCT unnest(contact_ids || $3::uuid[])) WHERE id = $1`,
    [id, !!o.tainted, o.contactIds ?? []],
  );
}

export async function finishTurn(id: string, status: Exclude<TurnStatus, 'running'>, error = '') {
  await query(`UPDATE copilot_turns SET status = $2, error = $3, step_label = '', finished_at = now() WHERE id = $1 AND status = 'running'`, [id, status, error.slice(0, 500)]);
}

export async function requestStop(id: string) {
  await query(`UPDATE copilot_turns SET cancel_requested_at = now() WHERE id = $1 AND status = 'running' AND cancel_requested_at IS NULL`, [id]);
}

export async function stopRequested(id: string): Promise<boolean> {
  return !!(await queryOne(`SELECT 1 FROM copilot_turns WHERE id = $1 AND cancel_requested_at IS NOT NULL`, [id]));
}

/** Turnos que empezó esa persona en la última hora y la cuenta en las últimas 24 h (límites de uso). */
export async function recentTurns(userId: string, accountId: string) {
  return (await queryOne<{ user_hour: number; account_day: number }>(
    `SELECT (SELECT count(*)::int FROM copilot_turns WHERE user_id = $1 AND started_at > now() - interval '1 hour') AS user_hour,
            (SELECT count(*)::int FROM copilot_turns WHERE account_id = $2 AND started_at > now() - interval '24 hours') AS account_day`,
    [userId, accountId],
  ))!;
}

// --- Mensajes --------------------------------------------------------------------------------------------------------

export async function addMessage(m: { thread_id: string; turn_id?: string | null; role: Message['role']; content?: string; tool_calls?: StoredToolCall[] | null; tool_call_id?: string | null; refs?: string[] }): Promise<Message> {
  return (await queryOne<Message>(
    `INSERT INTO copilot_messages (thread_id, turn_id, role, content, tool_calls, tool_call_id, refs) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [m.thread_id, m.turn_id ?? null, m.role, m.content ?? '', m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_call_id ?? null, m.refs ?? []],
  ))!;
}

/** Todo el historial del hilo, del más viejo al más nuevo (el motor lo recorta antes de mandarlo al modelo). */
export async function threadMessages(threadId: string, limit = 400): Promise<Message[]> {
  return (await query<Message>(`SELECT * FROM copilot_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT $2`, [threadId, limit])).reverse();
}

// --- Acciones --------------------------------------------------------------------------------------------------------

const ACTION_JSON = new Set(['args', 'risk_reasons', 'preview', 'result', 'links', 'before', 'after', 'undo']);
const ACTION_COLUMNS = new Set(['tool_call_id', 'tool', 'args', 'args_hash', 'risk', 'risk_reasons', 'status', 'title', 'preview', 'result', 'links', 'before', 'after', 'undo', 'undo_until', 'contact_ids', 'error', 'expires_at', 'confirmed_at', 'executed_at', 'undone_at']);

function columns(patch: Record<string, unknown>, from: number) {
  const keys = Object.keys(patch).filter((k) => ACTION_COLUMNS.has(k) && patch[k] !== undefined);
  return {
    keys,
    values: keys.map((k) => (ACTION_JSON.has(k) && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k])),
    set: keys.map((k, i) => `${k} = $${from + i}`).join(', '),
  };
}

export type NewAction = Partial<Action> & Pick<Action, 'thread_id' | 'turn_id' | 'account_id' | 'user_id' | 'tool' | 'risk' | 'status'>;

export async function insertAction(a: NewAction): Promise<Action> {
  const base = { thread_id: a.thread_id, turn_id: a.turn_id, account_id: a.account_id, user_id: a.user_id };
  const c = columns(a as Record<string, unknown>, 5);
  return (await queryOne<Action>(
    `INSERT INTO copilot_actions (thread_id, turn_id, account_id, user_id${c.keys.length ? ', ' + c.keys.join(', ') : ''})
     VALUES ($1, $2, $3, $4${c.keys.map((_, i) => `, $${5 + i}`).join('')}) RETURNING *`,
    [base.thread_id, base.turn_id, base.account_id, base.user_id, ...c.values],
  ))!;
}

export async function updateAction(id: string, patch: Partial<Action>, db?: Db): Promise<Action | null> {
  const c = columns(patch as Record<string, unknown>, 2);
  if (!c.keys.length) return getAction(id);
  const sql = `UPDATE copilot_actions SET ${c.set}, updated_at = now() WHERE id = $1 RETURNING *`;
  const params = [id, ...c.values];
  return db ? ((await db.query(sql, params)).rows[0] ?? null) : queryOne<Action>(sql, params);
}

export async function getAction(id: string): Promise<Action | null> {
  return queryOne<Action>(`SELECT * FROM copilot_actions WHERE id = $1`, [id]);
}

/** Acciones de esa persona en esa cuenta (las de otros no existen para ella). */
export async function ownAction(id: string, userId: string, accountId: string): Promise<Action | null> {
  return queryOne<Action>(`SELECT * FROM copilot_actions WHERE id = $1 AND user_id = $2 AND account_id = $3`, [id, userId, accountId]);
}

/**
 * Toma una propuesta para ejecutarla: una sola vez, solo quien la pidió, sin caducar y con la misma huella que se
 * mostró. Devuelve la acción ya en `executing`, o `null` si alguna condición no se cumple.
 */
export async function claimProposal(id: string, userId: string, seenHash: string): Promise<Action | null> {
  return queryOne<Action>(
    `UPDATE copilot_actions SET status = 'executing', confirmed_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'proposed' AND expires_at > now() AND args_hash = $3 RETURNING *`,
    [id, userId, seenHash],
  );
}

/** Toma una acción hecha para deshacerla (una sola vez a la vez). */
export async function claimUndo(id: string, userId: string): Promise<Action | null> {
  return queryOne<Action>(
    `UPDATE copilot_actions SET status = 'undoing', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'done' AND undo IS NOT NULL AND undo_until > now() RETURNING *`,
    [id, userId],
  );
}

export async function turnActions(turnId: string): Promise<Action[]> {
  return query<Action>(`SELECT * FROM copilot_actions WHERE turn_id = $1 ORDER BY created_at`, [turnId]);
}

export async function threadActions(threadId: string): Promise<Action[]> {
  return query<Action>(`SELECT * FROM copilot_actions WHERE thread_id = $1 ORDER BY created_at`, [threadId]);
}

export async function actionsByIds(ids: string[], threadId: string): Promise<Action[]> {
  if (!ids.length) return [];
  return query<Action>(`SELECT * FROM copilot_actions WHERE id = ANY($1::uuid[]) AND thread_id = $2 ORDER BY created_at`, [ids, threadId]);
}

// --- Novedades para el panel -----------------------------------------------------------------------------------------

/** Mensajes, acciones y turnos del hilo que cambiaron después de `afterRev`. */
export async function updatesSince(threadId: string, afterRev: number) {
  const [messages, actions, turns] = await Promise.all([
    query<Message>(`SELECT * FROM copilot_messages WHERE thread_id = $1 AND rev > $2 ORDER BY id`, [threadId, afterRev]),
    query<Action>(`SELECT * FROM copilot_actions WHERE thread_id = $1 AND rev > $2 ORDER BY created_at`, [threadId, afterRev]),
    query<Turn>(`SELECT * FROM copilot_turns WHERE thread_id = $1 AND rev > $2 ORDER BY started_at`, [threadId, afterRev]),
  ]);
  return { messages, actions, turns };
}

// --- Limpieza --------------------------------------------------------------------------------------------------------

/**
 * Turnos que dejaron de latir (el proceso se reinició o se cayó) pasan a «interrumpido»; una acción que quedó a medias
 * pasa a «no sabemos si se aplicó»; las propuestas vencidas, a «caducada».
 */
export async function sweepStale(threadId?: string) {
  const scope = threadId ? ' AND thread_id = $1' : '';
  const params = threadId ? [threadId] : [];
  await query(`UPDATE copilot_turns SET status = 'interrupted', step_label = '', finished_at = now(), error = 'Se interrumpió antes de terminar.' WHERE status = 'running' AND heartbeat_at < now() - interval '45 seconds'${scope}`, params);
  await query(`UPDATE copilot_actions SET status = 'unknown', updated_at = now(), error = 'Se interrumpió a la mitad: revisa si se aplicó.' WHERE status IN ('executing', 'undoing') AND updated_at < now() - interval '2 minutes'${scope}`, params);
  await query(`UPDATE copilot_actions SET status = 'expired', updated_at = now() WHERE status = 'proposed' AND expires_at < now()${scope}`, params);
}

/** Retención: hilos sin actividad en `COPILOT_RETENTION_DAYS` (o antes, si la cuenta guarda los mensajes menos tiempo). */
export async function pruneThreads(now = new Date(), accountId?: string, days = config.copilot.retentionDays) {
  const cutoff = new Date(now.getTime() - days * 86400_000);
  return accountId
    ? deleteInBatches('copilot_threads', `account_id = $1 AND updated_at < $2`, [accountId, cutoff], 500)
    : deleteInBatches('copilot_threads', `updated_at < $1`, [cutoff], 500);
}

/**
 * Al borrar los datos de un cliente: se vacía el texto de los turnos que lo tocaron y los datos de sus acciones. Corre
 * dentro de la transacción del borrado.
 */
export async function redactContact(db: Db, contactId: string) {
  const turns = (await db.query(`SELECT id, thread_id FROM copilot_turns WHERE $1 = ANY(contact_ids)`, [contactId])).rows as { id: string; thread_id: string }[];
  const turnIds = turns.map((t) => t.id);
  if (turnIds.length) {
    await db.query(`UPDATE copilot_messages SET content = '', tool_calls = NULL, redacted = true WHERE turn_id = ANY($1::uuid[])`, [turnIds]);
    await db.query(`UPDATE copilot_threads SET title = '' WHERE id = ANY($1::uuid[])`, [[...new Set(turns.map((t) => t.thread_id))]]);
  }
  await db.query(
    `UPDATE copilot_actions SET args = '{}', preview = NULL, result = NULL, before = NULL, after = NULL, undo = NULL, links = '[]',
            title = 'Datos de un cliente borrados', status = CASE WHEN status = 'proposed' THEN 'expired' ELSE status END, updated_at = now()
      WHERE turn_id = ANY($1::uuid[]) OR $2 = ANY(contact_ids)`,
    [turnIds, contactId],
  );
}
