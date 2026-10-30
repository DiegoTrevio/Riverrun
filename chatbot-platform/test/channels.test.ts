/** Canales: Telegram, Messenger, Instagram y chat web, y un chatbot atendiendo varios canales. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, pool, sleep, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const now = () => Math.floor(Date.now() / 1000);
const reqs = (fragment: string) => ext.requests.filter((r) => r.path.includes(fragment));

async function createChannel(type: string, config: Record<string, unknown>, chatbotId: string | null = h.botId) {
  const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type, name: `Canal ${type}`, chatbot_id: chatbotId, config });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ rules: { handoff_keywords: ['asesor'], handoff_notify_number: '5215599990000' } });
  await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { title: 'Precios', content: 'Doble: $1,650 MXN por noche.' });
  // Imagen del catálogo
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
  const b = '----x';
  const part = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('code', 'doble') + part('name', 'Habitación doble')),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="d.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const up = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: body, headers: { cookie: h.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
  assert.equal(up.statusCode, 200, up.body);
  // Documento de la biblioteca: se elige y se envía igual que una foto.
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Menu) >>\nendobj\n%%EOF\n');
  const docBody = Buffer.concat([
    Buffer.from(part('code', 'menu_pdf') + part('name', 'Menú')),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="menu.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const doc = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: docBody, headers: { cookie: h.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
  assert.equal(doc.statusCode, 200, doc.body);
  assert.deepEqual([doc.json().kind, doc.json().file_name], ['document', 'menu.pdf']);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

/* ------------------------------ Telegram ------------------------------ */
let tg: any;
t('Telegram: conectar valida el token y registra el webhook con secreto', async () => {
  tg = await createChannel('telegram', { bot_token: '123:ABC' });
  assert.equal(tg.config.bot_token, '••••••', 'el token nunca se devuelve completo');
  assert.match(tg.webhook_url, /^https:\/\/bot\.test\/webhook\//);
  ext.requests.length = 0;
  const r = await h.authed('POST', `/api/channels/${tg.id}/setup`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().channel.config.bot_username, 'palmas_bot');
  const set = reqs('/bot123:ABC/setWebhook')[0];
  assert.equal(set.body.url, tg.webhook_url);
  assert.ok(set.body.secret_token && set.body.secret_token.length >= 32);
  tg.secret = set.body.secret_token;
  // Guardar sin tocar el token enmascarado lo conserva
  await h.authed('PUT', `/api/channels/${tg.id}`, { name: 'Telegram Palmas', config: { bot_token: '••••••' } });
  ext.requests.length = 0;
  await h.authed('GET', `/api/channels/${tg.id}/status`);
  assert.equal(reqs('/bot123:ABC/getWebhookInfo').length, 1);
});

const tgUpdate = (text: string, chatId = 777, extra: Record<string, unknown> = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: Math.floor(Math.random() * 1e6), date: now(), chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Luis', last_name: 'Pérez' }, text, ...extra },
});

t('Telegram: rechaza webhooks sin el secreto y responde a los válidos (texto plano y foto)', async () => {
  const bad = await h.app.inject({ method: 'POST', url: `/webhook/${tg.webhook_token}`, payload: tgUpdate('hola') });
  assert.equal(bad.statusCode, 401);
  ext.requests.length = 0;
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['*Hola Luis*, la doble está en $1,650 MXN por noche'], image_ids: ['doble'] }));
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${tg.webhook_token}`, headers: { 'x-telegram-bot-api-secret-token': tg.secret }, payload: tgUpdate('/start') });
  assert.equal(r.statusCode, 200);
  // El bot simula "escribiendo…" antes de cada envío (≈2.5 s texto + 1.2 s foto): se da margen.
  await waitFor(() => reqs('/sendPhoto').length === 1, 12000);
  const msg = reqs('/sendMessage')[0];
  assert.equal(msg.body.chat_id, '777');
  assert.equal(msg.body.text, 'Hola Luis, la doble está en $1,650 MXN por noche', 'sin asteriscos de WhatsApp');
  assert.match(reqs('/sendPhoto')[0].raw, /name="photo"/);
  assert.ok(reqs('/sendChatAction').length >= 1, 'muestra "escribiendo…"');
  assert.match(h.calls[0].messages.filter((m) => m.role === 'user').pop()!.content, /inició la conversación/);
  assert.match(h.calls[0].messages[0].content, /Canal: Telegram/);
  const convs = (await h.authed('GET', `/api/conversations?channel_type=telegram`)).json();
  assert.equal(convs.length, 1);
  assert.equal(convs[0].push_name, 'Luis Pérez');
});

t('Telegram: un documento de la biblioteca sale con sendDocument y su nombre', async () => {
  ext.requests.length = 0;
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Te mando el menú en PDF'], image_ids: ['menu_pdf'] }));
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${tg.webhook_token}`, headers: { 'x-telegram-bot-api-secret-token': tg.secret }, payload: tgUpdate('¿tienen menú?', 778) });
  assert.equal(r.statusCode, 200);
  await waitFor(() => reqs('/sendDocument').length === 1, 12000);
  assert.equal(reqs('/sendPhoto').length, 0, 'un PDF no va como foto');
  await h.idle();
  const row = (await pool.query(`SELECT m.type, m.meta->>'file_name' AS file_name FROM messages m JOIN images i ON i.id = m.image_id WHERE i.code = 'menu_pdf' ORDER BY m.id DESC LIMIT 1`)).rows[0];
  assert.deepEqual([row.type, row.file_name], ['document', 'menu.pdf']);
});

t('Telegram: ignora grupos', async () => {
  h.reset();
  await h.app.inject({ method: 'POST', url: `/webhook/${tg.webhook_token}`, headers: { 'x-telegram-bot-api-secret-token': tg.secret }, payload: { message: { ...tgUpdate('hola').message, chat: { id: -100, type: 'group' } } } });
  await sleep(300);
  assert.equal(h.calls.length, 0);
});

t('Telegram: transferencia avisa al encargado por el WhatsApp de la cuenta', async () => {
  h.reset();
  await h.app.inject({ method: 'POST', url: `/webhook/${tg.webhook_token}`, headers: { 'x-telegram-bot-api-secret-token': tg.secret }, payload: tgUpdate('quiero un asesor', 778) });
  await waitFor(() => h.sent.some((s) => s.to === '5215599990000'));
  const notice = h.sent.find((s) => s.to === '5215599990000')!;
  assert.match(notice.text, /necesita atención/);
});

/* ------------------------------ Messenger ------------------------------ */
let fb: any;
const sign = (body: string, secret = 'app-secret') => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const fbEvent = (text: string, psid = 'PSID1', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: 'PAGE1' }, timestamp: Date.now(), message: { mid: `mid.${crypto.randomUUID()}`, text, ...extra } }] }] });

t('Messenger: verificación del webhook y suscripción de la página', async () => {
  fb = await createChannel('messenger', { page_id: 'PAGE1', page_access_token: 'EAAB', app_secret: 'app-secret' });
  assert.ok(fb.config.verify_token.length >= 16, 'se genera un token de verificación');
  const okv = await h.app.inject({ method: 'GET', url: `/webhook/${fb.webhook_token}?hub.mode=subscribe&hub.verify_token=${fb.config.verify_token}&hub.challenge=CH123` });
  assert.equal(okv.statusCode, 200);
  assert.equal(okv.body, 'CH123');
  const badv = await h.app.inject({ method: 'GET', url: `/webhook/${fb.webhook_token}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=CH123` });
  assert.equal(badv.statusCode, 403);
  ext.requests.length = 0;
  const setup = await h.authed('POST', `/api/channels/${fb.id}/setup`);
  assert.equal(setup.statusCode, 200, setup.body);
  assert.equal(reqs('/PAGE1/subscribed_apps').length, 1);
  assert.equal(reqs('/PAGE1/subscribed_apps')[0].query.get('access_token'), 'EAAB');
});

t('Messenger: solo acepta eventos firmados por Meta y responde con texto e imagen (URL firmada)', async () => {
  const body = fbEvent('hola, tienen fotos de la doble?');
  const unsigned = await h.app.inject({ method: 'POST', url: `/webhook/${fb.webhook_token}`, headers: { 'content-type': 'application/json' }, payload: body });
  assert.equal(unsigned.statusCode, 401);
  const forged = await h.app.inject({ method: 'POST', url: `/webhook/${fb.webhook_token}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'otro') }, payload: body });
  assert.equal(forged.statusCode, 401);
  ext.requests.length = 0;
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Claro, así es la *doble*'], image_ids: ['doble'] }));
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${fb.webhook_token}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
  assert.equal(r.statusCode, 200);
  await waitFor(() => reqs('/me/messages').filter((x) => x.body.message).length === 2);
  const [text, image] = reqs('/me/messages').filter((x) => x.body.message);
  assert.equal(text.body.recipient.id, 'PSID1');
  assert.equal(text.body.message.text, 'Claro, así es la doble');
  const url = image.body.message.attachment.payload.url as string;
  assert.match(url, /^https:\/\/bot\.test\/media\//);
  // La URL firmada sirve la imagen; alterada, no.
  const path = url.replace('https://bot.test', '');
  assert.equal((await h.app.inject({ method: 'GET', url: path })).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: path.replace(/s=[^&]+/, 's=falsa') })).statusCode, 403);
});

t('Messenger: el eco de nuestro envío se ignora; una respuesta manual desde la página pausa el bot', async () => {
  const sentMid = (await h.authed('GET', `/api/conversations?channel_type=messenger`)).json()[0];
  const detail = (await h.authed('GET', `/api/conversations/${sentMid.id}`)).json();
  const ourMid = detail.messages.find((m: any) => m.direction === 'out' && m.external_message_id).external_message_id;
  const echo = (mid: string, text: string) =>
    JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PAGE1' }, recipient: { id: 'PSID1' }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] }] });
  let body = echo(ourMid, 'Claro, así es la doble');
  await h.app.inject({ method: 'POST', url: `/webhook/${fb.webhook_token}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
  await sleep(200);
  assert.equal((await h.authed('GET', `/api/conversations/${sentMid.id}`)).json().conversation.status, 'bot');
  body = echo('mid.manual', 'Hola, te atiende Carla');
  await h.app.inject({ method: 'POST', url: `/webhook/${fb.webhook_token}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
  await waitFor(async () => (await h.authed('GET', `/api/conversations/${sentMid.id}`)).json().conversation.status === 'human');
});

t('Messenger: un documento de la biblioteca sale como archivo con su URL firmada', async () => {
  const body = fbEvent('me pasas el menú?', 'PSID9');
  ext.requests.length = 0;
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Claro, aquí va el menú'], image_ids: ['menu_pdf'] }));
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${fb.webhook_token}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
  assert.equal(r.statusCode, 200);
  await waitFor(() => reqs('/me/messages').some((x) => x.body.message?.attachment?.type === 'file'));
  const file = reqs('/me/messages').find((x) => x.body.message?.attachment?.type === 'file')!;
  assert.match(file.body.message.attachment.payload.url, /^https:\/\/bot\.test\/media\//);
  // La URL firmada entrega el PDF como descarga con su nombre.
  const u = new URL(file.body.message.attachment.payload.url);
  const got = await h.app.inject({ method: 'GET', url: u.pathname + u.search });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'application/pdf');
  assert.equal(got.headers['content-disposition'], `attachment; filename="menu.pdf"; filename*=UTF-8''menu.pdf`);
  // Rangos: Safari en iPhone pide el archivo por partes.
  const part = await h.app.inject({ method: 'GET', url: u.pathname + u.search, headers: { range: 'bytes=0-3' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 0-3/${got.rawPayload.length}`);
  assert.equal(part.rawPayload.toString('latin1'), got.rawPayload.subarray(0, 4).toString('latin1'));
  // Un nombre con raya, emoji u otro alfabeto ya no rompe la descarga (antes respondía 500).
  const id = u.pathname.split('/').pop()!;
  await pool.query(`UPDATE images SET file_name = 'Menú – 2026 📦 菜单.pdf' WHERE id = $1`, [id]);
  const named = await h.app.inject({ method: 'GET', url: u.pathname + u.search });
  assert.equal(named.statusCode, 200);
  assert.match(String(named.headers['content-disposition']), /filename\*=UTF-8''Men%C3%BA%20%E2%80%93%202026%20%F0%9F%93%A6%20%E8%8F%9C%E5%8D%95\.pdf/);
  await pool.query(`UPDATE images SET file_name = 'menu.pdf' WHERE id = $1`, [id]);
});

/* ------------------------------ Instagram ------------------------------ */
t('Instagram: recibe mensajes directos firmados y responde por la API de mensajes', async () => {
  const ig = await createChannel('instagram', { account_id: 'IG1', page_access_token: 'IGTOKEN', app_secret: 'ig-secret' });
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'IGSID9' }, recipient: { id: 'IG1' }, timestamp: Date.now(), message: { mid: 'ig.mid.1', text: 'precio doble?' } }] }] });
  ext.requests.length = 0;
  h.reset();
  h.setScript(() => ({ messages: ['La doble está en $1,650 MXN por noche'] }));
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${ig.webhook_token}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'ig-secret') }, payload: body });
  assert.equal(r.statusCode, 200);
  await waitFor(() => reqs('/me/messages').some((x) => x.body.message));
  const send = reqs('/me/messages').find((x) => x.body.message)!;
  assert.equal(send.body.recipient.id, 'IGSID9');
  assert.equal(send.query.get('access_token'), 'IGTOKEN');
  // Eventos de otra cuenta de Instagram se ignoran
  h.reset();
  const other = JSON.stringify({ object: 'instagram', entry: [{ id: 'OTRA', messaging: [{ sender: { id: 'X' }, recipient: { id: 'OTRA' }, timestamp: Date.now(), message: { mid: 'ig.mid.2', text: 'hola' } }] }] });
  await h.app.inject({ method: 'POST', url: `/webhook/${ig.webhook_token}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(other, 'ig-secret') }, payload: other });
  await sleep(300);
  assert.equal(h.calls.length, 0);
});

/* ------------------------------ Chat web ------------------------------ */
t('Chat web: sesión, mensaje, "escribiendo…" y respuesta con imagen', async () => {
  const web = await createChannel('webchat', { title: 'Hotel Palmas', color: '#0a7cff' });
  assert.match(web.embed_code, /widget\.js" data-channel="/);
  const base = `/webchat/${web.webhook_token}`;
  const cfg = (await h.app.inject({ method: 'GET', url: `${base}/config` })).json();
  assert.equal(cfg.title, 'Hotel Palmas');
  const { session } = (await h.app.inject({ method: 'POST', url: `${base}/session` })).json();
  assert.match(session, /^[a-f0-9]{32}\.[\w-]{22}$/);
  h.reset();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.setScript(async () => {
    await gate;
    return { action: 'reply_with_image', messages: ['Así es la *doble*'], image_ids: ['doble'] };
  });
  const send = await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'fotos de la doble?' } });
  assert.equal(send.statusCode, 200, send.body);
  const during = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}` })).json();
  assert.equal(during.typing, true);
  release();
  // Las respuestas aparecen antes de que la pregunta quede marcada como procesada: se espera a las dos cosas.
  await waitFor(async () => {
    const r = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}` })).json();
    return r.messages.length === 3 && !r.typing;
  });
  const after = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}` })).json();
  assert.equal(after.typing, false);
  assert.deepEqual(after.messages.map((m: any) => m.from), ['customer', 'bot', 'bot']);
  assert.equal(after.messages[1].text, 'Así es la doble');
  assert.match(after.messages[2].image_url, /^https:\/\/bot\.test\/media\//);
  // Consultar desde un id solo trae lo nuevo
  const since = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}&after=${after.messages[1].id}` })).json();
  assert.equal(since.messages.length, 1);
  // Otra sesión no ve esta conversación
  const { session: another } = (await h.app.inject({ method: 'POST', url: `${base}/session` })).json();
  const other = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${another}` })).json();
  assert.equal(other.messages.length, 0);
});

t('Chat web: solo valen las sesiones que entregó el servidor para ese canal', async () => {
  const web = await createChannel('webchat', {});
  const elsewhere = await createChannel('webchat', {});
  const base = `/webchat/${web.webhook_token}`;
  const { session } = (await h.app.inject({ method: 'POST', url: `${base}/session` })).json();
  const { session: foreign } = (await h.app.inject({ method: 'POST', url: `/webchat/${elsewhere.webhook_token}/session` })).json();
  h.setScript(() => ({ messages: ['ok'] }));
  // Una sesión inventada creaba un cliente y una respuesta de IA cada vez: el límite de sesiones por conexión no servía.
  for (const forged of ['a'.repeat(32), `${session.slice(0, 32)}.${'A'.repeat(22)}`, foreign]) {
    assert.equal((await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session: forged, text: 'hola' } })).statusCode, 400, forged);
    assert.equal((await h.app.inject({ method: 'GET', url: `${base}/messages?session=${forged}` })).statusCode, 400, forged);
  }
  assert.equal((await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'hola' } })).statusCode, 200);
});

t('Chat web: el modo de color es automático por defecto y se puede fijar en claro u oscuro', async () => {
  const web = await createChannel('webchat', { title: 'Hotel Palmas' });
  const config = async () => (await h.app.inject({ method: 'GET', url: `/webchat/${web.webhook_token}/config` })).json();
  assert.equal((await config()).theme, 'auto');
  assert.equal((await h.authed('PUT', `/api/channels/${web.id}`, { config: { title: 'Hotel Palmas', theme: 'dark' } })).statusCode, 200);
  assert.equal((await config()).theme, 'dark');
  assert.equal((await h.authed('PUT', `/api/channels/${web.id}`, { config: { title: 'Hotel Palmas', theme: 'morado' } })).statusCode, 400);
  assert.equal((await config()).theme, 'dark', 'un valor inválido no cambia nada');
});

t('Chat web: un documento de la biblioteca llega al widget como archivo para descargar', async () => {
  const web = await createChannel('webchat', { title: 'Hotel Palmas' });
  const base = `/webchat/${web.webhook_token}`;
  const { session } = (await h.app.inject({ method: 'POST', url: `${base}/session` })).json();
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Te dejo el menú'], image_ids: ['menu_pdf'] }));
  assert.equal((await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'menú?' } })).statusCode, 200);
  await waitFor(async () => (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}` })).json().messages.length === 3);
  const msgs = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}` })).json().messages;
  const file = msgs[2];
  assert.equal(file.image_url, null, 'no se muestra como foto');
  assert.deepEqual([file.file.name, file.file.kind], ['menu.pdf', 'document']);
  assert.match(file.file.url, /^https:\/\/bot\.test\/media\//);
});

t('Chat web: orígenes permitidos, límite de mensajes y canal desactivado', async () => {
  const web = await createChannel('webchat', { allowed_origins: ['hotelpalmas.mx', '*.palmas.com'] });
  const base = `/webchat/${web.webhook_token}`;
  const from = (origin: string) => h.app.inject({ method: 'GET', url: `${base}/config`, headers: { origin } });
  assert.equal((await from('https://hotelpalmas.mx')).headers['access-control-allow-origin'], 'https://hotelpalmas.mx');
  assert.equal((await from('https://reservas.palmas.com')).statusCode, 200);
  assert.equal((await from('https://sitio-ajeno.com')).statusCode, 403);
  const pre = await h.app.inject({ method: 'OPTIONS', url: `${base}/messages`, headers: { origin: 'https://hotelpalmas.mx', 'access-control-request-method': 'POST' } });
  assert.equal(pre.statusCode, 204);

  h.setScript(() => ({ messages: ['ok'] }));
  const { session } = (await h.app.inject({ method: 'POST', url: `${base}/session`, headers: { origin: 'https://hotelpalmas.mx' } })).json();
  const codes: number[] = [];
  for (let i = 0; i < 17; i++) codes.push((await h.app.inject({ method: 'POST', url: `${base}/messages`, headers: { origin: 'https://hotelpalmas.mx' }, payload: { session, text: `m${i}` } })).statusCode);
  assert.ok(codes.slice(0, 15).every((c) => c === 200));
  assert.equal(codes[16], 429);
  // Sin cabecera Origin no es un navegador: la lista de dominios no aplica (no es autenticación), solo se valida la sesión.
  assert.equal((await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session: 'corta', text: 'x' } })).statusCode, 400);

  // Muchas sesiones desde la misma conexión tampoco sirven para saltarse el límite: a lo más 10 por hora.
  const created = [];
  for (let i = 0; i < 11; i++) created.push(await h.app.inject({ method: 'POST', url: `${base}/session` }));
  assert.equal(created.filter((r) => r.statusCode === 200).length, 9, 'ya se había abierto una');
  const valid = created.filter((r) => r.statusCode === 200).map((r) => r.json().session as string);
  const ipCodes: number[] = [];
  for (let i = 0; i < 30; i++) {
    ipCodes.push((await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session: valid[i % valid.length], text: 'x' } })).statusCode);
  }
  assert.ok(ipCodes.includes(429), 'límite por IP entre sesiones');

  await h.authed('PUT', `/api/channels/${web.id}`, { active: false });
  assert.equal((await from('https://hotelpalmas.mx')).statusCode, 404);
});

/* ------------------------------ Varios canales, un chatbot ------------------------------ */
t('un chatbot atiende varios canales con memoria separada por cliente', async () => {
  const convs = (await h.authed('GET', `/api/conversations?chatbot_id=${h.botId}`)).json();
  const types = new Set(convs.map((c: any) => c.channel_type));
  for (const tp of ['telegram', 'messenger', 'instagram', 'webchat']) assert.ok(types.has(tp), `falta ${tp}`);
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.ok(bot.channels.length >= 5, 'el chatbot lista sus canales');
});

t('canal sin chatbot guarda mensajes sin responder; al asignarlo, el nuevo chatbot atiende', async () => {
  const web = await createChannel('webchat', {}, null);
  const base = `/webchat/${web.webhook_token}`;
  const { session } = (await h.app.inject({ method: 'POST', url: `${base}/session` })).json();
  await h.idle();
  h.reset();
  await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'hola?' } });
  await sleep(400);
  assert.equal(h.calls.length, 0);
  const bot2 = (await h.authed('POST', '/api/chatbots', { account_id: h.accountId, name: 'Segundo bot', active: true, ai: { debounce_seconds: 0.1 } })).json();
  await h.authed('PUT', `/api/channels/${web.id}`, { chatbot_id: bot2.id });
  h.setScript(() => ({ messages: ['Hola, soy el segundo bot'] }));
  await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'ahora sí?' } });
  await waitFor(() => h.calls.length === 1);
  assert.match(h.calls[0].messages[0].content, /"Segundo bot"/);
  const conv = (await h.authed('GET', `/api/conversations?channel_id=${web.id}`)).json()[0];
  assert.equal(conv.chatbot_id, bot2.id);
});

t('la configuración inválida de un canal se rechaza', async () => {
  const bad = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'webchat', name: 'x', config: { color: 'rojo' } });
  assert.equal(bad.statusCode, 400);
  const badType = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'fax', name: 'x' });
  assert.equal(badType.statusCode, 400);
});
