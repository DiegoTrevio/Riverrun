/**
 * INF-6 e INF-7: los datos cifrados en la base usan DATA_KEY (aparte de SESSION_SECRET, con versión de llave) y las
 * credenciales de los canales se guardan cifradas. `rekey-secrets` pasa todo a la llave actual: el 2FA todo o nada; lo
 * que ya no se puede leer se cuenta y se deja.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const { decryptSecret, encryptSecret, keyId } = await import('../src/secret.js');
const { rekeySecrets } = await import('../src/cli/rekey-secrets.js');
const store = await import('../src/store/index.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-993-Qx-994-Kv';
const KEY_A = 'llave-de-datos-a-0123456789abcdef0123456789';
const KEY_B = 'llave-de-datos-b-fedcba9876543210fedcba9876';
const rows = async () => (await pool.query(`SELECT email, totp_secret, totp_pending FROM users WHERE totp_secret IS NOT NULL OR totp_pending IS NOT NULL ORDER BY email`)).rows;
const withKeys = async (key: string, old: string[], fn: () => Promise<void>) => {
  const saved = [config.dataKey, config.dataKeysOld] as const;
  config.dataKey = key; config.dataKeysOld = old;
  try { await fn(); } finally { [config.dataKey, config.dataKeysOld] = saved; }
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const email of ['lia@clave.mx', 'max@clave.mx']) {
    await h.addUser({ account_id: h.accountId, name: email, email, password: PASS, role: 'admin' });
    await h.loginAs(email, PASS);
  }
  // Max empezó a cambiar de app: su secreto pendiente también se re-cifra.
  const max = await h.loginAs('max@clave.mx', PASS);
  assert.equal((await max('POST', '/api/me/2fa/authenticator')).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

test('v2 lleva el id de la llave; la anterior descifra mientras está en DATA_KEYS_OLD; v1 sigue con SESSION_SECRET', async () => {
  await withKeys(KEY_A, [], async () => {
    const a = encryptSecret('hola');
    assert.ok(a.startsWith(`v2.${keyId(KEY_A)}.`));
    await withKeys(KEY_B, [KEY_A], async () => assert.equal(decryptSecret(a), 'hola'));
    await withKeys(KEY_B, [], async () => assert.equal(decryptSecret(a), null, 'sin la anterior ya no se lee'));
  });
  const legacy = encryptSecret('viejo', { session: 'secreto-de-sesion-de-prueba' });
  await withKeys(KEY_A, [], async () => assert.equal(decryptSecret(legacy, { session: 'secreto-de-sesion-de-prueba' }), 'viejo'));
});

t('las credenciales de un canal se guardan cifradas y el código las sigue leyendo en claro', async () => {
  const ch = await store.createChannel({ account_id: h.accountId, chatbot_id: h.botId, type: 'telegram', name: 'Bot', config: { bot_token: '123:token-del-bot', secret: 'secreto-del-webhook' } });
  const raw = (await pool.query(`SELECT config FROM channels WHERE id = $1`, [ch.id])).rows[0].config;
  assert.match(raw.bot_token, /^v[12]\./);
  assert.doesNotMatch(JSON.stringify(raw), /token-del-bot|secreto-del-webhook/);
  const read = (await store.getChannel(ch.id))!;
  assert.equal(read.config.bot_token, '123:token-del-bot');
  assert.equal(read.config.secret, 'secreto-del-webhook');
  // Un canal de antes, en claro: al arrancar se cifra.
  await pool.query(`UPDATE channels SET config = config || '{"bot_token":"en-claro-de-antes"}'::jsonb WHERE id = $1`, [ch.id]);
  const { sealStoredChannelSecrets } = await import('../src/channel-secrets.js');
  assert.ok(await sealStoredChannelSecrets() >= 1);
  assert.match((await pool.query(`SELECT config->>'bot_token' AS v FROM channels WHERE id = $1`, [ch.id])).rows[0].v, /^v[12]\./);
  assert.equal((await store.getChannel(ch.id))!.config.bot_token, 'en-claro-de-antes');
  await store.deleteChannel(ch.id);
});

t('si un 2FA no se puede descifrar, no cambia nada', async () => {
  const before = await rows();
  const lia = before.find((r) => r.email === 'lia@clave.mx')!;
  await pool.query(`UPDATE users SET totp_secret = 'v1.dañado.dañado.dañado' WHERE email = 'lia@clave.mx'`);
  await assert.rejects(() => rekeySecrets(KEY_A), /^Error: No se pudo re-cifrar el 2FA de 1 persona: no se cambió nada$/);
  const afterRows = await rows();
  for (const r of before.filter((x) => x.email !== 'lia@clave.mx')) assert.deepEqual(afterRows.find((x) => x.email === r.email), r);
  await pool.query(`UPDATE users SET totp_secret = $1 WHERE email = 'lia@clave.mx'`, [lia.totp_secret]);
});

t('pasa todo a la llave nueva (2FA, canales) y lo ilegible se cuenta y se deja', async () => {
  const ch = await store.createChannel({ account_id: h.accountId, chatbot_id: h.botId, type: 'telegram', name: 'Bot 2', config: { bot_token: '456:otro-token' } });
  // Una credencial cifrada con una llave que ya no existe.
  await pool.query(`UPDATE channels SET config = config || jsonb_build_object('secret', $2::text) WHERE id = $1`, [ch.id, encryptSecret('x', { dataKey: 'llave-perdida-0123456789abcdef0123456789' })]);
  const before = await rows();
  const plain = before.map((r) => ({ email: r.email, secret: decryptSecret(r.totp_secret), pending: r.totp_pending && decryptSecret(r.totp_pending) }));
  assert.ok(plain.every((p) => p.secret), 'hoy se leen');
  const r = await rekeySecrets(KEY_A);
  assert.ok(r.rekeyed >= before.length + 1);
  assert.equal(r.unreadable, 1);
  for (const row of await rows()) {
    const p = plain.find((x) => x.email === row.email)!;
    assert.ok(row.totp_secret.startsWith(`v2.${keyId(KEY_A)}.`), row.email);
    await withKeys(KEY_A, [], async () => {
      assert.equal(decryptSecret(row.totp_secret), p.secret, row.email);
      assert.equal(row.totp_pending && decryptSecret(row.totp_pending), p.pending, row.email);
    });
  }
  assert.ok((await pool.query(`SELECT config->>'bot_token' AS v FROM channels WHERE id = $1`, [ch.id])).rows[0].v.startsWith(`v2.${keyId(KEY_A)}.`));
  await withKeys(KEY_A, [], async () => assert.equal((await store.getChannel(ch.id))!.config.bot_token, '456:otro-token'));
  await store.deleteChannel(ch.id);
});
