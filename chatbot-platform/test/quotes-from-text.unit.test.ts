/**
 * Cotizador escrito: de la salida de la IA (esquema estricto) a precios en centavos y una calculadora válida; qué impide
 * activarlo; ejemplos calculados por el sistema; y combinaciones sin precio detectadas antes de que un cliente las pida.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageCheck, draftItems, runExample, toDraft, validateDraft, type BuilderOutput } from '../src/quotes/from-text.js';

const tiers = (o: Partial<BuilderOutput['values'][number]['tiers']> = {}) => ({ of: '', steps: [], otherwise_value: '', otherwise_stop: '', ...o });
const item = (code: string, family: string, attrs: Record<string, string>, price: number, unit = 'litro') =>
  ({ code, name: `${family} ${Object.values(attrs).join(' ')}`.trim(), unit, family, attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })), price, price_max: null, price_mode: 'exact' as const, iva_mode: 'default' as const });

/** «Pintura por m²»: como la devolvería la IA. */
const PINTURA: BuilderOutput = {
  summary: 'Pintura por m² con escalón de menudeo y mayoreo.',
  price_items: [
    item('pint-mate-men', 'Pintura', { acabado: 'mate', escalon: 'menudeo' }, 90),
    item('PINT-MATE-MAY', 'pintura', { acabado: 'mate', escalon: 'mayoreo' }, 80),
    item('PINT-SAT-MEN', 'pintura', { acabado: 'satinado', escalon: 'menudeo' }, 110),
    item('PINT-SAT-MAY', 'pintura', { acabado: 'satinado', escalon: 'mayoreo' }, 95),
    item('MO', 'Mano de obra', {}, 35, 'm²'),
  ],
  inputs: [
    { key: 'largo', label: 'Largo', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
    { key: 'ancho', label: 'Ancho', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
    { key: 'Acabado', label: 'Acabado', help: '', type: 'option', unit: '', min: null, max: null, decimals: 0, options: [{ value: 'mate', label: 'Mate' }, { value: 'satinado', label: 'Satinado' }], required: true, default: '' },
    { key: 'mano_obra', label: 'Con mano de obra', help: '', type: 'boolean', unit: '', min: null, max: null, decimals: 0, options: [], required: false, default: 'no' },
  ],
  values: [
    { key: 'area', label: 'Área', formula: 'redondear(largo * ancho, 2)', tiers: tiers() },
    { key: 'litros', label: 'Litros', formula: 'redondear_arriba(area / 10)', tiers: tiers() },
    { key: 'escalon', label: 'Escalón', formula: '', tiers: tiers({ of: 'area', steps: [{ below: 50, value: 'menudeo' }], otherwise_value: 'mayoreo' }) },
  ],
  lines: [
    { label: 'Pintura {acabado}', family: 'Pintura', match: [{ attribute: 'acabado', formula: 'acabado' }, { attribute: 'escalon', formula: 'escalon' }], qty: 'litros', when: '' },
    { label: '', family: 'Mano de obra', match: [], qty: 'area', when: 'mano_obra' },
  ],
  stops: [{ when: 'area > 500', message: 'Para más de 500 m² te atiende un asesor.' }],
  legend: 'Precio aproximado.',
  examples: [
    { description: 'Cuarto chico', inputs: [{ key: 'largo', value: '5' }, { key: 'ancho', value: '4' }, { key: 'acabado', value: 'mate' }] },
    { description: 'Bodega con mano de obra', inputs: [{ key: 'largo', value: '10' }, { key: 'ancho', value: '8' }, { key: 'acabado', value: 'satinado' }, { key: 'mano_obra', value: 'sí' }] },
  ],
  unclear: [],
};
const NO_IVA_INCL = { prices_include_iva: false };

test('cotizador escrito: la salida de la IA se vuelve precios en centavos y una calculadora válida', () => {
  const draft = toDraft(PINTURA, NO_IVA_INCL);
  assert.deepEqual(validateDraft(draft), []);
  const first = draft.price_items[0];
  assert.equal(first.code, 'PINT-MATE-MEN', 'claves en mayúsculas');
  assert.equal(first.family, 'pintura', 'familias normalizadas');
  assert.deepEqual(first.attributes, { acabado: 'mate', escalon: 'menudeo' });
  assert.equal(first.price_min, 9000);
  assert.equal(first.iva_mode, 'plus', 'sin decir nada, el IVA de la cuenta');
  assert.equal(toDraft(PINTURA, { prices_include_iva: true }).price_items[0].iva_mode, 'included');
  const def = draft.definition as any;
  assert.equal(def.inputs[2].key, 'acabado', 'claves de datos normalizadas');
  assert.equal(def.inputs[3].default, false, 'un sí/no opcional queda en «no»');
  assert.deepEqual(def.values[2].tiers.otherwise, { value: 'mayoreo' });
  assert.equal(def.lines[1].family, 'mano_de_obra');
});

test('cotizador escrito: los ejemplos los calcula el sistema con los precios del borrador', () => {
  const draft = toDraft(PINTURA, NO_IVA_INCL);
  const items = draftItems(draft);
  // 20 m² → 2 litros mate a $90 (menudeo) = $180 + IVA.
  const small = runExample(draft.definition, items, 0.16, 'MXN', 'chico', { largo: '5', ancho: '4', acabado: 'mate' });
  assert.ok(small.ok, JSON.stringify(small));
  assert.equal(small.total_cents, 20_880);
  // 80 m² → mayoreo: 8 litros satinado × $95 + 80 m² × $35 = $3,560 + IVA.
  const big = runExample(draft.definition, items, 0.16, 'MXN', 'grande', { largo: '10', ancho: '8', acabado: 'satinado', mano_obra: 'sí' });
  assert.ok(big.ok);
  assert.equal(big.total_cents, 412_960);
  assert.deepEqual(big.lines!.map((l) => l.name), ['Pintura satinado', 'Mano de obra']);
  const stop = runExample(draft.definition, items, 0.16, 'MXN', 'enorme', { largo: '30', ancho: '20', acabado: 'mate' });
  assert.ok(!stop.ok && /500 m²/.test(stop.message!));
});

test('cotizador escrito: lo que impide activarlo se dice en palabras', () => {
  const noFamily = toDraft({ ...PINTURA, price_items: PINTURA.price_items.slice(0, 4) }, NO_IVA_INCL);
  assert.match(validateDraft(noFamily).join(' '), /familia «mano_de_obra», pero no hay ninguno/);
  const dup = toDraft({ ...PINTURA, price_items: [...PINTURA.price_items, item('MO', 'mano de obra', {}, 40)] }, NO_IVA_INCL);
  assert.match(validateDraft(dup).join(' '), /La clave «MO» está repetida/);
  const bad = toDraft({ ...PINTURA, values: [{ key: 'area', label: '', formula: 'largo x ancho', tiers: tiers() }, ...PINTURA.values.slice(1)] }, NO_IVA_INCL);
  assert.match(validateDraft(bad).join(' '), /Calculadora: Cálculo 1 \(area\)/);
  assert.match(validateDraft(toDraft({ ...PINTURA, price_items: [] }, NO_IVA_INCL)).join(' '), /No hay ningún precio/);
});

test('cotizador escrito: encuentra combinaciones sin precio antes de que un cliente las pida', () => {
  const draft = toDraft({ ...PINTURA, price_items: PINTURA.price_items.filter((p) => p.code !== 'PINT-SAT-MAY') }, NO_IVA_INCL);
  const missing = coverageCheck(draft.definition, draftItems(draft), 0.16);
  assert.equal(missing.length, 1, missing.join('\n'));
  assert.match(missing[0], /Falta en la lista de precios: «pintura» con .*satinado/);
  assert.deepEqual(coverageCheck(toDraft(PINTURA, NO_IVA_INCL).definition, draftItems(toDraft(PINTURA, NO_IVA_INCL)), 0.16), []);
});

test('cotizador escrito: la llamada deja espacio para la configuración completa (con muchos precios no se corta)', async () => {
  const { buildFromText } = await import('../src/quotes/from-text.js');
  const seen: any[] = [];
  const ai = { complete: async (req: any) => { seen.push(req); return { content: JSON.stringify(PINTURA), model: 'm', usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 }, latency_ms: 1 }; } } as any;
  const r = await buildFromText(ai, { text: 'Pintura mate $90 el litro', settings: { currency: 'MXN', iva_rate: 0.16, prices_include_iva: false } as any });
  assert.ok(r.draft);
  // Con una lista de precios por escalón (Metromalla, 56 precios) la IA gastaba casi todo el tope en razonar y la
  // configuración salía cortada («La IA no terminó de armar el cotizador»).
  assert.equal(seen[0].reasoning_effort, 'low');
  assert.ok(seen[0].max_tokens >= 32000);
});
