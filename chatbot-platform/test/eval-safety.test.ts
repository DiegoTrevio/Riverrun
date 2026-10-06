import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('la evaluación rechaza bases remotas antes de conectar o migrar', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { adminUrl } from './scripts/eval-engine.mjs';
    for (const url of ['postgres://user:secret@production.example/app', 'https://localhost/app']) {
      try { adminUrl(url); process.exit(1); } catch {}
    }
    const result = adminUrl('postgres://user:secret@127.0.0.1:5433/customer_database');
    if (result.pathname !== '/postgres') process.exit(2);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('el proveedor del motor rechaza ejecución directa sobre una base existente', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./evals/engine-provider.mjs')"], {
    env: { ...process.env, DATABASE_URL: 'postgres://localhost/customer_database', RIVERRUN_EVAL_DATABASE: '' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base temporal aislada/);
});
