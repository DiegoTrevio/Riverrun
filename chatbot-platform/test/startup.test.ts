/** Arranque real (proceso aparte): la configuración se valida antes de cargar el servidor. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

const DB = process.env.TEST_DATABASE_URL || 'postgres://chatbot:chatbot@localhost:5432/chatbot_test';
const base = new URL(DB);
const dbName = `${base.pathname.slice(1)}_startup`;
const startupUrl = Object.assign(new URL(DB), { pathname: `/${dbName}` }).toString();
const admin = new pg.Pool({ connectionString: DB, max: 1 });
const ok = await admin.query('SELECT 1').then(() => true).catch(() => false);
const SECRET = '9c2e7a1f4b8d3e6a0c5f9b2d7e1a4c8f';
const EVO_KEY = '7f3b9e1d5a8c2f6b0e4d9a3c7f1b5e8d';

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});

/** Entorno de producción mínimo y válido (sin superadministrador: no toca usuarios). */
const prodEnv = (over: Record<string, string>) => ({
  PATH: process.env.PATH!,
  NODE_ENV: 'production',
  DATABASE_URL: startupUrl,
  PUBLIC_BASE_URL: 'https://bot.test',
  WEBHOOK_BASE_URL: 'http://127.0.0.1:3000',
  EVOLUTION_URL: 'http://127.0.0.1:9',
  EVOLUTION_API_KEY: EVO_KEY,
  SESSION_SECRET: SECRET,
  SECURE_COOKIES: 'true',
  SIGNUP_REQUIRE_EMAIL: 'false',
  ALERT_WEBHOOK_URL: 'https://ntfy.sh/riverrun-prueba',
  UPLOADS_DIR: `/tmp/riverrun-startup-${process.pid}`,
  BACKUP_DIR: `/tmp/riverrun-startup-${process.pid}-backups`,
  ...over,
});

function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, output: () => out };
}

before(async () => {
  if (!ok) return;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
});
after(async () => {
  if (ok) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
});

const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible', timeout: 90_000 }, fn);

t('una configuración crítica impide arrancar: lista todo, dice cómo corregirlo y no muestra secretos', async () => {
  const p = start(prodEnv({ PORT: String(await freePort()), SESSION_SECRET: 'secret', SCHEDULER_INTERVAL_MS: 'rapido', KNOWLEDGE_SEARCH_ACCOUNT_IDS: 'piloto', ADMIN_PASSWORD: 'abc' }));
  const code = await p.exited;
  const out = p.output();
  assert.equal(code, 1, out);
  assert.match(out, /no arranca/);
  for (const v of ['SESSION_SECRET', 'SCHEDULER_INTERVAL_MS', 'KNOWLEDGE_SEARCH_ACCOUNT_IDS', 'ADMIN_PASSWORD']) assert.match(out, new RegExp(v), `falta ${v}`);
  assert.doesNotMatch(out, /\n\s+at .*\(.*\.ts/, 'sin traza de error: se reporta antes de importar config.ts');
  assert.ok(!out.includes(EVO_KEY) && !out.includes('rapido') && !out.includes('piloto'), 'no repite valores');
  // No llegó a migrar la base.
  const db = new pg.Pool({ connectionString: startupUrl, max: 1 });
  try {
    const t = await db.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    assert.equal(t.rows[0].t, null);
  } finally {
    await db.end();
  }
});

t('una configuración válida arranca, migra y responde', async () => {
  const port = await freePort();
  const p = start(prodEnv({ PORT: String(port) }));
  let health: any = null;
  try {
    for (let i = 0; i < 120 && health === null; i++) {
      if (p.child.exitCode !== null) break;
      health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
      if (health === null) await new Promise((r) => setTimeout(r, 500));
    }
    assert.deepEqual(health, { ok: true }, p.output());
    assert.doesNotMatch(p.output(), /no arranca/);
  } finally {
    p.child.kill('SIGTERM');
    await p.exited;
  }
});
