/**
 * Zernio para el negocio y para el administrador de la plataforma: "Redes sociales" conecta redes con un retorno de un
 * solo uso y solo guarda cuentas del perfil del negocio; el enlace que el administrador manda al cliente sirve hasta que
 * conecta; el administrador ve a cada negocio, sincroniza, desconecta, revisa y reenvía entregas del webhook; el plan
 * limita cuántas redes se conectan; y el presupuesto de llamadas se comparte entre todos.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, ext, pool, store, zer } from './harness.js';
// Después del arnés (que define las variables de entorno con await de nivel superior).
const { clientFor } = await import('../src/channels/zernio.js');
const { drainZernioBudget, tryTakeZernioBudget } = await import('../src/channels/zernio-budget.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let otherAccount: string;
let otherOwner: Awaited<ReturnType<typeof h.loginAs>>;

const profileOf = async (accountId: string) => (await pool.query(`SELECT zernio_profile_id AS p FROM accounts WHERE id = $1`, [accountId])).rows[0].p as string;
const zAccount = (id: string, profileId: string, platform: string) =>
  zer.accounts.set(id, { _id: id, platform, profileId, username: id.replace('acc_', ''), displayName: `Cuenta ${id.replace('acc_', '')}`, profilePicture: '', isActive: true });
/** Última petición a /connect de Zernio: de ahí sale el token del retorno. */
const lastConnect = () => [...ext.requests].reverse().find((r) => r.path.startsWith('/api/v1/connect/'))!;
const tokenOf = (redirect: string) => redirect.split('/').pop()!;
/** Pide conectar una red desde "Redes sociales" y devuelve el token del retorno. */
async function startPanel(as: typeof owner, platform: string, extra: Record<string, unknown> = {}) {
  const r = await as('POST', '/api/social-accounts/connect', { platform, ...extra });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().kind, 'oauth');
  return tokenOf(lastConnect().query.get('redirect_url')!);
}
const back = (token: string, query: string) => h.app.inject({ method: 'GET', url: `/zernio/return/${token}?${query}` });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola'] }));
  await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'redes@palmas.mx', name: 'Dueña', password: 'Pz-140-Qx-340-Kv', role: 'admin' });
  otherAccount = (await h.authed('POST', '/api/accounts', { name: 'Florería Lila' })).json().id;
  await h.authed('POST', '/api/users', { account_id: otherAccount, email: 'lila@flores.mx', name: 'Lila', password: 'Pz-130-Qx-330-Kv', role: 'admin' });
  await pool.query('UPDATE users SET email_verified_at = now()');
  owner = await h.loginAs('redes@palmas.mx', 'Pz-140-Qx-340-Kv');
  otherOwner = await h.loginAs('lila@flores.mx', 'Pz-130-Qx-330-Kv');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('Redes sociales: el retorno sirve una vez y solo guarda cuentas del perfil del negocio', async () => {
  // El otro negocio tiene una cuenta real en su perfil.
  await h.authed('POST', `/api/system/zernio/tenants/${otherAccount}/profile`);
  zAccount('acc_lila_li', await profileOf(otherAccount), 'linkedin');

  const forged = await startPanel(owner, 'linkedin');
  const q = lastConnect().query;
  assert.equal(q.get('profileId'), await profileOf(h.accountId), 'la conexión usa el perfil de este negocio');
  assert.ok(q.get('brandName'));
  let r = await back(forged, 'connected=linkedin&accountId=acc_lila_li');
  assert.equal(r.statusCode, 302);
  assert.match(String(r.headers.location), /#\/redes\?zernio=not_yours$/);
  assert.equal((await pool.query(`SELECT 1 FROM social_accounts WHERE zernio_account_id = 'acc_lila_li' AND account_id = $1`, [h.accountId])).rowCount, 0);
  // El mismo retorno no sirve dos veces.
  assert.equal((await back(forged, 'connected=linkedin&accountId=acc_lila_li')).statusCode, 403);
  assert.equal((await back('token-inventado', 'accountId=x')).statusCode, 403);

  const real = await startPanel(owner, 'linkedin');
  zAccount('acc_palmas_li', await profileOf(h.accountId), 'linkedin');
  r = await back(real, 'connected=linkedin&accountId=acc_palmas_li');
  assert.match(String(r.headers.location), /#\/redes\?zernio=ok$/);
  const list = (await owner('GET', '/api/social-accounts')).json();
  const li = list.accounts.find((a: any) => a.platform === 'linkedin');
  assert.equal(li.status, 'active');
  assert.equal(li.dm, false, 'LinkedIn no tiene mensajes directos');
  assert.equal(li.channel_id, null);
  for (const hidden of ['zernio_account_id', 'profile_id', 'account_id']) assert.ok(!(hidden in li), `no expone ${hidden}`);
  assert.ok(!JSON.stringify(list).includes('acc_palmas_li'));
});

t('una cuenta de otra red que la elegida no se guarda; un retorno cancelado tampoco', async () => {
  const token = await startPanel(owner, 'reddit');
  zAccount('acc_palmas_tt', await profileOf(h.accountId), 'tiktok');
  let r = await back(token, 'connected=reddit&accountId=acc_palmas_tt');
  assert.match(String(r.headers.location), /zernio=not_yours$/);
  const cancelled = await startPanel(owner, 'reddit');
  r = await back(cancelled, 'error=oauth_denied&platform=reddit&is_user_fixable=true');
  assert.match(String(r.headers.location), /zernio=cancelled$/);
  assert.equal((await pool.query(`SELECT 1 FROM social_accounts WHERE platform IN ('reddit', 'tiktok')`)).rowCount, 0);
});

t('una red con mensajes queda en una conexión con el agente elegido; se cambia, se desconecta y se reutiliza', async () => {
  const token = await startPanel(owner, 'twitter', { chatbot_id: h.botId });
  zAccount('acc_palmas_x', await profileOf(h.accountId), 'twitter');
  await back(token, 'connected=twitter&accountId=acc_palmas_x');
  let x = (await owner('GET', '/api/social-accounts')).json().accounts.find((a: any) => a.platform === 'twitter');
  assert.equal(x.dm, true);
  assert.equal(x.chatbot_id, h.botId);
  const ch = (await store.getChannel(x.channel_id))!;
  assert.equal(ch.type, 'zernio');
  assert.equal(ch.config.account_id, 'acc_palmas_x');
  assert.equal(ch.chatbot_id, h.botId);
  assert.equal(ch.connection_state, 'open');

  assert.equal((await owner('PUT', `/api/social-accounts/${x.id}`, { chatbot_id: null })).statusCode, 200);
  assert.equal((await store.getChannel(x.channel_id))!.chatbot_id, null);
  // Otro negocio no puede tocarla.
  assert.equal((await otherOwner('PUT', `/api/social-accounts/${x.id}`, { chatbot_id: null })).statusCode, 404);
  assert.equal((await otherOwner('POST', `/api/social-accounts/${x.id}/disconnect`)).statusCode, 404);

  assert.equal((await owner('POST', `/api/social-accounts/${x.id}/disconnect`)).statusCode, 200);
  assert.ok(!zer.accounts.has('acc_palmas_x'), 'se quitó de Zernio');
  const kept = (await store.getChannel(ch.id))!;
  assert.equal(kept.config.account_id, '');
  assert.equal(kept.connection_state, 'close');
  // Al volver a conectar X se usa la misma conexión (con su historial).
  const again = await startPanel(owner, 'twitter');
  zAccount('acc_palmas_x2', await profileOf(h.accountId), 'twitter');
  await back(again, 'connected=twitter&accountId=acc_palmas_x2');
  x = (await owner('GET', '/api/social-accounts')).json().accounts.find((a: any) => a.platform === 'twitter');
  assert.equal(x.channel_id, ch.id);
  assert.equal((await store.getChannel(ch.id))!.config.account_id, 'acc_palmas_x2');
});

t('con "Conectar con Facebook" activo, Instagram por Zernio no contesta mensajes (sin respuestas dobles)', async () => {
  const token = await startPanel(owner, 'instagram', { chatbot_id: h.botId });
  zAccount('acc_palmas_ig', await profileOf(h.accountId), 'instagram');
  await back(token, 'connected=instagram&accountId=acc_palmas_ig');
  const data = (await owner('GET', '/api/social-accounts')).json();
  assert.equal(data.meta_direct, true);
  const ig = data.accounts.find((a: any) => a.platform === 'instagram');
  assert.equal(ig.dm, false);
  assert.equal(ig.channel_id, null);
  assert.equal((await pool.query(`SELECT 1 FROM channels WHERE config->>'account_id' = 'acc_palmas_ig'`)).rowCount, 0);
  assert.equal((await owner('PUT', `/api/social-accounts/${ig.id}`, { chatbot_id: h.botId })).statusCode, 400);
});

t('Telegram se termina en su conexión de mensajes (código para el bot)', async () => {
  const r = await owner('POST', '/api/social-accounts/connect', { platform: 'telegram', chatbot_id: h.botId });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().kind, 'channel');
  const ch = (await store.getChannel(r.json().channel_id))!;
  assert.deepEqual([ch.type, ch.config.platform, ch.chatbot_id, ch.account_id], ['zernio', 'telegram', h.botId, h.accountId]);
});

t('el enlace para el cliente: abre la autorización sin sesión, sirve tras cancelar y deja de servir al conectar', async () => {
  assert.equal((await owner('POST', `/api/system/zernio/tenants/${otherAccount}/connect-link`, { platform: 'twitter' })).statusCode, 403);
  const link = (await h.authed('POST', `/api/system/zernio/tenants/${otherAccount}/connect-link`, { platform: 'twitter' })).json();
  assert.match(link.url, /^https:\/\/bot\.test\/conectar-red\/[\w-]+$/);
  assert.ok(Date.parse(link.expires_at) > Date.now() + 6 * 86400_000);
  const path = new URL(link.url).pathname;
  let r = await h.app.inject({ method: 'GET', url: path });
  assert.equal(r.statusCode, 302);
  assert.match(String(r.headers.location), /^https:\/\/zernio\.example\/auth\//);
  const q = lastConnect().query;
  assert.equal(q.get('profileId'), await profileOf(otherAccount));
  assert.equal(q.get('welcome'), 'true');
  const token = tokenOf(q.get('redirect_url')!);

  r = await back(token, 'error=oauth_denied&platform=twitter');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /No se terminó la autorización/);
  assert.equal((await h.app.inject({ method: 'GET', url: path })).statusCode, 302, 'tras cancelar, el enlace sigue sirviendo');

  zAccount('acc_lila_x', await profileOf(otherAccount), 'twitter');
  r = await back(token, 'connected=twitter&accountId=acc_lila_x');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /quedó conectada/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const row = (await pool.query(`SELECT account_id, status FROM social_accounts WHERE zernio_account_id = 'acc_lila_x'`)).rows[0];
  assert.deepEqual(row, { account_id: otherAccount, status: 'active' });
  r = await h.app.inject({ method: 'GET', url: path });
  assert.equal(r.statusCode, 404);
  assert.match(r.body, /ya se usó/);
  // Telegram no se conecta con un enlace.
  assert.equal((await h.authed('POST', `/api/system/zernio/tenants/${otherAccount}/connect-link`, { platform: 'telegram' })).statusCode, 400);
});

t('el administrador ve a cada negocio con sus redes, sincroniza con Zernio y desconecta todo', async () => {
  assert.equal((await owner('GET', '/api/system/zernio/tenants')).statusCode, 403);
  let tenants = (await h.authed('GET', '/api/system/zernio/tenants')).json();
  const lila = tenants.find((x: any) => x.account_id === otherAccount);
  assert.equal(lila.name, 'Florería Lila');
  assert.deepEqual(lila.accounts.map((a: any) => a.platform), ['twitter']);
  assert.equal(typeof lila.outbound_month, 'number');

  // Conectada a mano en Zernio (en el perfil del negocio) y otra que ya no está allá.
  zAccount('acc_lila_pin', await profileOf(otherAccount), 'pinterest');
  zer.accounts.delete('acc_lila_x');
  const s = (await h.authed('POST', `/api/system/zernio/tenants/${otherAccount}/sync`)).json();
  assert.equal(s.accounts, 2, 'acc_lila_li y acc_lila_pin');
  const rows = Object.fromEntries((await pool.query(`SELECT zernio_account_id, status FROM social_accounts WHERE account_id = $1`, [otherAccount])).rows.map((r) => [r.zernio_account_id, r.status]));
  assert.equal(rows.acc_lila_pin, 'active');
  assert.equal(rows.acc_lila_li, 'active');
  assert.equal(rows.acc_lila_x, 'disconnected');
  const xch = (await pool.query(`SELECT c.connection_state FROM channels c JOIN social_accounts s ON s.channel_id = c.id WHERE s.zernio_account_id = 'acc_lila_x'`)).rows[0];
  assert.equal(xch.connection_state, 'close');

  const d = (await h.authed('POST', `/api/system/zernio/tenants/${otherAccount}/disconnect-all`)).json();
  assert.equal(d.disconnected, 3);
  assert.ok(!zer.accounts.has('acc_lila_pin') && !zer.accounts.has('acc_lila_li'));
  tenants = (await h.authed('GET', '/api/system/zernio/tenants')).json();
  assert.deepEqual(tenants.find((x: any) => x.account_id === otherAccount).accounts, []);
});

t('registro del webhook: muestra entregas fallidas y las reenvía; perfiles sin dueño y presupuesto', async () => {
  const webhookId = zer.webhooks.find((w) => w.url === 'https://bot.test/zernio/events')?._id;
  assert.ok(webhookId, 'el webhook de la plataforma quedó registrado al conectar');
  zer.logs.push(
    { webhookId, eventId: 'evt_falla_1', event: 'message.received', status: 'failed', statusCode: 503, errorMessage: 'Service Unavailable', createdAt: new Date().toISOString() },
    { webhookId, eventId: 'evt_bien_1', event: 'account.connected', status: 'success', statusCode: 200, createdAt: new Date().toISOString() },
  );
  const logs = (await h.authed('GET', '/api/system/zernio/webhook-logs')).json();
  assert.deepEqual(logs.map((l: any) => [l.id, l.ok, l.status_code]), [['evt_falla_1', false, 503], ['evt_bien_1', true, 200]]);
  assert.equal((await h.authed('POST', '/api/system/zernio/webhook-logs/evt_falla_1/redeliver', { webhook_id: logs[0].webhook_id })).statusCode, 200);
  assert.deepEqual(zer.redelivered, [{ webhookId, eventId: 'evt_falla_1' }]);
  const gone = await h.authed('POST', '/api/system/zernio/webhook-logs/evt_viejo/redeliver', { webhook_id: webhookId });
  assert.equal(gone.statusCode, 400);
  assert.match(gone.json().error, /30 días/);

  zer.profiles.push({ _id: 'prof_huerfano', name: 'Negocio borrado', externalId: 'ya-no-existe' });
  const orphans = (await h.authed('GET', '/api/system/zernio/orphans')).json();
  assert.deepEqual(orphans.profiles.map((p: any) => p.id), ['prof_huerfano']);

  const budget = (await h.authed('GET', '/api/system/zernio/budget')).json();
  assert.ok(budget.capacity > 0 && budget.tokens >= 0);
  assert.equal((await owner('GET', '/api/system/zernio/budget')).statusCode, 403);
});

t('el plan limita cuántas redes se conectan', async () => {
  const used = (await owner('GET', '/api/social-accounts')).json().limit.used;
  await pool.query(`UPDATE accounts SET limits_override = $2 WHERE id = $1`, [h.accountId, { social_accounts: used }]);
  try {
    const r = await owner('POST', '/api/social-accounts/connect', { platform: 'youtube' });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /redes sociales conectadas/);
    assert.equal((await owner('GET', '/api/social-accounts')).json().limit.max, used);
    // Reconectar una que ya tiene no cuenta como nueva.
    const li = (await owner('GET', '/api/social-accounts')).json().accounts.find((a: any) => a.platform === 'linkedin');
    assert.equal((await owner('POST', '/api/social-accounts/connect', { platform: 'linkedin', reconnect: li.id })).statusCode, 200);
    assert.equal(lastConnect().query.get('reconnectAccountId'), 'acc_palmas_li');
  } finally {
    await pool.query(`UPDATE accounts SET limits_override = '{}' WHERE id = $1`, [h.accountId]);
  }
});

t('presupuesto compartido: lo de segundo plano deja libre el 30 %; un 429 de Zernio lo vacía', async () => {
  const prev = process.env.ZERNIO_RATE_PER_MIN;
  process.env.ZERNIO_RATE_PER_MIN = '6';
  try {
    await pool.query(`DELETE FROM rate_buckets WHERE key = 'zernio'`);
    for (let i = 0; i < 4; i++) assert.equal(await tryTakeZernioBudget('interactive'), true);
    assert.equal(await tryTakeZernioBudget('background'), false, 'quedan ~2 de 6: segundo plano espera');
    assert.equal(await tryTakeZernioBudget('interactive'), true, 'lo que pide una persona sí pasa');
    await drainZernioBudget();
    assert.equal(await tryTakeZernioBudget('interactive'), false);
  } finally {
    process.env.ZERNIO_RATE_PER_MIN = prev;
    await pool.query(`DELETE FROM rate_buckets WHERE key = 'zernio'`);
  }
  // Zernio responde 429: se repite una vez y la llamada termina bien.
  zer.rateLimited = 1;
  const before = ext.requests.filter((r) => r.path === '/api/v1/users').length;
  const me = await clientFor().call<any>('GET', '/users');
  assert.equal(me.currentUserId, zer.userId);
  assert.equal(ext.requests.filter((r) => r.path === '/api/v1/users').length - before, 2);
});

t('si Zernio no quita la cuenta, no se dice "desconectada"; un error de Zernio llega como aviso claro', async () => {
  const li = (await owner('GET', '/api/social-accounts')).json().accounts.find((a: any) => a.platform === 'linkedin');
  ext.fail.add('/api/v1/accounts/acc_palmas_li');
  try {
    const r = await owner('POST', `/api/social-accounts/${li.id}/disconnect`);
    assert.equal(r.statusCode, 502);
    assert.match(r.json().error, /No se pudo desconectar en Zernio/);
    assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE id = $1`, [li.id])).rows[0].status, 'active');
    assert.ok(zer.accounts.has('acc_palmas_li'));
  } finally {
    ext.fail.delete('/api/v1/accounts/acc_palmas_li');
  }
  // Sincronizar con Zernio caído: aviso claro y nada se marca como desconectado.
  ext.fail.add('/api/v1/accounts');
  try {
    const r = await h.authed('POST', `/api/system/zernio/tenants/${h.accountId}/sync`);
    assert.equal(r.statusCode, 502);
    assert.match(r.json().error, /Zernio respondió con un error/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM social_accounts WHERE account_id = $1 AND status = 'disconnected'`, [h.accountId])).rows[0].n, 0);
  } finally {
    ext.fail.delete('/api/v1/accounts');
  }
  assert.equal((await owner('POST', '/api/social-accounts/no-es-un-id/disconnect')).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/system/zernio/tenants/no-es-un-id/sync')).statusCode, 400);
});

t('el límite de redes también se respeta al conectar desde la conexión del agente (y la que no cabe se quita de Zernio)', async () => {
  const used = (await owner('GET', '/api/social-accounts')).json().limit.used;
  await pool.query(`UPDATE accounts SET limits_override = $2 WHERE id = $1`, [h.accountId, { social_accounts: used }]);
  try {
    const c = (await owner('POST', '/api/channels', { type: 'zernio', name: 'Reddit', config: { platform: 'reddit' } })).json();
    assert.equal((await owner('POST', `/api/channels/${c.id}/zernio/connect`, {})).statusCode, 200);
    const cfg = (await store.getChannel(c.id))!.config;
    zAccount('acc_palmas_rd', cfg.profile_id, 'reddit');
    const r = await h.app.inject({ method: 'GET', url: `/zernio/callback/${c.webhook_token}/${cfg.connect_state}?accountId=acc_palmas_rd` });
    assert.match(String(r.headers.location), /zernio=limit$/);
    assert.ok(!zer.accounts.has('acc_palmas_rd'), 'se quitó de Zernio para no pagar por ella');
    assert.equal((await pool.query(`SELECT 1 FROM social_accounts WHERE zernio_account_id = 'acc_palmas_rd'`)).rowCount, 0);
    assert.equal((await store.getChannel(c.id))!.config.account_id, '');
  } finally {
    await pool.query(`UPDATE accounts SET limits_override = '{}' WHERE id = $1`, [h.accountId]);
  }
});

t('Reconectar Telegram vuelve a su misma conexión (no crea otra ni cuenta como red nueva)', async () => {
  const tg = (await owner('POST', '/api/social-accounts/connect', { platform: 'telegram' })).json();
  await pool.query(`UPDATE channels SET config = config || '{"account_id":"acc_palmas_tg"}'::jsonb WHERE id = $1`, [tg.channel_id]);
  const row = (await pool.query(
    `INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, status, channel_id) VALUES ($1, 'acc_palmas_tg', $2, 'telegram', 'needs_reconnect', $3) RETURNING id`,
    [h.accountId, await profileOf(h.accountId), tg.channel_id])).rows[0];
  const channels = (await pool.query(`SELECT count(*)::int AS n FROM channels WHERE account_id = $1`, [h.accountId])).rows[0].n;
  const used = (await owner('GET', '/api/social-accounts')).json().limit.used;
  await pool.query(`UPDATE accounts SET limits_override = $2 WHERE id = $1`, [h.accountId, { social_accounts: used }]);
  try {
    const r = await owner('POST', '/api/social-accounts/connect', { platform: 'telegram', reconnect: row.id });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { kind: 'channel', channel_id: tg.channel_id });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM channels WHERE account_id = $1`, [h.accountId])).rows[0].n, channels);
  } finally {
    await pool.query(`UPDATE accounts SET limits_override = '{}' WHERE id = $1`, [h.accountId]);
  }
});
