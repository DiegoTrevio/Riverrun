/** Catálogo de modelos de OpenRouter: avisa de modelos configurados que ya no existen. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { config } = await import('../src/config.js');
const models = await import('../src/ai/models.js');

let catalog = ['openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'];
let hits = 0;
let down = false;
const server = http.createServer((req, res) => {
  hits++;
  if (down) { res.writeHead(503); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: catalog.map((id) => ({ id })) }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('descarga el catálogo una vez (con caché), tolera caídas y solo valida contra OpenRouter', async () => {
  models.resetModelCatalogCache();
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const t0 = Date.now();
  const first = await models.fetchCatalog(t0, url);
  assert.deepEqual([...first!].sort(), [...catalog].sort());
  const before = hits;
  await models.fetchCatalog(t0 + 1000, url);
  assert.equal(hits, before, 'dentro de las 6 h usa la copia guardada');
  down = true;
  const stale = await models.fetchCatalog(t0 + 7 * 3600_000, url);
  assert.ok(stale && stale.has('openai/gpt-4.1-mini'), 'si OpenRouter no responde, conserva la última copia');
  down = false;
  models.resetModelCatalogCache();
  down = true;
  assert.equal(await models.fetchCatalog(t0, url), null, 'sin copia y sin respuesta: no se sabe');
  down = false;
  assert.equal(await models.missingModels(), null, 'con un proveedor que no es OpenRouter no se valida');
});

t('detecta los modelos configurados (global, de respaldo y de cada asistente) que ya no existen', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { model: 'openai/gpt-viejo-retirado', fallback_models: ['google/gemini-2.5-flash', 'proveedor/inexistente:nitro'] } });
  const missing = await models.missingModels(new Set(['openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash:free', 'anthropic/claude-haiku-4.5']));
  const ids = missing!.map((m) => m.id);
  assert.ok(ids.includes('openai/gpt-viejo-retirado'));
  assert.ok(ids.includes('proveedor/inexistente:nitro'));
  assert.ok(!ids.includes('google/gemini-2.5-flash'));
  assert.ok(missing!.find((m) => m.id === 'openai/gpt-viejo-retirado')!.where.startsWith('asistente'));
  // Con todo en el catálogo no hay faltantes
  const all = new Set((await models.configuredModels()).map((m) => m.id.split(':')[0]));
  assert.deepEqual(await models.missingModels(all), []);
});

t('configuredModels incluye los de los asistentes y normaliza nombres sueltos', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { model: 'gpt-4.1-mini', fallback_models: ['google/gemini-2.5-flash'] } });
  const list = await models.configuredModels();
  assert.ok(list.some((m) => m.id === 'openai/gpt-4.1-mini' && m.where.startsWith('asistente')));
  assert.ok(list.some((m) => m.id === 'google/gemini-2.5-flash' && m.where.startsWith('respaldo')));
  assert.ok(list.some((m) => m.where === 'OPENROUTER_MODEL'));
});

t('el asistente acepta hasta 2 modelos de respaldo', async () => {
  assert.equal((await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { fallback_models: ['a/b', 'c/d', 'e/f'] } })).statusCode, 400);
  const r = await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { fallback_models: ['a/b', 'c/d'] } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().ai.fallback_models, ['a/b', 'c/d']);
});
