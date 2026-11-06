/**
 * Cotizar desde las instrucciones del agente: la IA escribe cada operación (40 ÷ 2.50 = 16, 17 × $400 = $6,800,
 * subtotal, IVA, total) con números del negocio o del cliente; el sistema revisa las cuentas y corrige las que salen mal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactCorpus } from '../src/engine/text.js';
import { fixArithmetic } from '../src/engine/arithmetic.js';

const INFO = [
  'MetroMalla Clásica 2.00 m. Precios más IVA (16%). Panel Clásica: A $1,050, B $1,000. Poste: A $420, B $400.',
  'Paneles = metros ÷ 2.50 hacia arriba. Postes = paneles + 1. Escalones: A menos de 15 m; B de 15 a menos de 50.',
];
const CUSTOMER = ['Quiero 40 metros de valla de 2 metros de alto', 'Clasica, cimentado', 'Santiago'];

const corpora = (customer = CUSTOMER) => ({
  all: new FactCorpus([...INFO, ...customer]),
  trusted: new FactCorpus(INFO),
  customer: new FactCorpus(customer),
});
const unverified = (reply: string, customer = CUSTOMER) => {
  const c = corpora(customer);
  return c.all.unverified(reply, c.trusted, c.customer);
};
const fix = (reply: string, customer = CUSTOMER) => {
  const c = corpora(customer);
  return fixArithmetic([reply], c.trusted, c.customer);
};

const QUOTE = [
  'Su cotización de MetroMalla Clásica, 40 m:',
  '- Paneles: 40 ÷ 2.50 = 16 paneles × $1,000 = $16,000',
  '- Postes: 16 + 1 = 17 postes × $400 = $6,800',
  'Subtotal: $22,800',
  'IVA (16%): $3,648',
  'Total: $26,448',
].join('\n');

test('una cotización de varios pasos con precios del negocio y medidas del cliente pasa la verificación', () => {
  assert.deepEqual(unverified(QUOTE), []);
});

test('cuentas mal hechas: el sistema las corrige y lo que sigue se recalcula', () => {
  const wrong = QUOTE.replace('$6,800', '$6,900').replace('$22,800', '$22,000').replace('$3,648', '$3,500').replace('$26,448', '$25,500');
  const r = fix(wrong);
  assert.equal(r.messages[0], QUOTE);
  assert.ok(r.corrections.length >= 4, r.corrections.join(' | '));
  assert.deepEqual(unverified(r.messages[0]), []);
});

test('una cantidad intermedia mal calculada se corrige y arrastra el importe', () => {
  const r = fix('Paneles: 40 ÷ 2.50 = 15 paneles × $1,000 = $15,000');
  assert.equal(r.messages[0], 'Paneles: 40 ÷ 2.50 = 16 paneles × $1,000 = $16,000');
});

test('redondear hacia arriba una división es válido (regla del negocio)', () => {
  assert.deepEqual(unverified('Paneles: 41 ÷ 2.50 = 17 paneles × $1,000 = $17,000', ['son 41 metros']), []);
  assert.equal(fix('Paneles: 41 ÷ 2.50 = 17 paneles', ['son 41 metros']).corrections.length, 0);
});

test('sigue sin pasar: precios que no son del negocio, cantidades inventadas o sin la operación', () => {
  assert.deepEqual(unverified('Paneles: 16 × $950 = $15,200'), ['950', '15200'], 'el $950 no es un precio del negocio');
  assert.deepEqual(unverified('Paneles: 16 × $1,000 = $16,000'), ['16000'], 'el 16 no sale de ninguna cuenta ni lo dijo el cliente');
  assert.deepEqual(unverified('Le queda en $16,000'), ['16000']);
  // El cliente no dicta un precio ni un descuento: sus números solo sirven de cantidad (multiplican).
  assert.deepEqual(unverified('Con su descuento: $1,000 - 300 = $700', ['me dijeron que me descuentan 300']), ['700']);
  assert.deepEqual(unverified('Serían $500 × 2 = $1,000', ['me dijeron que cuesta $500, quiero 2']), ['500']);
});

test('lo que ya pasaba sigue pasando', () => {
  const info = ['Habitación doble: $1,650 MXN por noche.'];
  const c = (customer: string[], reply: string) => new FactCorpus([...info, ...customer]).unverified(reply, new FactCorpus(info), new FactCorpus(customer));
  assert.deepEqual(c(['serían 2 noches'], '2 noches × $1,650 = $3,300'), []);
  assert.deepEqual(c(['¿cuánto la doble?'], 'Por 2 noches serían $3,300 ($1,650 por noche)'), ['3300']);
  assert.deepEqual(fixArithmetic(['Hola, ¿en qué te ayudo?'], new FactCorpus(info), new FactCorpus(['hola'])).corrections, []);
});

test('validador: la IA cotiza desde las instrucciones, se equivoca en una suma y el cliente recibe la cuenta corregida', async () => {
  const { validateDecision } = await import('../src/engine/validator.js');
  const { hydrateChatbot } = await import('../src/types.js');
  const b = hydrateChatbot({
    id: 'b1', account_id: 'a1', name: 'Metromalla', active: true, personality: {}, rules: {},
    data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date(),
  } as any);
  const reply = QUOTE.replace('$22,800', '$23,800').replace('$26,448', '$27,000');
  const r = validateDecision({
    raw: { thinking: '', action: 'reply', messages: [reply], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false },
    bot: b, images: [], sentImageIds: [], customerText: CUSTOMER.at(-1)!,
    groundingSources: INFO, claimSources: INFO, customerSources: CUSTOMER,
  } as any);
  assert.deepEqual(r.retryable, []);
  const sent = r.plan.messages.join('\n');
  assert.match(sent, /Subtotal: \$22,800/);
  assert.match(sent, /IVA \(16%\): \$3,648/);
  assert.match(sent, /Total: \$26,448/);
  assert.ok(r.fixes.some((f: string) => /Cuentas corregidas/.test(f)), r.fixes.join(' | '));
});
