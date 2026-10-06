import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor, store } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
before(async () => { if (ok) { h = await createHarness(); await h.createBot(); } });
after(async () => { if (h) await h.app.close(); await pool.end(); });

t('las secciones del asistente persisten en PostgreSQL y los cambios parciales conservan el resto', async () => {
  const input = {
    name: 'Los Trompitos',
    personality: { assistant_name: 'Mario', prompt: 'Toma pedidos y pregunta la dirección de entrega.', tone: ['amable'], emojis: 'none', formality: 'usted', style_examples: ['Con gusto le ayudo.'] },
    flow: { goal: 'Completar el pedido', greeting: 'Bienvenido', steps: [{ title: 'Pedido', description: 'Pregunta qué desea ordenar.' }] },
    ai: { model: 'gpt-4.1-mini', debounce_seconds: 0.1, timezone: 'America/Mexico_City' },
    rules: { fallback_message: 'Voy a confirmar ese dato con el equipo.', custom_rules: ['No ofrezcas descuentos.'], activation: { mode: 'keywords', on_keywords: ['pedido'], off_keywords: ['terminar'], off_action: 'handoff', resume_after_hours: 4 } },
  };
  let r = await h.authed('PUT', `/api/chatbots/${h.botId}`, input);
  assert.equal(r.statusCode, 200, r.body);
  const saved = r.json();
  const row = (await pool.query('SELECT name, personality, rules, flow, ai FROM chatbots WHERE id = $1', [h.botId])).rows[0];
  for (const key of ['name', 'personality', 'rules', 'flow', 'ai']) assert.deepEqual(row[key], saved[key]);

  r = await h.authed('PUT', `/api/chatbots/${h.botId}`, { personality: { prompt: 'Toma pedidos y pregunta nombre y dirección.' }, flow: { goal: 'Completar el pedido para entrega' }, rules: { activation: { off_keywords: ['finalizar'] } } });
  assert.equal(r.statusCode, 200, r.body);
  const fetched = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.deepEqual(fetched.personality, { ...saved.personality, prompt: 'Toma pedidos y pregunta nombre y dirección.' });
  assert.deepEqual(fetched.flow, { ...saved.flow, goal: 'Completar el pedido para entrega' });
  assert.deepEqual(fetched.rules, { ...saved.rules, activation: { ...saved.rules.activation, off_keywords: ['finalizar'] } });
  assert.deepEqual(fetched.ai, saved.ai);
  assert.deepEqual(fetched.data_fields, saved.data_fields);

  const invalid = await h.authed('PUT', `/api/chatbots/${h.botId}`, { name: 'No debe guardarse', personality: { emojis: 'inválido' } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual((await h.authed('GET', `/api/chatbots/${h.botId}`)).json(), fetched);
});

t('el motor usa la configuración actual y el conocimiento activo; bloquea precios inventados', async () => {
  const put = await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { activation: { mode: 'always' }, verify_facts: true } });
  assert.equal(put.statusCode, 200, put.body);
  let r = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { title: 'Menú', content: 'Taco al pastor: $25 MXN.', active: true });
  assert.equal(r.statusCode, 200, r.body);
  const knowledgeId = r.json().id;
  r = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { title: 'Oferta antigua', content: 'PROMOCION_RETIRADA: taco a $10.', active: false });
  assert.equal(r.statusCode, 200, r.body);
  h.reset();
  h.setScript((req) => {
    const prompt = req.messages[0].content;
    assert.match(prompt, /Te llamas Mario/);
    assert.match(prompt, /Toma pedidos y pregunta nombre y dirección/);
    assert.match(prompt, /Completar el pedido para entrega/);
    assert.match(prompt, /No ofrezcas descuentos/);
    assert.match(prompt, /Taco al pastor: \$25/);
    assert.doesNotMatch(prompt, /PROMOCION_RETIRADA/);
    assert.equal(req.model, 'gpt-4.1-mini');
    return { messages: ['Cuesta $999 MXN.'] };
  });
  await h.webhook('¿Cuánto cuesta el taco?');
  await waitFor(() => h.sent.length === 1);
  await h.idle();
  assert.equal(h.calls.length, 2, 'reintenta cuando el precio no está en el conocimiento');
  assert.equal(h.sent[0].text, 'Voy a confirmar ese dato con el equipo.');

  await h.authed('PUT', `/api/chatbots/${h.botId}`, { personality: { prompt: 'Atiende pedidos para recoger en sucursal.' } });
  await h.authed('PUT', `/api/knowledge/${knowledgeId}`, { content: 'Taco al pastor: $30 MXN.' });
  h.reset();
  h.setScript((req) => {
    assert.match(req.messages[0].content, /Atiende pedidos para recoger en sucursal/);
    assert.doesNotMatch(req.messages[0].content, /Toma pedidos y pregunta nombre y dirección/);
    assert.match(req.messages[0].content, /Taco al pastor: \$30/);
    assert.doesNotMatch(req.messages[0].content, /Taco al pastor: \$25/);
    return { messages: ['El taco al pastor cuesta $30 MXN.'] };
  });
  await h.webhook('¿Cuál es el precio ahora?');
  await waitFor(() => h.sent.length === 1);
  await h.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sent[0].text, 'El taco al pastor cuesta $30 MXN.');
});


t('el modelo con prefijo openai de OpenRouter mantiene el cálculo del consumo', async () => {
  for (const model of ['gpt-4.1-mini', 'openai/gpt-4.1-mini']) {
    await store.insertAiRun({ account_id: h.accountId, chatbot_id: h.botId, conversation_id: null, kind: 'chat', model, input_tokens: 1000, cached_tokens: 100, output_tokens: 200, latency_ms: 1 });
  }
  const rows = (await pool.query("SELECT model, cost_usd FROM ai_runs WHERE model IN ('gpt-4.1-mini', 'openai/gpt-4.1-mini') AND input_tokens = 1000 ORDER BY model")).rows;
  assert.equal(rows.length, 2);
  assert.ok(Number(rows[0].cost_usd) > 0);
  assert.equal(Number(rows[0].cost_usd), Number(rows[1].cost_usd));
});


t('el costo reportado por OpenRouter se conserva aunque el modelo no esté en la tabla de precios', async () => {
  await store.insertAiRun({ account_id: h.accountId, chatbot_id: h.botId, conversation_id: null, kind: 'transcription', model: 'google/modelo-de-prueba', input_tokens: 20, cached_tokens: 0, output_tokens: 10, latency_ms: 1, cost_usd: 0.00123 });
  const row = (await pool.query("SELECT cost_usd FROM ai_runs WHERE model = 'google/modelo-de-prueba'")).rows[0];
  assert.equal(Number(row.cost_usd), 0.00123);
});
