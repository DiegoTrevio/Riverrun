/**
 * Tope de IA de la plataforma (PAY-20): cada plan (o la prueba gratis) tiene un gasto de IA al mes que el cliente no
 * puede cambiar. Lo fija el superadmin (por plan, o una excepción por cuenta); el presupuesto que el cliente configura
 * en «Consumo de IA» solo puede ser más estricto. Confirmar un costo dudoso también es del superadmin.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { accountAi, AiBudgetBlocked } = await import('../src/ai/budget.js');
const { config } = await import('../src/config.js');

const PASS = 'Pz-951-Qx-952-Kv';
const req = { model: 'openai/gpt-4.1-mini', messages: [{ role: 'user' as const, content: 'hola' }], json_schema: { name: 'cap_case', schema: {} } };
const call = () => accountAi(h.ai, h.accountId, h.botId).complete(req);
const spend = (usd: number) => pool.query(`INSERT INTO ai_spend (account_id, kind, models, state, reserved_usd, charged_usd, cost_source) VALUES ($1, 'decision', ARRAY['gpt-4.1-mini'], 'settled', $2, $2, 'reported')`, [h.accountId, usd]);
const blocked = async () => {
  try {
    await call();
    return '';
  } catch (e: any) {
    assert.ok(e instanceof AiBudgetBlocked, String(e));
    return e.code as string;
  }
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('con el tope de la cuenta gastado, la IA se detiene aunque el cliente no tenga presupuesto propio', async () => {
  await pool.query(`UPDATE accounts SET status = 'active', plan = '' WHERE id = $1`, [h.accountId]);
  assert.equal(await blocked(), '', 'sin tope de la plataforma, sigue');
  const r = await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: 0.5 });
  assert.equal(r.statusCode, 200, r.body);
  await spend(0.6);
  assert.equal(await blocked(), 'platform_cap');
  const notice = (await pool.query(`SELECT title FROM notifications WHERE account_id = $1 ORDER BY id DESC LIMIT 1`, [h.accountId])).rows[0];
  assert.match(notice.title, /tope de IA de tu plan/);
  assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: null })).statusCode, 200);
  assert.equal(await blocked(), '', 'sin la excepción, sin tope');
});

t('el tope del plan aplica a sus cuentas; la excepción de la cuenta manda sobre el plan', async () => {
  assert.equal((await h.authed('POST', '/api/plans', { key: 'basico', name: 'Básico', price: 199, currency: 'MXN', ai_usd_per_month: 0.5 })).statusCode, 200);
  await pool.query(`UPDATE accounts SET plan = 'basico' WHERE id = $1`, [h.accountId]);
  assert.equal(await blocked(), 'platform_cap', 'ya gastó 0.6 este mes');
  await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: 10 });
  assert.equal(await blocked(), '');
  await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: null });
  await pool.query(`UPDATE accounts SET plan = '' WHERE id = $1`, [h.accountId]);
});

t('en la prueba gratis aplica TRIAL_AI_USD', async () => {
  const before = config.signup.trialAiUsd;
  config.signup.trialAiUsd = 0.5;
  try {
    await pool.query(`UPDATE accounts SET status = 'trial', trial_ends_at = now() + interval '7 days' WHERE id = $1`, [h.accountId]);
    assert.equal(await blocked(), 'platform_cap');
  } finally {
    config.signup.trialAiUsd = before;
    await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [h.accountId]);
  }
});

t('el administrador de la cuenta no cambia el tope ni confirma costos dudosos', async () => {
  await h.addUser({ account_id: h.accountId, name: 'Ada', email: 'ada@tope.mx', password: PASS, role: 'admin' });
  const admin = await h.loginAs('ada@tope.mx', PASS);
  assert.equal((await admin('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: 1000 })).statusCode, 403);
  const row = (await pool.query(`INSERT INTO ai_spend (account_id, kind, models, state, cost_source) VALUES ($1, 'decision', ARRAY['gpt-4.1-mini'], 'uncertain', 'unknown') RETURNING id`, [h.accountId])).rows[0];
  const r = await admin('POST', `/api/ai-budget/review/${row.id}`, { amount_usd: 0, note: 'Lo pongo en cero' });
  assert.equal(r.statusCode, 403, r.body);
  assert.equal((await h.authed('POST', `/api/ai-budget/review/${row.id}?account_id=${h.accountId}`, { amount_usd: 0.001, note: 'Revisado con el proveedor' })).statusCode, 200, 'el superadmin sí');
});

t('con tope de la plataforma, un modelo sin precio conocido no pasa (el tope no se puede cuidar) (revisión 3b)', async () => {
  await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: 100 });
  try {
    const r = accountAi(h.ai, h.accountId, h.botId).complete({ ...req, model: 'proveedor-nuevo/modelo-sin-precio', fallback_models: 'none' });
    await assert.rejects(r, (e: any) => e instanceof AiBudgetBlocked && e.code === 'price_unknown');
  } finally {
    await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: null });
  }
});

t('los modelos por omisión tienen precio (también gemini-2.5-flash, para audios y fotos con OpenRouter); uno nuevo se detecta', async () => {
  const { unpricedModels } = await import('../src/ai/budget.js');
  const before = { ...config.openai };
  try {
    config.openai.transcriptionModel = 'google/gemini-2.5-flash';
    config.openai.mediaModel = 'google/gemini-2.5-flash';
    assert.deepEqual(await unpricedModels(), []);
    config.openai.fallbackModels = ['proveedor-nuevo/modelo-sin-precio'];
    assert.deepEqual(await unpricedModels(), ['proveedor-nuevo/modelo-sin-precio']);
  } finally {
    Object.assign(config.openai, before);
  }
});

t('un plan sin su propio tope lleva el de por omisión (PLAN_DEFAULT_AI_USD); con el suyo, el suyo', async () => {
  const { platformAiCap } = await import('../src/ai/budget.js');
  assert.equal((await h.authed('POST', '/api/plans', { key: 'sintope', name: 'Sin tope', price: 99, currency: 'MXN' })).statusCode, 200);
  await pool.query(`UPDATE accounts SET plan = 'sintope', status = 'active' WHERE id = $1`, [h.accountId]);
  try {
    assert.equal(await platformAiCap(h.accountId), config.signup.planDefaultAiUsd);
    assert.equal(config.signup.planDefaultAiUsd, 20);
    await pool.query(`UPDATE plans SET ai_usd_per_month = 7 WHERE key = 'sintope'`);
    assert.equal(await platformAiCap(h.accountId), 7);
  } finally {
    await pool.query(`UPDATE accounts SET plan = '' WHERE id = $1`, [h.accountId]);
  }
});

t('PAY-6: una cuenta sin cupo no transcribe audios ni empieza pedidos al Copiloto', async () => {
  await pool.query(`UPDATE accounts SET status = 'active', plan = '' WHERE id = $1`, [h.accountId]);
  assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: 0.5, copilot_enabled: true })).statusCode, 200);
  await h.addUser({ account_id: h.accountId, email: 'duena@sin-cupo.mx', name: 'Dueña', password: PASS, role: 'admin' });
  const owner = await h.loginAs('duena@sin-cupo.mx', PASS);
  const thread = (await owner('POST', '/api/copilot/threads', {})).json().id as string;
  try {
    await spend(0.45); // 90 % del tope: el Copiloto ya no empieza (no deja sin IA al agente)
    const r = await owner('POST', `/api/copilot/threads/${thread}/messages`, { text: 'Hola' });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.json().error, /presupuesto de IA/);
    await spend(0.1);
    await assert.rejects(accountAi(h.ai, h.accountId, h.botId, 'transcription').transcribe(Buffer.alloc(4000), 'audio/ogg', 2), (e: any) => e instanceof AiBudgetBlocked && e.code === 'platform_cap');
  } finally {
    await pool.query(`DELETE FROM ai_spend WHERE account_id = $1`, [h.accountId]);
    assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { ai_usd_override: null })).statusCode, 200);
  }
});

// PAY-24: la tarifa propia del cliente (ai_budget_settings.prices) no puede abaratar lo que cuenta contra el tope de la plataforma.
const setPrices = async (prices: object[]) => {
  const rev = (await pool.query(`SELECT revision FROM ai_budget_settings WHERE account_id = $1`, [h.accountId])).rows[0]?.revision ?? 0;
  const r = await h.authed('PUT', `/api/ai-budget?account_id=${h.accountId}`, { revision: rev, settings: { prices } });
  assert.equal(r.statusCode, 200, r.body);
};
const setCap = async (usd: number | null) => {
  await pool.query(`UPDATE accounts SET ai_usd_override = $2${usd === null ? `, plan = '', status = 'active'` : ''} WHERE id = $1`, [h.accountId, usd]);
};
const lastCharged = async () => Number((await pool.query(`SELECT charged_usd FROM ai_spend WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [h.accountId])).rows[0].charged_usd);
const blockedWith = async (model: string) => {
  try {
    await accountAi(h.ai, h.accountId, h.botId).complete({ ...req, model, fallback_models: 'none' });
    return '';
  } catch (e: any) {
    assert.ok(e instanceof AiBudgetBlocked, String(e));
    return e.code as string;
  }
};

t('PAY-24: con tope de la plataforma, una tarifa propia más baja no abarata lo que se cobra', async () => {
  try {
    await setCap(5); await setPrices([]); await call();
    const base = await lastCharged();
    assert.ok(base > 0);
    await setPrices([{ model: 'gpt-4.1-mini', input_per_mtok: 0.000001, output_per_mtok: 0.000001 }]); await call();
    assert.equal(await lastCharged(), base);
    await setPrices([{ model: 'gpt-4.1-mini', input_per_mtok: 0, output_per_mtok: 0, is_free: true }]); await call();
    assert.equal(await lastCharged(), base);
  } finally {
    await setPrices([]); await setCap(null);
  }
});

t('PAY-24: con tope de la plataforma, un modelo que solo tiene tarifa propia se bloquea como price_unknown', async () => {
  try {
    await setCap(5); await setPrices([{ model: 'modelo-propio', input_per_mtok: 1, output_per_mtok: 1 }]);
    assert.equal(await blockedWith('modelo-propio'), 'price_unknown');
  } finally {
    await setPrices([]); await setCap(null);
  }
});

t('PAY-24: sin tope de la plataforma, la tarifa propia sigue mandando', async () => {
  const saved = config.signup.planDefaultAiUsd;
  config.signup.planDefaultAiUsd = 0;
  try {
    await setCap(null); await setPrices([{ model: 'gpt-4.1-mini', input_per_mtok: 100, output_per_mtok: 100 }]); await call();
    assert.ok((await lastCharged()) > 0.01);
  } finally {
    config.signup.planDefaultAiUsd = saved;
    await setPrices([]);
  }
});
