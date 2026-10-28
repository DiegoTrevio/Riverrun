/**
 * Lienzo de flujos de punta a punta: se dibuja, se publica (una regla y sus flujos, en una transacción), el cliente
 * escribe la palabra, recibe el mensaje con botones y su elección lo lleva a la rama dibujada. Volver a publicar
 * actualiza lo mismo (sin duplicar), pausar lo detiene y borrar el lienzo borra lo que publicó.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['respuesta de la IA'] }));
  const s = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  assert.equal((await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { consent: { ...s.consent, require_for_campaigns: false } })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const node = (id: string, type: string, data: Record<string, unknown>, y = 0) => ({ id, type, x: 0, y, data });
const edge = (from: string, port: string, to: string) => ({ id: `${from}-${port.replace(':', '_')}-${to}`, from, port, to });
const promo = (text = 'Hola {{nombre}}, ¿te interesa la promo?', withBranch = true) => ({
  settings: { business_hours_only: false, stop_on_reply: true },
  nodes: [
    node('t1', 'trigger', { trigger: { type: 'message_received', match: 'keywords', keywords: ['promo'] }, stop_ai: true }),
    node('m1', 'message', { text, buttons: [{ id: 'b1', label: 'Ver precios', reply: 'Claro 👇' }, { id: 'b2', label: 'Hablar con alguien' }] }, 200),
    node('w1', 'wait', { value: 1, unit: 'days' }, 400),
    node('m2', 'message', { text: '¿Pudiste verlo?' }, 600),
    node('p1', 'message', { text: 'Precios: corte $150, barba $90.' }, 200),
    node('hd', 'action', { action: 'handoff' }, 400),
    node('n1', 'note', { text: 'Pedir foto nueva al equipo' }, 800),
  ],
  edges: [edge('t1', 'out', 'm1'), edge('m1', 'out', 'w1'), edge('w1', 'out', 'm2'), ...(withBranch ? [edge('m1', 'b:b1', 'p1')] : []), edge('m1', 'b:b2', 'hd')],
});

const create = async (name: string, board: unknown) => {
  const r = await h.authed('POST', '/api/flow-boards', { account_id: h.accountId, name, board });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const save = async (id: string, revision: number, body: Record<string, unknown>) => h.authed('PUT', `/api/flow-boards/${id}`, { revision, ...body });
const publish = async (id: string, revision: number) => h.authed('POST', `/api/flow-boards/${id}/publish`, { revision });
const owned = async (id: string) => ({
  rules: (await pool.query(`SELECT id, active, trigger, actions, stop_ai FROM automations WHERE board_id = $1`, [id])).rows,
  flows: (await pool.query(`SELECT id, name, active, steps FROM sequences WHERE board_id = $1 ORDER BY name`, [id])).rows,
});
const textsTo = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text);

let boardId = '';
let revision = 0;

t('publicar crea la regla y los flujos; el cliente escribe la palabra, elige un botón y recibe la rama', async () => {
  const b = await create('Promo de octubre', promo());
  boardId = b.id; revision = b.revision;
  assert.deepEqual(b.problems.filter((p: any) => !p.warning), [], 'el lienzo recién creado no tiene pendientes');

  const r = await publish(boardId, revision);
  assert.equal(r.statusCode, 200, r.body);
  const pub = r.json();
  assert.equal(pub.sequences.length, 2);
  const { rules, flows } = await owned(boardId);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].stop_ai, true);
  assert.deepEqual(rules[0].actions, [{ type: 'start_sequence', sequence_id: pub.sequences[0].id }]);
  const main = flows.find((f) => f.name === 'Promo de octubre');
  const branch = flows.find((f) => f.name !== 'Promo de octubre');
  assert.equal(main.steps.length, 2);
  assert.deepEqual(main.steps[0].buttons.map((x: any) => [x.label, x.action, x.sequence_id]), [['Ver precios', 'start_sequence', branch.id], ['Hablar con alguien', 'handoff', null]]);
  assert.deepEqual([main.steps[1].delay_value, main.steps[1].delay_unit], [1, 'days']);
  assert.equal((await h.authed('GET', '/api/flow-boards')).json()[0].published_revision, revision);

  const phone = '5215530000001';
  const aiBefore = h.calls.length;
  await h.webhook('quiero la promo', { phone });
  await h.idle();
  await h.fastForward();
  await waitFor(() => textsTo(phone).length === 1);
  assert.equal(h.calls.length, aiBefore, 'el flujo contesta: la IA no responde ese mensaje');
  assert.match(textsTo(phone)[0], /^Hola Ana, ¿te interesa la promo\?\n\n1\. Ver precios\n2\. Hablar con alguien/);

  await h.webhook('1', { phone });
  await h.idle();
  await h.fastForward();
  await waitFor(() => textsTo(phone).length === 3);
  assert.deepEqual(textsTo(phone).slice(1).map((x) => x.split('\n')[0]), ['Claro 👇', 'Precios: corte $150, barba $90.']);
});

t('volver a publicar actualiza lo mismo; quitar una rama borra su flujo; nada queda duplicado', async () => {
  const before = await owned(boardId);
  // Mover tarjetas no es un cambio por publicar; cambiar un mensaje, sí.
  const moved = promo();
  moved.nodes.forEach((n) => { n.x += 40; n.y += 16; });
  const m = await save(boardId, revision, { board: moved });
  assert.equal(m.statusCode, 200, m.body);
  assert.equal(m.json().pending, false, 'solo se movieron tarjetas');
  revision = m.json().revision;
  const s = await save(boardId, revision, { board: promo('Nuevo texto de la promo', false) });
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().pending, true, 'cambió un mensaje y se quitó una rama');
  revision = s.json().revision;
  const r = await publish(boardId, revision);
  assert.equal(r.statusCode, 200, r.body);
  const now = await owned(boardId);
  assert.equal(now.rules.length, 1);
  assert.equal(now.rules[0].id, before.rules[0].id, 'la misma regla');
  assert.equal(now.flows.length, 1, 'la rama que se quitó ya no existe');
  assert.equal(now.flows[0].id, before.flows.find((f) => f.name === 'Promo de octubre').id, 'el mismo flujo principal');
  assert.equal(now.flows[0].steps[0].text, 'Nuevo texto de la promo');
  assert.equal(now.flows[0].steps[0].buttons[0].action, 'end', 'un botón sin línea termina el flujo');
  assert.equal((await h.authed('GET', `/api/flow-boards/${boardId}`)).json().pending, false, 'publicado: nada pendiente');
});

t('pendientes, otra pestaña y pausa: no se publica con errores, no se pisa otra versión y pausar apaga todo', async () => {
  const bad = await create('Incompleto', { nodes: [node('t1', 'trigger', { trigger: { type: 'message_received', match: 'keywords', keywords: [] } }), node('m1', 'message', { text: '' })], edges: [edge('t1', 'out', 'm1')] });
  const r = await publish(bad.id, bad.revision);
  assert.equal(r.statusCode, 400);
  const body = r.json();
  assert.ok(body.problems.some((p: any) => p.node === 'm1' && /vacío/.test(p.message)), 'cada pendiente señala su elemento');
  assert.equal((await owned(bad.id)).flows.length, 0, 'nada se publicó');

  const stale = await save(boardId, revision - 1, { name: 'Otro nombre' });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().revision, revision);
  assert.equal((await publish(boardId, revision - 1)).statusCode, 409);

  assert.equal((await h.authed('POST', `/api/flow-boards/${boardId}/pause`, { paused: true })).statusCode, 200);
  const paused = await owned(boardId);
  assert.ok(paused.rules.every((x) => !x.active) && paused.flows.every((x) => !x.active));
  // Volver a publicar en pausa no lo enciende.
  const again = await publish(boardId, revision);
  assert.equal(again.statusCode, 200, again.body);
  assert.ok((await owned(boardId)).rules.every((x) => !x.active));
  assert.equal((await h.authed('POST', `/api/flow-boards/${boardId}/pause`, { paused: false })).statusCode, 200);
  assert.ok((await owned(boardId)).rules.every((x) => x.active));
});

t('borrar el lienzo borra su regla y sus flujos; las reglas hechas a mano no se tocan', async () => {
  const manual = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Regla a mano', trigger: { type: 'new_contact' }, actions: [{ type: 'add_tag', tag: 'nuevo' }] });
  assert.equal(manual.statusCode, 200, manual.body);
  const { rules, flows } = await owned(boardId);
  assert.equal((await h.authed('DELETE', `/api/flow-boards/${boardId}`)).statusCode, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM automations WHERE id = ANY($1::uuid[])', [rules.map((x) => x.id)])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sequences WHERE id = ANY($1::uuid[])', [flows.map((x) => x.id)])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM automations WHERE id = $1', [manual.json().id])).rows[0].n, 1);
});
