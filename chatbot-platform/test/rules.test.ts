/** Reglas del chatbot que el backend hace cumplir (no solo se piden a la IA). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitEmojis } from '../src/engine/text.js';
import { registerMismatch, validateDecision } from '../src/engine/validator.js';
import { alignFixedMessages, chatbotFromTemplate, FIXED_MESSAGES } from '../src/templates/business.js';
import { hydrateChatbot, RulesSchema, type ChatbotRow } from '../src/types.js';

const bot = (over: Record<string, any> = {}) =>
  hydrateChatbot({ id: 'b1', account_id: 'a1', name: 'Clínica', active: true, personality: {}, rules: {}, data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date(), ...over } as ChatbotRow);
const decision = (messages: string[]) => ({ thinking: '', action: 'reply', messages, image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false });
const run = (b: ReturnType<typeof bot>, messages: string[], o: { customer?: string; final?: boolean } = {}) =>
  validateDecision({ raw: decision(messages), bot: b, images: [], sentImageIds: [], groundingSources: [], customerText: o.customer ?? 'hola', final: o.final });

test('emojis "pocos": se dejan solo 2 (sin pedir otra respuesta); "ninguno": se quitan', () => {
  const r = run(bot(), ['¡Hola! 😊🎉 Bienvenida 🌴', 'Te esperamos 👍🏽 ✨']);
  assert.deepEqual(r.retryable, []);
  assert.deepEqual(r.plan.messages, ['¡Hola! 😊🎉 Bienvenida', 'Te esperamos']);
  assert.deepEqual(limitEmojis(['a 👨‍👩‍👧 b 👍🏽 c 😊'], 2), ['a 👨‍👩‍👧 b 👍🏽 c'], 'emojis compuestos cuentan como uno');
  const none = run(bot({ personality: { emojis: 'none' } }), ['Hola 😊']);
  assert.deepEqual(none.plan.messages, ['Hola']);
  const normal = run(bot({ personality: { emojis: 'normal' } }), ['🎉🎉🎉🎉']);
  assert.deepEqual(normal.plan.messages, ['🎉🎉🎉🎉']);
});

test('temas prohibidos: el bot no los saca por su cuenta; si el cliente pregunta, puede declinar', () => {
  const b = bot({ rules: { forbidden_topics: ['política', 'competencia'] } });
  const r = run(b, ['La limpieza cuesta lo que ve en la lista.', 'Por cierto, la competencia cobra más.']);
  assert.match(r.retryable.join(), /competencia/);
  const last = run(b, ['La limpieza cuesta lo que ve en la lista.', 'Por cierto, la competencia cobra más.'], { final: true });
  assert.deepEqual(last.plan.messages, ['La limpieza cuesta lo que ve en la lista.'], 'en el último intento se quita la oración');
  const asked = run(b, ['De política no puedo opinar, pero con gusto le ayudo con su cita.'], { customer: '¿Y qué opinas de la política?' });
  assert.deepEqual(asked.retryable, []);
  assert.ok(asked.fixes.some((f) => f.includes('política')), 'queda registrado para revisión');
});

test('trato: "usted" rechaza el tuteo y "tú" rechaza el usted', () => {
  assert.equal(registerMismatch('¿Le gustaría agendar? Con gusto le ayudo.', 'usted'), null);
  assert.equal(registerMismatch('¿Te gustaría agendar?', 'usted'), 'Te');
  assert.equal(registerMismatch('¿Estás disponible mañana?', 'usted'), 'Estás');
  assert.equal(registerMismatch('Un té verde, por favor', 'usted'), null, '"té" (bebida) no es tuteo');
  assert.equal(registerMismatch('El paquete "te consiento" incluye masaje', 'usted'), null, 'lo citado no cuenta');
  assert.equal(registerMismatch('¿Ustedes vienen juntos?', 'tu'), null, '"ustedes" (plural) sí se usa con tú');
  assert.equal(registerMismatch('¿Usted desea agendar?', 'tu'), 'Usted');

  const formal = bot({ personality: { formality: 'usted' } });
  assert.match(run(formal, ['¿Te gustaría agendar?']).retryable.join(), /usted/);
  assert.deepEqual(run(formal, ['¿Le gustaría agendar?']).retryable, []);
  const last = run(formal, ['¿Te gustaría agendar?'], { final: true });
  assert.deepEqual(last.retryable, [], 'en el último intento no se deja al cliente sin respuesta');
  assert.ok(last.fixes.some((f) => f.startsWith('Revisar trato')));
});

test('largo de las respuestas: "muy corta" pide resumir una respuesta larga', () => {
  const long = 'Tenemos limpieza dental, resinas, blanqueamiento y ortodoncia. '.repeat(6);
  const short = bot({ personality: { response_length: 'muy_corta' }, ai: { max_chars_per_bubble: 2000 } });
  assert.match(run(short, [long]).retryable.join(), /demasiado larga/);
  assert.deepEqual(run(short, [long], { final: true }).retryable, []);
  const detailed = bot({ personality: { response_length: 'detallada' }, ai: { max_chars_per_bubble: 2000 } });
  assert.deepEqual(run(detailed, [long]).retryable, []);
});

test('mensajes fijos en el trato elegido: plantillas y cambio de tú a usted', () => {
  const salud = chatbotFromTemplate({ business_type: 'salud', company: 'Clínica Sonrisa', assistant_name: 'Sofi', description: '' });
  assert.equal(salud.personality.formality, 'usted');
  assert.equal(salud.rules.handoff_message, FIXED_MESSAGES.usted.handoff_message);
  assert.match(salud.flow.greeting!, /¿En qué le puedo ayudar\?/);
  assert.equal(registerMismatch(salud.rules.handoff_message!, 'usted'), null);
  assert.equal(registerMismatch(salud.rules.fallback_message!, 'usted'), null);

  const tienda = chatbotFromTemplate({ business_type: 'tienda', company: 'Moda', assistant_name: '', description: '' });
  assert.equal(tienda.rules.handoff_message, FIXED_MESSAGES.tu.handoff_message);
  assert.equal(FIXED_MESSAGES.tu.handoff_message, RulesSchema.parse({}).handoff_message, 'los de "tú" son los de fábrica');
  assert.equal(FIXED_MESSAGES.tu.fallback_message, RulesSchema.parse({}).fallback_message);

  const defaults = RulesSchema.parse({});
  assert.equal(alignFixedMessages(defaults, 'usted').handoff_message, FIXED_MESSAGES.usted.handoff_message);
  const custom = { ...defaults, handoff_message: 'Te paso con Laura 🙌' };
  assert.equal(alignFixedMessages(custom, 'usted').handoff_message, 'Te paso con Laura 🙌', 'lo escrito a mano no se toca');
});
