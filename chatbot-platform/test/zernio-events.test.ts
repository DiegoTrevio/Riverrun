/**
 * Eventos de Zernio con una sola llave para todos los negocios: cada evento cuenta una sola vez, los viejos no se
 * aceptan, lo que no es un mensaje se procesa en una cola (conexión, entregado, leído, fallido), las cuentas conectadas
 * desde Zernio se adoptan por su perfil, y al borrar un negocio sus redes y su perfil se quitan de Zernio.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, pool, store, waitFor, zer } from './harness.js';
// Después del arnés (que define las variables de entorno con await de nivel superior).
const { platformWebhookSecret } = await import('../src/channels/zernio.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let channel: any;
let profileId = '';

const deliver = (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', platformWebhookSecret()).update(raw).digest('hex');
  return h.app.inject({ method: 'POST', url: '/zernio/events', headers: { 'content-type': 'application/json', 'x-zernio-signature': sig, ...headers }, payload: raw });
};
const inbound = (conv: string, text: string, id = `evt_${crypto.randomUUID()}`) => ({
  id, event: 'message.received', timestamp: new Date().toISOString(),
  message: { id: `zm_${crypto.randomUUID()}`, conversationId: conv, platformMessageId: `ig_${crypto.randomUUID()}`, direction: 'incoming', text, sender: { name: 'Ana' }, sentAt: new Date().toISOString() },
  conversation: { id: conv }, account: { id: 'acc_ev', profileId, platform: 'instagram' },
});
/** Conecta una red del negocio por el flujo real y devuelve el canal. */
async function connected(accountId: string, platform: string, zid: string, botId: string | null = null) {
  const c = (await h.authed('POST', '/api/channels', { account_id: accountId, chatbot_id: botId, type: 'zernio', name: `${platform} ${zid}`, config: { platform } })).json();
  assert.equal((await h.authed('POST', `/api/channels/${c.id}/zernio/connect`, {})).statusCode, 200);
  const cfg = (await store.getChannel(c.id))!.config;
  if (platform !== 'telegram') {
    zer.accounts.set(zid, { _id: zid, platform, profileId: cfg.profile_id, username: zid, displayName: zid, isActive: true });
    const r = await h.app.inject({ method: 'GET', url: `/zernio/callback/${c.webhook_token}/${cfg.connect_state}?accountId=${zid}` });
    assert.equal(r.statusCode, 302);
  }
  return { ...c, profile_id: cfg.profile_id };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  channel = await connected(h.accountId, 'instagram', 'acc_ev', h.botId);
  profileId = channel.profile_id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la cuenta conectada queda registrada como del negocio y enlazada a su conexión', async () => {
  const row = (await pool.query(`SELECT account_id, channel_id, platform, status FROM social_accounts WHERE zernio_account_id = 'acc_ev'`)).rows[0];
  assert.deepEqual(row, { account_id: h.accountId, channel_id: channel.id, platform: 'instagram', status: 'active' });
  assert.equal((await pool.query(`SELECT account_id FROM zernio_profiles WHERE profile_id = $1`, [profileId])).rows[0].account_id, h.accountId);
});

t('un mismo evento (reintento de Zernio) cuenta una sola vez; uno de hace más de 35 días no se acepta', async () => {
  const ev = inbound('conv_dup', 'Hola, ¿precio?', 'evt_dup_1');
  for (let i = 0; i < 3; i++) assert.equal((await deliver(ev)).statusCode, 200);
  await h.idle();
  const msgs = await pool.query(`SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts k ON k.id = c.contact_id WHERE k.external_id = 'conv_dup' AND m.direction = 'in'`);
  assert.equal(msgs.rowCount, 1);
  assert.equal((await pool.query(`SELECT state FROM zernio_events WHERE event_id = 'evt_dup_1'`)).rows[0].state, 'done');
  // El id también puede venir solo en la cabecera.
  const noId: any = inbound('conv_hdr', 'Hola');
  delete noId.id;
  assert.equal((await deliver(noId, { 'x-zernio-event-id': 'evt_hdr_1' })).statusCode, 200);
  assert.equal((await deliver(noId, { 'x-zernio-event-id': 'evt_hdr_1' })).statusCode, 200);
  await h.idle();
  assert.equal((await pool.query(`SELECT 1 FROM zernio_events WHERE event_id = 'evt_hdr_1'`)).rowCount, 1);

  const old = { ...inbound('conv_vieja', 'Hola de hace mucho'), timestamp: new Date(Date.now() - 40 * 86400_000).toISOString() };
  assert.equal((await deliver(old)).statusCode, 200);
  await h.idle();
  assert.equal((await pool.query(`SELECT 1 FROM contacts WHERE external_id = 'conv_vieja'`)).rowCount, 0);
});

t('entregado, leído y fallido se marcan en el mensaje enviado (y solo en los de ese negocio)', async () => {
  await deliver(inbound('conv_st', 'Hola'));
  await h.idle();
  const out = (await pool.query(
    `SELECT m.id, m.external_message_id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts k ON k.id = c.contact_id
      WHERE k.external_id = 'conv_st' AND m.direction = 'out' ORDER BY m.id DESC LIMIT 1`)).rows[0];
  assert.ok(out?.external_message_id, 'la respuesta del agente guardó el id de Zernio');
  const status = (event: string, extra: Record<string, unknown> = {}) => deliver({
    id: `evt_${crypto.randomUUID()}`, event, timestamp: new Date().toISOString(),
    message: { id: out.external_message_id, conversationId: 'conv_st' }, account: { id: 'acc_ev', profileId, platform: 'instagram' }, ...extra,
  });
  assert.equal((await status('message.delivered')).statusCode, 200);
  await h.idle();
  let m = (await pool.query(`SELECT delivered_at, read_at, status FROM messages WHERE id = $1`, [out.id])).rows[0];
  assert.ok(m.delivered_at && !m.read_at);
  await status('message.read');
  await h.idle();
  m = (await pool.query(`SELECT delivered_at, read_at, status FROM messages WHERE id = $1`, [out.id])).rows[0];
  assert.ok(m.read_at);
  await status('message.failed', { error: { code: 'TEMPLATE_REQUIRED', message: 'Outside the 24h window' } });
  await h.idle();
  m = (await pool.query(`SELECT status, meta FROM messages WHERE id = $1`, [out.id])).rows[0];
  assert.equal(m.status, 'failed');
  assert.equal(m.meta.error_code, 'TEMPLATE_REQUIRED');
});

t('desconexión y reconexión pasan por la cola: canal y cuenta del negocio quedan al día', async () => {
  const ev = (event: string) => ({ id: `evt_${crypto.randomUUID()}`, event, timestamp: new Date().toISOString(), account: { accountId: 'acc_ev', profileId, platform: 'instagram', reason: 'Token expired' } });
  assert.equal((await deliver(ev('account.disconnected'))).statusCode, 200);
  await waitFor(async () => (await store.getChannel(channel.id))!.connection_state === 'close', 5000);
  await h.idle();
  assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE zernio_account_id = 'acc_ev'`)).rows[0].status, 'needs_reconnect');
  assert.equal((await deliver(ev('account.connected'))).statusCode, 200);
  await waitFor(async () => (await store.getChannel(channel.id))!.connection_state === 'open', 5000);
  await h.idle();
  assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE zernio_account_id = 'acc_ev'`)).rows[0].status, 'active');
});

t('una cuenta conectada directo en Zernio se adopta si su perfil es de un negocio; si no, se ignora', async () => {
  const connectedEv = (zid: string, profile: string) => ({ id: `evt_${crypto.randomUUID()}`, event: 'account.connected', timestamp: new Date().toISOString(), account: { accountId: zid, profileId: profile, platform: 'linkedin', username: 'clinica' } });
  assert.equal((await deliver(connectedEv('acc_li', profileId))).statusCode, 200);
  await h.idle();
  const row = (await pool.query(`SELECT account_id, platform, channel_id FROM social_accounts WHERE zernio_account_id = 'acc_li'`)).rows[0];
  assert.deepEqual(row, { account_id: h.accountId, platform: 'linkedin', channel_id: null });
  assert.equal((await deliver(connectedEv('acc_nadie', 'prof_desconocido'))).statusCode, 200);
  await h.idle();
  assert.equal((await pool.query(`SELECT 1 FROM social_accounts WHERE zernio_account_id = 'acc_nadie'`)).rowCount, 0);
});

t('Telegram no tiene ventana de 24 h: un aviso proactivo sale aunque el cliente no haya escrito hoy', async () => {
  const tg = await connected(h.accountId, 'telegram', 'acc_tg_unused', h.botId);
  // Telegram se conecta con código; aquí se simula ya conectado con su cuenta.
  await pool.query(`UPDATE channels SET config = config || '{"account_id":"acc_tg"}'::jsonb WHERE id = $1`, [tg.id]);
  const tgEvent = { ...inbound('conv_tg', 'Hola'), account: { id: 'acc_tg', profileId, platform: 'telegram' } };
  await deliver(tgEvent);
  await h.idle();
  const conv = (await pool.query(`SELECT c.id, c.contact_id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.external_id = 'conv_tg'`)).rows[0];
  await pool.query(`UPDATE contacts SET consent_at = now() WHERE id = $1`, [conv.contact_id]);
  await pool.query(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1`, [conv.id]);
  const r = await h.service.outbound.send(conv.id, { text: 'Tu pedido ya salió', source: 'campaign' });
  assert.equal(r.sent, true, JSON.stringify(r));
});

t('al borrar un negocio, sus redes y su perfil se quitan de Zernio (en un trabajo con reintentos)', async () => {
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Negocio que se va' })).json();
  const c = await connected(acc.id, 'instagram', 'acc_se_va');
  assert.ok(zer.accounts.has('acc_se_va'));
  assert.ok(zer.profiles.some((p) => p._id === c.profile_id));
  assert.equal((await h.authed('DELETE', `/api/accounts/${acc.id}`)).statusCode, 200);
  await h.fastForward();
  await waitFor(() => !zer.accounts.has('acc_se_va') && !zer.profiles.some((p) => p._id === c.profile_id), 8000);
  assert.ok(ext.requests.some((r) => r.method === 'DELETE' && r.path === `/api/v1/profiles/${c.profile_id}`));
});
