import crypto from 'node:crypto';
import { query, queryOne } from '../db.js';
import {
  hydrateChatbot,
  type Chatbot,
  type ChatbotRow,
  type Contact,
  type Conversation,
  type ConversationStatus,
  type ImageAsset,
  type KnowledgeItem,
  type Message,
} from '../types.js';

/* ------------------------------ Chatbots ------------------------------ */

export async function listChatbots(): Promise<Chatbot[]> {
  const rows = await query<ChatbotRow>('SELECT * FROM chatbots ORDER BY created_at');
  return rows.map(hydrateChatbot);
}

export async function getChatbot(id: string): Promise<Chatbot | null> {
  const row = await queryOne<ChatbotRow>('SELECT * FROM chatbots WHERE id = $1', [id]);
  return row ? hydrateChatbot(row) : null;
}

export async function getChatbotByToken(token: string): Promise<Chatbot | null> {
  const row = await queryOne<ChatbotRow>('SELECT * FROM chatbots WHERE webhook_token = $1', [token]);
  return row ? hydrateChatbot(row) : null;
}

export function newWebhookToken() {
  return crypto.randomBytes(18).toString('base64url');
}

export interface ChatbotInput {
  name?: string;
  active?: boolean;
  whatsapp_number?: string;
  evolution_instance?: string | null;
  evolution_url?: string | null;
  evolution_api_key?: string | null;
  personality?: unknown;
  rules?: unknown;
  data_fields?: unknown;
  flow?: unknown;
  ai?: unknown;
}

const CHATBOT_JSON_COLS = ['personality', 'rules', 'data_fields', 'flow', 'ai'] as const;
const CHATBOT_PLAIN_COLS = ['name', 'active', 'whatsapp_number', 'evolution_instance', 'evolution_url', 'evolution_api_key'] as const;

export async function createChatbot(input: ChatbotInput): Promise<Chatbot> {
  const row = await queryOne<ChatbotRow>(
    `INSERT INTO chatbots (name, active, whatsapp_number, evolution_instance, evolution_url, evolution_api_key, webhook_token, personality, rules, data_fields, flow, ai)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      input.name ?? 'Nuevo chatbot',
      input.active ?? false,
      input.whatsapp_number ?? '',
      input.evolution_instance || null,
      input.evolution_url || null,
      input.evolution_api_key || null,
      newWebhookToken(),
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
      let v = input[col];
      if ((col === 'evolution_instance' || col === 'evolution_url' || col === 'evolution_api_key') && v === '') v = null;
      params.push(v);
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
  await query('DELETE FROM chatbots WHERE id = $1', [id]);
}

export async function rotateWebhookToken(id: string): Promise<string> {
  const token = newWebhookToken();
  await query('UPDATE chatbots SET webhook_token = $1, updated_at = now() WHERE id = $2', [token, id]);
  return token;
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

export async function upsertContact(chatbotId: string, jid: string, phone: string, pushName: string, channel = 'whatsapp'): Promise<Contact> {
  const row = await queryOne<Contact>(
    `INSERT INTO contacts (chatbot_id, jid, phone, push_name, channel) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (chatbot_id, jid) DO UPDATE SET
       push_name = CASE WHEN EXCLUDED.push_name <> '' THEN EXCLUDED.push_name ELSE contacts.push_name END,
       phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE contacts.phone END,
       updated_at = now()
     RETURNING *`,
    [chatbotId, jid, phone, pushName, channel],
  );
  return row!;
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

export async function getOrCreateConversation(chatbotId: string, contactId: string): Promise<Conversation> {
  const row = await queryOne<Conversation>(
    `INSERT INTO conversations (chatbot_id, contact_id) VALUES ($1,$2)
     ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id
     RETURNING *`,
    [chatbotId, contactId],
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
  evolution_message_id?: string | null;
  processed?: boolean;
  status?: string;
  meta?: Record<string, unknown>;
}

/** Inserta un mensaje. Devuelve null si ya existía (webhook duplicado). */
export async function insertMessage(m: NewMessage): Promise<Message | null> {
  const row = await queryOne<Message>(
    `INSERT INTO messages (conversation_id, direction, sender, type, content, image_id, evolution_message_id, processed, status, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING RETURNING *`,
    [
      m.conversation_id,
      m.direction,
      m.sender,
      m.type ?? 'text',
      m.content,
      m.image_id ?? null,
      m.evolution_message_id ?? null,
      m.processed ?? true,
      m.status ?? 'ok',
      JSON.stringify(m.meta ?? {}),
    ],
  );
  if (row) await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [m.conversation_id]);
  return row;
}

export async function updateMessage(id: number, patch: { evolution_message_id?: string | null; status?: string; meta?: Record<string, unknown> }) {
  await query(
    `UPDATE messages SET evolution_message_id = COALESCE($2, evolution_message_id), status = COALESCE($3, status),
       meta = CASE WHEN $4::jsonb IS NULL THEN meta ELSE meta || $4::jsonb END WHERE id = $1`,
    [id, patch.evolution_message_id ?? null, patch.status ?? null, patch.meta ? JSON.stringify(patch.meta) : null],
  );
}

export async function findMessageByEvolutionId(conversationId: string, evolutionId: string) {
  return queryOne<Message>('SELECT * FROM messages WHERE conversation_id = $1 AND evolution_message_id = $2', [conversationId, evolutionId]);
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
       AND evolution_message_id IS NULL AND created_at > now() - ($2 || ' seconds')::interval ORDER BY id LIMIT 1`,
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
    `INSERT INTO ai_runs (chatbot_id, conversation_id, kind, model, input_tokens, cached_tokens, output_tokens, latency_ms, attempt, decision, validation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
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
