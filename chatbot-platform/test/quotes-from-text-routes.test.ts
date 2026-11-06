/**
 * Cotizador escrito en el panel: armar desde texto (sin guardar, con ejemplos calculados y una corrección si hace falta),
 * activar en el agente (precios, calculadora y configuración juntos), volver a armar (sube la versión y apaga lo que se
 * quitó), no pisar una calculadora hecha a mano, permisos y otras cuentas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let agent: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
let other: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;

const tiers = (o: Record<string, unknown> = {}) => ({ of: '', steps: [], otherwise_value: '', otherwise_stop: '', ...o });
const price = (code: string, family: string, attrs: Record<string, string>, pesos: number, unit = 'litro') =>
  ({ code, name: `${family} ${Object.values(attrs).join(' ')}`.trim(), unit, family, attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })), price: pesos, price_max: null, price_mode: 'exact', iva_mode: 'default' });
const output = (o: Record<string, unknown> = {}) => ({
  summary: 'Pintura por m² con menudeo y mayoreo.',
  price_items: [
    price('PINT-MATE-MEN', 'pintura', { acabado: 'mate', escalon: 'menudeo' }, 90),
    price('PINT-MATE-MAY', 'pintura', { acabado: 'mate', escalon: 'mayoreo' }, 80),
    price('PINT-SAT-MEN', 'pintura', { acabado: 'satinado', escalon: 'menudeo' }, 110),
    price('PINT-SAT-MAY', 'pintura', { acabado: 'satinado', escalon: 'mayoreo' }, 95),
  ],
  inputs: [
    { key: 'largo', label: 'Largo', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
    { key: 'ancho', label: 'Ancho', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
    { key: 'acabado', label: 'Acabado', help: '', type: 'option', unit: '', min: null, max: null, decimals: 0, options: [{ value: 'mate', label: 'Mate' }, { value: 'satinado', label: 'Satinado' }], required: true, default: '' },
  ],
  values: [
    { key: 'area', label: 'Área', formula: 'redondear(largo * ancho, 2)', tiers: tiers() },
    { key: 'litros', label: 'Litros', formula: 'redondear_arriba(area / 10)', tiers: tiers() },
    { key: 'escalon', label: 'Escalón', formula: '', tiers: tiers({ of: 'area', steps: [{ below: 50, value: 'menudeo' }], otherwise_value: 'mayoreo' }) },
  ],
  lines: [{ label: 'Pintura {acabado}', family: 'pintura', match: [{ attribute: 'acabado', formula: 'acabado' }, { attribute: 'escalon', formula: 'escalon' }], qty: 'litros', when: '' }],
  stops: [{ when: 'area > 500', message: 'Para más de 500 m² te atiende un asesor.' }],
  legend: 'Precio aproximado.',
  examples: [{ description: 'Cuarto', inputs: [{ key: 'largo', value: '5' }, { key: 'ancho', value: '4' }, { key: 'acabado', value: 'mate' }] }],
  unclear: [],
  ...o,
});
const TEXT = 'Pintura por m². Litros = m² ÷ 10 hacia arriba. Menudeo menos de 50 m², mayoreo desde 50. Mate $90/$80, satinado $110/$95.';
const builder = (outs: unknown[]) => {
  let n = 0;
  h.setScript((req) => (req.json_schema?.name === 'quote_builder' ? JSON.stringify(outs[Math.min(n++, outs.length - 1)]) : { messages: ['Ok'] }));
};
const builderCalls = () => h.calls.filter((c) => c.json_schema?.name === 'quote_builder');
/** Lo que hace el panel tras activar: guarda en el agente la calculadora (versión aplicada, como cualquier cambio). */
const connect = async (calculatorId: string, who = (m: string, u: string, b?: unknown) => h.authed(m, u, b)) => {
  const revision = (await h.authed('GET', `/api/chatbots/${h.botId}/versions`)).json().draft.revision;
  return who('POST', `/api/chatbots/${h.botId}/version-apply`, { revision, patch: { ai: { quotes: { enabled: true, allow_final: true, required_fields: [], template_id: '', calculator_id: calculatorId, send_summary: true, send_pdf: true } } } });
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({});
  await h.addUser({ account_id: h.accountId, name: 'Agente', email: 'agente@pinta.test', password: 'Pz-118-Qx-318-Kv', role: 'agent' });
  agent = await h.loginAs('agente@pinta.test', 'Pz-118-Qx-318-Kv');
  await h.addAccount({ name: 'Otra', admin: { email: 'admin@otra-pinta.test', password: 'Pz-119-Qx-319-Kv' } });
  other = await h.loginAs('admin@otra-pinta.test', 'Pz-119-Qx-319-Kv');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('armar desde texto: borrador con ejemplos calculados por el sistema, sin guardar nada', async () => {
  h.reset();
  builder([output()]);
  const res = await h.authed('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json();
  assert.equal(r.ready, true);
  assert.deepEqual(r.problems, []);
  // 20 m² → 2 litros mate × $90 = $180 + IVA = $208.80.
  assert.equal(r.examples[0].ok, true);
  assert.equal(r.examples[0].totals.total, '$208.80');
  assert.equal(r.draft.price_items.length, 4);
  assert.equal((await h.authed('GET', `/api/price-items?account_id=${h.accountId}`)).json().length, 0, 'no guarda precios');
  assert.equal((await h.authed('GET', `/api/quote-calculators?account_id=${h.accountId}`)).json().length, 0, 'ni calculadoras');
  const runs = await pool.query(`SELECT count(*)::int AS n FROM ai_runs WHERE account_id = $1 AND kind = 'quote_builder'`, [h.accountId]);
  assert.equal(runs.rows[0].n, 1, 'el uso de IA queda registrado');

  // Probar el borrador con otros datos: con sus precios aún sin guardar.
  const pv = (await h.authed('POST', `/api/quote-calculators/preview?account_id=${h.accountId}`, { definition: r.draft.definition, price_items: r.draft.price_items, inputs: { largo: 10, ancho: 8, acabado: 'satinado' } })).json();
  assert.ok(pv.ok, JSON.stringify(pv));
  assert.equal(pv.priced.total_min, 8 * 9500 * 1.16, '80 m² → mayoreo');
});

t('armar desde texto: si la IA se equivoca, el sistema le devuelve el problema y se queda la versión corregida', async () => {
  h.reset();
  const broken = output({ values: [{ key: 'area', label: '', formula: 'largo x ancho', tiers: tiers() }, ...output().values.slice(1)] });
  builder([broken, output()]);
  const r = (await h.authed('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId })).json();
  assert.equal(r.ready, true, JSON.stringify(r.problems));
  const calls = builderCalls();
  assert.equal(calls.length, 2);
  assert.match(String(calls[1].messages.at(-1)!.content), /el sistema encontró esto:[\s\S]*Cálculo 1 \(area\)/);

  // Si nunca se corrige, se dice qué falta y no se puede activar.
  h.reset();
  builder([broken]);
  const bad = (await h.authed('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId })).json();
  assert.equal(bad.ready, false);
  assert.match(bad.problems.join(' '), /Cálculo 1 \(area\)/);
  assert.equal(builderCalls().length, 3, 'primera versión y dos correcciones');
  const apply = await h.authed('POST', '/api/quote-calculators/from-text/apply', { text: TEXT, chatbot_id: h.botId, draft: bad.draft });
  assert.equal(apply.statusCode, 400);
});

t('activar: precios, calculadora y agente juntos; volver a armar sube la versión y apaga lo que se quitó', async () => {
  h.reset();
  builder([output()]);
  const r = (await h.authed('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId })).json();
  const res = await h.authed('POST', '/api/quote-calculators/from-text/apply', { text: TEXT, chatbot_id: h.botId, draft: r.draft });
  assert.equal(res.statusCode, 200, res.body);
  const a = res.json();
  assert.deepEqual([a.created, a.updated, a.deactivated, a.calculator.version], [4, 0, 0, 1]);
  assert.equal(a.calculator.template_key, 'texto');
  assert.equal(a.calculator.source_text, TEXT);
  // Conectarla al agente es un cambio de configuración más, con su historial de versiones (como lo hace el panel).
  assert.equal((await h.authed('GET', `/api/chatbots/${h.botId}`)).json().ai.quotes.calculator_id, '', 'guardar no cambia el agente');
  const connected = await connect(a.calculator.id);
  assert.equal(connected.statusCode, 200, connected.body);
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.equal(bot.ai.quotes.enabled, true);
  assert.equal(bot.ai.quotes.calculator_id, a.calculator.id);
  const tagged = await pool.query('SELECT count(*)::int AS n FROM price_items WHERE account_id = $1 AND calculator_id = $2 AND active', [h.accountId, a.calculator.id]);
  assert.equal(tagged.rows[0].n, 4);

  // Nuevo texto: sin satinado mayoreo y con el mate menudeo más caro.
  const next = output({ price_items: [price('PINT-MATE-MEN', 'pintura', { acabado: 'mate', escalon: 'menudeo' }, 99), ...output().price_items.slice(1, 3)] });
  builder([next]);
  const r2 = (await h.authed('POST', '/api/quote-calculators/from-text', { text: `${TEXT} (nuevo)`, chatbot_id: h.botId })).json();
  assert.match(r2.warnings.join(' '), /satinado/, 'avisa la combinación que se quedó sin precio');
  const b = (await h.authed('POST', '/api/quote-calculators/from-text/apply', { text: `${TEXT} (nuevo)`, chatbot_id: h.botId, draft: r2.draft })).json();
  assert.equal(b.calculator.id, a.calculator.id, 'la misma calculadora');
  assert.deepEqual([b.created, b.updated, b.deactivated], [0, 3, 1]);
  const items = (await h.authed('GET', `/api/price-items?account_id=${h.accountId}`)).json();
  assert.equal(items.find((i: any) => i.code === 'PINT-SAT-MAY').active, false, 'se apaga, no se borra');
  assert.equal(items.find((i: any) => i.code === 'PINT-MATE-MEN').price_min, 9900);
});

t('una calculadora armada a mano no se pisa: el texto crea la suya', async () => {
  const manual = (await h.authed('POST', `/api/quote-calculators?account_id=${h.accountId}`, { name: 'A mano', definition: { inputs: [{ key: 'n', label: 'Cantidad', type: 'number' }], lines: [{ family: 'pintura', qty: 'n' }] } })).json();
  assert.equal((await connect(manual.id)).statusCode, 200);
  h.reset();
  builder([output()]);
  const r = (await h.authed('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId })).json();
  const a = (await h.authed('POST', '/api/quote-calculators/from-text/apply', { text: TEXT, chatbot_id: h.botId, draft: r.draft })).json();
  assert.notEqual(a.calculator.id, manual.id);
  const still = (await h.authed('GET', `/api/quote-calculators/${manual.id}`)).json();
  assert.equal(still.definition.lines[0].qty, 'n', 'la de a mano sigue igual');
});

t('permisos: el agente no arma ni activa; otra cuenta no usa este agente', async () => {
  builder([output()]);
  assert.equal((await agent('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId })).statusCode, 403);
  assert.equal((await agent('POST', '/api/quote-calculators/from-text/apply', { text: TEXT, chatbot_id: h.botId, draft: { price_items: [], definition: {} } })).statusCode, 403);
  const o1 = await other('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId });
  assert.ok([403, 404].includes(o1.statusCode), o1.body);
  const r = (await h.authed('POST', '/api/quote-calculators/from-text', { text: TEXT, chatbot_id: h.botId })).json();
  const o2 = await other('POST', '/api/quote-calculators/from-text/apply', { text: TEXT, chatbot_id: h.botId, draft: r.draft });
  assert.ok([403, 404].includes(o2.statusCode), o2.body);
  assert.equal((await h.authed('POST', '/api/quote-calculators/from-text', { text: '   ', chatbot_id: h.botId })).statusCode, 400);
  // Una calculadora de otra cuenta no se puede conectar a este agente.
  const foreign = (await other('POST', '/api/quote-calculators', { name: 'Ajena', definition: { inputs: [{ key: 'n', label: 'Cantidad', type: 'number' }], lines: [{ family: 'x', qty: 'n' }] } })).json();
  const bad = await connect(foreign.id);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /no existe en esta cuenta/);
});
