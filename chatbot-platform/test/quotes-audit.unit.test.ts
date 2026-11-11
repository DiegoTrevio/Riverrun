/**
 * Revisión del cotizador de punta a punta: lo que ve el cliente tiene que cuadrar (cantidad × precio = importe,
 * subtotal + IVA = total) y los datos se entienden como los escribe una persona.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInputs, CalculatorDefinition, evaluateCalculator, parseHumanNumber } from '../src/quotes/calculator.js';
import { formatLineAmount, formatMoney, formatTotals, formatUnitPrice } from '../src/quotes/format.js';
import { priceQuote, unitBeforeIva, type LineInput } from '../src/quotes/pricing.js';
import { summaryMessage } from '../src/quotes/messages.js';
import { runExample } from '../src/quotes/from-text.js';
import type { PriceItem, Quote } from '../src/store/quotes.js';

const IVA = { iva_rate: 0.16 };
const line = (o: Partial<LineInput>): LineInput => ({ name: 'Concepto', qty: 1, price_mode: 'exact', price_min: 100000, price_max: null, iva_mode: 'included', ...o });

test('IVA incluido: cada renglón cuadra (cantidad × precio unitario = importe) y el total es el precio de lista', () => {
  const q = priceQuote([line({ name: 'Panel', qty: 3, price_min: 116000 }), line({ name: 'Poste', qty: 4, price_min: 35000 }), line({ name: 'Malla', qty: 2.5, price_min: 9999 })], IVA);
  for (const l of q.lines) {
    const unit = unitBeforeIva(l.price_min!, l.iva_mode, IVA.iva_rate);
    assert.equal(l.amount_min, Math.round(unit * l.qty), `${l.name}: ${l.qty} × ${unit} debe dar el importe`);
  }
  // El cliente paga lo que dice la lista: 3 × $1,160 + 4 × $350 + 2.5 × $99.99 (redondeado al centavo).
  assert.equal(q.total_min, 348000 + 140000 + Math.round(9999 * 2.5));
  assert.equal(q.subtotal_min + q.iva_min, q.total_min);
  assert.equal(q.subtotal_min, q.lines.reduce((s, l) => s + l.amount_min!, 0));
  assert.equal(formatUnitPrice(q.lines[1], 'MXN', IVA.iva_rate), '$301.72');
  assert.equal(formatLineAmount(q.lines[1]), '$1,206.88');
});

test('IVA incluido: el desglose del chat muestra el precio sin IVA para que la suma se pueda revisar', () => {
  const priced = priceQuote([line({ name: 'Panel', qty: 3, price_min: 116000, unit: 'pieza' })], IVA);
  const quote = { ...priced, folio: 'C-1', kind: 'approximate', currency: 'MXN', iva_rate: 0.16, valid_until: '2026-11-25' } as unknown as Quote;
  const text = summaryMessage(quote, 'tu');
  assert.match(text, /3 × Panel — \$1,000\.00 = \$3,000\.00/);
  assert.match(text, /Subtotal: \$3,000\.00/);
  assert.match(text, /IVA: \$480\.00/);
  assert.match(text, /Total: \$3,480\.00/);
});

test('IVA que se suma o exento: el precio unitario no cambia', () => {
  assert.equal(unitBeforeIva(116000, 'plus', 0.16), 116000);
  assert.equal(unitBeforeIva(116000, 'exempt', 0.16), 116000);
  assert.equal(formatUnitPrice({ price_mode: 'range', price_min: 116000, price_max: 232000, iva_mode: 'plus' }, 'MXN', 0.16), '$1,160.00 a $2,320.00');
  assert.equal(formatUnitPrice({ price_mode: 'range', price_min: 116000, price_max: 232000, iva_mode: 'included' }, 'MXN', 0.16), '$1,000.00 a $2,000.00');
});

test('números como los escribe una persona: m2, signo de pesos, m.l. y punto final', () => {
  assert.equal(parseHumanNumber('40 m2'), 40);
  assert.equal(parseHumanNumber('40m2'), 40);
  assert.equal(parseHumanNumber('25 mts2'), 25);
  assert.equal(parseHumanNumber('12 m³'), 12);
  assert.equal(parseHumanNumber('$1,500'), 1500);
  assert.equal(parseHumanNumber('12 m.l.'), 12);
  assert.equal(parseHumanNumber('40.'), 40);
  // Lo que no es un solo número sigue sin pasar (el asistente lo vuelve a preguntar).
  assert.equal(parseHumanNumber('2x3'), null);
  assert.equal(parseHumanNumber('2x3 m'), null);
  assert.equal(parseHumanNumber('entre 20 y 30'), null);
  assert.equal(parseHumanNumber('40 m2 y 10 m2'), null);
  assert.equal(parseHumanNumber('2 m 3'), null);
  assert.equal(parseHumanNumber('10 item 2'), null);
  assert.equal(parseHumanNumber('40 m2.'), 40);
  assert.equal(parseHumanNumber('40 metros lineales'), 40);
});

const DEF = CalculatorDefinition.parse({
  inputs: [
    { key: 'altura', label: 'Altura', type: 'option', options: [{ value: '1.5', label: '1.50 m' }, { value: '2', label: '2.00 m' }] },
    { key: 'instalacion', label: 'Instalación', type: 'boolean' },
  ],
  lines: [{ family: 'x', qty: '1' }],
});

test('opciones con número: «2 m», «2 metros» o «1,5 m» eligen la opción de ese número', () => {
  for (const [said, value] of [['2 m', '2'], ['2 metros', '2'], ['2m', '2'], ['1,5 m', '1.5'], ['1.50', '1.5']]) {
    const r = checkInputs(DEF, { altura: said, instalacion: 'no' });
    assert.deepEqual(r.invalid, [], said);
    assert.equal(r.values.altura, value, said);
  }
  assert.equal(checkInputs(DEF, { altura: '3 m', instalacion: 'no' }).invalid.length, 1, 'un número que no es opción no pasa');
});

test('sí / no con cortesía: «sí, por favor», «no gracias»; «no sé» no cuenta como respuesta', () => {
  const v = (said: string) => checkInputs(DEF, { altura: '2', instalacion: said });
  for (const s of ['Sí', 'sí, por favor', 'si quiero', 'Sí, gracias', 'claro']) assert.equal(v(s).values.instalacion, true, s);
  for (const s of ['No', 'no gracias', 'no, gracias', 'No, por ahora no']) assert.equal(v(s).values.instalacion, false, s);
  for (const s of ['no sé', 'tal vez', 'si es barato', 'sí, por ahora no', 'si, por el momento no', 'no, lo quiero', 'no, me interesa', 'no, claro']) assert.equal(v(s).invalid.length, 1, s);
});

test('ejemplo del cotizador escrito con IVA incluido: el renglón cuadra', () => {
  const items: PriceItem[] = [{ id: '00000000-0000-4000-8000-000000000001', account_id: '', code: 'P', name: 'Panel', description: '', unit: 'pieza', price_mode: 'exact', price_min: 35000, price_max: null, iva_mode: 'included', active: true, sort: 0, family: 'x', attributes: {} }];
  const def = { inputs: [{ key: 'n', label: 'Piezas', type: 'number', decimals: 0, min: 1 }], lines: [{ family: 'x', qty: 'n' }] };
  const ex = runExample(def, items, 0.16, 'MXN', '', { n: 4 });
  assert.ok(ex.ok);
  assert.deepEqual(ex.lines![0], { name: 'Panel', qty: '4', unit_price: '$301.72', amount: '$1,206.88' });
  assert.equal(ex.totals!.total, formatMoney(140000));
  const r = evaluateCalculator(def, { n: 4 }, items, IVA);
  assert.ok(r.ok && formatTotals(r.priced).total === '$1,400.00');
});
