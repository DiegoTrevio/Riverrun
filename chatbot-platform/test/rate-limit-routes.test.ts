/**
 * Límites de las rutas en la base (etapa 4′, tarea 4.1): una IPv6 cuenta por su /64 y el contador vive en la base, así
 * que lo comparten todos los procesos y sobrevive a reiniciar la app.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => { if (ok) h = await createHarness(); });
after(async () => { if (h) await h.app.close(); await pool.end(); });

const accept = (remoteAddress: string) =>
  h.app.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress, payload: { token: 'x'.repeat(40), name: 'X', password: 'Pz-001-Qx-002-Kv', accept_terms: true } });

t('dos direcciones del mismo /64 comparten el límite; otra /64 no', async () => {
  for (let i = 0; i < 10; i++) assert.notEqual((await accept(i % 2 ? '2001:db8:a:b::1' : '2001:db8:a:b:ffff::9')).statusCode, 429, `intento ${i + 1}`);
  assert.equal((await accept('2001:db8:a:b:1234::5')).statusCode, 429, 'la misma /64');
  assert.notEqual((await accept('2001:db8:a:c::1')).statusCode, 429, 'otra /64');
});

t('el límite vive en la base: sobrevive a reconstruir la app', async () => {
  const row = (await pool.query(`SELECT hits FROM rate_limits WHERE key = 'invite-accept:2001:db8:a:b::/64'`)).rows[0];
  assert.ok(row && row.hits >= 11, 'el contador está en la base, por /64');
  const { buildApp } = await import('../src/app.js');
  const { app: other } = await buildApp({ ai: h.ai } as any);
  try {
    const r = await other.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress: '2001:db8:a:b::77', payload: { token: 'x'.repeat(40), name: 'X', password: 'Pz-001-Qx-002-Kv', accept_terms: true } });
    assert.equal(r.statusCode, 429, 'otra instancia de la app ve el mismo tope');
  } finally {
    await other.close();
  }
});

t('las importaciones con IA cuentan en la base por cuenta (20 por hora)', async () => {
  const { checkImportRate } = await import('../src/knowledge-import.js');
  const acc = '00000000-0000-4000-8000-00000000abcd';
  for (let i = 0; i < 20; i++) await checkImportRate(acc);
  await assert.rejects(checkImportRate(acc), /muchas importaciones seguidas/);
});
