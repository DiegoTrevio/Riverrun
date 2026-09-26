/**
 * Prueba de extremo a extremo con PostgreSQL real, IA simulada y WhatsApp simulado.
 * Requiere una base de datos de pruebas (se borra por completo):
 *   TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store, waitFor, type Req } from './harness.js';

const dbOk = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !dbOk && 'PostgreSQL de pruebas no disponible' }, fn);

let h: Awaited<ReturnType<typeof createHarness>>;
let app: any, authed: any, service: any, webhook: any, sent: any[], calls: Req[];
let cookie = '';
let botId = '';
let token = '';
// Guion de la IA simulada (cada prueba lo reemplaza).
let script: (req: Req, i: number) => any = () => ({ messages: ['Ok'] });

before(async () => {
  if (!dbOk) return;
  h = await createHarness();
  ({ app, authed, service, sent, calls, cookie } = h);
  webhook = (text: string, opts?: any) => h.webhook(text, opts);
  h.setScript((req, i) => script(req, i));
  h.setSummary('- Ana busca la doble para diciembre');
});

after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el panel exige autenticación', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/chatbots' });
  assert.equal(r.statusCode, 401);
  const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'admin', password: 'x' } });
  assert.equal(bad.statusCode, 401);
});

t('crear y configurar chatbot desde la API', async () => {
  await h.createBot({ name: 'Hotel Palmas', active: false });
  botId = h.botId;
  token = h.token;

  const upd = await authed('PUT', `/api/chatbots/${botId}`, {
    active: true,
    personality: { prompt: 'Eres recepcionista del hotel.', tone: ['natural'], emojis: 'few' },
    rules: { handoff_keywords: ['asesor'], handoff_notify_number: '5215599990000', fallback_message: 'Déjame confirmarlo con el equipo.' },
    data_fields: [
      { key: 'nombre', label: 'Nombre', type: 'name' },
      { key: 'fechas', label: 'Fechas', type: 'date' },
    ],
    ai: { debounce_seconds: 0.3, recent_messages: 4, summary_batch: 4 },
  });
  assert.equal(upd.statusCode, 200, upd.body);
  const invalid = await authed('PUT', `/api/chatbots/${botId}`, { personality: { emojis: 'muchos' } });
  assert.equal(invalid.statusCode, 400);

  const k = await authed('POST', `/api/chatbots/${botId}/knowledge`, { category: 'precios', title: 'Habitaciones', content: 'Doble: $1,650 MXN por noche. Suite: $2,900 MXN por noche.' });
  assert.equal(k.statusCode, 200);

  // Imagen (PNG mínimo válido) vía multipart
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
  const boundary = '----x';
  const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('code', 'suite') + part('name', 'Suite') + part('description', 'Suite con jacuzzi') + part('usage_rule', 'Cuando pregunten por la suite')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({ method: 'POST', url: `/api/chatbots/${botId}/images`, payload: body, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(up.statusCode, 200, up.body);

  // Un archivo que no es imagen se rechaza aunque diga .png
  const fake = Buffer.concat([
    Buffer.from(part('code', 'x') + part('name', 'x')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nhola\r\n--${boundary}--\r\n`),
  ]);
  const up2 = await app.inject({ method: 'POST', url: `/api/chatbots/${botId}/images`, payload: fake, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(up2.statusCode, 400);
});

t('agrupa mensajes seguidos y responde una sola vez, guardando datos', async () => {
  calls.length = 0;
  sent.length = 0;
  script = () => ({ messages: ['¡Hola Ana! La doble está en $1,650 MXN por noche. ¿Para qué fechas sería?'], save_data: [{ field: 'nombre', value: 'ana' }], remember: ['Le interesa la habitación doble'] });
  await webhook('hola');
  await webhook('soy ana, cuanto cuesta la doble?');
  const bad = await app.inject({ method: 'POST', url: '/webhook/token-falso', payload: {} });
  assert.equal(bad.statusCode, 404);
  await waitFor(() => sent.length === 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(calls.length, 1, 'una sola llamada a la IA para dos mensajes');
  const lastUser = calls[0].messages.filter((m) => m.role === 'user').pop()!;
  assert.match(lastUser.content, /hola\nsoy ana/);
  assert.equal(calls[0].json_schema?.name, 'chatbot_decision');
  assert.equal(sent[0].to, '5215511112222');

  const convs = await authed('GET', `/api/conversations?chatbot_id=${botId}`);
  const conv = convs.json()[0];
  const detail = (await authed('GET', `/api/conversations/${conv.id}`)).json();
  assert.equal(detail.contact.name, 'Ana');
  assert.deepEqual(detail.contact.data, { nombre: 'Ana' });
  assert.deepEqual(detail.contact.notes, ['Le interesa la habitación doble']);
  assert.equal(detail.messages.length, 3);
});

t('el eco de nuestros propios mensajes no pausa el bot', async () => {
  const convs = (await authed('GET', `/api/conversations?chatbot_id=${botId}`)).json();
  await webhook(sent[0].text, { fromMe: true, id: 'OUT-1' });
  await new Promise((r) => setTimeout(r, 100));
  const c = await store.getConversation(convs[0].id);
  assert.equal(c!.status, 'bot');
});

t('precio inventado: reintenta con corrección y envía la versión verificada', async () => {
  calls.length = 0;
  sent.length = 0;
  script = (_req, i) => (i === 0 ? { messages: ['La doble para 3 noches sale en $4,500'] } : { messages: ['La doble está en $1,650 MXN por noche; el total depende de las noches.'] });
  await webhook('y cuanto seria por 3 noches?');
  await waitFor(() => sent.length === 1);
  assert.equal(calls.length, 2);
  const correction = calls[1].messages[calls[1].messages.length - 1];
  assert.equal(correction.role, 'system');
  assert.match(correction.content, /4500/);
  assert.match(sent[0].text, /1,650/);
});

t('si insiste en inventar, usa el mensaje de respaldo', async () => {
  calls.length = 0;
  sent.length = 0;
  script = () => ({ messages: ['El desayuno cuesta $350'] });
  await webhook('cuanto cuesta el desayuno?');
  await waitFor(() => sent.length === 1);
  assert.equal(calls.length, 2);
  assert.equal(sent[0].text, 'Déjame confirmarlo con el equipo.');
  const logs = (await authed('GET', `/api/logs?chatbot_id=${botId}&source=validator`)).json();
  assert.ok(logs.some((l: any) => l.message.includes('respaldo')));
});

t('envía solo imágenes del catálogo', async () => {
  calls.length = 0;
  sent.length = 0;
  script = () => ({ action: 'reply_with_image', messages: ['Así es la suite, cuesta $2,900 MXN por noche'], image_ids: ['suite', 'alberca_inventada'] });
  await webhook('tienes fotos de la suite?');
  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent.map((s) => s.kind), ['text', 'image']);
  assert.equal(sent[1].image, 'suite');
  // La IA ve en el siguiente turno que la imagen ya se envió
  calls.length = 0;
  sent.length = 0;
  script = () => ({ messages: ['Claro'] });
  await webhook('gracias');
  await waitFor(() => sent.length === 1);
  assert.match(calls[0].messages[0].content, /Imágenes ya enviadas en esta conversación: suite/);
});

t('memoria: resume lo antiguo y no manda todo el historial', async () => {
  const convs = (await authed('GET', `/api/conversations?chatbot_id=${botId}`)).json();
  // recent_messages=4 y summary_batch=4: con >8 mensajes sin resumir se genera resumen
  await waitFor(async () => !!(await store.getConversation(convs[0].id))!.summary);
  const c = await store.getConversation(convs[0].id);
  assert.match(c!.summary, /Ana busca la doble/);
  assert.ok(c!.summary_until_id > 0);
  calls.length = 0;
  sent.length = 0;
  script = () => ({ messages: ['Claro'] });
  await webhook('ok y el check in?');
  await waitFor(() => sent.length === 1);
  const req = calls.find((x) => x.json_schema)!;
  assert.match(req.messages[0].content, /Resumen de la conversación anterior/);
  // system + lo no resumido (acotado a recent_messages + summary_batch) + el pendiente
  const c2 = await store.getConversation(convs[0].id);
  const unsummarized = await store.countMessagesAfter(convs[0].id, c2!.summary_until_id);
  assert.ok(unsummarized <= 4 + 4 + 2, `lo no resumido se mantiene acotado (${unsummarized})`);
  assert.ok(req.messages.length <= 1 + unsummarized, `historial acotado (${req.messages.length})`);
  assert.ok(!req.messages.some((m) => m.content.includes('soy ana')), 'los mensajes antiguos no se reenvían');
});

t('palabra clave transfiere a humano sin llamar a la IA, avisa y deja de responder', async () => {
  calls.length = 0;
  sent.length = 0;
  await webhook('quiero hablar con un asesor');
  await waitFor(() => sent.length === 2);
  assert.equal(calls.length, 0);
  assert.equal(sent[1].kind, 'notify');
  assert.equal(sent[1].to, '5215599990000');
  const convs = (await authed('GET', `/api/conversations?chatbot_id=${botId}&status=human`)).json();
  assert.equal(convs.length, 1);
  sent.length = 0;
  await webhook('hola? sigue ahí?');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent.length, 0);

  // Mensaje manual desde el panel y devolver al bot
  const m = await authed('POST', `/api/conversations/${convs[0].id}/send`, { text: 'Hola Ana, soy Carlos del hotel' });
  assert.equal(m.statusCode, 200, m.body);
  assert.equal(sent[0].text, 'Hola Ana, soy Carlos del hotel');
  await authed('POST', `/api/conversations/${convs[0].id}/release`);
  const c = await store.getConversation(convs[0].id);
  assert.equal(c!.status, 'bot');
  // el mensaje que llegó durante la atención humana no se responde después
  assert.equal((await store.pendingInbound(c!.id)).length, 0);
});

t('si una persona responde desde el teléfono, el bot se pausa', async () => {
  sent.length = 0;
  await webhook('hola', { phone: '5215533334444' });
  script = () => ({ messages: ['¡Hola! ¿En qué te ayudo?'] });
  await waitFor(() => sent.length === 1);
  await webhook('Hola, te atiende Luis', { phone: '5215533334444', fromMe: true, id: 'PHONE-1' });
  await new Promise((r) => setTimeout(r, 100));
  const convs = (await authed('GET', `/api/conversations?chatbot_id=${botId}&search=33334444`)).json();
  assert.equal(convs[0].status, 'human');
});

t('mensajes duplicados del webhook se ignoran', async () => {
  sent.length = 0;
  calls.length = 0;
  script = () => ({ messages: ['Hola'] });
  await webhook('hola', { phone: '5215555556666', id: 'DUP-1' });
  await webhook('hola', { phone: '5215555556666', id: 'DUP-1' });
  await waitFor(() => sent.length === 1);
  await new Promise((r) => setTimeout(r, 300));
  const convs = (await authed('GET', `/api/conversations?chatbot_id=${botId}&search=55556666`)).json();
  assert.equal(convs[0].message_count, 2);
});

t('chatbot inactivo guarda pero no responde', async () => {
  await authed('PUT', `/api/chatbots/${botId}`, { active: false });
  sent.length = 0;
  calls.length = 0;
  await webhook('hola?', { phone: '5215577778888' });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent.length, 0);
  assert.equal(calls.length, 0);
});

t('simulador del panel usa el mismo motor aunque el bot esté inactivo', async () => {
  script = () => ({ action: 'reply_with_image', messages: ['Te comparto la suite'], image_ids: ['suite'], save_data: [{ field: 'fechas', value: '20 al 23 de diciembre' }] });
  const r = await authed('POST', `/api/chatbots/${botId}/playground`, { session: 's1', text: 'suite del 20 al 23 de diciembre' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.deepEqual(body.outputs.map((o: any) => o.type), ['text', 'image']);
  assert.equal(body.contact.data.fechas, '20 al 23 de diciembre');
  const hist = (await authed('GET', `/api/chatbots/${botId}/playground/s1`)).json();
  assert.equal(hist.messages.length, 3);
  // Las conversaciones del simulador no aparecen en la lista normal
  const convs = (await authed('GET', `/api/conversations?chatbot_id=${botId}`)).json();
  assert.ok(convs.every((c: any) => c.channel_type === 'whatsapp'));
  await authed('DELETE', `/api/chatbots/${botId}/playground/s1`);
  assert.equal((await authed('GET', `/api/chatbots/${botId}/playground/s1`)).json().messages.length, 0);
});

t('estadísticas y duplicado de chatbot', async () => {
  const s = (await authed('GET', '/api/stats')).json();
  assert.ok(s.chatbots[0].input_tokens_30d > 0);
  const d = await authed('POST', `/api/chatbots/${botId}/duplicate`);
  assert.equal(d.statusCode, 200);
  const copy = d.json();
  assert.equal(copy.active, false);
  assert.equal((await authed('GET', `/api/chatbots/${copy.id}/knowledge`)).json().length, 1);
  assert.equal((await authed('GET', `/api/chatbots/${copy.id}/images`)).json().length, 1);
  void service;
});
