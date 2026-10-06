import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAiProvider, validEmbedding } from '../src/ai/provider.js';

test('embeddings: endpoint OpenRouter, lote ordenado, dimensiones, costo y errores sin secretos', async () => {
  let status = 200;
  let bad = false;
  const seen: any[] = [];
  const vector = (n: number) => Array.from({ length: 1536 }, (_, i) => i === n ? 1 : 0);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status !== 200 ? { error: { message: 'Secret FAKE-KEY' } } : { model: 'openai/text-embedding-3-small', data: [{ index: 1, embedding: bad ? [1, 2] : vector(1) }, { index: 0, embedding: vector(0) }], usage: { prompt_tokens: 7, cost: 0.00001 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ai = new OpenAiProvider('FAKE-KEY', `http://127.0.0.1:${(server.address() as any).port}`, 1000, 'openrouter');
    const result = await ai.embed(['Uno', 'Dos'], 'openai/text-embedding-3-small');
    assert.equal(seen[0].path, '/embeddings');
    assert.equal(seen[0].auth, 'Bearer FAKE-KEY');
    assert.deepEqual(seen[0].body.input, ['Uno', 'Dos']);
    assert.equal(seen[0].body.dimensions, 1536);
    assert.equal(seen[0].body.encoding_format, 'float');
    assert.deepEqual(result.vectors, [vector(0), vector(1)]);
    assert.equal(result.input_tokens, 7);
    assert.equal(result.cost_usd, 0.00001);
    bad = true;
    await assert.rejects(ai.embed(['Uno', 'Dos'], 'openai/text-embedding-3-small'), /Dimensiones/);
    status = 401;
    await assert.rejects(ai.embed(['Uno'], 'openai/text-embedding-3-small'), (e: Error) => e.message.includes('clave') && !e.message.includes('FAKE-KEY'));
    assert.equal(validEmbedding(Array(1536).fill(0)), false);
    const invalid = vector(0); invalid[2] = Infinity;
    assert.equal(validEmbedding(invalid), false);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
