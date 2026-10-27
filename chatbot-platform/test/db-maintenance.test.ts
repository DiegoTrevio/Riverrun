/**
 * Base de datos a escala (auditoría, PR 5a): migraciones de índices sin bloquear la tabla, migraciones que no se quedan
 * esperando un candado, limpieza en lotes y en una sola instancia, trabajos que se cancelan con su índice y tiempos
 * límite para consultas atoradas y transacciones olvidadas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tiempos cortos para poder probarlos (antes de cargar la configuración).
process.env.DB_STATEMENT_TIMEOUT_MS = '2000';
process.env.DB_IDLE_TX_TIMEOUT_MS = '1000';
process.env.MIGRATION_LOCK_TIMEOUT_MS = '500';

const { dbAvailable, migrate, pool } = await import('./harness.js');
const { deleteInBatches, exclusively } = await import('../src/db.js');
const { pruneLogs } = await import('../src/logs.js');
const { cancelJobs } = await import('../src/automation/store.js');
const { runMaintenance } = await import('../src/maintenance.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);

/** Una carpeta de migraciones con solo estos archivos (las ya aplicadas no hacen falta). */
function migrations(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-migr-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}
const indexValid = async (name: string) => (await pool.query(`SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`, [name])).rows[0]?.indisvalid;
/** Plan de una consulta sin recorrido secuencial (para saber qué índice puede usar, aunque la tabla esté casi vacía). */
async function plan(sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL enable_seqscan = off');
    const rows = (await c.query(`EXPLAIN ${sql}`, params)).rows;
    await c.query('ROLLBACK');
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    c.release();
  }
}

before(async () => {
  if (!ok) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
});
after(async () => {
  await pool.end();
});

t('una migración marcada sin transacción crea índices con CONCURRENTLY (dentro de una transacción no se puede)', async () => {
  const plain = migrations({ '990_concurrently.sql': 'CREATE INDEX CONCURRENTLY IF NOT EXISTS accounts_name_test_idx ON accounts (name);\n' });
  await assert.rejects(migrate(pool, plain), /cannot run inside a transaction block/);
  const dir = migrations({
    '990_concurrently.sql': `-- migrate:no-transaction
-- Dos índices, cada uno en su sentencia.
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounts_name_test_idx ON accounts (name);

-- comentario entre sentencias
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounts_created_test_idx ON accounts (created_at);
`,
  });
  assert.deepEqual(await migrate(pool, dir), ['990_concurrently.sql']);
  assert.equal(await indexValid('accounts_name_test_idx'), true);
  assert.equal(await indexValid('accounts_created_test_idx'), true);
  assert.deepEqual(await migrate(pool, dir), [], 'no se repite');
  // Un comentario al final de una sentencia juntaría dos: se rechaza con un mensaje claro.
  const trailing = migrations({ '993_trailing.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS accounts_x_idx ON accounts (name); -- nombre\n' });
  await assert.rejects(migrate(pool, trailing), /comentarios van en su propia línea/);
});

t('un índice que quedó a medias (inválido) se reconstruye al volver a migrar', async () => {
  await pool.query(`CREATE TABLE unique_test (id serial PRIMARY KEY, x int); INSERT INTO unique_test (x) VALUES (1), (1);`);
  // Un CONCURRENTLY que falla a la mitad deja el índice creado pero inválido.
  await assert.rejects(pool.query('CREATE UNIQUE INDEX CONCURRENTLY unique_test_x ON unique_test (x)'));
  assert.equal(await indexValid('unique_test_x'), false);
  await pool.query(`UPDATE unique_test SET x = 2 WHERE id = (SELECT max(id) FROM unique_test)`);
  const dir = migrations({ '991_rebuild.sql': '-- migrate:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS unique_test_x ON unique_test (x);\n' });
  assert.deepEqual(await migrate(pool, dir), ['991_rebuild.sql']);
  assert.equal(await indexValid('unique_test_x'), true, 'IF NOT EXISTS lo habría dejado inválido');
});

t('una migración que no consigue su candado falla pronto en vez de dejar esperando a la app', async () => {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE');
    const dir = migrations({ '992_alter.sql': 'ALTER TABLE contacts ADD COLUMN lock_test int;\n' });
    const started = Date.now();
    await assert.rejects(migrate(pool, dir), /lock timeout/);
    assert.ok(Date.now() - started < 1500, 'no esperó al candado');
    await holder.query('ROLLBACK');
    assert.deepEqual(await migrate(pool, dir), ['992_alter.sql'], 'al liberarse, se aplica en el siguiente intento');
  } finally {
    holder.release();
  }
});

t('la bitácora vieja se borra en lotes y la reciente se queda', async () => {
  await pool.query(`INSERT INTO event_logs (level, source, message, created_at) SELECT 'info', 'system', 'viejo', now() - interval '40 days' FROM generate_series(1, 12000)`);
  await pool.query(`INSERT INTO event_logs (level, source, message) SELECT 'info', 'system', 'reciente' FROM generate_series(1, 10)`);
  assert.equal(await pruneLogs(30), 12000);
  const left = (await pool.query(`SELECT message, count(*)::int AS n FROM event_logs WHERE message IN ('viejo', 'reciente') GROUP BY message`)).rows;
  assert.deepEqual(left, [{ message: 'reciente', n: 10 }]);
  // Lotes del tamaño pedido: 12 filas con lotes de 5 son tres sentencias (5, 5 y 2).
  await pool.query(`INSERT INTO event_logs (level, source, message, created_at) SELECT 'info', 'system', 'lote', now() - interval '40 days' FROM generate_series(1, 12)`);
  let statements = 0;
  const original = pool.query.bind(pool);
  (pool as any).query = (...a: any[]) => { if (/WHERE ctid = ANY/.test(String(a[0]))) statements++; return (original as any)(...a); };
  try {
    assert.equal(await deleteInBatches('event_logs', `message = 'lote'`, [], 5), 12);
  } finally {
    (pool as any).query = original;
  }
  assert.equal(statements, 3);
});

t('el mantenimiento corre en una sola instancia a la vez', async () => {
  let release!: () => void;
  const held = exclusively('maintenance', () => new Promise<void>((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await runMaintenance(), 'locked', 'otra instancia se salta la vuelta');
  release();
  assert.deepEqual(await held, { ran: true, value: undefined });
  assert.equal(await runMaintenance(), 'ran');
});

t('cancelar los trabajos de una inscripción usa su índice y no toca los demás', async () => {
  await pool.query(`INSERT INTO jobs (type, payload, run_at) SELECT 'sequence_step', jsonb_build_object('enrollment_id', 'e' || g), now() + interval '1 day' FROM generate_series(1, 50) g`);
  await cancelJobs('enrollment_id', 'e7');
  const rows = (await pool.query(`SELECT payload->>'enrollment_id' AS e, status FROM jobs WHERE type = 'sequence_step' AND status = 'cancelled'`)).rows;
  assert.deepEqual(rows, [{ e: 'e7', status: 'cancelled' }]);
  assert.match(await plan(`UPDATE jobs SET status = 'cancelled' WHERE status = 'pending' AND payload->>'enrollment_id' = $1`, ['e8']), /jobs_pending_enrollment_idx/);
  assert.match(await plan(`UPDATE jobs SET status = 'cancelled' WHERE status = 'pending' AND payload ? 'receivable_id' AND payload->>'receivable_id' = $1`, ['r1']), /jobs_receivable_idx/);
  await assert.rejects(cancelJobs('otra_llave' as any, 'x'), /llave no permitida/);
});

t('los mensajes por fecha, la recuperación de trabajos y la limpieza tienen su índice', async () => {
  assert.match(await plan(`SELECT count(*) FROM messages WHERE created_at >= now() - interval '30 days'`), /messages_created_brin/);
  assert.match(await plan(`SELECT id FROM jobs WHERE status = 'running' AND started_at < now() - interval '5 minutes'`), /jobs_running_started_idx/);
  assert.match(await plan(`SELECT id FROM jobs WHERE status IN ('done','failed','cancelled') AND created_at < now() - interval '30 days'`), /jobs_finished_created_idx/);
  assert.match(await plan(`SELECT id FROM event_logs WHERE level = 'error' AND created_at > now() - interval '15 minutes'`), /event_logs_errors_idx/);
});

t('una consulta atorada y una transacción olvidada se cortan solas', async () => {
  assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '2s');
  await assert.rejects(pool.query('SELECT pg_sleep(3)'), /statement timeout/);
  const c = await pool.connect();
  c.on('error', () => undefined);
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1');
    await new Promise((r) => setTimeout(r, 1600));
    // PostgreSQL cierra la conexión; node-postgres lo reporta como error de conexión.
    await assert.rejects(c.query('SELECT 1'), /idle-in-transaction|terminat|not queryable/i);
  } finally {
    c.release(true);
  }
});
