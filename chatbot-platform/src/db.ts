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

export let pool = guard(new pg.Pool({ connectionString: config.databaseUrl, max: 10 }));

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
    client.release(broken);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(here, '..', 'migrations');

export async function migrate(p: pg.Pool = pool): Promise<string[]> {
  await p.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await p.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await p.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}
