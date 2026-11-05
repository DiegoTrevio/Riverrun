/**
 * Sin verificación en dos pasos (MFA_REQUIRED apagado, como viene por defecto): se entra solo con correo y contraseña,
 * las acciones delicadas no piden código y el Copiloto no propone acciones que se confirman con código. Las demás pruebas
 * corren con la verificación obligatoria (el arnés la enciende si nadie la fijó).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MFA_REQUIRED = 'false';
const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { config } = await import('../src/config.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let ip = 0;
const PASS = 'Pz-961-Qx-962-Kv';
const cookieOf = (r: any, name: string) => [r.headers['set-cookie'] ?? []].flat().map(String).find((c: string) => c.startsWith(`${name}=`))?.split(';')[0];
const login = (email: string, password = PASS) => h.app.inject({ method: 'POST', url: '/api/login', remoteAddress: `10.81.0.${++ip}`, payload: { email, password } });
const as = (cookie: string) => (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, headers: { cookie }, payload: payload as any });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la configuración viene sin verificación en dos pasos y sin acciones con código del Copiloto', async () => {
  assert.equal(config.mfa.required, false);
  assert.equal(config.copilot.codeActions, false);
});

t('correo y contraseña abren la sesión directo, sin reto ni QR', async () => {
  await h.addUser({ account_id: h.accountId, name: 'Sin Código', email: 'sincodigo@mfa.mx', password: PASS, role: 'agent' });
  const r = await login('sincodigo@mfa.mx');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().ok, true);
  assert.equal(r.json().mfa, undefined, 'no pide segundo paso');
  assert.equal(cookieOf(r, 'cp_mfa'), undefined, 'sin cookie de reto');
  const session = cookieOf(r, 'cp_session');
  assert.ok(session && !session.endsWith('='), 'abre la sesión');
  const me = await as(session!)('GET', '/api/me');
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.email, 'sincodigo@mfa.mx');
  assert.equal(me.json().mfa_required, false);
  // La contraseña equivocada sigue sin entrar.
  assert.equal((await login('sincodigo@mfa.mx', 'otra-clave-mala-123')).statusCode, 401);
});

t('quien ya tenía su app configurada también entra solo con la contraseña', async () => {
  await h.addUser({ account_id: h.accountId, name: 'Con App', email: 'conapp@mfa.mx', password: PASS, role: 'agent' });
  await pool.query(`UPDATE users SET totp_enabled_at = now() WHERE email = 'conapp@mfa.mx'`);
  const r = await login('conapp@mfa.mx');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().ok, true);
  assert.ok(cookieOf(r, 'cp_session'));
});

t('las acciones delicadas no piden código', async () => {
  await h.addUser({ account_id: h.accountId, name: 'Cambia', email: 'cambia@mfa.mx', password: PASS, role: 'agent' });
  const call = as(cookieOf(await login('cambia@mfa.mx'), 'cp_session')!);
  assert.deepEqual((await call('GET', '/api/2fa/recent')).json(), { recent: true });
  const changed = await call('PUT', '/api/me/password', { current: PASS, password: 'Pz-963-Qx-964-Kv' });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.notEqual(changed.json().code, 'step_up');
});

t('el registro entra directo y el dueño transfiere la cuenta a un administrador sin 2FA', async () => {
  const s = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.81.1.1', payload: { name: 'Mara', company: 'Florería Mara', business_type: 'servicios', email: 'mara@floreria.mx', password: PASS, accept_terms: true } });
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().mfa, undefined, 'no pide configurar la app');
  const owner = as(cookieOf(s, 'cp_session')!);
  const accountId = s.json().account.id;
  const admin = await h.addUser({ account_id: accountId, name: 'Hereda', email: 'hereda@floreria.mx', password: PASS, role: 'admin' });
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [admin.id]);
  assert.equal((await pool.query(`SELECT totp_enabled_at FROM users WHERE id = $1`, [admin.id])).rows[0].totp_enabled_at, null);
  const moved = await owner('POST', '/api/account/transfer', { user_id: admin.id });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [accountId])).rows[0].owner_user_id, admin.id);
});
