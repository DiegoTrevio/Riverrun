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
  const created = await h.addAccount({ name: 'Taller Duarte', admin: { name: 'Dora', email: 'dora@duenos.mx', password: PASS } });
  acc = created.id;
  for (const [name, email, role] of [['Beto', 'beto@duenos.mx', 'admin'], ['Ciro', 'ciro@duenos.mx', 'agent']] as const) {
    const r = await h.addUser({ account_id: acc, name, email, password: PASS, role });
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
  const other = (await h.addAccount({ name: 'Otra', admin: { name: 'Olga', email: 'olga@duenos.mx', password: PASS } })).id;
  const second = (await h.addUser({ account_id: other, name: 'Pita', email: 'pita@duenos.mx', password: PASS, role: 'admin' })).id;
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

t('la lista del equipo marca al dueño (también para el superadministrador)', async () => {
  const beto = await h.loginAs('beto@duenos.mx', PASS);
  for (const list of [(await beto('GET', '/api/users')).json(), (await h.authed('GET', `/api/users?account_id=${acc}`)).json()]) {
    assert.deepEqual(list.filter((u: any) => u.is_owner).map((u: any) => u.email), ['dora@duenos.mx']);
  }
  await pool.query(`UPDATE accounts SET owner_user_id = NULL WHERE id = $1`, [acc]);
  const fixed = (await beto('GET', '/api/users')).json();
  assert.deepEqual(fixed.filter((u: any) => u.is_owner).map((u: any) => u.email), ['dora@duenos.mx'], 'sin dueño guardado: el más antiguo, ya guardado');
});

t('nadie más calcula al dueño por su cuenta', async () => {
  const dir = path.resolve(import.meta.dirname, '../src');
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith(path.join('identity', 'ownership.ts')));
  const copies = files.filter((f) => /ORDER BY \((u\.)?id = (\$1|a\.owner_user_id)\) DESC/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(copies, []);
});

/* ------------------------------ Poderes del dueño ------------------------------ */

const ID = '00000000-0000-4000-8000-000000000000';
/** Lo que solo hace el dueño (o el superadministrador). */
export const OWNER_ROUTES: [string, string][] = [
  ['GET', '/api/billing/fiscal'],
  ['PUT', '/api/billing/fiscal'],
  ['GET', `/api/billing/invoices/${ID}/pdf`],
  ['POST', '/api/billing/checkout'],
  ['POST', '/api/billing/confirm'],
  ['POST', '/api/billing/portal'],
  ['POST', '/api/billing/change'],
  ['POST', '/api/billing/payment-method'],
  ['POST', '/api/billing/cancel'],
  ['GET', '/api/account/export.zip'],
  ['POST', '/api/account/deletion'],
  ['DELETE', '/api/account/deletion'],
  ['POST', '/api/account/transfer'],
];
const OWNER_ONLY = { error: 'Solo el dueño de la cuenta (Dora) puede hacer esto', code: 'owner_only' };
const age = (email: string) => pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]);

t('un administrador que no es dueño no llega a lo del dueño (aunque su código sea viejo: no le pide el código)', async () => {
  const beto = await h.loginAs('beto@duenos.mx', PASS);
  await age('beto@duenos.mx');
  for (const [method, url] of OWNER_ROUTES) {
    const r = await beto(method, url, {});
    assert.equal(r.statusCode, 403, `${method} ${url}: ${r.body}`);
    assert.deepEqual(r.json(), OWNER_ONLY, `${method} ${url}`);
  }
  assert.equal((await beto('GET', '/api/billing')).statusCode, 200, 'el plan sí lo ve');
});

t('el dueño y el superadministrador (con la cuenta en ?account_id) sí llegan', async () => {
  const dora = await h.loginAs('dora@duenos.mx', PASS);
  await h.authed('POST', '/api/2fa/step-up', { code: await h.codeFor('admin@test.mx') });
  for (const [method, url] of OWNER_ROUTES) {
    for (const [who, call, u] of [['dueño', dora, url], ['superadmin', h.authed, `${url}?account_id=${acc}`]] as const) {
      const r = await call(method, u, {});
      const code = (() => { try { return r.json().code; } catch { return undefined; } })(); // el ZIP no es JSON
      assert.notEqual(code, 'owner_only', `${who} → ${method} ${url}: ${r.body.slice(0, 200)}`);
      assert.notEqual(r.statusCode, 403, `${who} → ${method} ${url}: ${r.body.slice(0, 200)}`);
    }
  }
});

t('un administrador no toca al dueño ni a otros administradores; sí a los agentes', async () => {
  const eva = (await h.addUser({ account_id: acc, name: 'Eva', email: 'eva@duenos.mx', password: PASS, role: 'admin' })).id;
  const beto = await h.loginAs('beto@duenos.mx', PASS);
  for (const target of [ids['dora@duenos.mx'], eva]) {
    for (const [method, url, body] of [
      ['PUT', `/api/users/${target}`, { name: 'Otro nombre' }],
      ['PUT', `/api/users/${target}`, { active: false }],
      ['PUT', `/api/users/${target}`, { role: 'agent' }],
      ['DELETE', `/api/users/${target}`, undefined],
      ['POST', `/api/users/${target}/2fa/reset`, {}],
    ] as const) {
      const r = await beto(method, url, body);
      assert.deepEqual(r.json(), OWNER_ONLY, `${method} ${url} ${JSON.stringify(body)}`);
    }
  }
  const ciro = ids['ciro@duenos.mx'];
  assert.equal((await beto('PUT', `/api/users/${ciro}`, { name: 'Ciro Ruiz' })).statusCode, 200);
  assert.equal((await beto('PUT', `/api/users/${ciro}`, { active: false })).statusCode, 200);
  assert.equal((await beto('PUT', `/api/users/${ciro}`, { active: true })).statusCode, 200);
  assert.deepEqual((await beto('PUT', `/api/users/${ciro}`, { role: 'admin' })).json(), OWNER_ONLY, 'hacer administrador a alguien es del dueño');
  assert.deepEqual((await beto('POST', '/api/invitations', { email: 'nueva-admin@duenos.mx', role: 'admin' })).json(), OWNER_ONLY, 'invitar a un administrador también');
  assert.equal((await beto('POST', '/api/invitations', { email: 'nuevo-agente@duenos.mx', role: 'agent' })).statusCode, 200, 'invitar a un agente no');
  assert.deepEqual((await beto('POST', '/api/users', { account_id: acc, name: 'Fito', email: 'fito@duenos.mx', password: PASS, role: 'admin' })).json(), OWNER_ONLY);
});

t('nadie desactiva, degrada, mueve ni borra al dueño: primero transfiere', async () => {
  const dora = ids['dora@duenos.mx'];
  const other = (await h.authed('POST', '/api/accounts', { name: 'Destino' })).json().id;
  await h.authed('POST', '/api/2fa/step-up', { code: await h.codeFor('admin@test.mx') });
  for (const [method, body] of [['PUT', { active: false }], ['PUT', { role: 'agent' }], ['PUT', { account_id: other }], ['DELETE', undefined]] as const) {
    const r = await h.authed(method, `/api/users/${dora}`, body);
    assert.equal(r.statusCode, 400, `${method} ${JSON.stringify(body)}: ${r.body}`);
    assert.equal(r.json().error, 'Primero transfiere la cuenta a otro administrador');
  }
  const owner = await h.loginAs('dora@duenos.mx', PASS);
  assert.equal((await owner('PUT', `/api/users/${ids['beto@duenos.mx']}`, { name: 'Beto Duarte' })).statusCode, 200, 'el dueño sí maneja a los administradores');
});
