import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function settings(overrides: Record<string, string> = {}) {
  const taskEnv = { ...process.env };
  for (const key of Object.keys(taskEnv)) if (/^(OPENAI_|OPENROUTER_)/.test(key)) delete taskEnv[key];
  Object.assign(taskEnv, overrides);
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ baseUrl: config.openai.baseUrl, model: config.openai.defaultModel, summaryModel: config.openai.summaryModel, audioModel: config.openai.transcriptionModel, usesExpectedKey: config.openai.apiKey === 'TEST-KEY' }));`], { env: taskEnv, encoding: 'utf8' }));
}

test('configuración por defecto usa OpenRouter y acepta la variable anterior de clave', () => {
  assert.deepEqual(settings({ OPENAI_API_KEY: 'TEST-KEY' }), { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', summaryModel: 'openai/gpt-4.1-mini', audioModel: 'google/gemini-2.5-flash', usesExpectedKey: true });
});

test('variables OpenRouter tienen prioridad y se puede elegir OpenAI explícitamente', () => {
  const router = settings({ OPENAI_API_KEY: 'OLD-KEY', OPENROUTER_API_KEY: 'TEST-KEY', OPENAI_MODEL: 'gpt-4.1-mini', OPENROUTER_MODEL: 'anthropic/claude-sonnet-4', OPENROUTER_SUMMARY_MODEL: 'openai/gpt-4.1-nano' });
  assert.equal(router.usesExpectedKey, true);
  assert.equal(router.model, 'anthropic/claude-sonnet-4');
  assert.equal(router.summaryModel, 'openai/gpt-4.1-nano');
  assert.deepEqual(settings({ OPENAI_BASE_URL: 'https://api.openai.com/v1/', OPENAI_API_KEY: 'TEST-KEY' }), { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', summaryModel: 'gpt-4.1-mini', audioModel: 'gpt-4o-mini-transcribe', usesExpectedKey: true });
});
