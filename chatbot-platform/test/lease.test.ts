/** Cola durable: una conversación la atiende un solo proceso a la vez y el trabajo perdido se retoma. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const lease = async (id: string) => (await pool.query(`SELECT lease_owner, lease_until, last_attempt_at FROM conversations WHERE id = $1`, [id])).rows[0];

t('el arrendamiento es exclusivo, renovable y se libera', async () => {
  h.setScript(() => ({ messages: ['Hola'] }));
  await h.webhook('hola', { phone: '5215520000001' });
  await waitFor(() => h.sent.length >= 1);
  const conv = await h.conversationFor('5215520000001');
  await waitFor(async () => (await lease(conv.id)).lease_owner === null, 3000); // el proceso suelta el arrendamiento justo después de enviar
  assert.equal(await store.claimConversation(conv.id, 'proceso-A', 60), true);
  assert.equal(await store.claimConversation(conv.id, 'proceso-B', 60), false, 'otro proceso no puede tomarla');
  assert.equal(await store.claimConversation(conv.id, 'proceso-A', 60), true, 'el dueño sí puede volver a tomarla');
  await store.releaseConversation(conv.id, 'proceso-B');
  assert.equal((await lease(conv.id)).lease_owner, 'proceso-A', 'soltar la de otro no hace nada');
  await store.releaseConversation(conv.id, 'proceso-A');
  assert.equal((await lease(conv.id)).lease_owner, null);
  assert.equal(await store.claimConversation(conv.id, 'proceso-B', 60), true);
  await store.releaseConversation(conv.id, 'proceso-B');
});

t('si otro proceso la está atendiendo, este espera y responde cuando la suelta (una sola respuesta)', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Respuesta única'] }));
  const phone = '5215520000002';
  await h.webhook('primer mensaje', { phone });
  await waitFor(() => h.sent.length === 1);
  h.reset();
  const conv = await h.conversationFor(phone);
  await waitFor(async () => (await lease(conv.id)).lease_owner === null, 3000);
  assert.equal(await store.claimConversation(conv.id, 'otro-proceso', 60), true);
  await h.webhook('segundo mensaje', { phone });
  await sleep(1500);
  assert.equal(h.sent.length, 0, 'mientras otro proceso la tiene, este no responde');
  await store.releaseConversation(conv.id, 'otro-proceso');
  await waitFor(() => h.sent.length === 1, 8000);
  await sleep(500);
  assert.equal(h.sent.length, 1, 'responde una sola vez');
  assert.equal((await lease(conv.id)).lease_owner, null, 'al terminar libera el arrendamiento');
});

t('un proceso que murió a la mitad: otro retoma la conversación al vencer su arrendamiento', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Retomado'] }));
  const phone = '5215520000003';
  // Estado de un proceso que cayó: mensaje sin responder + arrendamiento ajeno ya vencido, sin temporizador local.
  const ch = (await pool.query(`SELECT * FROM channels WHERE type = 'whatsapp' LIMIT 1`)).rows[0];
  const contact = await store.upsertContact(ch, `${phone}@s.whatsapp.net`, phone, 'Ana');
  const conv = await store.getOrCreateConversation(ch, contact.id);
  await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', type: 'text', content: 'hola, ¿siguen ahí?', processed: false });
  await pool.query(`UPDATE conversations SET lease_owner = 'proceso-muerto', lease_until = now() - interval '1 minute', last_attempt_at = now() WHERE id = $1`, [conv.id]);
  await pool.query(`UPDATE messages SET created_at = now() - interval '2 minutes' WHERE conversation_id = $1`, [conv.id]);
  assert.deepEqual(await store.recoverableConversations(), [conv.id]);
  assert.equal(await h.service.sweepPending(), 1);
  await waitFor(() => h.sent.length === 1, 8000);
  assert.equal(h.sent[0].text, 'Retomado');
  await waitFor(async () => (await lease(conv.id)).lease_owner === null, 3000);
});

t('mensajes que nadie intentó (temporizador perdido) se retoman; los que ya fallaron no se reintentan en bucle', async () => {
  h.reset();
  const ch = (await pool.query(`SELECT * FROM channels WHERE type = 'whatsapp' LIMIT 1`)).rows[0];
  const mk = async (phone: string) => {
    const contact = await store.upsertContact(ch, `${phone}@s.whatsapp.net`, phone, 'Ana');
    const conv = await store.getOrCreateConversation(ch, contact.id);
    const msg = await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', type: 'text', content: 'ayuda', processed: false });
    await pool.query(`UPDATE messages SET created_at = now() - interval '1 minute' WHERE id = $1`, [msg.id]);
    return conv.id;
  };
  const lost = await mk('5215520000004');
  const failed = await mk('5215520000005');
  await pool.query(`UPDATE conversations SET last_attempt_at = now() WHERE id = $1`, [failed]); // ya se intentó y falló: arrendamiento liberado
  const ids = await store.recoverableConversations();
  assert.ok(ids.includes(lost), 'la perdida se retoma');
  assert.ok(!ids.includes(failed), 'la que ya se intentó no se reintenta sola');
  // Recién llegados (dentro del tiempo de espera) tampoco: su temporizador sigue vivo.
  const fresh = await mk('5215520000006');
  await pool.query(`UPDATE messages SET created_at = now() WHERE conversation_id = $1`, [fresh]);
  assert.ok(!(await store.recoverableConversations()).includes(fresh));
  // Playground no entra.
  h.setScript(() => ({ messages: ['ok'] }));
  await h.service.sweepPending();
  await waitFor(() => h.sent.some((s) => s.to === '5215520000004'), 8000);
});
