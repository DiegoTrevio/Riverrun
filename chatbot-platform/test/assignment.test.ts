/** Reparto por turnos (round robin) de conversaciones y avisos internos al equipo. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const assignment = await import('../src/automation/assignment.js');

const team: { id: string; email: string; api: Awaited<ReturnType<typeof h.loginAs>> }[] = [];
let phoneN = 0;
const settings = (assignmentPatch: Record<string, unknown>) => h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { assignment: assignmentPatch });
const notices = async (userId: string, kind?: string) => (await pool.query(`SELECT title, kind FROM notifications WHERE user_id = $1 ${kind ? `AND kind = '${kind}'` : ''} ORDER BY id`, [userId])).rows;
const sortedIds = () => team.map((u) => u.id).sort();
/** Cliente nuevo que pide una persona: la regla lo transfiere y se dispara el reparto. */
async function handoffConversation() {
  const phone = `52155${String(8000000 + ++phoneN)}`;
  await h.webhook('quiero hablar con un humano', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone))?.assigned_user_id || (await h.conversationFor(phone))?.status === 'human', 8000);
  await h.idle();
  await h.service.automator.settleAll();
  // El reparto ocurre justo después de la transferencia: se le da un momento (sin fallar si nadie lo recibe).
  await waitFor(async () => !!(await h.conversationFor(phone))?.assigned_user_id, 1500).catch(() => undefined);
  return h.conversationFor(phone);
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola'] }));
  for (const n of ['ana', 'beto', 'carla']) {
    const email = `${n}@equipo.mx`;
    const r = await h.authed('POST', '/api/users', { account_id: h.accountId, email, name: n, password: 'clave-equipo-1', role: 'agent' });
    assert.equal(r.statusCode, 200, r.body);
    team.push({ id: r.json().id, email, api: await h.loginAs(email, 'clave-equipo-1') });
  }
  const rule = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Quiere una persona', trigger: { type: 'message_received', match: 'keywords', keywords: ['humano'] }, actions: [{ type: 'handoff', reason: 'Lo pidió el cliente' }] });
  assert.equal(rule.statusCode, 200, rule.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('sin reparto activado: la transferencia avisa a todo el equipo y nadie queda asignado', async () => {
  const c = await handoffConversation();
  assert.equal(c.status, 'human');
  assert.equal(c.assigned_user_id, null);
  for (const u of team) assert.ok((await notices(u.id, 'handoff')).length >= 1, 'todos reciben el aviso general');
});

t('con round robin: cada transferencia va a la siguiente persona y solo a ella le llega el aviso', async () => {
  assert.equal((await settings({ enabled: true, roles: ['agent'] })).statusCode, 200);
  const before = Object.fromEntries(await Promise.all(team.map(async (u) => [u.id, (await notices(u.id)).length])));
  const got: string[] = [];
  for (let i = 0; i < 6; i++) got.push((await handoffConversation()).assigned_user_id);
  const order = sortedIds();
  // El turno recorre a las tres personas en orden fijo y se repite
  const start = order.indexOf(got[0]);
  assert.ok(start >= 0);
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5].map((i) => order[(start + i) % 3]));
  for (const u of team) {
    const after = await notices(u.id);
    assert.equal(after.length - before[u.id], 2, 'dos conversaciones y dos avisos por persona');
    assert.ok(after.slice(before[u.id]).every((n) => n.kind === 'assignment'), 'solo avisos de asignación, no el general');
  }
});

t('quien está fuera de turno se salta, sin perder su lugar; al volver recibe de nuevo', async () => {
  const beto = team[1];
  assert.equal((await h.authed('PUT', `/api/users/${beto.id}`, { available: false })).statusCode, 200);
  const got: string[] = [];
  for (let i = 0; i < 4; i++) got.push((await handoffConversation()).assigned_user_id);
  assert.ok(!got.includes(beto.id), 'Beto no recibe nada mientras no esté disponible');
  assert.equal(new Set(got).size, 2);
  assert.deepEqual(got.slice(0, 2).sort(), got.slice(2).sort(), 'las otras dos se alternan por igual');
  // Él mismo puede marcarse disponible desde su perfil
  assert.equal((await beto.api('PUT', '/api/me', { available: true })).statusCode, 200);
  const next = [];
  for (let i = 0; i < 3; i++) next.push((await handoffConversation()).assigned_user_id);
  assert.ok(next.includes(beto.id));
  assert.equal(new Set(next).size, 3);
});

t('turnos simultáneos: 12 reparticiones a la vez quedan parejas, sin repetir ni saltar a nadie', async () => {
  const c = await h.conversationFor('52155' + String(8000000 + 1));
  const picks = await Promise.all(Array.from({ length: 12 }, () => assignment.assignRoundRobin({ id: c.id, account_id: h.accountId }, { scope: 'carrera', roles: ['agent'], reason: 'prueba' })));
  const counts = new Map<string, number>();
  for (const p of picks) counts.set(p!.id, (counts.get(p!.id) ?? 0) + 1);
  assert.deepEqual([...counts.values()].sort(), [4, 4, 4]);
});

t('si nadie está disponible, se avisa a todo el equipo como antes (no se pierde la transferencia)', async () => {
  for (const u of team) await h.authed('PUT', `/api/users/${u.id}`, { available: false });
  const before = (await notices(team[0].id, 'handoff')).length;
  const c = await handoffConversation();
  assert.equal(c.status, 'human');
  assert.equal(c.assigned_user_id, null);
  assert.equal((await notices(team[0].id, 'handoff')).length, before + 1);
  for (const u of team) await h.authed('PUT', `/api/users/${u.id}`, { available: true });
});

t('"avisar también a todo el equipo" y solo entre personas elegidas', async () => {
  await settings({ enabled: true, roles: ['agent'], user_ids: [team[0].id, team[2].id], notify_all: true });
  const beforeBeto = (await notices(team[1].id)).length;
  const picks = new Set<string>();
  for (let i = 0; i < 4; i++) picks.add((await handoffConversation()).assigned_user_id);
  assert.deepEqual([...picks].sort(), [team[0].id, team[2].id].sort(), 'solo entre las elegidas');
  await waitFor(async () => (await notices(team[1].id)).length - beforeBeto >= 4, 5000); // el aviso general sale justo después del de la persona asignada
  assert.equal((await notices(team[1].id)).length - beforeBeto, 4, 'Beto no recibe conversaciones, pero sí el aviso general');
  await settings({ enabled: true, roles: ['agent'], user_ids: [], notify_all: false });
});

t('regla "asignar": avisa a la persona del turno y puede pasar la conversación a una persona', async () => {
  await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Ventas por turnos', trigger: { type: 'message_received', match: 'keywords', keywords: ['cotizar'] }, actions: [{ type: 'assign', message: 'Cotización para {{cliente}}', roles: ['agent'], take_over: true }] });
  const phone = '5215590000001';
  await h.webhook('quiero cotizar', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone))?.assigned_user_id, 8000);
  const c = await h.conversationFor(phone);
  assert.ok(team.some((u) => u.id === c.assigned_user_id));
  assert.equal(c.status, 'human', 'take_over pasó la conversación a una persona');
  const n = await notices(c.assigned_user_id, 'assignment');
  assert.ok(n.some((x) => /Te asignaron/.test(x.title)));
});

t('regla "alertar" por turnos: un solo aviso por evento, rotando', async () => {
  await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Aviso rotativo', trigger: { type: 'message_received', match: 'keywords', keywords: ['catalogo'] }, actions: [{ type: 'alert_team', message: 'Piden catálogo', roles: ['agent'], round_robin: true }] });
  const before = Object.fromEntries(await Promise.all(team.map(async (u) => [u.id, (await notices(u.id, 'alert')).length])));
  for (let i = 0; i < 3; i++) await h.webhook('mándame el catalogo', { phone: `52155900001${i}` });
  await waitFor(async () => { await h.service.automator.settleAll(); const tot = (await Promise.all(team.map(async (u) => (await notices(u.id, 'alert')).length - before[u.id]))).reduce((a, b) => a + b, 0); return tot >= 3; }, 8000);
  for (const u of team) assert.equal((await notices(u.id, 'alert')).length - before[u.id], 1, 'cada persona recibió uno');
});

t('asignación manual: permisos, validaciones y filtros de la lista', async () => {
  const c = await h.conversationFor('5215590000001');
  const [ana, beto] = team;
  // Un agente solo se asigna a sí mismo
  assert.equal((await ana.api('PUT', `/api/conversations/${c.id}/assign`, { user_id: beto.id })).statusCode, 403);
  assert.equal((await ana.api('PUT', `/api/conversations/${c.id}/assign`, { user_id: 'next' })).statusCode, 403);
  assert.equal((await ana.api('PUT', `/api/conversations/${c.id}/assign`, { user_id: 'me' })).statusCode, 200);
  const mine = (await ana.api('GET', '/api/conversations?assigned=me')).json();
  assert.ok(mine.length >= 1 && mine.every((x: any) => x.assigned_user_id === ana.id));
  assert.ok((await ana.api('GET', '/api/conversations?assigned=none')).json().every((x: any) => x.assigned_user_id === null));
  const detail = (await ana.api('GET', `/api/conversations/${c.id}`)).json();
  assert.equal(detail.assignee.id, ana.id);
  // El administrador sí asigna a otros, y Beto recibe el aviso
  assert.equal((await h.authed('PUT', `/api/conversations/${c.id}/assign`, { user_id: beto.id })).statusCode, 200);
  assert.ok((await notices(beto.id, 'assignment')).length >= 1);
  // Ana ya no es la dueña: no puede soltarla
  assert.equal((await ana.api('PUT', `/api/conversations/${c.id}/assign`, { user_id: null })).statusCode, 403);
  // Una persona de otra cuenta no es válida
  const other = await h.authed('POST', '/api/accounts', { name: 'Otra', admin: { name: 'Otra', email: 'otra@otra.mx', password: 'clave-segura-1' } });
  const foreign = (await pool.query(`SELECT id FROM users WHERE email = 'otra@otra.mx'`)).rows[0].id;
  assert.equal((await h.authed('PUT', `/api/conversations/${c.id}/assign`, { user_id: foreign })).statusCode, 400);
  void other;
  assert.equal((await h.authed('PUT', `/api/conversations/${c.id}/assign`, { user_id: 'next' })).statusCode, 200);
  assert.equal((await h.authed('PUT', `/api/conversations/${c.id}/assign`, { user_id: null })).statusCode, 200);
  // Quien se desactiva deja de tener conversaciones abiertas asignadas
  await h.authed('PUT', `/api/conversations/${c.id}/assign`, { user_id: beto.id });
  await h.authed('PUT', `/api/users/${beto.id}`, { active: false });
  assert.equal((await h.conversationFor('5215590000001')).assigned_user_id, null);
  await h.authed('PUT', `/api/users/${beto.id}`, { active: true });
});

t('tomar una conversación sin dueña te la asigna', async () => {
  const phone = '5215590000099';
  await h.webhook('hola', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  const c = await h.conversationFor(phone);
  assert.equal(c.assigned_user_id, null);
  assert.equal((await team[2].api('POST', `/api/conversations/${c.id}/takeover`)).statusCode, 200);
  assert.equal((await h.conversationFor(phone)).assigned_user_id, team[2].id);
});

t('aviso interno manual: a todos, a un rol, a personas, por turnos; validaciones y permisos', async () => {
  const count = async (u: { id: string }) => (await notices(u.id, 'notice')).length;
  const b = await Promise.all(team.map(count));
  const r1 = await h.authed('POST', '/api/notifications/send', { account_id: h.accountId, title: 'Junta a las 5', body: 'Sala 2', link: '#/conversations' });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.ok(r1.json().sent_to >= 3);
  assert.deepEqual(await Promise.all(team.map(count)), b.map((x) => x + 1));
  // Por turnos: uno por aviso, rotando
  const b2 = await Promise.all(team.map(count));
  for (let i = 0; i < 3; i++) {
    const r = await h.authed('POST', '/api/notifications/send', { account_id: h.accountId, title: `Turno ${i}`, roles: ['agent'], round_robin: true });
    assert.equal(r.json().sent_to, 1);
  }
  assert.deepEqual(await Promise.all(team.map(count)), b2.map((x) => x + 1));
  // Personas concretas (las ajenas se ignoran)
  const foreign = (await pool.query(`SELECT id FROM users WHERE email = 'otra@otra.mx'`)).rows[0].id;
  const r3 = await h.authed('POST', '/api/notifications/send', { account_id: h.accountId, title: 'Solo Ana', user_ids: [team[0].id, foreign] });
  assert.deepEqual(r3.json().recipients, [team[0].id]);
  // Validaciones y permisos
  assert.equal((await h.authed('POST', '/api/notifications/send', { account_id: h.accountId, title: '' })).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/notifications/send', { account_id: h.accountId, title: 'x', link: 'https://malo.com' })).statusCode, 400, 'el enlace debe ser una ruta del panel');
  assert.equal((await team[0].api('POST', '/api/notifications/send', { title: 'x' })).statusCode, 403);
  // Nadie disponible en el turno
  for (const u of team) await h.authed('PUT', `/api/users/${u.id}`, { available: false });
  assert.equal((await h.authed('POST', '/api/notifications/send', { account_id: h.accountId, title: 'x', roles: ['agent'], round_robin: true })).statusCode, 409);
  for (const u of team) await h.authed('PUT', `/api/users/${u.id}`, { available: true });
});

t('API v1: equipo, avisos y asignación con llave de escritura (la de lectura no puede)', async () => {
  const read = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Lee', scope: 'read' })).json().key;
  const write = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Zapier', scope: 'write' })).json().key;
  const call = (key: string, method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url: `/api/v1${url}`, payload: payload as any, headers: { authorization: `Bearer ${key}` } });
  const tm = (await call(read, 'GET', '/team')).json().data;
  assert.ok(tm.length >= 3 && tm.every((u: any) => u.role === 'admin' || u.role === 'agent'));
  assert.equal((await call(read, 'POST', '/notifications', { title: 'x' })).statusCode, 403);
  const before = (await notices(team[1].id, 'notice')).length;
  const r = await call(write, 'POST', '/notifications', { title: 'Desde Zapier', body: 'Nuevo lead', user_ids: [team[1].id] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await notices(team[1].id, 'notice')).length, before + 1);
  const c = await h.conversationFor('5215590000099');
  assert.equal((await call(write, 'PUT', `/conversations/${c.id}/assign`, { user_id: team[0].id })).statusCode, 200);
  assert.equal((await call(write, 'PUT', `/conversations/${c.id}/assign`, { user_id: 'next' })).statusCode, 200);
  assert.equal((await call(read, 'GET', '/conversations?limit=200')).json().data.find((x: any) => x.id === c.id).assigned_user_id !== undefined, true);
  assert.equal((await call(write, 'PUT', `/conversations/${c.id}/assign`, { user_id: '00000000-0000-4000-8000-000000000000' })).statusCode, 400);
});
