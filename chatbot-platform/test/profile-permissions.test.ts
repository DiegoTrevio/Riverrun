import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool, store } from './harness.js';

const { notifyUsers } = await import('../src/automation/store.js');
const available = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !available && 'PostgreSQL no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let member: Awaited<ReturnType<typeof h.loginAs>>;
let a: any, b: any, user: any, botA: any, botB: any;
before(async () => {
  if (!available) return;
  h = await createHarness();
  a = (await h.authed('POST', '/api/accounts', { name: 'Perfil A', admin: { email: 'admin@perfil.test', password: 'perfil-admin-123' } })).json();
  b = (await h.authed('POST', '/api/accounts', { name: 'Perfil B' })).json();
  admin = await h.loginAs('admin@perfil.test', 'perfil-admin-123');
  botA = (await admin('POST', '/api/chatbots', { name: 'Asistente A' })).json();
  botB = (await h.authed('POST', '/api/chatbots', { account_id: b.id, name: 'Asistente B' })).json();
  user = (await admin('POST', '/api/users', { email: 'usuario@perfil.test', password: 'usuario-perfil-123', role: 'admin' })).json();
  member = await h.loginAs('usuario@perfil.test', 'usuario-perfil-123');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('un administrador solo gestiona su perfil y no puede cambiar su alcance ni dar acceso maestro', async () => {
  const bots = (await member('GET', `/api/chatbots?account_id=${b.id}`)).json();
  assert.deepEqual(bots.map((bot: any) => bot.id), [botA.id]);
  assert.equal((await member('GET', `/api/chatbots/${botB.id}`)).statusCode, 404);
  assert.equal((await admin('PUT', `/api/users/${user.id}`, { account_id: b.id })).statusCode, 403);
  assert.equal((await admin('PUT', `/api/users/${user.id}`, { role: 'superadmin' })).statusCode, 403);
  const own = await member('PUT', `/api/users/${user.id}`, { account_id: null });
  assert.equal(own.statusCode, 403);
  assert.equal((await store.getUser(user.id))!.account_id, a.id);
});

t('el maestro reasigna el perfil y una sesión abierta pierde acceso al anterior inmediatamente', async () => {
  await pool.query('UPDATE accounts SET owner_user_id = $1 WHERE id = $2', [user.id, a.id]);
  await notifyUsers(a.id, [user.id], { title: 'Datos privados A', body: 'Solo perfil A' });
  assert.equal((await member('GET', '/api/notifications')).json().unread, 1);
  const moved = await h.authed('PUT', `/api/users/${user.id}`, { account_id: b.id });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().account_id, b.id);
  // A mutation authorized against a stale profile must fail after reassignment.
  assert.equal(await store.updateUser(user.id, { active: false }, a.id), null);
  assert.equal(await store.deleteUser(user.id, a.id), false);
  assert.equal((await store.getUser(user.id))!.active, true);
  assert.equal((await member('GET', `/api/chatbots/${botA.id}`)).statusCode, 404);
  assert.equal((await member('GET', `/api/chatbots/${botB.id}`)).statusCode, 200);
  assert.equal((await member('GET', '/api/me')).json().account.id, b.id);
  assert.equal((await store.getAccount(a.id))!.owner_user_id, null);
  await notifyUsers(b.id, [user.id], { title: 'Datos B', body: 'Perfil nuevo' });
  const notifications = (await member('GET', '/api/notifications')).json();
  assert.equal(notifications.unread, 1);
  assert.deepEqual(notifications.items.map((n: any) => n.title), ['Datos B']);
  await member('POST', '/api/notifications/read', {});
  assert.equal((await member('GET', '/api/notifications')).json().unread, 0);
  assert.equal((await pool.query('SELECT read_at FROM notifications WHERE user_id = $1 AND account_id = $2', [user.id, a.id])).rows[0].read_at, null);
  const missing = await h.authed('PUT', `/api/users/${user.id}`, { account_id: crypto.randomUUID() });
  assert.equal(missing.statusCode, 404);
  assert.equal((await store.getUser(user.id))!.account_id, b.id);
  assert.equal((await h.authed('PUT', `/api/users/${user.id}`, { account_id: null })).statusCode, 400);
});

t('el operador solo atiende conversaciones y agenda de su perfil', async () => {
  assert.equal((await h.authed('PUT', `/api/users/${user.id}`, { role: 'agent' })).statusCode, 200);
  assert.equal((await member('POST', '/api/chatbots', { name: 'Prohibido' })).statusCode, 403);
  assert.equal((await member('GET', '/api/users')).statusCode, 403);
  assert.equal((await member('GET', '/api/conversations')).statusCode, 200);
  assert.equal((await member('GET', '/api/accounts')).json().length, 1);
});

t('el maestro puede promover un usuario existente sin cambiar su contraseña', async () => {
  const before = await store.getUserForLogin(user.email);
  const promoted = await h.authed('PUT', `/api/users/${user.id}`, { role: 'superadmin' });
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(promoted.json().account_id, null);
  assert.equal((await store.getUserForLogin(user.email))!.password_hash, before!.password_hash);
  assert.equal((await member('GET', '/api/accounts')).json().length, 2);
  assert.equal((await member('GET', `/api/chatbots/${botA.id}`)).statusCode, 200);
  assert.equal((await member('GET', `/api/chatbots/${botB.id}`)).statusCode, 200);
});

t('la migración da acceso maestro al correo de Diego verificado y conserva su contraseña', async () => {
  const created = await h.authed('POST', '/api/users', { account_id: a.id, email: 'diegoa.trevio@gmail.com', password: 'diego-prueba-123', role: 'admin' });
  assert.equal(created.statusCode, 200, created.body);
  const login = await h.loginAs('diegoa.trevio@gmail.com', 'diego-prueba-123');
  const before = await store.getUserForLogin('diegoa.trevio@gmail.com');
  const migration = fs.readFileSync('migrations/009_master_access.sql', 'utf8');
  await pool.query(migration);
  const me = (await login('GET', '/api/me')).json();
  assert.equal(me.user.role, 'superadmin');
  assert.equal(me.user.account_id, null);
  assert.equal((await login('GET', '/api/accounts')).json().length, 2);
  assert.equal((await store.getUserForLogin(before!.email))!.password_hash, before!.password_hash);
  await pool.query(migration);
  assert.equal((await store.grantMasterAccess('DIEGOA.TREVIO@GMAIL.COM')).role, 'superadmin');
});

t('provisionar no crea usuarios inexistentes ni concede acceso a un correo sin confirmar', async () => {
  await assert.rejects(store.grantMasterAccess('no-existe@perfil.test'), /no existe/);
  const pending = await store.createUser({ account_id: a.id, email: 'sin-confirmar@perfil.test', name: '', password_hash: 'hash-prueba', role: 'admin', verified: false });
  await assert.rejects(store.grantMasterAccess(pending.email), /Confirma el correo/);
  assert.equal((await store.getUser(pending.id))!.role, 'admin');
  const diego = await store.getUserForLogin('diegoa.trevio@gmail.com');
  await pool.query("UPDATE users SET role = 'admin', account_id = $1, email_verified_at = NULL WHERE id = $2", [a.id, diego!.id]);
  await pool.query(fs.readFileSync('migrations/009_master_access.sql', 'utf8'));
  assert.equal((await store.getUser(diego!.id))!.role, 'admin');
});

t('crear perfil y administrador es atómico si el correo ya está en uso', async () => {
  const response = await h.authed('POST', '/api/accounts', { name: 'Perfil incompleto', admin: { email: 'admin@perfil.test', password: 'perfil-admin-123' } });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal((await store.listAccounts()).length, 2);
});
