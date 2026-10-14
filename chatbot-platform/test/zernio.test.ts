/**
 * Redes sociales por Zernio de extremo a extremo: la plataforma tiene una sola llave; cada negocio elige la red y la
 * conecta desde el panel (OAuth, código de Telegram o Bluesky), recibe los mensajes por el webhook único de la
 * plataforma y el agente contesta en el mismo hilo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, pool, sleep, store, waitFor, zer } from './harness.js';
// Después del arnés (que define las variables de entorno con await de nivel superior).
const { platformWebhookSecret } = await import('../src/channels/zernio.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let channel: any;

const reqs = (fragment: string) => ext.requests.filter((r) => r.path.includes(fragment));
const sendsTo = (conv: string) => reqs(`/inbox/conversations/${conv}/messages`);
const sign = (raw: string, secret = platformWebhookSecret()) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const cfg = async (id = channel.id) => (await store.getChannel(id))!.config;

const event = (over: Record<string, any> = {}, msg: Record<string, any> = {}) => JSON.stringify({
  id: `evt_${crypto.randomUUID()}`, event: 'message.received', timestamp: new Date().toISOString(),
  message: {
    id: `zm_${crypto.randomUUID()}`, conversationId: 'conv_77', platform: 'instagram', platformMessageId: 'ig_1', direction: 'incoming',
    text: 'Hola, ¿tienen habitaciones?', attachments: [], sender: { id: 'u_77', name: 'Ana', username: 'ana' }, sentAt: new Date().toISOString(), ...msg,
  },
  conversation: { id: 'conv_77', participantName: 'Ana' },
  account: { id: 'acc_ig', platform: 'instagram', username: 'hotel' },
  ...over,
});
const deliver = (raw: string, secret?: string) =>
  h.app.inject({ method: 'POST', url: '/zernio/events', headers: { 'content-type': 'application/json', 'x-zernio-signature': sign(raw, secret) }, payload: raw });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola, con gusto te ayudo'] }));
  // El dueño del negocio (no el superadmin) conecta sus redes.
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'dueno@redes.mx', name: 'Dueño', password: 'clave-redes-1', role: 'admin' });
  assert.equal(u.statusCode, 200, u.body);
  await pool.query('UPDATE users SET email_verified_at = now() WHERE email = $1', ['dueno@redes.mx']);
  owner = await h.loginAs('dueno@redes.mx', 'clave-redes-1');
  const r = await owner('POST', '/api/channels', { type: 'zernio', name: 'Instagram del hotel', chatbot_id: h.botId, config: { platform: 'instagram' } });
  assert.equal(r.statusCode, 200, r.body);
  channel = r.json();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('alta: el negocio solo elige la red; perfil, cuenta y llave no se aceptan desde el panel', async () => {
  const c = await cfg();
  assert.equal(c.platform, 'instagram');
  assert.equal(c.profile_id, '');
  assert.equal(c.api_key, '');
  const spoof = await owner('PUT', `/api/channels/${channel.id}`, { config: { platform: 'instagram', profile_id: 'prof_ajeno', account_id: 'acc_ajena', api_key: 'zk_propia' } });
  assert.equal(spoof.statusCode, 200, spoof.body);
  const after = await cfg();
  assert.equal(after.profile_id, '');
  assert.equal(after.account_id, '');
  assert.equal(after.api_key, '');
  const bad = await owner('POST', '/api/channels', { type: 'zernio', name: 'X', config: { platform: 'myspace' } });
  assert.equal(bad.statusCode, 400);
});

t('conexión OAuth: crea el perfil del negocio en Zernio una sola vez y devuelve la página de autorización', async () => {
  const r = await owner('POST', `/api/channels/${channel.id}/zernio/connect`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().kind, 'oauth');
  assert.match(r.json().authUrl, /^https:\/\/zernio\.example\/auth\//);
  const c = await cfg();
  assert.equal(zer.profiles.filter((p) => p.externalId === h.accountId).length, 1);
  assert.equal(c.profile_id, zer.profiles.find((p) => p.externalId === h.accountId)._id);
  const call = reqs('/connect/instagram').at(-1)!;
  assert.equal(call.query.get('profileId'), c.profile_id);
  assert.equal(call.query.get('redirect_url'), `https://bot.test/zernio/callback/${channel.webhook_token}/${c.connect_state}`);
  assert.equal(call.headers.authorization, `Bearer ${zer.key}`, 'usa la llave de la plataforma');
  // Otra conexión reutiliza el mismo perfil.
  assert.equal((await owner('POST', `/api/channels/${channel.id}/zernio/connect`)).statusCode, 200);
  assert.equal(zer.profiles.filter((p) => p.externalId === h.accountId).length, 1);
});

t('retorno con estado falso se rechaza y no cambia la cuenta', async () => {
  const c = await cfg();
  const r = await h.app.inject({ method: 'GET', url: `/zernio/callback/${channel.webhook_token}/estado-falso?accountId=acc_x&profileId=${c.profile_id}` });
  assert.equal(r.statusCode, 403);
  assert.equal((await cfg()).account_id, '');
});

t('retorno válido: guarda usuario, nombre y foto, deja el canal en línea y registra el webhook único de la plataforma', async () => {
  const c = await cfg();
  zer.accounts.set('acc_ig', { _id: 'acc_ig', platform: 'instagram', profileId: c.profile_id, username: 'hotel', displayName: 'Hotel Palmas', profilePicture: 'https://cdn.zernio.example/hotel.jpg', isActive: true });
  const url = `/zernio/callback/${channel.webhook_token}/${c.connect_state}?connected=instagram&accountId=acc_ig&profileId=${c.profile_id}&username=hotel`;
  const r = await h.app.inject({ method: 'GET', url });
  assert.equal(r.statusCode, 302, r.body);
  assert.match(String(r.headers.location), new RegExp(`/#/channel/${channel.id}$`));
  const saved = await cfg();
  assert.equal(saved.account_id, 'acc_ig');
  assert.equal(saved.username, 'hotel');
  assert.equal(saved.display_name, 'Hotel Palmas');
  assert.equal(saved.picture, 'https://cdn.zernio.example/hotel.jpg');
  assert.equal(saved.connect_state, '');
  assert.equal((await store.getChannel(channel.id))!.connection_state, 'open');
  assert.equal(zer.webhooks.length, 1);
  assert.equal(zer.webhooks[0].url, 'https://bot.test/zernio/events');
  assert.equal(zer.webhooks[0].secret, platformWebhookSecret());
  assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 403, 'el mismo estado no sirve dos veces');

  const status = await owner('GET', `/api/channels/${channel.id}/status`);
  assert.equal(status.json().state, 'open');
  assert.equal(status.json().details.username, 'hotel');
});

t('retorno de conexión: un enlace vencido o con otro perfil no sirve y el estado se consume igual', async () => {
  const connect = async () => {
    assert.equal((await owner('POST', `/api/channels/${channel.id}/zernio/connect`)).statusCode, 200);
    return (await cfg()).connect_state as string;
  };
  let state = await connect();
  const wrong = `/zernio/callback/${channel.webhook_token}/${state}?accountId=acc_intruso&profileId=prof_otro`;
  assert.equal((await h.app.inject({ method: 'GET', url: wrong })).statusCode, 302);
  assert.equal((await cfg()).account_id, 'acc_ig');
  assert.equal((await h.app.inject({ method: 'GET', url: wrong })).statusCode, 403, 'estado consumido');
  state = await connect();
  const old = `${(Date.now() - 31 * 60_000).toString(36)}.${state.split('.')[1]}`;
  await store.updateChannel(channel.id, { config: { ...(await cfg()), connect_state: old } });
  const r = await h.app.inject({ method: 'GET', url: `/zernio/callback/${channel.webhook_token}/${old}?accountId=acc_tarde&profileId=${(await cfg()).profile_id}` });
  assert.equal(r.statusCode, 302);
  assert.equal((await cfg()).account_id, 'acc_ig');
});

t('mensaje entrante por el webhook de la plataforma: el agente responde en el mismo hilo', async () => {
  const r = await deliver(event());
  assert.equal(r.statusCode, 200);
  await waitFor(() => sendsTo('conv_77').length >= 1, 15000);
  await h.idle();
  const sent = sendsTo('conv_77').at(-1)!;
  assert.equal(sent.body.accountId, 'acc_ig');
  assert.match(sent.body.message, /con gusto te ayudo/);
  const contact = (await pool.query(`SELECT k.push_name AS name FROM contacts k JOIN conversations c ON c.contact_id = k.id WHERE c.channel_id = $1`, [channel.id])).rows[0];
  assert.equal(contact.name, 'Ana');
});

t('entrega repetida del mismo mensaje no genera una segunda respuesta', async () => {
  const before = sendsTo('conv_77').length;
  assert.equal((await deliver(event())).statusCode, 200);
  await h.idle();
  await sleep(300);
  assert.equal(sendsTo('conv_77').length, before);
});

t('firma inválida o evento de una cuenta sin canal: no se procesa', async () => {
  const before = sendsTo('conv_78').length;
  assert.equal((await deliver(event({}, { conversationId: 'conv_78', platformMessageId: 'ig_2' }), 'otro-secreto')).statusCode, 401);
  assert.equal((await deliver(event({ account: { id: 'acc_desconocida' } }, { conversationId: 'conv_78', platformMessageId: 'ig_3' }))).statusCode, 200);
  await h.idle();
  await sleep(300);
  assert.equal(sendsTo('conv_78').length, before);
});

t('eco de una respuesta del agente no pausa la conversación', async () => {
  const sent = sendsTo('conv_77').at(-1)!;
  const raw = event({ event: 'message.sent' }, { direction: 'outgoing', platformMessageId: 'ig_echo_1', text: sent.body.message, sender: { id: 'hotel' } });
  assert.equal((await deliver(raw)).statusCode, 200);
  await h.idle();
  await sleep(300);
  const status = (await pool.query('SELECT status FROM conversations WHERE channel_id = $1', [channel.id])).rows[0]?.status;
  assert.equal(status, 'bot');
});

t('adjunto del cliente servido por Zernio (WhatsApp): se descarga con la llave de la plataforma', async () => {
  const raw = event({}, { platformMessageId: 'ig_doc_1', text: '', attachments: [{ type: 'file', mimeType: 'application/pdf', url: `${process.env.ZERNIO_API_URL}/whatsapp/media/9`, name: 'ine.pdf' }] });
  assert.equal((await deliver(raw)).statusCode, 200);
  await waitFor(() => reqs('/whatsapp/media/9').length >= 1, 10000);
  assert.equal(reqs('/whatsapp/media/9').at(-1)!.headers.authorization, `Bearer ${zer.key}`);
  await h.idle();
});

t('desconexión avisada por Zernio: el canal queda desconectado y se avisa al equipo', async () => {
  const raw = JSON.stringify({ id: 'evt_down', event: 'account.disconnected', account: { accountId: 'acc_ig', profileId: (await cfg()).profile_id, platform: 'instagram', username: 'hotel', disconnectionType: 'unintentional', reason: 'Token expired' }, timestamp: new Date().toISOString() });
  assert.equal((await deliver(raw)).statusCode, 200);
  await waitFor(async () => (await store.getChannel(channel.id))!.connection_state === 'close', 5000);
  const n = await pool.query(`SELECT title FROM notifications WHERE account_id = $1 AND title LIKE '%red social%'`, [h.accountId]);
  assert.ok(n.rows.length >= 1, 'aviso de desconexión');
  const reconnect = JSON.stringify({ id: 'evt_up', event: 'account.connected', account: { accountId: 'acc_ig', platform: 'instagram' } });
  assert.equal((await deliver(reconnect)).statusCode, 200);
  await waitFor(async () => (await store.getChannel(channel.id))!.connection_state === 'open', 5000);
});

t('ventana de 24 h: fuera de ella no se escribe por Zernio', async () => {
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE c.channel_id = $1 AND k.external_id = 'conv_77'`,
    [channel.id],
  );
  const convId = rows[0].id as string;
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

t('cambiar de red con la cuenta conectada no se permite; desconectar la quita en Zernio y limpia el canal', async () => {
  const change = await owner('PUT', `/api/channels/${channel.id}`, { config: { platform: 'facebook' } });
  assert.equal(change.statusCode, 400);
  const r = await owner('POST', `/api/channels/${channel.id}/zernio/disconnect`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(zer.accounts.has('acc_ig'), false);
  const c = await cfg();
  assert.equal(c.account_id, '');
  assert.equal(c.username, '');
  assert.equal((await store.getChannel(channel.id))!.connection_state, 'close');
  assert.equal((await owner('PUT', `/api/channels/${channel.id}`, { config: { platform: 'facebook' } })).statusCode, 200);
});

t('Telegram: código en el panel; mientras no llega al bot queda pendiente y luego se conecta solo', async () => {
  const ch = (await owner('POST', '/api/channels', { type: 'zernio', name: 'Telegram', config: { platform: 'telegram' } })).json();
  const r = await owner('POST', `/api/channels/${ch.id}/zernio/connect`);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.kind, 'code');
  assert.match(body.code, /^ZRN-/);
  assert.equal(body.botUsername, 'ZernioConnectBot');
  assert.equal((await owner('POST', `/api/channels/${ch.id}/zernio/telegram-check`)).json().status, 'pending');
  zer.telegram.get(body.code)!.status = 'connected';
  const done = await owner('POST', `/api/channels/${ch.id}/zernio/telegram-check`);
  assert.equal(done.json().status, 'connected');
  const c = await cfg(ch.id);
  assert.match(c.account_id, /^acc_/);
  assert.equal(c.username, 'hotel_bot');
  assert.equal(c.telegram_code, '');
  assert.equal((await store.getChannel(ch.id))!.connection_state, 'open');
  assert.equal(zer.profiles.filter((p) => p.externalId === h.accountId).length, 1, 'el mismo perfil del negocio');
});

t('Bluesky: usuario y contraseña de aplicación en el panel; una contraseña mala no conecta', async () => {
  const ch = (await owner('POST', '/api/channels', { type: 'zernio', name: 'Bluesky', config: { platform: 'bluesky' } })).json();
  assert.equal((await owner('POST', `/api/channels/${ch.id}/zernio/connect`, {})).statusCode, 400);
  const bad = await owner('POST', `/api/channels/${ch.id}/zernio/connect`, { identifier: 'hotel.bsky.social', app_password: 'mala' });
  assert.equal(bad.statusCode, 400);
  assert.equal((await cfg(ch.id)).account_id, '');
  const good = await owner('POST', `/api/channels/${ch.id}/zernio/connect`, { identifier: 'hotel.bsky.social', app_password: 'abcd-efgh-ijkl-mnop' });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().kind, 'connected');
  assert.equal(good.json().channel.config.username, 'hotel.bsky.social');
  const creds = reqs('/connect/bluesky/credentials').at(-1)!;
  assert.equal(creds.body.state, `user_1-${(await cfg(ch.id)).profile_id}`);
  assert.equal(JSON.stringify(await cfg(ch.id)).includes('abcd-efgh'), false, 'la contraseña de aplicación no se guarda');
});

t('canales anteriores: el webhook propio del canal con su secreto sigue funcionando (formato con payload)', async () => {
  const legacy = await h.authed('POST', '/api/channels', {
    account_id: h.accountId, type: 'zernio', name: 'Zernio anterior', chatbot_id: h.botId,
    config: { platform: 'reddit', profile_id: 'prof_viejo', account_id: 'acc_vieja', api_key: 'zk_test', webhook_secret: 'secreto-viejo' },
  });
  assert.equal(legacy.statusCode, 200, legacy.body);
  const ch = legacy.json();
  const raw = JSON.stringify({ event: 'message.received', payload: { accountId: 'acc_vieja', conversationId: 'conv_rd', message: { id: 'rd_1', text: 'Hola' }, sender: { name: 'Luis' } } });
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${ch.webhook_token}`, headers: { 'content-type': 'application/json', 'x-zernio-signature': sign(raw, 'secreto-viejo') }, payload: raw });
  assert.equal(r.statusCode, 200);
  await waitFor(() => sendsTo('conv_rd').length >= 1, 15000);
  assert.equal(sendsTo('conv_rd').at(-1)!.headers.authorization, 'Bearer zk_test', 'usa su propia llave');
  await h.idle();
});

t('convive con el WhatsApp por QR: el aviso al encargado sigue saliendo por la cuenta de WhatsApp', async () => {
  const zernioChannel = await store.getChannel(channel.id);
  h.reset();
  await h.service.transportFor(zernioChannel!, { phone: '', external_id: 'conv_77' } as any).notify('5215599990000', 'Transferencia: revisar a Ana');
  assert.ok(h.sent.some((s) => s.kind === 'text' && s.to === '5215599990000' && s.text.includes('Transferencia')), JSON.stringify(h.sent));
});
