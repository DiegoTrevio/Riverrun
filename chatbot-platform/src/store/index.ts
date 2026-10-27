import { evaluatedChatbot, evaluatedImages } from '../engine/agent-snapshot.js';
import crypto from 'node:crypto';
import { enqueue } from '../engine/queue.js';
import { query, queryOne, withTransaction } from '../db.js';
import { removeInboundAccountFiles, type StoredMedia } from '../channels/media.js';
import { removeAccountAttachments } from '../attachments.js';
import { perRequestKeys } from '../engine/questions.js';
import { closeCardForRequest } from './pipelines.js';
import {
  channelConfig,
  hydrateChatbot,
  type Account,
  type AccountStatus,
  type Channel,
  type ChannelType,
  type Role,
  type User,
  type AlertPrefs,
  type Chatbot,
  type ChatbotRow,
  type Contact,
  type ContactTask,
  type Conversation,
  type ConversationStatus,
  type ImageAsset,
  type KnowledgeItem,
  type Message,
} from '../types.js';

/** Cliente de una transacción (withTransaction); sin él se usa el pool. */
type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const rowsOf = async (client: Queryable | undefined, text: string, params: unknown[]) => (client ? (await client.query(text, params)).rows : query(text, params));

/* ------------------------------ Cuentas ------------------------------ */

export async function listAccounts(): Promise<Account[]> {
  return query<Account>('SELECT * FROM accounts ORDER BY created_at');
}

export async function getAccount(id: string) {
  return queryOne<Account>('SELECT * FROM accounts WHERE id = $1', [id]);
}

export async function createAccount(
  name: string,
  opts: { status?: AccountStatus; trialEndsAt?: Date | null; businessType?: string; source?: string } = {},
  client?: Queryable,
): Promise<Account> {
  const rows = await rowsOf(client,
    'INSERT INTO accounts (name, status, trial_ends_at, business_type, signup_source) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, opts.status ?? 'active', opts.trialEndsAt ?? null, opts.businessType ?? '', opts.source ?? 'admin'],
  );
  const account = rows[0] as Account;
  // Su perfil de Zernio se crea cuando conecte su primera red (accountProfile), no al darse de alta.
  return account;
}

export async function updateAccount(
  id: string,
  patch: { name?: string; active?: boolean; status?: AccountStatus; plan?: string; trial_ends_at?: Date | null; business_type?: string; limits_override?: Record<string, number>; brand_id?: string | null; keep_data?: boolean },
) {
  return queryOne<Account>(
    `UPDATE accounts SET name = COALESCE($2, name), active = COALESCE($3, active), status = COALESCE($4, status), plan = COALESCE($5, plan),
       trial_ends_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE trial_ends_at END,
       trial_warned_at = CASE WHEN $6::boolean THEN NULL ELSE trial_warned_at END,
       business_type = COALESCE($8, business_type), limits_override = COALESCE($9::jsonb, limits_override), brand_id = CASE WHEN $10::boolean THEN $11::uuid ELSE brand_id END,
       keep_data = COALESCE($12, keep_data), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.active ?? null, patch.status ?? null, patch.plan ?? null, patch.trial_ends_at !== undefined, patch.trial_ends_at ?? null, patch.business_type ?? null, patch.limits_override ? JSON.stringify(patch.limits_override) : null, patch.brand_id !== undefined, patch.brand_id ?? null, patch.keep_data ?? null],
  );
}

/** Marca pasos del asistente de configuración como completados. */
export async function markOnboarding(accountId: string, steps: Record<string, boolean>) {
  return queryOne<Account>(`UPDATE accounts SET onboarding = onboarding || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`, [accountId, JSON.stringify(steps)]);
}

export async function deleteAccount(id: string) {
  // Borra en cascada todo lo de la cuenta (mensajes, bitácora…): en una cuenta grande pasa del tiempo límite normal.
  await withTransaction(async (db) => {
    await db.query('SET LOCAL statement_timeout = 0');
    await db.query('DELETE FROM accounts WHERE id = $1', [id]);
  });
  await removeInboundAccountFiles(id);
  await removeAccountAttachments(id);
}

/* ------------------------------ Usuarios ------------------------------ */

const USER_COLS = 'id, account_id, role, name, email, phone, notify_whatsapp, alert_prefs, available, active, email_verified_at, last_login_at, created_at';

export async function listUsers(accountId: string | null): Promise<User[]> {
  return accountId
    ? query<User>(`SELECT ${USER_COLS} FROM users WHERE account_id = $1 ORDER BY created_at`, [accountId])
    : query<User>(`SELECT ${USER_COLS} FROM users ORDER BY account_id NULLS FIRST, created_at`);
}

export async function getUser(id: string) {
  return queryOne<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
}

export async function getUserForLogin(email: string) {
  return queryOne<User & { password_hash: string; account_active: boolean | null }>(
    `SELECT u.*, a.active AS account_active FROM users u LEFT JOIN accounts a ON a.id = u.account_id WHERE lower(u.email) = lower($1)`,
    [email.trim()],
  );
}

/* ------------------------------ Sesiones del panel ------------------------------ */

export interface UserSession {
  id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string;
  ip: string;
  via: string;
}

/** Abre una sesión. Una persona tiene como mucho 30 abiertas: al pasar de ahí se cierran las de uso más antiguo. */
export async function createUserSession(s: { userId: string; expires: Date; via: string; userAgent: string; ip: string }) {
  const row = (await queryOne<{ id: string }>(
    `INSERT INTO user_sessions (user_id, expires_at, via, user_agent, ip) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [s.userId, s.expires, s.via, s.userAgent, s.ip],
  ))!;
  await query(
    `UPDATE user_sessions SET revoked_at = now() WHERE id IN (
       SELECT id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC OFFSET 30)`,
    [s.userId],
  );
  return row;
}

/** ¿Sigue abierta? Anota el uso como mucho cada 5 minutos (no se escribe en cada petición). */
export async function touchUserSession(id: string, userId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const row = await queryOne<{ stale: boolean }>(
    `SELECT last_seen_at < now() - interval '5 minutes' AS stale FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [id, userId],
  );
  if (!row) return false;
  if (row.stale) await query(`UPDATE user_sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  return true;
}

export async function listUserSessions(userId: string) {
  return query<UserSession>(
    `SELECT id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, via FROM user_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 50`,
    [userId],
  );
}

/** Cierra sesiones de una persona: una (`only`), todas menos una (`except`) o todas. Devuelve cuántas cerró. */
export async function revokeUserSessions(userId: string, o: { only?: string; except?: string | null } = {}) {
  const rows = await query(
    `UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL
        AND ($2::uuid IS NULL OR id = $2) AND ($3::uuid IS NULL OR id <> $3) RETURNING id`,
    [userId, o.only ?? null, o.except ?? null],
  );
  return rows.length;
}

/** Borra las sesiones vencidas o cerradas hace más de 30 días. */
export async function pruneUserSessions() {
  await query(`DELETE FROM user_sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days'`);
}

/** Usuario de una sesión: debe estar activo y, si tiene cuenta, la cuenta también. */
export async function getSessionUser(id: string) {
  return queryOne<User & { password_hash: string }>(
    `SELECT ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')}, u.password_hash FROM users u LEFT JOIN accounts a ON a.id = u.account_id
     WHERE u.id = $1 AND u.active AND (u.account_id IS NULL OR a.active)`,
    [id],
  );
}

export async function createUser(
  u: { account_id: string | null; role: Role; name: string; email: string; password_hash: string; verified?: boolean },
  client?: Queryable,
) {
  // Los usuarios que crea un administrador se dan por verificados; los del autoregistro, no.
  const rows = await rowsOf(client,
    `INSERT INTO users (account_id, role, name, email, password_hash, email_verified_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::boolean THEN now() END) RETURNING ${USER_COLS}`,
    [u.account_id, u.role, u.name, u.email.trim(), u.password_hash, u.verified ?? true],
  );
  return rows[0] as User;
}

export const getUserBasic = (id: string) => queryOne<{ id: string; name: string; email: string }>(`SELECT id, name, email FROM users WHERE id = $1`, [id]);

export async function updateUser(
  id: string,
  patch: { name?: string; role?: Role; account_id?: string | null; active?: boolean; password_hash?: string; email?: string; phone?: string; notify_whatsapp?: boolean; available?: boolean; alert_prefs?: AlertPrefs },
  expectedAccountId?: string,
) {
  return withTransaction(async (client) => {
    const result = await client.query<User>(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
       password_hash = COALESCE($5, password_hash), email = COALESCE($6, email),
       phone = COALESCE($7, phone), notify_whatsapp = COALESCE($8, notify_whatsapp),
       account_id = CASE WHEN $9::boolean THEN $10::uuid ELSE account_id END, available = COALESCE($12, available),
       alert_prefs = COALESCE($13::jsonb, alert_prefs), updated_at = now()
     WHERE id = $1 AND ($11::uuid IS NULL OR account_id = $11) RETURNING ${USER_COLS}`,
      [id, patch.name ?? null, patch.role ?? null, patch.active ?? null, patch.password_hash ?? null, patch.email?.trim() ?? null, patch.phone?.replace(/\D/g, '') ?? null, patch.notify_whatsapp ?? null, patch.account_id !== undefined, patch.account_id ?? null, expectedAccountId ?? null, patch.available ?? null, patch.alert_prefs ? JSON.stringify(patch.alert_prefs) : null],
    );
    const user = result.rows[0] ?? null;
    // Quien se desactiva o cambia de perfil deja de tener conversaciones abiertas asignadas.
    if (user && (patch.active === false || patch.account_id !== undefined)) {
      await client.query(`UPDATE conversations SET assigned_user_id = NULL, assigned_at = NULL WHERE assigned_user_id = $1 AND status <> 'closed' AND ($2::uuid IS NULL OR account_id <> $2 OR $3::boolean)`, [id, user.account_id, patch.active === false]);
    }
    if (user && patch.account_id !== undefined && user.role !== 'superadmin') {
      // A transferred user must no longer receive owner alerts from the old profile.
      await client.query('UPDATE accounts SET owner_user_id = NULL WHERE owner_user_id = $1 AND id <> $2', [id, user.account_id]);
    }
    return user;
  });
}

/** Trusted server-side provisioning. Never called by public registration or login. */
export async function grantMasterAccess(email: string) {
  return withTransaction(async (client) => {
    const existing = await client.query('SELECT id, email_verified_at FROM users WHERE lower(email) = lower($1) FOR UPDATE', [email.trim()]);
    if (!existing.rows.length) throw new Error('El usuario no existe. Regístralo y confirma su correo antes de asignar acceso maestro.');
    if (!existing.rows[0].email_verified_at) throw new Error('Confirma el correo del usuario antes de asignar acceso maestro.');
    const result = await client.query(`UPDATE users SET role = 'superadmin', account_id = NULL, active = true, updated_at = now() WHERE id = $1 RETURNING ${USER_COLS}`, [existing.rows[0].id]);
    return result.rows[0] as User;
  });
}

export async function markEmailVerified(id: string) {
  await query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [id]);
}

/* ------------------------------ Tokens de un solo uso (correo y contraseña) ------------------------------ */

const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Crea un token de un solo uso; se guarda solo su hash. Invalida los anteriores del mismo tipo. */
export async function createAuthToken(userId: string, kind: 'verify_email' | 'reset_password', ttlMinutes: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, [userId, kind]);
  await query(`INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`, [
    userId,
    kind,
    tokenHash(token),
    ttlMinutes,
  ]);
  return token;
}

/** Consume el token (una sola vez, sin caducar). Devuelve el usuario dueño o null. */
export async function consumeAuthToken(token: string, kind: 'verify_email' | 'reset_password') {
  const row = await queryOne<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [tokenHash(token), kind],
  );
  return row?.user_id ?? null;
}

export async function touchLogin(id: string) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function deleteUser(id: string, expectedAccountId?: string) {
  return withTransaction(async (client) => {
    // Su enlace para reservar se va con ella (si quedara sin persona, ofrecería todos los servicios del negocio). Va antes
    // de borrarla: en bases con la versión anterior de la 062 la llave foránea deja el enlace sin persona.
    await client.query('DELETE FROM booking_links WHERE user_id = $1 AND ($2::uuid IS NULL OR account_id = $2)', [id, expectedAccountId ?? null]);
    const deleted = await client.query<{ account_id: string }>('DELETE FROM users WHERE id = $1 AND ($2::uuid IS NULL OR account_id = $2) RETURNING account_id', [id, expectedAccountId ?? null]);
    if (!deleted.rows.length) return false;
    // Los servicios guardan a sus personas asignadas en jsonb (sin clave foránea): se quita la persona borrada para que
    // reservar no intente usar un usuario que ya no existe.
    await client.query(
      `UPDATE services SET assigned_user_ids = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(assigned_user_ids) x WHERE x <> $2), '[]'::jsonb)
       WHERE account_id = $1 AND assigned_user_ids @> to_jsonb($2::text)`,
      [deleted.rows[0].account_id, id],
    );
    return true;
  });
}

export async function countSuperadmins(): Promise<number> {
  return (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'superadmin' AND active`))!.n;
}

/* ------------------------------ Chatbots ------------------------------ */

export async function listChatbots(accountId: string | null = null): Promise<Chatbot[]> {
  const rows = accountId
    ? await query<ChatbotRow>('SELECT * FROM chatbots WHERE account_id = $1 ORDER BY created_at', [accountId])
    : await query<ChatbotRow>('SELECT * FROM chatbots ORDER BY created_at');
  return rows.map(hydrateChatbot);
}

export async function getChatbot(id: string): Promise<Chatbot | null> {
  const evaluated = evaluatedChatbot(id);
  if (evaluated) return evaluated;
  const row = await queryOne<ChatbotRow>('SELECT * FROM chatbots WHERE id = $1', [id]);
  return row ? hydrateChatbot(row) : null;
}

export function newWebhookToken() {
  return crypto.randomBytes(18).toString('base64url');
}

export interface ChatbotInput {
  name?: string;
  active?: boolean;
  personality?: unknown;
  rules?: unknown;
  data_fields?: unknown;
  flow?: unknown;
  ai?: unknown;
  saved_messages?: unknown;
  start_on_connect?: boolean;
  creation_ref?: string | null;
}

const CHATBOT_JSON_COLS = ['personality', 'rules', 'data_fields', 'flow', 'ai', 'saved_messages'] as const;
const CHATBOT_PLAIN_COLS = ['name', 'active', 'start_on_connect'] as const;

export async function createChatbot(accountId: string, input: ChatbotInput, client?: Queryable): Promise<Chatbot> {
  const rows = await rowsOf(client,
    `INSERT INTO chatbots (account_id, name, active, personality, rules, data_fields, flow, ai, saved_messages, start_on_connect, creation_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      accountId,
      input.name ?? 'Nuevo chatbot',
      input.active ?? false,
      JSON.stringify(input.personality ?? {}),
      JSON.stringify(input.rules ?? {}),
      JSON.stringify(input.data_fields ?? []),
      JSON.stringify(input.flow ?? {}),
      JSON.stringify(input.ai ?? {}),
      JSON.stringify(input.saved_messages ?? []),
      input.start_on_connect ?? false,
      input.creation_ref ?? null,
    ],
  );
  return hydrateChatbot(rows[0]);
}

export async function updateChatbot(id: string, input: ChatbotInput, client?: Queryable): Promise<Chatbot | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const col of CHATBOT_PLAIN_COLS) {
    if (input[col] !== undefined) {
      params.push(input[col]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  for (const col of CHATBOT_JSON_COLS) {
    if (input[col] !== undefined) {
      params.push(JSON.stringify(input[col]));
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return getChatbot(id);
  params.push(id);
  const [row] = await rowsOf(client,
    `UPDATE chatbots SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return row ? hydrateChatbot(row) : null;
}

export async function deleteChatbot(id: string) {
  // El simulador es interno del chatbot; los demás canales quedan sin chatbot asignado.
  await query(`DELETE FROM channels WHERE chatbot_id = $1 AND type = 'playground'`, [id]);
  await query('DELETE FROM chatbots WHERE id = $1', [id]);
}

/* ------------------------------ Canales ------------------------------ */

// Una cuenta pausada (prueba vencida) conserva el panel, pero sus canales no responden ni envían.
const CHANNEL_SELECT = `SELECT ch.*, (a.active AND a.status <> 'paused') AS account_active FROM channels ch JOIN accounts a ON a.id = ch.account_id`;

function hydrateChannel(row: Channel | null): Channel | null {
  if (!row) return null;
  return { ...row, config: channelConfig(row.type, row.config) };
}

export async function listChannels(accountId: string | null, opts: { chatbotId?: string; includePlayground?: boolean } = {}): Promise<Channel[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (accountId) {
    params.push(accountId);
    where.push(`ch.account_id = $${params.length}`);
  }
  if (opts.chatbotId) {
    params.push(opts.chatbotId);
    where.push(`ch.chatbot_id = $${params.length}`);
  }
  if (!opts.includePlayground) where.push(`ch.type <> 'playground'`);
  const rows = await query<Channel>(`${CHANNEL_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ch.created_at`, params);
  return rows.map((r) => hydrateChannel(r)!);
}

export async function getChannel(id: string) {
  return hydrateChannel(await queryOne<Channel>(`${CHANNEL_SELECT} WHERE ch.id = $1`, [id]));
}

export async function getChannelByToken(token: string) {
  return hydrateChannel(await queryOne<Channel>(`${CHANNEL_SELECT} WHERE ch.webhook_token = $1`, [token]));
}

export const MAX_WHATSAPP_PROFILES = 4;

export class WhatsappProfileLimitError extends Error {
  readonly statusCode = 409;
  constructor() {
    super(`Esta cuenta ya tiene ${MAX_WHATSAPP_PROFILES} perfiles de WhatsApp. Elimina uno para conectar otro número.`);
  }
}

export async function createChannel(c: { account_id: string; chatbot_id: string | null; type: ChannelType; name: string; active?: boolean; config: Record<string, unknown> }) {
  const id = await withTransaction(async (client) => {
    if (c.type === 'whatsapp') {
      // Serialize reservations per account, including concurrent onboarding requests.
      await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [c.account_id]);
      const count = await client.query("SELECT count(*)::int AS total FROM channels WHERE account_id = $1 AND type = 'whatsapp'", [c.account_id]);
      if (count.rows[0].total >= MAX_WHATSAPP_PROFILES) throw new WhatsappProfileLimitError();
    }
    const result = await client.query(
      `INSERT INTO channels (account_id, chatbot_id, type, name, active, config, webhook_token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [c.account_id, c.chatbot_id, c.type, c.name, c.active ?? true, JSON.stringify(c.config), newWebhookToken()],
    );
    return result.rows[0].id as string;
  });
  return (await getChannel(id))!;
}

export async function updateChannel(id: string, patch: { name?: string; active?: boolean; chatbot_id?: string | null; config?: Record<string, unknown> }) {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.active !== undefined) set('active', patch.active);
  if (patch.chatbot_id !== undefined) set('chatbot_id', patch.chatbot_id);
  if (patch.config !== undefined) set('config', JSON.stringify(patch.config));
  if (sets.length) {
    params.push(id);
    await query(`UPDATE channels SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  return getChannel(id);
}

export async function rotateChannelToken(id: string): Promise<string> {
  const token = newWebhookToken();
  await query('UPDATE channels SET webhook_token = $1, updated_at = now() WHERE id = $2', [token, id]);
  return token;
}

export async function deleteChannel(id: string) {
  await query('DELETE FROM channels WHERE id = $1', [id]);
}

/** Canal interno del simulador de un chatbot (se crea al usarlo por primera vez). */
export async function getOrCreatePlaygroundChannel(bot: Chatbot): Promise<Channel> {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM channels WHERE chatbot_id = $1 AND type = 'playground'`, [bot.id]);
  if (existing) return (await getChannel(existing.id))!;
  await query(
    `INSERT INTO channels (account_id, chatbot_id, type, name, webhook_token) VALUES ($1,$2,'playground','Simulador',$3)
     ON CONFLICT DO NOTHING`,
    [bot.account_id, bot.id, newWebhookToken()],
  );
  const row = await queryOne<{ id: string }>(`SELECT id FROM channels WHERE chatbot_id = $1 AND type = 'playground'`, [bot.id]);
  return (await getChannel(row!.id))!;
}

/* ----------------------------- Conocimiento ---------------------------- */

export async function listKnowledge(chatbotId: string, onlyActive = false): Promise<KnowledgeItem[]> {
  return query<KnowledgeItem>(
    `SELECT * FROM knowledge_items WHERE chatbot_id = $1 ${onlyActive ? 'AND active' : ''} ORDER BY sort_order, created_at`,
    [chatbotId],
  );
}

export async function getKnowledge(id: string) {
  return queryOne<KnowledgeItem>('SELECT * FROM knowledge_items WHERE id = $1', [id]);
}

export async function upsertKnowledge(chatbotId: string, item: Partial<KnowledgeItem> & { id?: string }, client?: Queryable): Promise<KnowledgeItem> {
  if (item.id) {
    const rows = await rowsOf(client,
      `UPDATE knowledge_items SET category = COALESCE($2, category), title = COALESCE($3, title), content = COALESCE($4, content),
         always_include = COALESCE($5, always_include), active = COALESCE($6, active), sort_order = COALESCE($7, sort_order),
         source_url = CASE WHEN $9::boolean THEN $10 ELSE source_url END, updated_at = now()
       WHERE id = $1 AND chatbot_id = $8 RETURNING *`,
      [item.id, item.category ?? null, item.title ?? null, item.content ?? null, item.always_include ?? null, item.active ?? null, item.sort_order ?? null, chatbotId, item.source_url !== undefined, item.source_url ?? null],
    );
    if (!rows[0]) throw new Error('Elemento no encontrado');
    return rows[0];
  }
  const rows = await rowsOf(client,
    `INSERT INTO knowledge_items (chatbot_id, category, title, content, always_include, active, sort_order, source_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [chatbotId, item.category ?? 'general', item.title ?? '', item.content ?? '', item.always_include ?? false, item.active ?? true, item.sort_order ?? 0, item.source_url ?? null],
  );
  return rows[0];
}

export async function deleteKnowledge(id: string) {
  await query('DELETE FROM knowledge_items WHERE id = $1', [id]);
}

/* ------------------------------- Imágenes ------------------------------ */

export async function listImages(chatbotId: string, onlyActive = false): Promise<ImageAsset[]> {
  const evaluated=evaluatedImages(chatbotId);
  if(evaluated) return onlyActive?evaluated.filter(i=>i.active):evaluated;
  return query<ImageAsset>(
    `SELECT * FROM images WHERE chatbot_id = $1 ${onlyActive ? 'AND active' : ''} ORDER BY created_at`,
    [chatbotId],
  );
}

export async function getImage(id: string) {
  return queryOne<ImageAsset>('SELECT * FROM images WHERE id = $1', [id]);
}

export async function insertImage(img: Omit<ImageAsset, 'id' | 'active'> & { active?: boolean; sha256?: string }): Promise<ImageAsset> {
  const row = await queryOne<ImageAsset>(
    `INSERT INTO images (chatbot_id, code, name, description, usage_rule, caption, file_path, mime_type, size_bytes, active, send_when, sha256, kind, file_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [img.chatbot_id, img.code, img.name, img.description, img.usage_rule, img.caption, img.file_path, img.mime_type, img.size_bytes, img.active ?? true, JSON.stringify(img.send_when ?? {}), img.sha256 ?? '', img.kind ?? 'image', img.file_name ?? ''],
  );
  return row!;
}

export async function updateImage(id: string, patch: Partial<ImageAsset>, client?: Queryable): Promise<ImageAsset | null> {
  const allowed = ['code', 'name', 'description', 'usage_rule', 'caption', 'active', 'file_path', 'mime_type', 'size_bytes', 'send_when', 'sha256', 'kind', 'file_name'] as const;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      params.push(k === 'send_when' ? JSON.stringify(patch[k]) : patch[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return getImage(id);
  params.push(id);
  return (await rowsOf(client, `UPDATE images SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params))[0] ?? null;
}

/**
 * Borra una foto y la quita de las reglas automáticas y secuencias que la usaban (no tienen llave foránea): así siguen
 * pudiéndose guardar y desactivar. Devuelve sus nombres para avisarle al negocio.
 */
export async function deleteImage(id: string): Promise<{ automations: string[]; sequences: string[] }> {
  const strip = (col: string) =>
    `${col} = (SELECT coalesce(jsonb_agg(CASE WHEN e->>'image_id' = $1 THEN jsonb_set(e, '{image_id}', '""') ELSE e END ORDER BY i), '[]'::jsonb)
       FROM jsonb_array_elements(${col}) WITH ORDINALITY AS t(e, i))`;
  return withTransaction(async (client) => {
    const autos = await client.query<{ name: string }>(`UPDATE automations SET ${strip('actions')} WHERE actions @> jsonb_build_array(jsonb_build_object('image_id', $1::text)) RETURNING name`, [id]);
    const seqs = await client.query<{ name: string }>(`UPDATE sequences SET ${strip('steps')} WHERE steps @> jsonb_build_array(jsonb_build_object('image_id', $1::text)) RETURNING name`, [id]);
    await client.query('DELETE FROM images WHERE id = $1', [id]);
    return { automations: autos.rows.map((r) => r.name), sequences: seqs.rows.map((r) => r.name) };
  });
}

/* ------------------------- Contactos y conversaciones ------------------------- */

export async function upsertContact(channel: Pick<Channel, 'id' | 'account_id'>, externalId: string, phone: string, pushName: string): Promise<Contact> {
  const row = await queryOne<Contact>(
    `INSERT INTO contacts (account_id, channel_id, external_id, phone, push_name) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel_id, external_id) DO UPDATE SET
       push_name = CASE WHEN EXCLUDED.push_name <> '' THEN EXCLUDED.push_name ELSE contacts.push_name END,
       phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE contacts.phone END,
       updated_at = now()
     RETURNING *`,
    [channel.account_id, channel.id, externalId, phone, pushName],
  );
  return row!;
}

export async function findContact(channelId: string, externalId: string) {
  return queryOne<Contact>('SELECT * FROM contacts WHERE channel_id = $1 AND external_id = $2', [channelId, externalId]);
}

export async function getContact(id: string) {
  return queryOne<Contact>('SELECT * FROM contacts WHERE id = $1', [id]);
}

const TASK_SELECT = `SELECT t.id, t.account_id, t.contact_id, t.conversation_id, t.kind, t.body, t.status,
  to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.created_by, u.name AS created_by_name, t.created_via, t.done_at, t.done_by, t.created_at, t.updated_at
  FROM contact_tasks t LEFT JOIN users u ON u.id = t.created_by`;

/** Pendientes y notas del contacto: las abiertas primero (por fecha límite); luego lo hecho y las notas, más recientes primero. */
export function listContactTasks(contactId: string) {
  return query<ContactTask>(`${TASK_SELECT} WHERE t.contact_id = $1 ORDER BY (t.status = 'abierta') DESC, t.due_on NULLS LAST, t.created_at DESC`, [contactId]);
}

export function getContactTask(id: string) {
  return queryOne<ContactTask>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
}

export async function insertContactTask(row: Pick<ContactTask, 'account_id' | 'contact_id' | 'conversation_id' | 'kind' | 'body' | 'due_on' | 'created_by' | 'created_via'>) {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO contact_tasks (account_id, contact_id, conversation_id, kind, body, due_on, created_by, created_via) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [row.account_id, row.contact_id, row.conversation_id, row.kind, row.body, row.due_on, row.created_by, row.created_via],
  );
  return inserted!.id;
}

/** Cambia solo los campos indicados. Las columnas las fija el código que llama, nunca el cliente. */
export async function updateContactTask(id: string, patch: Partial<Pick<ContactTask, 'body' | 'status' | 'due_on' | 'done_at' | 'done_by'>>) {
  const entries = Object.entries(patch);
  const sets = entries.map(([column], i) => `${column} = $${i + 2}`);
  await query(`UPDATE contact_tasks SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1`, [id, ...entries.map(([, value]) => value)]);
}

export async function deleteContactTask(id: string) {
  await query('DELETE FROM contact_tasks WHERE id = $1', [id]);
}

type ContactPatch = { name?: string; data?: Record<string, string>; notes?: string[]; tags?: string[]; opted_out?: boolean; /** Versión de datos que vio el panel: si cambió, no se guarda. */ expectedDataVersion?: number };

export async function updateContact(id: string, patch: Pick<ContactPatch, 'name' | 'data' | 'notes'>) {
  return (await updateContactFromPanel(id, patch))?.contact ?? null;
}

/** Capture the previous values under the same lock as the write, so repeated edits emit no duplicate events. */
export async function updateContactFromPanel(id: string, patch: ContactPatch) {
  return withTransaction(async (client) => {
    const before = (await client.query<Contact>('SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) return null;
    if (patch.expectedDataVersion !== undefined) {
      const current = (await client.query<{ v: number }>('SELECT COALESCE(max(data_version), 0)::int AS v FROM conversations WHERE contact_id = $1', [id])).rows[0].v;
      if (current !== patch.expectedDataVersion) throw new StaleDataError('Los datos cambiaron mientras los editabas');
    }
    const contact = (await client.query<Contact>(
      `UPDATE contacts SET name = COALESCE($2, name), data = COALESCE($3, data), notes = COALESCE($4, notes),
       tags = COALESCE($5, tags), opted_out = COALESCE($6, opted_out),
       opted_out_at = CASE WHEN $6::boolean IS NULL OR $6 = opted_out THEN opted_out_at WHEN $6 THEN now() ELSE NULL END,
       updated_at = now() WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.data !== undefined ? JSON.stringify(patch.data) : null,
       patch.notes !== undefined ? JSON.stringify(patch.notes) : null,
       patch.tags !== undefined ? JSON.stringify([...new Set(patch.tags)].slice(0, 50)) : null, patch.opted_out ?? null],
    )).rows[0];
    if (patch.data !== undefined || patch.name !== undefined || patch.notes !== undefined) {
      await client.query('UPDATE conversations SET data = COALESCE($2::jsonb, data), data_version = data_version + 1 WHERE contact_id = $1', [id, patch.data !== undefined ? JSON.stringify(patch.data) : null]);
    }
    const fields = new Set(Object.entries(contact.data).filter(([field, value]) => value && value !== before.data[field]).map(([field]) => field));
    if (contact.name && contact.name !== before.name) fields.add('nombre');
    return { contact, changedFields: [...fields], optedOut: !before.opted_out && contact.opted_out,
      addedTags: contact.tags.filter(tag => !before.tags.some(old => old.toLowerCase() === tag.toLowerCase())) };
  });
}

/** Merge only the new answers, atomically, into both records; never replace a stale snapshot. */
/** Notas por cliente: el mismo límite que el panel y la API (50). Antes la IA recortaba a 30 y borraba notas guardadas. */
export const MAX_NOTES = 50;

/** Los datos cambiaron después de que la persona abrió el formulario: no se sobrescriben. */
export class StaleDataError extends Error {}

export async function saveConversationMemory(conversationId: string, contactId: string, patch: { data: Record<string, string>; name?: string; remember: string[] }, sourceMessageId?: number, sourceMessageIds?: Record<string, number>) {
  return withTransaction(async (client) => {
    const contact = (await client.query<Contact>('SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [contactId])).rows[0];
    if (!contact) throw new Error('Contacto no encontrado');
    const conversation = (await client.query<Conversation>('SELECT * FROM conversations WHERE id = $1 AND contact_id = $2 FOR UPDATE', [conversationId, contactId])).rows[0];
    if (!conversation) throw new Error('La conversación no pertenece al contacto');
    if (sourceMessageId !== undefined) {
      const source = await client.query("SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND direction = 'in'", [sourceMessageId, conversationId]);
      if (!source.rows.length) throw new Error('El mensaje de origen no pertenece a esta conversación');
    }
    const notes = [...contact.notes];
    for (const note of patch.remember) {
      if (!notes.some((n) => n.trim().toLowerCase() === note.trim().toLowerCase())) notes.push(note);
    }
    const updated = await client.query<Contact>(
      'UPDATE contacts SET data = data || $2::jsonb, name = COALESCE($3, name), notes = $4, updated_at = now() WHERE id = $1 RETURNING *',
      [contactId, JSON.stringify(patch.data), patch.name ?? null, JSON.stringify(notes.slice(-MAX_NOTES))],
    );
    await client.query('UPDATE conversations SET data = data || $2::jsonb, data_version = data_version + 1 WHERE id = $1', [conversationId, JSON.stringify(patch.data)]);
    const provenance = sourceMessageIds ?? (sourceMessageId !== undefined ? Object.fromEntries(Object.keys(patch.data).map((key) => [key, sourceMessageId])) : {});
    for (const messageId of new Set(Object.values(provenance))) {
      const captured = Object.fromEntries(Object.entries(provenance).filter(([key, id]) => id === messageId && Object.hasOwn(patch.data, key)).map(([key]) => [key, patch.data[key]]));
      if (!Object.keys(captured).length) continue;
      const source = await client.query("SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND direction = 'in'", [messageId, conversationId]);
      if (!source.rows.length) throw new Error('El mensaje de origen no pertenece a esta conversación');
      // Original questions and replies remain intact; each answer points to its actual message.
      await client.query("UPDATE messages SET meta = meta || jsonb_build_object('captured_data', COALESCE(meta->'captured_data', '{}'::jsonb) || $2::jsonb) WHERE id = $1", [messageId, JSON.stringify(captured)]);
    }
    return updated.rows[0];
  });
}

/**
 * Reinicia la conversación: el asistente empieza de cero con este cliente. Olvida el resumen y el historial (que se
 * conserva para el equipo), vuelve a la primera etapa y la siguiente respuesta cuenta como bienvenida (y sus fotos,
 * las de etapa y objetivo vuelven a salir).
 */
const RESTART_SQL = `summary = '', restarted_after_id = GREATEST(restarted_after_id, COALESCE((SELECT max(id) FROM messages WHERE conversation_id = conversations.id), 0)),
  summary_until_id = GREATEST(restarted_after_id, COALESCE((SELECT max(id) FROM messages WHERE conversation_id = conversations.id), 0)), data_version = data_version + 1,
  flow_step = 0, goal_completed_at = NULL, flow_started_at = now(), questions_done_at = NULL`;

/** Desde la conversación («Reiniciar conversación»): además borra lo que se sabe del cliente (datos, nombre y notas). */
export async function resetConversationMemory(conversationId: string, contactId: string) {
  await beginRequest(conversationId, { reason: 'reinicio' });
  await withTransaction(async (client) => {
    await client.query('SELECT id FROM contacts WHERE id = $1 FOR UPDATE', [contactId]);
    const scope = await client.query('SELECT id FROM conversations WHERE id = $1 AND contact_id = $2 FOR UPDATE', [conversationId, contactId]);
    if (!scope.rows.length) throw new Error('La conversación no pertenece al contacto');
    await client.query("UPDATE contacts SET data = '{}', notes = '[]', name = '', updated_at = now() WHERE id = $1", [contactId]);
    await client.query(`UPDATE conversations SET ${RESTART_SQL},
      report_summary = '', report_analysis = '{}'::jsonb, report_until_id = 0, report_at = NULL, report_data_version = -1, data = '{}'
      WHERE id = $1 AND contact_id = $2`, [conversationId, contactId]);
  });
}

/**
 * Al actualizar un asistente: todas sus conversaciones empiezan de cero con la configuración nueva. Se conservan los
 * datos de los clientes, su reporte, quién atiende cada una y si el asistente está en pausa o esperando su palabra de
 * activación (así ningún cliente pierde la atención ni la recibe si la había pausado). Devuelve cuántas se reiniciaron.
 */
export async function restartChatbotConversations(chatbotId: string): Promise<number> {
  const ids = await query<{ id: string }>('SELECT id FROM conversations WHERE chatbot_id = $1', [chatbotId]);
  for (const { id } of ids) await beginRequest(id, { reason: 'reinicio' });
  const rows = await query<{ id: string }>(`UPDATE conversations SET ${RESTART_SQL} WHERE chatbot_id = $1 RETURNING id`, [chatbotId]);
  return rows.length;
}

/* ------------------------------ Solicitudes ------------------------------ */

/** Por qué empezó una solicitud: el cliente volvió tras un tiempo, la IA detectó que pide lo mismo otra vez, se reabrió… */
export type RequestReason = 'tiempo' | 'contenido' | 'reapertura' | 'campaña' | 'reinicio';

export interface ConversationRequest {
  number: number;
  reason: RequestReason | 'inicio';
  started_at: Date;
  ended_at: Date | null;
  goal_completed_at: Date | null;
  data: Record<string, string>;
}

/**
 * El cliente empieza una solicitud nueva (otra reserva, el mismo problema otra vez…): se cierra la actual guardando si
 * cumplió su objetivo y sus respuestas, y la conversación vuelve a la primera etapa (o a `step`), con objetivo, preguntas,
 * fotos y avisos «una vez» contando de nuevo. Las respuestas a las preguntas que se repiten en cada solicitud se archivan
 * y se borran de los datos del cliente para volver a preguntarlas; el nombre, el correo y el teléfono se conservan.
 * Devuelve el número de la solicitud nueva.
 */
export async function beginRequest(conversationId: string, o: { reason: RequestReason; step?: number; since?: Date }): Promise<number> {
  return withTransaction(async (client) => {
    const conv = (await client.query('SELECT * FROM conversations WHERE id = $1 FOR UPDATE', [conversationId])).rows[0] as Conversation | undefined;
    if (!conv) return 0;
    const botRow = conv.chatbot_id ? (await client.query('SELECT * FROM chatbots WHERE id = $1', [conv.chatbot_id])).rows[0] : null;
    const keys = botRow ? perRequestKeys(hydrateChatbot(botRow)) : [];
    const contact = (await client.query('SELECT data FROM contacts WHERE id = $1 FOR UPDATE', [conv.contact_id])).rows[0] as { data: Record<string, string> } | undefined;
    const data = contact?.data ?? {};
    const answers = JSON.stringify(Object.fromEntries(keys.filter((k) => data[k]).map((k) => [k, data[k]])));
    const last = ((await client.query('SELECT max(number)::int AS n FROM conversation_requests WHERE conversation_id = $1', [conv.id])).rows[0]?.n as number | null) ?? 0;
    if (last) {
      await client.query('UPDATE conversation_requests SET ended_at = now(), goal_completed_at = $3, data = $4 WHERE conversation_id = $1 AND number = $2', [conv.id, last, conv.goal_completed_at ?? null, answers]);
    } else {
      // La primera solicitud no tenía registro: empezó con la conversación (o en su último recorrido).
      await client.query(
        `INSERT INTO conversation_requests (conversation_id, number, reason, started_at, ended_at, goal_completed_at, data) VALUES ($1, 1, 'inicio', $2, now(), $3, $4)`,
        [conv.id, conv.flow_started_at ?? (conv as Conversation & { created_at?: Date }).created_at ?? new Date(), conv.goal_completed_at ?? null, answers],
      );
    }
    const number = Math.max(last, 1) + 1;
    await client.query('INSERT INTO conversation_requests (conversation_id, number, reason, started_at) VALUES ($1, $2, $3, coalesce($4::timestamptz, now()))', [conv.id, number, o.reason, o.since ?? null]);
    // La tarjeta del pipeline es de la solicitud: se cierra (como ganada o perdida) y la nueva empieza en la primera
    // columna. Un reinicio por cambios en el agente no cambia lo que el cliente pidió: su tarjeta sigue abierta.
    if (o.reason !== 'reinicio') await closeCardForRequest(client, conv.id, !!conv.goal_completed_at);
    if (keys.length) await client.query('UPDATE contacts SET data = data - $2::text[], updated_at = now() WHERE id = $1', [conv.contact_id, keys]);
    await client.query(
      `UPDATE conversations SET data = data - $2::text[], data_version = data_version + 1, flow_step = $3, goal_completed_at = NULL,
         questions_done_at = NULL, flow_started_at = coalesce($4::timestamptz, now()) WHERE id = $1`,
      [conv.id, keys, o.step ?? 0, o.since ?? null],
    );
    return number;
  });
}

/** Solicitudes de la conversación, de la primera a la actual (vacío si nunca empezó una segunda). */
export async function listRequests(conversationId: string): Promise<ConversationRequest[]> {
  return query<ConversationRequest>('SELECT number, reason, started_at, ended_at, goal_completed_at, data FROM conversation_requests WHERE conversation_id = $1 ORDER BY number', [conversationId]);
}

/** Cuándo fue el último mensaje (de cualquiera) antes de este: para saber si el cliente vuelve tras un tiempo. */
export async function lastActivityBefore(conversationId: string, messageId: number): Promise<Date | null> {
  const row = await queryOne<{ at: Date | null }>('SELECT max(created_at) AS at FROM messages WHERE conversation_id = $1 AND id < $2', [conversationId, messageId]);
  return row?.at ?? null;
}

/** Conversación del contacto; el chatbot que la atiende siempre es el asignado actualmente al canal. */
export async function getOrCreateConversation(channel: Pick<Channel, 'id' | 'account_id' | 'chatbot_id'>, contactId: string): Promise<Conversation> {
  const row = await queryOne<Conversation>(
    `INSERT INTO conversations (account_id, channel_id, chatbot_id, contact_id, data) VALUES ($1,$2,$3,$4,(SELECT data FROM contacts WHERE id = $4))
     ON CONFLICT (contact_id) DO UPDATE SET chatbot_id = EXCLUDED.chatbot_id
     RETURNING *`,
    [channel.account_id, channel.id, channel.chatbot_id, contactId],
  );
  return row!;
}

export async function getConversation(id: string) {
  return queryOne<Conversation>('SELECT * FROM conversations WHERE id = $1', [id]);
}

/** ¿La conversación de este contacto está asignada a esta persona? (Lo que un agente puede ver de un contacto.) */
export async function contactAssignedTo(contactId: string, userId: string) {
  return !!(await queryOne(`SELECT 1 FROM conversations WHERE contact_id = $1 AND assigned_user_id = $2`, [contactId, userId]));
}

export async function setConversationStatus(id: string, status: ConversationStatus, reason = '') {
  return queryOne<Conversation>(
    `UPDATE conversations SET status = $2, handoff_reason = $3, status_changed_at = now() WHERE id = $1 RETURNING *`,
    [id, status, reason],
  );
}

/** Only one concurrent caller owns the transition and its handoff event. */
export async function takeConversation(id: string, reason: string) {
  return queryOne<Conversation>(
    "UPDATE conversations SET status = 'human', handoff_reason = $2, status_changed_at = now() WHERE id = $1 AND status <> 'human' RETURNING *",
    [id, reason],
  );
}

/** Desde dónde tomó una persona la conversación: teléfono, panel… (vacío = nunca). */
export type HandoffVia = 'telefono' | 'panel' | 'regla' | 'bot' | '';

/** Queda en el contacto quién tomó su conversación y desde dónde. */
export async function markHandoff(contactId: string, userId: string | null, via: HandoffVia) {
  await query('UPDATE contacts SET handoff_at = now(), handoff_by = $2, handoff_via = $3 WHERE id = $1', [contactId, userId, via]);
}

export async function updateSummary(id: string, summary: string, untilId: number, expectedVersion?: number) {
  await query(`UPDATE conversations SET summary = $2, summary_until_id = $3 WHERE id = $1
    AND summary_until_id <= $3 AND ($4::bigint IS NULL OR data_version = $4)`, [id, summary, untilId, expectedVersion ?? null]);
}

export async function saveConversationReport(id: string, summary: string, untilId: number, expectedVersion: number, captures: { field: string; value: string; messageId: number }[] = [], analysis: Record<string, unknown> = {}) {
  return withTransaction(async (client) => {
    const link = (await client.query('SELECT contact_id FROM conversations WHERE id = $1', [id])).rows[0];
    if (!link) return null;
    const contact = (await client.query<Contact>('SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [link.contact_id])).rows[0];
    const conversation = (await client.query<Conversation>('SELECT * FROM conversations WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!contact || !conversation || conversation.data_version !== expectedVersion || conversation.report_until_id > untilId) return null;
    const added: Record<string, string> = {};
    for (const capture of captures) {
      // Report extraction fills omitted answers; it never overwrites a later/manual correction.
      if (Object.hasOwn(contact.data, capture.field) || Object.keys(contact.data).length + Object.keys(added).length >= 100) continue;
      const source = await client.query("SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND direction = 'in'", [capture.messageId, id]);
      if (!source.rows.length) throw new Error('El dato no tiene un mensaje de origen válido');
      added[capture.field] = capture.value;
      await client.query("UPDATE messages SET meta = meta || jsonb_build_object('captured_data', COALESCE(meta->'captured_data', '{}'::jsonb) || $2::jsonb) WHERE id = $1", [capture.messageId, JSON.stringify({ [capture.field]: capture.value })]);
    }
    const changed = Object.keys(added).length > 0;
    if (changed) await client.query("UPDATE contacts SET data = data || $2::jsonb, name = CASE WHEN $3 <> '' THEN $3 ELSE name END, updated_at = now() WHERE id = $1", [contact.id, JSON.stringify(added), added.nombre ?? '']);
    const result = await client.query<Conversation>(`UPDATE conversations SET report_summary = $2, report_until_id = $3, report_at = now(), report_analysis = $6::jsonb,
      data = data || $4::jsonb, data_version = data_version + $5, report_data_version = data_version + $5 WHERE id = $1 RETURNING *`,
      [id, summary, untilId, JSON.stringify(added), changed ? 1 : 0, JSON.stringify(analysis)]);
    return result.rows[0];
  });
}

/* -------------------------------- Mensajes ------------------------------- */

export interface NewMessage {
  queueDelayMs?: number;
  /** Foto o documento del cliente ya guardado en disco: se registra en la misma transacción que el mensaje. */
  media?: StoredMedia;
  conversation_id: string;
  direction: 'in' | 'out';
  sender: Message['sender'];
  type?: string;
  content: string;
  image_id?: string | null;
  external_message_id?: string | null;
  processed?: boolean;
  status?: string;
  meta?: Record<string, unknown>;
}

/** Inserta un mensaje. Devuelve null si ya existía (webhook duplicado). */
export async function insertMessage(m: NewMessage, transaction?: import('pg').PoolClient): Promise<Message | null> {
  const insert = async (client: import('pg').PoolClient) => {
    const result = await client.query<Message>(
      `INSERT INTO messages (conversation_id, direction, sender, type, content, image_id, external_message_id, processed, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        m.conversation_id,
        m.direction,
        m.sender,
        m.type ?? 'text',
        m.content,
        m.image_id ?? null,
        m.external_message_id ?? null,
        m.processed ?? true,
        m.status ?? 'ok',
        JSON.stringify(m.meta ?? {}),
      ],
    );
    const row = result.rows[0] ?? null;
    if (row) await client.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [m.conversation_id]);
    if (row && m.queueDelayMs !== undefined) await enqueue(m.conversation_id, m.queueDelayMs, client);
    if (row && m.media) {
      // Si esto falla, se deshace también el mensaje: nunca queda un mensaje que diga "foto" sin su archivo.
      await client.query(
        `INSERT INTO message_media (message_id, kind, mime, file_name, size_bytes, sha256, file_path, complete, ai_summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.id, m.media.kind, m.media.mime, m.media.file_name, m.media.size_bytes, m.media.sha256, m.media.file_path, m.media.complete, m.media.ai_summary ?? ''],
      );
    }
    return row;
  };
  return transaction ? insert(transaction) : withTransaction(insert);
}

export async function updateMessage(id: number, patch: { external_message_id?: string | null; status?: string; meta?: Record<string, unknown> }) {
  await withTransaction(async (client) => {
    const previous = (await client.query<Message>('SELECT * FROM messages WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!previous) return;
    await client.query(
      `UPDATE messages SET external_message_id = COALESCE($2, external_message_id), status = COALESCE($3, status),
         meta = CASE WHEN $4::jsonb IS NULL THEN meta ELSE meta || $4::jsonb END WHERE id = $1`,
      [id, patch.external_message_id ?? null, patch.status ?? null, patch.meta ? JSON.stringify(patch.meta) : null],
    );
    if (patch.status !== undefined && patch.status !== previous.status) {
      await client.query('UPDATE conversations SET data_version = data_version + 1 WHERE id = $1', [previous.conversation_id]);
    }
  });
}

export async function findMessageByExternalId(conversationId: string, externalId: string) {
  return queryOne<Message>('SELECT * FROM messages WHERE conversation_id = $1 AND external_message_id = $2', [conversationId, externalId]);
}

/** Guarda un aviso interno que acabamos de enviar, para reconocer su eco aunque no pertenezca a ninguna conversación. */
export async function recordInternalNotice(accountId: string, phone: string, content: string) {
  await query(`DELETE FROM internal_notices WHERE created_at < now() - interval '1 day'`);
  await query(`INSERT INTO internal_notices (account_id, phone, content) VALUES ($1,$2,$3)`, [accountId, phone, content.slice(0, 4000)]);
}

/** Consume el registro de un aviso interno cuyo eco acaba de llegar. Devuelve false si no fue un aviso nuestro. */
export async function consumeInternalNotice(accountId: string, phone: string, content: string) {
  const row = await queryOne<{ id: string }>(
    `DELETE FROM internal_notices WHERE id = (
       SELECT id FROM internal_notices WHERE account_id = $1 AND phone = $2 AND content = $3
         AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC LIMIT 1)
     RETURNING id`,
    [accountId, phone, content.slice(0, 4000)],
  );
  return !!row;
}

/** Busca un mensaje saliente reciente con el mismo texto (para reconocer ecos de nuestros propios envíos). */
export async function findRecentOutgoingEcho(conversationId: string, content: string, seconds = 120) {
  return queryOne<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'out' AND sender IN ('bot','human','system')
       AND content = $2 AND created_at > now() - ($3 || ' seconds')::interval ORDER BY id DESC LIMIT 1`,
    [conversationId, content, String(seconds)],
  );
}

/** Mensajes enviados por nosotros hace poco (para reconocer un eco que la plataforma devuelve sin formato). */
export async function recentOutgoing(conversationId: string, seconds = 120) {
  return query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'out' AND sender IN ('bot','human','system')
       AND created_at > now() - ($2 || ' seconds')::interval ORDER BY id DESC LIMIT 20`,
    [conversationId, String(seconds)],
  );
}

/** Imagen enviada por nosotros hace poco cuyo ID aún no se guardó (eco que llega antes que la respuesta HTTP). */
/**
 * Eco de una foto, video, documento o audio que enviamos: su texto no sirve para reconocerlo (va vacío o es el nombre del
 * archivo), así que se busca el envío reciente del mismo tipo que aún no tiene identificador de la plataforma.
 */
export async function findRecentOutgoingMediaEcho(conversationId: string, type: 'image' | 'video' | 'document' | 'audio', seconds = 120) {
  return queryOne<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'out' AND type = $3 AND sender IN ('bot','human','system')
       AND external_message_id IS NULL AND created_at > now() - ($2 || ' seconds')::interval ORDER BY id LIMIT 1`,
    [conversationId, String(seconds), type],
  );
}

export async function pendingInbound(conversationId: string): Promise<Message[]> {
  return query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'in' AND processed = false ORDER BY id`,
    [conversationId],
  );
}

export async function markProcessed(conversationId: string, upToId: number) {
  await query(`UPDATE messages SET processed = true WHERE conversation_id = $1 AND direction = 'in' AND processed = false AND id <= $2`, [conversationId, upToId]);
}

export async function markMessageProcessed(id: number) {
  await query(`UPDATE messages SET processed = true WHERE id = $1`, [id]);
}

export async function countInbound(conversationId: string): Promise<number> {
  const r = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [conversationId]);
  return r?.n ?? 0;
}

export async function isFirstLiveInbound(conversationId: string, messageId: number): Promise<boolean> {
  const row = await queryOne<{ first: boolean }>(
    // Tras reiniciar la conversación, cuenta desde el reinicio (vuelve la bienvenida).
    `SELECT $2::bigint = min(m.id) AS first FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = $1 AND m.direction = 'in' AND m.id > COALESCE(c.restarted_after_id, 0)
     AND m.type <> 'reaction' AND COALESCE(m.meta->>'stale', 'false') <> 'true'`, [conversationId, messageId],
  );
  return row?.first === true;
}

/* ----------------------- Arrendamiento de conversaciones (cola durable) ----------------------- */

/** Toma la conversación para este proceso. Falla si otro proceso la tiene y su arrendamiento sigue vigente. */
export async function claimConversation(id: string, owner: string, ttlSeconds = 300): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE conversations SET lease_owner = $2, lease_until = now() + make_interval(secs => $3), last_attempt_at = now()
     WHERE id = $1 AND (lease_until IS NULL OR lease_until < now() OR lease_owner = $2) RETURNING id`,
    [id, owner, ttlSeconds],
  );
  return !!row;
}

export async function renewConversationLease(id: string, owner: string, ttlSeconds = 300) {
  await query(`UPDATE conversations SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2`, [id, owner, ttlSeconds]);
}

export async function releaseConversation(id: string, owner: string) {
  await query(`UPDATE conversations SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2`, [id, owner]);
}

/**
 * Conversaciones con mensajes sin responder que nadie está atendiendo:
 *  - nunca se intentaron (se perdió el temporizador o llegaron a otro proceso que se cayó), o
 *  - se interrumpieron (arrendamiento vencido sin liberar: el proceso murió a la mitad).
 * Los errores de la IA no vuelven aquí: liberan el arrendamiento y ya se intentaron.
 */
export async function recoverableConversations(maxAgeMinutes = 15, limit = 50): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT c.id FROM conversations c
       JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN chatbots b ON b.id = c.chatbot_id
     WHERE ch.type <> 'playground'
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.processed = false AND m.direction = 'in'
                     AND m.created_at > now() - make_interval(mins => $1)
                     AND m.created_at < now() - make_interval(secs => GREATEST(COALESCE((b.ai->>'debounce_seconds')::float, 3), 3) + 5)
                     AND (c.last_attempt_at IS NULL OR m.created_at > c.last_attempt_at))
       AND (c.lease_until IS NULL OR c.lease_until < now())
     LIMIT $2`,
    [maxAgeMinutes, limit],
  );
  const interrupted = await query<{ id: string }>(
    `SELECT c.id FROM conversations c
     WHERE c.lease_until IS NOT NULL AND c.lease_until < now()
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.processed = false AND m.direction = 'in' AND m.created_at > now() - make_interval(mins => $1))
     LIMIT $2`,
    [maxAgeMinutes, limit],
  );
  return [...new Set([...rows, ...interrupted].map((r) => r.id))];
}

export async function markAllProcessed(conversationId: string) {
  await query(`UPDATE messages SET processed = true WHERE conversation_id = $1 AND processed = false`, [conversationId]);
}

/** Últimos N mensajes (en orden cronológico) con id <= beforeOrEqualId si se indica. */
export async function recentMessages(conversationId: string, limit: number): Promise<Message[]> {
  const rows = await query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND status NOT IN ('failed','uncertain','pending','cancelled') ORDER BY id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

/** Últimos `limit` mensajes posteriores al resumen (lo que la IA aún no tiene resumido), en orden cronológico. */
export async function unsummarizedMessages(conversationId: string, afterId: number, limit: number): Promise<Message[]> {
  const rows = await query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 AND status NOT IN ('failed','uncertain','pending','cancelled') ORDER BY id DESC LIMIT $3`,
    [conversationId, afterId, limit],
  );
  return rows.reverse();
}

export async function messagesBetween(conversationId: string, afterId: number, upToId: number): Promise<Message[]> {
  return query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 AND id <= $3 AND status NOT IN ('failed','uncertain','pending','cancelled') ORDER BY id`,
    [conversationId, afterId, upToId],
  );
}

export async function countMessagesAfter(conversationId: string, afterId: number): Promise<number> {
  const r = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND id > $2`, [conversationId, afterId]);
  return r?.n ?? 0;
}

export async function sentImageIds(conversationId: string): Promise<string[]> {
  const rows = await query<{ image_id: string }>(
    // Solo las del recorrido actual: al reabrir una conversación (flow_started_at) las fotos de etapa y objetivo vuelven a salir.
    `SELECT DISTINCT m.image_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = $1 AND m.direction = 'out' AND m.image_id IS NOT NULL AND m.status = 'ok'
       AND (c.flow_started_at IS NULL OR m.created_at >= c.flow_started_at)`,
    [conversationId],
  );
  return rows.map((r) => r.image_id);
}

/**
 * Preguntas de la lista en la conversación: cuántas veces se hizo cada una en el recorrido actual (`asked`) y en
 * toda la conversación (`askedEver`), y si ya se terminaron en este recorrido.
 */
export async function questionJourney(conversationId: string): Promise<{ asked: Record<string, number>; askedEver: Record<string, number>; done: boolean }> {
  const [rows, conv] = await Promise.all([
    query<{ key: string; n: number; ever: number }>(
      `SELECT m.meta->>'question' AS key,
              (count(*) FILTER (WHERE c.flow_started_at IS NULL OR m.created_at >= c.flow_started_at))::int AS n,
              count(*)::int AS ever
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND m.direction = 'out' AND m.status = 'ok' AND m.meta ? 'question'
        GROUP BY 1`,
      [conversationId],
    ),
    queryOne<{ done: boolean }>(`SELECT questions_done_at IS NOT NULL AS done FROM conversations WHERE id = $1`, [conversationId]),
  ]);
  return {
    asked: Object.fromEntries(rows.filter((r) => r.n > 0).map((r) => [r.key, r.n])),
    askedEver: Object.fromEntries(rows.map((r) => [r.key, r.ever])),
    done: !!conv?.done,
  };
}

/** Registra que se terminaron las preguntas en este recorrido. true solo la primera vez (no se dispara dos veces). */
export async function markQuestionsDone(conversationId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`UPDATE conversations SET questions_done_at = now() WHERE id = $1 AND questions_done_at IS NULL RETURNING id`, [conversationId]);
  return !!row;
}

/** ¿Ya llegó esta foto (entregada) desde ese momento? Evita duplicar un reenvío pendiente. */
export async function imageSentSince(conversationId: string, imageId: string, since: Date): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND image_id = $2 AND direction = 'out' AND status = 'ok' AND created_at >= $3`,
    [conversationId, imageId, since],
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Guarda la etapa del recorrido y, si `goal`, marca el objetivo como cumplido.
 * Devuelve true solo la primera vez que se cumple (evita repetir la acción al cumplirlo).
 */
export async function setFlowState(conversationId: string, step: number, goal: boolean): Promise<boolean> {
  const row = await queryOne<{ newly: boolean }>(
    `WITH old AS (SELECT goal_completed_at FROM conversations WHERE id = $1)
     UPDATE conversations SET flow_step = CASE WHEN $2::int > 0 THEN $2::int ELSE flow_step END,
       goal_completed_at = CASE WHEN $3::boolean AND goal_completed_at IS NULL THEN now() ELSE goal_completed_at END
     WHERE id = $1 RETURNING ($3::boolean AND (SELECT goal_completed_at FROM old) IS NULL) AS newly`,
    [conversationId, step, goal],
  );
  return !!row?.newly;
}

/* ------------------------------ Conexión de WhatsApp ------------------------------ */

export async function saveQr(channelId: string, qr: string) {
  await query(`UPDATE channels SET qr_code = $2, qr_at = now() WHERE id = $1`, [channelId, qr]);
}

/** Código por número y el número con el que vincula la instancia (`code` null: el número ya se pidió, el código aún no llega). */
export async function savePairingCode(channelId: string, code: string | null, number: string) {
  await query(`UPDATE channels SET pairing_code = $2, pairing_number = $3, pairing_at = now() WHERE id = $1`, [channelId, code, number]);
}

/** Código nuevo que llegó por webhook: solo si el canal se está vinculando por número (sustituye al anterior). */
export async function refreshPairingCode(channelId: string, code: string) {
  await query(`UPDATE channels SET pairing_code = $2, pairing_at = now() WHERE id = $1 AND pairing_number IS NOT NULL`, [channelId, code]);
}

/** Cambia el estado de conexión sin avisos (p.ej. al desconectar a propósito desde el panel). */
export async function setConnectionStateQuiet(channelId: string, state: string) {
  // Desconexión a propósito: no cuenta como caída (sin avisos ni reconexión automática).
  await query(`UPDATE channels SET connection_state = $2, connection_state_at = now(), down_since = NULL WHERE id = $1`, [channelId, state]);
}

/** Deja el estado de conexión como estaba (p.ej. si no se pudo desconectar a propósito). */
export async function restoreConnectionState(channelId: string, state: string | null | undefined, downSince: Date | null | undefined) {
  await query(`UPDATE channels SET connection_state = $2, down_since = $3 WHERE id = $1`, [channelId, state ?? null, downSince ?? null]);
}

export async function clearConnectionCodes(channelId: string) {
  await query(`UPDATE channels SET qr_code = NULL, qr_at = NULL, pairing_code = NULL, pairing_number = NULL, pairing_at = NULL WHERE id = $1`, [channelId]);
}

/**
 * Al reabrir (o desde el panel): el recorrido empieza de nuevo y el asistente vuelve a su estado inicial (sin pausa
 * ni activación). Con `keepCampaignStart`, un recorrido que una campaña empezó después de cerrarse la conversación
 * se conserva (el cliente contesta a esa campaña: sigue desde la etapa que marcó).
 */
export async function resetFlowState(conversationId: string, opts: { keepCampaignStart?: boolean } = {}) {
  const kept = !!opts.keepCampaignStart && !!(await queryOne('SELECT 1 FROM conversations WHERE id = $1 AND flow_started_at IS NOT NULL AND flow_started_at > status_changed_at', [conversationId]));
  // Al reabrirse empieza una solicitud nueva (salvo que la haya empezado una campaña después del cierre).
  if (!kept) await beginRequest(conversationId, { reason: 'reapertura' });
  await query(`UPDATE conversations SET agent_off_at = NULL, agent_off_reason = '', agent_off_until = NULL, agent_on_at = NULL WHERE id = $1`, [conversationId]);
}

/** Etapas del recorrido renumeradas (se quitó o movió una): las conversaciones de ese asistente siguen en la misma. */
export async function remapFlowSteps(chatbotId: string, map: number[], client?: Queryable) {
  await rowsOf(client, `UPDATE conversations SET flow_step = coalesce(($2::int[])[flow_step], 0) WHERE chatbot_id = $1 AND flow_step > 0 AND flow_step <= $3`, [chatbotId, map, map.length]);
}

/** Hora de la base de datos (la misma que usan created_at y flow_started_at). */
export async function dbNow(): Promise<Date> {
  return (await queryOne<{ now: Date }>('SELECT now() AS now'))!.now;
}

/** Una campaña empieza un recorrido nuevo en esta etapa (objetivo y preguntas vuelven a contar desde `since`, antes de su envío). */
export async function startFlowAt(conversationId: string, step: number, since?: Date) {
  await beginRequest(conversationId, { reason: 'campaña', step, since });
}

/* ------------------------- Asistente encendido / en pausa ------------------------- */

export async function setAgentOff(conversationId: string, reason: string, until: Date | null) {
  return queryOne<Conversation>(
    `UPDATE conversations SET agent_off_at = now(), agent_off_reason = $2, agent_off_until = $3 WHERE id = $1 RETURNING *`,
    [conversationId, reason, until],
  );
}

export async function setAgentOn(conversationId: string) {
  return queryOne<Conversation>(
    `UPDATE conversations SET agent_off_at = NULL, agent_off_reason = '', agent_off_until = NULL, agent_on_at = now() WHERE id = $1 RETURNING *`,
    [conversationId],
  );
}

export async function lastHumanActivity(conversationId: string): Promise<Date | null> {
  const r = await queryOne<{ t: Date | null }>(
    `SELECT max(created_at) AS t FROM messages WHERE conversation_id = $1 AND sender = 'human'`,
    [conversationId],
  );
  return r?.t ?? null;
}

/* --------------------------------- AI runs -------------------------------- */

export async function insertAiRun(run: {
  account_id: string;
  chatbot_id: string | null;
  conversation_id: string | null;
  kind: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  latency_ms: number;
  attempt?: number;
  decision?: unknown;
  validation?: unknown;
  audio_seconds?: number;
  cost_usd?: number;
}) {
  // Se usa el costo reportado por el proveedor; si falta, el precio vigente del modelo (prefijo más largo: "gpt-4.1-mini-2025-04-14" → "gpt-4.1-mini").
  // input_tokens ya incluye los tokens en caché, que se cobran a su propio precio.
  await query(
    `INSERT INTO ai_runs (account_id, chatbot_id, conversation_id, kind, model, input_tokens, cached_tokens, output_tokens, latency_ms, attempt, decision, validation, audio_seconds, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14::numeric, (
       SELECT (greatest($6::int - $7::int, 0) * p.input_per_mtok + $7::int * p.cached_per_mtok + $8::int * p.output_per_mtok) / 1000000.0
              + $13::int / 60.0 * p.per_audio_minute
       FROM ai_prices p WHERE (starts_with($5::text, p.model) OR starts_with(regexp_replace($5::text, '^openai/', ''), p.model)) ORDER BY length(p.model) DESC LIMIT 1), 0))`,
    [
      run.account_id,
      run.chatbot_id,
      run.conversation_id,
      run.kind,
      run.model,
      run.input_tokens,
      run.cached_tokens,
      run.output_tokens,
      run.latency_ms,
      run.attempt ?? 1,
      run.decision === undefined ? null : JSON.stringify(run.decision),
      run.validation === undefined ? null : JSON.stringify(run.validation),
      Math.round(run.audio_seconds ?? 0),
      run.cost_usd ?? null,
    ],
  );
}
