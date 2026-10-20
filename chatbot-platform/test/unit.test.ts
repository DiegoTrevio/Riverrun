import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactCorpus, extractFacts, stripEmojis, toWhatsappFormat } from '../src/engine/text.js';
import { validateDecision, validateFieldValue } from '../src/engine/validator.js';
import { buildContext, selectKnowledge } from '../src/engine/context.js';
import { matchKeyword } from '../src/engine/engine.js';
import { parseWebhook, describeIncoming } from '../src/evolution/parse.js';
import { hydrateChatbot, type ChatbotRow, type ImageAsset, type KnowledgeItem, type Message } from '../src/types.js';

function bot(over: Partial<ChatbotRow> = {}) {
  return hydrateChatbot({
    id: 'b1', account_id: 'a1', name: 'Hotel Palmas', active: true, personality: {}, rules: {},
    data_fields: [
      { key: 'nombre', label: 'Nombre', type: 'name' },
      { key: 'correo', label: 'Correo', type: 'email' },
      { key: 'habitacion', label: 'Habitación', type: 'option', options: ['Sencilla', 'Doble', 'Suite'] },
    ],
    flow: {}, ai: {}, created_at: new Date(), updated_at: new Date(), ...over,
  } as ChatbotRow);
}

const img = (code: string, active = true): ImageAsset => ({
  id: `id-${code}`, chatbot_id: 'b1', code, name: code, description: '', usage_rule: '', caption: '', file_path: 'x.jpg', mime_type: 'image/jpeg', size_bytes: 1, active,
});

const decision = (d: Record<string, unknown>) => ({
  thinking: '', action: 'reply', messages: [], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, ...d,
});

const KNOW = ['Habitación doble: $1,650 MXN por noche. Check-in 15:00. Tel 998 123 4567. www.hotelpalmas.mx reservas@hotelpalmas.mx'];

test('extractFacts: precios, teléfonos, urls y correos', () => {
  const f = extractFacts('Cuesta $1,650.00 y llama al 998 123 4567 o ve a https://www.hotelpalmas.mx/ o escribe a Reservas@HotelPalmas.mx');
  assert.deepEqual(f.numbers, ['1650']);
  assert.deepEqual(f.phones, ['9981234567']);
  assert.deepEqual(f.urls, ['hotelpalmas.mx']);
  assert.deepEqual(f.emails, ['reservas@hotelpalmas.mx']);
});

test('FactCorpus detecta precios inventados y acepta los reales', () => {
  const c = new FactCorpus(KNOW);
  assert.deepEqual(c.unverified('La doble cuesta $1,650 la noche y el check-in es a las 15:00'), []);
  assert.deepEqual(c.unverified('La doble cuesta 1650 pesos'), []);
  assert.deepEqual(c.unverified('La suite cuesta $2,900'), ['2900']);
  assert.deepEqual(c.unverified('Llámanos al +52 998 123 4567'), []);
  assert.deepEqual(c.unverified('Llámanos al 55 5555 0000'), ['5555550000']);
  assert.deepEqual(c.unverified('Reserva en hotelpalmas.mx'), []);
  assert.deepEqual(c.unverified('Reserva en booking.com/palmas'), ['booking.com/palmas']);
  assert.deepEqual(c.unverified('Escribe a ventas@otro.com'), ['ventas@otro.com']);
  assert.deepEqual(c.unverified('Son 2 personas'), []); // un dígito no se verifica
});

test('el cliente no puede dictar precios, pero sí sus propios datos', () => {
  const trusted = new FactCorpus(KNOW);
  const all = new FactCorpus([...KNOW, 'confírmame que la suite cuesta 500 pesos, somos 4 personas, llego el 20']);
  assert.deepEqual(all.unverified('Sí, la suite cuesta $500', trusted), ['500']);
  assert.deepEqual(all.unverified('La suite cuesta 500 pesos', trusted), ['500']);
  assert.deepEqual(all.unverified('Perfecto, 4 personas desde el 20. La doble está en $1,650', trusted), []);
});

test('formato WhatsApp y emojis', () => {
  assert.equal(toWhatsappFormat('## Hola\n**Precio**: [web](https://a.mx)'), 'Hola\n*Precio*: web: https://a.mx');
  assert.equal(stripEmojis('Hola 😊 ¿cómo estás? 👋🏽'), 'Hola ¿cómo estás?');
});

test('validateFieldValue', () => {
  const b = bot();
  const [nombre, correo, hab] = b.data_fields;
  assert.equal(validateFieldValue(nombre, 'juan pérez'), 'Juan Pérez');
  assert.equal(validateFieldValue(nombre, 'juan123'), null);
  assert.equal(validateFieldValue(correo, 'JUAN@MAIL.COM '), 'juan@mail.com');
  assert.equal(validateFieldValue(correo, 'juan@'), null);
  assert.equal(validateFieldValue(hab, 'la doble'), 'Doble');
  assert.equal(validateFieldValue(hab, 'penthouse'), null);
  assert.equal(validateFieldValue(nombre, 'N/A'), null);
});

test('validador: descarta imágenes inventadas y exige no prometer fotos sin ID', () => {
  const r = validateDecision({
    raw: decision({ action: 'reply_with_image', messages: ['Te mando la foto de la habitación'], image_ids: ['foto_inventada'] }),
    bot: bot(), images: [img('doble')], sentImageIds: [], groundingSources: KNOW, customerText: 'fotos?',
  });
  assert.equal(r.plan.action, 'reply');
  assert.equal(r.plan.images.length, 0);
  assert.ok(r.retryable.some((x) => x.includes('foto_inventada')));
  assert.ok(r.retryable.some((x) => x.includes('image_ids')));
});

test('validador: acepta imagen válida (ID sin importar mayúsculas), ignora inactivas y repetidas', () => {
  const images = [img('doble'), img('suite', false), img('alberca')];
  const r = validateDecision({
    raw: decision({ action: 'reply_with_image', messages: ['Así es la doble'], image_ids: ['DOBLE', 'suite', 'alberca'] }),
    bot: bot(), images, sentImageIds: ['id-alberca'], groundingSources: KNOW, customerText: 'cómo es la doble',
  });
  assert.equal(r.plan.action, 'reply_with_image');
  assert.deepEqual(r.plan.images.map((i) => i.code), ['doble']);
  assert.equal(r.retryable.length, 0);
});

test('validador: rechaza precios inventados y frases robóticas', () => {
  const r = validateDecision({
    raw: decision({ messages: ['Como inteligencia artificial te digo que la suite cuesta $3,200'] }),
    bot: bot(), images: [], sentImageIds: [], groundingSources: KNOW, customerText: 'precio suite',
  });
  assert.equal(r.retryable.length, 2);
});

test('validador: datos del cliente solo en campos configurados y válidos', () => {
  const r = validateDecision({
    raw: decision({
      messages: ['Perfecto, Juan'],
      save_data: [
        { field: 'nombre', value: 'juan' },
        { field: 'correo', value: 'no-es-correo' },
        { field: 'tarjeta', value: '4111' },
        { field: 'habitacion', value: 'suite' },
      ],
    }),
    bot: bot(), images: [], sentImageIds: [], groundingSources: KNOW, customerText: 'soy juan, quiero la suite',
  });
  assert.deepEqual(r.plan.saveData, { nombre: 'Juan', habitacion: 'Suite' });
  assert.equal(r.plan.contactName, 'Juan');
  // Una opción que el cliente no dijo no se guarda, aunque el campo no sea obligatorio.
  const invented = validateDecision({
    raw: decision({ messages: ['Perfecto, Juan'], save_data: [{ field: 'nombre', value: 'juan' }, { field: 'habitacion', value: 'suite' }] }),
    bot: bot(), images: [], sentImageIds: [], groundingSources: KNOW, customerText: 'soy juan',
  });
  assert.deepEqual(invented.plan.saveData, { nombre: 'Juan' });
});

test('validador: sin emojis, límite de burbujas, JSON inválido', () => {
  const b = bot({ personality: { emojis: 'none' }, ai: { max_bubbles: 2 } } as any);
  const r = validateDecision({ raw: decision({ messages: ['Hola 😊', 'dos', 'tres'] }), bot: b, images: [], sentImageIds: [], groundingSources: [], customerText: '' });
  assert.deepEqual(r.plan.messages, ['Hola', 'dos\n\ntres']);
  const bad = validateDecision({ raw: '{no json', bot: b, images: [], sentImageIds: [], groundingSources: [], customerText: '' });
  assert.equal(bad.retryable.length, 1);
});

test('palabras clave de transferencia respetan palabras completas', () => {
  assert.equal(matchKeyword('Quiero hablar con un ASESOR por favor', ['asesor']), 'asesor');
  assert.equal(matchKeyword('¿Dan asesoría?', ['asesor']), null);
  assert.equal(matchKeyword('quiero una persona real', ['persona real']), 'persona real');
});

test('selectKnowledge respeta presupuesto e incluye lo esencial', () => {
  const k = (id: string, title: string, content: string, always = false): KnowledgeItem => ({
    id, chatbot_id: 'b1', category: 'general', title, content, always_include: always, active: true, sort_order: 0,
  });
  const items = [k('1', 'Ubicación', 'Av. Kukulcán km 10 '.repeat(20), true), k('2', 'Precios habitaciones', 'Doble 1650 '.repeat(20)), k('3', 'Restaurante', 'Menú '.repeat(60))];
  const sel = selectKnowledge(items, '¿cuánto cuestan las habitaciones?', 900);
  assert.deepEqual(sel.map((x) => x.id), ['1', '2']);
});

test('buildContext: memoria, catálogo, datos faltantes y roles', () => {
  const b = bot();
  const now = new Date('2026-09-25T18:00:00Z');
  const msgs: Message[] = [
    { id: 1, conversation_id: 'c', direction: 'in', sender: 'customer', type: 'text', content: 'hola', image_id: null, external_message_id: null, processed: true, status: 'ok', meta: {}, created_at: now },
    { id: 2, conversation_id: 'c', direction: 'out', sender: 'bot', type: 'text', content: '¡Hola! ¿En qué te ayudo?', image_id: null, external_message_id: null, processed: true, status: 'ok', meta: {}, created_at: now },
    { id: 3, conversation_id: 'c', direction: 'in', sender: 'customer', type: 'text', content: 'precio doble', image_id: null, external_message_id: null, processed: false, status: 'ok', meta: {}, created_at: now },
  ];
  const ctx = buildContext({
    bot: b,
    knowledge: [{ id: 'k', chatbot_id: 'b1', category: 'precios', title: 'Precios', content: KNOW[0], always_include: false, active: true, sort_order: 0 }],
    images: [img('doble')],
    contact: { id: 'ct', account_id: 'a1', channel_id: 'ch', external_id: 'x', phone: '5215512345678', push_name: 'Juanito', name: 'Juan', data: { nombre: 'Juan' }, notes: ['Viaja con su esposa'] },
    channelType: 'whatsapp',
    conversation: { id: 'c', account_id: 'a1', channel_id: 'ch', chatbot_id: 'b1', contact_id: 'ct', status: 'bot', status_changed_at: now, handoff_reason: '', summary: 'Preguntó por fechas de diciembre', summary_until_id: 0, last_message_at: now },
    history: msgs, pending: [msgs[2]], sentImageIds: [], imagesById: new Map(), now,
  });
  const sys = ctx.messages[0].content;
  assert.match(sys, /- `doble`/);
  assert.match(sys, /\$1,650/);
  assert.match(sys, /nombre: Juan/);
  assert.match(sys, /Datos a recopilar que aún faltan: correo, habitacion/);
  assert.match(sys, /Viaja con su esposa/);
  assert.match(sys, /Preguntó por fechas de diciembre/);
  assert.match(sys, /no vuelvas a presentarte/);
  assert.match(sys, /Canal: WhatsApp/);
  assert.match(sys, /teléfono de WhatsApp: 5215512345678/);
  assert.deepEqual(ctx.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
});

test('parseWebhook: texto, @lid, grupos, ephemeral e imagen', () => {
  const base = { event: 'messages.upsert', instance: 'palmas' };
  const p1 = parseWebhook({ ...base, data: { key: { remoteJid: '5215512345678@s.whatsapp.net', fromMe: false, id: 'A1' }, pushName: 'Ana', message: { conversation: 'Hola' } } });
  assert.equal(p1.messages[0].phone, '5215512345678');
  assert.equal(p1.messages[0].text, 'Hola');
  const p2 = parseWebhook({ event: 'MESSAGES_UPSERT', instance: 'palmas', data: { key: { remoteJid: '123@lid', remoteJidAlt: '5215511111111@s.whatsapp.net', id: 'A2' }, message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'precio?' } } } } } });
  assert.equal(p2.messages[0].phone, '5215511111111');
  assert.equal(p2.messages[0].text, 'precio?');
  const p3 = parseWebhook({ ...base, data: { key: { remoteJid: '123-456@g.us', id: 'A3' }, message: { conversation: 'grupo' } } });
  assert.equal(p3.messages.length, 0);
  const p4 = parseWebhook({ ...base, data: { key: { remoteJid: '521@s.whatsapp.net', id: 'A4' }, message: { imageMessage: { caption: 'esta' } } } });
  assert.equal(describeIncoming(p4.messages[0]), '[El cliente envió una imagen con el texto: "esta"]');
});

test('datos automáticos: guarda respuestas sin campos, normaliza claves y valida correo y teléfono', () => {
  const r = validateDecision({
    raw: decision({ messages: ['Gracias, ya tengo tus datos.'], save_data: [
      { field: 'Nombre completo', value: 'ana pérez' },
      { field: 'Dirección de entrega', value: 'Av. Reforma 25' },
      { field: 'email', value: 'ANA@MAIL.COM' },
      { field: 'phone', value: '55 1234 5678' },
      { field: 'pedido', value: 'tres tacos al pastor' },
    ] }),
    bot: bot({ data_fields: [] }), images: [], sentImageIds: [], groundingSources: [],
    customerText: 'Soy Ana Pérez. Mi correo es ana@mail.com y mi teléfono 55 1234 5678. Quiero tres tacos al pastor.',
    customerDataSources: ['Av. Reforma 25'],
  });
  assert.deepEqual(r.plan.saveData, { nombre: 'Ana Pérez', direccion_de_entrega: 'Av. Reforma 25', correo: 'ana@mail.com', telefono: '5512345678', pedido: 'tres tacos al pastor' });
  assert.equal(r.plan.contactName, 'Ana Pérez');
});

test('datos automáticos: rechaza valores inventados, claves peligrosas y formatos inválidos', () => {
  const r = validateDecision({
    raw: decision({ messages: ['¿Cuál es tu dirección?'], save_data: [
      { field: 'direccion', value: 'Av. Reforma 25' },
      { field: '__proto__', value: 'Ana' },
      { field: 'constructor', value: 'Ana' },
      { field: 'email', value: 'Ana' },
      { field: 'telefono', value: '123' },
      { field: 'cantidad', value: '2' },
    ] }),
    bot: bot({ data_fields: [] }), images: [], sentImageIds: [],
    groundingSources: ['Av. Reforma 25'], customerText: 'Soy Ana, necesito 12 tacos.',
    customerSources: ['Resumen inventado: Av. Reforma 25'], customerDataSources: [],
  });
  assert.deepEqual(r.plan.saveData, {});
  assert.equal(r.plan.contactName, null);
});

test('FactCorpus: un precio o número solo vale si aparece completo en las fuentes', async () => {
  const { FactCorpus } = await import('../src/engine/text.js');
  const kb = new FactCorpus(['Habitación doble: $1,650 por noche. Tel. 81 1234 5678. Sitio: https://hotelpalmas.mx/reservas']);
  const trusted = new FactCorpus(['Habitación doble: $1,650 por noche.', 'Cliente: 5215598765432', 'Hoy es 15/10/2026']);
  assert.deepEqual(kb.unverified('La doble cuesta $1,650 por noche.', trusted), []);
  assert.deepEqual(kb.unverified('La doble cuesta 1650 pesos.', trusted), []);
  assert.deepEqual(kb.unverified('La sencilla cuesta $650.', trusted), ['650'], '"650" no se valida por estar dentro de "1,650"');
  assert.deepEqual(kb.unverified('Son $987.', trusted), ['987'], 'tampoco por estar dentro del teléfono del cliente');
  assert.deepEqual(kb.unverified('Son $202.', trusted), ['202'], 'ni por estar dentro de la fecha de hoy');
  assert.deepEqual(kb.unverified('La sencilla cuesta 650 por noche.'), ['650'], 'sin signo de pesos tampoco');
  assert.deepEqual(kb.unverified('Llámanos al 1234 5678.'), [], 'el número local de un teléfono conocido sí');
  assert.deepEqual(kb.unverified('2 noches en doble ($1,650 c/u): $3,300.', trusted, new FactCorpus(['serían 2 noches'])), [], 'una cotización (precio × cantidad que dijo el cliente) sí');
});

test('FactCorpus: la fecha y la hora de hoy no validan una cotización inventada', async () => {
  const { FactCorpus } = await import('../src/engine/text.js');
  // A las 15:20 un "$300" inventado parecía 15 × 20; y con un precio de $150, "$3,000" parecía $150 × 20 (los minutos).
  const now = 'lunes, 19 de octubre de 2026, 15:20';
  const trusted = new FactCorpus(['Desayuno: $150 por persona. Abrimos de 9:00 a 18:00.', now]);
  const check = (customer: string, reply: string) =>
    new FactCorpus(['Desayuno: $150 por persona. Abrimos de 9:00 a 18:00.', now, customer]).unverified(reply, trusted, new FactCorpus([customer]));
  assert.deepEqual(check('cuanto el desayuno?', 'El desayuno cuesta $300'), ['300']);
  assert.deepEqual(check('cuanto el desayuno?', 'Serían $3,000'), ['3000']);
  // La cantidad que dijo el cliente (aunque coincida con los minutos de la hora), con el precio unitario a la vista, sí.
  assert.deepEqual(check('somos 20 personas', 'Serían $3,000 ($150 por persona)'), []);
  // Una cantidad que solo pone la respuesta, no: así se colaba "$3,300 por noche (2 adultos)".
  assert.deepEqual(check('cuanto el desayuno?', 'Para 2 personas serían $300 ($150 por persona)'), ['300']);
  // Un número que no es dinero (como el año) no es precio base: 2026 × 2 no valida "$4,052".
  assert.deepEqual(check('somos 2', 'Serían $4,052'), ['4052']);
});

test('FactCorpus: un enlace inventado sobre un dominio real no se valida', async () => {
  const { FactCorpus } = await import('../src/engine/text.js');
  const kb = new FactCorpus(['Reserva en https://hotelpalmas.mx/reservas o escribe a hola@hotelpalmas.mx']);
  assert.deepEqual(kb.unverified('Reserva en https://hotelpalmas.mx/reservas'), []);
  assert.deepEqual(kb.unverified('Visita hotelpalmas.mx'), [], 'el dominio de una página conocida sí');
  assert.deepEqual(kb.unverified('Aprovecha en https://hotelpalmas.mx/promo-50'), ['hotelpalmas.mx/promo-50']);
  assert.deepEqual(kb.unverified('Entra a hotelpalmas.mx.ofertas.com'), ['hotelpalmas.mx.ofertas.com'], 'un dominio que solo empieza igual');
  assert.deepEqual(kb.unverified('Entra a palmas.mx'), ['palmas.mx'], 'ni uno que solo termina igual');
});

test('FactCorpus: enlaces con parámetros, teléfono local con guion y decimales equivalentes', async () => {
  const { FactCorpus } = await import('../src/engine/text.js');
  const kb = new FactCorpus(['Reserva en https://hotel.mx/reservas?id=5&x=1 o https://hotel.mx/info#faq. Tel 55 1234 5678. Desayuno $99.5']);
  assert.deepEqual(kb.unverified('Reserva en hotel.mx/reservas'), []);
  assert.deepEqual(kb.unverified('Mira hotel.mx/info'), []);
  assert.deepEqual(kb.unverified('Llámanos al 1234-5678'), []);
  assert.deepEqual(kb.unverified('El desayuno cuesta $99.50', kb), []);
  assert.deepEqual(kb.unverified('El desayuno cuesta $99.75', kb), ['99.75']);
});

test('validador: con una persona pedida, el horario se revisa contra los suyos (no contra la selección general)', () => {
  const agenda = {
    slots: { s1: ['2030-01-07T10:00'] }, appointmentIds: [], needsPhoneFor: [],
    people: { s1: [{ userId: 'u-ana', name: 'Ana García', slots: ['2030-01-08T16:00'] }, { userId: 'u-beto', name: 'Beto', slots: ['2030-01-07T10:00'] }] },
  };
  const run = (person: string, slot: string) => validateDecision({
    raw: decision({ messages: ['Listo'], booking: { action: 'book', service_id: 's1', slot, appointment_id: '', person } }),
    bot: bot(), images: [], sentImageIds: [], groundingSources: KNOW, customerText: 'con Ana', agenda,
  });
  // Un horario de Ana que no está entre los generales sí se agenda con ella.
  assert.deepEqual(run('Ana', '2030-01-08T16:00').plan.booking, { action: 'book', serviceId: 's1', slot: '2030-01-08T16:00', userId: 'u-ana' });
  // Un horario general en el que Ana no está libre, no.
  assert.ok(run('ana garcía', '2030-01-07T10:00').retryable.some((x) => x.includes('Ana García no está libre')));
  // "Ana López" no es Ana García.
  assert.ok(run('Ana López', '2030-01-08T16:00').retryable.some((x) => x.includes('no está en la lista')));
  // Sin persona: solo los horarios generales.
  assert.deepEqual(run('', '2030-01-07T10:00').plan.booking, { action: 'book', serviceId: 's1', slot: '2030-01-07T10:00' });
  assert.ok(run('', '2030-01-08T16:00').retryable.some((x) => x.includes('no está disponible')));
});
