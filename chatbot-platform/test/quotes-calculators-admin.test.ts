/**
 * Administrar calculadoras entre cuentas: plantillas por giro, exportar e importar con su texto y sus precios (formato 2,
 * y el 1 de antes), y copiar a otra cuenta (solo superadmin). Todo llega apagado y aislado en la cuenta destino.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type As = Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
let agent: As;
let owner: As;
let other: As;
let sup: As;
let otherAccount: string;

const DEF = {
  inputs: [{ key: 'm2', label: 'Metros cuadrados', type: 'number', min: 1 }, { key: 'acabado', label: 'Acabado', type: 'option', options: [{ value: 'mate', label: 'Mate' }, { value: 'satinado', label: 'Satinado' }] }],
  values: [{ key: 'litros', formula: 'redondear_arriba(m2 / 10)' }],
  lines: [{ label: 'Pintura {acabado}', family: 'pintura', match: { acabado: 'acabado' }, qty: 'litros' }],
  legend: 'Aproximada.',
};
const item = (code: string, acabado: string, pesos: number) => ({ code, name: `Pintura ${acabado}`, description: '', unit: 'litro', family: 'pintura', attributes: { acabado }, price_mode: 'exact', price_min: pesos * 100, price_max: null, iva_mode: 'plus', active: true, sort: 0 });
const FILE = { format: 'riverrun.quote-calculator', version: 2, name: 'Pintura', description: '', template_key: 'texto', source_text: 'Pintura por m²: mate $90, satinado $110 el litro.', definition: DEF, price_items: [item('PNT-MATE', 'mate', 90), item('PNT-SAT', 'satinado', 110)] };

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({});
  await h.addUser({ account_id: h.accountId, name: 'Agente', email: 'agente@admcalc.test', password: 'Pz-120-Qx-320-Kv', role: 'agent' });
  agent = await h.loginAs('agente@admcalc.test', 'Pz-120-Qx-320-Kv');
  await h.addUser({ account_id: h.accountId, name: 'Dueña', email: 'duena@admcalc.test', password: 'Pz-123-Qx-323-Kv', role: 'admin' });
  owner = await h.loginAs('duena@admcalc.test', 'Pz-123-Qx-323-Kv');
  otherAccount = (await h.addAccount({ name: 'Pinturas del Norte', admin: { email: 'admin@norte.test', password: 'Pz-121-Qx-321-Kv' } })).id;
  other = await h.loginAs('admin@norte.test', 'Pz-121-Qx-321-Kv');
  await h.addSuperadmin('super@admcalc.test', 'Pz-122-Qx-322-Kv');
  sup = await h.loginAs('super@admcalc.test', 'Pz-122-Qx-322-Kv');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const itemsOf = async (accountId: string, calculatorId: string) =>
  (await pool.query('SELECT code, price_min::int AS price_min, attributes FROM price_items WHERE account_id = $1 AND calculator_id = $2 ORDER BY code', [accountId, calculatorId])).rows;

t('plantillas por giro: textos para empezar, solo para administradores', async () => {
  const list = (await h.authed('GET', '/api/quote-calculators/text-templates')).json();
  assert.ok(list.length >= 6);
  assert.deepEqual(list.map((x: any) => x.key).slice(0, 3), ['cercas', 'superficies', 'eventos']);
  assert.ok(list.every((x: any) => x.label && x.text.length > 100 && /\$\d/.test(x.text)), 'cada plantilla trae precios de ejemplo');
  assert.equal((await agent('GET', '/api/quote-calculators/text-templates')).statusCode, 403);
});

t('importar con precios (formato 2) y exportar de vuelta: mismo texto, definición y precios; llega apagada', async () => {
  const acct = `?account_id=${h.accountId}`;
  const res = await h.authed('POST', `/api/quote-calculators/import${acct}`, FILE);
  assert.equal(res.statusCode, 200, res.body);
  const calc = res.json();
  assert.deepEqual([calc.active, calc.created, calc.source_text], [false, 2, FILE.source_text]);
  assert.deepEqual((await itemsOf(h.accountId, calc.id)).map((i: any) => [i.code, i.price_min]), [['PNT-MATE', 9000], ['PNT-SAT', 11000]]);

  const exp = (await h.authed('GET', `/api/quote-calculators/${calc.id}/export`)).json();
  assert.equal(exp.version, 2);
  assert.equal(exp.source_text, FILE.source_text);
  assert.deepEqual(exp.price_items.map((i: any) => [i.code, i.price_min, i.attributes]), [['PNT-MATE', 9000, { acabado: 'mate' }], ['PNT-SAT', 11000, { acabado: 'satinado' }]]);
  assert.equal(exp.price_items[0].id, undefined, 'sin ids');

  // En otra cuenta (otra instalación): la misma calculadora con sus precios, que cotiza igual.
  const there = (await other('POST', '/api/quote-calculators/import', exp)).json();
  assert.notEqual(there.id, calc.id);
  assert.deepEqual(there.definition, calc.definition);
  assert.equal((await itemsOf(otherAccount, there.id)).length, 2);
  const pv = (await other('POST', `/api/quote-calculators/${there.id}/preview`, { inputs: { m2: 25, acabado: 'satinado' } })).json();
  assert.ok(pv.ok, JSON.stringify(pv));
  assert.equal(pv.priced.total_min, 3 * 11000 * 1.16);

  // El formato 1 (solo la calculadora) sigue funcionando.
  const v1 = await h.authed('POST', `/api/quote-calculators/import${acct}`, { format: 'riverrun.quote-calculator', version: 1, name: 'Vieja', definition: DEF });
  assert.equal(v1.statusCode, 200, v1.body);
  assert.equal(v1.json().created, 0);

  // Un archivo con un precio mal hecho no importa nada.
  const bad = await h.authed('POST', `/api/quote-calculators/import${acct}`, { ...FILE, name: 'Mala', price_items: [item('PNT-MATE', 'mate', 90), { ...item('PNT-SAT', 'satinado', 110), price_mode: 'range' }] });
  assert.equal(bad.statusCode, 400);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM quote_calculators WHERE account_id = $1 AND name = 'Mala'`, [h.accountId])).rows[0].n, 0);
});

t('copiar a otra cuenta: solo el superadmin; con o sin precios; llega apagada y aislada', async () => {
  const calc = (await h.authed('GET', `/api/quote-calculators?account_id=${h.accountId}`)).json().find((c: any) => c.name === 'Pintura');
  // Un administrador de cuenta (ni siquiera hacia la suya) no copia calculadoras; el agente tampoco.
  assert.equal((await other('POST', `/api/quote-calculators/${calc.id}/copy`, { account_id: otherAccount })).statusCode, 403);
  assert.equal((await agent('POST', `/api/quote-calculators/${calc.id}/copy`, { account_id: otherAccount })).statusCode, 403);

  const copy = await sup('POST', `/api/quote-calculators/${calc.id}/copy`, { account_id: otherAccount, with_prices: true });
  assert.equal(copy.statusCode, 200, copy.body);
  const c = copy.json();
  assert.deepEqual([c.account_id, c.active, c.source_text, c.updated + c.created], [otherAccount, false, FILE.source_text, 2]);
  assert.equal((await itemsOf(otherAccount, c.id)).length, 2);
  assert.equal((await other('GET', '/api/quote-calculators')).json().some((x: any) => x.id === c.id), true, 'la otra cuenta la ve');
  assert.equal((await owner('GET', `/api/quote-calculators/${c.id}`)).statusCode, 404, 'la cuenta de origen no ve la copia');
  assert.equal((await other('GET', `/api/quote-calculators/${calc.id}`)).statusCode, 404, 'la cuenta destino no ve la original');
  assert.equal((await owner('POST', `/api/quote-calculators/${calc.id}/copy`, { account_id: h.accountId })).statusCode, 403, 'ni el administrador de la cuenta de origen copia');

  const bare = (await sup('POST', `/api/quote-calculators/${calc.id}/copy`, { account_id: otherAccount, with_prices: false })).json();
  assert.equal((await itemsOf(otherAccount, bare.id)).length, 0);

  assert.equal((await sup('POST', `/api/quote-calculators/${calc.id}/copy`, { account_id: '00000000-0000-4000-8000-000000000000' })).statusCode, 404);
  assert.equal((await sup('POST', '/api/quote-calculators/00000000-0000-4000-8000-000000000000/copy', { account_id: otherAccount })).statusCode, 404);
  const logs = await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE account_id = $1 AND message LIKE '%copió aquí la calculadora%'`, [otherAccount]);
  assert.equal(logs.rows[0].n, 2, 'la cuenta destino sabe qué llegó');
});

t('una cuenta admite hasta 20 calculadoras, también al importar o copiar', async () => {
  const n = (await pool.query('SELECT count(*)::int AS n FROM quote_calculators WHERE account_id = $1', [otherAccount])).rows[0].n;
  for (let i = n; i < 20; i++) assert.equal((await other('POST', '/api/quote-calculators/import', { ...FILE, name: `P${i}`, price_items: [] })).statusCode, 200);
  const over = await other('POST', '/api/quote-calculators/import', { ...FILE, name: 'Una más', price_items: [] });
  assert.equal(over.statusCode, 400);
  assert.match(over.json().error, /hasta 20 calculadoras/);
  const calc = (await h.authed('GET', `/api/quote-calculators?account_id=${h.accountId}`)).json()[0];
  assert.equal((await sup('POST', `/api/quote-calculators/${calc.id}/copy`, { account_id: otherAccount })).statusCode, 400);
});
