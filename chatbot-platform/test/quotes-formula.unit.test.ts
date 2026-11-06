/** Fórmulas de la calculadora: operaciones, condiciones, redondeos, textos que son número y errores en palabras. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, FormulaError, run } from '../src/quotes/formula.js';

test('fórmulas: precedencia, paréntesis y menos', () => {
  assert.equal(run('2 + 3 * 4', {}), 14);
  assert.equal(run('(2 + 3) * 4', {}), 20);
  assert.equal(run('-2 * -3', {}), 6);
  assert.equal(run('10 / 4', {}), 2.5);
});

test('fórmulas: redondeos sin errores de coma flotante', () => {
  assert.equal(run('redondear_arriba(metros / 2.5)', { metros: 40 }), 16);
  assert.equal(run('redondear_arriba(metros / 2.5)', { metros: 37.5 }), 15, '37.5 / 2.5 es 15 exacto, no 16');
  assert.equal(run('redondear_arriba(metros / 2.5)', { metros: 37.6 }), 16);
  assert.equal(run('redondear_abajo(7, 2)', {}), 6);
  assert.equal(run('redondear(2.345, 2)', {}), 2.35);
  assert.equal(run('min(3, 1, 2) + max(4, 9) + abs(-1)', {}), 11);
});

test('fórmulas: condiciones con «y», «o», «no», si() y «? :»', () => {
  const s = { fijacion: 'cimentado', altura: 2 };
  assert.equal(run("altura + si(fijacion == 'cimentado', 0.5, 0)", s), 2.5);
  assert.equal(run("fijacion == 'placa' ? 1 : 0", s), 0);
  assert.equal(run("altura >= 1.5 y no (fijacion == 'placa')", s), true);
  assert.equal(run("altura < 1 o fijacion == 'Cimentado'", s), true, 'sin importar mayúsculas');
});

test('fórmulas: un texto numérico (opción «1.5») cuenta como número; si no, se concatena', () => {
  assert.equal(run('altura == 1.5', { altura: '1.5' }), true);
  assert.equal(run('altura + 0.5', { altura: '2' }), 2.5);
  assert.equal(run("'PANEL-' + producto + '-' + altura", { producto: 'recta', altura: '2' }), 'PANEL-recta-2');
});

test('fórmulas: los errores dicen qué pasa, en palabras', () => {
  const err = (src: string, scope: Record<string, any> = {}) => {
    try { run(src, scope); } catch (e) { assert.ok(e instanceof FormulaError); return (e as Error).message; }
    return assert.fail(`«${src}» debió fallar`);
  };
  assert.match(err('1 / 0'), /División entre cero/);
  assert.match(err('metros * 2'), /No existe el dato o cálculo «metros»/);
  assert.match(err('altura = 2', { altura: 2 }), /«==»/);
  assert.match(err('foo(1)'), /No existe la función «foo»/);
  assert.match(err('si(1, 2)'), /lleva 3/);
  assert.match(err("'clasica' * 2"), /no es un número/);
  assert.match(err('(1 + 2'), /cerrar el paréntesis/);
  assert.match(err('2 +'), /termina antes de tiempo/);
});

test('fórmulas: no ejecuta código ni acepta cosas raras', () => {
  for (const src of ['process.exit()', 'constructor.constructor("x")()', '`x`', 'a; b', 'x[0]', '__proto__']) {
    assert.throws(() => compile(src, new Set(['a', 'b', 'x'])), FormulaError, src);
  }
  assert.throws(() => compile('1+'.repeat(400) + '1'), FormulaError, 'tope de longitud');
  assert.throws(() => compile('('.repeat(60) + '1' + ')'.repeat(60)), FormulaError, 'tope de niveles');
});
