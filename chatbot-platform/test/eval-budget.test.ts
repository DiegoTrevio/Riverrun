import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { LiveBudget } = await import('../evals/live-budget.mjs');
const model = 'openai/gpt-4.1-mini';
const reply = (cost_usd = 0.001) => ({ cost_usd, usage: { input_tokens: 12, output_tokens: 8 } });

test('límites inválidos no inician una evaluación real', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity', '11']) assert.throws(() => new LiveBudget({ RIVERRUN_EVAL_MAX_USD: value }));
  assert.throws(() => new LiveBudget({ RIVERRUN_EVAL_MAX_CALLS: '41' }));
  assert.throws(() => new LiveBudget({ RIVERRUN_EVAL_MAX_CALLS: '1.5' }));
  assert.throws(() => new LiveBudget({ RIVERRUN_EVAL_MAX_OUTPUT_TOKENS: '2001' }));
});

test('el presupuesto se reserva antes de llamar al proveedor', async () => {
  const b = new LiveBudget({ RIVERRUN_EVAL_MAX_USD: '0.01' });
  let sent = 0;
  await assert.rejects(b.request('completion', model, [], async () => { sent++; return reply(); }));
  assert.equal(sent, 0); assert.equal(b.blocked, true);
});

test('decisiones, resúmenes y embeddings comparten el límite de solicitudes', async () => {
  const b = new LiveBudget({ RIVERRUN_EVAL_MAX_CALLS: '2' });
  await b.request('completion', model, [], async () => reply());
  await b.request('embedding', 'openai/text-embedding-3-small', ['texto'], async () => ({ cost_usd: 0.0001, input_tokens: 3 }));
  await assert.rejects(b.request('completion', model, [], async () => { throw new Error('No debe ejecutarse'); }));
  assert.equal(b.calls, 2); assert.equal(b.inputTokens, 15); assert.equal(b.outputTokens, 8);
  assert.ok(Math.abs(b.reportedUsd - 0.0011) < 1e-10);
});

test('rechaza modelos sin política de reserva y textos demasiado grandes', async () => {
  for (const [m, input] of [['modelo-caro', []], [model, ['x'.repeat(100001)]]]) {
    const b = new LiveBudget();
    await assert.rejects(b.request('completion', m, input, async () => { throw new Error('No debe ejecutarse'); }));
    assert.equal(b.calls, 0);
  }
});

test('un costo ausente detiene las siguientes llamadas y mantiene la reserva', async () => {
  const b = new LiveBudget();
  await assert.rejects(b.request('completion', model, [], async () => ({ usage: {} })), /costo válido/);
  assert.equal(b.unknownCostCalls, 1); assert.ok(b.reservedUsd > 0);
  await assert.rejects(b.request('completion', model, [], async () => reply()));
  assert.equal(b.calls, 1);
});

test('un error del proveedor no libera una reserva que podría haber sido cobrada', async () => {
  const b = new LiveBudget();
  await assert.rejects(b.request('completion', model, [], async () => { throw new Error('Timeout'); }), /Timeout/);
  assert.ok(b.reservedUsd > 0); assert.equal(b.blocked, true);
  await assert.rejects(b.request('completion', model, [], async () => reply()));
  assert.equal(b.calls, 1);
});

test('un costo superior a la reserva queda registrado y bloquea nuevas solicitudes', async () => {
  const b = new LiveBudget();
  await assert.rejects(b.request('completion', model, [], async () => reply(0.5)), /reserva/);
  assert.equal(b.reportedUsd, 0.5); assert.equal(b.blocked, true);
});

test('las reservas simultáneas no permiten gastar dos veces el mismo saldo', async () => {
  const b = new LiveBudget({ RIVERRUN_EVAL_MAX_USD: '0.1' });
  let done;
  const first = b.request('completion', model, [], () => new Promise(resolve => { done = resolve; }));
  await assert.rejects(b.request('completion', model, [], async () => reply()));
  done(reply()); await first;
  assert.equal(b.calls, 1);
});

test('el reporte de consumo contiene solamente cifras y límites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'riverrun-budget-'));
  try {
    const path = join(dir, 'usage.json');
    const b = new LiveBudget({ RIVERRUN_EVAL_USAGE_FILE: path, OPENROUTER_API_KEY: 'PRIVATE-TEST-KEY' });
    await b.request('completion', model, [{ content: 'Mensaje privado sintético' }], async () => reply());
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.includes('PRIVATE-TEST-KEY') && !text.includes('Mensaje privado'));
    assert.equal(JSON.parse(text).calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
