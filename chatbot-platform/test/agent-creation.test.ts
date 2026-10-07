import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';

const ok = await dbAvailable();
let h: Awaited<ReturnType<typeof createHarness>>;
before(async () => { if (ok) { h = await createHarness(); await h.createBot(); } });
after(async () => { if (h) await h.app.close(); await pool.end(); });
const setup = { goal: 'Completar el pedido', questions: 'Qué desea pedir y dónde se entrega', knowledge: 'Tacos a $25. Abierto de 12 a 22.' };

test('creación guiada guarda objetivo, preguntas y conocimiento sin campos manuales y conserva configuración al editar', { skip: !ok }, async () => {
  const r = await h.authed('POST', '/api/chatbots', { account_id: h.accountId, name: 'Trompitos', template: 'restaurante', active: true, setup });
  assert.equal(r.statusCode, 200, r.body);
  const bot = r.json();
  assert.equal(bot.active, false);
  assert.deepEqual(bot.data_fields, []);
  assert.equal(bot.flow.goal, setup.goal);
  assert.match(bot.personality.prompt, /PREGUNTAS CLAVE/);
  assert.ok(bot.personality.prompt.includes(setup.questions));
  assert.ok(!bot.personality.prompt.includes(setup.knowledge));
  const items = await store.listKnowledge(bot.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, setup.knowledge);
  const update = await h.authed('PUT', `/api/chatbots/${bot.id}`, { personality: { assistant_name: 'Mario' } });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().personality.prompt, bot.personality.prompt);
  h.setScript((request) => {
    assert.ok(request.messages[0].content.includes(setup.questions));
    assert.ok(request.messages[0].content.includes(setup.knowledge));
    assert.ok(request.messages[0].content.includes(setup.goal));
    return { messages: ['¿Dónde se entrega?'], save_data: [{ field: 'nombre', value: 'Ana' }] };
  });
  const simulation = await h.authed('POST', `/api/chatbots/${bot.id}/playground`, { session: 'guided-creation', text: 'Soy Ana y quiero tacos' });
  assert.equal(simulation.statusCode, 200, simulation.body);
  assert.ok(h.calls.length > 0);
  assert.equal(simulation.json().contact.data.nombre, 'Ana');
  assert.equal(simulation.json().conversation.data.nombre, 'Ana');
  const invalid = await h.authed('POST', '/api/chatbots', { account_id: h.accountId, name: 'Incompleto', setup: { ...setup, questions: ' ' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM chatbots WHERE name='Incompleto'")).rows[0].n, 0);
});

test('la creación completa se revierte si falla el conocimiento', { skip: !ok }, async () => {
  await pool.query(`CREATE FUNCTION reject_setup_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated knowledge failure'; END $$`);
  await pool.query('CREATE TRIGGER reject_setup BEFORE INSERT ON knowledge_items FOR EACH ROW EXECUTE FUNCTION reject_setup_knowledge()');
  try {
    const r = await h.authed('POST', '/api/chatbots', { account_id: h.accountId, name: 'Revertido', setup });
    assert.equal(r.statusCode, 500);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM chatbots WHERE name='Revertido'")).rows[0].n, 0);
  } finally {
    await pool.query('DROP TRIGGER reject_setup ON knowledge_items');
    await pool.query('DROP FUNCTION reject_setup_knowledge()');
  }
});
