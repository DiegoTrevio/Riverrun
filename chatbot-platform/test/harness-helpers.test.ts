/**
 * Los ayudantes del arnés crean usuarios como el producto: por invitación que la persona acepta eligiendo su contraseña
 * (nadie escribe la contraseña de otro). Quedan con su correo verificado y pueden entrar.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const PASS = 'Pz-991-Qx-992-Kv';

before(async () => {
  if (ok) h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('addUser: por invitación aceptada, con su correo verificado; puede entrar', async () => {
  await h.createBot();
  const u = await h.addUser({ name: 'Ana', email: 'ana@ayudantes.mx', password: PASS, role: 'agent' });
  assert.equal(u.account_id, h.accountId, 'por omisión, la cuenta del arnés');
  assert.equal(u.role, 'agent');
  const row = (await pool.query(`SELECT name, email_verified_at FROM users WHERE id = $1`, [u.id])).rows[0];
  assert.equal(row.name, 'Ana');
  assert.ok(row.email_verified_at);
  const inv = (await pool.query(`SELECT accepted_user_id, invited_by FROM account_invitations WHERE lower(email) = 'ana@ayudantes.mx'`)).rows[0];
  assert.deepEqual(inv, { accepted_user_id: u.id, invited_by: null });
  const ana = await h.loginAs('ana@ayudantes.mx', PASS);
  assert.equal((await ana('GET', '/api/me')).json().user.id, u.id);
});

t('addUser: sin nombre queda sin nombre, y el teléfono para avisos se guarda', async () => {
  const u = await h.addUser({ email: 'sin-nombre@ayudantes.mx', password: PASS, role: 'agent', phone: '5215550001111', notify_whatsapp: true });
  const row = (await pool.query(`SELECT name, phone, notify_whatsapp FROM users WHERE id = $1`, [u.id])).rows[0];
  assert.deepEqual(row, { name: '', phone: '5215550001111', notify_whatsapp: true });
});

t('addAccount con administrador: es el único administrador y el dueño', async () => {
  const acc = await h.addAccount({ name: 'Taller Ayudante', admin: { name: 'Toño', email: 'tono@ayudantes.mx', password: PASS } });
  assert.equal(acc.admin?.role, 'admin');
  assert.equal(acc.admin?.account_id, acc.id);
  const owner = (await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [acc.id])).rows[0].owner_user_id;
  const { accountOwner } = await import('../src/identity/ownership.js');
  assert.equal((await accountOwner(acc.id))?.id, acc.admin?.id);
  assert.equal(owner, acc.admin?.id, 'al aceptar como administrador de una cuenta sin dueño, queda guardado como dueño');
  const empty = await h.addAccount({ name: 'Sin Nadie' });
  assert.equal(empty.admin, undefined);
});

t('addSuperadmin: otro superadministrador, sin cuenta y sin dejar cuentas de paso', async () => {
  const before = (await pool.query(`SELECT count(*)::int AS n FROM accounts`)).rows[0].n;
  const s = await h.addSuperadmin('otro-maestro@ayudantes.mx', PASS);
  assert.equal(s.role, 'superadmin');
  assert.equal(s.account_id, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM accounts`)).rows[0].n, before);
  const otro = await h.loginAs('otro-maestro@ayudantes.mx', PASS);
  assert.equal((await otro('GET', '/api/me')).json().user.role, 'superadmin');
});

t('cada aceptación entra desde otra conexión: muchas seguidas no topan el límite', async () => {
  for (let i = 0; i < 12; i++) await h.addUser({ email: `lote-${i}@ayudantes.mx`, password: PASS, role: 'agent' });
});
