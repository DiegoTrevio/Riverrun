import crypto from 'node:crypto';
import { query, queryOne } from '../db.js';
import {
  channelConfig,
  hydrateChatbot,
  type Account,
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

/* ------------------------------ Cuentas ------------------------------ */

export async function listAccounts(): Promise<Account[]> {
  return query<Account>('SELECT * FROM accounts ORDER BY created_at');
}

export async function getAccount(id: string) {
  return queryOne<Account>('SELECT * FROM accounts WHERE id = $1', [id]);
}

export async function createAccount(name: string): Promise<Account> {
  return (await queryOne<Account>('INSERT INTO accounts (name) VALUES ($1) RETURNING *', [name]))!;
}

export async function updateAccount(id: string, patch: { name?: string; active?: boolean }) {
  return queryOne<Account>(
    'UPDATE accounts SET name = COALESCE($2, name), active = COALESCE($3, active), updated_at = now() WHERE id = $1 RETURNING *',
    [id, patch.name ?? null, patch.active ?? null],
  );
}

export async function deleteAccount(id: string) {
  await query('DELETE FROM accounts WHERE id = $1', [id]);
}

/* ------------------------------ Usuarios ------------------------------ */

const USER_COLS = 'id, account_id, role, name, email, active, last_login_at, created_at';

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

export async function createUser(u: { account_id: string | null; role: Role; name: string; email: string; password_hash: string }) {
  return (await queryOne<User>(
    `INSERT INTO users (account_id, role, name, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING ${USER_COLS}`,
    [u.account_id, u.role, u.name, u.email.trim(), u.password_hash],
  ))!;
}

export async function updateUser(id: string, patch: { name?: string; role?: Role; active?: boolean; password_hash?: string; email?: string }) {
  return queryOne<User>(
    `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
       password_hash = COALESCE($5, password_hash), email = COALESCE($6, email), updated_at = now()
     WHERE id = $1 RETURNING ${USER_COLS}`,
    [id, patch.name ?? null, patch.role ?? null, patch.active ?? null, patch.password_hash ?? null, patch.email?.trim() ?? null],
  );
}

export async function touchLogin(id: string) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function deleteUser(id: string) {
  await query('DELETE FROM users WHERE id = $1', [id]);
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

const CHANNEL_SELECT = `SELECT ch.*, a.active AS account_active FROM channels ch JOIN accounts a ON a.id = ch.account_id`;

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

export async function createChannel(c: { account_id: string; chatbot_id: string | null; type: ChannelType; name: string; active?: boolean; config: Record<string, unknown> }) {
  const row = await queryOne<Channel>(
    `INSERT INTO channels (account_id, chatbot_id, type, name, active, config, webhook_token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [c.account_id, c.chatbot_id, c.type, c.name, c.active ?? true, JSON.stringify(c.config), newWebhookToken()],
  );
  return (await getChannel(row!.id))!;
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
    `INSERT INTO images (chatbot_id, code, name, description, usage_rule, caption, file_path, mime_type, size_bytes, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [img.chatbot_id, img.code, img.name, img.description, img.usage_rule, img.caption, img.file_path, img.mime_type, img.size_bytes, img.active ?? true],
  );
  return row!;
}

export async function updateImage(id: string, patch: Partial<ImageAsset>): Promise<ImageAsset | null> {
  const allowed = ['code', 'name', 'description', 'usage_rule', 'caption', 'active', 'file_path', 'mime_type', 'size_bytes'] as const;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      params.push(patch[k]);
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

export async function updateContact(id: string, patch: { name?: string; data?: Record<string, string>; notes?: string[] }) {
  return queryOne<Contact>(
    `UPDATE contacts SET name = COALESCE($2, name), data = COALESCE($3, data), notes = COALESCE($4, notes), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.data ? JSON.stringify(patch.data) : null, patch.notes ? JSON.stringify(patch.notes) : null],
  );
}

/** Conversación del contacto; el chatbot que la atiende siempre es el asignado actualmente al canal. */
export async function getOrCreateConversation(channel: Pick<Channel, 'id' | 'account_id' | 'chatbot_id'>, contactId: string): Promise<Conversation> {
  const row = await queryOne<Conversation>(
    `INSERT INTO conversations (account_id, channel_id, chatbot_id, contact_id) VALUES ($1,$2,$3,$4)
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

export async function updateSummary(id: string, summary: string, untilId: number) {
  await query('UPDATE conversations SET summary = $2, summary_until_id = $3 WHERE id = $1', [id, summary, untilId]);
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
  const row = await queryOne<Message>(
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
  if (row) await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [m.conversation_id]);
  return row;
}

export async function updateMessage(id: number, patch: { external_message_id?: string | null; status?: string; meta?: Record<string, unknown> }) {
  await query(
    `UPDATE messages SET external_message_id = COALESCE($2, external_message_id), status = COALESCE($3, status),
       meta = CASE WHEN $4::jsonb IS NULL THEN meta ELSE meta || $4::jsonb END WHERE id = $1`,
    [id, patch.external_message_id ?? null, patch.status ?? null, patch.meta ? JSON.stringify(patch.meta) : null],
  );
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
  chatbot_id: string;
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
}) {
  await query(
    `INSERT INTO ai_runs (account_id, chatbot_id, conversation_id, kind, model, input_tokens, cached_tokens, output_tokens, latency_ms, attempt, decision, validation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
    ],
  );
}
