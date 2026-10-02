/** Concurrencia y fallas: lo que pasa en WhatsApp real cuando las cosas no llegan en orden. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ rules: { handoff_keywords: ['asesor'] } });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el cliente escribe mientras la IA piensa: se descarta y se responde a todo junto', async () => {
  h.reset();
  const phone = '5215510000001';
  h.setScript(async (req, i) => {
    if (i === 0) {
      await h.webhook('y también quiero saber si aceptan mascotas', { phone });
      await sleep(100);
    }
    const lastUser = req.messages.filter((m) => m.role === 'user').pop()!.content;
    return { messages: [`Respuesta a: ${lastUser.replace(/\n/g, ' / ')}`] };
  });
  await h.webhook('hola, precio de la doble?', { phone });
  await waitFor(() => h.sent.length >= 1);
  await sleep(800);
  assert.equal(h.sent.length, 1, JSON.stringify(h.sent));
  assert.match(h.sent[0].text, /precio de la doble\? \/ y también quiero saber si aceptan mascotas/);
});

t('una persona toma la conversación mientras la IA piensa: el bot no envía nada', async () => {
  h.reset();
  const phone = '5215510000002';
  await h.webhook('hola', { phone });
  h.setScript(() => ({ messages: ['Hola'] }));
  await waitFor(() => h.sent.length === 1);
  h.reset();
  h.setScript(async () => {
    const c = await h.conversationFor(phone);
    await h.authed('POST', `/api/conversations/${c.id}/takeover`);
    return { messages: ['Esto no debe llegar'] };
  });
  await h.webhook('otra pregunta', { phone });
  await waitFor(() => h.calls.length === 1);
  await sleep(400);
  assert.equal(h.sent.length, 0);
});

t('si Evolution falla al enviar: se registra, se marca como no enviado y no rompe la conversación', async () => {
  h.reset();
  const phone = '5215510000003';
  h.failNext.text = 1;
  h.setScript(() => ({ messages: ['Primer intento'] }));
  await h.webhook('hola', { phone });
  await waitFor(() => h.calls.length === 1);
  await sleep(300);
  const c = await h.conversationFor(phone);
  const detail = (await h.authed('GET', `/api/conversations/${c.id}`)).json();
  assert.equal(detail.messages.find((m: any) => m.direction === 'out').status, 'failed');
  const logs = (await h.authed('GET', `/api/logs?source=evolution&conversation_id=${c.id}`)).json();
  assert.match(logs[0].message, /No se pudo enviar/);
  // El siguiente mensaje funciona y el fallido no aparece en el historial de la IA
  h.reset();
  h.setScript(() => ({ messages: ['Segundo'] }));
  await h.webhook('sigues ahí?', { phone });
  await waitFor(() => h.sent.length === 1);
  assert.ok(!h.calls[0].messages.some((m) => m.content.includes('Primer intento')));
});

t('webhook de otra instancia se ignora (evita cruzar chatbots)', async () => {
  h.reset();
  const r = await h.app.inject({
    method: 'POST', url: `/webhook/${h.token}`,
    payload: { event: 'messages.upsert', instance: 'otra', data: { key: { remoteJid: '5215510000004@s.whatsapp.net', id: 'X1' }, message: { conversation: 'hola' } } },
  });
  assert.equal(r.statusCode, 200);
  await sleep(400);
  assert.equal(h.sent.length, 0);
  assert.equal(await h.conversationFor('5215510000004'), undefined);
});

t('nota de voz sin transcripción: la IA sabe que es audio y responde', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['No puedo escuchar audios, ¿me lo escribes?'] }));
  await h.app.inject({
    method: 'POST', url: `/webhook/${h.token}`,
    payload: { event: 'messages.upsert', instance: 'palmas', data: { key: { remoteJid: '5215510000005@s.whatsapp.net', id: 'AUD1' }, message: { audioMessage: { seconds: 5 } }, messageTimestamp: Math.floor(Date.now() / 1000) } },
  });
  await waitFor(() => h.sent.length === 1);
  assert.match(h.calls[0].messages.filter((m) => m.role === 'user').pop()!.content, /nota de voz/);
});

t('muchos clientes a la vez: cada uno recibe su propia respuesta', async () => {
  h.reset();
  h.setScript(async (req) => {
    await sleep(Math.random() * 60);
    const lastUser = req.messages.filter((m) => m.role === 'user').pop()!.content;
    return { messages: [`eco ${lastUser}`] };
  });
  const phones = Array.from({ length: 12 }, (_, i) => `52155200000${String(i).padStart(2, '0')}`);
  await Promise.all(phones.map((p) => h.webhook(`soy ${p}`, { phone: p })));
  await waitFor(() => h.sent.length === phones.length, 8000);
  for (const s of h.sent) assert.equal(s.text, `eco soy ${s.to}`);
  void store;
});
