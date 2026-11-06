/**
 * API de calculadoras de cotización y lista de precios en CSV: crear, versionar, probar con datos, exportar e importar,
 * subir y bajar la lista de precios, y que una cuenta nunca vea ni use lo de otra.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let other: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
let agent: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({});
  await h.addUser({ account_id: h.accountId, name: 'Agente', email: 'agente@calc.test', password: 'Pz-101-Qx-301-Kv', role: 'agent' });
  agent = await h.loginAs('agente@calc.test', 'Pz-101-Qx-301-Kv');
  await h.addAccount({ name: 'Otra empresa', admin: { email: 'admin@otra.test', password: 'Pz-202-Qx-402-Kv' } });
  other = await h.loginAs('admin@otra.test', 'Pz-202-Qx-402-Kv');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const CSV = [
  'clave,nombre,familia,precio,iva,producto,escalon',
  'PAN-A,Panel recto,panel,"1,000.00",mas,recta,A',
  'PAN-B,Panel recto,panel,900,mas,recta,B',
  'INST,Instalación por metro,instalacion,$150,,,',
].join('\n');

const DEF = {
  inputs: [
    { key: 'metros', label: 'Metros', type: 'number', min: 1, max: 1000 },
    { key: 'producto', label: 'Producto', type: 'option', options: [{ value: 'recta', label: 'Recta' }, { value: 'curva', label: 'Curva' }] },
    { key: 'instalacion', label: 'Instalación', type: 'boolean', required: false },
  ],
  values: [
    { key: 'escalon', tiers: { of: 'metros', steps: [{ below: 20, value: 'A' }, { below: 100, value: 'B' }], otherwise: { stop: 'Para 100 metros o más te atiende un asesor.' } } },
    { key: 'paneles', formula: 'redondear_arriba(metros / 2.5)' },
  ],
  lines: [
    { family: 'panel', match: { producto: 'producto', escalon: 'escalon' }, qty: 'paneles' },
    { family: 'instalacion', qty: 'metros', when: 'instalacion' },
  ],
  legend: 'Precio aproximado.',
};

t('lista de precios en CSV: revisar sin guardar, subir, actualizar por clave y bajar', async () => {
  const acct = `?account_id=${h.accountId}`;
  const bad = (await h.authed('POST', `/api/price-items/import${acct}`, { csv: 'clave,nombre,precio\nX,Algo,mucho' })).json();
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /no es un precio/);

  const dry = (await h.authed('POST', `/api/price-items/import${acct}`, { csv: CSV, dry_run: true })).json();
  assert.deepEqual([dry.ok, dry.create, dry.update], [true, 3, 0]);
  assert.equal((await h.authed('GET', `/api/price-items${acct}`)).json().length, 0, 'la revisión no guarda nada');

  const done = await h.authed('POST', `/api/price-items/import${acct}`, { csv: CSV });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual([done.json().created, done.json().updated], [3, 0]);
  const again = (await h.authed('POST', `/api/price-items/import${acct}`, { csv: CSV.replace('900,', '950,') })).json();
  assert.deepEqual([again.created, again.updated], [0, 3]);

  const items = (await h.authed('GET', `/api/price-items${acct}`)).json();
  const panB = items.find((i: any) => i.code === 'PAN-B');
  assert.deepEqual([panB.family, panB.attributes, panB.price_min], ['panel', { producto: 'recta', escalon: 'B' }, 95000]);

  // Un panel viejo que no conoce los atributos no los borra al editar.
  const upd = (await h.authed('PUT', `/api/price-items/${panB.id}`, { name: 'Panel recto B' })).json();
  assert.deepEqual(upd.attributes, { producto: 'recta', escalon: 'B' });

  const csv = await h.authed('GET', `/api/price-items/export.csv${acct}`);
  assert.equal(csv.statusCode, 200);
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  assert.match(csv.body, /clave,nombre,familia/);
  assert.match(csv.body, /PAN-B,Panel recto B,panel,.*950\.00/);

  assert.equal((await agent('POST', '/api/price-items/import', { csv: CSV })).statusCode, 403);
});

t('calculadoras: crear, versionar, probar con datos, exportar e importar', async () => {
  const acct = `?account_id=${h.accountId}`;
  const broken = await h.authed('POST', `/api/quote-calculators${acct}`, { name: 'Rota', definition: { ...DEF, lines: [{ family: 'panel', qty: 'tablas' }] } });
  assert.equal(broken.statusCode, 400);
  assert.match(broken.json().error, /tablas/);

  const made = await h.authed('POST', `/api/quote-calculators${acct}`, { name: 'Cercas', definition: DEF });
  assert.equal(made.statusCode, 200, made.body);
  const calc = made.json();
  assert.equal(calc.version, 1);

  const same = (await h.authed('PUT', `/api/quote-calculators/${calc.id}`, { description: 'Cercas por metro' })).json();
  assert.deepEqual([same.version, same.description], [1, 'Cercas por metro'], 'sin cambiar la definición no sube la versión');
  const changed = (await h.authed('PUT', `/api/quote-calculators/${calc.id}`, { definition: { ...DEF, legend: 'Aproximado, sujeto a visita.' } })).json();
  assert.equal(changed.version, 2);

  const r = (await h.authed('POST', `/api/quote-calculators/${calc.id}/preview`, { inputs: { metros: 40, producto: 'Recta', instalacion: true } })).json();
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.lines.map((l: any) => [l.name, l.qty]), [['Panel recto B', 16], ['Instalación por metro', 40]]);
  // 16 × $950 + 40 × $150 = $21,200.00; IVA 16 % = $3,392.00.
  assert.equal(r.priced.total_min, 2_459_200);
  assert.match(r.totals.total, /24,592\.00/);

  const stop = (await h.authed('POST', `/api/quote-calculators/${calc.id}/preview`, { inputs: { metros: 150, producto: 'recta' } })).json();
  assert.deepEqual([stop.ok, stop.reason], [false, 'stop']);
  const missing = (await h.authed('POST', `/api/quote-calculators/${calc.id}/preview`, { inputs: {} })).json();
  assert.deepEqual([missing.ok, missing.reason], [false, 'missing']);

  const draft = (await h.authed('POST', `/api/quote-calculators/preview${acct}`, { definition: DEF, inputs: { metros: 10, producto: 'recta' } })).json();
  assert.ok(draft.ok && draft.lines[0].name === 'Panel recto', 'un borrador sin guardar también se prueba (escalón A)');

  const exp = await h.authed('GET', `/api/quote-calculators/${calc.id}/export`);
  assert.equal(exp.statusCode, 200);
  const file = exp.json();
  assert.equal(file.format, 'riverrun.quote-calculator');
  assert.equal(file.id, undefined, 'el archivo no lleva ids');

  assert.equal((await h.authed('POST', `/api/quote-calculators/import${acct}`, { ...file, format: 'otra-cosa' })).statusCode, 400);
  const imported = (await h.authed('POST', `/api/quote-calculators/import${acct}`, file)).json();
  assert.notEqual(imported.id, calc.id);
  assert.equal(imported.active, false, 'lo importado llega apagado hasta revisarlo');
  assert.deepEqual(imported.definition, changed.definition);

  assert.equal((await h.authed('GET', `/api/quote-calculators${acct}`)).json().length, 2);
  assert.equal((await h.authed('DELETE', `/api/quote-calculators/${imported.id}`)).statusCode, 200);
  assert.equal((await h.authed('GET', `/api/quote-calculators${acct}`)).json().length, 1);

  assert.equal((await agent('GET', '/api/quote-calculators')).statusCode, 403);
  assert.equal((await agent('POST', `/api/quote-calculators/${calc.id}/preview`, { inputs: {} })).statusCode, 403);
});

t('calculadoras: otra cuenta no las ve, no las prueba y no usa los precios ajenos', async () => {
  const [calc] = (await h.authed('GET', `/api/quote-calculators?account_id=${h.accountId}`)).json();
  assert.equal((await other('GET', '/api/quote-calculators')).json().length, 0);
  assert.equal((await other('GET', `/api/quote-calculators/${calc.id}`)).statusCode, 404);
  assert.equal((await other('PUT', `/api/quote-calculators/${calc.id}`, { name: 'Mía' })).statusCode, 404);
  assert.equal((await other('DELETE', `/api/quote-calculators/${calc.id}`)).statusCode, 404);
  assert.equal((await other('POST', `/api/quote-calculators/${calc.id}/preview`, { inputs: {} })).statusCode, 404);
  assert.equal((await other('GET', `/api/quote-calculators/${calc.id}/export`)).statusCode, 404);

  // Con la misma definición, la otra cuenta no tiene precios: no cotiza con los de la primera.
  const r = (await other('POST', '/api/quote-calculators/preview', { definition: DEF, inputs: { metros: 40, producto: 'recta' } })).json();
  assert.deepEqual([r.ok, r.reason], [false, 'price']);
  assert.match((await other('GET', '/api/price-items/export.csv')).body, /^﻿?clave,nombre/);
  assert.doesNotMatch((await other('GET', '/api/price-items/export.csv')).body, /PAN-B/);
});
