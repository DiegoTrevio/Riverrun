/** Simulador: cuando el sistema rechaza una respuesta, el panel muestra qué intentó responder la IA (sin entrar al servidor). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
let h: Awaited<ReturnType<typeof createHarness>>;
before(async () => { if (ok) { h = await createHarness(); await h.createBot(); } });
after(async () => { if (h) await h.app.close(); await pool.end(); });

test('simulador: una respuesta rechazada trae el texto que propuso la IA y el motivo', { skip: !ok }, async () => {
  h.setScript(() => ({ messages: ['La malla de 40 metros le queda en $41,400 con IVA.'] }));
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/playground`, { session: 'borrador', text: 'Quiero 40 metros de malla' });
  assert.equal(r.statusCode, 200, r.body);
  const result = r.json().result;
  assert.equal(result.fallback_used, true, 'el precio inventado no sale');
  const rejected = result.attempts.filter((a: any) => a.retryable.length);
  assert.ok(rejected.length >= 1);
  assert.deepEqual(rejected[0].draft, ['La malla de 40 metros le queda en $41,400 con IVA.']);
  assert.match(rejected[0].retryable.join(' '), /41400/);
});
