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

test('una cantidad mal calculada no se corrige (puede ser una medida mencionada): no cuenta como revisada', () => {
  const r = fix('Paneles: 40 ÷ 2.50 = 15 paneles × $1,000 = $15,000');
  assert.equal(r.messages[0], 'Paneles: 40 ÷ 2.50 = 15 paneles × $1,000 = $15,000');
  assert.deepEqual(unverified(r.messages[0]), ['15000'], 'el importe que sale de esa cantidad no pasa');
  // Respuesta real: «4 abrazaderas por poste de 2.00 m × 17 = 68» no se vuelve «34».
  const real = 'Postes: 16 + 1 = 17\nAbrazaderas: 4 por poste de 2.00 m × 17 = 68';
  assert.equal(fix(real).messages[0], real);
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

test('validador: el aviso de «escribe tú la cotización» nunca deja al cliente sin respuesta', async () => {
  const { validateDecision } = await import('../src/engine/validator.js');
  const { hydrateChatbot } = await import('../src/types.js');
  const b = hydrateChatbot({ id: 'b1', account_id: 'a1', name: 'Salón', active: true, personality: {}, rules: {}, data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date() } as any);
  const run = (grounding: string[], final: boolean) => validateDecision({
    raw: { thinking: '', action: 'reply', messages: ['Con gusto te ayudo.'], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, quote: { action: 'prepare', items: [{ item_code: 'SALON', qty: 1, qty_quote: '' }], notes: '', wants_final: false } },
    bot: b, images: [], sentImageIds: [], customerText: '¿Me cotizas el salón?', groundingSources: grounding, claimSources: grounding, customerSources: ['¿Me cotizas el salón?'], final,
  } as any);
  // Sin precios en la información no hay nada que cotizar: se responde normal.
  assert.deepEqual(run(['Salón para eventos en Monterrey.'], false).retryable, []);
  // En el último intento, la respuesta sale aunque la IA siga sin escribir precios.
  assert.deepEqual(run(INFO, true).retryable, []);
  assert.match(run(INFO, false).retryable.join(' '), /escribe tú la cotización/);
});

test('respuestas reales (segunda prueba en vivo): comentario entre paréntesis dentro de la operación e IVA de un monto sin escribir la multiplicación', async () => {
  const { QUOTE_TEXT_TEMPLATES } = await import('../src/quotes/text-templates.js');
  const info = [QUOTE_TEXT_TEMPLATES.find((t) => t.key === 'cercas')!.text, 'Flete en Santiago: $1,500 por viaje. IVA (16%).'];
  const check = (customer: string[], reply: string) => {
    const trusted = new FactCorpus(info);
    const cust = new FactCorpus(customer);
    return { bad: new FactCorpus([...info, ...customer]).unverified(reply, trusted, cust), fixes: fixArithmetic([reply], trusted, cust).corrections };
  };
  // Gemini: «17 postes × 4 (para 2.00 m de altura) = 68 abrazaderas».
  const gemini = [
    'Paneles: 40 ÷ 2.50 = 16 paneles',
    'Postes: 16 paneles + 1 = 17 postes (cimentado, altura + 0.50 m = 2.50 m)',
    'Abrazaderas: 17 postes × 4 (para 2.00 m de altura) = 68 abrazaderas',
    'Paneles: 16 × $1,000 = $16,000',
    'Postes: 17 × $450 = $7,650',
    'Abrazaderas: 68 × $12 = $816',
    'Subtotal materiales: $16,000 + $7,650 + $816 = $24,466',
  ].join('\n');
  assert.deepEqual(check(['Quiero 40 metros de valla de 2 metros de alto', 'Clasica, cimentado', 'Santiago'], gemini), { bad: [], fixes: [] });
  // GPT: el IVA del flete escrito como monto («$1,500 + $240»): $240 = $1,500 × 16 %.
  const gpt = 'Flete en Santiago: $1,500 + IVA = $1,500 + $240 = $1,740';
  assert.deepEqual(check(['Cotízame 60 metros, Santiago'], gpt), { bad: [], fixes: [] });
  // El IVA de un monto que no es del negocio ni salió de una cuenta sigue sin pasar.
  assert.deepEqual(check(['Cotízame 60 metros, Santiago'], 'Extra: $2,200 + $352 = $2,552').bad, ['2200', '352', '2552']);
});

test('respuestas reales: IVA solo de los materiales con la instalación aparte, y flete suelto antes del subtotal', async () => {
  const { QUOTE_TEXT_TEMPLATES } = await import('../src/quotes/text-templates.js');
  const info = [QUOTE_TEXT_TEMPLATES.find((t) => t.key === 'cercas')!.text, 'Flete en Santiago y Monterrey: $1,500 por viaje. IVA (16%).'];
  const run = (customer: string[], reply: string) => {
    const trusted = new FactCorpus(info);
    const cust = new FactCorpus(customer);
    const r = fixArithmetic([reply], trusted, cust);
    return { bad: new FactCorpus([...info, ...customer]).unverified(r.messages[0], trusted, cust), fixes: r.corrections, text: r.messages[0] };
  };
  // GPT-4.1-mini: el IVA y el total son de los materiales; la instalación se suma después. Nada debe cambiar.
  const gpt = [
    'Instalación cimentada: $600 × 25 m = $15,000',
    'Paneles: 10 × $850 = $8,500',
    'Postes: 11 × $450 = $4,950',
    'Abrazaderas: 44 × $12 = $528',
    'Subtotal materiales: $8,500 + $4,950 + $528 = $13,978',
    'IVA 16%: $2,236.48',
    'Total materiales: $16,214.48',
    'Instalación: $15,000',
    'Total general: $16,214.48 + $15,000 = $31,214.48',
  ].join('\n');
  const customer = ['Necesito 25 metros de Recta de 2 metros, cimentada, con instalación, en Monterrey'];
  const derivation = ['Paneles: 25 ÷ 2.5 = 10 paneles', 'Postes: 10 + 1 = 11 postes', 'Abrazaderas: 11 postes × 4 = 44 abrazaderas'].join('\n');
  assert.deepEqual(run(customer, `${derivation}\n${gpt}`), { bad: [], fixes: [], text: `${derivation}\n${gpt}` });
  // Gemini: flete en un renglón suelto antes del subtotal (el subtotal lo incluye).
  const gemini = [
    'Paneles: 10 ÷ 2.50 = 4 paneles × $700 = $2,800',
    'Postes: 4 + 1 = 5 postes × $360 = $1,800',
    'Placas: 5 placas × $90 = $450',
    'Abrazaderas: 5 postes × 3 = 15 abrazaderas × $14 = $210',
    'Flete a Santiago: $1,500',
    'Subtotal: $6,760',
    'IVA (16%): $1,081.60',
    'Total: $7,841.60',
  ].join('\n');
  const c2 = ['Hola, quiero cotizar 10 metros de malla Recta de 1.50 m con placa, para Santiago, sin instalación'];
  assert.deepEqual(run(c2, gemini), { bad: [], fixes: [], text: gemini });
  // Con un monto suelto, un subtotal que no cuadra no se «corrige» (no se sabe qué quiso sumar): lo revisa la verificación.
  const off = gemini.replace('$6,760', '$6,000');
  assert.deepEqual(run(c2, off).fixes, []);
});

test('respuestas reales: total en negritas de WhatsApp y «Aquí tiene el desglose»', async () => {
  const { unsupportedClaims } = await import('../src/engine/claims.js');
  const info = [...INFO, 'Flete en Santiago: $1,500 por viaje.'];
  const trusted = new FactCorpus(info);
  const cust = new FactCorpus(CUSTOMER);
  const reply = `${QUOTE}\nTotal con flete: $26,448 + $1,500 = *$27,948*`;
  assert.deepEqual(new FactCorpus([...info, ...CUSTOMER]).unverified(reply, trusted, cust), []);
  assert.deepEqual(fixArithmetic([reply], trusted, cust).corrections, []);
  assert.deepEqual(fixArithmetic(['16 * $1,000 = $16,000'], trusted, new FactCorpus(['quiero 16'])).derived.has('16000'), true, 'un * solo entre números sí multiplica');
  assert.deepEqual(unsupportedClaims('Con gusto le cotizo. Aquí tiene el desglose:', info), []);
  assert.deepEqual(unsupportedClaims('Aquí tiene su cotización y el presupuesto', info), []);
  assert.deepEqual(unsupportedClaims('Esta cotización tiene una validez de 15 días.', info), [], 'respuesta real');
  assert.deepEqual(unsupportedClaims('La cotización tiene vigencia de 15 días.', info), []);
  assert.notDeepEqual(unsupportedClaims('Tenemos alberca techada', info), [], 'lo demás se sigue revisando');
});

test('validador: «permítame un momento mientras calculo» sin precios se regresa a la IA (nunca en el último intento)', async () => {
  const { validateDecision } = await import('../src/engine/validator.js');
  const { hydrateChatbot } = await import('../src/types.js');
  const b = hydrateChatbot({ id: 'b1', account_id: 'a1', name: 'Metromalla', active: true, personality: {}, rules: {}, data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date() } as any);
  const run = (text: string, final = false, grounding = INFO) => validateDecision({
    raw: { thinking: '', action: 'reply', messages: [text], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false },
    bot: b, images: [], sentImageIds: [], customerText: 'Santiago', groundingSources: grounding, claimSources: grounding, customerSources: CUSTOMER, final,
  } as any).retryable.join(' ');
  for (const stall of ['Con gusto le ayudo con su cotización. Permítame un momento mientras calculo los detalles.', 'Entendido, sin instalación. Permítame recalcular la cotización.', 'Calculo la cotización para 40 metros de valla clásica.']) {
    assert.match(run(stall), /Prometiste calcular/, stall);
    assert.doesNotMatch(run(stall, true), /Prometiste calcular/, 'en el último intento sale');
  }
  assert.doesNotMatch(run('¿Qué modelo prefiere, Recta o Clásica?'), /Prometiste/);
  assert.doesNotMatch(run('Permítame un momento, le paso con un asesor.'), /Prometiste/);
  assert.doesNotMatch(run('Permítame un momento mientras calculo.', false, ['Salón para eventos.']), /Prometiste/, 'sin precios no hay cotización que pedir');
});

test('formato «solo totales» (instrucciones de Metromalla): las cuentas van en thinking, el sistema las revisa y corrige el mensaje', async () => {
  const { validateDecision } = await import('../src/engine/validator.js');
  const { hydrateChatbot } = await import('../src/types.js');
  const { QUOTE_TEXT_TEMPLATES } = await import('../src/quotes/text-templates.js');
  const info = [QUOTE_TEXT_TEMPLATES.find((t) => t.key === 'cercas')!.text, 'IVA = subtotal × 0.16. Total = subtotal + IVA.', 'La Recta es más económica; misma resistencia y acabado.'];
  const b = hydrateChatbot({ id: 'b1', account_id: 'a1', name: 'Metromalla', active: true, personality: { formality: 'usted' }, rules: {}, data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date() } as any);
  const customer = ['Hola, quiero una cotizacion para una malla clasica de 40 metros de 2 metros de alto', 'cimentado'];
  const thinking = [
    'Paneles: 40 ÷ 2.50 = 16 paneles',
    'Postes: 16 + 1 = 17 postes',
    'Abrazaderas: 17 × 4 = 68',
    'Recta: 16 × $850 = $13,600; 17 × $450 = $7,650; 68 × $12 = $816',
    'Subtotal Recta: $13,600 + $7,650 + $816 = $22,066',
    'Total Recta: $22,066 × 1.16 = $25,596.56',
    'Clásica: 16 × $1,000 = $16,000',
    'Subtotal Clásica: $16,000 + $7,650 + $816 = $24,466',
    'Total Clásica: $24,466 × 1.16 = $28,380.56',
  ].join('\n');
  const reply = (recta: string, clasica: string) => `Con 40 metros lineales, altura de 2.00 m y fijación cimentado, estas serían sus opciones:\n\n*MetroMalla Recta:* ${recta} con IVA.\n*MetroMalla Clásica:* ${clasica} con IVA.\n\nLa Recta es más económica y tiene la misma resistencia y acabado. Su cotización tiene vigencia de 15 días.`;
  const run = (thinkingText: string, text: string) => validateDecision({
    raw: { thinking: thinkingText, action: 'reply', messages: [text], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false },
    bot: b, images: [], sentImageIds: [], customerText: customer.at(-1)!, groundingSources: info, claimSources: info, customerSources: customer, final: false,
  } as any);
  // Las cuentas están en thinking: el mensaje con solo los totales pasa tal cual (y «estas serían» no es tuteo).
  const ok = run(thinking, reply('$25,596.56', '$28,380.56'));
  assert.deepEqual(ok.retryable, []);
  assert.match(ok.plan.messages.join('\n'), /\$25,596\.56 con IVA[\s\S]*\$28,380\.56 con IVA/);
  // La IA se equivocó en la cuenta interna del total de la Clásica: el sistema corrige la cuenta y el total del mensaje.
  const bad = run(thinking.replace('= $28,380.56', '= $28,000.00'), reply('$25,596.56', '$28,000.00'));
  assert.deepEqual(bad.retryable, []);
  assert.match(bad.plan.messages.join('\n'), /\*MetroMalla Clásica:\* \$28,380\.56 con IVA/);
  // Sin cuentas en thinking, un total suelto sigue sin pasar (no se sabe de dónde sale).
  assert.match(run('El cliente quiere cotizar.', reply('$25,596.56', '$28,380.56')).retryable.join(' '), /25596\.56/);
  // Un total del mensaje que no sale de las cuentas internas tampoco pasa.
  assert.match(run(thinking, reply('$25,596.56', '$30,000')).retryable.join(' '), /30000/);
});

test('respuestas reales (instrucciones de Metromalla): cuenta partida en renglones y «(subtotal + flete) × 1.16»', async () => {
  const { QUOTE_TEXT_TEMPLATES } = await import('../src/quotes/text-templates.js');
  const info = [QUOTE_TEXT_TEMPLATES.find((t) => t.key === 'cercas')!.text, 'Aplica IVA del 16%. Total con entrega = (subtotal de materiales + flete) × 1.16. Santiago, García, Juárez, Cadereyta y Allende: $1,500, $2,500 y $3,500.'];
  const customer = ['Hola, quiero una cotizacion para una malla clasica de 40 metros de 2 metros de alto', 'cimentado', 'Allende'];
  const check = (reply: string) => {
    const trusted = new FactCorpus(info);
    const cust = new FactCorpus(customer);
    const r = fixArithmetic([reply], trusted, cust);
    return { bad: new FactCorpus([...info, ...customer]).unverified(r.messages[0], trusted, cust), fixes: r.corrections, text: r.messages[0] };
  };
  // Gemini partió cada operación en su renglón.
  const split = ['Paneles: 40', '÷ 2.50 = 16 paneles', '× $850 = $13,600', 'Postes: 16 + 1 = 17 postes', '× $400 = $6,800', 'Abrazaderas: 17 postes', '× 4 = 68 abrazaderas', '× $12 = $816',
    'Subtotal: $13,600 + $6,800 + $816 = $21,216', 'IVA (16%): $21,216', '× 0.16 = $3,394.56', 'Total: $21,216 + $3,394.56 = $24,610.56'].join('\n');
  assert.deepEqual(check(split), { bad: [], fixes: [], text: split }, 'el formato del cliente se conserva');
  // La fórmula de las instrucciones, con paréntesis.
  const grouped = ['Paneles: 40 ÷ 2.50 = 16 paneles × $850 = $13,600', 'Postes: 16 + 1 = 17 postes × $400 = $6,800', 'Abrazaderas: 17 postes × 4 = 68 abrazaderas × $12 = $816',
    'Subtotal materiales: $13,600 + $6,800 + $816 = $21,216', 'Flete: $2,500', 'Total con IVA: ($21,216 + $2,500) × 1.16 = $27,510.56'].join('\n');
  assert.deepEqual(check(grouped), { bad: [], fixes: [], text: grouped });
  // Gemini escribió $27,410.56: el sistema lo corrige con la cuenta de los paréntesis.
  assert.match(check(grouped.replace('$27,510.56', '$27,410.56')).text, /× 1\.16 = \$27,510\.56/);
  // Un comentario entre paréntesis sin operación sigue sin cortar la cuenta.
  assert.deepEqual(check('Paneles: 40 ÷ 2.50 = 16\nPostes: 16 + 1 = 17\nAbrazaderas: 17 postes × 4 (para 2.00 m de altura) = 68 abrazaderas\n68 × $12 = $816').bad, []);
});
