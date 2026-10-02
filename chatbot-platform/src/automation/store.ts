import crypto from 'node:crypto';
import { query, queryOne } from '../db.js';
import { accountSettings, type AccountSettings, type Appointment, type Automation, type Sequence, type Service } from './types.js';

/* ------------------------------ Configuración de la cuenta ------------------------------ */

export async function getSettings(accountId: string): Promise<AccountSettings> {
  const row = await queryOne<{ settings: unknown }>('SELECT settings FROM accounts WHERE id = $1', [accountId]);
  const s = accountSettings(row?.settings);
  // Secretos generados la primera vez que se necesitan.
  if (!s.calendar_token || !s.webhook_secret) {
    s.calendar_token ||= crypto.randomBytes(18).toString('base64url');
    s.webhook_secret ||= crypto.randomBytes(24).toString('hex');
    await query('UPDATE accounts SET settings = $2 WHERE id = $1', [accountId, JSON.stringify(s)]);
  }
  return s;
}

export async function saveSettings(accountId: string, s: AccountSettings) {
  await query('UPDATE accounts SET settings = $2, updated_at = now() WHERE id = $1', [accountId, JSON.stringify(s)]);
}

export async function accountByCalendarToken(token: string) {
  return queryOne<{ id: string; name: string; settings: unknown }>(`SELECT id, name, settings FROM accounts WHERE settings->>'calendar_token' = $1 AND active`, [token]);
}

/* ------------------------------ Reglas ------------------------------ */

export async function listAutomations(accountId: string | null) {
  return accountId
    ? query<Automation>('SELECT * FROM automations WHERE account_id = $1 ORDER BY priority DESC, created_at', [accountId])
    : query<Automation>('SELECT * FROM automations ORDER BY account_id, priority DESC, created_at');
}

export async function getAutomation(id: string) {
  return queryOne<Automation>('SELECT * FROM automations WHERE id = $1', [id]);
}

/** Reglas activas para un disparador (las del chatbot concreto y las generales de la cuenta). */
export async function activeAutomations(accountId: string, triggerType: string, chatbotId: string | null) {
  return query<Automation>(
    `SELECT * FROM automations WHERE account_id = $1 AND active AND trigger->>'type' = $2 AND (chatbot_id IS NULL OR chatbot_id = $3)
     ORDER BY priority DESC, created_at`,
    [accountId, triggerType, chatbotId],
  );
}

export async function saveAutomation(accountId: string, a: Omit<Automation, 'id' | 'account_id' | 'run_count' | 'last_run_at'>, id?: string) {
  const params = [a.name, a.active, a.chatbot_id, JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.actions), a.stop_ai, a.priority];
  if (id) {
    return queryOne<Automation>(
      `UPDATE automations SET name=$1, active=$2, chatbot_id=$3, trigger=$4, conditions=$5, actions=$6, stop_ai=$7, priority=$8, updated_at=now()
       WHERE id = $9 RETURNING *`,
      [...params, id],
    );
  }
  return queryOne<Automation>(
    `INSERT INTO automations (name, active, chatbot_id, trigger, conditions, actions, stop_ai, priority, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [...params, accountId],
  );
}

export async function deleteAutomation(id: string) {
  await query('DELETE FROM automations WHERE id = $1', [id]);
}

export async function markAutomationRun(id: string) {
  await query('UPDATE automations SET run_count = run_count + 1, last_run_at = now() WHERE id = $1', [id]);
}

/* ------------------------------ Secuencias ------------------------------ */

export async function listSequences(accountId: string | null) {
  return accountId
    ? query<Sequence>('SELECT * FROM sequences WHERE account_id = $1 ORDER BY created_at', [accountId])
    : query<Sequence>('SELECT * FROM sequences ORDER BY account_id, created_at');
}

export async function getSequence(id: string) {
  return queryOne<Sequence>('SELECT * FROM sequences WHERE id = $1', [id]);
}

export async function saveSequence(accountId: string, s: Omit<Sequence, 'id' | 'account_id'>, id?: string) {
  const params = [s.name, s.active, JSON.stringify(s.steps), s.stop_on_reply, s.business_hours_only];
  if (id) {
    return queryOne<Sequence>(
      `UPDATE sequences SET name=$1, active=$2, steps=$3, stop_on_reply=$4, business_hours_only=$5, updated_at=now() WHERE id = $6 RETURNING *`,
      [...params, id],
    );
  }
  return queryOne<Sequence>(
    `INSERT INTO sequences (name, active, steps, stop_on_reply, business_hours_only, account_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [...params, accountId],
  );
}

export async function deleteSequence(id: string) {
  await query('DELETE FROM sequences WHERE id = $1', [id]);
}

export interface Enrollment {
  id: string;
  account_id: string;
  sequence_id: string;
  conversation_id: string;
  status: 'active' | 'completed' | 'stopped';
  current_step: number;
  last_inbound_id: number;
  stop_reason: string;
  started_at: Date;
  next_run_at: Date | null;
}

export async function createEnrollment(accountId: string, sequenceId: string, conversationId: string, lastInboundId: number) {
  return queryOne<Enrollment>(
    `INSERT INTO sequence_enrollments (account_id, sequence_id, conversation_id, last_inbound_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING *`,
    [accountId, sequenceId, conversationId, lastInboundId],
  );
}

export async function getEnrollment(id: string) {
  return queryOne<Enrollment>('SELECT * FROM sequence_enrollments WHERE id = $1', [id]);
}

export async function updateEnrollment(id: string, patch: { status?: string; current_step?: number; next_run_at?: Date | null; stop_reason?: string; last_step?: boolean }) {
  await query(
    `UPDATE sequence_enrollments SET status = COALESCE($2, status), current_step = COALESCE($3, current_step),
       next_run_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE next_run_at END,
       stop_reason = COALESCE($6, stop_reason),
       last_step_at = CASE WHEN $7::boolean THEN now() ELSE last_step_at END,
       finished_at = CASE WHEN $2 IN ('completed','stopped') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [id, patch.status ?? null, patch.current_step ?? null, patch.next_run_at !== undefined, patch.next_run_at ?? null, patch.stop_reason ?? null, !!patch.last_step],
  );
}

export async function listEnrollments(conversationId: string) {
  return query<Enrollment & { sequence_name: string }>(
    `SELECT e.*, s.name AS sequence_name FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
     WHERE e.conversation_id = $1 ORDER BY e.started_at DESC LIMIT 20`,
    [conversationId],
  );
}

/** Detiene inscripciones activas; devuelve cuántas se detuvieron. */
export async function stopEnrollments(conversationId: string, reason: string, sequenceId?: string) {
  const rows = await query<{ id: string }>(
    `UPDATE sequence_enrollments SET status = 'stopped', stop_reason = $2, finished_at = now()
     WHERE conversation_id = $1 AND status = 'active' AND ($3::uuid IS NULL OR sequence_id = $3) RETURNING id`,
    [conversationId, reason, sequenceId ?? null],
  );
  for (const r of rows) await cancelJobs('enrollment_id', r.id);
  return rows.length;
}

/* ------------------------------ Tareas programadas ------------------------------ */

export interface Job {
  id: number;
  account_id: string | null;
  type: string;
  payload: Record<string, any>;
  run_at: Date;
  status: string;
  attempts: number;
}

/** Programa una tarea. Con `dedupe_key`, reemplaza la pendiente con la misma clave. */
export async function scheduleJob(j: { account_id: string | null; type: string; payload: Record<string, unknown>; run_at: Date; dedupe_key?: string }) {
  return queryOne<Job>(
    `INSERT INTO jobs (account_id, type, payload, run_at, dedupe_key) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL
     DO UPDATE SET run_at = EXCLUDED.run_at, payload = EXCLUDED.payload RETURNING *`,
    [j.account_id, j.type, JSON.stringify(j.payload), j.run_at, j.dedupe_key ?? null],
  );
}

/** Reclama tareas vencidas (varias instancias no toman la misma: SKIP LOCKED). */
export async function claimDueJobs(limit: number) {
  return query<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = now()
     WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now() ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [limit],
  );
}

export async function finishJob(id: number, status: 'done' | 'failed' | 'cancelled', error = '') {
  await query(`UPDATE jobs SET status = $2, last_error = $3, finished_at = now() WHERE id = $1`, [id, status, error.slice(0, 1000)]);
}

export async function retryJob(id: number, runAt: Date, error: string) {
  await query(`UPDATE jobs SET status = 'pending', run_at = $2, last_error = $3 WHERE id = $1`, [id, runAt, error.slice(0, 1000)]);
}

export async function cancelJobs(payloadKey: string, value: string) {
  await query(`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE status = 'pending' AND payload->>$1 = $2`, [payloadKey, value]);
}

/** Tareas "running" de un proceso que murió vuelven a la cola. */
export async function recoverStaleJobs() {
  await query(`UPDATE jobs SET status = 'pending' WHERE status = 'running' AND started_at < now() - interval '5 minutes'`);
}

export async function listJobs(accountId: string | null, conversationId?: string) {
  const params: unknown[] = [];
  const where: string[] = [`status = 'pending'`];
  if (accountId) {
    params.push(accountId);
    where.push(`account_id = $${params.length}`);
  }
  if (conversationId) {
    params.push(conversationId);
    where.push(`payload->>'conversation_id' = $${params.length}`);
  }
  return query<Job>(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY run_at LIMIT 200`, params);
}

/* ------------------------------ Servicios y citas ------------------------------ */

export async function listServices(accountId: string | null, onlyActive = false) {
  return accountId
    ? query<Service>(`SELECT * FROM services WHERE account_id = $1 ${onlyActive ? 'AND active' : ''} ORDER BY created_at`, [accountId])
    : query<Service>(`SELECT * FROM services ${onlyActive ? 'WHERE active' : ''} ORDER BY account_id, created_at`);
}

export async function getService(id: string) {
  return queryOne<Service>('SELECT * FROM services WHERE id = $1', [id]);
}

export async function saveService(accountId: string, s: Omit<Service, 'id' | 'account_id'>, id?: string) {
  const cols = ['name', 'kind', 'description', 'duration_minutes', 'buffer_minutes', 'capacity', 'min_notice_minutes', 'max_days_ahead', 'location', 'hours', 'reminders', 'reminder_message', 'assigned_user_ids', 'notify_team', 'active'] as const;
  const values = cols.map((c) => (['hours', 'reminders', 'assigned_user_ids'].includes(c) ? (s[c] === null ? null : JSON.stringify(s[c])) : s[c]));
  if (id) {
    return queryOne<Service>(`UPDATE services SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`, [...values, id]);
  }
  return queryOne<Service>(
    `INSERT INTO services (${cols.join(', ')}, account_id) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`,
    [...values, accountId],
  );
}

export async function deleteService(id: string) {
  await query('DELETE FROM services WHERE id = $1', [id]);
}

export async function getAppointment(id: string) {
  return queryOne<Appointment>('SELECT * FROM appointments WHERE id = $1', [id]);
}

export async function listAppointments(accountId: string | null, opts: { from?: Date; to?: Date; contactId?: string; status?: string } = {}) {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (accountId) add('a.account_id = ?', accountId);
  if (opts.from) add('a.starts_at >= ?', opts.from);
  if (opts.to) add('a.starts_at < ?', opts.to);
  if (opts.contactId) add('a.contact_id = ?', opts.contactId);
  if (opts.status) add('a.status = ?', opts.status);
  return query<Appointment & { assigned_user_name: string | null; channel_type: string | null }>(
    `SELECT a.*, u.name AS assigned_user_name, ch.type AS channel_type FROM appointments a
       LEFT JOIN users u ON u.id = a.assigned_user_id
       LEFT JOIN conversations c ON c.id = a.conversation_id
       LEFT JOIN channels ch ON ch.id = c.channel_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.starts_at LIMIT 1000`,
    params,
  );
}

/* ------------------------------ Notificaciones ------------------------------ */

export async function notifyUsers(accountId: string, userIds: string[], n: { title: string; body: string; link?: string; kind?: string }) {
  for (const uid of new Set(userIds)) {
    await query(`INSERT INTO notifications (account_id, user_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)`, [
      accountId,
      uid,
      n.kind ?? 'alert',
      n.title.slice(0, 200),
      n.body.slice(0, 2000),
      n.link ?? '',
    ]);
  }
}

export async function teamMembers(accountId: string, roles: string[] = ['admin', 'agent']) {
  return query<{ id: string; name: string; email: string; role: string; phone: string; notify_whatsapp: boolean }>(
    `SELECT id, name, email, role, phone, notify_whatsapp FROM users WHERE account_id = $1 AND active AND role = ANY($2)`,
    [accountId, roles],
  );
}

/* ------------------------------ Contactos ------------------------------ */

export async function setTags(contactId: string, tags: string[]) {
  await query('UPDATE contacts SET tags = $2, updated_at = now() WHERE id = $1', [contactId, JSON.stringify([...new Set(tags)].slice(0, 50))]);
}

export async function setOptOut(contactId: string, optedOut: boolean) {
  await query(`UPDATE contacts SET opted_out = $2, opted_out_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [contactId, optedOut]);
}

export async function lastInbound(conversationId: string) {
  return queryOne<{ id: number; created_at: Date }>(
    `SELECT id, created_at FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`,
    [conversationId],
  );
}

/** El cliente escribió: se detienen las secuencias configuradas para detenerse al responder. */
export async function stopEnrollmentsOnReply(conversationId: string) {
  const rows = await query<{ id: string }>(
    `UPDATE sequence_enrollments e SET status = 'stopped', stop_reason = 'el cliente respondió', finished_at = now()
     FROM sequences s WHERE s.id = e.sequence_id AND s.stop_on_reply AND e.conversation_id = $1 AND e.status = 'active'
     RETURNING e.id`,
    [conversationId],
  );
  for (const r of rows) await cancelJobs('enrollment_id', r.id);
}

/* ------------------------------ Campañas ------------------------------ */

export interface Campaign {
  id: string;
  account_id: string;
  channel_id: string;
  name: string;
  message: string;
  image_id: string | null;
  audience: { tags_any?: string[]; tags_none?: string[]; active_within_days?: number; statuses?: string[] };
  scheduled_at: Date | null;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';
  rate_per_minute: number;
  stats: Record<string, number>;
}

export async function listCampaigns(accountId: string | null) {
  return accountId
    ? query<Campaign>('SELECT * FROM campaigns WHERE account_id = $1 ORDER BY created_at DESC', [accountId])
    : query<Campaign>('SELECT * FROM campaigns ORDER BY created_at DESC');
}

export async function getCampaign(id: string) {
  return queryOne<Campaign>('SELECT * FROM campaigns WHERE id = $1', [id]);
}

export async function saveCampaign(accountId: string, c: Pick<Campaign, 'channel_id' | 'name' | 'message' | 'image_id' | 'audience' | 'scheduled_at' | 'rate_per_minute'>, id?: string) {
  const params = [c.channel_id, c.name, c.message, c.image_id, JSON.stringify(c.audience), c.scheduled_at, c.rate_per_minute];
  if (id) {
    return queryOne<Campaign>(
      `UPDATE campaigns SET channel_id=$1, name=$2, message=$3, image_id=$4, audience=$5, scheduled_at=$6, rate_per_minute=$7, updated_at=now()
       WHERE id = $8 RETURNING *`,
      [...params, id],
    );
  }
  return queryOne<Campaign>(
    `INSERT INTO campaigns (channel_id, name, message, image_id, audience, scheduled_at, rate_per_minute, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [...params, accountId],
  );
}

export async function setCampaignStatus(id: string, status: Campaign['status']) {
  await query('UPDATE campaigns SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
}

export async function deleteCampaign(id: string) {
  await query('DELETE FROM campaigns WHERE id = $1', [id]);
}

/** Conversaciones del canal que cumplen el segmento (nunca incluye a quienes se dieron de baja). */
export async function campaignAudience(c: Pick<Campaign, 'channel_id' | 'audience'>, limit = 100000) {
  const a = c.audience ?? {};
  const params: unknown[] = [c.channel_id];
  const where = ['cv.channel_id = $1', 'NOT ct.opted_out'];
  if (a.tags_any?.length) {
    params.push(a.tags_any.map((t) => t.toLowerCase()));
    where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(ct.tags) t WHERE lower(t) = ANY($${params.length}))`);
  }
  if (a.tags_none?.length) {
    params.push(a.tags_none.map((t) => t.toLowerCase()));
    where.push(`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(ct.tags) t WHERE lower(t) = ANY($${params.length}))`);
  }
  if (a.active_within_days && a.active_within_days > 0) {
    params.push(String(a.active_within_days));
    where.push(`cv.last_message_at > now() - ($${params.length} || ' days')::interval`);
  }
  if (a.statuses?.length) {
    params.push(a.statuses);
    where.push(`cv.status = ANY($${params.length})`);
  }
  params.push(limit);
  return query<{ conversation_id: string; name: string; push_name: string; phone: string }>(
    `SELECT cv.id AS conversation_id, ct.name, ct.push_name, ct.phone FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
     WHERE ${where.join(' AND ')} ORDER BY cv.last_message_at DESC LIMIT $${params.length}`,
    params,
  );
}

export async function campaignStats(id: string) {
  const rows = await query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status`, [id]);
  const stats: Record<string, number> = { pending: 0, sent: 0, skipped: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r.n;
  stats.total = rows.reduce((a, r) => a + r.n, 0);
  await query('UPDATE campaigns SET stats = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(stats)]);
  return stats;
}

/* ------------------------------ Notificaciones del usuario ------------------------------ */

export async function listNotifications(userId: string, limit = 50) {
  return query(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT $2`, [userId, limit]);
}

export async function unreadCount(userId: string) {
  return (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId]))!.n;
}

export async function markNotificationsRead(userId: string, ids?: number[]) {
  await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2))`, [userId, ids?.length ? ids : null]);
}

export async function pruneAutomationData(days: number) {
  await query(`DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND created_at < now() - ($1 || ' days')::interval`, [String(days)]);
  await query(`DELETE FROM notifications WHERE created_at < now() - ($1 || ' days')::interval`, [String(Math.max(days, 60))]);
}
