/**
 * Separación entre negocios con una sola llave de Zernio: cada negocio solo puede conectar cuentas de SU perfil, una
 * cuenta vive en un solo canal, los eventos solo llegan al canal del perfil correcto y el negocio nunca ve los ids.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool, store, zer } from './harness.js';
// Después del arnés (que define las variables de entorno con await de nivel superior).
const { platformWebhookSecret } = await import('../src/channels/zernio.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let otherAccount: string;

const cfg = async (id: string) => (await store.getChannel(id))!.config;
/** Pide la conexión (crea el perfil del negocio) y devuelve el estado de un solo uso. */
const connect = async (as: typeof owner, id: string) => {
  const r = await as('POST', `/api/channels/${id}/zernio/connect`);
  assert.equal(r.statusCode, 200, r.body);
  return cfg(id);
};
/** Lo que Zernio devuelve al terminar la autorización (cualquiera puede armar esta dirección). */
const callback = (channel: any, state: string, accountId: string) =>
  h.app.inject({ method: 'GET', url: `/zernio/callback/${channel.webhook_token}/${state}?connected=instagram&accountId=${accountId}&username=x` });
const deliver = (body: unknown) => {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', platformWebhookSecret()).update(raw).digest('hex');
  return h.app.inject({ method: 'POST', url: '/zernio/events', headers: { 'content-type': 'application/json', 'x-zernio-signature': sig }, payload: raw });
};
const zAccount = (id: string, profileId: string, platform = 'instagram') =>
  zer.accounts.set(id, { _id: id, platform, profileId, username: id, displayName: `Cuenta ${id}`, profilePicture: '', isActive: true });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola'] }));
  await h.addUser({ account_id: h.accountId, email: 'duena@palmas.mx', name: 'Dueña', password: 'Pz-138-Qx-338-Kv', role: 'admin' });
  await pool.query('UPDATE users SET email_verified_at = now()');
  owner = await h.loginAs('duena@palmas.mx', 'Pz-138-Qx-338-Kv');
  otherAccount = (await h.authed('POST', '/api/accounts', { name: 'Otro negocio' })).json().id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('un negocio no puede quedarse con la cuenta de Zernio de otro armando el retorno a mano', async () => {
  // El otro negocio conecta su Instagram de verdad.
  const theirs = (await h.authed('POST', '/api/channels', { account_id: otherAccount, type: 'zernio', name: 'IG ajeno', config: { platform: 'instagram' } })).json();
  const tc = await connect(h.authed, theirs.id);
  zAccount('acc_ajena', tc.profile_id);
  assert.equal((await callback(theirs, tc.connect_state, 'acc_ajena')).statusCode, 302);
  assert.equal((await cfg(theirs.id)).account_id, 'acc_ajena');

  // Este negocio pide su propia conexión y vuelve con la cuenta del otro.
  const mine = (await owner('POST', '/api/channels', { type: 'zernio', name: 'Mi IG', chatbot_id: h.botId, config: { platform: 'instagram' } })).json();
  const mc = await connect(owner, mine.id);
  assert.notEqual(mc.profile_id, tc.profile_id, 'cada negocio tiene su perfil');
  const r = await callback(mine, mc.connect_state, 'acc_ajena');
  assert.equal(r.statusCode, 302);
  assert.match(String(r.headers.location), /\?zernio=not_yours$/);
  assert.equal((await cfg(mine.id)).account_id, '', 'no se guarda la cuenta ajena');
  assert.equal((await cfg(theirs.id)).account_id, 'acc_ajena', 'el otro negocio la conserva');
  const log = await pool.query(`SELECT 1 FROM event_logs WHERE channel_id = $1 AND message LIKE 'Zernio: la cuenta devuelta no pertenece%'`, [mine.id]);
  assert.equal(log.rowCount, 1);

  // Una cuenta de su perfil pero de otra red tampoco sirve.
  const st = (await connect(owner, mine.id)).connect_state;
  zAccount('acc_fb_propia', mc.profile_id, 'facebook');
  assert.match(String((await callback(mine, st, 'acc_fb_propia')).headers.location), /zernio=not_yours/);
});

t('una cuenta solo puede estar en una conexión; el retorno con error de Zernio no conecta nada', async () => {
  const a = (await owner('POST', '/api/channels', { type: 'zernio', name: 'IG uno', config: { platform: 'instagram' } })).json();
  const b = (await owner('POST', '/api/channels', { type: 'zernio', name: 'IG dos', config: { platform: 'instagram' } })).json();
  const ac = await connect(owner, a.id);
  zAccount('acc_unica', ac.profile_id);
  assert.equal((await callback(a, ac.connect_state, 'acc_unica')).statusCode, 302);
  assert.equal((await cfg(a.id)).account_id, 'acc_unica');
  const bc = await connect(owner, b.id);
  const r = await callback(b, bc.connect_state, 'acc_unica');
  assert.match(String(r.headers.location), /\?zernio=in_use$/);
  assert.equal((await cfg(b.id)).account_id, '');
  // El índice también lo impide en la base, por cualquier otra vía.
  await assert.rejects(pool.query(`UPDATE channels SET config = config || '{"account_id":"acc_unica"}'::jsonb WHERE id = $1`, [b.id]), /channels_zernio_account_idx/);

  const st = (await connect(owner, b.id)).connect_state;
  const cancelled = await h.app.inject({ method: 'GET', url: `/zernio/callback/${b.webhook_token}/${st}?error=access_denied&is_user_fixable=true` });
  assert.match(String(cancelled.headers.location), /\?zernio=cancelled$/);
  assert.equal((await cfg(b.id)).account_id, '');
});

t('el negocio y sus agentes no ven el perfil ni la cuenta de Zernio; nadie los escribe desde el panel', async () => {
  const c = (await owner('POST', '/api/channels', { type: 'zernio', name: 'IG visible', config: { platform: 'instagram' } })).json();
  const cc = await connect(owner, c.id);
  zAccount('acc_visible', cc.profile_id);
  await callback(c, cc.connect_state, 'acc_visible');

  const mine = (await owner('GET', `/api/channels/${c.id}`)).json();
  assert.equal(mine.config.connected, true);
  assert.equal(mine.config.profile_id, undefined);
  assert.equal(mine.config.account_id, undefined);
  const listed = (await owner('GET', '/api/channels')).json().find((x: any) => x.id === c.id);
  assert.equal(listed.config.account_id, undefined);
  const sup = (await h.authed('GET', `/api/channels/${c.id}`)).json();
  assert.equal(sup.config.account_id, 'acc_visible', 'el superadmin sí los ve');

  // Ni el superadmin puede cambiar perfil o cuenta desde el formulario: solo el flujo de conexión.
  assert.equal((await h.authed('PUT', `/api/channels/${c.id}`, { config: { platform: 'instagram', profile_id: 'prof_x', account_id: 'acc_x' } })).statusCode, 200);
  const after = await cfg(c.id);
  assert.equal(after.account_id, 'acc_visible');
  assert.equal(after.profile_id, cc.profile_id);
});

t('un evento solo llega al canal del perfil que dice el evento', async () => {
  const c = (await owner('POST', '/api/channels', { type: 'zernio', name: 'IG eventos', chatbot_id: h.botId, config: { platform: 'instagram' } })).json();
  const cc = await connect(owner, c.id);
  zAccount('acc_eventos', cc.profile_id);
  await callback(c, cc.connect_state, 'acc_eventos');
  const event = (profileId: string, conv: string) => ({
    id: `evt_${crypto.randomUUID()}`, event: 'message.received',
    message: { id: `zm_${crypto.randomUUID()}`, conversationId: conv, platformMessageId: `ig_${conv}`, direction: 'incoming', text: 'Hola', sender: { name: 'Ana' }, sentAt: new Date().toISOString() },
    conversation: { id: conv }, account: { id: 'acc_eventos', profileId, platform: 'instagram' },
  });
  const contacts = async (conv: string) => (await pool.query(`SELECT 1 FROM contacts WHERE external_id = $1`, [conv])).rowCount;
  assert.equal((await deliver(event('prof_de_otro', 'conv_ajena'))).statusCode, 200);
  await h.idle();
  assert.equal(await contacts('conv_ajena'), 0, 'evento de otro perfil: se ignora');
  assert.equal((await deliver(event(cc.profile_id, 'conv_propia'))).statusCode, 200);
  await h.idle();
  assert.equal(await contacts('conv_propia'), 1);
});
