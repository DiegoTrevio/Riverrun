/**
 * Ninguna cuenta en pausa usa IA (esperando tarjeta, prueba vencida, pago, disputa o a mano): toda llamada pasa por
 * `accountAi`, que la frena antes de reservar o llamar al proveedor, y las rutas de IA responden 402 `ai_paused` con
 * el motivo. Los mensajes entrantes se guardan igual, sin transcribir ni leer archivos.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, evo, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { accountAi, AiBudgetBlocked } = await import('../src/ai/budget.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const pause = (reason: string) => pool.query(`UPDATE accounts SET status = 'paused', pause_reason = $2, paused_at = now() WHERE id = $1`, [h.accountId, reason]);
const resume = () => pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [h.accountId]);
let transcribed = 0;
/** Toda llamada al proveedor falso: con esquema, sin esquema (resúmenes) y del Copiloto. */
const aiCount = () => h.calls.length + h.summaryCalls.length + h.copilotCalls.length;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ ai: { transcribe_audio: true } });
  const original = h.ai.transcribe!.bind(h.ai);
  h.ai.transcribe = async (...args: Parameters<typeof original>) => { transcribed++; return original(...args); };
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('accountAi no llama a la IA con la cuenta en pausa', async () => {
  await pause('card');
  const before = aiCount();
  const ai = accountAi(h.ai, h.accountId, h.botId, 'decision');
  const paused = (e: any) => e instanceof AiBudgetBlocked && e.code === 'ai_paused' && e.statusCode === 402 && e.message === 'Activa tu prueba para usar la IA';
  await assert.rejects(ai.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hola' }] }), paused);
  await assert.rejects(ai.transcribe!(Buffer.from('OggS'), 'audio/ogg', 3), paused);
  if (ai.embed) await assert.rejects(ai.embed(['hola'], 'text-embedding-3-small'), paused);
  assert.equal(aiCount(), before, 'no llegó nada al proveedor');
  assert.equal(transcribed, 0);
  await resume();
});

t('las rutas de IA responden 402 ai_paused con el motivo', async () => {
  const routes: [string, string, unknown][] = [
    ['POST', `/api/chatbots/${h.botId}/prompt-edit`, { instruction: 'Hazlo más amable' }],
    ['POST', `/api/flow-boards/ai?account_id=${h.accountId}`, { idea: 'Un flujo para agendar citas' }],
    ['POST', `/api/chatbots/${h.botId}/knowledge/import`, { text: 'Abrimos de 9 a 6.' }],
    ['POST', `/api/chatbots/${h.botId}/playground`, { session: 'pausa', text: 'hola' }],
    ['POST', `/api/chatbots/${h.botId}/test-message`, { text: 'hola' }],
    ['POST', `/api/chatbots/${h.botId}/tests/run`, { revision: 'cualquiera' }],
  ];
  for (const [reason, text] of [['card', 'Activa tu prueba para usar la IA'], ['payment', 'Tu cuenta está en pausa']]) {
    await pause(reason);
    const before = aiCount();
    for (const [method, url, body] of routes) {
      const r = await h.authed(method, url, body);
      assert.equal(r.statusCode, 402, `${url} (${reason}): ${r.body}`);
      assert.deepEqual({ code: r.json().code, error: r.json().error }, { code: 'ai_paused', error: text }, url);
    }
    assert.equal(aiCount(), before, `ninguna ruta llamó a la IA (${reason})`);
  }
  await resume();
});

t('el Copiloto tampoco responde con la cuenta en pausa', async () => {
  const admin = await h.addUser({ account_id: h.accountId, name: 'Copi', email: 'copi@pausa.mx', password: 'Pz-151-Qx-351-Kv', role: 'admin' });
  assert.ok(admin);
  const api = await h.loginAs('copi@pausa.mx', 'Pz-151-Qx-351-Kv');
  await pool.query(`UPDATE accounts SET copilot_enabled = true WHERE id = $1`, [h.accountId]);
  const thread = await api('POST', '/api/copilot/threads', {});
  assert.equal(thread.statusCode, 200, thread.body);
  await pause('card');
  const before = h.copilotCalls.length;
  const r = await api('POST', `/api/copilot/threads/${thread.json().id}/messages`, { text: 'Hola' });
  assert.equal(r.statusCode, 402, r.body);
  assert.equal(r.json().code, 'ai_paused');
  assert.equal(h.copilotCalls.length, before);
  await resume();
});

t('un audio entrante con la cuenta en pausa se guarda sin transcribir y sin errores (Review Focus 5)', async () => {
  await pause('payment');
  evo.media.set('AUD-PAUSA', { buffer: Buffer.from('OggS-audio'), mimetype: 'audio/ogg' });
  const since = new Date();
  await h.app.inject({
    method: 'POST', url: `/webhook/${h.token}`,
    payload: { event: 'messages.upsert', instance: 'palmas', data: { key: { remoteJid: '5215510000777@s.whatsapp.net', id: 'AUD-PAUSA' }, message: { audioMessage: { seconds: 4 } }, messageTimestamp: Math.floor(Date.now() / 1000) } },
  });
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.phone = '5215510000777'`)).rows[0].n === 1, 5000);
  assert.equal(transcribed, 0, 'no se transcribió');
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE created_at >= $1 AND level IN ('warn', 'error')`, [since])).rows.map((r) => r.message);
  assert.deepEqual(logs.filter((m: string) => /transcribir|IA|pausa/i.test(m)), [], 'sin avisos de IA en la bitácora');
  await resume();
});

t('guardar conocimiento con la cuenta en pausa guarda el artículo', async () => {
  await pause('card');
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { category: 'general', title: 'Horario', content: 'Abrimos de 9 a 6.' });
  assert.ok(r.statusCode < 300, r.body);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM knowledge_items WHERE chatbot_id = $1 AND title = 'Horario'`, [h.botId])).rows[0].n, 1);
  await resume();
});

t('con la cuenta activa la IA sigue funcionando', async () => {
  const before = aiCount();
  await accountAi(h.ai, h.accountId, h.botId, 'decision').complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(aiCount(), before + 1);
  evo.media.set('AUD-ACTIVA', { buffer: Buffer.from('OggS-audio'), mimetype: 'audio/ogg' });
  await h.app.inject({
    method: 'POST', url: `/webhook/${h.token}`,
    payload: { event: 'messages.upsert', instance: 'palmas', data: { key: { remoteJid: '5215510000778@s.whatsapp.net', id: 'AUD-ACTIVA' }, message: { audioMessage: { seconds: 4 } }, messageTimestamp: Math.floor(Date.now() / 1000) } },
  });
  await waitFor(() => transcribed === 1, 5000);
});
