/**
 * La misma calculadora, sin código nuevo, cotiza giros muy distintos: superficies por m², eventos por persona con extras,
 * servicios por hora con mínimo y productos con mayoreo. Si un giro nuevo necesitara programar, esto lo detectaría.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatorProblem, evaluateCalculator } from '../src/quotes/calculator.js';
import type { PriceItem } from '../src/store/quotes.js';

let n = 0;
const item = (family: string, attributes: Record<string, string>, pesos: number, o: Partial<PriceItem> = {}): PriceItem => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, account_id: 'acc', code: `${family}-${n}`.toUpperCase(),
  name: family, description: '', unit: 'pieza', price_mode: 'exact', price_min: Math.round(pesos * 100), price_max: null,
  iva_mode: 'plus', active: true, sort: n, family, attributes, ...o,
});
const IVA = { iva_rate: 0.16 };

test('giro m² (pintura/impermeabilización): área = largo × ancho, precio por escalón y material', () => {
  const def = {
    inputs: [
      { key: 'largo', label: 'Largo', type: 'number', unit: 'm', min: 0.1 },
      { key: 'ancho', label: 'Ancho', type: 'number', unit: 'm', min: 0.1 },
      { key: 'acabado', label: 'Acabado', type: 'option', options: [{ value: 'acrilico', label: 'Acrílico' }, { value: 'prefabricado', label: 'Prefabricado' }] },
    ],
    values: [
      { key: 'area', formula: 'redondear(largo * ancho, 2)' },
      { key: 'escalon', tiers: { of: 'area', steps: [{ below: 100, value: 'menudeo' }], otherwise: { value: 'volumen' } } },
    ],
    lines: [{ label: 'Impermeabilizante {acabado}', family: 'm2', match: { acabado: 'acabado', escalon: 'escalon' }, qty: 'area' }],
  };
  assert.equal(calculatorProblem(def), null);
  const prices = [item('m2', { acabado: 'acrilico', escalon: 'menudeo' }, 120), item('m2', { acabado: 'acrilico', escalon: 'volumen' }, 95)];
  const chico = evaluateCalculator(def, { largo: 8, ancho: 5, acabado: 'Acrílico' }, prices, IVA);
  assert.ok(chico.ok, JSON.stringify(chico));
  assert.equal(chico.lines[0].qty, 40);
  assert.equal(chico.priced.subtotal_min, 40 * 12000);
  const grande = evaluateCalculator(def, { largo: 20, ancho: 10, acabado: 'acrilico' }, prices, IVA);
  assert.ok(grande.ok && grande.priced.subtotal_min === 200 * 9500, 'al cruzar 100 m² cambia el precio');
});

test('giro eventos: personas × paquete, extras solo si se piden, y tope que pasa con un asesor', () => {
  const def = {
    inputs: [
      { key: 'personas', label: 'Invitados', type: 'number', min: 20, max: 1000, decimals: 0 },
      { key: 'paquete', label: 'Paquete', type: 'option', options: [{ value: 'basico', label: 'Básico' }, { value: 'premium', label: 'Premium' }] },
      { key: 'dj', label: 'DJ', type: 'boolean', required: false },
      { key: 'meseros', label: 'Meseros extra', type: 'number', required: false, default: 0, min: 0 },
    ],
    values: [{ key: 'mesas', formula: 'redondear_arriba(personas / 10)' }],
    lines: [
      { label: 'Paquete {paquete} por persona', family: 'paquete', match: { paquete: 'paquete' }, qty: 'personas' },
      { family: 'mesa', qty: 'mesas' },
      { family: 'dj', qty: '1', when: 'dj' },
      { family: 'mesero', qty: 'meseros' },
    ],
    stops: [{ when: 'personas > 500', message: 'Para más de 500 invitados te contacta un asesor.' }],
  };
  assert.equal(calculatorProblem(def), null);
  const prices = [item('paquete', { paquete: 'basico' }, 350), item('paquete', { paquete: 'premium' }, 600), item('mesa', {}, 150), item('dj', {}, 5000), item('mesero', {}, 800)];
  const sinExtras = evaluateCalculator(def, { personas: 85, paquete: 'basico' }, prices, IVA);
  assert.ok(sinExtras.ok, JSON.stringify(sinExtras));
  assert.deepEqual(sinExtras.lines.map((l) => [l.name, l.qty]), [['Paquete basico por persona', 85], ['mesa', 9]]);
  const conExtras = evaluateCalculator(def, { personas: 85, paquete: 'premium', dj: 'sí', meseros: 2 }, prices, IVA);
  assert.ok(conExtras.ok, JSON.stringify(conExtras));
  assert.equal(conExtras.priced.subtotal_min, (85 * 600 + 9 * 150 + 5000 + 2 * 800) * 100);
  const enorme = evaluateCalculator(def, { personas: 800, paquete: 'basico' }, prices, IVA);
  assert.ok(!enorme.ok && enorme.reason === 'stop');
  assert.ok(!evaluateCalculator(def, { personas: 10, paquete: 'basico' }, prices, IVA).ok, 'menos del mínimo se vuelve a preguntar');
});

test('giro servicios por hora: mínimo de horas y visita según zona', () => {
  const def = {
    inputs: [
      { key: 'horas', label: 'Horas', type: 'number', min: 0.5, max: 200 },
      { key: 'zona', label: 'Zona', type: 'option', options: [{ value: 'centro', label: 'Centro' }, { value: 'foranea', label: 'Foránea' }] },
    ],
    values: [{ key: 'cobradas', formula: 'max(redondear_arriba(horas), 2)' }],
    lines: [{ family: 'hora', qty: 'cobradas' }, { family: 'visita', match: { zona: 'zona' }, qty: '1' }],
  };
  assert.equal(calculatorProblem(def), null);
  const prices = [item('hora', {}, 450), item('visita', { zona: 'centro' }, 0), item('visita', { zona: 'foranea' }, 300)];
  const r = evaluateCalculator(def, { horas: 1, zona: 'foránea' }, prices, IVA);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.lines.map((l) => l.qty), [2, 1], 'se cobra el mínimo de 2 horas');
  assert.equal(r.priced.subtotal_min, (2 * 450 + 300) * 100);
});

test('giro mayoreo: el precio por pieza cambia al cruzar cada escalón', () => {
  const def = {
    inputs: [{ key: 'piezas', label: 'Piezas', type: 'number', min: 1, decimals: 0 }, { key: 'color', label: 'Color', type: 'option', options: [{ value: 'negro', label: 'Negro' }, { value: 'blanco', label: 'Blanco' }] }],
    values: [{ key: 'nivel', tiers: { of: 'piezas', steps: [{ below: 12, value: 'menudeo' }, { below: 100, value: 'medio' }], otherwise: { value: 'mayoreo' } } }],
    lines: [{ label: 'Playera {color}', family: 'playera', match: { nivel: 'nivel' }, qty: 'piezas' }],
  };
  assert.equal(calculatorProblem(def), null);
  const prices = [item('playera', { nivel: 'menudeo' }, 180), item('playera', { nivel: 'medio' }, 150), item('playera', { nivel: 'mayoreo' }, 120)];
  const unit = (piezas: number) => {
    const r = evaluateCalculator(def, { piezas, color: 'negro' }, prices, IVA);
    assert.ok(r.ok, JSON.stringify(r));
    return r.priced.subtotal_min / piezas / 100;
  };
  assert.deepEqual([unit(11), unit(12), unit(99), unit(100)], [180, 150, 150, 120]);
  assert.ok(!evaluateCalculator(def, { piezas: 2.5, color: 'negro' }, prices, IVA).ok, 'piezas con decimales se vuelven a preguntar');
});

test('IVA según cada cuenta: más IVA, exento y otra tasa', () => {
  const def = { inputs: [{ key: 'n', label: 'Cantidad', type: 'number', min: 1 }], lines: [{ family: 'x', qty: 'n' }] };
  const r = (iva_mode: PriceItem['iva_mode'], rate: number) => {
    const out = evaluateCalculator(def, { n: 2 }, [item('x', {}, 100, { iva_mode })], { iva_rate: rate });
    assert.ok(out.ok, JSON.stringify(out));
    return [out.priced.subtotal_min, out.priced.iva_min, out.priced.total_min];
  };
  assert.deepEqual(r('plus', 0.16), [20000, 3200, 23200]);
  assert.deepEqual(r('exempt', 0.16), [20000, 0, 20000]);
  assert.deepEqual(r('plus', 0.08), [20000, 1600, 21600]);
  const incl = evaluateCalculator(def, { n: 2 }, [item('x', {}, 116, { iva_mode: 'included' })], IVA);
  assert.ok(incl.ok && incl.priced.total_min === 23200, 'con IVA incluido el total es el precio de lista');
});
