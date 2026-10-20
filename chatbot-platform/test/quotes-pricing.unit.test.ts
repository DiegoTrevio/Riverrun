/** Cálculo de cotizaciones: centavos exactos, cada tipo de precio y de IVA, y cómo se escriben los totales. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineProblem, priceQuote, type LineInput } from '../src/quotes/pricing.js';
import { formatDate, formatLineAmount, formatMoney, formatTotals, formatUnitPrice } from '../src/quotes/format.js';

const IVA = { iva_rate: 0.16 };
const line = (o: Partial<LineInput>): LineInput => ({ name: 'Concepto', qty: 1, price_mode: 'exact', price_min: 100000, price_max: null, iva_mode: 'plus', ...o });

test('cotizaciones: precio exacto con IVA que se suma', () => {
  const q = priceQuote([line({ qty: 2, price_min: 165000 })], IVA);
  assert.equal(q.subtotal_min, 330000);
  assert.equal(q.iva_min, 52800);
  assert.equal(q.total_min, 382800);
  assert.equal(q.total_max, q.total_min);
  assert.equal(q.can_be_final, true);
  assert.equal(formatTotals(q).total, '$3,828.00');
});

test('cotizaciones: IVA incluido y exento', () => {
  const inc = priceQuote([line({ price_min: 116000, iva_mode: 'included' })], IVA);
  assert.deepEqual([inc.subtotal_min, inc.iva_min, inc.total_min], [100000, 16000, 116000]);
  const ex = priceQuote([line({ price_min: 50000, iva_mode: 'exempt' })], IVA);
  assert.deepEqual([ex.subtotal_min, ex.iva_min, ex.total_min], [50000, 0, 50000]);
  // Con IVA incluido el total es siempre el precio escrito, aunque el redondeo reparta centavos.
  const odd = priceQuote([line({ price_min: 99999, iva_mode: 'included', qty: 3 })], IVA);
  assert.equal(odd.total_min, 299997);
});

test('cotizaciones: redondeo al centavo con cantidades decimales', () => {
  const q = priceQuote([line({ qty: 1.5, price_min: 333, iva_mode: 'exempt' })], IVA);
  assert.equal(q.subtotal_min, 500, '333 × 1.5 = 499.5 → 500');
  const iva = priceQuote([line({ price_min: 3, iva_mode: 'plus' })], IVA);
  assert.equal(iva.iva_min, 0, '3 × 0.16 = 0.48 → 0');
  assert.equal(lineProblem({ qty: 1.2345, price_mode: 'exact', price_min: 1, price_max: null, iva_mode: 'plus' }), 'La cantidad admite hasta 3 decimales');
});

test('cotizaciones: rango, «desde» y por confirmar dan una cotización aproximada', () => {
  const q = priceQuote([
    line({ name: 'Renta', price_min: 165000 }),
    line({ name: 'Decoración', price_mode: 'range', price_min: 100000, price_max: 150000 }),
  ], IVA);
  assert.equal(q.total_min, 191400 + 116000);
  assert.equal(q.total_max, 191400 + 174000);
  assert.equal(q.can_be_final, false);
  assert.equal(formatTotals(q).total, '$3,074.00 a $3,654.00');

  const from = priceQuote([line({ price_mode: 'from', price_min: 120000 }), line({ price_mode: 'tbd', price_min: null })], IVA);
  assert.equal(from.open_ended, true);
  assert.equal(from.has_tbd, true);
  assert.equal(formatTotals(from).total, 'desde $1,392.00 + conceptos por confirmar');
  assert.equal(formatLineAmount(from.lines[1]), 'Por confirmar');

  const onlyTbd = priceQuote([line({ price_mode: 'tbd', price_min: null })], IVA);
  assert.equal(formatTotals(onlyTbd).total, 'Por confirmar');
  assert.equal(priceQuote([], IVA).can_be_final, false);
});

test('cotizaciones: conceptos incoherentes se rechazan con un mensaje claro', () => {
  assert.throws(() => priceQuote([line({ price_mode: 'range', price_min: 5, price_max: 5 })], IVA), /mínimo debe ser menor/);
  assert.throws(() => priceQuote([line({ price_min: null })], IVA), /Falta el precio/);
  assert.throws(() => priceQuote([line({ qty: 0 })], IVA), /cantidad/);
  assert.throws(() => priceQuote([line({ price_mode: 'tbd', price_min: 10 })], IVA), /no lleva monto/);
  assert.throws(() => priceQuote(Array.from({ length: 101 }, () => line({})), IVA), /hasta 100/);
});

test('cotizaciones: precios y fechas en español de México', () => {
  assert.equal(formatMoney(123456789), '$1,234,567.89');
  assert.equal(formatUnitPrice({ price_mode: 'from', price_min: 120000, price_max: null }), 'desde $1,200.00');
  assert.equal(formatUnitPrice({ price_mode: 'range', price_min: 100000, price_max: 150000 }), '$1,000.00 a $1,500.00');
  assert.equal(formatDate('2026-11-04'), '4 de noviembre de 2026');
  assert.match(formatMoney(100000, 'USD'), /1,000\.00/);
});
