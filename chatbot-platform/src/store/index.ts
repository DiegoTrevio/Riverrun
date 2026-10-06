import crypto from 'node:crypto';
import { query, queryOne, withTransaction } from '../db.js';
import {
  channelConfig,
  hydrateChatbot,
  type Account,
  type AccountStatus,
  type Channel,
  type ChannelType,
  type Role,
  type User,
  type Chatbot,
  type ChatbotRow,
  type Contact,
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
  return rows[0] as Account;
}

export async function updateAccount(
  id: string,
  patch: { name?: string; active?: boolean; status?: AccountStatus; plan?: string; trial_ends_at?: Date | null; business_type?: string },
) {
  return queryOne<Account>(
    `UPDATE accounts SET name = COALESCE($2, name), active = COALESCE($3, active), status = COALESCE($4, status), plan = COALESCE($5, plan),
       trial_ends_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE trial_ends_at END,
       trial_warned_at = CASE WHEN $6::boolean THEN NULL ELSE trial_warned_at END,
       business_type = COALESCE($8, business_type), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.active ?? null, patch.status ?? null, patch.plan ?? null, patch.trial_ends_at !== undefined, patch.trial_ends_at ?? null, patch.business_type ?? null],
  );
}

/** Marca pasos del asistente de configuración como completados. */
export async function markOnboarding(accountId: string, steps: Record<string, boolean>) {
  return queryOne<Account>(`UPDATE accounts SET onboarding = onboarding || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`, [accountId, JSON.stringify(steps)]);
}

export async function deleteAccount(id: string) {
  await query('DELETE FROM accounts WHERE id = $1', [id]);
}

/* ------------------------------ Usuarios ------------------------------ */

const USER_COLS = 'id, account_id, role, name, email, phone, notify_whatsapp, active, email_verified_at, last_login_at, created_at';

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

export async function updateUser(
  id: string,
  patch: { name?: string; role?: Role; account_id?: string | null; active?: boolean; password_hash?: string; email?: string; phone?: string; notify_whatsapp?: boolean },
  expectedAccountId?: string,
) {
  return withTransaction(async (client) => {
    const result = await client.query<User>(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
       password_hash = COALESCE($5, password_hash), email = COALESCE($6, email),
       phone = COALESCE($7, phone), notify_whatsapp = COALESCE($8, notify_whatsapp),
       account_id = CASE WHEN $9::boolean THEN $10::uuid ELSE account_id END, updated_at = now()
     WHERE id = $1 AND ($11::uuid IS NULL OR account_id = $11) RETURNING ${USER_COLS}`,
      [id, patch.name ?? null, patch.role ?? null, patch.active ?? null, patch.password_hash ?? null, patch.email?.trim() ?? null, patch.phone?.replace(/\D/g, '') ?? null, patch.notify_whatsapp ?? null, patch.account_id !== undefined, patch.account_id ?? null, expectedAccountId ?? null],
    );
    const user = result.rows[0] ?? null;
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
  const deleted = await query('DELETE FROM users WHERE id = $1 AND ($2::uuid IS NULL OR account_id = $2) RETURNING id', [id, expectedAccountId ?? null]);
  return deleted.length > 0;
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
}

const CHATBOT_JSON_COLS = ['personality', 'rules', 'data_fields', 'flow', 'ai'] as const;
const CHATBOT_PLAIN_COLS = ['name', 'active'] as const;

export async function createChatbot(accountId: string, input: ChatbotInput): Promise<Chatbot> {
  const row = await queryOne<ChatbotRow>(
    `INSERT INTO chatbots (account_id, name, active, personality, rules, data_fields, flow, ai)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      accountId,
      input.name ?? 'Nuevo chatbot',
      input.active ?? false,
      JSON.stringify(input.personality ?? {}),
      JSON.stringify(input.rules ?? {}),
      JSON.stringify(input.data_fields ?? []),
      JSON.stringify(input.flow ?? {}),
      JSON.stringify(input.ai ?? {}),
    ],
  );
  return hydrateChatbot(row!);
}

export async function updateChatbot(id: string, input: ChatbotInput): Promise<Chatbot | null> {
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
  const row = await queryOne<ChatbotRow>(
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

export async function upsertKnowledge(chatbotId: string, item: Partial<KnowledgeItem> & { id?: string }): Promise<KnowledgeItem> {
  if (item.id) {
    const row = await queryOne<KnowledgeItem>(
      `UPDATE knowledge_items SET category = COALESCE($2, category), title = COALESCE($3, title), content = COALESCE($4, content),
         always_include = COALESCE($5, always_include), active = COALESCE($6, active), sort_order = COALESCE($7, sort_order), updated_at = now()
       WHERE id = $1 AND chatbot_id = $8 RETURNING *`,
      [item.id, item.category ?? null, item.title ?? null, item.content ?? null, item.always_include ?? null, item.active ?? null, item.sort_order ?? null, chatbotId],
    );
    if (!row) throw new Error('Elemento no encontrado');
    return row;
  }
  const row = await queryOne<KnowledgeItem>(
    `INSERT INTO knowledge_items (chatbot_id, category, title, content, always_include, active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [chatbotId, item.category ?? 'general', item.title ?? '', item.content ?? '', item.always_include ?? false, item.active ?? true, item.sort_order ?? 0],
  );
  return row!;
}

export async function deleteKnowledge(id: string) {
  await query('DELETE FROM knowledge_items WHERE id = $1', [id]);
}

/* ------------------------------- Imágenes ------------------------------ */

export async function listImages(chatbotId: string, onlyActive = false): Promise<ImageAsset[]> {
  return query<ImageAsset>(
    `SELECT * FROM images WHERE chatbot_id = $1 ${onlyActive ? 'AND active' : ''} ORDER BY created_at`,
    [chatbotId],
  );
}

export async function getImage(id: string) {
  return queryOne<ImageAsset>('SELECT * FROM images WHERE id = $1', [id]);
}

export async function insertImage(img: Omit<ImageAsset, 'id' | 'active'> & { active?: boolean }): Promise<ImageAsset> {
  const row = await queryOne<ImageAsset>(
    `INSERT INTO images (chatbot_id, code, name, description, usage_rule, caption, file_path, mime_type, size_bytes, active, send_when)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [img.chatbot_id, img.code, img.name, img.description, img.usage_rule, img.caption, img.file_path, img.mime_type, img.size_bytes, img.active ?? true, JSON.stringify(img.send_when ?? {})],
  );
  return row!;
}

export async function updateImage(id: string, patch: Partial<ImageAsset>): Promise<ImageAsset | null> {
  const allowed = ['code', 'name', 'description', 'usage_rule', 'caption', 'active', 'file_path', 'mime_type', 'size_bytes', 'send_when'] as const;
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
  return queryOne<ImageAsset>(`UPDATE images SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
}

export async function deleteImage(id: string) {
  await query('DELETE FROM images WHERE id = $1', [id]);
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

type ContactPatch = { name?: string; data?: Record<string, string>; notes?: string[]; tags?: string[]; opted_out?: boolean };

export async function updateContact(id: string, patch: Pick<ContactPatch, 'name' | 'data' | 'notes'>) {
  return (await updateContactFromPanel(id, patch))?.contact ?? null;
}

/** Capture the previous values under the same lock as the write, so repeated edits emit no duplicate events. */
export async function updateContactFromPanel(id: string, patch: ContactPatch) {
  return withTransaction(async (client) => {
    const before = (await client.query<Contact>('SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) return null;
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
      [contactId, JSON.stringify(patch.data), patch.name ?? null, JSON.stringify(notes.slice(-30))],
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

export async function resetConversationMemory(conversationId: string, contactId: string) {
  await withTransaction(async (client) => {
    await client.query('SELECT id FROM contacts WHERE id = $1 FOR UPDATE', [contactId]);
    const scope = await client.query('SELECT id FROM conversations WHERE id = $1 AND contact_id = $2 FOR UPDATE', [conversationId, contactId]);
    if (!scope.rows.length) throw new Error('La conversación no pertenece al contacto');
    await client.query("UPDATE contacts SET data = '{}', notes = '[]', name = '', updated_at = now() WHERE id = $1", [contactId]);
    await client.query(`UPDATE conversations SET summary = '', summary_until_id = 0, data = '{}', data_version = data_version + 1,
      report_summary = '', report_until_id = 0, report_at = NULL, report_data_version = -1, flow_step = 0, goal_completed_at = NULL
      WHERE id = $1 AND contact_id = $2`, [conversationId, contactId]);
  });
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

export async function updateSummary(id: string, summary: string, untilId: number, expectedVersion?: number) {
  await query(`UPDATE conversations SET summary = $2, summary_until_id = $3 WHERE id = $1
    AND summary_until_id <= $3 AND ($4::bigint IS NULL OR data_version = $4)`, [id, summary, untilId, expectedVersion ?? null]);
}

export async function saveConversationReport(id: string, summary: string, untilId: number, expectedVersion: number, captures: { field: string; value: string; messageId: number }[] = []) {
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
    const result = await client.query<Conversation>(`UPDATE conversations SET report_summary = $2, report_until_id = $3, report_at = now(),
      data = data || $4::jsonb, data_version = data_version + $5, report_data_version = data_version + $5 WHERE id = $1 RETURNING *`,
      [id, summary, untilId, JSON.stringify(added), changed ? 1 : 0]);
    return result.rows[0];
  });
}

/* -------------------------------- Mensajes ------------------------------- */

export interface NewMessage {
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
export async function insertMessage(m: NewMessage): Promise<Message | null> {
  return withTransaction(async (client) => {
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
    return row;
  });
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

/** Busca un mensaje saliente reciente con el mismo texto (para reconocer ecos de nuestros propios envíos). */
export async function findRecentOutgoingEcho(conversationId: string, content: string, seconds = 120) {
  return queryOne<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'out' AND sender IN ('bot','human','system')
       AND content = $2 AND created_at > now() - ($3 || ' seconds')::interval ORDER BY id DESC LIMIT 1`,
    [conversationId, content, String(seconds)],
  );
}

/** Imagen enviada por nosotros hace poco cuyo ID aún no se guardó (eco que llega antes que la respuesta HTTP). */
export async function findRecentOutgoingImageEcho(conversationId: string, seconds = 120) {
  return queryOne<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'out' AND type = 'image' AND sender IN ('bot','human','system')
       AND external_message_id IS NULL AND created_at > now() - ($2 || ' seconds')::interval ORDER BY id LIMIT 1`,
    [conversationId, String(seconds)],
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
    `SELECT $2::bigint = min(id) AS first FROM messages WHERE conversation_id = $1 AND direction = 'in'
     AND type <> 'reaction' AND COALESCE(meta->>'stale', 'false') <> 'true'`, [conversationId, messageId],
  );
  return row?.first === true;
}

export async function markAllProcessed(conversationId: string) {
  await query(`UPDATE messages SET processed = true WHERE conversation_id = $1 AND processed = false`, [conversationId]);
}

/** Últimos N mensajes (en orden cronológico) con id <= beforeOrEqualId si se indica. */
export async function recentMessages(conversationId: string, limit: number): Promise<Message[]> {
  const rows = await query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND status <> 'failed' ORDER BY id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

/** Últimos `limit` mensajes posteriores al resumen (lo que la IA aún no tiene resumido), en orden cronológico. */
export async function unsummarizedMessages(conversationId: string, afterId: number, limit: number): Promise<Message[]> {
  const rows = await query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 AND status <> 'failed' ORDER BY id DESC LIMIT $3`,
    [conversationId, afterId, limit],
  );
  return rows.reverse();
}

export async function messagesBetween(conversationId: string, afterId: number, upToId: number): Promise<Message[]> {
  return query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 AND id <= $3 AND status <> 'failed' ORDER BY id`,
    [conversationId, afterId, upToId],
  );
}

export async function countMessagesAfter(conversationId: string, afterId: number): Promise<number> {
  const r = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND id > $2`, [conversationId, afterId]);
  return r?.n ?? 0;
}

export async function sentImageIds(conversationId: string): Promise<string[]> {
  const rows = await query<{ image_id: string }>(
    `SELECT DISTINCT image_id FROM messages WHERE conversation_id = $1 AND image_id IS NOT NULL AND status <> 'failed'`,
    [conversationId],
  );
  return rows.map((r) => r.image_id);
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

export async function savePairingCode(channelId: string, code: string, number: string) {
  await query(`UPDATE channels SET pairing_code = $2, pairing_number = $3, pairing_at = now() WHERE id = $1`, [channelId, code, number]);
}

/** Cambia el estado de conexión sin avisos (p.ej. al desconectar a propósito desde el panel). */
export async function setConnectionStateQuiet(channelId: string, state: string) {
  await query(`UPDATE channels SET connection_state = $2, connection_state_at = now() WHERE id = $1`, [channelId, state]);
}

export async function clearConnectionCodes(channelId: string) {
  await query(`UPDATE channels SET qr_code = NULL, qr_at = NULL, pairing_code = NULL, pairing_number = NULL, pairing_at = NULL WHERE id = $1`, [channelId]);
}

/** Reinicia el recorrido (al reabrir una conversación cerrada, o desde el panel). */
/** Al reabrir: el recorrido empieza de nuevo y el asistente vuelve a su estado inicial (sin pausa ni activación). */
export async function resetFlowState(conversationId: string) {
  await query(
    `UPDATE conversations SET flow_step = 0, goal_completed_at = NULL, agent_off_at = NULL, agent_off_reason = '', agent_off_until = NULL, agent_on_at = NULL WHERE id = $1`,
    [conversationId],
  );
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
