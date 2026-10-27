/** Apagado con plazo: sale con 0 si todo cierra, con 1 si algo falla o se cuelga, y una segunda señal no lo repite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gracefulShutdown } from '../src/shutdown.js';

const run = (steps: { name: string; run: () => unknown }[], timeoutMs = 1000) => {
  const exits: number[] = [];
  const logs: string[] = [];
  const shutdown = gracefulShutdown({ steps, timeoutMs, exit: (c) => exits.push(c), log: (m) => logs.push(m) });
  return { shutdown, exits, logs };
};

test('cierra en orden y sale con 0', async () => {
  const order: string[] = [];
  const s = run([{ name: 'servidor', run: async () => { order.push('servidor'); } }, { name: 'base', run: () => { order.push('base'); } }]);
  await s.shutdown();
  assert.deepEqual(order, ['servidor', 'base']);
  assert.deepEqual(s.exits, [0]);
});

test('si un paso falla, los demás corren igual y sale con 1', async () => {
  const order: string[] = [];
  const s = run([{ name: 'servidor', run: () => { throw new Error('boom'); } }, { name: 'base', run: () => { order.push('base'); } }]);
  await s.shutdown();
  assert.deepEqual(order, ['base'], 'la base se cierra aunque el servidor falló');
  assert.deepEqual(s.exits, [1]);
  assert.ok(s.logs.some((l) => /servidor: boom/.test(l)));
});

test('si un paso se cuelga, sale con 1 al vencer el plazo y dice qué faltó', async () => {
  const s = run([{ name: 'trabajos en curso', run: () => new Promise(() => undefined) }], 50);
  void s.shutdown();
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(s.exits, [1]);
  assert.ok(s.logs.some((l) => /pendiente: trabajos en curso/.test(l)));
});

test('una segunda señal mientras se apaga no repite el cierre', async () => {
  let closes = 0;
  let release!: () => void;
  const s = run([{ name: 'servidor', run: () => { closes++; return new Promise<void>((r) => { release = r; }); } }]);
  const first = s.shutdown('SIGTERM');
  await s.shutdown('SIGINT');
  release();
  await first;
  assert.equal(closes, 1);
  assert.deepEqual(s.exits, [0]);
  assert.ok(s.logs.some((l) => /SIGINT ignorado/.test(l)));
});
