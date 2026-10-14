/**
 * Pipelines (embudos) y sus tarjetas. Una tarjeta es una solicitud de un cliente: avanza por las columnas que definió el
 * negocio, sola (por lo que detecta la IA o por eventos) o a mano desde el tablero.
 */
import { query, queryOne, withTransaction } from '../db.js';

export type StageKind = 'open' | 'won' | 'lost';

/** Lo que hace que una tarjeta entre a una columna, además del contexto que detecta la IA (`when`). */
export type StageEvent =
  | { type: 'goal_completed' }
  | { type: 'appointment_booked' }
  | { type: 'appointment_cancelled' }
  | { type: 'handoff' }
  | { type: 'data_captured'; field: string }
  | { type: 'stage_reached'; step: number }
  | { type: 'tag_added'; tag: string };

export interface Stage {
  id: string;
  name: string;
  kind: StageKind;
  color: string;
  /** Situación (en palabras del negocio) que la IA detecta para pasar la tarjeta a esta columna. */
  when: string;
  events: StageEvent[];
}

export interface Pipeline {
  id: string;
  account_id: string;
  name: string;
  stages: Stage[];
  chatbot_ids: string[];
  allow_backward: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PipelineCard {
  id: string;
  account_id: string;
  pipeline_id: string;
  conversation_id: string;
  request_number: number;
  stage_id: string;
  stage_entered_at: Date;
  created_at: Date;
  closed_at: Date | null;
}

export type MoveSource = 'inicio' | 'ia' | 'evento' | 'manual' | 'cierre';

export interface PipelineMove {
  id: string;
  card_id: string;
  from_stage: string | null;
  to_stage: string;
  source: MoveSource;
  reason: string;
  user_id: string | null;
  user_name?: string | null;
  created_at: Date;
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/* ------------------------------ Pipelines ------------------------------ */

export async function listPipelines(accountId: string | null): Promise<Pipeline[]> {
  return accountId
    ? query<Pipeline>('SELECT * FROM pipelines WHERE account_id = $1 ORDER BY created_at', [accountId])
    : query<Pipeline>('SELECT * FROM pipelines ORDER BY created_at');
}

export async function getPipeline(id: string): Promise<Pipeline | null> {
  return queryOne<Pipeline>('SELECT * FROM pipelines WHERE id = $1', [id]);
}

/** Pipeline que usa un agente (null si no tiene). */
export async function pipelineForBot(chatbotId: string): Promise<Pipeline | null> {
  return queryOne<Pipeline>('SELECT * FROM pipelines WHERE $1 = ANY(chatbot_ids) ORDER BY created_at LIMIT 1', [chatbotId]);
}

/**
 * Crea o actualiza un pipeline. Un agente usa a lo más uno: si se le asigna este, se quita de los demás de la cuenta.
 * Las tarjetas que estaban en una columna que se borró pasan a la primera.
 */
export async function savePipeline(
  accountId: string,
  body: { name: string; stages: Stage[]; chatbot_ids: string[]; allow_backward: boolean },
  id?: string,
): Promise<Pipeline> {
  return withTransaction(async (client) => {
    const params = [accountId, body.name, JSON.stringify(body.stages), body.chatbot_ids, body.allow_backward];
    const row = (id
      ? await client.query('UPDATE pipelines SET name = $2, stages = $3, chatbot_ids = $4, allow_backward = $5, updated_at = now() WHERE id = $6 AND account_id = $1 RETURNING *', [...params, id])
      : await client.query('INSERT INTO pipelines (account_id, name, stages, chatbot_ids, allow_backward) VALUES ($1, $2, $3, $4, $5) RETURNING *', params)
    ).rows[0] as Pipeline;
    if (body.chatbot_ids.length) {
      await client.query(
        `UPDATE pipelines SET chatbot_ids = ARRAY(SELECT x FROM unnest(chatbot_ids) x WHERE x <> ALL($3::uuid[])), updated_at = now()
          WHERE account_id = $1 AND id <> $2 AND chatbot_ids && $3::uuid[]`,
        [accountId, row.id, body.chatbot_ids],
      );
    }
    const ids = body.stages.map((s) => s.id);
    const orphans = (await client.query('SELECT id, stage_id FROM pipeline_cards WHERE pipeline_id = $1 AND stage_id <> ALL($2::text[])', [row.id, ids])).rows as { id: string; stage_id: string }[];
    for (const card of orphans) {
      await client.query('UPDATE pipeline_cards SET stage_id = $2, stage_entered_at = now() WHERE id = $1', [card.id, ids[0]]);
      await client.query(`INSERT INTO pipeline_moves (card_id, from_stage, to_stage, source, reason) VALUES ($1, $2, $3, 'manual', 'Se borró su columna')`, [card.id, card.stage_id, ids[0]]);
    }
    return row;
  });
}

export async function deletePipeline(id: string) {
  await query('DELETE FROM pipelines WHERE id = $1', [id]);
}

/* ------------------------------ Tarjetas ------------------------------ */

export async function getCard(id: string): Promise<PipelineCard | null> {
  return queryOne<PipelineCard>('SELECT * FROM pipeline_cards WHERE id = $1', [id]);
}

export async function openCardOf(conversationId: string): Promise<PipelineCard | null> {
  return queryOne<PipelineCard>('SELECT * FROM pipeline_cards WHERE conversation_id = $1 AND closed_at IS NULL', [conversationId]);
}

/**
 * Tarjeta abierta de la conversación en este pipeline; si no hay, la crea en la primera columna (una nueva por solicitud).
 * Si la abierta era de otro pipeline (el agente cambió de pipeline), esa se cierra donde estaba.
 */
export async function ensureCard(pipeline: Pipeline, conv: { id: string; account_id: string }): Promise<{ card: PipelineCard; created: boolean }> {
  const current = await openCardOf(conv.id);
  if (current?.pipeline_id === pipeline.id) return { card: current, created: false };
  if (current) await query('UPDATE pipeline_cards SET closed_at = now() WHERE id = $1 AND closed_at IS NULL', [current.id]);
  const first = pipeline.stages[0].id;
  const inserted = await queryOne<PipelineCard>(
    `INSERT INTO pipeline_cards (account_id, pipeline_id, conversation_id, request_number, stage_id)
     VALUES ($1, $2, $3, coalesce((SELECT max(number) FROM conversation_requests WHERE conversation_id = $3), 1), $4)
     ON CONFLICT (conversation_id) WHERE closed_at IS NULL DO NOTHING RETURNING *`,
    [conv.account_id, pipeline.id, conv.id, first],
  );
  if (inserted) {
    await query(`INSERT INTO pipeline_moves (card_id, from_stage, to_stage, source, reason) VALUES ($1, NULL, $2, 'inicio', 'Solicitud nueva')`, [inserted.id, first]);
    return { card: inserted, created: true };
  }
  // Otro evento de la misma conversación la creó al mismo tiempo.
  return { card: (await openCardOf(conv.id))!, created: false };
}

/**
 * Mueve la tarjeta si sigue en la columna `from` (otro evento pudo moverla al mismo tiempo). Devuelve si se movió.
 */
export async function moveCard(cardId: string, from: string, to: string, o: { source: MoveSource; reason: string; userId?: string | null }): Promise<boolean> {
  return withTransaction(async (client) => {
    const moved = (await client.query('UPDATE pipeline_cards SET stage_id = $3, stage_entered_at = now() WHERE id = $1 AND stage_id = $2 RETURNING id', [cardId, from, to])).rows.length > 0;
    if (moved) await client.query('INSERT INTO pipeline_moves (card_id, from_stage, to_stage, source, reason, user_id) VALUES ($1, $2, $3, $4, $5, $6)', [cardId, from, to, o.source, o.reason.slice(0, 300), o.userId ?? null]);
    return moved;
  });
}

/**
 * Termina la solicitud (el cliente vuelve por otra): su tarjeta se cierra. Si quedó en una columna intermedia, pasa a
 * «ganada» si cumplió el objetivo o a «perdida» si no (cuando el pipeline las tiene). Va dentro de la transacción que
 * empieza la solicitud nueva.
 */
export async function closeCardForRequest(client: Queryable, conversationId: string, goalCompleted: boolean) {
  const row = (await client.query(
    `SELECT c.id, c.stage_id, p.stages FROM pipeline_cards c JOIN pipelines p ON p.id = c.pipeline_id
      WHERE c.conversation_id = $1 AND c.closed_at IS NULL FOR UPDATE OF c`,
    [conversationId],
  )).rows[0] as { id: string; stage_id: string; stages: Stage[] } | undefined;
  if (!row) return;
  const stage = row.stages.find((s) => s.id === row.stage_id);
  if (!stage || stage.kind === 'open') {
    const target = row.stages.find((s) => s.kind === (goalCompleted ? 'won' : 'lost'));
    if (target) {
      await client.query('UPDATE pipeline_cards SET stage_id = $2, stage_entered_at = now() WHERE id = $1', [row.id, target.id]);
      await client.query(`INSERT INTO pipeline_moves (card_id, from_stage, to_stage, source, reason) VALUES ($1, $2, $3, 'cierre', $4)`, [
        row.id, row.stage_id, target.id, goalCompleted ? 'La solicitud terminó con el objetivo cumplido' : 'La solicitud terminó sin cumplir el objetivo',
      ]);
    }
  }
  await client.query('UPDATE pipeline_cards SET closed_at = now() WHERE id = $1', [row.id]);
}

export interface BoardCard extends PipelineCard {
  contact_id: string;
  contact_name: string;
  contact_phone: string;
  conversation_status: string;
  assigned_user_id: string | null;
  assigned_name: string | null;
  last_message_at: Date;
  channel_name: string;
  last_reason: string;
  last_source: MoveSource | null;
}

/**
 * Tarjetas del tablero: las abiertas y, de las cerradas, las que terminaron en una columna de ganadas o perdidas en los
 * últimos `days` días. Un agente solo ve las de sus conversaciones.
 */
export async function boardCards(pipeline: Pipeline, o: { days: number; assignedTo?: string | null }): Promise<BoardCard[]> {
  const finals = pipeline.stages.filter((s) => s.kind !== 'open').map((s) => s.id);
  return query<BoardCard>(
    `SELECT c.*, ct.id AS contact_id, coalesce(nullif(ct.name, ''), nullif(ct.push_name, ''), ct.phone, '') AS contact_name, coalesce(ct.phone, '') AS contact_phone,
            v.status AS conversation_status, v.assigned_user_id, u.name AS assigned_name, v.last_message_at, coalesce(ch.name, '') AS channel_name,
            coalesce(m.reason, '') AS last_reason, m.source AS last_source
       FROM pipeline_cards c
       JOIN conversations v ON v.id = c.conversation_id
       JOIN contacts ct ON ct.id = v.contact_id
       LEFT JOIN channels ch ON ch.id = v.channel_id
       LEFT JOIN users u ON u.id = v.assigned_user_id
       LEFT JOIN LATERAL (SELECT reason, source FROM pipeline_moves WHERE card_id = c.id ORDER BY id DESC LIMIT 1) m ON true
      WHERE c.pipeline_id = $1
        AND (c.closed_at IS NULL OR (c.stage_id = ANY($2::text[]) AND c.closed_at > now() - make_interval(days => $3)))
        AND ($4::uuid IS NULL OR v.assigned_user_id = $4)
      ORDER BY c.stage_entered_at DESC
      LIMIT 2000`,
    [pipeline.id, finals, o.days, o.assignedTo ?? null],
  );
}

/** Tarjetas de una conversación (una por solicitud), de la más reciente a la primera, con su historial. */
export async function cardsOfConversation(conversationId: string): Promise<(PipelineCard & { pipeline_name: string; stages: Stage[]; moves: PipelineMove[] })[]> {
  const cards = await query<PipelineCard & { pipeline_name: string; stages: Stage[] }>(
    `SELECT c.*, p.name AS pipeline_name, p.stages FROM pipeline_cards c JOIN pipelines p ON p.id = c.pipeline_id
      WHERE c.conversation_id = $1 ORDER BY c.id DESC LIMIT 20`,
    [conversationId],
  );
  if (!cards.length) return [];
  const moves = await query<PipelineMove>(
    `SELECT m.*, u.name AS user_name FROM pipeline_moves m LEFT JOIN users u ON u.id = m.user_id WHERE m.card_id = ANY($1::bigint[]) ORDER BY m.id`,
    [cards.map((c) => c.id)],
  );
  return cards.map((c) => ({ ...c, moves: moves.filter((m) => String(m.card_id) === String(c.id)) }));
}
