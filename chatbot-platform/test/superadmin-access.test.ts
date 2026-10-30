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

t('recuperar el acceso crea al superadmin si no existe, pero no convierte en superadmin a otro usuario', async () => {
  const created = await resetSuperadminPassword('nuevo-jefe@test.mx', 'clave-elegida-larga');
  assert.equal(created.created, true);
  assert.equal((await login('nuevo-jefe@test.mx', 'clave-elegida-larga')).statusCode, 200);
  assert.equal((await pool.query(`SELECT role FROM users WHERE email = 'nuevo-jefe@test.mx'`)).rows[0].role, 'superadmin');

  const jefe = await h.loginAs('nuevo-jefe@test.mx', 'clave-elegida-larga');
  const acc = (await jefe('POST', '/api/accounts', { name: 'Negocio de Ana', admin: { name: 'Ana', email: 'ana@negocio.mx', password: 'Pz-109-Qx-309-Kv' } })).json();
  assert.ok(acc.id);
  await assert.rejects(() => resetSuperadminPassword('ana@negocio.mx'), /no es superadministrador/);
  assert.equal((await login('ana@negocio.mx', 'Pz-109-Qx-309-Kv')).statusCode, 200, 'su contraseña no cambió');
});
