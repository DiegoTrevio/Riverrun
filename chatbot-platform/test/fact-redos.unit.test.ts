/** Verificación de hechos: el texto de un cliente no congela el proceso, por largo u hostil que sea (IN-15). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampInbound, extractFacts, extractMoney, FactCorpus, MAX_INBOUND_TEXT } from '../src/engine/text.js';

/** Con expresiones que retroceden, 65 000 caracteres de `a.` tardaban 17 s por pasada (crece al cuadrado). */
const PIECES = ['a.', '1.', 'a@', 'a-', 'a.a@', '1,', '$1', 'www.a', 'a.co/', '1 '];

for (const size of [20_000, 1024 * 1024]) {
  test(`extractFacts y FactCorpus con ${size} caracteres hostiles tardan poco`, () => {
    for (const piece of PIECES) {
      const s = piece.repeat(Math.ceil(size / piece.length));
      const t = performance.now();
      extractFacts(s);
      extractMoney(s);
      new FactCorpus([s]);
      const ms = performance.now() - t;
      // Lineal: 20 000 caracteres en milisegundos y 1 MB en segundos (antes, 1 MB eran horas). Un mensaje se corta en
      // 8 000 caracteres, así que el historial de un cliente (14 mensajes) queda muy por debajo de 1 MB.
      assert.ok(ms < (size > 100_000 ? 6000 : 150), `«${piece}» × ${size}: ${ms.toFixed(0)} ms`);
    }
  });
}

test('extractFacts sigue reconociendo lo de antes', () => {
  const f = extractFacts('Escríbenos a ventas@hotel.mx o entra a www.hotel.mx/reservas, mpago.la/abc o https://linktr.ee/hotel; llama al 55 1234 5678. Cuesta $1,650');
  assert.deepEqual(f.emails, ['ventas@hotel.mx']);
  assert.deepEqual(f.urls, ['hotel.mx/reservas', 'mpago.la/abc', 'linktr.ee/hotel']);
  assert.deepEqual(f.phones, ['5512345678']);
  assert.ok(f.numbers.includes('1650'));
  assert.deepEqual(extractMoney('cuesta $1,650 o 15 mil pesos, US$ 20'), ['1650', '15000', '20']);
});

test('clampInbound corta a 8 000 caracteres y lo dice', () => {
  assert.equal(MAX_INBOUND_TEXT, 8000);
  assert.equal(clampInbound('hola'), 'hola');
  assert.equal(clampInbound('x'.repeat(8000)), 'x'.repeat(8000));
  const c = clampInbound('x'.repeat(20_000));
  assert.ok(c.length <= 8000 + 30, `${c.length}`);
  assert.ok(c.endsWith('…[mensaje recortado]'));
  // No parte un emoji (par sustituto) a la mitad.
  assert.doesNotMatch(clampInbound('x'.repeat(7999) + '😀'.repeat(10)), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
