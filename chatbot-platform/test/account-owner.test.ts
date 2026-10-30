/**
 * El dueño de la cuenta: uno solo, siempre un administrador activo de ella. Sin uno válido, el administrador activo más
 * antiguo (y queda guardado). Solo él maneja el dinero, la cuenta y a los demás administradores.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { accountOwner } = await import('../src/identity/ownership.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-995-Qx-996-Kv';
let acc: string;
const ids: Record<string, string> = {};
const ownerId = async () => (await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [acc])).rows[0].owner_user_id;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  const created = await h.authed('POST', '/api/accounts', { name: 'Taller Duarte', admin: { name: 'Dora', email: 'dora@duenos.mx', password: PASS } });
  assert.equal(created.statusCode, 200, created.body);
  acc = created.json().id;
  for (const [name, email, role] of [['Beto', 'beto@duenos.mx', 'admin'], ['Ciro', 'ciro@duenos.mx', 'agent']] as const) {
    const r = await h.authed('POST', '/api/users', { account_id: acc, name, email, password: PASS, role });
    assert.equal(r.statusCode, 200, r.body);
  }
  for (const r of (await pool.query(`SELECT id, email FROM users WHERE account_id = $1`, [acc])).rows) ids[r.email] = r.id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el dueño es quien guarda la cuenta', async () => {
  assert.equal(await ownerId(), ids['dora@duenos.mx']);
  const owner = await accountOwner(acc);
  assert.equal(owner?.id, ids['dora@duenos.mx']);
  assert.equal(owner?.name, 'Dora');
  assert.equal(owner?.email, 'dora@duenos.mx');
});

t('si el dueño guardado no es un administrador activo de la cuenta, lo es el administrador activo más antiguo (y queda guardado)', async () => {
  for (const wrong of [ids['ciro@duenos.mx'], (await pool.query(`SELECT id FROM users WHERE role = 'superadmin' LIMIT 1`)).rows[0].id]) {
    await pool.query(`UPDATE accounts SET owner_user_id = $2 WHERE id = $1`, [acc, wrong]);
    assert.equal((await accountOwner(acc))?.id, ids['dora@duenos.mx']);
    assert.equal(await ownerId(), ids['dora@duenos.mx'], 'queda guardado');
  }
  await pool.query(`UPDATE users SET active = false WHERE id = $1`, [ids['dora@duenos.mx']]);
  assert.equal((await accountOwner(acc))?.id, ids['beto@duenos.mx'], 'inactiva: el siguiente');
  await pool.query(`UPDATE users SET active = true WHERE id = $1`, [ids['dora@duenos.mx']]);
  await pool.query(`UPDATE accounts SET owner_user_id = $2 WHERE id = $1`, [acc, ids['dora@duenos.mx']]);
});

t('si la fila del dueño desaparece, el siguiente administrador queda como dueño', async () => {
  const other = (await h.authed('POST', '/api/accounts', { name: 'Otra', admin: { name: 'Olga', email: 'olga@duenos.mx', password: PASS } })).json().id;
  const second = (await h.authed('POST', '/api/users', { account_id: other, name: 'Pita', email: 'pita@duenos.mx', password: PASS, role: 'admin' })).json().id;
  await pool.query(`DELETE FROM users WHERE email = 'olga@duenos.mx'`);
  assert.equal((await accountOwner(other))?.id, second);
  assert.equal((await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [other])).rows[0].owner_user_id, second);
  const empty = (await h.authed('POST', '/api/accounts', { name: 'Vacía' })).json().id;
  assert.equal(await accountOwner(empty), null, 'sin administradores no hay dueño');
});

t('/api/me dice quién es el dueño', async () => {
  const beto = await h.loginAs('beto@duenos.mx', PASS);
  assert.deepEqual((await beto('GET', '/api/me')).json().owner, { id: ids['dora@duenos.mx'], name: 'Dora' });
  assert.equal((await h.authed('GET', '/api/me')).json().owner, null, 'el superadministrador no tiene cuenta propia');
});

t('nadie más calcula al dueño por su cuenta', async () => {
  const dir = path.resolve(import.meta.dirname, '../src');
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith(path.join('identity', 'ownership.ts')));
  const copies = files.filter((f) => /ORDER BY \((u\.)?id = (\$1|a\.owner_user_id)\) DESC/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(copies, []);
});
