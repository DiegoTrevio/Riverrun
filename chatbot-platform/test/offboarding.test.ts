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
  for (const [name, email] of [['Mario', 'mario@imprenta.mx'], ['Nadia', 'nadia@imprenta.mx'], ['Otilia', 'otilia@imprenta.mx']]) {
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

t('el resumen es de quien puede manejar a esa persona', async () => {
  const nadiaId = (await pool.query(`SELECT id FROM users WHERE email = 'nadia@imprenta.mx'`)).rows[0].id;
  const mario = await h.loginAs('mario@imprenta.mx', PASS);
  assert.equal((await mario('GET', `/api/users/${nadiaId}/offboarding`)).json().code, 'owner_only', 'otro administrador no es suyo');
  const outsider = await h.addAccount({ name: 'Ajena', admin: { name: 'Ajeno', email: 'ajeno@otra.mx', password: PASS } });
  assert.ok(outsider.admin);
  const ajeno = await h.loginAs('ajeno@otra.mx', PASS);
  assert.equal((await ajeno('GET', `/api/users/${nadiaId}/offboarding`)).statusCode, 404);
});
