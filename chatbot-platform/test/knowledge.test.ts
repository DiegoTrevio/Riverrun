import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';
const { config } = await import('../src/config.js');
const { indexKnowledge, semanticKnowledge, knowledgeChunks, knowledgeHash, vectorAvailable } = await import('../src/engine/knowledge.js');
const dbOk = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !dbOk && 'PostgreSQL no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let vectorReady = false;
const original = config.knowledgeSearch.enabled;
const v = (n: number) => Array.from({ length: 1536 }, (_, i) => i === n ? 1 : 0);
const fake = { complete: async () => { throw new Error('No chat'); }, transcribe: async () => '', embed: async (texts: string[], model: string) => ({ vectors: texts.map((s) => v(s.includes('hospedaje') || s.includes('Tarifa') ? 0 : 1)), model, input_tokens: 10, latency_ms: 1, cost_usd: 0.00001 }) };
before(async () => { if (dbOk) { h = await createHarness(); vectorReady = await vectorAvailable(); if (process.env.REQUIRE_PGVECTOR === 'true') assert.ok(vectorReady, 'La comprobación pgvector requiere la extensión real.'); } });
after(async () => { config.knowledgeSearch.enabled = original; if (h) await h.app.close(); await pool.end(); });

test('fragmentos conservan el contenido con solapamiento y hash cambia con la fuente', () => {
  const text = 'Precio comprobado $1,650. '.repeat(300);
  const chunks = knowledgeChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 700 && text.includes(c)));
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i - 1].slice(-120), chunks[i].slice(0, 120));
  assert.notEqual(knowledgeHash({ category: '', title: '', content: 'A' } as any), knowledgeHash({ category: '', title: '', content: 'B' } as any));
});

t('migración es repetible y el modo desactivado conserva la selección anterior', async () => {
  await h.createBot({ ai: { knowledge_char_budget: 1000 } });
  const bot = (await store.getChatbot(h.botId))!;
  config.knowledgeSearch.enabled = false;
  assert.equal(await semanticKnowledge(bot, [], 'hola', fake), null);
  const status = await h.authed('GET', `/api/chatbots/${bot.id}/knowledge/index`);
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().enabled, false);
  const { migrate } = await import('../src/db.js');
  assert.deepEqual(await migrate(), []);
});

t('pgvector busca por coseno dentro del agente, respeta presupuesto y datos obligatorios', async () => {
  if (!vectorReady) { assert.equal(await vectorAvailable(), false); return; }
  config.knowledgeSearch.enabled = true;
  const bot = (await store.getChatbot(h.botId))!;
  const rate = await store.upsertKnowledge(bot.id, { title: 'Tarifa', content: 'La estancia cuesta $1,650 por noche. ' + 'Servicio confirmado. '.repeat(110) });
  await store.upsertKnowledge(bot.id, { title: 'Horario', content: 'Abierto a las 15:00. ' + 'Recepción. '.repeat(110) });
  // Short excerpts must fit this small budget; make source pieces smaller via the budget here.
  bot.ai.knowledge_char_budget = 2100;
  const required = await store.upsertKnowledge(bot.id, { title: 'Regla', content: 'No aceptamos mascotas.', always_include: true });
  const otherAccount = await store.createAccount('Otro perfil');
  const other = await store.createChatbot(otherAccount.id, { name: 'Otro agente' });
  await store.upsertKnowledge(other.id, { title: 'Tarifa secreta', content: 'No compartir $9,999.' });
  await indexKnowledge(other, fake);
  const found = await semanticKnowledge(bot, await store.listKnowledge(bot.id, true), 'hospedaje económico', fake);
  assert.ok(found);
  assert.ok(found.some((k) => k.id === rate.id));
  assert.ok(found.some((k) => k.id === required.id));
  assert.ok(found.every((k) => k.chatbot_id === bot.id));
  assert.ok(!found.some((k) => k.content.includes('9,999')));
  assert.ok(found.reduce((n, k) => n + k.title.length + k.content.length + 30, 0) <= 2100);
  assert.ok((await pool.query("SELECT * FROM ai_runs WHERE kind='embedding'")).rows.length > 0);
  const stat = (await h.authed('GET', `/api/chatbots/${bot.id}/knowledge/index`)).json();
  assert.equal(stat.indexed_items, 2);
});

t('administrador de otro perfil no puede consultar ni preparar el índice del agente', async () => {
  await h.authed('POST', '/api/accounts', { name: 'Perfil restringido', admin: { email: 'vector@perfil.test', password: 'vector-perfil-123' } });
  const outsider = await h.loginAs('vector@perfil.test', 'vector-perfil-123');
  assert.equal((await outsider('GET', `/api/chatbots/${h.botId}/knowledge/index`)).statusCode, 404);
  assert.equal((await outsider('POST', `/api/chatbots/${h.botId}/knowledge/index`, {})).statusCode, 404);
});

t('editar, desactivar y borrar fuentes evita recuperar vectores obsoletos', async () => {
  if (!vectorReady) return;
  const bot = (await store.getChatbot(h.botId))!;
  const k = (await store.listKnowledge(bot.id, true)).find((x) => x.title === 'Tarifa')!;
  await store.upsertKnowledge(bot.id, { id: k.id, content: 'Nuevo precio $1,800.' });
  const updated = await semanticKnowledge(bot, await store.listKnowledge(bot.id, true), 'hospedaje', fake);
  assert.ok(updated?.some((x) => x.content.includes('1,800')));
  assert.ok(!updated?.some((x) => x.content.includes('1,650')));
  await store.upsertKnowledge(bot.id, { id: k.id, active: false });
  assert.ok(!(await semanticKnowledge(bot, await store.listKnowledge(bot.id, true), 'hospedaje', fake))?.some((x) => x.id === k.id));
  await store.deleteKnowledge(k.id);
  assert.equal((await pool.query('SELECT * FROM knowledge_chunks WHERE item_id=$1', [k.id])).rowCount, 0);
});

t('edición durante indexación no guarda una versión vieja; falla del proveedor usa alternativa', async () => {
  if (!vectorReady) return;
  const bot = (await store.getChatbot(h.botId))!;
  const k = await store.upsertKnowledge(bot.id, { title: 'Tarifa', content: 'Original $1,650.' });
  const racing = { ...fake, embed: async (texts: string[], model: string) => { await store.upsertKnowledge(bot.id, { id: k.id, content: 'Corregido $1,800.' }); return fake.embed(texts, model); } };
  await indexKnowledge(bot, racing);
  assert.equal((await pool.query('SELECT * FROM knowledge_chunks WHERE item_id=$1', [k.id])).rowCount, 0);
  const broken = { ...fake, embed: async () => { throw new Error('Key denied'); } };
  assert.equal(await semanticKnowledge(bot, await store.listKnowledge(bot.id, true), 'hospedaje', broken), null);
});

t('motor real usa fragmentos semánticos como conocimiento verificado sin enviar WhatsApp real', async () => {
  if (!vectorReady) return;
  for (const k of await store.listKnowledge(h.botId)) await store.deleteKnowledge(k.id);
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { debounce_seconds: 0, knowledge_char_budget: 2100 } });
  await store.upsertKnowledge(h.botId, { title: 'Horario', content: 'Recepción. '.repeat(400) });
  await store.upsertKnowledge(h.botId, { title: 'Tarifa', content: 'Doble $1,650. ' + 'Detalles. '.repeat(400) });
  h.ai.embed = fake.embed;
  h.setScript(() => ({ messages: ['La doble cuesta $1,650.'] }));
  await h.webhook('hospedaje económico');
  await waitFor(() => h.sent.some((m) => m.text.includes('1,650')));
  await h.idle();
  assert.ok(h.calls[0].messages[0].content.includes('1,650'));
  assert.ok(!h.calls[0].messages[0].content.includes('Recepción. '.repeat(200)));
});
