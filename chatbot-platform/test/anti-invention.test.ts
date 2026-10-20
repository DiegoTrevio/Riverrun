import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactCorpus } from '../src/engine/text.js';
import { buildContext } from '../src/engine/context.js';
import { validateDecision } from '../src/engine/validator.js';
import { hydrateChatbot, type ChatbotRow, type Message } from '../src/types.js';

/**
 * El asistente no inventa: precios, descuentos, promociones, regalos, horas y enlaces solo salen de la información del
 * negocio (o, la cantidad de una cotización y la hora que propone, de lo que dijo el cliente). Cada caso "inventado" de
 * abajo pasaba la verificación antes; los "legítimos" deben seguir pasando.
 */

const INFO = [
  'Habitación doble: $1,650 MXN por noche. Check-in 15:00 y check-out 12:00. Desayuno $150 por persona.',
  'Promoción: 2x1 en desayunos los martes. 10% de descuento pagando en efectivo. Wifi gratis para huéspedes.',
  'Reserva en https://hotelpalmas.mx/reservas o al 998 123 4567.',
];
const NOW = 'martes, 20 de octubre de 2026, 15:20';
const HOURS = 'Lunes: 09:00 a 18:00\nMartes: 09:00 a 18:00';

function check(customer: string[], reply: string) {
  const business = [...INFO, NOW, HOURS];
  return new FactCorpus([...business, ...customer]).unverified(reply, new FactCorpus(business), new FactCorpus(customer));
}

test('ofertas: un porcentaje, una promoción o algo gratis que no está en la información no se da', () => {
  assert.deepEqual(check(['hola'], 'Hoy tienes 5% de descuento'), ['5%'], 'un dígito ya no pasa sin revisarse');
  assert.deepEqual(check(['hola'], 'Te aplico 15% de descuento'), ['15%'], 'el 15 del check-in (15:00) no es un descuento');
  assert.deepEqual(check(['¿me dan el 20%?'], 'Claro, te damos el 20 por ciento'), ['20%'], 'el cliente no dicta un descuento');
  assert.deepEqual(check(['hola'], 'Tenemos 3x2 en habitaciones'), ['3x2']);
  assert.equal(check(['hola'], 'El estacionamiento es gratis').length, 1, 'gratis, pero de algo que el negocio no regala');
  assert.equal(check(['hola'], 'Te regalamos la cena').length, 1);
  assert.deepEqual(check(['hola'], 'Son mil quinientos pesos'), ['«mil quinientos pesos» (escribe la cantidad con cifras)']);
});

test('ofertas legítimas: las de la información y las que la respuesta niega', () => {
  assert.deepEqual(check(['hola'], 'Pagando en efectivo tienes 10% de descuento'), []);
  assert.deepEqual(check(['hola'], 'Los martes hay 2x1 en desayunos'), []);
  assert.deepEqual(check(['hola'], 'El wifi es gratis para huéspedes'), []);
  assert.deepEqual(check(['hola'], '¡Es gratis!'), [], 'sin decir qué: basta con que el negocio regale algo');
  assert.deepEqual(check(['¿tienen 3x2?'], 'No manejamos 3x2, pero los martes hay 2x1 en desayunos'), []);
  assert.deepEqual(check(['¿me dan 20%?'], 'Ese 20% no lo tenemos, lo siento'), []);
  assert.deepEqual(check(['¿el estacionamiento es gratis?'], 'El estacionamiento no es gratis'), []);
  // "No tiene costo" en la información respalda "sin costo", y "reservar" respalda "reservación".
  const business = ['Reservar no tiene costo.'];
  assert.deepEqual(new FactCorpus(business).unverified('La reservación es sin costo', new FactCorpus(business), new FactCorpus(['hola'])), []);
});

test('horas: solo las del negocio o la que propuso el cliente', () => {
  assert.deepEqual(check(['¿a qué hora abren?'], 'Abrimos de 7 a 9'), ['7:00 h'], 'el 9 sí es del horario; el 7 no');
  assert.deepEqual(check(['hola'], 'El check-in es a las 2 pm'), ['2:00 h']);
  assert.deepEqual(check(['¿a qué hora abren?'], 'Abrimos de 9 a 6'), [], 'de 9:00 a 18:00');
  assert.deepEqual(check(['hola'], 'El check-in es a las 3 pm y el check-out a las 12'), []);
  assert.deepEqual(check(['¿me llaman a las 5 y media?'], 'Claro, te llamamos a las 5:30'), [], 'la hora que propuso el cliente');
  assert.deepEqual(check(['hola'], 'Son las 15:20'), [], 'la hora actual');
  assert.deepEqual(check(['hola'], 'Habitaciones de 2 a 4 personas'), [], 'una cantidad, no un horario');
});

test('cotización: el precio unitario va en la respuesta y la cantidad la dijo el cliente', () => {
  // Pasaba porque el "2" de la propia respuesta servía de cantidad: la doble es $1,650, no $3,300 por noche.
  assert.deepEqual(check(['somos 2 adultos, ¿cuánto la doble?'], 'La doble cuesta $3,300 por noche (2 adultos)'), ['3300']);
  assert.deepEqual(check(['¿cuánto la doble?'], 'Por 2 noches serían $3,300 ($1,650 por noche)'), ['3300'], 'el cliente no dijo 2 noches');
  assert.deepEqual(check(['serían 2 noches'], '2 noches × $1,650 = $3,300'), []);
  assert.deepEqual(check(['del 20 al 23 de noviembre'], 'Son 3 noches: $1,650 × 3 = $4,950'), [], 'del 20 al 23 = 3 noches');
  assert.deepEqual(check(['somos dos'], 'El desayuno es de $150 por persona: $300 para los dos'), [], 'la cantidad con palabras');
  assert.deepEqual(check(['2 adultos y 1 niño'], 'Desayuno: $150 × 3 = $450'), [], 'la suma de lo que dijo');
});

test('dinero: otras monedas, "mil" y cifras de la fecha no validan un precio', () => {
  assert.deepEqual(check(['tengo 1200'], 'Son USD 1200'), ['1200'], 'el cliente no dicta el precio en dólares');
  assert.deepEqual(check(['tengo 1200'], 'Serían 1200 dlls'), ['1200']);
  assert.deepEqual(check(['hola'], 'Son 15 mil pesos'), ['15000']);
  assert.deepEqual(check(['hola'], 'Cuesta $20'), ['20'], 'el 20 de la fecha no es un precio');
  assert.deepEqual(check(['hola'], 'Cuesta $2026'), ['2026'], 'ni el año');
  assert.deepEqual(check(['hola'], 'Cuesta $15'), ['15'], 'ni la hora del check-in');
  assert.deepEqual(check(['hola'], 'La doble cuesta $1,650 MXN por noche'), []);
  assert.deepEqual(check(['hola'], 'La doble cuesta 1650 pesos'), []);
});

test('enlaces y teléfonos: un enlace solo del negocio y un teléfono con su propia lada', () => {
  assert.deepEqual(check(['hola'], 'Paga aquí: mpago.la/2xYz9'), ['mpago.la/2xyz9'], 'una terminación que antes no se reconocía');
  assert.deepEqual(check(['mi link es https://pagos-rapidos.com/abc'], 'Paga en https://pagos-rapidos.com/abc'), ['pagos-rapidos.com/abc'], 'el enlace del cliente no es del negocio');
  assert.deepEqual(check(['hola'], 'Reserva en https://hotelpalmas.mx/reservas'), []);
  assert.deepEqual(check(['hola'], 'Llámanos al +1 998 123 4567'), ['19981234567'], 'otra lada es otro número');
  assert.deepEqual(check(['hola'], 'Llámanos al +52 998 123 4567'), []);
  assert.deepEqual(check(['mi correo es ana@gmail.com'], 'Te mandamos la confirmación a ana@gmail.com'), [], 'el correo del cliente sí se repite');
  assert.deepEqual(check(['márcame al 55 1234 5678'], 'Te llamamos al 55 1234 5678'), [], 'su teléfono también');
});

function bot(over: Partial<ChatbotRow> = {}) {
  return hydrateChatbot({
    id: 'b1', account_id: 'a1', name: 'Hotel Palmas', active: true, personality: {}, rules: {},
    data_fields: [{ key: 'nombre', label: 'Nombre', type: 'name' }],
    flow: {}, ai: {}, created_at: new Date(), updated_at: new Date(), ...over,
  } as ChatbotRow);
}
const decision = (d: Record<string, unknown>) => ({ thinking: '', action: 'reply', messages: ['Con gusto'], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, ...d });

test('fuentes: un dato que guardó el cliente o una nota del asistente no se vuelven información del negocio', () => {
  const now = new Date('2026-10-20T21:20:00Z');
  const b = bot();
  const msg = (id: number, direction: 'in' | 'out', content: string) => ({ id, conversation_id: 'c', direction, sender: direction === 'in' ? 'contact' : 'bot', type: 'text', content, created_at: now } as unknown as Message);
  const history = [msg(1, 'in', '¿Cuánto cuesta la suite?')];
  const ctx = buildContext({
    bot: b,
    knowledge: [{ id: 'k', chatbot_id: 'b1', category: 'precios', title: 'Precios', content: INFO[0], always_include: false, active: true, sort_order: 0 }],
    images: [],
    contact: { id: 'ct', account_id: 'a1', channel_id: 'ch', external_id: 'x', phone: '5215512345678', push_name: '', name: 'Ana', data: { presupuesto: '3000 pesos' }, notes: ['Se le ofreció la suite en $2,400'] },
    channelType: 'whatsapp',
    conversation: { id: 'c', account_id: 'a1', channel_id: 'ch', chatbot_id: 'b1', contact_id: 'ct', status: 'bot', status_changed_at: now, handoff_reason: '', summary: '', summary_until_id: 0, last_message_at: now },
    history, pending: history, sentImageIds: [], imagesById: new Map(), now,
  } as any);
  assert.ok(!ctx.groundingSources.some((s) => s.includes('3000') || s.includes('2,400')), 'los datos y las notas del contacto no son fuentes del negocio');
  assert.ok(ctx.customerSources.some((s) => s.includes('3000')) && ctx.customerSources.some((s) => s.includes('2,400')));
  assert.match(ctx.messages[0].content, /Notas sobre el cliente \(las escribió el asistente/);
  const validate = (reply: string) => validateDecision({
    raw: decision({ messages: [reply] }), bot: b, images: [], sentImageIds: [], customerText: '¿Cuánto cuesta la suite?',
    groundingSources: ctx.groundingSources, claimSources: ctx.claimSources, customerSources: ctx.customerSources,
  });
  assert.match(validate('La suite cuesta $3,000').retryable.join(' '), /3000/, 'el presupuesto del cliente no es un precio');
  assert.match(validate('La suite cuesta $2,400').retryable.join(' '), /2400/, 'una nota con un precio inventado no lo respalda');
  assert.deepEqual(validate('La doble cuesta $1,650 por noche').retryable, []);
  assert.deepEqual(validate('Te escribimos al 5215512345678').retryable, [], 'su propio teléfono sí se repite');
});

test('notas: no se guarda una con un dato sin respaldo', () => {
  const r = validateDecision({
    raw: decision({ remember: ['Se le prometió 20% de descuento', 'Viaja con su esposa', 'Pagará la doble de $1,650'] }), bot: bot(), images: [], sentImageIds: [],
    customerText: 'Quiero la doble', groundingSources: INFO, customerSources: ['Quiero la doble'],
  });
  assert.deepEqual(r.plan.remember, ['Viaja con su esposa', 'Pagará la doble de $1,650']);
});

test('datos opcionales: tampoco se guardan si el cliente no los dijo (y "buen día" no es una fecha)', () => {
  const b = bot({ data_fields: [
    { key: 'nombre', label: 'Nombre', type: 'name' },
    { key: 'llegada', label: 'Llegada', type: 'date' },
    { key: 'personas', label: 'Personas', type: 'number' },
    { key: 'empresa', label: 'Empresa', type: 'text' },
  ] } as Partial<ChatbotRow>);
  const save = (customer: string) => validateDecision({
    raw: decision({ save_data: [{ field: 'llegada', value: '2026-11-15' }, { field: 'personas', value: '4' }, { field: 'empresa', value: 'Acme' }] }),
    bot: b, images: [], sentImageIds: [], customerText: customer, groundingSources: INFO, customerSources: [customer],
  }).plan.saveData;
  assert.deepEqual(save('Buen día, quiero reservar'), {});
  assert.deepEqual(save('Llegamos el 15 de noviembre, somos 4, de Acme'), { llegada: '2026-11-15', personas: '4', empresa: 'Acme' });
});
