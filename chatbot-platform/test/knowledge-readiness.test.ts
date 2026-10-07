import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';
const { config } = await import('../src/config.js');
const { knowledgeReadiness } = await import('../src/engine/knowledge-readiness.js');
const { migrate } = await import('../src/db.js');
const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const old = { enabled: config.knowledgeSearch.enabled, key: config.openai.apiKey };
const vector = Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0);
const fake = { complete: async () => { throw new Error('No chat'); }, transcribe: async () => '', embed: async () => ({ vectors: [vector], model: config.knowledgeSearch.model, input_tokens: 8, latency_ms: 1 }) };
before(async () => { if (ok) h = await createHarness(); });
after(async () => { config.knowledgeSearch.enabled = old.enabled; config.openai.apiKey = old.key; if (h) await h.app.close(); await pool.end(); });

t('diagnóstico no modifica datos ni declara listo un proveedor no comprobado', async () => {
  await h.createBot();
  await store.upsertKnowledge(h.botId, { title: 'Información existente', content: 'Dato conservado' });
  config.knowledgeSearch.enabled = false;
  config.openai.apiKey = '';
  const before = await store.listKnowledge(h.botId);
  const result = await knowledgeReadiness({ verifyProvider: true, ai: fake });
  assert.equal(result.ready, false);
  assert.equal(result.key_present, false);
  assert.equal(result.provider, 'not_checked');
  assert.ok(result.issues.some((s) => s.includes('KNOWLEDGE_SEARCH_ENABLED')));
  assert.deepEqual(await store.listKnowledge(h.botId), before);
});

t('esquema y proveedor compatibles completan la activación; migración repetida conserva datos', async () => {
  config.knowledgeSearch.enabled = true;
  config.openai.apiKey = 'TEST-KEY';
  const probe = await knowledgeReadiness();
  if (!probe.vector_version) { assert.equal(probe.database_ready, false); return; }
  const before = await store.listKnowledge(h.botId);
  assert.deepEqual(await migrate(), []);
  assert.deepEqual(await migrate(), []);
  const result = await knowledgeReadiness({ verifyProvider: true, ai: fake });
  assert.equal(result.ready, true);
  assert.equal(result.provider, 'verified');
  assert.equal(result.embedding_type, 'vector(1536)');
  assert.deepEqual(await store.listKnowledge(h.botId), before);
  assert.equal((await knowledgeReadiness()).ready, false, 'Sin prueba del proveedor no se acredita activación plena');
});

t('rechaza vectores incompatibles y errores sin mostrar claves', async () => {
  const probe = await knowledgeReadiness();
  if (!probe.database_ready) return;
  const invalid = { ...fake, embed: async () => ({ ...await fake.embed(), vectors: [[1, 2]] }) };
  const result = await knowledgeReadiness({ verifyProvider: true, ai: invalid });
  assert.equal(result.ready, false);
  assert.equal(result.provider, 'failed');
  const denied = { ...fake, embed: async () => { throw new Error('TEST-KEY private URL postgres://private'); } };
  const failure = await knowledgeReadiness({ verifyProvider: true, ai: denied });
  assert.equal(failure.provider, 'failed');
  assert.ok(!JSON.stringify(failure).includes('TEST-KEY'));
  assert.ok(!JSON.stringify(failure).includes('postgres://private'));
});

t('detecta esquema vectorial incompatible antes de comprobar el proveedor', async () => {
  if (!(await knowledgeReadiness()).database_ready) return;
  await pool.query('ALTER TABLE knowledge_chunks RENAME COLUMN embedding TO old_embedding');
  let calls = 0;
  try {
    const result = await knowledgeReadiness({ verifyProvider: true, ai: { ...fake, embed: async () => { calls++; return fake.embed(); } } });
    assert.equal(result.database_ready, false);
    assert.equal(result.ready, false);
    assert.equal(calls, 0);
  } finally { await pool.query('ALTER TABLE knowledge_chunks RENAME COLUMN old_embedding TO embedding'); }
});
