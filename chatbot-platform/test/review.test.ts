/** Escenarios de la revisión del flujo (casos límite reales de WhatsApp). */
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
  await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { category: 'precios', title: 'Habitaciones', content: 'Doble: $1,650 MXN por noche. Suite: $2,900 MXN por noche.' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('memoria continua: los mensajes aún no resumidos siempre llegan a la IA', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { debounce_seconds: 0.2, recent_messages: 4, summary_batch: 6 } });
  h.reset();
  h.setScript(() => ({ messages: ['Ok'] }));
  const phone = '5215500000001';
  const texts = ['me llamo Pedro y voy con mi perro', 'dos', 'tres', 'cuatro'];
  for (const [i, text] of texts.entries()) {
    await h.webhook(text, { phone });
    await waitFor(() => h.sent.length === i + 1);
  }
  // 8 mensajes (4 del cliente + 4 del bot), aún sin resumen: el primero debe seguir en el contexto
  const last = h.calls[h.calls.length - 1];
  assert.ok(last.messages.some((m) => m.content.includes('voy con mi perro')), 'el primer mensaje no debe perderse');
});

t('estilo: si la IA insiste en una frase prohibida, se limpia en lugar de mandar el mensaje de "no tengo el dato"', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Como inteligencia artificial no tengo cuerpo. La doble está en $1,650 MXN por noche.'] }));
  await h.webhook('precio de la doble?', { phone: '5215500000002' });
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.sent[0].text, 'La doble está en $1,650 MXN por noche.');
});

t('temas prohibidos: declinar amablemente no provoca reintentos', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { forbidden_topics: ['política'] } });
  h.reset();
  h.setScript(() => ({ messages: ['De política prefiero no opinar 🙂 ¿Te ayudo con tu reservación?'] }));
  await h.webhook('que opinas de la politica?', { phone: '5215500000003' });
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.calls.length, 1);
});

t('cotización calculada (precio × noches) no se considera invento', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Por 3 noches en la doble serían $4,950 MXN ($1,650 por noche).'] }));
  await h.webhook('cuanto por 3 noches en la doble?', { phone: '5215500000004' });
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.calls.length, 1, 'no debe reintentar');
  assert.match(h.sent[0].text, /4,950/);
  // pero un total que no corresponde sí se rechaza
  h.reset();
  h.setScript(() => ({ messages: ['Por 3 noches serían $4,000 MXN.'] }));
  await h.webhook('y por 3 noches la doble?', { phone: '5215500000004' });
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.calls.length, 2);
});

t('regla "si no hay dato, transferir": el backend la hace cumplir aunque la IA solo responda', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { unknown_info_behavior: 'handoff' } });
  h.reset();
  h.setScript(() => ({ messages: ['Ese dato no lo tengo, pero pregúntame otra cosa'], info_not_found: true }));
  await h.webhook('tienen gimnasio?', { phone: '5215500000005' });
  await waitFor(async () => (await h.conversationFor('5215500000005'))?.status === 'human');
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { unknown_info_behavior: 'say_unknown' } });
});

t('una conversación cerrada se reabre cuando el cliente vuelve a escribir', async () => {
  h.reset();
  const phone = '5215500000006';
  await h.webhook('hola', { phone });
  await waitFor(() => h.sent.length === 1);
  const c = await h.conversationFor(phone);
  await h.authed('POST', `/api/conversations/${c.id}/close`);
  await h.webhook('hola de nuevo', { phone });
  await waitFor(() => h.sent.length === 2);
  assert.equal((await h.conversationFor(phone)).status, 'bot');
});

t('mensajes viejos (reconexión, sincronización) se guardan pero no se responden', async () => {
  h.reset();
  await h.webhook('mensaje de hace 2 horas', { phone: '5215500000007', timestamp: Math.floor(Date.now() / 1000) - 7200 });
  await sleep(500);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.conversationFor('5215500000007')).message_count, 1);
});

t('si la IA falla en el reintento, se usa la respuesta segura en vez de quedarse callado', async () => {
  h.reset();
  h.setScript((_r, i) => (i === 0 ? { messages: ['El desayuno cuesta $300'] } : new Error('OpenAI HTTP 500')));
  await h.webhook('cuanto el desayuno?', { phone: '5215500000008' });
  await waitFor(() => h.sent.length === 1);
  assert.match(h.sent[0].text, /no lo tengo confirmado/);
});

t('actualizar una parte de la personalidad no borra el resto', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { personality: { prompt: 'Eres recepcionista', emojis: 'none', assistant_name: 'Sofía' } });
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { personality: { emojis: 'few' } });
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.equal(bot.personality.prompt, 'Eres recepcionista');
  assert.equal(bot.personality.assistant_name, 'Sofía');
  assert.equal(bot.personality.emojis, 'few');
});

t('respuesta larga sin saltos de línea se divide por oraciones', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { debounce_seconds: 0.2, max_chars_per_bubble: 100, max_bubbles: 3 } });
  h.reset();
  const long = 'La doble tiene dos camas matrimoniales y vista al jardín. Incluye wifi y estacionamiento sin costo. El check-in es por la tarde y el check-out al mediodía.';
  h.setScript(() => ({ messages: [long] }));
  await h.webhook('como es la doble?', { phone: '5215500000009' });
  await waitFor(() => h.sent.length >= 2);
  await sleep(200);
  assert.ok(h.sent.every((s) => s.text.length <= 100), JSON.stringify(h.sent));
  assert.equal(h.calls.length, 1);
  void store;
});
