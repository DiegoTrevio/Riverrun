/**
 * Cada negocio registra sus redes desde su cuenta: Facebook e Instagram con el botón «Conectar con Facebook» (app de Meta
 * de la plataforma, sin copiar tokens; un solo webhook para todos) y las demás redes por Zernio, con un perfil de Zernio
 * que se crea al dar de alta la cuenta.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, metaFake, pool, sleep, store, waitFor, zer } from './harness.js';
// Después del arnés (que define las variables de entorno con await de nivel superior).
const { checkMetaTokens } = await import('../src/channels/meta-connect.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let sessionId = '';

const reqs = (fragment: string) => ext.requests.filter((r) => r.path.includes(fragment));
const sign = (raw: string, secret = 'meta-app-secret-pruebas') => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const deliver = (raw: string, secret?: string) =>
  h.app.inject({ method: 'POST', url: '/meta/webhook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, secret) }, payload: raw });
const dm = (object: 'page' | 'instagram', ownId: string, from: string, text: string) => JSON.stringify({
  object, entry: [{ id: ownId, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: ownId }, timestamp: Date.now(), message: { mid: `mid.${crypto.randomUUID()}`, text } }] }],
});
const metaChannels = async (accountId = h.accountId) =>
  (await pool.query(`SELECT id, type, config, connection_state, disconnect_reason FROM channels WHERE account_id = $1 AND type IN ('messenger','instagram') ORDER BY type`, [accountId])).rows;

/** Pulsa el botón (el navegador recibe la cookie del nonce) y devuelve el estado de Facebook y esa cookie. */
async function startConnect(as: (m: string, u: string, p?: unknown) => Promise<any> = owner, body: Record<string, unknown> = { chatbot_id: h.botId }) {
  const r = await as('POST', '/api/meta/connect', body);
  assert.equal(r.statusCode, 200, r.body);
  const url = new URL(r.json().url);
  assert.equal(url.searchParams.get('client_id'), 'meta-app-pruebas');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://bot.test/meta/callback');
  const cookie = String(r.headers['set-cookie']).match(/meta_nonce=[^;]+/)?.[0] ?? '';
  assert.ok(cookie, 'la conexión deja una cookie del navegador');
  return { state: url.searchParams.get('state')!, cookie };
}
const callback = (state: string, cookie = '') =>
  h.app.inject({ method: 'GET', url: `/meta/callback?code=abc&state=${state}`, headers: cookie ? { cookie } : {} });

/** Pulsa el botón y vuelve de Facebook en el mismo navegador; devuelve la sesión para elegir páginas. */
async function connectWithFacebook(as: (m: string, u: string, p?: unknown) => Promise<any> = owner, body: Record<string, unknown> = { chatbot_id: h.botId }) {
  const { state, cookie } = await startConnect(as, body);
  const back = await callback(state, cookie);
  assert.equal(back.statusCode, 302);
  const m = String(back.headers.location).match(/#\/conectar-facebook\/([0-9a-f-]{36})\?account_id=([0-9a-f-]{36})$/);
  assert.ok(m, String(back.headers.location));
  return { id: m[1], accountId: m[2], state, cookie };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola, con gusto te ayudo'] }));
  const u = await h.addUser({ account_id: h.accountId, email: 'dueno@facebook.mx', name: 'Dueño', password: 'Pz-125-Qx-325-Kv', role: 'admin' });
  await pool.query('UPDATE users SET email_verified_at = now() WHERE email = $1', ['dueno@facebook.mx']);
  owner = await h.loginAs('dueno@facebook.mx', 'Pz-125-Qx-325-Kv');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el panel sabe que Facebook se conecta con el botón', async () => {
  const meta = (await owner('GET', '/api/meta')).json();
  assert.equal(meta.meta_connect_enabled, true);
});

t('Conectar con Facebook: inicio de sesión, regreso con las páginas (sin tokens) y el enlace es de un solo uso', async () => {
  ext.requests.length = 0;
  const s = await connectWithFacebook();
  sessionId = s.id;
  // Código → token corto → token de larga duración → páginas con sus tokens.
  assert.equal(reqs('/oauth/access_token').length, 2);
  assert.equal(reqs('/me/accounts')[0].query.get('access_token'), 'long_short_user_tok');
  const session = await owner('GET', `/api/meta/sessions/${sessionId}`);
  assert.equal(session.statusCode, 200, session.body);
  assert.doesNotMatch(session.body, /page_tok/, 'los tokens de las páginas nunca llegan al navegador');
  const pages = session.json().pages;
  assert.deepEqual(pages.map((p: any) => p.name), ['Hotel Palmas', 'Spa Palmas']);
  assert.deepEqual(pages[0].instagram, { id: 'IG1', username: 'hotelpalmas', picture: 'https://img.test/ig1.jpg', connected: false });
  assert.equal(pages[1].instagram, null);
  assert.equal(s.accountId, h.accountId, 'el regreso indica la cuenta (el superadministrador vuelve a la misma)');
  // El mismo regreso no se puede usar dos veces.
  const again = await callback(s.state, s.cookie);
  assert.match(String(again.headers.location), /#\/conectar-facebook\?error=/);
  // Cancelar en Facebook vuelve con un mensaje fijo: el texto de la URL no se muestra.
  const cancel = await h.app.inject({ method: 'GET', url: '/meta/callback?error=access_denied&error_description=Llama%20al%20555' });
  assert.match(decodeURIComponent(String(cancel.headers.location)), /error=Se canceló la conexión/);
  assert.doesNotMatch(decodeURIComponent(String(cancel.headers.location)), /555/);
});

t('un enlace de conexión ajeno no captura las páginas de quien lo abre (sin la cookie del navegador que lo inició)', async () => {
  const attacker = await startConnect();
  const before = (await pool.query('SELECT count(*)::int AS n FROM meta_connect_sessions WHERE jsonb_array_length(pages) > 0')).rows[0].n;
  // La víctima abre el enlace en su navegador: no tiene la cookie, o tiene la de otra conexión suya.
  const victim = await startConnect();
  for (const cookie of ['', victim.cookie]) {
    const r = await callback(attacker.state, cookie);
    assert.match(String(r.headers.location), /#\/conectar-facebook\?error=/);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_connect_sessions WHERE jsonb_array_length(pages) > 0')).rows[0].n, before, 'no se guardaron páginas');
});

t('otro negocio no puede ver ni usar la sesión', async () => {
  const other = (await h.authed('POST', '/api/accounts', { name: 'Otro negocio' })).json();
  assert.ok(other.id);
  const r = await h.authed('GET', `/api/meta/sessions/${sessionId}?account_id=${other.id}`);
  assert.equal(r.statusCode, 404);
});

t('elegir páginas: Messenger e Instagram quedan conectados al agente, suscritos y en línea', async () => {
  ext.requests.length = 0;
  const r = await owner('POST', `/api/meta/sessions/${sessionId}/apply`, { pages: [{ page_id: 'PAGE1', messenger: true, instagram: true }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.doesNotMatch(r.body, /page_tok/);
  assert.deepEqual(r.json().channels.map((c: any) => c.type).sort(), ['instagram', 'messenger']);
  const sub = reqs('/PAGE1/subscribed_apps');
  assert.equal(sub.length, 1);
  assert.equal(sub[0].query.get('access_token'), 'page_tok_1');
  assert.equal(sub[0].query.get('subscribed_fields'), 'messages,messaging_postbacks,message_echoes');
  const [ig, fb] = await metaChannels();
  for (const c of [ig, fb]) {
    assert.equal(c.config.connected_via, 'facebook');
    assert.equal(c.connection_state, 'open');
    assert.equal((await store.getChannel(c.id))!.chatbot_id, h.botId);
  }
  assert.equal(fb.config.page_id, 'PAGE1');
  assert.equal(ig.config.account_id, 'IG1');
  assert.equal(ig.config.username, 'hotelpalmas');
  // La sesión se consume.
  assert.equal((await owner('GET', `/api/meta/sessions/${sessionId}`)).statusCode, 404);
});

t('volver a conectar renueva el token sin duplicar canales, aunque se pulse dos veces', async () => {
  const s = await connectWithFacebook();
  const session = (await owner('GET', `/api/meta/sessions/${s.id}`)).json();
  assert.equal(session.pages[0].messenger_connected, true);
  assert.equal(session.pages[0].instagram.connected, true);
  const body = { pages: [{ page_id: 'PAGE1', messenger: true, instagram: true }] };
  const [a, b] = await Promise.all([owner('POST', `/api/meta/sessions/${s.id}/apply`, body), owner('POST', `/api/meta/sessions/${s.id}/apply`, body)]);
  // Una gana; la otra se rechaza: 400 si llegó mientras se aplicaba, 404 si la sesión ya se había consumido.
  const codes = [a.statusCode, b.statusCode].sort();
  assert.equal(codes[0], 200, a.body + b.body);
  assert.ok([400, 404].includes(codes[1]), a.body + b.body);
  assert.equal((await metaChannels()).length, 2);
});

t('si falla la suscripción en Meta, la sesión sigue disponible para reintentar', async () => {
  const s = await connectWithFacebook();
  ext.fail.add('/PAGE2/subscribed_apps');
  try {
    const r = await owner('POST', `/api/meta/sessions/${s.id}/apply`, { pages: [{ page_id: 'PAGE2', messenger: true, instagram: false }] });
    assert.equal(r.statusCode, 400);
  } finally { ext.fail.delete('/PAGE2/subscribed_apps'); }
  assert.equal((await owner('GET', `/api/meta/sessions/${s.id}`)).statusCode, 200);
  assert.equal((await owner('POST', `/api/meta/sessions/${s.id}/apply`, { pages: [{ page_id: 'PAGE2', messenger: true, instagram: false }] })).statusCode, 200);
  // Se quita para que el resto de las pruebas trabaje solo con PAGE1.
  const spa = (await metaChannels()).find((c) => c.config.page_id === 'PAGE2' && c.type === 'messenger');
  await pool.query('DELETE FROM channels WHERE id = $1', [spa.id]);
});

t('la misma página no se conecta en dos negocios (ambos agentes contestarían)', async () => {
  const other = (await h.authed('POST', '/api/accounts', { name: 'Negocio ajeno' })).json();
  const { id } = await connectWithFacebook(h.authed, { account_id: other.id });
  const apply = await h.authed('POST', `/api/meta/sessions/${id}/apply?account_id=${other.id}`, { pages: [{ page_id: 'PAGE1', messenger: true, instagram: false }] });
  assert.equal(apply.statusCode, 400);
  assert.match(apply.json().error, /ya está conectado en otra cuenta/);
  assert.equal((await metaChannels(other.id)).length, 0);
});

t('webhook de la plataforma: Meta lo verifica con el token y solo acepta eventos firmados con la app', async () => {
  const okv = await h.app.inject({ method: 'GET', url: '/meta/webhook?hub.mode=subscribe&hub.verify_token=verificacion-meta-pruebas&hub.challenge=CH9' });
  assert.equal(okv.statusCode, 200);
  assert.equal(okv.body, 'CH9');
  assert.equal((await h.app.inject({ method: 'GET', url: '/meta/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=CH9' })).statusCode, 403);
  const body = dm('page', 'PAGE1', 'PSID9', 'hola');
  assert.equal((await h.app.inject({ method: 'POST', url: '/meta/webhook', headers: { 'content-type': 'application/json' }, payload: body })).statusCode, 401);
  assert.equal((await deliver(body, 'otra-clave')).statusCode, 401);
});

t('mensajes de Messenger e Instagram llegan al canal de su página y el agente contesta', async () => {
  ext.requests.length = 0;
  assert.equal((await deliver(dm('page', 'PAGE1', 'PSID1', '¿tienen habitaciones?'))).statusCode, 200);
  assert.equal((await deliver(dm('instagram', 'IG1', 'IGU1', 'hola desde insta'))).statusCode, 200);
  // Una página que no es de nadie se acepta (Meta no reintenta) y no hace nada.
  assert.equal((await deliver(dm('page', 'PAGE_AJENA', 'PSID2', 'hola'))).statusCode, 200);
  await waitFor(() => reqs('/me/messages').filter((x) => x.body?.message?.text).length >= 2, 15000);
  const replies = reqs('/me/messages').filter((x) => x.body?.message?.text);
  assert.deepEqual(replies.map((x) => x.body.recipient.id).sort(), ['IGU1', 'PSID1']);
  assert.ok(replies.every((x) => x.query.get('access_token') === 'page_tok_1'));
  await h.idle();
  const convs = (await pool.query(`SELECT c.type FROM conversations v JOIN channels c ON c.id = v.channel_id WHERE c.account_id = $1 AND c.type IN ('messenger','instagram')`, [h.accountId])).rows;
  assert.deepEqual(convs.map((r) => r.type).sort(), ['instagram', 'messenger']);
});

t('auditoría S1: otro negocio no puede apartar ni recibir la página de Facebook o el Instagram de este', async () => {
  const rival = (await h.authed('POST', '/api/accounts', { name: 'Negocio rival' })).json();
  await h.addUser({ account_id: rival.id, email: 'rival@otro.mx', name: 'Rival', password: 'Pz-142-Qx-342-Kv', role: 'admin' });
  const as = await h.loginAs('rival@otro.mx', 'Pz-142-Qx-342-Kv');
  // Crea canales manuales con la página y el Instagram del hotel, y escribe a mano que se conectaron con el botón.
  const fake = { connected_via: 'facebook', meta_connected_at: '2026-01-01T00:00:00Z', page_id: 'PAGE1', page_access_token: 'tok-falso', app_secret: 's', verify_token: 'v' };
  const m = await as('POST', '/api/channels', { type: 'messenger', name: 'Mi Messenger', config: fake });
  assert.equal(m.statusCode, 200, m.body);
  const ig = await as('POST', '/api/channels', { type: 'instagram', name: 'Mi Instagram', config: { ...fake, account_id: 'IG1' } });
  assert.equal(ig.statusCode, 200, ig.body);
  // Y lo intenta también editando.
  assert.equal((await as('PUT', `/api/channels/${m.json().id}`, { config: { connected_via: 'facebook', meta_connected_at: 'x' } })).statusCode, 200);
  for (const c of await metaChannels(rival.id)) {
    assert.equal(c.config.connected_via, 'manual', 'el panel no marca un canal como conectado con el botón');
    assert.equal(c.config.meta_connected_at, '');
  }
  // Los eventos de Meta de esa página siguen llegando solo al hotel.
  await deliver(dm('page', 'PAGE1', 'PSID_S1', 'mensaje para el hotel'));
  await deliver(dm('instagram', 'IG1', 'IGU_S1', 'mensaje para el hotel por insta'));
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE external_id IN ('PSID_S1', 'IGU_S1')`)).rows[0].n === 2, 15000);
  const owners = (await pool.query(`SELECT DISTINCT k.account_id FROM contacts k WHERE k.external_id IN ('PSID_S1', 'IGU_S1')`)).rows.map((r) => r.account_id);
  assert.deepEqual(owners, [h.accountId]);
  await h.idle();
  // Un canal conectado con el botón no cambia de página desde el panel.
  const fb = (await metaChannels()).find((c) => c.type === 'messenger');
  assert.equal((await owner('PUT', `/api/channels/${fb.id}`, { config: { page_id: 'OTRA_PAGINA', page_access_token: 'otro' } })).statusCode, 200);
  const after = (await store.getChannel(fb.id))!.config;
  assert.equal(after.page_id, 'PAGE1');
  assert.equal(after.page_access_token, 'page_tok_1');
});

t('auditoría S1: un canal que ya decía «conectado» antes de la marca solo recibe eventos si Meta confirma que su token es de esa página', async () => {
  const { verifyPendingMetaChannels } = await import('../src/channels/meta-connect.js');
  const legacy = (await h.authed('POST', '/api/accounts', { name: 'Negocio de antes' })).json();
  // Como los dejaría la migración 084: marcados «conectados» pero sin evidencia, pendientes de verificar.
  const mk = async (type: string, cfg: Record<string, unknown>) => (await pool.query(
    `INSERT INTO channels (account_id, type, name, webhook_token, config) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [legacy.id, type, `Canal ${type}`, `tok-${crypto.randomUUID()}`, JSON.stringify({ connected_via: 'facebook', meta_verify: 'pending', page_access_token: 'page_tok_2', ...cfg })])).rows[0].id;
  metaFake.pages.push({ id: 'PAGE7', name: 'Café Siete', access_token: 'page_tok_7', picture: { data: { url: 'https://img.test/p7.jpg' } }, instagram_business_account: { id: 'IG7', username: 'cafesiete', profile_picture_url: '' } });
  try {
    const real = await mk('messenger', { page_id: 'PAGE7', page_access_token: 'page_tok_7' });
    const realIg = await mk('instagram', { page_id: 'PAGE7', account_id: 'IG7', page_access_token: 'page_tok_7' });
    const forged = await mk('messenger', { page_id: 'PAGE_AJENA_9', page_access_token: 'tok-falso' });
    const forgedIg = await mk('instagram', { page_id: 'PAGE7', account_id: 'IG_AJENO', page_access_token: 'page_tok_7' });
    metaFake.revoked.add('tok-falso');
    // Mientras está pendiente no recibe nada.
    await deliver(dm('page', 'PAGE7', 'PSID_P7', 'hola café'));
    await h.idle();
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE external_id = 'PSID_P7'`)).rows[0].n, 0);
    const r = await verifyPendingMetaChannels();
    assert.deepEqual(r, { verified: 2, dropped: 2 });
    const cfg = async (id: string) => (await store.getChannel(id))!.config;
    for (const id of [real, realIg]) {
      const c = await cfg(id);
      assert.equal(c.connected_via, 'facebook');
      assert.ok(c.meta_connected_at);
      assert.equal(c.meta_verify, '');
    }
    for (const id of [forged, forgedIg]) {
      const c = await cfg(id);
      assert.equal(c.connected_via, 'manual');
      assert.equal(c.page_access_token, '');
    }
    await deliver(dm('page', 'PAGE7', 'PSID_P7', 'hola café'));
    await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE external_id = 'PSID_P7'`)).rows[0].n === 1, 15000);
    await h.idle();
  } finally {
    metaFake.pages.pop();
    metaFake.revoked.delete('tok-falso');
    // Las pruebas siguientes cuentan los canales de Facebook del hotel: este negocio no debe interferir.
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [legacy.id]);
  }
});

t('si Facebook retira el permiso, el canal queda desconectado y el negocio recibe el aviso', async () => {
  metaFake.revoked.add('page_tok_1');
  const r = await checkMetaTokens();
  assert.equal(r.lost, 2);
  const [ig, fb] = await metaChannels();
  assert.equal(fb.connection_state, 'close');
  assert.equal(fb.disconnect_reason, 'token_revoked');
  assert.equal(ig.connection_state, 'close');
  const notes = (await pool.query(`SELECT title, body FROM notifications WHERE account_id = $1 AND title LIKE 'Tu % se desconectó%'`, [h.accountId])).rows;
  assert.ok(notes.some((n) => n.title.startsWith('Tu Messenger se desconectó') && /retiró el permiso/.test(n.body) && /Conectar con Facebook/.test(n.body)), JSON.stringify(notes));
  assert.ok(notes.some((n) => n.title.startsWith('Tu Instagram se desconectó')));
  // Volver a conectar con un token nuevo lo deja en línea.
  metaFake.revoked.clear();
  metaFake.pages[0].access_token = 'page_tok_1b';
  const s = await connectWithFacebook();
  assert.equal((await owner('POST', `/api/meta/sessions/${s.id}/apply`, { pages: [{ page_id: 'PAGE1', messenger: true, instagram: true }] })).statusCode, 200);
  for (const c of await metaChannels()) {
    assert.equal(c.connection_state, 'open');
    assert.equal((await store.getChannel(c.id))!.config.page_access_token, 'page_tok_1b');
  }
});

t('desconectar desde el panel borra el token; la suscripción de la página se quita con el último canal que la usa', async () => {
  const [ig, fb] = await metaChannels();
  ext.requests.length = 0;
  const r = await owner('POST', `/api/channels/${fb.id}/meta/disconnect`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(reqs('/PAGE1/subscribed_apps').filter((x) => x.method === 'DELETE').length, 0, 'el Instagram de la página sigue usándola');
  const ch = (await store.getChannel(fb.id))!;
  assert.equal(ch.config.page_access_token, '');
  assert.equal(ch.connection_state, 'close');
  // Ya no se revisa ni recibe eventos: solo queda el Instagram.
  assert.equal((await checkMetaTokens()).checked, 1);
  assert.equal((await store.getChannel(ig.id))!.connection_state, 'open');
  assert.equal((await owner('POST', `/api/channels/${ig.id}/meta/disconnect`)).statusCode, 200);
  assert.equal(reqs('/PAGE1/subscribed_apps').filter((x) => x.method === 'DELETE').length, 1);
});

t('Zernio: el perfil del negocio se crea al conectar su primera red (no al darse de alta), una sola vez', async () => {
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Florería Luna' })).json();
  const profileOf = async () => (await pool.query('SELECT zernio_profile_id FROM accounts WHERE id = $1', [acc.id])).rows[0].zernio_profile_id;
  await sleep(300);
  assert.equal(await profileOf(), '', 'darse de alta no crea nada en Zernio');
  assert.equal(zer.profiles.filter((p) => p.externalId === acc.id).length, 0);
  const created = await h.authed('POST', '/api/channels', { account_id: acc.id, type: 'zernio', name: 'X del negocio', config: { platform: 'twitter' } });
  assert.equal(created.statusCode, 200, created.body);
  const ch = created.json();
  const c = await h.authed('POST', `/api/channels/${ch.id}/zernio/connect`, {});
  assert.equal(c.statusCode, 200, c.body);
  const profileId = await profileOf();
  assert.ok(profileId);
  assert.equal((await store.getChannel(ch.id))!.config.profile_id, profileId);
  assert.equal((await pool.query('SELECT account_id FROM zernio_profiles WHERE profile_id = $1', [profileId])).rows[0].account_id, acc.id);
  // Otra conexión (aunque se haya perdido el dato local) reutiliza el mismo perfil: Zernio lo encuentra por externalId.
  await pool.query(`UPDATE accounts SET zernio_profile_id = '' WHERE id = $1`, [acc.id]);
  await pool.query(`UPDATE channels SET config = config || '{"profile_id":""}'::jsonb WHERE id = $1`, [ch.id]);
  assert.equal((await h.authed('POST', `/api/channels/${ch.id}/zernio/connect`, {})).statusCode, 200);
  assert.equal(await profileOf(), profileId);
  assert.equal(zer.profiles.filter((p) => p.externalId === acc.id).length, 1);
});

t('primeros pasos: «Redes» es opcional y queda hecho al conectar una red', async () => {
  const ob = (await owner('GET', '/api/onboarding')).json();
  assert.equal(ob.steps.networks, false, 'ya no queda ninguna red conectada');
  await pool.query(`UPDATE channels SET connection_state = 'open' WHERE account_id = $1 AND type = 'instagram'`, [h.accountId]);
  assert.equal((await owner('GET', '/api/onboarding')).json().steps.networks, true, 'una red conectada completa el paso');
  const luna = (await pool.query(`SELECT id FROM accounts WHERE name = 'Florería Luna'`)).rows[0].id;
  const acc = (await h.authed('GET', `/api/onboarding?account_id=${luna}`)).json();
  assert.equal(acc.steps.networks, false);
  assert.equal((await owner('POST', '/api/onboarding/step', { step: 'networks' })).statusCode, 200);
});
