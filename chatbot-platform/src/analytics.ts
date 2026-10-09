/**
 * Estadísticas del panel: conversaciones, mensajes, citas, costo de IA y reparto por persona.
 * Los cálculos corren en la base de datos. Los días son días de la zona horaria de la cuenta, así un mensaje
 * de las 23:30 cuenta para su día local aunque en UTC ya sea otro día. Las cifras "en este momento" (abiertas,
 * esperando a una persona, sin asignar) son fotos actuales; el resto depende del periodo elegido.
 */
import { HttpError } from './access.js';
import * as astore from './automation/store.js';
import { query, queryOne } from './db.js';

export const RANGE_KEYS = ['today', 'week', '7', '15', '30', '60', '90', 'custom'] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
const MAX_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** El simulador del panel no es tráfico de clientes: no entra en ninguna cifra. */
const REAL = `c.channel_id IN (SELECT ch.id FROM channels ch WHERE ch.account_id = $1 AND ch.type <> 'playground')`;

const isDate = (s: string) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const shift = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const num = (v: unknown) => Number(v ?? 0);

interface Bounds {
  timezone: string;
  from: string;
  to: string;
  days: number;
  start: Date;
  end: Date;
  prevFrom: string;
  prevTo: string;
  prevStart: Date;
  prevEnd: Date;
}

/** Convierte el periodo elegido en fechas locales y en instantes [inicio, fin) de la zona de la cuenta. */
async function resolveBounds(accountId: string, range: RangeKey, from?: string, to?: string): Promise<Bounds> {
  const settings = await astore.getSettings(accountId);
  const timezone = settings.timezone || 'America/Mexico_City';
  const today = await queryOne<{ day: string; dow: number }>(
    `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, extract(isodow FROM (now() AT TIME ZONE $1)::date)::int AS dow`,
    [timezone],
  );
  if (!today) throw new HttpError(500, 'No se pudo leer la fecha de la cuenta');
  let first: string;
  let last: string;
  if (range === 'custom') {
    if (!from || !to || !isDate(from) || !isDate(to)) throw new HttpError(400, 'Elige una fecha de inicio y una de fin válidas');
    first = from;
    last = to;
  } else if (range === 'today') {
    first = last = today.day;
  } else if (range === 'week') {
    first = shift(today.day, -(today.dow - 1)); // desde el lunes
    last = today.day;
  } else {
    first = shift(today.day, -(Number(range) - 1));
    last = today.day;
  }
  if (first > last) throw new HttpError(400, 'La fecha de inicio es posterior a la de fin');
  const days = daysBetween(first, last) + 1;
  if (days > MAX_DAYS) throw new HttpError(400, `El rango máximo es de ${MAX_DAYS} días`);
  const at = await queryOne<{ s: Date; e: Date; ps: Date }>(
    `SELECT timezone($1, $2::date::timestamp) AS s, timezone($1, ($3::date + 1)::timestamp) AS e, timezone($1, ($2::date - $4::int)::timestamp) AS ps`,
    [timezone, first, last, days],
  );
  if (!at) throw new HttpError(500, 'No se pudo calcular el periodo');
  const prevFrom = shift(first, -days);
  return {
    timezone,
    from: first,
    to: last,
    days,
    start: at.s,
    end: at.e,
    prevFrom,
    prevTo: shift(first, -1),
    prevStart: at.ps,
    prevEnd: at.s,
  };
}

/** Cifras de un periodo. Se calcula igual para el periodo elegido y para el anterior (variaciones). */
async function periodTotals(accountId: string, s: Date, e: Date) {
  const [convs, msgs, rt, appts, ai] = await Promise.all([
    queryOne<{ new_conversations: number; closed_in_period: number }>(
      `SELECT count(*) FILTER (WHERE c.created_at >= $2 AND c.created_at < $3)::int AS new_conversations,
              count(*) FILTER (WHERE c.status = 'closed' AND c.status_changed_at >= $2 AND c.status_changed_at < $3)::int AS closed_in_period
         FROM conversations c
        WHERE c.account_id = $1 AND ${REAL}
          AND ((c.created_at >= $2 AND c.created_at < $3) OR (c.status = 'closed' AND c.status_changed_at >= $2 AND c.status_changed_at < $3))`,
      [accountId, s, e],
    ),
    queryOne<{ received: number; sent_bot: number; sent_human: number; sent_system: number; failed: number; answered_by_bot: number; answered_by_people: number }>(
      `SELECT count(*) FILTER (WHERE m.direction = 'in' AND m.sender = 'customer')::int AS received,
              count(*) FILTER (WHERE m.direction = 'out' AND m.sender = 'bot' AND m.status = 'ok')::int AS sent_bot,
              count(*) FILTER (WHERE m.direction = 'out' AND m.sender = 'human' AND m.status = 'ok')::int AS sent_human,
              count(*) FILTER (WHERE m.direction = 'out' AND m.sender = 'system' AND m.status = 'ok')::int AS sent_system,
              count(*) FILTER (WHERE m.direction = 'out' AND m.status = 'failed')::int AS failed,
              count(DISTINCT m.conversation_id) FILTER (WHERE m.direction = 'out' AND m.sender = 'bot' AND m.status = 'ok')::int AS answered_by_bot,
              count(DISTINCT m.conversation_id) FILTER (WHERE m.direction = 'out' AND m.sender = 'human' AND m.status = 'ok')::int AS answered_by_people
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = $1 AND ${REAL} AND m.created_at >= $2 AND m.created_at < $3`,
      [accountId, s, e],
    ),
    // Tiempo de primera respuesta: desde el primer mensaje del cliente en el periodo hasta la primera respuesta del asistente o de una persona.
    queryOne<{ samples: number; minutes: number | null }>(
      `WITH firsts AS (
         SELECT m.conversation_id, min(m.created_at) AS first_in
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.account_id = $1 AND ${REAL} AND m.direction = 'in' AND m.sender = 'customer' AND m.created_at >= $2 AND m.created_at < $3
          GROUP BY m.conversation_id
       )
       SELECT count(*)::int AS samples, avg(EXTRACT(EPOCH FROM (r.at - f.first_in)) / 60)::float AS minutes
         FROM firsts f
         CROSS JOIN LATERAL (
           SELECT min(o.created_at) AS at FROM messages o
            WHERE o.conversation_id = f.conversation_id AND o.direction = 'out' AND o.sender IN ('bot', 'human') AND o.status = 'ok' AND o.created_at >= f.first_in
         ) r
        WHERE r.at IS NOT NULL`,
      [accountId, s, e],
    ),
    queryOne<{ total: number; confirmed: number; completed: number; cancelled: number; no_show: number; by_bot: number; by_people: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE a.status = 'confirmed')::int AS confirmed,
              count(*) FILTER (WHERE a.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE a.status = 'no_show')::int AS no_show,
              count(*) FILTER (WHERE a.source = 'bot')::int AS by_bot,
              count(*) FILTER (WHERE a.source <> 'bot')::int AS by_people
         FROM appointments a
        WHERE a.account_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3`,
      [accountId, s, e],
    ),
    queryOne<{ runs: number; cost: number }>(
      `SELECT count(*)::int AS runs, coalesce(sum(r.cost_usd), 0)::float AS cost FROM ai_runs r WHERE r.account_id = $1 AND r.created_at >= $2 AND r.created_at < $3`,
      [accountId, s, e],
    ),
  ]);
  const sentTotal = num(msgs?.sent_bot) + num(msgs?.sent_human) + num(msgs?.sent_system);
  return {
    conversations_new: num(convs?.new_conversations),
    conversations_closed: num(convs?.closed_in_period),
    conversations_answered_by_bot: num(msgs?.answered_by_bot),
    conversations_answered_by_people: num(msgs?.answered_by_people),
    messages_received: num(msgs?.received),
    messages_sent_bot: num(msgs?.sent_bot),
    messages_sent_human: num(msgs?.sent_human),
    messages_sent_system: num(msgs?.sent_system),
    messages_sent: sentTotal,
    messages_failed: num(msgs?.failed),
    first_response_minutes: rt && rt.samples > 0 && rt.minutes !== null ? Math.round(Number(rt.minutes) * 10) / 10 : null,
    first_response_samples: num(rt?.samples),
    appointments: num(appts?.total),
    appointments_confirmed: num(appts?.confirmed),
    appointments_completed: num(appts?.completed),
    appointments_cancelled: num(appts?.cancelled),
    appointments_no_show: num(appts?.no_show),
    appointments_by_bot: num(appts?.by_bot),
    appointments_by_people: num(appts?.by_people),
    ai_runs: num(ai?.runs),
    ai_cost_usd: num(ai?.cost),
  };
}

/** Lo que pasa ahora mismo: no depende del periodo. */
async function snapshot(accountId: string) {
  const [open, upcoming] = await Promise.all([
    queryOne<{ open_now: number; waiting_people_now: number; unassigned_now: number }>(
      `SELECT count(*)::int AS open_now,
              count(*) FILTER (WHERE c.status = 'human')::int AS waiting_people_now,
              count(*) FILTER (WHERE c.assigned_user_id IS NULL)::int AS unassigned_now
         FROM conversations c
        WHERE c.account_id = $1 AND c.status <> 'closed' AND ${REAL}`,
      [accountId],
    ),
    queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM appointments a WHERE a.account_id = $1 AND a.status = 'confirmed' AND a.starts_at >= now() AND a.starts_at < now() + interval '7 days'`,
      [accountId],
    ),
  ]);
  return {
    conversations_open_now: num(open?.open_now),
    conversations_waiting_people_now: num(open?.waiting_people_now),
    conversations_unassigned_now: num(open?.unassigned_now),
    appointments_upcoming_7d: num(upcoming?.n),
  };
}

/** Totales por día local: se rellenan los días sin actividad para que las gráficas no salten. */
async function daily(accountId: string, b: Bounds) {
  const [msgs, convs, appts] = await Promise.all([
    query<{ day: string; received: number; sent_bot: number; sent_human: number }>(
      `SELECT to_char((m.created_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE m.direction = 'in' AND m.sender = 'customer')::int AS received,
              count(*) FILTER (WHERE m.direction = 'out' AND m.sender = 'bot' AND m.status = 'ok')::int AS sent_bot,
              count(*) FILTER (WHERE m.direction = 'out' AND m.sender = 'human' AND m.status = 'ok')::int AS sent_human
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = $1 AND ${REAL} AND m.created_at >= $2 AND m.created_at < $3
        GROUP BY 1`,
      [accountId, b.start, b.end, b.timezone],
    ),
    query<{ day: string; n: number }>(
      `SELECT to_char((c.created_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM conversations c
        WHERE c.account_id = $1 AND ${REAL} AND c.created_at >= $2 AND c.created_at < $3
        GROUP BY 1`,
      [accountId, b.start, b.end, b.timezone],
    ),
    query<{ day: string; n: number }>(
      `SELECT to_char((a.starts_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM appointments a
        WHERE a.account_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
        GROUP BY 1`,
      [accountId, b.start, b.end, b.timezone],
    ),
  ]);
  const byDay = <T extends { day: string }>(rows: T[]) => new Map(rows.map((r) => [r.day, r]));
  const m = byDay(msgs);
  const c = byDay(convs);
  const a = byDay(appts);
  const rows = [];
  for (let day = b.from; day <= b.to; day = shift(day, 1)) {
    const mm = m.get(day);
    rows.push({
      date: day,
      conversations_new: num(c.get(day)?.n),
      messages_received: num(mm?.received),
      messages_sent_bot: num(mm?.sent_bot),
      messages_sent_human: num(mm?.sent_human),
      appointments: num(a.get(day)?.n),
    });
  }
  return rows;
}

/** Equipo: lo que recibió cada persona por turnos o a mano, lo que tiene ahora y lo que ha respondido. */
async function team(accountId: string, s: Date, e: Date) {
  const [people, assigned, open, sent, appts] = await Promise.all([
    query<{ id: string; name: string; email: string; role: string; active: boolean }>(
      `SELECT u.id, u.name, u.email, u.role, u.active FROM users u WHERE u.account_id = $1 AND u.role <> 'superadmin' ORDER BY u.name, u.email`,
      [accountId],
    ),
    query<{ user_id: string; conversations: number; round_robin: number; manual: number; previous: number }>(
      `SELECT ca.user_id,
              count(DISTINCT ca.conversation_id)::int AS conversations,
              count(*) FILTER (WHERE ca.source = 'round_robin')::int AS round_robin,
              count(*) FILTER (WHERE ca.source IN ('manual', 'takeover', 'api'))::int AS manual,
              count(*) FILTER (WHERE ca.source = 'anterior')::int AS previous
         FROM conversation_assignments ca
        WHERE ca.account_id = $1 AND ca.user_id IS NOT NULL AND ca.created_at >= $2 AND ca.created_at < $3
        GROUP BY ca.user_id`,
      [accountId, s, e],
    ),
    query<{ user_id: string; n: number }>(
      `SELECT c.assigned_user_id AS user_id, count(*)::int AS n
         FROM conversations c
        WHERE c.account_id = $1 AND c.status <> 'closed' AND c.assigned_user_id IS NOT NULL AND ${REAL}
        GROUP BY 1`,
      [accountId],
    ),
    query<{ user_id: string; messages: number; conversations: number }>(
      `SELECT m.meta->>'user_id' AS user_id, count(*)::int AS messages, count(DISTINCT m.conversation_id)::int AS conversations
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = $1 AND ${REAL} AND m.direction = 'out' AND m.sender = 'human' AND m.status = 'ok'
          AND m.meta ? 'user_id' AND m.created_at >= $2 AND m.created_at < $3
        GROUP BY 1`,
      [accountId, s, e],
    ),
    query<{ user_id: string; n: number }>(
      `SELECT a.assigned_user_id AS user_id, count(*)::int AS n
         FROM appointments a
        WHERE a.account_id = $1 AND a.status <> 'cancelled' AND a.assigned_user_id IS NOT NULL AND a.starts_at >= $2 AND a.starts_at < $3
        GROUP BY 1`,
      [accountId, s, e],
    ),
  ]);
  const by = <T extends { user_id: string | null }>(rows: T[]) => new Map(rows.filter((r) => r.user_id).map((r) => [r.user_id as string, r]));
  const A = by(assigned);
  const O = by(open);
  const S = by(sent);
  const P = by(appts);
  const roundRobinTotal = assigned.reduce((sum, r) => sum + num(r.round_robin), 0);
  const users = people
    .map((u) => {
      const a = A.get(u.id);
      const rr = num(a?.round_robin);
      return {
        id: u.id,
        name: u.name || u.email,
        email: u.email,
        role: u.role,
        active: u.active,
        conversations_received: num(a?.conversations),
        round_robin: rr,
        manual: num(a?.manual),
        previous: num(a?.previous),
        round_robin_share: roundRobinTotal ? Math.round((rr / roundRobinTotal) * 1000) / 10 : null,
        open_now: num(O.get(u.id)?.n),
        messages_sent: num(S.get(u.id)?.messages),
        conversations_replied: num(S.get(u.id)?.conversations),
        appointments: num(P.get(u.id)?.n),
      };
    })
    .filter((u) => u.active || u.conversations_received || u.open_now || u.messages_sent || u.appointments);
  return { users, round_robin_total: roundRobinTotal };
}

/** Canales de la cuenta (sin el simulador). */
async function channels(accountId: string, s: Date, e: Date) {
  return query<{ id: string; name: string; type: string; new_conversations: number; received: number; sent: number }>(
    `SELECT ch.id, ch.name, ch.type,
            (SELECT count(*)::int FROM conversations c WHERE c.channel_id = ch.id AND c.created_at >= $2 AND c.created_at < $3) AS new_conversations,
            (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE c.channel_id = ch.id AND m.direction = 'in' AND m.sender = 'customer' AND m.created_at >= $2 AND m.created_at < $3) AS received,
            (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE c.channel_id = ch.id AND m.direction = 'out' AND m.status = 'ok' AND m.sender IN ('bot', 'human', 'system') AND m.created_at >= $2 AND m.created_at < $3) AS sent
       FROM channels ch
      WHERE ch.account_id = $1 AND ch.type <> 'playground'
      ORDER BY ch.name`,
    [accountId, s, e],
  );
}

/** Citas más pedidas en el periodo. */
async function services(accountId: string, s: Date, e: Date) {
  return query<{ name: string; total: number }>(
    `SELECT coalesce(nullif(a.service_name, ''), 'Sin servicio') AS name, count(*)::int AS total
       FROM appointments a
      WHERE a.account_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
      GROUP BY 1 ORDER BY total DESC, name LIMIT 8`,
    [accountId, s, e],
  );
}

/** Costo de IA por tipo de llamada (respuestas, resúmenes, transcripciones…). */
async function aiByKind(accountId: string, s: Date, e: Date) {
  return query<{ kind: string; runs: number; cost: number }>(
    `SELECT r.kind, count(*)::int AS runs, coalesce(sum(r.cost_usd), 0)::float AS cost
       FROM ai_runs r
      WHERE r.account_id = $1 AND r.created_at >= $2 AND r.created_at < $3
      GROUP BY r.kind ORDER BY cost DESC, r.kind`,
    [accountId, s, e],
  );
}

/** Panel completo de estadísticas para un periodo. Las fechas se interpretan en la zona horaria de la cuenta. */
export async function overview(accountId: string, range: RangeKey, from?: string, to?: string) {
  const b = await resolveBounds(accountId, range, from, to);
  const [totals, previous, now, days, team_, chans, svc, ai] = await Promise.all([
    periodTotals(accountId, b.start, b.end),
    periodTotals(accountId, b.prevStart, b.prevEnd),
    snapshot(accountId),
    daily(accountId, b),
    team(accountId, b.start, b.end),
    channels(accountId, b.start, b.end),
    services(accountId, b.start, b.end),
    aiByKind(accountId, b.start, b.end),
  ]);
  return {
    generated_at: new Date().toISOString(),
    period: { range, from: b.from, to: b.to, days: b.days, timezone: b.timezone, prev_from: b.prevFrom, prev_to: b.prevTo },
    totals: { ...totals, ...now },
    previous,
    daily: days,
    team: { ...team_, unassigned_open_now: now.conversations_unassigned_now },
    channels: chans,
    services: svc,
    ai_by_kind: ai,
  };
}
