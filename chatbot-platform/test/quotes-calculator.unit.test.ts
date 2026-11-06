/**
 * Calculadora de cotizaciones con un caso real de giro (cercas por metro lineal, con precios inventados): cantidades
 * derivadas, escalones, conceptos que dependen de la fijación, reglas para pasar con un asesor y montos exactos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatorProblem, evaluateCalculator, parseHumanNumber } from '../src/quotes/calculator.js';
import type { PriceItem } from '../src/store/quotes.js';

const IVA = { iva_rate: 0.16 };

const CERCAS = {
  inputs: [
    { key: 'metros', label: 'Metros lineales', type: 'number', unit: 'ML', min: 0.5, max: 10000 },
    { key: 'producto', label: 'Producto', type: 'option', options: [{ value: 'recta', label: 'MetroMalla Recta' }, { value: 'clasica', label: 'MetroMalla Clásica' }, { value: 'gavion', label: 'Muro Gavión' }] },
    { key: 'altura', label: 'Altura', type: 'option', options: [{ value: '0.5', label: '0.50 m' }, { value: '1', label: '1.00 m' }, { value: '1.5', label: '1.50 m' }, { value: '2', label: '2.00 m' }] },
    { key: 'fijacion', label: 'Fijación', type: 'option', options: [{ value: 'placa', label: 'Con placa' }, { value: 'cimentado', label: 'Cimentado' }] },
    { key: 'instalacion', label: 'Instalación', type: 'boolean', required: false },
    { key: 'zona', label: 'Zona de entrega', type: 'option', required: false, default: 'sin_dato', options: [{ value: 'mty', label: 'Monterrey' }, { value: 'periferia', label: 'Santiago, García, Juárez, Cadereyta o Allende' }, { value: 'recoge', label: 'Recoge en planta' }] },
  ],
  values: [
    { key: 'escalon', label: 'Escalón de precio', tiers: { of: 'metros', steps: [{ below: 15, value: 'A' }, { below: 50, value: 'B' }, { below: 100, value: 'C' }, { below: 130, value: 'D' }], otherwise: { stop: 'Para 130 metros o más te atiende un asesor.' } } },
    { key: 'paneles', formula: 'redondear_arriba(metros / 2.5)' },
    { key: 'postes', formula: 'paneles + 1' },
    { key: 'largo_poste', formula: "altura + si(fijacion == 'cimentado', 0.5, 0)" },
    { key: 'abrazaderas', formula: 'postes * si(altura <= 1, 2, si(altura == 1.5, 3, 4))' },
    { key: 'rango_flete', formula: "metros < 20 ? 'hasta_20' : metros < 70 ? '20_70' : '70_120'" },
  ],
  lines: [
    { family: 'panel', match: { producto: 'producto', altura: 'altura', escalon: 'escalon' }, qty: 'paneles', when: "producto != 'gavion'" },
    { label: 'Poste de {largo_poste} m', family: 'poste', match: { largo: 'largo_poste', escalon: 'escalon' }, qty: 'postes', when: "producto != 'gavion'" },
    { family: 'placa', match: { escalon: 'escalon' }, qty: 'postes', when: "fijacion == 'placa' y producto != 'gavion'" },
    { family: 'abrazadera', match: { escalon: 'escalon' }, qty: 'abrazaderas', when: "producto != 'gavion'" },
    { family: 'instalacion', match: { fijacion: 'fijacion' }, qty: 'metros', when: 'instalacion' },
    { family: 'flete', match: { zona: 'zona', rango: 'rango_flete' }, qty: '1', when: "zona == 'mty' o zona == 'periferia'" },
  ],
  stops: [
    { when: 'instalacion y metros > 50', message: 'La instalación de más de 50 metros la cotiza un asesor.' },
    { when: "(zona == 'mty' o zona == 'periferia') y (metros < 5 o metros == 20 o metros == 70 o metros > 120)", message: 'El flete para esa cantidad lo confirma un asesor.' },
  ],
  legend: 'Precio aproximado sujeto a visita. Vigencia: 15 días.',
};

let n = 0;
const item = (family: string, attributes: Record<string, string>, pesos: number, o: Partial<PriceItem> = {}): PriceItem => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  account_id: 'acc',
  code: `${family}-${n}`.toUpperCase(),
  name: family[0].toUpperCase() + family.slice(1),
  description: '',
  unit: 'pieza',
  price_mode: 'exact',
  price_min: Math.round(pesos * 100),
  price_max: null,
  iva_mode: 'plus',
  active: true,
  sort: n,
  family,
  attributes,
  ...o,
});

const PRICES: PriceItem[] = [
  item('panel', { producto: 'clasica', altura: '2', escalon: 'B' }, 1000, { name: 'Panel MetroMalla Clásica 2.00 m' }),
  item('panel', { producto: 'recta', altura: '2', escalon: 'B' }, 850),
  item('poste', { largo: '2.5', escalon: 'B' }, 450),
  item('poste', { largo: '2', escalon: 'B' }, 400),
  item('placa', { escalon: 'B' }, 80),
  item('abrazadera', { escalon: 'B' }, 12),
  item('instalacion', { fijacion: 'cimentado' }, 598, { unit: 'metro lineal' }),
  item('flete', { zona: 'mty', rango: '20_70' }, 1500, { unit: 'servicio' }),
];

const quote = (inputs: Record<string, unknown>, prices = PRICES) => evaluateCalculator(CERCAS, inputs, prices, IVA);
const base = { metros: 40, producto: 'clasica', altura: '2', fijacion: 'cimentado' };

test('calculadora: la definición de ejemplo es válida', () => {
  assert.equal(calculatorProblem(CERCAS), null);
});

test('calculadora: 40 ML, Clásica, 2.00 m, cimentado → escalón B, 16 paneles, 17 postes de 2.5 m, 68 abrazaderas, sin placas', () => {
  const r = quote(base);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.scope.escalon, 'B');
  assert.deepEqual(r.lines.map((l) => [l.name, l.qty]), [
    ['Panel MetroMalla Clásica 2.00 m', 16],
    ['Poste de 2.5 m', 17],
    ['Abrazadera', 68],
  ]);
  // 16 × $1,000 + 17 × $450 + 68 × $12 = $24,466.00; IVA 16 % = $3,914.56.
  assert.equal(r.priced.subtotal_min, 2_446_600);
  assert.equal(r.priced.iva_min, 391_456);
  assert.equal(r.priced.total_min, 2_838_056);
  assert.equal(r.priced.total_max, r.priced.total_min);
  assert.equal(r.kind, 'approximate');
  assert.match(r.legend, /aproximado/);
});

test('calculadora: con placa los postes miden la altura del panel y va una placa por poste', () => {
  const r = quote({ ...base, fijacion: 'placa' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.lines.map((l) => [l.name, l.qty]), [
    ['Panel MetroMalla Clásica 2.00 m', 16], ['Poste de 2 m', 17], ['Placa', 17], ['Abrazadera', 68],
  ]);
});

test('calculadora: los datos se entienden como los escribe una persona', () => {
  assert.ok(quote({ ...base, metros: '40 metros', producto: 'MetroMalla Clásica', altura: '2.00', fijacion: 'Cimentado' }).ok);
  assert.equal(parseHumanNumber('1,250'), 1250);
  assert.equal(parseHumanNumber('40,5'), 40.5);
  assert.equal(parseHumanNumber('2 m'), 2);
});

test('calculadora: faltan datos → los pide en orden; un dato fuera de las opciones → se vuelve a preguntar', () => {
  const missing = quote({ metros: 40 });
  assert.ok(!missing.ok && missing.reason === 'missing');
  assert.deepEqual(!missing.ok && missing.reason === 'missing' ? missing.missing.map((m) => m.key) : [], ['producto', 'altura', 'fijacion']);
  const invalid = quote({ ...base, altura: '3' });
  assert.ok(!invalid.ok && invalid.reason === 'invalid');
});

test('calculadora: extras opcionales solo si se piden; el flete solo con zona', () => {
  const sinExtras = quote(base);
  assert.ok(sinExtras.ok && !sinExtras.lines.some((l) => /Instalacion|Flete/.test(l.name)));
  const conTodo = quote({ ...base, instalacion: 'sí', zona: 'Monterrey' });
  assert.ok(conTodo.ok, JSON.stringify(conTodo));
  assert.deepEqual(conTodo.lines.slice(-2).map((l) => [l.name, l.qty]), [['Instalacion', 40], ['Flete', 1]]);
  const recoge = quote({ ...base, zona: 'recoge' });
  assert.ok(recoge.ok && !recoge.lines.some((l) => l.name === 'Flete'));
});

test('calculadora: reglas para pasar con un asesor', () => {
  const grande = quote({ ...base, metros: 130 });
  assert.ok(!grande.ok && grande.reason === 'stop' && /130 metros/.test(grande.message));
  const instalacion = quote({ ...base, metros: 60, instalacion: true });
  assert.ok(!instalacion.ok && instalacion.reason === 'stop' && /instalación/.test(instalacion.message));
  const flete = quote({ ...base, metros: 20, zona: 'mty' });
  assert.ok(!flete.ok && flete.reason === 'stop' && /flete/i.test(flete.message));
});

test('calculadora: un precio que falta (o repetido) no se inventa: pasa con un asesor y dice qué falta', () => {
  const r = quote({ ...base, metros: 10 }); // escalón A: no hay precios A en la lista
  assert.ok(!r.ok && r.reason === 'price');
  assert.match(!r.ok && r.reason === 'price' ? r.detail : '', /Falta en la lista de precios: «panel» con producto = clasica, altura = 2, escalon = A/);
  const doble = quote(base, [...PRICES, item('panel', { producto: 'clasica', altura: '2', escalon: 'B' }, 999)]);
  assert.ok(!doble.ok && doble.reason === 'price' && /Hay 2 precios/.test(doble.detail));
  const inactivo = quote(base, PRICES.map((p) => (p.family === 'abrazadera' ? { ...p, active: false } : p)));
  assert.ok(!inactivo.ok && inactivo.reason === 'price', 'un precio inactivo no se usa');
});

test('calculadora: los errores de configuración dicen dónde están', () => {
  assert.match(calculatorProblem({ ...CERCAS, values: [{ key: 'paneles', formula: 'metros / ' }] })!, /Cálculo 1 \(paneles\)/);
  assert.match(calculatorProblem({ ...CERCAS, lines: [{ family: 'panel', qty: 'tablas * 2' }] })!, /Concepto 1 .*«tablas»/);
  assert.match(calculatorProblem({ ...CERCAS, values: [{ key: 'metros', formula: '1' }] })!, /ya hay otro dato o cálculo llamado «metros»/);
  assert.match(calculatorProblem({ ...CERCAS, inputs: [{ key: 'Metros', label: 'x', type: 'number' }] })!, /Dato 1: Usa minúsculas/);
  assert.match(calculatorProblem({ ...CERCAS, values: [{ key: 'e', tiers: { of: 'metros', steps: [{ below: 50, value: 'B' }, { below: 15, value: 'A' }], otherwise: { value: 'C' } } }] })!, /de menor a mayor/);
});

test('calculadora: mismo dato, mismo resultado (determinista)', () => {
  assert.deepEqual(quote(base), quote(base));
});
