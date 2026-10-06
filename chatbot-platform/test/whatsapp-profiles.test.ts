import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, evo, pool } from './harness.js';

const available = await dbAvailable();
let h: Awaited<ReturnType<typeof createHarness>>;
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !available && 'PostgreSQL no disponible' }, fn);
before(async () => {
  if (!available) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});
const create = (account_id = h.accountId, chatbot_id: string | null = h.botId) => h.authed('POST', '/api/channels', { account_id, chatbot_id, type: 'whatsapp', name: 'Perfil' });

t('cuatro perfiles por cuenta: las solicitudes simultáneas no exceden el límite', async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => create()));
  assert.equal(responses.filter(r => r.statusCode === 200).length, 3);
  assert.equal(responses.filter(r => r.statusCode === 409).length, 3);
  const profiles = (await h.authed('GET', `/api/channels?account_id=${h.accountId}`)).json();
  assert.equal(profiles.length, 4);
  assert.equal(new Set(profiles.map((p: any) => p.config.instance)).size, 4);
  assert.equal(new Set(profiles.map((p: any) => p.webhook_token)).size, 4);
  assert.ok(profiles.every((p: any) => p.chatbot_id === h.botId));
  assert.match(responses.find(r => r.statusCode === 409)!.json().error, /4 perfiles/);
});

t('cuatro perfiles generan sesiones y QRs independientes para el mismo asistente', async () => {
  const profiles = (await h.authed('GET', `/api/channels?account_id=${h.accountId}`)).json();
  for (const [index, profile] of profiles.entries()) {
    const first = await h.authed('POST', `/api/channels/${profile.id}/whatsapp/session`, {});
    assert.equal(first.statusCode, 200, first.body);
    const update = await h.app.inject({ method: 'POST', url: `/webhook/${profile.webhook_token}`, payload: {
      instance: profile.config.instance, event: 'qrcode.updated', data: { qrcode: { base64: `PROFILE${index}` } },
    } });
    assert.equal(update.statusCode, 200, update.body);
  }
  for (const [index, profile] of profiles.entries()) {
    const session = await h.authed('POST', `/api/channels/${profile.id}/whatsapp/session`, {});
    assert.equal(session.json().qr, `data:image/png;base64,PROFILE${index}`);
  }
  evo.instances.get(profiles[0].config.instance)!.state = 'open';
  const connected = await h.authed('POST', `/api/channels/${profiles[0].id}/whatsapp/session`, {});
  assert.equal(connected.json().state, 'open');
  for (const profile of profiles.slice(1)) {
    const session = await h.authed('POST', `/api/channels/${profile.id}/whatsapp/session`, {});
    assert.equal(session.json().state, 'connecting');
    assert.ok(session.json().qr);
  }
});

t('cada perfil conserva su asistente; desactivar no libera un lugar y eliminar sí', async () => {
  const bot = await h.authed('POST', '/api/chatbots', { account_id: h.accountId, name: 'Otro asistente' });
  assert.equal(bot.statusCode, 200, bot.body);
  const changed = await h.authed('PUT', `/api/channels/${h.channelId}`, { chatbot_id: bot.json().id, active: false });
  assert.equal(changed.statusCode, 200, changed.body);
  const profiles = (await h.authed('GET', `/api/channels?account_id=${h.accountId}`)).json();
  assert.equal(profiles.find((p: any) => p.id === h.channelId).chatbot_id, bot.json().id);
  assert.ok(profiles.filter((p: any) => p.id !== h.channelId).every((p: any) => p.chatbot_id === h.botId));
  assert.equal((await create()).statusCode, 409);
  assert.equal((await h.authed('DELETE', `/api/channels/${h.channelId}`)).statusCode, 200);
  assert.equal((await create()).statusCode, 200);
  const web = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'webchat', name: 'Web' });
  assert.equal(web.statusCode, 200, web.body);
});

t('el límite es por cuenta y no permite vincular asistentes de otra cuenta', async () => {
  const account = await h.authed('POST', '/api/accounts', { name: 'Otra cuenta' });
  assert.equal(account.statusCode, 200, account.body);
  const id = account.json().id;
  assert.equal((await create(id, null)).statusCode, 200);
  assert.equal((await create(id, h.botId)).statusCode, 400);
  const meta = await h.authed('GET', '/api/meta');
  assert.equal(meta.json().max_whatsapp_profiles, 4);
});
