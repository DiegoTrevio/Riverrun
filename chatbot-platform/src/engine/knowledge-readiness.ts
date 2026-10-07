import fs from 'node:fs';
import type pg from 'pg';
import { config } from '../config.js';
import { migrationsDir, pool } from '../db.js';
import { OpenAiProvider, validEmbedding, type AiProvider } from '../ai/provider.js';

export async function knowledgeReadiness(options: { database?: pg.Pool; verifyProvider?: boolean; ai?: AiProvider } = {}) {
  const db = options.database ?? pool;
  const issues: string[] = [];
  const server = (await db.query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version_num, current_setting('server_version') AS version")).rows[0];
  const collation = (await db.query('SELECT datcollversion AS recorded, pg_database_collation_actual_version(oid) AS actual FROM pg_database WHERE datname=current_database()')).rows[0];
  const collationReady = collation.recorded === collation.actual;
  if (!collationReady) issues.push('La versión de collation del volumen no coincide con la imagen. Restaura la copia en un volumen nuevo o reconstruye los índices afectados antes de actualizar su versión.');
  if (server.version_num < 160000 || server.version_num >= 170000) issues.push('Este procedimiento de activación requiere PostgreSQL 16.');
  const extension = (await db.query("SELECT default_version, installed_version FROM pg_available_extensions WHERE name='vector'")).rows[0];
  if (!extension) issues.push('El servidor no ofrece pgvector: instala la extensión o utiliza la imagen PostgreSQL 16 con pgvector.');
  else if (!extension.installed_version) issues.push('La extensión vector aún no está instalada en esta base.');
  const schema = (await db.query("SELECT to_regclass('public.knowledge_chunks') IS NOT NULL AS chunks, to_regclass('public.schema_migrations') IS NOT NULL AS migrations")).rows[0];
  const applied = schema.migrations ? new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)) : new Set();
  const pending = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql') && !applied.has(name)).sort();
  if (pending.length) issues.push('Hay migraciones pendientes.');
  const type = schema.chunks ? (await db.query("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='public.knowledge_chunks'::regclass AND attname='embedding' AND NOT attisdropped")).rows[0]?.type : null;
  if (type !== 'vector(1536)') issues.push('knowledge_chunks.embedding debe existir con tipo vector(1536).');
  if (extension?.installed_version) {
    const vector = `[1,${Array(1535).fill(0).join(',')}]`;
    const probe = (await db.query('SELECT $1::vector <=> $1::vector AS distance', [vector])).rows[0];
    if (!Number.isFinite(Number(probe.distance)) || Math.abs(Number(probe.distance)) > 1e-6) issues.push('La comprobación de distancia coseno falló.');
  }
  const databaseReady = issues.length === 0;
  if (!config.knowledgeSearch.enabled) issues.push('KNOWLEDGE_SEARCH_ENABLED debe ser true en el backend.');
  if (!config.openai.apiKey) issues.push('Falta la clave del proveedor de embeddings.');
  let provider: 'not_checked' | 'verified' | 'failed' = 'not_checked';
  if (options.verifyProvider && config.openai.apiKey && databaseReady) {
    try {
      const ai = options.ai ?? new OpenAiProvider();
      if (!ai.embed) throw new Error('Unsupported');
      const result = await ai.embed(['Comprobación sintética de búsqueda semántica.'], config.knowledgeSearch.model);
      if (result.vectors.length !== 1 || !validEmbedding(result.vectors[0])) throw new Error('Invalid embedding');
      const distance = (await db.query('SELECT $1::vector <=> $1::vector AS distance', [`[${result.vectors[0].join(',')}]`])).rows[0].distance;
      if (!Number.isFinite(Number(distance)) || Math.abs(Number(distance)) > 1e-6) throw new Error('Invalid cosine');
      provider = 'verified';
    } catch {
      provider = 'failed';
      issues.push('No se pudo verificar el proveedor y el modelo de embeddings. Revisa autenticación, saldo, acceso de red y compatibilidad con 1536 dimensiones.');
    }
  }
  return { database: server.database, postgres_version: server.version, collation_ready: collationReady, vector_version: extension?.installed_version ?? null, embedding_type: type, pending_migrations: pending, enabled: config.knowledgeSearch.enabled, key_present: !!config.openai.apiKey, model: config.knowledgeSearch.model, database_ready: databaseReady, provider, ready: issues.length === 0 && provider === 'verified', issues };
}
