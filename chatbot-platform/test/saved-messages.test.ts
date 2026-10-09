/** Mensajes guardados (texto + foto) elegidos por la IA, y envíos programados que siguen el recorrido. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const imageIds: Record<string, string> = {};

const PRICES = 'Tarifas: habitación doble $1,650 MXN por noche, desayuno incluido.';
const HOURS = 'Recepción abierta de 9:00 a 18:00 h.';

async function upload(code: string, name: string) {
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
  const b = '----x';
  const part = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('code', code) + part('name', name)),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${code}.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: body, headers: { cookie: h.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
  assert.equal(r.statusCode, 200, r.body);
  imageIds[code] = r.json().id;
}

const flowStepOf = async (conversationId: string) =>
  (await pool.query('SELECT flow_step FROM conversations WHERE id = $1', [conversationId])).rows[0].flow_step as number;

/** Mensaje del cliente por WhatsApp y espera a que el asistente termine. */
async function ask(phone: string, text: string) {
  const before = h.sent.length;
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200);
  await waitFor(() => h.sent.length > before, 15000);
  await h.idle();
  return h.sent.slice(before).filter((s) => s.to === phone);
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  await upload('doble', 'Habitación doble');
  await upload('suite', 'Suite');
  const r = await h.authed('PUT', `/api/chatbots/${h.botId}`, {
    flow: { goal: '', steps: [{ title: 'Saludo' }, { title: 'Fechas' }, { title: 'Cierre' }] },
    saved_messages: [
      { code: 'precios', title: 'Lista de precios', text: PRICES, image_id: imageIds.doble, when: 'Cuando pregunten precios', flow_step: 2 },
      { code: 'horario', title: 'Horario', text: HOURS, when: 'Cuando pregunten el horario' },
      { code: 'viejo', text: 'Promoción vencida', active: false },
    ],
  });
  assert.equal(r.statusCode, 200, r.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('validación: código válido, sin duplicados, con texto o foto y la foto del mismo asistente', async () => {
  const put = (saved_messages: unknown) => h.authed('PUT', `/api/chatbots/${h.botId}`, { saved_messages });
  assert.equal((await put([{ code: 'con espacio', text: 'x' }])).statusCode, 400);
  assert.equal((await put([{ code: 'a', text: 'x' }, { code: 'a', text: 'y' }])).statusCode, 400);
  assert.equal((await put([{ code: 'vacio' }])).statusCode, 400, 'sin texto ni foto');
  const foreign = await put([{ code: 'ajena', text: 'x', image_id: crypto.randomUUID() }]);
  assert.equal(foreign.statusCode, 400);
  assert.match(foreign.body, /no pertenece a este asistente/);

  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.deepEqual(bot.saved_messages.map((m: any) => m.code), ['precios', 'horario', 'viejo'], 'los intentos inválidos no cambiaron lo guardado');
});

t('el prompt lista los mensajes guardados activos con su código, cuándo usarlos y si llevan foto', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  await ask('5215520000001', 'Hola');
  const prompt = JSON.stringify(h.calls.at(-1));
  assert.match(prompt, /Mensajes guardados/);
  assert.match(prompt, /`precios`/);
  assert.match(prompt, /usar cuando: Cuando pregunten precios/);
  assert.match(prompt, /con foto/);
  assert.match(prompt, /deja la conversación en la etapa 2 \(Fechas\)/);
  assert.doesNotMatch(prompt, /`viejo`/, 'los inactivos no se ofrecen');
});

t('con foto: sale un solo mensaje, la foto con el texto guardado como pie', async () => {
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: [], saved_message_codes: ['precios'] }));
  const out = await ask('5215520000002', '¿Cuánto cuesta la habitación?');
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.deepEqual(out[0], { kind: 'image', to: '5215520000002', text: PRICES, image: 'doble' });
});

t('sin foto: se envía el texto guardado tal cual', async () => {
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: [], saved_message_codes: ['horario'] }));
  const out = await ask('5215520000003', '¿A qué hora abren?');
  assert.deepEqual(out.map((s) => [s.kind, s.text]), [['text', HOURS]]);
});

t('códigos inexistentes o inactivos se descartan; el resto de la respuesta sí sale', async () => {
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['Con gusto te ayudo'], saved_message_codes: ['no-existe', 'viejo'] }));
  const out = await ask('5215520000004', 'Hola');
  assert.deepEqual(out.map((s) => [s.kind, s.text]), [['text', 'Con gusto te ayudo']]);
});

t('si la plataforma rechaza la foto, el cliente igual recibe el texto', async () => {
  h.reset();
  h.failNext.image = 1;
  h.setScript(() => ({ action: 'reply', messages: [], saved_message_codes: ['precios'] }));
  const out = await ask('5215520000005', 'Precios por favor');
  assert.deepEqual(out.map((s) => [s.kind, s.text]), [['text', PRICES]]);
});

t('recorrido: el mensaje guardado deja la conversación en su etapa si la IA no marcó otra', async () => {
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: [], saved_message_codes: ['precios'], flow_step: 0 }));
  await ask('5215520000006', '¿Precios?');
  const conv = await h.conversationFor('5215520000006');
  assert.equal(await flowStepOf(conv.id), 2);
});

t('límite de fotos por respuesta: la foto del mensaje guardado cuenta y las demás se omiten', async () => {
  assert.equal((await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { max_images_per_reply: 1 } })).statusCode, 200);
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Te comparto opciones'], image_ids: ['suite'], saved_message_codes: ['precios'] }));
  const out = await ask('5215520000007', 'Muéstrame habitaciones y precios');
  assert.deepEqual(out.map((s) => [s.kind, s.image ?? null]), [['text', null], ['image', 'doble']]);
  assert.equal((await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { max_images_per_reply: 2 } })).statusCode, 200);
});

t('envío programado: texto y foto en un solo mensaje y la conversación queda en la etapa indicada', async () => {
  const conv = await h.conversationFor('5215520000001');
  h.reset();
  const r = await h.service.outbound.send(conv.id, { text: 'Hola, te compartimos nuestra promoción de octubre', imageId: imageIds.suite, source: 'campaign', flowStep: 1 });
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.deepEqual(h.sent, [{ kind: 'image', to: '5215520000001', text: 'Hola, te compartimos nuestra promoción de octubre', image: 'suite' }]);
  assert.equal(await flowStepOf(conv.id), 1);

  // El asistente continúa el recorrido desde esa etapa cuando el cliente responde.
  h.setScript(() => ({ messages: ['¿Para qué fechas te interesa?'], flow_step: 2 }));
  await ask('5215520000001', 'Me interesa');
  const prompt = JSON.stringify(h.calls.at(-1));
  assert.match(prompt, /Etapa actual: 1\. Saludo/);
  assert.match(prompt, /promoción de octubre/, 'la IA ve el mensaje programado en el historial');
  assert.equal(await flowStepOf(conv.id), 2);
});

t('campañas: guardan la etapa del recorrido para el primer mensaje', async () => {
  const r = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Bienvenida', message: 'Hola {{nombre}}', image_id: imageIds.doble, flow_step: 1 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().flow_step, 1);
  assert.equal((await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Mal', flow_step: 99 })).statusCode, 400);
});

t('duplicar el asistente: los mensajes guardados apuntan a las fotos copiadas', async () => {
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/duplicate`, {});
  assert.equal(r.statusCode, 200, r.body);
  const copy = r.json();
  const copied = copy.saved_messages.find((m: any) => m.code === 'precios');
  assert.ok(copied.image_id && copied.image_id !== imageIds.doble);
  const copyImages = (await h.authed('GET', `/api/chatbots/${copy.id}/images`)).json();
  assert.ok(copyImages.some((i: any) => i.id === copied.image_id && i.code === 'doble'));
});
