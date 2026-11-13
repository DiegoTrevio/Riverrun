/** Aceptar cotizaciones a la vez no se queda con todas las conexiones de la base. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CONCURRENT_ACCEPTS, withAcceptSlot } from '../src/quotes/accept-slots.js';

test('aceptar cotizaciones: más de las permitidas a la vez responde 429 sin esperar; al terminar se libera el lugar', async () => {
  const gates: Array<() => void> = [];
  const busy = Array.from({ length: MAX_CONCURRENT_ACCEPTS }, () => withAcceptSlot(() => new Promise<string>((r) => gates.push(() => r('ok')))));
  await assert.rejects(withAcceptSlot(async () => 'de más'), (e: any) => e.statusCode === 429);
  gates.forEach((open) => open());
  assert.deepEqual(await Promise.all(busy), Array(MAX_CONCURRENT_ACCEPTS).fill('ok'));
  assert.equal(await withAcceptSlot(async () => 'libre'), 'libre');
});

test('aceptar cotizaciones: un error también libera el lugar', async () => {
  for (let i = 0; i < MAX_CONCURRENT_ACCEPTS + 1; i++) await assert.rejects(withAcceptSlot(async () => { throw new Error('falló'); }), /falló/);
  assert.equal(await withAcceptSlot(async () => 'libre'), 'libre');
});
