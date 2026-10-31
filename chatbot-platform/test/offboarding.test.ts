/**
 * Bajas: al desactivar o borrar a alguien se van con esa persona lo que creó y sigue abierto. Sus llaves de API se
 * revocan, sus webhooks se pausan con el motivo y sus invitaciones pendientes se cancelan. Lo de los demás no cambia, y
 * reactivarla no revive nada.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Api = Awaited<ReturnType<typeof h.loginAs>>;

const PASS = 'Pz-977-Qx-978-Kv';
let acc: string;
let owner: Api;

/** Lo que crea una persona: una llave, un webhook y una invitación pendiente. */
async function equip(email: string) {
  const api = await h.loginAs(email, PASS);
  const key = await api('POST', '/api/api-keys', { name: `Llave de ${email}`, scope: 'read' });
  assert.equal(key.statusCode, 200, key.body);
  const hook = await api('POST', '/api/webhook-endpoints', { url: `https://hooks.example.com/${email}`, events: ['*'] });
  assert.equal(hook.statusCode, 200, hook.body);
  const inv = await api('POST', '/api/invitations', { email: `invitado-de-${email}`, role: 'agent' });
  assert.equal(inv.statusCode, 200, inv.body);
  return { key: key.json().key as string, hook: hook.json().id as string, invite: inv.json().id as string };
}
const v1 = (key: string) => h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${key}` } });
const hookRow = async (id: string) => (await pool.query(`SELECT active, disabled_reason FROM webhook_endpoints WHERE id = $1`, [id])).rows[0];
const inviteOpen = async (id: string) => (await pool.query(`SELECT revoked_at IS NULL AND accepted_at IS NULL AS open FROM account_invitations WHERE id = $1`, [id])).rows[0].open;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  acc = (await h.addAccount({ name: 'Imprenta Ruiz', admin: { name: 'Rocío', email: 'rocio@imprenta.mx', password: PASS } })).id;
  for (const [name, email] of [['Mario', 'mario@imprenta.mx'], ['Nadia', 'nadia@imprenta.mx'], ['Otilia', 'otilia@imprenta.mx'], ['Pablo', 'pablo@imprenta.mx']]) {
    await h.addUser({ account_id: acc, name, email, password: PASS, role: 'admin' });
  }
  owner = await h.loginAs('rocio@imprenta.mx', PASS);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('desactivar a alguien revoca sus llaves, pausa sus webhooks y cancela sus invitaciones; lo de los demás sigue', async () => {
  const mario = await equip('mario@imprenta.mx');
  const nadia = await equip('nadia@imprenta.mx');
  const marioId = (await pool.query(`SELECT id FROM users WHERE email = 'mario@imprenta.mx'`)).rows[0].id;
  assert.equal((await v1(mario.key)).statusCode, 200);

  const summary = await owner('GET', `/api/users/${marioId}/offboarding`);
  assert.equal(summary.statusCode, 200, summary.body);
  assert.deepEqual(summary.json(), { api_keys: 1, webhooks: 1, invitations: 1 });

  assert.equal((await owner('PUT', `/api/users/${marioId}`, { active: false })).statusCode, 200);
  assert.equal((await v1(mario.key)).statusCode, 401, 'su llave ya no entra');
  assert.deepEqual(await hookRow(mario.hook), { active: false, disabled_reason: 'Lo creó Mario, que ya no está en el equipo' });
  assert.equal(await inviteOpen(mario.invite), false, 'su invitación ya no se acepta');
  assert.deepEqual((await owner('GET', `/api/users/${marioId}/offboarding`)).json(), { api_keys: 0, webhooks: 0, invitations: 0 });

  assert.equal((await v1(nadia.key)).statusCode, 200, 'lo de Nadia sigue');
  assert.deepEqual(await hookRow(nadia.hook), { active: true, disabled_reason: '' });
  assert.equal(await inviteOpen(nadia.invite), true);

  assert.equal((await owner('PUT', `/api/users/${marioId}`, { active: true })).statusCode, 200);
  assert.equal((await v1(mario.key)).statusCode, 401, 'reactivarlo no revive su llave');
  assert.equal((await hookRow(mario.hook)).active, false, 'ni su webhook');
  assert.equal(await inviteOpen(mario.invite), false, 'ni su invitación');
});

t('borrar a alguien hace lo mismo antes de que sus llaves y webhooks se queden sin autor', async () => {
  const otilia = await equip('otilia@imprenta.mx');
  const id = (await pool.query(`SELECT id FROM users WHERE email = 'otilia@imprenta.mx'`)).rows[0].id;
  assert.equal((await owner('DELETE', `/api/users/${id}`)).statusCode, 200);
  assert.equal((await v1(otilia.key)).statusCode, 401);
  assert.deepEqual(await hookRow(otilia.hook), { active: false, disabled_reason: 'Lo creó Otilia, que ya no está en el equipo' });
  assert.equal(await inviteOpen(otilia.invite), false);
});

t('pasar a alguien a otra cuenta también es una baja en la de antes', async () => {
  const pablo = await equip('pablo@imprenta.mx');
  const id = (await pool.query(`SELECT id FROM users WHERE email = 'pablo@imprenta.mx'`)).rows[0].id;
  const other = (await h.addAccount({ name: 'Imprenta Norte' })).id;
  const moved = await h.authed('PUT', `/api/users/${id}`, { account_id: other });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((await v1(pablo.key)).statusCode, 401, 'su llave de la cuenta de antes ya no entra');
  assert.deepEqual(await hookRow(pablo.hook), { active: false, disabled_reason: 'Lo creó Pablo, que ya no está en el equipo' });
  assert.equal(await inviteOpen(pablo.invite), false);
});

t('el resumen es de quien puede manejar a esa persona', async () => {
  const nadiaId = (await pool.query(`SELECT id FROM users WHERE email = 'nadia@imprenta.mx'`)).rows[0].id;
  const mario = await h.loginAs('mario@imprenta.mx', PASS);
  assert.equal((await mario('GET', `/api/users/${nadiaId}/offboarding`)).json().code, 'owner_only', 'otro administrador no es suyo');
  const outsider = await h.addAccount({ name: 'Ajena', admin: { name: 'Ajeno', email: 'ajeno@otra.mx', password: PASS } });
  assert.ok(outsider.admin);
  const ajeno = await h.loginAs('ajeno@otra.mx', PASS);
  assert.equal((await ajeno('GET', `/api/users/${nadiaId}/offboarding`)).statusCode, 404);
});

t('bajar a un administrador a agente revoca sus llaves, pausa sus webhooks y cancela sus invitaciones (ID-12)', async () => {
  const user = await h.addUser({ account_id: acc, name: 'Quique', email: 'quique@imprenta.mx', password: PASS, role: 'admin' });
  const quique = await equip('quique@imprenta.mx');
  assert.equal((await v1(quique.key)).statusCode, 200);
  const r = await owner('PUT', `/api/users/${user.id}`, { role: 'agent' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await v1(quique.key)).statusCode, 401, 'su llave ya no entra');
  assert.deepEqual(await hookRow(quique.hook), { active: false, disabled_reason: 'Lo creó Quique, que ya no está en el equipo' });
  assert.equal(await inviteOpen(quique.invite), false);
});

t('una llave cuyo creador ya no es administrador activo de la cuenta no entra, aunque no se haya revocado (ID-12)', async () => {
  await h.addUser({ account_id: acc, name: 'Rita', email: 'rita@imprenta.mx', password: PASS, role: 'admin' });
  const rita = await equip('rita@imprenta.mx');
  assert.equal((await v1(rita.key)).statusCode, 200);
  // Cambios hechos fuera de las rutas (una migración, un arreglo a mano): la llave igual deja de servir.
  await pool.query(`UPDATE users SET role = 'agent' WHERE email = 'rita@imprenta.mx'`);
  assert.equal((await v1(rita.key)).statusCode, 401);
  await pool.query(`UPDATE users SET role = 'admin', active = false WHERE email = 'rita@imprenta.mx'`);
  assert.equal((await v1(rita.key)).statusCode, 401);
  await pool.query(`UPDATE users SET active = true WHERE email = 'rita@imprenta.mx'`);
  assert.equal((await v1(rita.key)).statusCode, 200, 'administradora activa otra vez: entra');
});

t('la migración 099 revoca las llaves sin un administrador activo detrás y lo anota en la bitácora (ID-12)', async () => {
  await h.addUser({ account_id: acc, name: 'Sara', email: 'sara@imprenta.mx', password: PASS, role: 'admin' });
  const sara = await equip('sara@imprenta.mx');
  const live = await equip('rita@imprenta.mx');
  const keyId = (await pool.query(`SELECT id FROM api_keys WHERE name = 'Llave de sara@imprenta.mx'`)).rows[0].id;
  await pool.query(`UPDATE api_keys SET created_by = NULL WHERE id = $1`, [keyId]);
  const sql = (await import('node:fs')).readFileSync('migrations/099_orphan_api_keys.sql', 'utf8');
  await pool.query(sql);
  await pool.query(sql);
  assert.ok((await pool.query(`SELECT revoked_at FROM api_keys WHERE id = $1`, [keyId])).rows[0].revoked_at, 'revocada');
  assert.equal((await v1(sara.key)).statusCode, 401);
  assert.equal((await v1(live.key)).statusCode, 200, 'la de una administradora activa sigue');
  const logs = (await pool.query(`SELECT details FROM event_logs WHERE account_id = $1 AND message LIKE 'Llave de API revocada:%'`, [acc])).rows;
  assert.deepEqual(logs.map((l) => l.details.api_key_id), [keyId], 'una sola nota');
});
