import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAiProvider, AiError } from '../src/ai/provider.js';
import { config } from '../src/config.js';

async function withApi(fn: (url: string, seen: any[], fail: (status: number) => void) => Promise<void>) {
  const seen: any[] = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, authorization: req.headers.authorization, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status !== 200 ? { error: { message: 'Incorrect API key: sk-or-v1-FAKE-SECRET' } } : { model: body.model, choices: [{ message: { content: 'Respuesta de prueba' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.00003, prompt_tokens_details: { cached_tokens: 5 } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as any).port}`, seen, (s) => { status = s; }); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('OpenRouter: autentica, adapta modelos antiguos, exige JSON Schema y conserva uso de tokens', async () => {
  await withApi(async (url, seen) => {
    const client = new OpenAiProvider('TEST-ROUTER', url, 1000, 'openrouter');
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    const result = await client.complete({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hola' }], temperature: 0.3, json_schema: { name: 'decision', schema } });
    assert.equal(seen[0].url, '/chat/completions');
    assert.equal(seen[0].authorization, 'Bearer TEST-ROUTER');
    assert.equal(seen[0].body.model, 'openai/gpt-4.1-mini');
    assert.equal(seen[0].body.max_tokens, 1200);
    assert.equal(seen[0].body.max_completion_tokens, undefined);
    assert.equal(seen[0].body.temperature, 0.3);
    assert.deepEqual(seen[0].body.provider, { require_parameters: true });
    assert.deepEqual(seen[0].body.response_format.json_schema, { name: 'decision', strict: true, schema });
    assert.equal(result.content, 'Respuesta de prueba');
    assert.deepEqual(result.usage, { input_tokens: 20, cached_tokens: 5, output_tokens: 10 });
    assert.equal(result.model, 'openai/gpt-4.1-mini');
    assert.equal(result.cost_usd, 0.00003);
    await client.complete({ model: 'google/gemini-2.5-flash', messages: [] });
    assert.equal(seen[1].body.model, 'google/gemini-2.5-flash');
    assert.equal(seen[1].body.response_format, undefined, 'los resúmenes no exigen JSON');
  });
});

test('OpenRouter: usa reasoning unificado y no envía temperature a modelos OpenAI de razonamiento', async () => {
  await withApi(async (url, seen) => {
    await new OpenAiProvider('TEST', url, 1000, 'openrouter').complete({ model: 'openai/o3-mini', messages: [], temperature: 0.4, reasoning_effort: 'low' });
    assert.deepEqual(seen[0].body.reasoning, { effort: 'low' });
    assert.equal(seen[0].body.temperature, undefined);
    assert.equal(seen[0].body.reasoning_effort, undefined);
    assert.equal(seen[0].body.max_tokens, 6000);
  });
});

test('OpenRouter: transcribe OGG por chat completions usando input_audio, sin endpoint OpenAI', async () => {
  const old = config.openai.transcriptionModel;
  config.openai.transcriptionModel = 'google/gemini-2.5-flash';
  try {
    await withApi(async (url, seen) => {
      const client = new OpenAiProvider('TEST', url, 1000, 'openrouter');
      const result = await client.transcribe(Buffer.from('OggS-test'), 'audio/ogg; codecs=opus');
      assert.ok(typeof result !== 'string');
      assert.equal(result.content, 'Respuesta de prueba');
      assert.equal(result.cost_usd, 0.00003);
      assert.equal(result.usage.input_tokens, 20);
      assert.equal(seen[0].url, '/chat/completions');
      assert.equal(seen[0].body.model, 'google/gemini-2.5-flash');
      assert.deepEqual(seen[0].body.messages[0].content[1], { type: 'input_audio', input_audio: { data: Buffer.from('OggS-test').toString('base64'), format: 'ogg' } });
      await assert.rejects(client.transcribe(Buffer.from('x'), 'application/octet-stream'), /Formato de audio/);
      assert.equal(seen.length, 1);
    });
  } finally { config.openai.transcriptionModel = old; }
});

test('OpenRouter: errores 401 y saldo insuficiente son claros y no exponen fragmentos de claves', async () => {
  await withApi(async (url, seen, fail) => {
    const client = new OpenAiProvider('TEST', url, 1000, 'openrouter');
    for (const status of [401, 402]) {
      fail(status);
      await assert.rejects(client.complete({ model: 'openai/gpt-4.1-mini', messages: [] }), (error: any) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.status, status);
        assert.match(error.message, status === 401 ? /OpenRouter rechazó la clave API/ : /saldo suficiente/);
        assert.doesNotMatch(error.message, /sk-or|FAKE-SECRET/);
        assert.equal(error.body, undefined);
        return true;
      });
    }
    assert.equal(seen.length, 2, 'no reintenta errores permanentes');
  });
});

test('OpenAI explícito conserva sus parámetros originales', async () => {
  await withApi(async (url, seen) => {
    await new OpenAiProvider('TEST', url, 1000, 'openai').complete({ model: 'o3-mini', messages: [], reasoning_effort: 'low' });
    assert.equal(seen[0].body.model, 'o3-mini');
    assert.equal(seen[0].body.max_completion_tokens, 6000);
    assert.equal(seen[0].body.reasoning_effort, 'low');
    assert.equal(seen[0].body.reasoning, undefined);
  });
});
