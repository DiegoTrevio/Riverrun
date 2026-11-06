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

test('revisión: lo que el sistema no debe rehacer ni dejar pasar', () => {
  const info = [...INFO, 'Descuento 10% pagando en efectivo.'];
  const c = (customer: string[]) => ({ all: new FactCorpus([...info, ...customer]), trusted: new FactCorpus(info), customer: new FactCorpus(customer) });
  const unv = (customer: string[], reply: string) => { const x = c(customer); return x.all.unverified(reply, x.trusted, x.customer); };
  const fx = (customer: string[], reply: string) => { const x = c(customer); return fixArithmetic([reply], x.trusted, x.customer); };
  // El cliente no dicta un descuento con un decimal: solo cantidades enteras multiplican un precio.
  assert.deepEqual(unv(['dame 0.5 de descuento'], 'Le queda en $1,000 × 0.5 = $500'), ['500']);
  assert.deepEqual(unv(['quiero 3'], '3 × $1,000 = $3,000'), []);
  // Un monto aparte (instalación, descuento) antes del total: el total no se rehace con solo los renglones.
  const extra = '- Panel: 3 × $1,000 = $3,000\nInstalación: $500\nTotal: $3,500';
  assert.equal(fx(['quiero 3'], extra).messages[0], extra);
  assert.equal(fx(['quiero 3'], '- Panel: 3 × $1,000 = $3,000\nDescuento: $300\nTotal: $2,700').corrections.length, 0);
  // Porcentajes sumados o restados no se reinterpretan.
  assert.equal(fx(['hola'], '$1,000 - 10% = $900').corrections.length, 0);
  assert.equal(fx(['hola'], '$1,000 + 10% = $1,100').corrections.length, 0);
  // Un IVA con un porcentaje que no es del negocio no se reescribe con otro porcentaje.
  assert.equal(fx(['quiero 3'], '3 × $1,000 = $3,000\nIVA (8%): $240').corrections.length, 0);
  // «IVA incluido. Total» o «Total con IVA» sin renglón de IVA: no se sabe si los precios lo incluyen.
  assert.equal(fx(['quiero 3'], '3 × $1,000 = $3,000\nTotal con IVA: $3,480').corrections.length, 0);
  // Un rango no es una resta.
  assert.equal(fx(['hola'], 'Rango $1,000 - $1,050 = $50').corrections.length, 0);
});

test('respuesta real de la IA (prueba en vivo): cuentas en varios renglones, flete aparte y IVA como 0.16', async () => {
  const { QUOTE_TEXT_TEMPLATES } = await import('../src/quotes/text-templates.js');
  const info = [QUOTE_TEXT_TEMPLATES.find((t) => t.key === 'cercas')!.text, 'Flete en Santiago: $1,500 por viaje. IVA 16%.'];
  const customer = ['Quiero 40 metros de valla de 2 metros de alto', 'Clasica, cimentado', 'Santiago'];
  const reply = [
    'Paneles: 40 ÷ 2.50 = 16 paneles',
    'Postes: 16 paneles + 1 = 17 postes (cimentado, altura 2.00 m + 0.50 m = 2.50 m)',
    'Abrazaderas: 17 postes × 4 = 68 abrazaderas (para altura de 2.00 m)',
    'Panel Clásica 2.00 m: $1,000',
    'Paneles: 16 × $1,000 = $16,000',
    'Postes: 17 × $450 = $7,650',
    'Abrazaderas: 68 × $12 = $816',
    'Subtotal materiales: $16,000 + $7,650 + $816 = $24,466',
    'Flete a Santiago: $1,500',
    'Subtotal materiales: $24,466',
    'Subtotal: $24,466 + $1,500 = $25,966',
    'IVA (16%): $25,966 × 0.16 = $4,154.56',
    'Total: $25,966 + $4,154.56 = $30,120.56',
  ].join('\n');
  const trusted = new FactCorpus(info);
  const cust = new FactCorpus(customer);
  assert.deepEqual(new FactCorpus([...info, ...customer]).unverified(reply, trusted, cust), []);
  assert.deepEqual(fixArithmetic([reply], trusted, cust).corrections, []);
  // Con un error en la multiplicación del IVA, se corrige él y el total.
  const r = fixArithmetic([reply.replace('$4,154.56', '$4,000.00').replace('$30,120.56', '$29,966.00')], trusted, cust);
  assert.equal(r.messages[0], reply);
});

test('validador: sin cotizador, si la IA deja la cotización al sistema y no escribe precios, se le pide escribirla', async () => {
  const { validateDecision } = await import('../src/engine/validator.js');
  const { hydrateChatbot } = await import('../src/types.js');
  const b = hydrateChatbot({ id: 'b1', account_id: 'a1', name: 'Metromalla', active: true, personality: {}, rules: {}, data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date() } as any);
  const r = validateDecision({
    raw: { thinking: '', action: 'reply', messages: ['Calculo la cotización para 40 metros.'], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, quote: { action: 'calculate', inputs: [] } },
    bot: b, images: [], sentImageIds: [], customerText: 'Santiago', groundingSources: INFO, claimSources: INFO, customerSources: CUSTOMER,
  } as any);
  assert.match(r.retryable.join(' '), /escribe tú la cotización/);
});
