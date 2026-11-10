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

test('cotizaciones: la cantidad debe salir de lo que escribió el cliente (cifras o palabras)', async () => {
  const { customerSaidQuantity, quantitiesIn } = await import('../src/engine/validator.js');
  assert.ok(quantitiesIn('somos 1,500 personas').includes(1500));
  assert.ok(quantitiesIn('ciento cincuenta invitados').includes(150));
  assert.ok(quantitiesIn('dos mil volantes').includes(2000));
  assert.ok(quantitiesIn('dos docenas').includes(24));
  assert.ok(quantitiesIn('treinta y cinco sillas').includes(35));
  assert.ok(quantitiesIn('2.5 horas').includes(2.5));
  const said = ['Hola, cotízame el banquete para 80 personas el sábado'];
  assert.equal(customerSaidQuantity(80, '80 personas', said), true);
  assert.equal(customerSaidQuantity(120, '80 personas', said), false, 'la cita no dice esa cantidad');
  assert.equal(customerSaidQuantity(120, '120 personas', said), false, 'el cliente no lo escribió');
  assert.equal(customerSaidQuantity(80, '', said), false);
});

test('cotizaciones: el IVA es subtotal × tasa, redondeado una sola vez (no la suma del IVA de cada renglón)', () => {
  // Metromalla, 1 m Clásica 1.00 m con placa: subtotal $1,872.91 × 0.16 = $299.6656 → $299.67.
  // Redondeando el IVA de cada renglón salía $299.66 (144.75 + 104.59 + 31.64 + 18.68).
  const q = priceQuote([
    line({ name: 'Panel', qty: 1, price_min: 90471 }),
    line({ name: 'Poste', qty: 2, price_min: 32683 }),
    line({ name: 'Placa', qty: 2, price_min: 9889 }),
    line({ name: 'Abrazadera', qty: 4, price_min: 2919 }),
  ], IVA);
  assert.deepEqual([q.subtotal_min, q.iva_min, q.total_min], [187291, 29967, 217258]);
  // Ejemplo oficial de Metromalla (Clásica, 25 m, 1.50 m, con placa y flete): subtotal $16,981.05, IVA $2,716.97.
  const ex = priceQuote([line({ price_min: 956800 }), line({ price_min: 298100 }), line({ price_min: 148335 }), line({ price_min: 144870 }), line({ price_min: 150000 })], IVA);
  assert.deepEqual([ex.subtotal_min, ex.iva_min, ex.total_min], [1698105, 271697, 1969802]);
  // Con renglones de IVA incluido y exentos: el IVA de los que «suman IVA» se calcula sobre su suma; el incluido se separa
  // de su propio importe; el exento no lleva.
  const mixed = priceQuote([line({ price_min: 333 }), line({ price_min: 333 }), line({ price_min: 116000, iva_mode: 'included' }), line({ price_min: 5000, iva_mode: 'exempt' })], IVA);
  assert.equal(mixed.iva_min, Math.round(666 * 0.16) + 16000, '0.16 × $6.66 = $1.07 (renglón por renglón eran $0.53 + $0.53)');
  assert.equal(mixed.subtotal_min, 666 + 100000 + 5000);
  // En un rango, mínimo y máximo con la misma regla.
  const r = priceQuote([line({ price_mode: 'range', price_min: 333, price_max: 999 }), line({ price_min: 333 })], IVA);
  assert.deepEqual([r.iva_min, r.iva_max], [Math.round(666 * 0.16), Math.round(1332 * 0.16)]);
});
