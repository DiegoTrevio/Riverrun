import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { validEmbedding, type AiProvider } from '../ai/provider.js';
import * as store from '../store/index.js';
import type { Chatbot, KnowledgeItem } from '../types.js';
import { selectKnowledge } from './context.js';

export const knowledgeHash = (k: KnowledgeItem) => createHash('sha256').update(`${k.category}\n${k.title}\n${k.content}`).digest('hex');
const hashSql = "encode(digest(k.category || E'\\n' || k.title || E'\\n' || k.content, 'sha256'), 'hex')";
const vectorSql = (v: number[]) => {
  if (!validEmbedding(v)) throw new Error('Embedding inválido (se requieren 1536 dimensiones).');
  return `[${v.join(',')}]`;
};

/** Overlap preserves facts near boundaries; stored text is always an original excerpt. */
export function knowledgeChunks(text: string): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 700, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + 500) end = boundary;
    }
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - 120;
  }
  return chunks;
}

export async function vectorAvailable(): Promise<boolean> {
  return !!(await queryOne<{ ready: boolean }>("SELECT to_regclass('public.knowledge_chunks') IS NOT NULL AS ready"))?.ready;
}

async function embed(ai: AiProvider, bot: Chatbot, texts: string[]) {
  if (!ai.embed) throw new Error('El proveedor no soporta embeddings.');
  const result = await ai.embed(texts, config.knowledgeSearch.model);
  if (result.vectors.length !== texts.length || result.vectors.some((v) => !validEmbedding(v))) throw new Error('Embeddings inválidos.');
  await store.insertAiRun({ account_id: bot.account_id, chatbot_id: bot.id, conversation_id: null, kind: 'embedding', model: result.model, input_tokens: result.input_tokens, cached_tokens: 0, output_tokens: 0, latency_ms: result.latency_ms, cost_usd: result.cost_usd });
  return result.vectors;
}

const indexing = new Map<string, Promise<number>>();
/** Missing or changed items are durable work: rediscovered from the source hash on every search. */
export async function indexKnowledge(bot: Chatbot, ai: AiProvider, limit = Infinity): Promise<number> {
  const key = `${bot.id}:${config.knowledgeSearch.model}`;
  const pending = indexing.get(key);
  if (pending) { await pending; return indexKnowledge(bot, ai, limit); }
  const work = (async () => {
    if (!config.knowledgeSearch.enabled || !ai.embed || !await vectorAvailable()) return 0;
    const missing = await query<KnowledgeItem>(`SELECT k.* FROM knowledge_items k JOIN chatbots b ON b.id=k.chatbot_id
      WHERE k.chatbot_id=$1 AND b.account_id=$2 AND k.active AND NOT k.always_include
      AND NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.item_id=k.id AND c.model=$3 AND c.content_hash=${hashSql})
      ORDER BY k.sort_order, k.created_at`, [bot.id, bot.account_id, config.knowledgeSearch.model]);
    let count = 0;
    for (const k of missing.slice(0, limit)) {
      const hash = knowledgeHash(k);
      const chunks = knowledgeChunks(k.content);
      const vectors: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += 32) vectors.push(...await embed(ai, bot, chunks.slice(offset, offset + 32).map((text) => `${k.category}\n${k.title}\n${text}`)));
      const saved = await withTransaction(async (client) => {
        const current = await client.query(`SELECT k.id FROM knowledge_items k JOIN chatbots b ON b.id=k.chatbot_id WHERE k.id=$1 AND k.chatbot_id=$2 AND b.account_id=$3 AND k.active AND NOT k.always_include AND ${hashSql}=$4 FOR UPDATE OF k`, [k.id, bot.id, bot.account_id, hash]);
        if (!current.rowCount) return false; // edited/deleted while the embedding request was in flight
        await client.query('DELETE FROM knowledge_chunks WHERE item_id=$1', [k.id]);
        for (let i = 0; i < chunks.length; i++) await client.query('INSERT INTO knowledge_chunks(item_id,model,content_hash,chunk_no,content,embedding) VALUES($1,$2,$3,$4,$5,$6::vector)', [k.id, config.knowledgeSearch.model, hash, i, chunks[i], vectorSql(vectors[i])]);
        return true;
      });
      if (saved) count++;
    }
    return count;
  })();
  indexing.set(key, work);
  try { return await work; } finally { indexing.delete(key); }
}

/** Null means the caller should use the existing lexical selector. No provider failure blocks a reply. */
export async function semanticKnowledge(bot: Chatbot, items: KnowledgeItem[], text: string, ai: AiProvider): Promise<KnowledgeItem[] | null> {
  if (!config.knowledgeSearch.enabled || !ai.embed || !items.some((k) => !k.always_include)) return null;
  try {
    if (!await vectorAvailable()) return null;
    await indexKnowledge(bot, ai, 4);
    const [vector] = await embed(ai, bot, [text.slice(-6000) || 'Información del negocio']);
    const rows = await query<KnowledgeItem & { excerpt: string }>(`SELECT k.*, c.content AS excerpt FROM knowledge_chunks c
      JOIN knowledge_items k ON k.id=c.item_id JOIN chatbots b ON b.id=k.chatbot_id
      WHERE k.chatbot_id=$1 AND b.account_id=$2 AND k.active AND NOT k.always_include AND c.model=$3
      AND c.content_hash=${hashSql} ORDER BY c.embedding <=> $4::vector, k.id, c.chunk_no LIMIT 40`, [bot.id, bot.account_id, config.knowledgeSearch.model, vectorSql(vector)]);
    if (!rows.length) return null;
    const chosen = items.filter((k) => k.always_include);
    let used = chosen.reduce((n, k) => n + k.title.length + k.content.length + 30, 0);
    const selected = new Map<string, KnowledgeItem>();
    for (const row of rows) {
      const old = selected.get(row.id);
      const size = row.excerpt.length + (old ? 2 : row.title.length + 30);
      if (used + size > bot.ai.knowledge_char_budget) continue;
      selected.set(row.id, { ...row, content: old ? `${old.content}\n\n${row.excerpt}` : row.excerpt });
      used += size;
    }
    // Partial indexing must not hide documents waiting for an embedding or always-include facts.
    const indexedIds = new Set(rows.map((k) => k.id));
    const rest = selectKnowledge(items.filter((k) => !k.always_include && !indexedIds.has(k.id)), text, Math.max(0, bot.ai.knowledge_char_budget - used));
    return [...chosen, ...selected.values(), ...rest];
  } catch {
    console.warn('[knowledge] Búsqueda semántica no disponible; se utiliza búsqueda por palabras.');
    return null;
  }
}

export async function knowledgeIndexStatus(bot: Chatbot) {
  const available = await vectorAvailable();
  const stats = available ? await queryOne(`SELECT count(*)::int AS indexed_items FROM knowledge_items k WHERE k.chatbot_id=$1 AND k.active AND NOT k.always_include AND EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.item_id=k.id AND c.model=$2 AND c.content_hash=${hashSql})`, [bot.id, config.knowledgeSearch.model]) : { indexed_items: 0 };
  return { enabled: config.knowledgeSearch.enabled, available, model: config.knowledgeSearch.model, ...stats };
}
