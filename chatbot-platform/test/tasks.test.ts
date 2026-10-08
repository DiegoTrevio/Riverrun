/** Pendientes y notas por contacto: se crean y marcan desde el panel o una regla, y siguen la visibilidad del contacto. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Req = Awaited<ReturnType<typeof h.loginAs>>;
const PASS = 'clave-tareas-1';
let adminId = '';
let luisId = '';
let luis: Req;

async function newAgent(name: string) {
  const email = `${name}@tareas.test`;
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, email, name, password: PASS, role: 'agent' });
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
  adminId = (await h.authed('GET', '/api/me')).json().user.id;
  const luisUser = await newAgent('luis');
  luisId = luisUser.id;
  luis = luisUser.req;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el panel crea un pendiente y una nota; la conversación muestra ambos', async () => {
  const conv = await conversationWith('5215540000101', null);
  const url = `/api/contacts/${conv.contact_id}/tasks`;
  const pendiente = await h.authed('POST', url, { kind: 'pendiente', body: 'Confirmar la cotización', due_on: '2030-01-15', conversation_id: conv.id });
  assert.equal(pendiente.statusCode, 200, pendiente.body);
  assert.equal(pendiente.json().created_via, 'panel');
  assert.equal(pendiente.json().created_by, adminId);
  assert.equal(pendiente.json().due_on, '2030-01-15');
  assert.equal(pendiente.json().conversation_id, conv.id);
  const nota = await h.authed('POST', url, { kind: 'nota', body: 'Prefiere WhatsApp por la tarde', conversation_id: conv.id });
  assert.equal(nota.statusCode, 200, nota.body);
  assert.equal(nota.json().due_on, null);
  const list = (await h.authed('GET', url)).json();
  assert.deepEqual(list.map((x: any) => x.kind), ['pendiente', 'nota'], 'primero el pendiente con fecha');
  const detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
  assert.equal(detail.tasks.length, 2);
});

t('marcar como hecho guarda quién y cuándo; reabrirlo lo limpia; una nota no se marca', async () => {
  const conv = await conversationWith('5215540000102', null);
  const url = `/api/contacts/${conv.contact_id}/tasks`;
  const created = (await h.authed('POST', url, { kind: 'pendiente', body: 'Llamar al proveedor' })).json();
  const done = await h.authed('PATCH', `/api/tasks/${created.id}`, { status: 'hecha' });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().status, 'hecha');
  assert.equal(done.json().done_by, adminId);
  assert.ok(done.json().done_at);
  const reopened = await h.authed('PATCH', `/api/tasks/${created.id}`, { status: 'abierta' });
  assert.equal(reopened.json().status, 'abierta');
  assert.equal(reopened.json().done_by, null);
  assert.equal(reopened.json().done_at, null);
  const note = (await h.authed('POST', url, { kind: 'nota', body: 'Cliente frecuente' })).json();
  assert.equal((await h.authed('PATCH', `/api/tasks/${note.id}`, { status: 'hecha' })).statusCode, 400, 'las notas no se marcan');
  assert.equal((await h.authed('PATCH', `/api/tasks/${note.id}`, { body: 'Cliente muy frecuente' })).json().body, 'Cliente muy frecuente');
});

t('datos inválidos se rechazan', async () => {
  const a = await conversationWith('5215540000103', null);
  const b = await conversationWith('5215540000104', null);
  const url = `/api/contacts/${a.contact_id}/tasks`;
  assert.equal((await h.authed('POST', url, { kind: 'pendiente', body: '   ' })).statusCode, 400, 'texto vacío');
  assert.equal((await h.authed('POST', url, { kind: 'pendiente', body: 'x'.repeat(1001) })).statusCode, 400, 'texto demasiado largo');
  assert.equal((await h.authed('POST', url, { kind: 'pendiente', body: 'Algo', due_on: '15/01/2030' })).statusCode, 400, 'fecha con otro formato');
  assert.equal((await h.authed('POST', url, { kind: 'nota', body: 'Algo', due_on: '2030-01-15' })).statusCode, 400, 'una nota no tiene fecha');
  assert.equal((await h.authed('POST', url, { kind: 'pendiente', body: 'Algo', conversation_id: b.id })).statusCode, 400, 'la conversación es de otro contacto');
});

t('un agente solo ve y atiende los pendientes de los contactos que tiene asignados', async () => {
  const suyo = await conversationWith('5215540000105', luisId);
  const ajeno = await conversationWith('5215540000106', null);
  const ajenoTask = (await h.authed('POST', `/api/contacts/${ajeno.contact_id}/tasks`, { kind: 'pendiente', body: 'Revisar pago' })).json();
  assert.equal((await luis('GET', `/api/contacts/${ajeno.contact_id}/tasks`)).statusCode, 404, 'un contacto que no es suyo no existe para él');
  assert.equal((await luis('POST', `/api/contacts/${ajeno.contact_id}/tasks`, { kind: 'nota', body: 'Hola' })).statusCode, 404);
  assert.equal((await luis('PATCH', `/api/tasks/${ajenoTask.id}`, { status: 'hecha' })).statusCode, 404);
  assert.equal((await luis('GET', `/api/contacts/${suyo.contact_id}/tasks`)).statusCode, 200);
  // En su contacto puede anotar y completar; solo borra lo que él creó.
  const nota = (await luis('POST', `/api/contacts/${suyo.contact_id}/tasks`, { kind: 'nota', body: 'Pidió factura' })).json();
  assert.equal(nota.created_by, luisId);
  const pendiente = (await h.authed('POST', `/api/contacts/${suyo.contact_id}/tasks`, { kind: 'pendiente', body: 'Enviar factura' })).json();
  assert.equal((await luis('PATCH', `/api/tasks/${pendiente.id}`, { status: 'hecha' })).json().done_by, luisId);
  assert.equal((await luis('DELETE', `/api/tasks/${pendiente.id}`)).statusCode, 403, 'no borra lo que creó otra persona');
  assert.equal((await luis('DELETE', `/api/tasks/${nota.id}`)).statusCode, 200);
  assert.equal((await h.authed('DELETE', `/api/tasks/${pendiente.id}`)).statusCode, 200, 'el administrador borra cualquiera');
});

t('una regla de automatización crea el pendiente vinculado a la conversación, con fecha límite', async () => {
  const rule = await h.authed('POST', '/api/automations', {
    account_id: h.accountId,
    name: 'Presupuesto → seguimiento',
    trigger: { type: 'message_received', match: 'keywords', keywords: ['presupuesto'] },
    actions: [{ type: 'create_task', kind: 'pendiente', body: 'Dar seguimiento a {{cliente}}: "{{mensaje}}"', due_days: 3 }],
  });
  assert.equal(rule.statusCode, 200, rule.body);
  const phone = '5215540000107';
  await h.webhook('quiero un presupuesto', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  await h.idle();
  await h.service.automator.settleAll();
  const conv = await h.conversationFor(phone);
  const [task] = (await h.authed('GET', `/api/contacts/${conv.contact_id}/tasks`)).json();
  assert.ok(task, 'la regla creó el pendiente');
  assert.equal(task.created_via, 'regla');
  assert.equal(task.created_by, null);
  assert.equal(task.conversation_id, conv.id);
  assert.match(task.body, /^Dar seguimiento a .+: "quiero un presupuesto"$/);
  // Vence en unos días; el margen cubre la diferencia de zona horaria con la cuenta.
  const days = (Date.parse(task.due_on) - Date.now()) / 86_400_000;
  assert.ok(days > 1.5 && days < 4.5, `vence en ${days.toFixed(2)} días`);
});

t('la exportación de datos del cliente incluye sus pendientes y notas', async () => {
  const conv = await conversationWith('5215540000108', null);
  assert.equal((await h.authed('POST', `/api/contacts/${conv.contact_id}/tasks`, { kind: 'nota', body: 'Dato para la exportación' })).statusCode, 200);
  const data = (await h.authed('GET', `/api/contacts/${conv.contact_id}/data`)).json();
  assert.ok(data.tasks.some((x: any) => x.body === 'Dato para la exportación'));
});

t('borrar al cliente borra también sus pendientes y notas', async () => {
  const conv = await conversationWith('5215540000109', null);
  assert.equal((await h.authed('POST', `/api/contacts/${conv.contact_id}/tasks`, { kind: 'nota', body: 'Se borra con el cliente' })).statusCode, 200);
  assert.equal((await h.authed('DELETE', `/api/contacts/${conv.contact_id}`)).statusCode, 200);
  const left = await pool.query('SELECT count(*)::int AS n FROM contact_tasks WHERE contact_id = $1', [conv.contact_id]);
  assert.equal(left.rows[0].n, 0);
});
