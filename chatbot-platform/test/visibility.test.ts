/** Visibilidad por asignación: el agente solo ve lo que tiene asignado; el administrador ve todo lo de su cuenta. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Req = Awaited<ReturnType<typeof h.loginAs>>;
let ana: Req;
let carmen: Req;
let anaId = '';
let betoId = '';
let carmenId = '';
let mine: { id: string; contact_id: string };
let theirs: { id: string; contact_id: string };
let free: { id: string; contact_id: string };
let serviceId = '';

const PASS = 'clave-visible-1';
async function newUser(name: string, role: 'agent' | 'admin') {
  const email = `${name}@visibilidad.test`;
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, email, name, password: PASS, role });
  assert.equal(r.statusCode, 200, r.body);
  return { id: r.json().id as string, req: await h.loginAs(email, PASS) };
}

/** Cliente nuevo que escribe; la conversación queda asignada a quien se indique (o sin asignar). */
async function conversationWith(phone: string, assigneeId: string | null) {
  await h.webhook('hola, quisiera información', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  await h.idle();
  const conv = await h.conversationFor(phone);
  if (assigneeId) assert.equal((await h.authed('PUT', `/api/conversations/${conv.id}/assign`, { user_id: assigneeId })).statusCode, 200);
  return conv as { id: string; contact_id: string };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Con gusto te ayudo.'] }));
  const a = await newUser('ana', 'agent');
  const b = await newUser('beto', 'agent');
  const c = await newUser('carmen', 'admin');
  anaId = a.id;
  betoId = b.id;
  carmenId = c.id;
  ana = a.req;
  carmen = c.req;
  mine = await conversationWith('5215577770001', anaId);
  theirs = await conversationWith('5215577770002', betoId);
  free = await conversationWith('5215577770003', null);
  const svc = await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Consulta' });
  assert.equal(svc.statusCode, 200, svc.body);
  serviceId = svc.json().id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el agente solo ve sus conversaciones; el administrador ve todas las de la cuenta', async () => {
  const seen = (await ana('GET', '/api/conversations')).json().map((c: { id: string }) => c.id);
  assert.deepEqual(seen, [mine.id]);
  const all = (await carmen('GET', '/api/conversations')).json().map((c: { id: string }) => c.id);
  assert.ok(all.includes(mine.id) && all.includes(theirs.id) && all.includes(free.id), JSON.stringify(all));
});

t('los filtros de persona no le amplían nada al agente', async () => {
  for (const q of ['assigned=none', `assigned=${betoId}`, 'include_playground=true']) {
    const ids = (await ana('GET', `/api/conversations?${q}`)).json().map((c: { id: string }) => c.id);
    assert.ok(!ids.includes(theirs.id) && !ids.includes(free.id), `${q}: ${JSON.stringify(ids)}`);
  }
});

t('una conversación ajena o sin asignar no existe para el agente: 404 en todo', async () => {
  const cases: [string, string, unknown?][] = [
    ['GET', `/api/conversations/${theirs.id}`],
    ['GET', `/api/conversations/${free.id}`],
    ['POST', `/api/conversations/${theirs.id}/send`, { text: 'hola' }],
    ['POST', `/api/conversations/${theirs.id}/takeover`],
    ['POST', `/api/conversations/${free.id}/close`],
    ['PUT', `/api/conversations/${theirs.id}/assign`, { user_id: 'me' }],
  ];
  for (const [method, url, body] of cases) {
    const r = await ana(method, url, body);
    assert.equal(r.statusCode, 404, `${method} ${url} → ${r.statusCode} ${r.body}`);
  }
});

t('el agente opera su conversación, pero no la pasa a otra persona', async () => {
  assert.equal((await ana('GET', `/api/conversations/${mine.id}`)).statusCode, 200);
  const r = await ana('PUT', `/api/conversations/${mine.id}/assign`, { user_id: betoId });
  assert.equal(r.statusCode, 403, r.body);
});

t('contactos: el agente solo edita los que tienen una conversación suya', async () => {
  assert.equal((await ana('PUT', `/api/contacts/${mine.contact_id}`, { name: 'Ana cliente' })).statusCode, 200);
  assert.equal((await ana('PUT', `/api/contacts/${theirs.contact_id}`, { name: 'Nadie' })).statusCode, 404);
});

t('estadísticas, exportaciones y datos de un contacto: solo administradores', async () => {
  assert.equal((await ana('GET', '/api/stats')).statusCode, 403);
  assert.equal((await ana('GET', '/api/export/contacts.csv')).statusCode, 403);
  assert.equal((await ana('GET', `/api/contacts/${mine.contact_id}/data`)).statusCode, 403);
  assert.equal((await carmen('GET', `/api/stats`)).statusCode, 200);
});

t('citas: el agente ve y cambia solo las suyas, y no agenda para otra persona', async () => {
  const mineApt = await h.authed('POST', '/api/appointments', { service_id: serviceId, slot: '2031-03-10T10:00', conversation_id: mine.id, customer_name: 'Ana cliente', force: true, notify_customer: false, assigned_user_id: anaId });
  assert.equal(mineApt.statusCode, 200, mineApt.body);
  const theirApt = await h.authed('POST', '/api/appointments', { service_id: serviceId, slot: '2031-03-11T10:00', conversation_id: theirs.id, customer_name: 'Beto cliente', force: true, notify_customer: false, assigned_user_id: betoId });
  assert.equal(theirApt.statusCode, 200, theirApt.body);

  const seen = (await ana('GET', '/api/appointments?from=2031-03-01T00:00:00Z&to=2031-03-31T00:00:00Z')).json().map((a: { id: string }) => a.id);
  assert.deepEqual(seen, [mineApt.json().id]);
  const admin = (await carmen('GET', '/api/appointments?from=2031-03-01T00:00:00Z&to=2031-03-31T00:00:00Z')).json();
  assert.equal(admin.length, 2);

  assert.equal((await ana('PUT', `/api/appointments/${theirApt.json().id}`, { notes: 'x' })).statusCode, 404);
  assert.equal((await ana('POST', `/api/appointments/${theirApt.json().id}/cancel`, {})).statusCode, 404);
  const other = await ana('POST', '/api/appointments', { service_id: serviceId, slot: '2031-03-12T10:00', conversation_id: mine.id, customer_name: 'Ana', force: false, assigned_user_id: betoId });
  assert.equal(other.statusCode, 403, other.body);
});

t('avisos: una conversación sin asignar solo avisa a administradores; el agente solo recibe lo suyo', async () => {
  const title = 'Aviso de visibilidad';
  await h.service.automator.alertTeam(h.accountId, { title, body: 'prueba', conversationId: theirs.id, kind: 'test' });
  const got = (await pool.query(`SELECT user_id FROM notifications WHERE title = $1 ORDER BY user_id`, [title])).rows.map((r) => r.user_id).sort();
  assert.deepEqual(got, [betoId, carmenId].sort());

  const title2 = 'Aviso de visibilidad 2';
  await h.service.automator.alertTeam(h.accountId, { title: title2, body: 'prueba', conversationId: free.id, kind: 'test' });
  const got2 = (await pool.query(`SELECT user_id FROM notifications WHERE title = $1`, [title2])).rows.map((r) => r.user_id);
  assert.deepEqual(got2, [carmenId]);
});

t('cuenta: el agente ve su cuenta sin totales ni datos del dueño', async () => {
  const accounts = (await ana('GET', '/api/accounts')).json();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].conversations, undefined);
  assert.equal(accounts[0].ai_cost_month, undefined);
  assert.equal(accounts[0].owner_email, undefined);
  const full = (await carmen('GET', '/api/accounts')).json();
  assert.notEqual(full[0].conversations, undefined);
});
