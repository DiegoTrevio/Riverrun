import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAiProvider, AiError } from '../src/ai/provider.js';
import { config } from '../src/config.js';

async function withApi(fn: (url: string, seen: any[], fail: (status: number) => void) => Promise<void>, reply?: (body: any) => Record<string, unknown>) {
  const seen: any[] = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, authorization: req.headers.authorization, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      const choice = reply?.(body) ?? { message: { content: 'Respuesta de prueba' }, finish_reason: 'stop' };
      res.end(JSON.stringify(status !== 200 ? { error: { message: 'Incorrect API key: sk-or-v1-FAKE-SECRET' } } : { model: body.model, choices: [choice], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.00003, prompt_tokens_details: { cached_tokens: 5 } } }));
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

test('evaluación: una solicitud contada no genera reintentos HTTP ocultos', async () => {
  await withApi(async (url, seen, fail) => {
    fail(503);
    const client = new OpenAiProvider('TEST', url, 1000, 'openrouter', 1);
    await assert.rejects(client.complete({ model: 'openai/gpt-4.1-mini', messages: [] }), /HTTP 503/);
    assert.equal(seen.length, 1);
  });
});

test('el proveedor conserva tres intentos por defecto ante errores transitorios', async () => {
  await withApi(async (url, seen, fail) => {
    fail(503);
    await assert.rejects(new OpenAiProvider('TEST', url, 1000, 'openrouter').complete({ model: 'openai/gpt-4.1-mini', messages: [] }), /HTTP 503/);
    assert.equal(seen.length, 3);
  });
});

test('OpenRouter: lista de respaldo — models en orden, sin repetir el principal y con tope de 2', async () => {
  await withApi(async (url, seen) => {
    const client = new OpenAiProvider('TEST-ROUTER', url, 1000, 'openrouter');
    const messages = [{ role: 'user' as const, content: 'hola' }];
    // Global (OPENROUTER_FALLBACK_MODELS)
    const saved = config.openai.fallbackModels;
    config.openai.fallbackModels = ['anthropic/claude-haiku-4.5', 'openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'x/otro'];
    try {
      await client.complete({ model: 'gpt-4.1-mini', messages });
      assert.deepEqual(seen[0].body.models, ['openai/gpt-4.1-mini', 'anthropic/claude-haiku-4.5', 'google/gemini-2.5-flash']);
      assert.equal(seen[0].body.model, undefined, 'con lista de respaldo se envía "models", no "model"');
      // Los del asistente tienen prioridad sobre los globales
      await client.complete({ model: 'openai/gpt-4.1-mini', fallback_models: ['mistralai/mistral-small'], messages });
      assert.deepEqual(seen[1].body.models, ['openai/gpt-4.1-mini', 'mistralai/mistral-small']);
    } finally {
      config.openai.fallbackModels = saved;
    }
    // Sin respaldos: se comporta como antes
    await client.complete({ model: 'gpt-4.1-mini', messages });
    assert.equal(seen[2].body.model, 'openai/gpt-4.1-mini');
    assert.equal(seen[2].body.models, undefined);
    // Con OpenAI directo no se envía "models"
    const direct = new OpenAiProvider('TEST-OPENAI', url, 1000, 'openai');
    config.openai.fallbackModels = ['gpt-4o-mini'];
    try { await direct.complete({ model: 'gpt-4.1-mini', messages }); } finally { config.openai.fallbackModels = saved; }
    assert.equal(seen[3].body.models, undefined);
  });
});

test('OpenRouter: herramientas — envía tools en formato OpenAI, exige soporte y lee las llamadas sin texto', async () => {
  const toolReply = (body: any) => body.tools
    ? { message: { content: null, tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'buscar_contactos', arguments: '{"texto":"Ana"}' } },
      { id: 'call_b', type: 'function', function: { name: 'ver_contacto', arguments: { id: 'x' } } },
      { id: 'call_c', type: 'function', function: { arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }
    : { message: { content: 'Respuesta de prueba' }, finish_reason: 'stop' };
  await withApi(async (url, seen) => {
    const client = new OpenAiProvider('TEST', url, 1000, 'openrouter');
    const tools = [{ name: 'buscar_contactos', description: 'Busca contactos', parameters: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'], additionalProperties: false } }];
    const result = await client.complete({
      model: 'anthropic/claude-sonnet-4.5', fallback_models: 'none', tools, tool_choice: 'auto', reasoning_effort: 'low',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Eres Copiloto', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'Busca a Ana' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', name: 'buscar_contactos', arguments: '{"texto":"Ana"}' }] },
        { role: 'tool', tool_call_id: 'call_0', content: '{"contactos":[]}' },
      ],
    });
    const body = seen[0].body;
    assert.deepEqual(body.tools, [{ type: 'function', function: tools[0] }]);
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.provider, { require_parameters: true }, 'los respaldos sin herramientas se saltan');
    assert.equal(body.reasoning, undefined, 'con herramientas no se pide razonamiento');
    assert.equal(body.model, 'anthropic/claude-sonnet-4.5');
    assert.equal(body.models, undefined, "fallback_models: 'none' no manda respaldos");
    assert.deepEqual(body.messages[2], { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'buscar_contactos', arguments: '{"texto":"Ana"}' } }] });
    assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call_0', content: '{"contactos":[]}' });
    assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(result.content, '');
    assert.equal(result.finish_reason, 'tool_calls');
    assert.deepEqual(result.tool_calls, [
      { id: 'call_a', name: 'buscar_contactos', arguments: '{"texto":"Ana"}' },
      { id: 'call_b', name: 'ver_contacto', arguments: '{"id":"x"}' },
    ], 'los argumentos en objeto se vuelven texto y una llamada sin nombre se descarta');

    await client.complete({ model: 'anthropic/claude-sonnet-4.5', tools, tool_choice: { name: 'buscar_contactos' }, parallel_tool_calls: false, messages: [] });
    assert.deepEqual(seen[1].body.tool_choice, { type: 'function', function: { name: 'buscar_contactos' } });
    assert.equal(seen[1].body.parallel_tool_calls, false);

    // Sin herramientas, una respuesta vacía sigue siendo un error; y no se mezclan herramientas con JSON Schema.
    await assert.rejects(client.complete({ model: 'x/y', tools, json_schema: { name: 'n', schema: {} }, messages: [] }), (e: any) => e instanceof AiError && e.notDispatched);
    assert.equal(seen.length, 2, 'la combinación inválida no llega al proveedor');
  }, toolReply);
  await withApi(async (url) => {
    await assert.rejects(new OpenAiProvider('TEST', url, 1000, 'openrouter').complete({ model: 'x/y', messages: [] }), /Respuesta vacía/);
  }, () => ({ message: { content: '' }, finish_reason: 'length' }));
});

test('OpenRouter: caché que avanza con la conversación solo si se pide y todos los modelos son de Anthropic', async () => {
  await withApi(async (url, seen) => {
    const client = new OpenAiProvider('TEST', url, 1000, 'openrouter');
    await client.complete({ model: 'anthropic/claude-sonnet-4.5', fallback_models: 'none', prompt_cache: true, messages: [{ role: 'user', content: 'Hola' }] });
    assert.deepEqual(seen[0].body.cache_control, { type: 'ephemeral' });
    await client.complete({ model: 'anthropic/claude-sonnet-4.5', fallback_models: ['anthropic/claude-haiku-4.5'], prompt_cache: true, messages: [{ role: 'user', content: 'Hola' }] });
    assert.deepEqual(seen[1].body.cache_control, { type: 'ephemeral' }, 'con respaldos de Anthropic también');
    await client.complete({ model: 'anthropic/claude-sonnet-4.5', fallback_models: ['openai/gpt-4.1'], prompt_cache: true, messages: [{ role: 'user', content: 'Hola' }] });
    assert.equal(seen[2].body.cache_control, undefined, 'un respaldo de otro proveedor no recibe el campo');
    await client.complete({ model: 'anthropic/claude-sonnet-4.5', fallback_models: 'none', messages: [{ role: 'user', content: 'Hola' }] });
    assert.equal(seen[3].body.cache_control, undefined, 'sin pedirlo no se manda (el agente de clientes no cambia)');
    await client.complete({ model: 'openai/gpt-4.1-mini', fallback_models: 'none', prompt_cache: true, messages: [{ role: 'user', content: 'Hola' }] });
    assert.equal(seen[4].body.cache_control, undefined);
  });
  await withApi(async (url, seen) => {
    await new OpenAiProvider('TEST', url, 1000, 'openai').complete({ model: 'gpt-4.1', prompt_cache: true, messages: [{ role: 'user', content: 'Hola' }] });
    assert.equal(seen[0].body.cache_control, undefined, 'OpenAI directo no lo recibe');
  });
});

test('OpenRouter: un modelo que no acepta temperature se reintenta sin ella una vez y ya no se le manda', async () => {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      // Como OpenRouter con `require_parameters`: el modelo «sin-temperatura» no tiene proveedor que la acepte.
      if (body.model === 'anthropic/sin-temperatura' && body.temperature !== undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'No endpoints found that can handle the requested parameters.', code: 404 } }));
      }
      if (body.model === 'anthropic/no-existe') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Model not found', code: 404 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Hola' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.00001 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new OpenAiProvider('TEST', `http://127.0.0.1:${(server.address() as any).port}`, 1000, 'openrouter');
    const ask = (model: string) => client.complete({ model, fallback_models: 'none', temperature: 0.2, tools: [{ name: 'ping', description: 'Ping', parameters: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'Hola' }] });
    assert.equal((await ask('anthropic/sin-temperatura')).content, 'Hola');
    assert.deepEqual(seen.map((b) => b.temperature), [0.2, undefined], 'se repite sin temperature');
    await ask('anthropic/sin-temperatura');
    assert.equal(seen.length, 3, 'la siguiente llamada ya no la manda (una sola petición)');
    assert.equal(seen[2].temperature, undefined);
    await ask('anthropic/claude-sonnet-4.5');
    assert.equal(seen[3].temperature, 0.2, 'los modelos que sí la aceptan la siguen recibiendo');
    // Otro 404 (modelo que no existe) no se reintenta.
    await assert.rejects(ask('anthropic/no-existe'), (e: any) => e instanceof AiError && e.status === 404 && !e.unsupportedParameters);
    assert.equal(seen.length, 5);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
