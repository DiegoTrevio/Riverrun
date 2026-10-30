/** Límites de intentos en la base: un contador por clave, atómico entre peticiones simultáneas y que vence con su ventana. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, migrate, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { clearHits, countHit, hitsFor, pruneHits } = await import('../src/identity/rate-limit.js');

before(async () => {
  if (!ok) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
});
after(async () => {
  await pool.end();
});

t('40 golpes simultáneos cuentan 40 (sin carrera)', async () => {
  await Promise.all(Array.from({ length: 40 }, () => countHit('k:carrera', 60_000)));
  assert.equal(await hitsFor('k:carrera'), 40);
});

t('la ventana vence y vuelve a empezar en 1', async () => {
  assert.equal(await countHit('k:vence', 60_000), 1);
  assert.equal(await countHit('k:vence', 60_000), 2);
  await pool.query(`UPDATE rate_limits SET expires_at = now() - interval '1 second' WHERE key = 'k:vence'`);
  assert.equal(await hitsFor('k:vence'), 0);
  assert.equal(await countHit('k:vence', 60_000), 1);
});

t('una clave que no existe cuenta 0', async () => {
  assert.equal(await hitsFor('k:nada'), 0);
});

t('limpiar y podar', async () => {
  await countHit('k:a', 60_000);
  await countHit('k:b', 60_000);
  await clearHits('k:a', 'k:b');
  assert.equal(await hitsFor('k:a'), 0);
  assert.equal(await hitsFor('k:b'), 0);
  await pool.query(`INSERT INTO rate_limits VALUES ('k:viejo', 3, now() - interval '1 hour'), ('k:vivo', 3, now() + interval '1 hour')`);
  await pruneHits();
  assert.deepEqual((await pool.query(`SELECT key FROM rate_limits WHERE key IN ('k:viejo', 'k:vivo')`)).rows.map((r) => r.key), ['k:vivo']);
});
