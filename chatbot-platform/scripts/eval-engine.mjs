import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { LiveBudget } from '../evals/live-budget.mjs';
import { fileURLToPath } from 'node:url';

// Never migrate an existing database. The administrator connection is only used
// to create and drop a uniquely named, local, synthetic evaluation database.
export function adminUrl(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Las evaluaciones requieren PostgreSQL local; no aceptan bases remotas ni de producción.');
  }
  url.pathname = '/postgres';
  return url;
}
export async function run() {
  const live = process.argv.includes('--live');
  if (live && !process.env.OPENROUTER_API_KEY) throw new Error('Configura OPENROUTER_API_KEY de forma segura para evaluar OpenRouter.');
  if (live) new LiveBudget(); // validate limits before connecting to PostgreSQL
  const url = adminUrl(process.env.EVAL_ADMIN_DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://chatbot:chatbot@127.0.0.1:5433/postgres');
  const admin = new pg.Client({ connectionString: url.href });
  const name = `riverrun_eval_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    url.pathname = `/${name}`;
    const env = { ...process.env, DATABASE_URL: url.href, RIVERRUN_EVAL_DATABASE: name,
      RIVERRUN_EVAL_LIVE: String(live), KNOWLEDGE_SEARCH_ENABLED: 'false',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1', PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_CONFIG_DIR: '/tmp/riverrun-promptfoo' };
    const extra = process.argv.slice(2).filter(x => x !== '--live');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/promptfoo/dist/src/entrypoint.js', 'eval', '-c', live ? 'evals/engine-live.yaml' : 'evals/engine.yaml', '--no-cache', '--max-concurrency', '1', ...extra], { env, stdio: 'inherit' });
      const interrupt = () => child.kill('SIGTERM');
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', interrupt);
      const remove = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); };
      child.once('error', error => { remove(); reject(error); });
      child.once('exit', (code, signal) => { remove(); resolve(signal ? 1 : code ?? 1); });
    });
    process.exitCode = code;
  } finally {
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) run().catch(() => { console.error('No se pudo completar la evaluación. Comprueba PostgreSQL local, permisos CREATEDB, OPENROUTER_API_KEY y límites de consumo.'); process.exitCode = 1; });
