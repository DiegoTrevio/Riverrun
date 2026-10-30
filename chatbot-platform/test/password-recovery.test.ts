/**
 * Recuperar la contraseña sin delatar correos ni bloquear a la persona: la respuesta es la misma exista o no el correo y
 * sale antes de mandar nada (el resto va en segundo plano); hay topes por conexión y por correo guardados en la base;
 * hasta tres enlaces vivos (sirve cualquiera; al usar uno, los demás ya no); cambiar la contraseña los invalida; y
 * restablecer por correo quita el bloqueo del 2FA.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-973-Qx-974-Kv';
let ip = 0;
const ids: Record<string, string> = {};
const forgot = (email: string) => h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: `10.55.0.${++ip}`, payload: { email } });
const reset = (token: string, password = 'Pz-971-Qx-972-Kv') => h.app.inject({ method: 'POST', url: '/api/reset-password', remoteAddress: `10.56.0.${++ip}`, payload: { token, password } });
const mailsTo = (to: string) => outbox.filter((m) => m.to === to && /#\/restablecer/.test(m.text));
const tokenIn = (text: string) => decodeURIComponent(/restablecer\?token=([^\s]+)/.exec(text)![1]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  const acc = await h.addAccount({ name: 'Taller Rosa', admin: { name: 'Rosa', email: 'rosa@recupera.mx', password: PASS } });
  ids.rosa = acc.admin!.id;
  for (const [name, email] of [['Sol', 'sol@recupera.mx'], ['Tita', 'tita@recupera.mx']]) {
    ids[name.toLowerCase()] = (await h.addUser({ account_id: acc.id, name, email, password: PASS, role: 'agent' })).id;
  }
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la respuesta es la misma exista o no el correo, y sale antes de mandar el correo', async () => {
  const before = mailsTo('rosa@recupera.mx').length;
  const real = await forgot('rosa@recupera.mx');
  assert.equal(mailsTo('rosa@recupera.mx').length, before, 'el correo sale en segundo plano, después de responder');
  const none = await forgot('nadie@recupera.mx');
  assert.equal(real.statusCode, 200);
  assert.equal(real.body, none.body);
  assert.deepEqual(real.json(), { ok: true });
  await waitFor(() => mailsTo('rosa@recupera.mx').length === before + 1);
});

t('el cuarto pedido del mismo correo en una hora no manda nada (y responde igual)', async () => {
  // Rosa ya pidió uno.
  for (let i = 0; i < 2; i++) assert.deepEqual((await forgot('ROSA@recupera.mx')).json(), { ok: true });
  await waitFor(() => mailsTo('rosa@recupera.mx').length === 3);
  const fourth = await forgot('rosa@recupera.mx');
  assert.deepEqual(fourth.json(), { ok: true });
  await sleep(300);
  assert.equal(mailsTo('rosa@recupera.mx').length, 3);
});

t('desde una conexión, a lo más 5 pedidos por hora', async () => {
  const same = (email: string) => h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: '10.57.0.1', payload: { email } });
  for (let i = 0; i < 5; i++) assert.equal((await same(`otro${i}@recupera.mx`)).statusCode, 200);
  assert.equal((await same('otro5@recupera.mx')).statusCode, 429);
});

t('tres enlaces pedidos seguidos sirven (cualquiera); al usar uno, los otros ya no', async () => {
  for (let i = 0; i < 3; i++) await forgot('sol@recupera.mx');
  await waitFor(() => mailsTo('sol@recupera.mx').length === 3);
  const tokens = mailsTo('sol@recupera.mx').map((m) => tokenIn(m.text));
  assert.equal(new Set(tokens).size, 3);
  assert.equal((await reset(tokens[1])).statusCode, 200, 'el de en medio sirve');
  assert.equal((await reset(tokens[0])).statusCode, 400);
  assert.equal((await reset(tokens[2])).statusCode, 400);
  // Un cuarto deja fuera al más viejo.
  const made = [];
  for (let i = 0; i < 4; i++) made.push(await store.createAuthToken(ids.tita, 'reset_password', 60));
  assert.equal((await reset(made[0])).statusCode, 400, 'el más viejo ya no');
  assert.equal((await reset(made[3])).statusCode, 200);
});

t('cambiar la contraseña en Mi perfil invalida los enlaces vivos', async () => {
  const token = await store.createAuthToken(ids.rosa, 'reset_password', 60);
  const rosa = await h.loginAs('rosa@recupera.mx', PASS);
  assert.equal((await rosa('PUT', '/api/me/password', { current: PASS, password: 'Pz-969-Qx-970-Kv' })).statusCode, 200);
  assert.equal((await reset(token)).statusCode, 400);
});

t('restablecer por correo quita el bloqueo del 2FA', async () => {
  await pool.query(`UPDATE users SET mfa_locked_until = now() + interval '1 hour' WHERE id = $1`, [ids.sol]);
  await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, 10, now() + interval '1 hour') ON CONFLICT (key) DO UPDATE SET hits = 10`, [`mfa-user:${ids.sol}`]);
  const token = await store.createAuthToken(ids.sol, 'reset_password', 60);
  assert.equal((await reset(token, 'Pz-967-Qx-968-Kv')).statusCode, 200);
  assert.equal((await pool.query(`SELECT mfa_locked_until FROM users WHERE id = $1`, [ids.sol])).rows[0].mfa_locked_until, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM rate_limits WHERE key = $1`, [`mfa-user:${ids.sol}`])).rows[0].n, 0);
});
