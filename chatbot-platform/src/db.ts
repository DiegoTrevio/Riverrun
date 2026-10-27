import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

// bigint (bigserial) -> number: los IDs de mensajes caben de sobra en un Number.
pg.types.setTypeParser(20, (v) => Number(v));

/**
 * Si PostgreSQL se reinicia, las conexiones inactivas del pool emiten 'error'. Sin este manejador el
 * proceso entero se cae; con él, la conexión rota se descarta y el pool abre otra en la siguiente consulta.
 */
function guard(p: pg.Pool) {
  p.on('error', (err) => console.error(`[warn] [db] Conexión a PostgreSQL perdida (se reconecta sola): ${err.message}`));
  return p;
}

/**
 * Ninguna consulta puede tardar más de DB_STATEMENT_TIMEOUT_MS ni dejar una transacción abierta sin hacer nada más de
 * DB_IDLE_TX_TIMEOUT_MS: una consulta atorada o una transacción olvidada no retiene candados ni conexiones para siempre.
 * Las esperas a propósito (migraciones) quitan el límite en su propio cliente.
 */
export let pool = guard(new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.db.poolMax,
  connectionTimeoutMillis: 30_000,
  application_name: 'riverrun',
  options: `-c statement_timeout=${config.db.statementTimeoutMs} -c idle_in_transaction_session_timeout=${config.db.idleTxTimeoutMs}`,
}));

export function setPool(p: pg.Pool) {
  pool = guard(p);
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Ejecuta `fn` en una transacción (con su propio cliente). */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  // Si la conexión se corta a la mitad (reinicio de PostgreSQL, tiempo límite), el error no tumba el proceso.
  const onError = () => { broken = true; };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    // Si la conexión se cayó, el ROLLBACK también falla: se descarta la conexión en vez de devolverla rota al pool.
    await client.query('ROLLBACK').catch(() => (broken = true));
    throw e;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

/**
 * Borra en lotes (la misma sentencia con LIMIT, repetida) para no generar un pico de escritura ni retener la tabla:
 * devuelve el total. `where` es la condición sobre `table`; sus parámetros empiezan en $1.
 */
export async function deleteInBatches(table: string, where: string, params: unknown[] = [], batch = 5000): Promise<number> {
  return inBatches(`DELETE FROM ${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${table} WHERE ${where} LIMIT ${batch}))`, params, batch);
}

/** Como deleteInBatches, para un UPDATE: `where` debe dejar de cumplirse para las filas ya actualizadas. */
export async function updateInBatches(table: string, set: string, where: string, params: unknown[] = [], batch = 5000): Promise<number> {
  return inBatches(`UPDATE ${table} SET ${set} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${table} WHERE ${where} LIMIT ${batch}))`, params, batch);
}

async function inBatches(sql: string, params: unknown[], batch: number) {
  let total = 0;
  for (;;) {
    const n = (await pool.query(sql, params as any[])).rowCount ?? 0;
    total += n;
    if (n < batch) return total;
    await new Promise((r) => setTimeout(r, 50)); // deja respirar a la base entre lotes
  }
}

/**
 * Corre `fn` en una sola instancia a la vez (candado consultivo de sesión en su propio cliente). Si otra instancia lo
 * tiene, no espera: devuelve { ran: false }.
 */
export async function exclusively<T>(name: string, fn: () => Promise<T>): Promise<{ ran: false } | { ran: true; value: T }> {
  const client = await pool.connect();
  let broken = false;
  const onError = () => { broken = true; };
  client.on('error', onError);
  try {
    const got = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [`riverrun:${name}`])).rows[0]?.ok === true;
    if (!got) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`riverrun:${name}`]).catch(() => { broken = true; });
    }
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

const NO_TRANSACTION = /^--\s*migrate:no-transaction\b/;
/** Lo más que una réplica espera a que otra termine de migrar antes de rendirse (y que Docker la reinicie). */
const MIGRATION_WAIT_MS = 15 * 60_000;
/** Sentencias de una migración sin transacción: una por `;` al final de línea (sin bloques $$ ni funciones). */
const statements = (sql: string) => sql.split(/;\s*$/m)
  .map((x) => x.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim())
  .filter(Boolean);

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(here, '..', 'migrations');

export async function migrate(p: pg.Pool = pool, dir = migrationsDir): Promise<string[]> {
  // Keep the lock and all migration queries on the same connection, including
  // bootstrap DDL and the optional vector upgrade on already migrated databases.
  const client = await p.connect();
  let broken = false;
  let locked = false;
  try {
    // Las migraciones pueden tardar (crear índices): sin tiempo límite en este cliente.
    await client.query('SET statement_timeout = 0');
    // Otra réplica migrando: se reintenta sin dejar una consulta esperando. Una consulta en espera retendría su vista de
    // la base, y CREATE INDEX CONCURRENTLY de la otra réplica esperaría por ella (y PostgreSQL mataría a una de las dos).
    const waitStarted = Date.now();
    let warned = waitStarted;
    while (!(await client.query("SELECT pg_try_advisory_lock(hashtextextended('riverrun:schema-migrations', 0)) AS ok")).rows[0].ok) {
      if (Date.now() - waitStarted > MIGRATION_WAIT_MS) throw new Error('Otra réplica lleva más de 15 minutos migrando la base: revisa que no se haya quedado atorada.');
      if (Date.now() - warned > 30_000) {
        warned = Date.now();
        console.log(`[db] Esperando a que otra réplica termine de migrar la base (${Math.round((warned - waitStarted) / 1000)} s)...`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    locked = true;
    const collation = (await client.query('SELECT datcollversion AS recorded, pg_database_collation_actual_version(oid) AS actual FROM pg_database WHERE datname=current_database()')).rows[0];
    if (collation.recorded !== collation.actual) throw new Error('La versión de collation de PostgreSQL no coincide con la imagen. Restaura en un volumen compatible o reconstruye los índices antes de actualizar la versión de collation.');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      if (NO_TRANSACTION.test(sql)) {
        // Índices en tablas grandes (CONCURRENTLY): cada sentencia por separado y sin transacción, sin bloquear la tabla.
        for (const stmt of statements(sql)) {
          // Un comentario al final de una línea juntaría dos sentencias: mejor un error claro que un fallo raro.
          if (/--/.test(stmt)) throw new Error(`${f}: en una migración sin transacción, los comentarios van en su propia línea`);
          const idx = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+(\w+)/i.exec(stmt)?.[1];
          // Una corrida anterior que se cayó deja el índice inválido, e IF NOT EXISTS lo saltaría: se reconstruye.
          if (idx && (await client.query(`SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1 AND NOT i.indisvalid`, [idx])).rowCount) {
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx}`);
          }
          await client.query(stmt);
        }
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        applied.push(f);
        continue;
      }
      try {
        await client.query('BEGIN');
        // Si una tabla está ocupada, la migración falla y se reintenta al siguiente arranque en vez de dejar en espera a la app.
        await client.query(`SET LOCAL lock_timeout = ${Number(config.db.migrationLockTimeoutMs)}`);
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => { broken = true; });
        throw e;
      }
    }
    // Plain PostgreSQL installations can gain pgvector without deleting history.
    await client.query(fs.readFileSync(path.join(migrationsDir, '011_knowledge_vectors.sql'), 'utf8'));
    return applied;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('riverrun:schema-migrations', 0))").catch(() => { broken = true; });
    await client.query('RESET statement_timeout').catch(() => { broken = true; });
    client.release(broken);
  }
}
