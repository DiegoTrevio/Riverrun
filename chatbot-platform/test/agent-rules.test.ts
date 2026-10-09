/** Reglas generales del agente: seguridad, mensajes automáticos, bucles, datos sensibles, preguntas sin respuesta, repeticiones y contexto. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));

/** Un mensaje del cliente, esperando a que el asistente termine de procesarlo. */
const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(350);
  await h.idle();
  await h.service.automator.settleAll();
};
const textsTo = (phone: string) => h.sent.filter((s) => s.to === phone && s.kind === 'text').map((s) => s.text);
const decisions = () => h.calls.length;
const convOf = (phone: string) => h.conversationFor(phone);
const alertsOf = async (kind: string) => (await pool.query(`SELECT title, body FROM notifications WHERE account_id = $1 AND kind = $2 ORDER BY id`, [h.accountId, kind])).rows as { title: string; body: string }[];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'equipo@clinica.mx', name: 'Equipo', password: 'clave-equipo-1', role: 'agent' });
  assert.equal(u.statusCode, 200, u.body);
  // Las conversaciones sin asignar avisan a los administradores: los agentes solo reciben lo que tienen asignado.
  const owner = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'dueno@clinica.mx', name: 'Dueño', password: 'clave-equipo-1', role: 'admin' });
  assert.equal(owner.statusCode, 200, owner.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('emergencia: pasa a una persona con un mensaje fijo, sin consultar a la IA y con aviso al equipo', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Esto no debería enviarse'] }));
  const phone = '5215530000001';
  await say('ya no quiero vivir, todo está muy mal', phone);
  assert.equal(decisions(), 0, 'una emergencia no pasa por la IA');
  const sent = textsTo(phone);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /911/);
  assert.match(sent[0], /Línea de la Vida/);
  assert.equal((await convOf(phone)).status, 'human');
  assert.ok((await alertsOf('safety')).some((a) => /Posible emergencia/.test(a.title)), 'el equipo recibe el aviso');
});

t('emergencia en inglés: responde en inglés', async () => {
  h.reset();
  const phone = '5215530000002';
  await say("I'm going to kill myself tonight", phone);
  assert.equal(decisions(), 0);
  assert.match(textsTo(phone)[0], /emergency number/);
  assert.equal((await convOf(phone)).status, 'human');
});

t('peligro que no es autolesión: pide llamar a emergencias, sin la línea de crisis', async () => {
  h.reset();
  const phone = '5215530000003';
  await say('me están secuestrando, ayuda', phone);
  assert.equal(decisions(), 0);
  const [msg] = textsTo(phone);
  assert.match(msg, /911/);
  assert.doesNotMatch(msg, /Línea de la Vida/);
  assert.equal((await convOf(phone)).status, 'human');
});

t('mensajes automáticos (contestador, respuesta de ausencia): no se contestan y no gastan IA', async () => {
  h.reset();
  const phone = '5215530000004';
  await say('Respuesta automática: estoy fuera de la oficina hasta el lunes', phone);
  assert.equal(decisions(), 0);
  assert.deepEqual(textsTo(phone), []);
  assert.equal((await convOf(phone)).status, 'bot');
});

t('el mismo texto repetido por el cliente pausa al asistente y avisa al equipo, sin contestar la tercera vez', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  const phone = '5215530000005';
  const text = 'Gracias por escribirnos, en breve te atenderemos con gusto';
  await say(text, phone);
  await say(text, phone);
  assert.equal(decisions(), 2, 'las dos primeras sí se contestan');
  await say(text, phone);
  assert.equal(decisions(), 2, 'la tercera no llega a la IA');
  assert.equal(textsTo(phone).length, 2);
  const conv = await convOf(phone);
  assert.equal((await h.authed('GET', `/api/conversations/${conv.id}`)).json().agent.on, false, 'el asistente queda en pausa');
  const until = (await pool.query(`SELECT agent_off_until FROM conversations WHERE id = $1`, [conv.id])).rows[0].agent_off_until as Date;
  assert.ok(until.getTime() > Date.now() + 3 * 3600_000 && until.getTime() < Date.now() + 5 * 3600_000, 'la pausa dura unas horas, no para siempre');
  assert.ok((await alertsOf('automation')).some((a) => /bucle/.test(a.title)), 'el equipo se entera');
});

t('tarjeta: el número se guarda enmascarado y la IA no lo recibe completo', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Recibido, gracias.'] }));
  const phone = '5215530000006';
  await say('Mi tarjeta es 4111 1111 1111 1111, vence 12/29', phone);
  const rows = (await pool.query(`SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [(await convOf(phone)).id])).rows as { content: string }[];
  assert.ok(rows.some((r) => r.content.includes('•••• 1111')), 'se guarda solo el final');
  assert.ok(rows.every((r) => !/4111/.test(r.content)), 'nunca queda completo en la base de datos');
  assert.doesNotMatch(JSON.stringify(h.calls.at(-1)!.messages), /4111 1111 1111 1111|4111111111111111/);
});

t('preguntas: nunca se quedan sin respuesta; si la IA calla dos veces, pasa a una persona', async () => {
  h.reset();
  const phone = '5215530000007';
  h.setScript(() => ({ messages: ['¡Hola! ¿En qué te ayudo?'] }));
  await say('hola', phone);
  h.setScript(() => ({ action: 'no_reply', messages: [] }));
  const before = decisions();
  await say('¿Cuánto cuesta el servicio?', phone);
  assert.equal(decisions() - before, 2, 'reintenta una vez antes de rendirse');
  assert.equal((await convOf(phone)).status, 'human');
  assert.match(textsTo(phone).at(-1)!, /te comunico con alguien del equipo/);
});

t('promesa de seguimiento: el equipo recibe el aviso aunque el asistente solo lo diga', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Déjame revisarlo con el equipo y te aviso.'] }));
  const phone = '5215530000008';
  await say('¿Aceptan pagos con transferencia en dólares?', phone);
  assert.ok((await alertsOf('follow_up')).some((a) => /revisarlo con el equipo/.test(a.body)));
});

t('no repetir: la misma respuesta a otra pregunta se corrige; si el cliente repite su pregunta, puede repetirse', async () => {
  h.reset();
  const phone = '5215530000009';
  const answer = 'Con gusto te ayudo con eso, dime qué necesitas exactamente y lo vemos.';
  const other = 'Los domingos sí abrimos; dime a qué hora te acomoda y lo revisamos.';
  h.setScript(() => ({ messages: [answer] }));
  await say('hola, buenas tardes', phone);
  const replies = [answer, other];
  h.setScript(() => ({ messages: [replies.shift() ?? other] }));
  let before = decisions();
  await say('¿y los domingos abren?', phone);
  assert.equal(decisions() - before, 2, 'la respuesta repetida pide otra');
  assert.equal(textsTo(phone).at(-1), other);
  // El cliente repite exactamente su pregunta: no hace falta reformular.
  h.setScript(() => ({ messages: [other] }));
  before = decisions();
  await say('¿y los domingos abren?', phone);
  assert.equal(decisions() - before, 1);
  assert.equal(textsTo(phone).at(-1), other);
});

t('fuera de horario: la IA sabe que está cerrado, cuándo abre y que no debe prometer una respuesta inmediata', async () => {
  const { addDays, localParts } = await import('../src/automation/time.js');
  const tz = 'America/Bogota';
  const in2 = addDays(localParts(new Date(), tz).date, 2);
  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${in2}T12:00:00Z`).getUTCDay()];
  const onlyThatDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, d === dayKey ? [['10:00', '18:00']] : []]));
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: onlyThatDay, timezone: tz });
  h.reset();
  h.setScript(() => ({ messages: ['Con gusto, dejo tus datos para el equipo.'] }));
  await say('¿me atienden ahora?', '5215530000011');
  const prompt = String(h.calls.at(-1)!.messages[0].content);
  assert.match(prompt, /está CERRADO/);
  assert.match(prompt, /a partir del .* a las 10:00/);
  assert.match(prompt, /No prometas una respuesta inmediata/);
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: ALL_DAY, timezone: tz });
});

t('reglas generales: la IA las recibe en cada turno', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Hola'] }));
  await say('hola', '5215530000010');
  const prompt = String(h.calls.at(-1)!.messages[0].content);
  assert.match(prompt, /# Reglas generales/);
  assert.match(prompt, /idioma en que te escribe el cliente/);
  assert.match(prompt, /Nunca confirmes que recibiste un pago/);
  assert.match(prompt, /números de tarjeta, CVV/);
  assert.match(prompt, /cualquier palabra/);
  assert.match(prompt, /emergencia/);
});

t('emergencia con una persona atendiendo: el bot no contesta, pero el equipo recibe la alerta', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  const phone = '5215530000012';
  await say('hola', phone);
  const conv = await convOf(phone);
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/takeover`)).statusCode, 200);
  const before = textsTo(phone).length;
  await say('me quiero morir', phone);
  assert.equal(textsTo(phone).length, before, 'el asistente no habla cuando una persona atiende');
  assert.ok((await alertsOf('safety')).some((a) => a.body.includes('me quiero morir')), 'el equipo se entera igual');
});

t('detección: los falsos positivos comunes no escalan; las señales claras sí', async () => {
  const { detectRisk, isAutomatedMessage, repeatedCustomerText, maskSensitive, luhnValid } = await import('../src/engine/safety.js');
  // Modismos y preguntas que no son una emergencia
  for (const idiom of ['me quiero morir de la risa con ese chiste', 'me quiero morir de vergüenza', 'no quiero vivir en esta zona, ¿tienen departamentos?', 'me va a matar mi mamá si llego tarde', 'me da un infarto ver el precio', '¿tienen servicio de emergencia médica?', 'me duele la muela, ¿tienen urgencias?', 'I could kill myself laughing', 'I want to die laughing at this']) {
    assert.equal(detectRisk(idiom), null, idiom);
  }
  // Señales claras
  assert.equal(detectRisk('ya no quiero vivir')?.kind, 'selfharm');
  assert.equal(detectRisk('quiero morirme')?.kind, 'selfharm');
  assert.equal(detectRisk('no quiero seguir viviendo')?.kind, 'selfharm');
  assert.equal(detectRisk('me quieren matar')?.kind, 'danger');
  assert.equal(detectRisk('creo que tengo un infarto')?.kind, 'danger');
  assert.equal(detectRisk('estoy en una emergencia')?.kind, 'danger');
  assert.equal(detectRisk("I can't breathe")?.lang, 'en');
  assert.equal(detectRisk('I want to die')?.kind, 'selfharm');
  assert.equal(detectRisk("I think I'm having a heart attack")?.kind, 'danger');
  assert.equal(isAutomatedMessage('Estoy fuera de la oficina, ¿me llamas?'), false, 'una pregunta de una persona no es automática');
  assert.equal(isAutomatedMessage('Mensaje automático: respondemos el lunes'), true);
  assert.equal(isAutomatedMessage('Estoy fuera de la oficina y te mando los datos luego'), false, 'una persona que avisa de su ausencia sí merece respuesta');
  assert.equal(repeatedCustomerText(['ok', 'ok', 'ok']), null, 'un "ok" repetido es normal');
  assert.notEqual(repeatedCustomerText(['Gracias por escribir, te atenderemos', 'Hola', 'Gracias por escribir, te atenderemos', 'Gracias por escribir, te atenderemos']), null);
  assert.ok(luhnValid('4111111111111111'));
  assert.equal(maskSensitive('Mi tarjeta 4111 1111 1111 1111 y cvv 123'), 'Mi tarjeta •••• 1111 y cvv ***');
  assert.equal(maskSensitive('Mi número es 5512345678, gracias'), 'Mi número es 5512345678, gracias');
  assert.equal(maskSensitive('Mi WhatsApp es 5215520000000 y el de casa 5512345678'), 'Mi WhatsApp es 5215520000000 y el de casa 5512345678', 'un número telefónico de 13 dígitos pasa Luhn a veces y no es una tarjeta');
  assert.equal(maskSensitive('Referencia 4111 1111 1111 1112'), 'Referencia 4111 1111 1111 1112', 'un número que no pasa la verificación no se toca');
});

t('validador: no repite respuestas y no guarda ni repite datos sensibles', async () => {
  const { validateDecision } = await import('../src/engine/validator.js');
  const { hydrateChatbot } = await import('../src/types.js');
  const bot = hydrateChatbot({ id: 'b', account_id: 'a', name: 'X', active: true, personality: {}, rules: {}, data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date() } as any);
  const base = { bot, images: [], sentImageIds: [], groundingSources: [], customerText: '¿y los domingos abren?' };
  const reply = (messages: string[], extra: Record<string, unknown> = {}) => ({ action: 'reply', messages, save_data: [], image_ids: [], remember: [], handoff_reason: '', info_not_found: false, intents: [], ...extra });
  const answer = 'Con gusto te ayudo con eso, dime qué necesitas exactamente y lo vemos.';
  assert.ok(validateDecision({ ...base, raw: reply([answer]), recentBotTexts: [answer], customerRepeats: false, final: false }).retryable.length > 0);
  const last = validateDecision({ ...base, raw: reply([answer]), recentBotTexts: [answer], customerRepeats: false, final: true });
  assert.deepEqual(last.retryable, []);
  assert.deepEqual(last.plan.messages, [answer], 'en el último intento se acepta');
  assert.deepEqual(validateDecision({ ...base, raw: reply([answer]), recentBotTexts: [answer], customerRepeats: true, final: false }).retryable, []);

  const card = validateDecision({ ...base, customerText: 'mi tarjeta es 4111 1111 1111 1111', raw: reply(['Anoté tu tarjeta 4111 1111 1111 1111.'], { save_data: [{ field: 'tarjeta', value: '4111 1111 1111 1111' }] }), final: true });
  assert.equal(card.plan.saveData.tarjeta, undefined, 'no se guarda como dato del cliente');
  assert.ok(card.plan.messages.every((m) => !/4111/.test(m)), 'ni se repite en el mensaje');
  assert.ok(card.fixes.some((f) => /sensible/.test(f)));

  const shortQuestion = validateDecision({ ...base, customerText: '¿Sí?', raw: reply([], { action: 'no_reply' }), final: false });
  assert.deepEqual(shortQuestion.retryable, [], 'un "¿Sí?" no obliga a responder ni pasa a una persona');
});
