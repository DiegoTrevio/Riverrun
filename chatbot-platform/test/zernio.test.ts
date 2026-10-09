/** Zernio de extremo a extremo: conexión de cuenta, webhook firmado, respuesta del bot en el hilo y reintentos. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, pool, sleep, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let channel: any;

const reqs = (fragment: string) => ext.requests.filter((r) => r.path.includes(fragment));
const sendsTo = (conv: string) => reqs(`/inbox/conversations/${conv}/messages`);
const sign = (raw: string, secret: string) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const secretOf = async () => (await store.getChannel(channel.id))!.config.webhook_secret as string;

const inbound = (messageId: string, text: string, conv = 'conv_77') =>
  JSON.stringify({
    event: 'message.received',
    payload: { id: `evt_${messageId}`, conversationId: conv, message: { id: messageId, text, createdAt: new Date().toISOString() }, sender: { id: 'p_77', name: 'Ana' } },
  });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola, con gusto te ayudo'] }));
  const r = await h.authed('POST', '/api/channels', {
    account_id: h.accountId,
    type: 'zernio',
    name: 'Zernio Bluesky',
    chatbot_id: h.botId,
    config: { platform: 'bluesky', profile_id: 'prof_1', api_key: 'zk_test' },
  });
  assert.equal(r.statusCode, 200, r.body);
  channel = r.json();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('conexión: genera un estado de un solo uso y devuelve la URL de autorización', async () => {
  const r = await h.authed('POST', `/api/channels/${channel.id}/zernio/connect`);
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.json().authUrl, /^https:\/\/zernio\.example\/auth\//);

  const state = (await store.getChannel(channel.id))!.config.connect_state as string;
  assert.ok(state.length >= 30, 'el estado debe ser aleatorio y largo');
  const call = reqs('/connect/bluesky').at(-1)!;
  assert.equal(call.query.get('profileId'), 'prof_1');
  assert.equal(call.query.get('redirect_url'), `https://bot.test/zernio/callback/${channel.webhook_token}/${state}`);
  assert.equal(call.headers.authorization, 'Bearer zk_test');
});

t('retorno con estado falso se rechaza y no cambia la cuenta', async () => {
  const r = await h.app.inject({ method: 'GET', url: `/zernio/callback/${channel.webhook_token}/estado-falso?accountId=acc_x&profileId=prof_1` });
  assert.equal(r.statusCode, 403);
  assert.equal((await store.getChannel(channel.id))!.config.account_id, '');
});

t('retorno válido guarda la cuenta conectada, consume el estado y redirige al canal', async () => {
  const state = (await store.getChannel(channel.id))!.config.connect_state as string;
  const url = `/zernio/callback/${channel.webhook_token}/${state}?connected=true&accountId=acc_zernio_1&profileId=prof_1&username=ana`;
  const r = await h.app.inject({ method: 'GET', url });
  assert.equal(r.statusCode, 302, r.body);
  assert.match(String(r.headers.location), new RegExp(`/#/channel/${channel.id}$`));

  const saved = (await store.getChannel(channel.id))!.config;
  assert.equal(saved.account_id, 'acc_zernio_1');
  assert.equal(saved.username, 'ana');
  assert.equal(saved.connect_state, '');
  assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 403, 'el mismo estado no sirve dos veces');
});

t('retorno de conexión: un enlace vencido o con otro perfil no sirve y el estado se consume igual', async () => {
  const connect = async () => {
    assert.equal((await h.authed('POST', `/api/channels/${channel.id}/zernio/connect`)).statusCode, 200);
    return (await store.getChannel(channel.id))!.config.connect_state as string;
  };
  // Otro perfil: no cambia la cuenta y el mismo enlace ya no sirve.
  let state = await connect();
  const wrong = `/zernio/callback/${channel.webhook_token}/${state}?accountId=acc_intruso&profileId=prof_otro`;
  assert.equal((await h.app.inject({ method: 'GET', url: wrong })).statusCode, 302);
  assert.equal((await store.getChannel(channel.id))!.config.account_id, 'acc_zernio_1');
  assert.equal((await h.app.inject({ method: 'GET', url: wrong.replace('prof_otro', 'prof_1') })).statusCode, 403, 'estado consumido');
  // Vencido (generado hace más de 30 minutos): no guarda la cuenta.
  state = await connect();
  const old = `${(Date.now() - 31 * 60_000).toString(36)}.${state.split('.')[1]}`;
  await store.updateChannel(channel.id, { config: { ...(await store.getChannel(channel.id))!.config, connect_state: old } });
  const r = await h.app.inject({ method: 'GET', url: `/zernio/callback/${channel.webhook_token}/${old}?accountId=acc_tarde&profileId=prof_1` });
  assert.equal(r.statusCode, 302);
  assert.equal((await store.getChannel(channel.id))!.config.account_id, 'acc_zernio_1');
});

t('registro del webhook: Zernio recibe la URL pública, el secreto del canal y los eventos de mensajes', async () => {
  const r = await h.authed('POST', `/api/channels/${channel.id}/setup`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().ok, true);
  const call = reqs('/webhooks/settings').at(-1)!;
  assert.deepEqual(call.body, {
    url: `https://bot.test/webhook/${channel.webhook_token}`,
    secret: await secretOf(),
    events: ['message.received', 'message.sent'],
  });
});

t('mensaje entrante firmado: el bot responde en el mismo hilo con la cuenta conectada', async () => {
  const raw = inbound('zm_in_1', 'Hola, ¿tienen habitaciones?');
  const r = await h.app.inject({
    method: 'POST',
    url: `/webhook/${channel.webhook_token}`,
    headers: { 'content-type': 'application/json', 'x-zernio-signature': sign(raw, await secretOf()) },
    payload: raw,
  });
  assert.equal(r.statusCode, 200);
  await waitFor(() => sendsTo('conv_77').length >= 1, 15000);
  await h.idle();
  const sent = sendsTo('conv_77').at(-1)!;
  assert.equal(sent.body.accountId, 'acc_zernio_1');
  assert.match(sent.body.message, /con gusto te ayudo/);
});

t('entrega repetida del mismo mensaje no genera una segunda respuesta', async () => {
  const before = sendsTo('conv_77').length;
  const raw = inbound('zm_in_1', 'Hola, ¿tienen habitaciones?');
  const r = await h.app.inject({
    method: 'POST',
    url: `/webhook/${channel.webhook_token}`,
    headers: { 'content-type': 'application/json', 'x-zernio-signature': sign(raw, await secretOf()) },
    payload: raw,
  });
  assert.equal(r.statusCode, 200);
  await h.idle();
  await sleep(300);
  assert.equal(sendsTo('conv_77').length, before);
});

t('firma inválida: se rechaza con 401 y no se procesa', async () => {
  const before = sendsTo('conv_78').length;
  const raw = inbound('zm_bad_1', 'Hola', 'conv_78');
  const r = await h.app.inject({
    method: 'POST',
    url: `/webhook/${channel.webhook_token}`,
    headers: { 'content-type': 'application/json', 'x-zernio-signature': sign(raw, 'otro-secreto') },
    payload: raw,
  });
  assert.equal(r.statusCode, 401);
  await h.idle();
  await sleep(300);
  assert.equal(sendsTo('conv_78').length, before);
});

t('eco de una respuesta del bot no pausa la conversación', async () => {
  const sent = sendsTo('conv_77').at(-1)!;
  const raw = JSON.stringify({
    event: 'message.sent',
    payload: { id: 'evt_echo_1', conversationId: 'conv_77', message: { id: 'zm_echo_1', text: sent.body.message } },
  });
  const r = await h.app.inject({
    method: 'POST',
    url: `/webhook/${channel.webhook_token}`,
    headers: { 'content-type': 'application/json', 'x-zernio-signature': sign(raw, await secretOf()) },
    payload: raw,
  });
  assert.equal(r.statusCode, 200);
  await h.idle();
  await sleep(300);
  const status = (await pool.query('SELECT status FROM conversations WHERE channel_id = $1', [channel.id])).rows[0]?.status;
  assert.equal(status, 'bot');
});

t('eco sin formato ("*doble*" vuelve como "doble") no pausa la conversación', async () => {
  const conv = (await pool.query(`SELECT c.* FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE c.channel_id = $1 AND k.external_id = 'conv_77'`, [channel.id])).rows[0];
  await store.insertMessage({ conversation_id: conv.id, direction: 'out', sender: 'bot', type: 'text', content: 'La habitación *doble* cuesta lo de la lista.', status: 'ok' });
  const raw = JSON.stringify({
    event: 'message.sent',
    payload: { id: 'evt_echo_2', conversationId: 'conv_77', message: { id: 'zm_echo_2', text: 'La habitación doble cuesta lo de la lista.' } },
  });
  const r = await h.app.inject({
    method: 'POST',
    url: `/webhook/${channel.webhook_token}`,
    headers: { 'content-type': 'application/json', 'x-zernio-signature': sign(raw, await secretOf()) },
    payload: raw,
  });
  assert.equal(r.statusCode, 200);
  await h.idle();
  await sleep(300);
  assert.equal((await pool.query('SELECT status FROM conversations WHERE id = $1', [conv.id])).rows[0].status, 'bot');
  const human = await pool.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender = 'human'`, [conv.id]);
  assert.equal(human.rows[0].n, 0, 'no se registró como respuesta de una persona');
});

t('ventana de 24 h: fuera de ella no se escribe por Zernio', async () => {
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE c.channel_id = $1 AND k.external_id = 'conv_77'`,
    [channel.id],
  );
  const convId = rows[0].id as string;
  // Con consentimiento de promociones, lo único que bloquea el envío es la ventana de 24 h.
  const contactId = (await h.authed('GET', `/api/conversations/${convId}`)).json().contact.id;
  assert.equal((await h.authed('PUT', `/api/contacts/${contactId}`, { consent: true })).statusCode, 200);
  await pool.query(`UPDATE messages SET created_at = now() - interval '25 hours' WHERE conversation_id = $1`, [convId]);
  try {
    const r = await h.service.outbound.send(convId, { text: 'Promoción de temporada', source: 'campaign' });
    assert.equal(r.sent, false);
    assert.match((r as any).reason, /24 h/);
    assert.equal(sendsTo('conv_77').filter((x) => x.body.message === 'Promoción de temporada').length, 0);
  } finally {
    await pool.query(`UPDATE messages SET created_at = now() WHERE conversation_id = $1`, [convId]);
  }
});

t('convive con el WhatsApp por QR: el aviso al encargado sigue saliendo por la cuenta de WhatsApp', async () => {
  const zernioChannel = await store.getChannel(channel.id);
  h.reset();
  await h.service.transportFor(zernioChannel!, { phone: '', external_id: 'conv_77' } as any).notify('5215599990000', 'Transferencia: revisar a Ana');
  // El aviso sale como texto por el WhatsApp de QR de la cuenta, nunca por Zernio.
  assert.ok(h.sent.some((s) => s.kind === 'text' && s.to === '5215599990000' && s.text.includes('Transferencia')), JSON.stringify(h.sent));
});
