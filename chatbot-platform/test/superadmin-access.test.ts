/**
 * Acceso del superadministrador: ADMIN_PASSWORD solo sirve para crearlo la primera vez. Si cada arranque la volviera a
 * imponer, la contraseña inicial (que quedó en .env y se vio al instalar) regresaría aunque se cambiara en el panel.
 * Para recuperar el acceso hay un comando explícito (`./riverrun admin-password`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { bootstrapSuperadmin, resetSuperadminPassword } = await import('../src/auth.js');

const login = (email: string, password: string) => h.app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('reiniciar no devuelve la contraseña de .env a un superadmin que ya la cambió (ni lo reactiva)', async () => {
  const changed = await h.authed('PUT', '/api/me/password', { current: 'secreto123', password: 'Pz-157-Qx-357-Kv' });
  assert.equal(changed.statusCode, 200, changed.body);
  await bootstrapSuperadmin();
  assert.equal((await login('admin@test.mx', 'secreto123')).statusCode, 401, 'la contraseña de .env ya no entra');
  assert.equal((await login('admin@test.mx', 'Pz-157-Qx-357-Kv')).statusCode, 200);

  await pool.query(`UPDATE users SET active = false WHERE email = 'admin@test.mx'`);
  await bootstrapSuperadmin();
  assert.equal((await pool.query(`SELECT active FROM users WHERE email = 'admin@test.mx'`)).rows[0].active, false, 'desactivado sigue desactivado');
  await pool.query(`UPDATE users SET active = true WHERE email = 'admin@test.mx'`);
});

t('recuperar el acceso: contraseña nueva, cuenta activa y las sesiones abiertas se cierran', async () => {
  const opened = await login('admin@test.mx', 'Pz-157-Qx-357-Kv');
  const cookie = await h.sessionFrom(opened, 'admin@test.mx');
  await pool.query(`UPDATE users SET active = false WHERE email = 'admin@test.mx'`);
  const r = await resetSuperadminPassword('admin@test.mx');
  assert.equal(r.created, false);
  assert.ok(r.password.length >= 16, 'se genera una contraseña larga');
  assert.equal((await login('admin@test.mx', r.password)).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401, 'la sesión de antes se cerró');
});

t('recuperar el acceso también restablece su verificación en dos pasos y los intentos de su cuenta', async () => {
  const id = (await pool.query(`SELECT id FROM users WHERE email = 'admin@test.mx'`)).rows[0].id;
  const r0 = await resetSuperadminPassword('admin@test.mx');
  await h.sessionFrom(await login('admin@test.mx', r0.password), 'admin@test.mx'); // configura su app y entra
  await pool.query(`UPDATE users SET mfa_locked_until = now() + interval '1 hour' WHERE id = $1`, [id]);
  await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ('login-acct:admin@test.mx', 50, now() + interval '1 hour'), ($1, 50, now() + interval '1 hour')
    ON CONFLICT (key) DO UPDATE SET hits = 50, expires_at = now() + interval '1 hour'`, [`mfa-user:${id}`]);
  const r = await resetSuperadminPassword('admin@test.mx');
  const row = (await pool.query(`SELECT totp_secret, totp_pending, totp_enabled_at, mfa_locked_until FROM users WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(row, { totp_secret: null, totp_pending: null, totp_enabled_at: null, mfa_locked_until: null });
  assert.equal((await pool.query(`SELECT count(*)::int n FROM user_recovery_codes WHERE user_id = $1`, [id])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM rate_limits WHERE key IN ('login-acct:admin@test.mx', $1)`, [`mfa-user:${id}`])).rows[0].n, 0, 'sus contadores quedan en 0');
  assert.deepEqual((await login('admin@test.mx', r.password)).json(), { mfa: 'enroll' }, 'la configura al entrar');
});

t('recuperar el acceso crea al superadmin si no existe, pero no convierte en superadmin a otro usuario', async () => {
  const created = await resetSuperadminPassword('nuevo-jefe@test.mx', 'clave-elegida-larga');
  assert.equal(created.created, true);
  assert.equal((await login('nuevo-jefe@test.mx', 'clave-elegida-larga')).statusCode, 200);
  assert.equal((await pool.query(`SELECT role FROM users WHERE email = 'nuevo-jefe@test.mx'`)).rows[0].role, 'superadmin');

  const jefe = await h.loginAs('nuevo-jefe@test.mx', 'clave-elegida-larga');
  const acc = (await jefe('POST', '/api/accounts', { name: 'Negocio de Ana' })).json();
  assert.ok(acc.id);
  await h.addUser({ account_id: acc.id, name: 'Ana', email: 'ana@negocio.mx', password: 'Pz-109-Qx-309-Kv', role: 'admin' });
  await assert.rejects(() => resetSuperadminPassword('ana@negocio.mx'), /no es superadministrador/);
  assert.equal((await login('ana@negocio.mx', 'Pz-109-Qx-309-Kv')).statusCode, 200, 'su contraseña no cambió');
});
