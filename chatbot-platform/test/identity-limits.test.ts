/**
 * Límites de intentos al entrar, guardados en la base: 8 contraseñas malas por conexión (IPv6 por /64) en 15 minutos, 10
 * por cuenta en una hora (salvo desde un dispositivo recordado de esa persona) y 10 códigos malos por persona en una hora
 * (bloquea la verificación una hora y avisa). Un tope no se salta mandando muchas peticiones a la vez.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-981-Qx-982-Kv';
const login = (email: string, password: string, remoteAddress: string, cookie = '') =>
  h.app.inject({ method: 'POST', url: '/api/login', remoteAddress, payload: { email, password }, headers: cookie ? { cookie } : {} });
const cookiesOf = (r: any) => [r.headers['set-cookie'] ?? []].flat().map(String).map((c: string) => c.split(';')[0]).filter((c: string) => !c.endsWith('='));
const newUser = async (email: string) => {
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Ivo', email, password: PASS, role: 'agent' });
  assert.equal(r.statusCode, 200, r.body);
};
const ACCOUNT_LIMIT = 'Demasiados intentos con esta cuenta. Entra desde un dispositivo recordado o recupera tu contraseña por correo.';

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('8 contraseñas malas desde una /64 la bloquean; otra conexión sigue entrando', async () => {
  await newUser('ivo@lim.mx');
  for (let i = 0; i < 8; i++) {
    const r = await login(`nadie${i}@lim.mx`, 'clave-que-no-es-9', i % 2 ? '2001:db8:1:2::1' : '2001:db8:1:2::ffff');
    assert.equal(r.statusCode, 401, `intento ${i + 1}`);
  }
  const blocked = await login('ivo@lim.mx', PASS, '2001:db8:1:2:abcd::7');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, 'Demasiados intentos, espera 15 minutos');
  assert.equal((await login('ivo@lim.mx', PASS, '10.9.9.9')).statusCode, 200);
});

t('muchas a la vez no se saltan el tope: solo 8 se revisan', async () => {
  const all = await Promise.all(Array.from({ length: 12 }, (_, i) => login(`rafaga${i}@lim.mx`, 'clave-que-no-es-9', '10.70.70.70')));
  const codes = all.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 401).length, 8, codes.join(','));
  assert.equal(codes.filter((c) => c === 429).length, 4, codes.join(','));
});

t('10 contraseñas malas a una cuenta la bloquean, salvo desde su dispositivo recordado', async () => {
  await newUser('jo@lim.mx');
  // Su navegador de siempre: configura el 2FA y pide recordar el dispositivo.
  const first = await login('jo@lim.mx', PASS, '10.71.0.1');
  const jar = cookiesOf(first);
  const challenge = jar.join('; ');
  const e = await h.app.inject({ method: 'GET', url: '/api/2fa/enroll', headers: { cookie: challenge } });
  h.totpSecrets.set('jo@lim.mx', e.json().secret);
  const done = await h.app.inject({ method: 'POST', url: '/api/2fa/enroll', headers: { cookie: challenge }, payload: { code: await h.codeFor('jo@lim.mx') } });
  const c2 = cookiesOf(await login('jo@lim.mx', PASS, '10.71.0.1', cookiesOf(done).join('; ')));
  const remembered = await h.app.inject({ method: 'POST', url: '/api/login/2fa', remoteAddress: '10.71.0.1', headers: { cookie: [...cookiesOf(done), ...c2].join('; ') }, payload: { code: await h.codeFor('jo@lim.mx'), remember: true } });
  assert.equal(remembered.statusCode, 200, remembered.body);
  const trustCookie = cookiesOf(remembered).find((c: string) => c.startsWith('cp_trust='))!;
  assert.ok(trustCookie);

  for (let i = 0; i < 10; i++) assert.equal((await login('jo@lim.mx', 'clave-que-no-es-9', `10.72.0.${i}`)).statusCode, 401);
  const blocked = await login('jo@lim.mx', PASS, '10.73.0.1');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, ACCOUNT_LIMIT);
  const fromTrusted = await login('jo@lim.mx', PASS, '10.73.0.2', trustCookie);
  assert.equal(fromTrusted.statusCode, 200, fromTrusted.body);
  assert.equal(fromTrusted.json().ok, true);
});

t('10 códigos malos bloquean la verificación una hora y avisan por correo', async () => {
  await newUser('kai@lim.mx');
  await h.loginAs('kai@lim.mx', PASS); // configura la app
  const challenge = async () => cookiesOf(await login('kai@lim.mx', PASS, '10.74.0.1')).join('; ');
  const code = (cookie: string, c: string) => h.app.inject({ method: 'POST', url: '/api/login/2fa', headers: { cookie }, payload: { code: c } });
  let c = await challenge();
  for (let i = 0; i < 5; i++) assert.equal((await code(c, '111111')).statusCode, 400);
  c = await challenge();
  for (let i = 0; i < 4; i++) assert.equal((await code(c, '111111')).statusCode, 400);
  const tenth = await code(c, '111111');
  assert.equal(tenth.statusCode, 429);
  assert.equal(tenth.json().error, 'Bloqueamos la verificación por una hora por demasiados intentos. Si no fuiste tú, cambia tu contraseña.');
  await waitFor(() => outbox.some((m) => m.to === 'kai@lim.mx' && m.subject === 'Bloqueamos tu verificación por intentos fallidos'), 3000);
  assert.equal((await code(await challenge(), await h.codeFor('kai@lim.mx'))).statusCode, 429, 'bloqueada aunque el código sea bueno');
  assert.ok((await pool.query(`SELECT mfa_locked_until > now() + interval '50 minutes' AS locked FROM users WHERE email = 'kai@lim.mx'`)).rows[0].locked);
});

t('la contraseña actual equivocada al cambiarla cuenta como intento a la cuenta', async () => {
  await newUser('lia@lim.mx');
  const lia = await h.loginAs('lia@lim.mx', PASS);
  for (let i = 0; i < 10; i++) assert.equal((await lia('PUT', '/api/me/password', { current: 'clave-que-no-es-9', password: 'Pz-983-Qx-984-Kv' })).statusCode, 400);
  const r = await lia('PUT', '/api/me/password', { current: PASS, password: 'Pz-983-Qx-984-Kv' });
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, ACCOUNT_LIMIT);
});
