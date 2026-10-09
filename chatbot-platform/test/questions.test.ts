/** Apartado "Preguntas": lista ordenada que el asistente sigue paso a paso, y apagado al terminarla. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// El arnés va primero: define las variables de entorno antes de que se cargue la configuración.
import { createHarness, dbAvailable, pool, sleep, waitFor } from './harness.js';
const { validateDecision } = await import('../src/engine/validator.js');
const { asksQuestion, questionProgress } = await import('../src/engine/questions.js');
const { hydrateChatbot, RulesSchema } = await import('../src/types.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const Q1 = '¿Cuál es tu nombre?';
const Q2 = '¿Para qué fecha te gustaría reservar?';
const Q3 = '¿Cómo nos conociste?';
const QUESTIONS = [
  { key: 'nombre', label: 'Nombre', type: 'name', required: true, question: Q1 },
  { key: 'fecha', label: 'Fecha', type: 'text', required: true, question: Q2 },
  { key: 'origen', label: 'Origen', type: 'option', options: ['Instagram', 'Recomendación'], required: false, question: Q3 },
];

/* ------------------------------ Reglas puras (sin base de datos) ------------------------------ */

const bot = hydrateChatbot({
  id: 'b', account_id: 'a', name: 'Hotel', active: true, personality: {}, rules: {}, flow: { goal: 'Reservar' }, ai: {}, saved_messages: [],
  data_fields: QUESTIONS, created_at: new Date(), updated_at: new Date(),
} as any);
const base = { bot, images: [], sentImageIds: [], groundingSources: [], customerText: 'Hola' };
const reply = (messages: string[], extra: Record<string, unknown> = {}) => ({ action: 'reply', messages, save_data: [], image_ids: [], remember: [], handoff_reason: '', info_not_found: false, intents: [], ...extra });
const journey = (asked: Record<string, number> = {}, done = false) => ({ asked, done });

test('avance: respondidas, opcional hecha una vez se deja pasar, obligatoria nunca se salta', () => {
  const qs = bot.data_fields;
  assert.equal(questionProgress(qs, {}, '', {}).next?.key, 'nombre');
  assert.equal(questionProgress(qs, {}, 'Ana', {}).next?.key, 'fecha', 'el nombre de la ficha cuenta');
  assert.equal(questionProgress(qs, { fecha: 'mañana' }, '', { nombre: 5 }).next?.key, 'nombre', 'una obligatoria se sigue preguntando');
  const optional = questionProgress(qs, { nombre: 'Ana', fecha: 'mañana' }, '', { origen: 1 });
  assert.equal(optional.next, null);
  assert.deepEqual(optional.skipped.map((q) => q.key), ['origen']);
  assert.ok(asksQuestion('Perfecto, Ana. ¿Para qué fecha te gustaría reservar?', { question: Q2 }));
  assert.ok(asksQuestion('¿Para qué fecha quieres reservar?', { question: Q2 }), 'la IA puede adaptarla un poco');
  assert.ok(!asksQuestion('¿Cuántas personas son?', { question: Q2 }));
});

test('validador: sin la siguiente pregunta pide otra respuesta y en el último intento la agrega tal cual', () => {
  const first = validateDecision({ ...base, raw: reply(['¡Hola! Bienvenido.']), questionJourney: journey(), final: false });
  assert.ok(first.retryable.some((x) => x.includes(Q1)), first.retryable.join(' | '));
  const last = validateDecision({ ...base, raw: reply(['¡Hola! Bienvenido.']), questionJourney: journey(), final: true });
  assert.deepEqual(last.retryable, []);
  assert.deepEqual(last.plan.messages, ['¡Hola! Bienvenido.', Q1]);
  assert.deepEqual(last.plan.question, { key: 'nombre', text: Q1 });
});

test('validador: una pregunta de la lista fuera de orden se quita y se hace la que toca', () => {
  const last = validateDecision({ ...base, knownName: 'Ana', raw: reply(['Mucho gusto. ¿Cómo nos conociste?']), questionJourney: journey({ nombre: 1 }), final: true });
  assert.deepEqual(last.plan.messages, ['Mucho gusto.', Q2]);
});

test('validador: con una pregunta pendiente no se queda callado', () => {
  const last = validateDecision({ ...base, customerText: 'ok', raw: reply([], { action: 'no_reply' }), questionJourney: journey({ nombre: 1 }), final: true });
  assert.equal(last.plan.action, 'ask');
  assert.deepEqual(last.plan.messages, [Q1]);
});

test('validador: una respuesta libre que el cliente no escribió no cuenta (la pregunta sigue pendiente)', () => {
  const last = validateDecision({
    ...base, customerText: 'ok', knownName: 'Ana', questionJourney: journey({ nombre: 1, fecha: 1 }), final: true,
    raw: reply([`Perfecto. ${Q2}`], { save_data: [{ field: 'fecha', value: '15 de octubre' }] }),
  });
  assert.equal(last.plan.saveData.fecha, undefined);
  assert.equal(last.plan.question?.key, 'fecha');
  const real = validateDecision({
    ...base, customerText: 'El 15 de octubre', knownName: 'Ana', questionJourney: journey({ nombre: 1, fecha: 1 }), final: true,
    raw: reply([`Anotado. ${Q3}`], { save_data: [{ field: 'fecha', value: '15 de octubre' }] }),
  });
  assert.equal(real.plan.saveData.fecha, '15 de octubre');
  assert.equal(real.plan.question?.key, 'origen');
});

test('validador: fin de la lista solo en el turno en que se termina, no para un cliente que vuelve con todo respondido', () => {
  const done = { knownName: 'Ana', knownData: { fecha: 'mañana' } };
  // La opcional se hizo una vez y el cliente no la contestó: se terminó la lista en este turno.
  assert.equal(validateDecision({ ...base, ...done, customerText: 'jaja', raw: reply(['Listo, gracias.']), questionJourney: journey({ nombre: 1, fecha: 1, origen: 1 }), final: true }).plan.questionsCompleted, true);
  // Ya se avisó en este recorrido: no se vuelve a avisar.
  assert.equal(validateDecision({ ...base, ...done, raw: reply(['Claro.']), questionJourney: journey({ nombre: 1, fecha: 1, origen: 1 }, true), final: true }).plan.questionsCompleted, false);
  // Cliente que vuelve (recorrido nuevo, nada preguntado aún) con todo respondido antes: no se apaga al primer mensaje.
  const back = validateDecision({ ...base, knownName: 'Ana', knownData: { fecha: 'mañana', origen: 'Instagram' }, raw: reply(['¡Hola de nuevo!']), questionJourney: journey(), final: true });
  assert.equal(back.plan.questionsCompleted, false);
  assert.equal(back.plan.question, null);
});

test('validador: el objetivo no se cumple mientras falte una pregunta obligatoria', () => {
  const v = validateDecision({ ...base, knownName: 'Ana', raw: reply([Q2], { goal_completed: true }), questionJourney: journey({ nombre: 1 }), final: true });
  assert.equal(v.plan.goalCompleted, false);
  assert.ok(v.fixes.some((f) => /faltan (datos importantes \(Fecha\)|preguntas obligatorias \(fecha\))/.test(f)), v.fixes.join(' | '));
});

test('validador: el texto de la pregunta lo escribió el negocio (no cuenta como trato equivocado ni como repetición)', () => {
  const usted = hydrateChatbot({ ...bot, personality: { formality: 'usted' }, rules: {}, flow: {}, ai: {} } as any);
  const v = validateDecision({ ...base, bot: usted, raw: reply([`Buenas tardes, con gusto le atiendo. ${Q1}`]), questionJourney: journey(), final: false });
  assert.ok(!v.retryable.some((x) => /usted/.test(x)), v.retryable.join(' | '));
  const again = validateDecision({ ...base, knownName: 'Ana', customerText: '¿tienen alberca?', recentBotTexts: [Q2], raw: reply([Q2]), questionJourney: journey({ nombre: 1, fecha: 1 }), final: false });
  assert.ok(!again.retryable.some((x) => /Repites/.test(x)), again.retryable.join(' | '));
});

/* ------------------------------ De extremo a extremo (servidor y base de datos) ------------------------------ */

const detail = async (phone: string) => (await h.authed('GET', `/api/conversations/${(await h.conversationFor(phone)).id}`)).json();
const textsTo = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text);
const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(350);
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.phone = $1 AND m.direction = 'in' AND NOT m.processed`, [phone])).rows[0].n === 0, 8000);
  await h.idle();
};
const setActivation = async (activation: Record<string, unknown>) => {
  const r = await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { activation: RulesSchema.parse({ activation }).activation } });
  assert.equal(r.statusCode, 200, r.body);
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({
    personality: { prompt: 'Eres el asistente del Hotel Palmas. Atiende con amabilidad y ayuda a reservar.' },
    flow: { goal: 'Que el cliente reserve', on_goal_action: 'none' },
    data_fields: QUESTIONS,
  });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('configuración: guarda las preguntas en orden, rechaza claves repetidas y el modo por palabras sin palabras', async () => {
  const saved = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.deepEqual(saved.data_fields.map((f: any) => [f.key, f.question]), [['nombre', Q1], ['fecha', Q2], ['origen', Q3]]);
  const dup = await h.authed('PUT', `/api/chatbots/${h.botId}`, { data_fields: [...QUESTIONS, { key: 'fecha', label: 'Otra', question: '¿Otra?' }] });
  assert.equal(dup.statusCode, 400);
  const empty = await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { activation: { mode: 'keywords', on_keywords: [' '] } } });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.body, /al menos una palabra/);
  assert.equal((await h.authed('GET', `/api/chatbots/${h.botId}`)).json().rules.activation.mode, 'always', 'no se guardó');
});

t('recorrido completo: pregunta en orden, agrega la que falta, quita la adelantada, ignora respuestas inventadas y se apaga al terminar', async () => {
  const P = '5215530000001';
  await setActivation({ off_on_questions: true, off_message: 'Gracias, en breve te contactamos.' });
  h.reset();

  // 1) La IA saluda sin preguntar: el sistema pide otra respuesta y al final agrega la pregunta 1 tal cual.
  h.setScript(() => ({ messages: ['¡Hola! Bienvenido al hotel.'] }));
  await say('Hola', P);
  assert.equal(h.calls.length, 2, 'se pidió una segunda respuesta');
  assert.deepEqual(textsTo(P), ['¡Hola! Bienvenido al hotel.', Q1]);
  const prompt = JSON.stringify(h.calls.at(-1));
  assert.match(prompt, /# Preguntas \(en este orden\)/);
  assert.match(prompt, /SIGUIENTE PREGUNTA/);
  assert.match(prompt, /tienen prioridad sobre las guías generales/);
  const tagged = async () => (await pool.query(`SELECT m.meta->>'question' AS q FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.phone = $1 AND m.meta ? 'question' ORDER BY m.id`, [P])).rows.map((r) => r.q);
  assert.deepEqual(await tagged(), ['nombre'], 'el mensaje con la pregunta queda marcado');

  // 2) Responde el nombre; la IA se adelanta a la pregunta 3: se quita y se hace la 2.
  h.reset();
  h.setScript(() => ({ messages: ['Mucho gusto, Ana. ¿Cómo nos conociste?'], save_data: [{ field: 'nombre', value: 'Ana López' }] }));
  await say('Soy Ana López', P);
  assert.deepEqual(textsTo(P), ['Mucho gusto, Ana.', Q2]);
  assert.equal((await detail(P)).contact.name, 'Ana López');

  // 3) La IA inventa la fecha: no se guarda y la pregunta 2 sigue pendiente.
  h.reset();
  h.setScript(() => ({ messages: [`Perfecto. ${Q2}`], save_data: [{ field: 'fecha', value: '15 de octubre' }] }));
  await say('ok', P);
  assert.equal((await detail(P)).contact.data?.fecha, undefined);
  assert.deepEqual(textsTo(P), [`Perfecto. ${Q2}`]);
  assert.match(JSON.stringify(h.calls.at(-1)), /SIGUIENTE PREGUNTA[^"]*fecha/);

  // 4) Da la fecha: se guarda y la IA hace la 3 (opcional).
  h.reset();
  h.setScript(() => ({ messages: [`Anotado. ${Q3}`], save_data: [{ field: 'fecha', value: '15 de octubre' }] }));
  await say('El 15 de octubre', P);
  assert.equal((await detail(P)).contact.data?.fecha, '15 de octubre');
  assert.deepEqual(await tagged(), ['nombre', 'fecha', 'fecha', 'origen']);

  // 5) No contesta la opcional: se deja pasar, se terminó la lista y el asistente se apaga después de responder.
  h.reset();
  h.setScript(() => ({ messages: ['Listo, gracias por tus respuestas.'] }));
  await say('jaja', P);
  assert.deepEqual(textsTo(P), ['Listo, gracias por tus respuestas.', 'Gracias, en breve te contactamos.']);
  const d = await detail(P);
  assert.equal(d.agent.state, 'paused');
  assert.match(d.agent.reason, /respondió todas las preguntas/);

  // 6) Ya apagado: no se llama a la IA.
  h.reset();
  await say('¿Sigues ahí?', P);
  assert.equal(h.calls.length, 0);
  await setActivation({});
});

t('objetivo: no se marca cumplido mientras falten preguntas obligatorias', async () => {
  const P = '5215530000002';
  h.reset();
  h.setScript(() => ({ messages: [Q1], goal_completed: true }));
  await say('Hola, quiero reservar', P);
  assert.equal((await detail(P)).conversation.goal_completed_at, null);
});

t('activadores: con modo por palabras no responde hasta la palabra; al activarse empieza por la pregunta 1', async () => {
  const P = '5215530000003';
  await setActivation({ mode: 'keywords', on_keywords: ['reservar'] });
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola! Con gusto te ayudo.'] }));
  await say('hola', P);
  assert.equal(h.calls.length, 0);
  assert.equal((await detail(P)).agent.state, 'waiting');
  await say('quiero reservar', P);
  assert.deepEqual(textsTo(P), ['¡Hola! Con gusto te ayudo.', Q1]);
  await setActivation({});
});
