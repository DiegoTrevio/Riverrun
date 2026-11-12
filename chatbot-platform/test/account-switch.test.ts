/**
 * La cuenta maestra cambia de perfil de negocio desde el selector del panel: solo ella puede, cada entrada queda en la
 * bitácora de seguridad (la de la plataforma y la del propio negocio) y un vaivén entre perfiles no la llena de filas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-418-Qx-518-Kv';
const entries = async (accountId: string) => (await pool.query(`SELECT * FROM security_events WHERE kind = 'account.entered' AND account_id = $1 ORDER BY id`, [accountId])).rows;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  await h.addUser({ account_id: h.accountId, email: 'duena@cambio.mx', name: 'Dueña', password: PASS, role: 'admin' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la cuenta maestra entra a un perfil: queda anotado con quién, desde dónde y a qué negocio', async () => {
  const r = await h.authed('POST', `/api/accounts/${h.accountId}/switch`);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.id, h.accountId);
  assert.ok(body.name, 'devuelve el nombre del perfil para mostrarlo');
  const rows = await entries(h.accountId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'admin@test.mx');
  assert.ok(rows[0].user_id);
  assert.equal(rows[0].target, body.name);
});

t('entrar y salir varias veces del mismo perfil deja una sola fila por media hora', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await h.authed('POST', `/api/accounts/${h.accountId}/switch`)).statusCode, 200);
  assert.equal((await entries(h.accountId)).length, 1);
});

t('el negocio ve en su bitácora que la cuenta maestra entró', async () => {
  const duena = await h.loginAs('duena@cambio.mx', PASS);
  const r = await duena('GET', '/api/security-events?kind=account.entered');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().length, 1);
  assert.equal(r.json()[0].email, 'admin@test.mx');
});

t('solo la cuenta maestra puede cambiar de perfil', async () => {
  const duena = await h.loginAs('duena@cambio.mx', PASS);
  assert.equal((await duena('POST', `/api/accounts/${h.accountId}/switch`)).statusCode, 403);
});

t('un perfil que no existe (o un id mal escrito) responde 404 y no se anota', async () => {
  const before = (await pool.query(`SELECT count(*)::int n FROM security_events WHERE kind = 'account.entered'`)).rows[0].n;
  assert.equal((await h.authed('POST', '/api/accounts/00000000-0000-4000-8000-000000000000/switch')).statusCode, 404);
  assert.equal((await h.authed('POST', '/api/accounts/no-es-un-id/switch')).statusCode, 404);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM security_events WHERE kind = 'account.entered'`)).rows[0].n, before);
});

t('pedir un perfil con account_id sin pasar por el selector también queda anotado (y una persona normal no)', async () => {
  const other = await h.addAccount({ name: 'Negocio sin selector', admin: { email: 'dueno@sinselector.mx', password: PASS } });
  assert.equal((await h.authed('GET', `/api/contacts?account_id=${other.id}`)).statusCode, 200);
  const rows = await entries(other.id);
  assert.equal(rows.length, 1, 'la lectura con account_id deja su fila');
  assert.equal(rows[0].email, 'admin@test.mx');
  assert.equal(rows[0].target, 'Negocio sin selector');
  await h.authed('GET', `/api/contacts?account_id=${other.id}`);
  assert.equal((await entries(other.id)).length, 1, 'repetir dentro de la media hora no agrega filas');

  const dueno = await h.loginAs('dueno@sinselector.mx', PASS);
  await dueno('GET', `/api/contacts?account_id=${h.accountId}`);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM security_events WHERE kind = 'account.entered' AND email = 'dueno@sinselector.mx'`)).rows[0].n, 0);
});

t('un account_id en la dirección no esconde otro distinto en el cuerpo: se anotan los dos', async () => {
  const a = await h.addAccount({ name: 'Negocio A de la dirección' });
  const b = await h.addAccount({ name: 'Negocio B del cuerpo' });
  await h.authed('POST', `/api/services?account_id=${a.id}`, { account_id: b.id, name: 'Corte' });
  assert.equal((await entries(a.id)).length, 1);
  assert.equal((await entries(b.id)).length, 1);
});
