/**
 * Mi perfil → seguridad (estado, cambiar de app, códigos nuevos, dispositivos recordados) y «Restablecer 2FA» en Equipo:
 * quién puede restablecer a quién, qué borra y qué se cierra.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
import { currentStep, totpAt } from '../src/identity/totp.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-991-Qx-992-Kv';
type Client = Awaited<ReturnType<typeof h.loginAs>>;
let ana: Client; // administradora de la cuenta
let beto: Client; // agente de la misma cuenta
let otra: Client; // administradora de otra cuenta
const ids: Record<string, string> = {};
const mailTo = (email: string, subject: string) => outbox.some((m: any) => m.to === email && m.subject === subject);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const [name, email, role] of [['Ana', 'ana@perfil.mx', 'admin'], ['Beto', 'beto@perfil.mx', 'agent'], ['Cata', 'cata@perfil.mx', 'agent']] as const) {
    const r = await h.authed('POST', '/api/users', { account_id: h.accountId, name, email, password: PASS, role });
    assert.equal(r.statusCode, 200, r.body);
    ids[email] = r.json().id;
  }
  const other = await h.authed('POST', '/api/accounts', { name: 'Otra cuenta', admin: { name: 'Otra', email: 'otra@perfil.mx', password: PASS } });
  assert.equal(other.statusCode, 200, other.body);
  ana = await h.loginAs('ana@perfil.mx', PASS);
  beto = await h.loginAs('beto@perfil.mx', PASS);
  otra = await h.loginAs('otra@perfil.mx', PASS);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('Mi perfil muestra el estado del 2FA, los códigos que quedan y los dispositivos recordados', async () => {
  const s = (await ana('GET', '/api/me/security')).json();
  assert.ok(s.totp_enabled_at);
  assert.equal(s.recovery_remaining, 10);
  assert.deepEqual(s.devices, []);
  assert.equal(JSON.stringify(s).includes('totp_secret'), false);
});

t('códigos nuevos: los anteriores dejan de servir y llega el aviso', async () => {
  const first = (await ana('POST', '/api/me/2fa/recovery-codes')).json().recovery_codes as string[];
  assert.equal(first.length, 10);
  const second = (await ana('POST', '/api/me/2fa/recovery-codes')).json().recovery_codes as string[];
  assert.equal(second.length, 10);
  assert.equal((await ana('POST', '/api/2fa/step-up', { code: first[0] })).statusCode, 400, 'los anteriores ya no sirven');
  assert.equal((await ana('POST', '/api/2fa/step-up', { code: second[0] })).statusCode, 200);
  assert.equal((await ana('GET', '/api/me/security')).json().recovery_remaining, 9);
  await waitFor(() => mailTo('ana@perfil.mx', 'Generaste códigos de recuperación nuevos'));
});

t('cambiar de app: el código de la anterior ya no sirve y llega el aviso', async () => {
  const old = h.totpSecrets.get('ana@perfil.mx')!;
  const started = (await ana('POST', '/api/me/2fa/authenticator')).json();
  assert.match(started.secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(started.secret, old);
  assert.match(started.otpauth, /^otpauth:\/\/totp\//);
  assert.match(started.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal((await ana('POST', '/api/me/2fa/authenticator')).json().secret, started.secret, 'otra vez: el mismo pendiente');
  assert.equal((await ana('POST', '/api/me/2fa/authenticator/confirm', { code: '000000' })).statusCode, 400);
  // Mientras no confirma, la app anterior sigue sirviendo.
  assert.equal((await ana('POST', '/api/2fa/step-up', { code: await h.codeFor('ana@perfil.mx') })).statusCode, 200);
  await pool.query(`UPDATE users SET totp_last_step = 0 WHERE email = 'ana@perfil.mx'`);
  const r = await ana('POST', '/api/me/2fa/authenticator/confirm', { code: totpAt(started.secret, currentStep()) });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true });
  h.totpSecrets.set('ana@perfil.mx', started.secret);
  await pool.query(`UPDATE users SET totp_last_step = 0 WHERE email = 'ana@perfil.mx'`);
  assert.equal((await ana('POST', '/api/2fa/step-up', { code: totpAt(old, currentStep()) })).statusCode, 400, 'la app anterior ya no sirve');
  assert.equal((await ana('POST', '/api/2fa/step-up', { code: await h.codeFor('ana@perfil.mx') })).statusCode, 200);
  await waitFor(() => mailTo('ana@perfil.mx', 'Cambiaste tu app de verificación'));
});

t('olvidar un dispositivo recordado (solo los suyos)', async () => {
  const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'ana@perfil.mx', password: PASS } });
  const challenge = [login.headers['set-cookie']].flat().map(String).find((c) => c.startsWith('cp_mfa='))!.split(';')[0];
  const done = await h.app.inject({ method: 'POST', url: '/api/login/2fa', headers: { cookie: challenge, 'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/121.0' }, payload: { code: await h.codeFor('ana@perfil.mx'), remember: true } });
  assert.equal(done.statusCode, 200, done.body);
  const [device] = (await ana('GET', '/api/me/security')).json().devices;
  assert.equal(device.device, 'Firefox');
  assert.equal((await beto('DELETE', `/api/me/devices/${device.id}`)).statusCode, 404, 'el de otra persona no');
  assert.equal((await ana('DELETE', '/api/me/devices/no-es-un-id')).statusCode, 404);
  assert.deepEqual((await ana('DELETE', `/api/me/devices/${device.id}`)).json(), { ok: true });
  assert.deepEqual((await ana('GET', '/api/me/security')).json().devices, []);
});

t('Equipo: dice quién tiene el 2FA activo, sin nada del secreto', async () => {
  const users = (await ana('GET', '/api/users')).json();
  assert.ok(users.length >= 3);
  for (const u of users) {
    assert.equal(typeof u.mfa_enabled, 'boolean', u.email);
    assert.equal(Object.keys(u).some((k) => k.startsWith('totp') || k.startsWith('mfa_locked')), false, u.email);
  }
  assert.equal(users.find((u: any) => u.email === 'beto@perfil.mx').mfa_enabled, true);
  assert.equal(users.find((u: any) => u.email === 'cata@perfil.mx').mfa_enabled, false, 'todavía no entra');
});

t('restablecer el 2FA: quién puede', async () => {
  const beto2fa = `/api/users/${ids['beto@perfil.mx']}/2fa/reset`;
  assert.equal((await beto('POST', `/api/users/${ids['cata@perfil.mx']}/2fa/reset`)).statusCode, 403, 'un agente no');
  assert.equal((await otra('POST', beto2fa)).statusCode, 404, 'una administradora de otra cuenta no');
  const superId = (await h.authed('GET', '/api/me')).json().user.id;
  assert.equal((await ana('POST', `/api/users/${superId}/2fa/reset`)).statusCode, 404, 'una administradora nunca al superadmin');
  const self = await ana('POST', `/api/users/${ids['ana@perfil.mx']}/2fa/reset`);
  assert.equal(self.statusCode, 400);
  assert.deepEqual(self.json(), { error: 'Para cambiar tu propia app usa Mi perfil' });
  assert.equal((await h.authed('POST', `/api/users/${superId}/2fa/reset`)).statusCode, 400, 'ni el superadmin a sí mismo');
});

t('restablecer el 2FA: borra todo, cierra sus sesiones, avisa y al entrar lo configura otra vez', async () => {
  await pool.query(`UPDATE users SET mfa_locked_until = now() + interval '1 hour' WHERE email = 'beto@perfil.mx'`);
  assert.equal((await beto('GET', '/api/me')).statusCode, 200);
  const r = await ana('POST', `/api/users/${ids['beto@perfil.mx']}/2fa/reset`);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true });
  assert.equal((await beto('GET', '/api/me')).statusCode, 401, 'sus sesiones se cerraron');
  const row = (await pool.query(`SELECT totp_secret, totp_pending, totp_enabled_at, mfa_locked_until FROM users WHERE email = 'beto@perfil.mx'`)).rows[0];
  assert.deepEqual(row, { totp_secret: null, totp_pending: null, totp_enabled_at: null, mfa_locked_until: null });
  assert.equal((await pool.query(`SELECT count(*)::int n FROM user_recovery_codes WHERE user_id = $1`, [ids['beto@perfil.mx']])).rows[0].n, 0);
  await waitFor(() => outbox.some((m: any) => m.to === 'beto@perfil.mx' && m.subject === 'Se restableció tu verificación en dos pasos' && /Ana restableció/.test(m.text)));
  const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'beto@perfil.mx', password: PASS } });
  assert.deepEqual(login.json(), { mfa: 'enroll' });
  assert.equal((await ana('GET', '/api/users')).json().find((u: any) => u.email === 'beto@perfil.mx').mfa_enabled, false);
  beto = await h.loginAs('beto@perfil.mx', PASS);
  assert.equal((await beto('GET', '/api/me')).statusCode, 200, 'lo configura y entra');
});

t('las acciones de Mi perfil y restablecer piden verificación reciente', async () => {
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes' WHERE user_id = $1`, [ids['ana@perfil.mx']]);
  for (const [method, url] of [['POST', '/api/me/2fa/recovery-codes'], ['POST', '/api/me/2fa/authenticator'], ['POST', '/api/me/2fa/authenticator/confirm'], ['POST', `/api/users/${ids['cata@perfil.mx']}/2fa/reset`]]) {
    assert.equal((await ana(method, url, { code: '123456' })).json().code, 'step_up', `${method} ${url}`);
  }
  assert.equal((await ana('GET', '/api/me/security')).statusCode, 200, 'ver el estado no');
});

t('cambiar el rol de alguien cierra sus sesiones', async () => {
  const cata = await h.loginAs('cata@perfil.mx', PASS);
  assert.equal((await cata('GET', '/api/me')).statusCode, 200);
  assert.equal((await ana('POST', '/api/2fa/step-up', { code: await h.codeFor('ana@perfil.mx') })).statusCode, 200);
  assert.equal((await ana('PUT', `/api/users/${ids['cata@perfil.mx']}`, { name: 'Cata Ruiz' })).statusCode, 200);
  assert.equal((await cata('GET', '/api/me')).statusCode, 200, 'un cambio de nombre no las cierra');
  assert.equal((await ana('PUT', `/api/users/${ids['cata@perfil.mx']}`, { role: 'admin' })).statusCode, 200);
  assert.equal((await cata('GET', '/api/me')).statusCode, 401);
});
