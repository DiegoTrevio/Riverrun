/**
 * Llave de Zernio de la plataforma desde el panel: el superadministrador la pega en Sistema, se prueba con Zernio antes
 * de guardarla, se guarda cifrada, nunca vuelve al navegador y activa las redes para todas las cuentas (webhook único y
 * un perfil por cuenta). La variable ZERNIO_API_KEY del servidor, si existe, manda.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, ext, pool, waitFor, zer } from './harness.js';
// Después del arnés (que define las variables de entorno con await de nivel superior).
const { loadPlatformSecrets } = await import('../src/platform-secrets.js');
const { encryptSecret } = await import('../src/secret.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
const KEY = 'zk_llave_del_panel_1234';
const ENV_KEY = process.env.ZERNIO_API_KEY!;

before(async () => {
  if (!ok) return;
  // Esta instalación arranca sin llave en el .env: se pone desde el panel.
  delete process.env.ZERNIO_API_KEY;
  h = await createHarness();
  await h.createBot();
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'dueno@llave.mx', name: 'Dueño', password: 'clave-llave-1', role: 'admin' });
  assert.equal(u.statusCode, 200, u.body);
  await pool.query('UPDATE users SET email_verified_at = now() WHERE email = $1', ['dueno@llave.mx']);
  owner = await h.loginAs('dueno@llave.mx', 'clave-llave-1');
});
after(async () => {
  process.env.ZERNIO_API_KEY = ENV_KEY;
  if (h) await h.app.close();
  await pool.end();
});

t('sin llave: las redes sociales están apagadas para todas las cuentas', async () => {
  const s = (await h.authed('GET', '/api/system/zernio')).json();
  assert.equal(s.enabled, false);
  assert.equal(s.source, 'none');
  assert.equal((await owner('GET', '/api/meta')).json().zernio_enabled, false);
  const r = await owner('POST', '/api/channels', { type: 'zernio', name: 'X', chatbot_id: h.botId, config: { platform: 'twitter' } });
  assert.equal(r.statusCode, 400);
});

t('solo el superadministrador ve o cambia la llave', async () => {
  assert.equal((await owner('GET', '/api/system/zernio')).statusCode, 403);
  assert.equal((await owner('PUT', '/api/system/zernio', { api_key: KEY })).statusCode, 403);
  assert.equal((await owner('DELETE', '/api/system/zernio')).statusCode, 403);
});

t('una llave que Zernio rechaza no se guarda', async () => {
  const r = await h.authed('PUT', '/api/system/zernio', { api_key: 'llave-equivocada-1' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /rechazó la llave/);
  assert.equal((await h.authed('GET', '/api/system/zernio')).json().enabled, false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_secrets')).rows[0].n, 0);
});

t('guardar la llave: se prueba, se guarda cifrada y registra el webhook (los perfiles se crean al conectar cada red)', async () => {
  zer.webhooks.length = 0;
  const r = await h.authed('PUT', '/api/system/zernio', { api_key: KEY });
  assert.equal(r.statusCode, 200, r.body);
  assert.doesNotMatch(r.body, /llave_del_panel/, 'la llave nunca vuelve al navegador');
  const s = r.json();
  assert.equal(s.enabled, true);
  assert.equal(s.source, 'panel');
  assert.equal(s.hint, '1234');
  assert.deepEqual(s.webhook, { ok: true });
  assert.equal(zer.webhooks.length, 1);
  assert.equal(zer.webhooks[0].url, 'https://bot.test/zernio/events');
  const stored = (await pool.query('SELECT value FROM platform_secrets WHERE key = $1', ['zernio_api_key'])).rows[0].value;
  assert.ok(stored.startsWith('v1.') && !stored.includes(KEY), 'cifrada en la base');
  // Ningún perfil se crea por adelantado: solo el de quien conecte una red.
  assert.ok(s.accounts_total >= 1);
  assert.equal(s.accounts_with_profile, 0);
  assert.equal(zer.profiles.length, 0);
  assert.doesNotMatch((await h.authed('GET', '/api/system/zernio')).body, /llave_del_panel/);
});

t('la llave del panel sirve para todas las cuentas: el negocio conecta su red sin ver ninguna llave', async () => {
  assert.equal((await owner('GET', '/api/meta')).json().zernio_enabled, true);
  const c = await owner('POST', '/api/channels', { type: 'zernio', name: 'X del negocio', chatbot_id: h.botId, config: { platform: 'twitter' } });
  assert.equal(c.statusCode, 200, c.body);
  ext.requests.length = 0;
  const r = await owner('POST', `/api/channels/${c.json().id}/zernio/connect`, {});
  assert.equal(r.statusCode, 200, r.body);
  const calls = ext.requests.filter((x) => x.path.startsWith('/api/v1/'));
  assert.ok(calls.length > 0);
  assert.ok(calls.every((x) => x.headers.authorization === `Bearer ${KEY}`));
  assert.doesNotMatch(r.body + c.body, /llave_del_panel/);
});

t('otro proceso (o un reinicio) toma la llave de la base', async () => {
  await pool.query('UPDATE platform_secrets SET value = $1 WHERE key = $2', [encryptSecret('zk_otra_llave_9999'), 'zernio_api_key']);
  await loadPlatformSecrets();
  assert.equal((await h.authed('GET', '/api/system/zernio')).json().hint, '9999');
});

t('Probar y reparar vuelve a registrar el webhook si se borró en Zernio', async () => {
  zer.webhooks.length = 0;
  const r = await h.authed('POST', '/api/system/zernio/check');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(zer.webhooks.length, 1);
});

t('si el servidor define ZERNIO_API_KEY, esa manda y el panel no la cambia', async () => {
  process.env.ZERNIO_API_KEY = ENV_KEY;
  try {
    const s = (await h.authed('GET', '/api/system/zernio')).json();
    assert.equal(s.source, 'env');
    assert.equal((await h.authed('PUT', '/api/system/zernio', { api_key: KEY })).statusCode, 409);
    assert.equal((await h.authed('DELETE', '/api/system/zernio')).statusCode, 409);
  } finally { delete process.env.ZERNIO_API_KEY; }
});

t('una llave de otra cuenta de Zernio pide confirmación; al confirmar, las redes de los negocios quedan por reconectar', async () => {
  const c = (await owner('POST', '/api/channels', { type: 'zernio', name: 'X que se reconecta', chatbot_id: h.botId, config: { platform: 'twitter' } })).json();
  assert.equal((await owner('POST', `/api/channels/${c.id}/zernio/connect`, {})).statusCode, 200);
  const cfg = (await pool.query('SELECT config FROM channels WHERE id = $1', [c.id])).rows[0].config;
  zer.accounts.set('acc_x_ws', { _id: 'acc_x_ws', platform: 'twitter', profileId: cfg.profile_id, username: 'negocio', isActive: true });
  assert.equal((await h.app.inject({ method: 'GET', url: `/zernio/callback/${c.webhook_token}/${cfg.connect_state}?accountId=acc_x_ws` })).statusCode, 302);
  zer.userId = 'user_2';
  try {
    const r = await h.authed('PUT', '/api/system/zernio', { api_key: 'zk_de_otra_cuenta_5678' });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.json().error, /otra cuenta de Zernio/);
    assert.notEqual((await pool.query('SELECT zernio_profile_id FROM accounts WHERE id = $1', [h.accountId])).rows[0].zernio_profile_id, '', 'sin confirmar no cambia nada');
    const ok = await h.authed('PUT', '/api/system/zernio', { api_key: 'zk_de_otra_cuenta_5678', confirm_workspace_change: true });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await pool.query('SELECT zernio_profile_id FROM accounts WHERE id = $1', [h.accountId])).rows[0].zernio_profile_id, '');
    const ch = (await pool.query('SELECT config, connection_state, disconnect_reason FROM channels WHERE id = $1', [c.id])).rows[0];
    assert.equal(ch.config.account_id, '');
    assert.equal(ch.connection_state, 'close');
    assert.equal(ch.disconnect_reason, 'zernio_workspace_changed');
    assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE zernio_account_id = 'acc_x_ws'`)).rows[0].status, 'stale');
  } finally { zer.userId = 'user_1'; }
});

t('quitar la llave apaga las redes', async () => {
  const r = await h.authed('DELETE', '/api/system/zernio');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().enabled, false);
  assert.equal((await owner('GET', '/api/meta')).json().zernio_enabled, false);
});
