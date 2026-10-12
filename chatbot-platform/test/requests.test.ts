/**
 * Solicitudes: el cliente puede volver a pedir lo mismo (otra reserva, el mismo problema, la misma pregunta) y se le
 * atiende de nuevo. Por tiempo sin actividad o porque la IA lo detecta, con un seguro para no repetir en poco tiempo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep, store } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const Q_NAME = '¿Cuál es tu nombre?';
const Q_DATE = '¿Qué día llegas?';
const Q_ROOM = '¿Qué habitación prefieres?';
const GOAL_PHONE = '5215599991111';
const QUESTIONS = [
  { key: 'nombre', label: 'Nombre', type: 'name', required: true, question: Q_NAME },
  { key: 'fecha_llegada', label: 'Fecha de llegada', type: 'text', required: true, question: Q_DATE },
  // Se conserva entre solicitudes aunque sea una opción: el negocio lo marcó así.
  { key: 'habitacion', label: 'Habitación', type: 'option', options: ['Doble', 'Suite'], required: true, question: Q_ROOM, per_request: false },
];

const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(400);
  await h.idle();
};
const texts = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text);
const detail = async (phone: string) => (await h.authed('GET', `/api/conversations/${(await h.conversationFor(phone)).id}`)).json();
/** Mueve hacia atrás la conversación completa: como si el cliente escribiera de nuevo después de ese tiempo. */
const ago = async (phone: string, hours: number) => {
  const conv = await h.conversationFor(phone);
  await pool.query(`UPDATE messages SET created_at = created_at - make_interval(hours => $2) WHERE conversation_id = $1`, [conv.id, hours]);
  await pool.query(`UPDATE conversations SET flow_started_at = flow_started_at - make_interval(hours => $2) WHERE id = $1`, [conv.id, hours]);
};
const setHours = (hours: number) => h.authed('PUT', `/api/chatbots/${h.botId}`, { flow: { goal: 'Que el cliente solicite su reserva', new_request_after_hours: hours } });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ flow: { goal: 'Que el cliente solicite su reserva' }, data_fields: QUESTIONS });
  // Aviso al equipo al cumplirse el objetivo, una vez por conversación (por solicitud).
  const r = await h.authed('POST', '/api/automations', {
    account_id: h.accountId, chatbot_id: h.botId, name: 'Reserva', active: true, trigger: { type: 'goal_completed' }, conditions: [],
    actions: [{ type: 'alert_team', message: 'Reserva de {{cliente}}', roles: [], phones: [GOAL_PHONE] }], once_per_conversation: true,
  });
  assert.equal(r.statusCode, 200, r.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('por omisión se repite todo menos nombre, correo y teléfono, y el negocio puede cambiarlo por pregunta', async () => {
  const { repeatsEachRequest } = await import('../src/engine/questions.js');
  assert.equal(repeatsEachRequest({ type: 'text' }), true);
  assert.equal(repeatsEachRequest({ type: 'option' }), true);
  for (const type of ['name', 'email', 'phone'] as const) assert.equal(repeatsEachRequest({ type }), false);
  assert.equal(repeatsEachRequest({ type: 'option', per_request: false }), false);
  assert.equal(repeatsEachRequest({ type: 'name', per_request: true }), true);
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.equal(bot.flow.new_request_after_hours, 24, 'por omisión, 24 horas');
  assert.equal(bot.data_fields.find((f: any) => f.key === 'habitacion').per_request, false);
});

t('vuelve después de 24 h: solicitud nueva, se repiten las preguntas que tocan y el objetivo y su aviso cuentan de nuevo', async () => {
  const P = '5215510010001';
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola! Con gusto.'], save_data: [{ field: 'nombre', value: 'Ana López' }] }));
  await say('Hola, soy Ana López', P);
  h.setScript(() => ({ messages: ['Perfecto.'], save_data: [{ field: 'fecha_llegada', value: '20 de noviembre' }] }));
  await say('Llego el 20 de noviembre', P);
  h.setScript(() => ({ messages: ['Listo, Ana: quedó tu solicitud.'], save_data: [{ field: 'habitacion', value: 'Doble' }], goal_completed: true }));
  await say('Doble', P);
  let d = await detail(P);
  assert.ok(d.conversation.goal_completed_at, 'objetivo cumplido en la primera solicitud');
  const firstAlerts = h.sent.filter((s) => s.to === GOAL_PHONE).length;
  assert.equal(firstAlerts, 1);

  // Un día después vuelve a reservar.
  await ago(P, 25);
  h.reset();
  let prompt = '';
  h.setScript((req) => { prompt = String(req.messages[0].content); return { messages: ['¡Hola de nuevo, Ana! Claro que sí.'] }; });
  await say('Hola, quiero reservar otra vez', P);
  assert.match(prompt, /Solicitud actual: la 2\.ª de este cliente/);
  assert.match(prompt, /Solicitud 1\.ª \([^)]*\): cumplió el objetivo; sus respuestas: fecha_llegada: 20 de noviembre/);
  assert.match(prompt, /SIGUIENTE PREGUNTA[^\n]*«¿Qué día llegas\?»/, 'la fecha se vuelve a preguntar');
  assert.doesNotMatch(prompt, /El objetivo YA se cumplió/);
  assert.deepEqual(texts(P), ['¡Hola de nuevo, Ana! Claro que sí.', Q_DATE]);
  d = await detail(P);
  assert.equal(d.contact.data.nombre, 'Ana López', 'el nombre se conserva');
  assert.equal(d.contact.data.habitacion, 'Doble', 'lo que el negocio marcó como «no se repite» se conserva');
  assert.equal(d.contact.data.fecha_llegada, undefined, 'la fecha de la reserva anterior ya no cuenta');

  // La fecha de la reserva pasada no contesta la pregunta de nuevo: si la IA la repite sin que el cliente la diga, no se guarda.
  h.reset();
  h.setScript(() => ({ messages: ['Va.'], save_data: [{ field: 'fecha_llegada', value: '20 de noviembre' }] }));
  await say('Sí, para dos personas', P);
  assert.equal((await detail(P)).contact.data.fecha_llegada, undefined);

  h.setScript(() => ({ messages: ['Listo, Ana: quedó tu nueva solicitud.'], save_data: [{ field: 'fecha_llegada', value: '3 de enero' }], goal_completed: true }));
  await say('Llego el 3 de enero', P);
  d = await detail(P);
  assert.ok(d.conversation.goal_completed_at, 'el objetivo se cumple otra vez');
  assert.equal(firstAlerts + h.sent.filter((s) => s.to === GOAL_PHONE).length, 2, 'el aviso «una vez» vuelve a salir en la solicitud nueva');
  assert.deepEqual(d.requests.map((r: any) => [r.number, r.reason, !!r.ended_at, !!r.goal_completed_at]), [[1, 'inicio', true, true], [2, 'tiempo', false, false]]);
  assert.deepEqual(d.requests[0].data, { fecha_llegada: '20 de noviembre' });
});

t('dentro de las 24 h sigue la misma solicitud; con 0 horas solo cuenta lo que detecte la IA', async () => {
  const P = '5215510010002';
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'], save_data: [{ field: 'nombre', value: 'Luis' }] }));
  await say('Hola, soy Luis', P);
  await ago(P, 5);
  await say('¿Sigues ahí?', P);
  assert.deepEqual((await detail(P)).requests, [], '5 horas después sigue la misma solicitud');

  assert.equal((await setHours(0)).statusCode, 200);
  await ago(P, 24 * 30);
  await say('Hola otra vez', P);
  assert.deepEqual((await detail(P)).requests, [], 'con 0 horas el tiempo no abre solicitudes');
  assert.equal((await setHours(24)).statusCode, 200);
});

t('la IA detecta que pide lo mismo otra vez: con el objetivo cumplido se abre una solicitud y se responde con ella', async () => {
  const P = '5215510010003';
  h.reset();
  h.setScript(() => ({ messages: ['Listo, Marta: quedó tu solicitud.'], save_data: [{ field: 'nombre', value: 'Marta' }, { field: 'fecha_llegada', value: '5 de diciembre' }, { field: 'habitacion', value: 'Suite' }], goal_completed: true }));
  await say('Soy Marta, llego el 5 de diciembre, suite', P);
  assert.ok((await detail(P)).conversation.goal_completed_at);

  h.reset();
  const prompts: string[] = [];
  h.setScript((req) => {
    prompts.push(String(req.messages[0].content));
    return prompts.length === 1 ? { messages: ['Claro.'], new_request: true } : { messages: ['¡Con gusto hacemos otra!'], new_request: true };
  });
  await say('Quiero hacer otra reserva para mi hermana', P);
  // La primera propuesta abre la solicitud; después se vuelve a pensar la respuesta ya con ella (y una marca nueva no abre otra).
  assert.ok(prompts.length >= 2);
  assert.doesNotMatch(prompts[0], /Solicitud actual/);
  assert.ok(prompts.slice(1).every((p) => /Solicitud actual: la 2\.ª/.test(p)));
  assert.deepEqual(texts(P), ['¡Con gusto hacemos otra!', Q_DATE], 'responde con la solicitud nueva y pregunta la fecha');
  const d = await detail(P);
  assert.deepEqual(d.requests.map((r: any) => [r.number, r.reason]), [[1, 'inicio'], [2, 'contenido']]);
  assert.equal(d.conversation.goal_completed_at, null);
});

t('seguro: si la solicitud empezó hace poco y no cumplió su objetivo, pedir lo mismo no abre otra', async () => {
  const P = '5215510010004';
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola! ¿Cuál es tu nombre?'] }));
  await say('Hola, quiero reservar', P);
  h.setScript(() => ({ messages: ['Claro, te ayudo con la reserva.'], new_request: true }));
  await say('Quiero reservar', P);
  const d = await detail(P);
  assert.deepEqual(d.requests, [], 'no se abre una solicitud nueva');
  const logs = (await h.authed('GET', `/api/logs?conversation_id=${d.conversation.id}`)).json();
  assert.ok(logs.some((l: any) => /se sigue la misma/.test(l.message)));
});

t('reabrir una conversación cerrada también es una solicitud nueva', async () => {
  const P = '5215510010005';
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'], save_data: [{ field: 'nombre', value: 'Rosa' }, { field: 'fecha_llegada', value: '1 de marzo' }] }));
  await say('Soy Rosa, llego el 1 de marzo', P);
  const conv = await h.conversationFor(P);
  await store.setConversationStatus(conv.id, 'closed', 'prueba');
  h.setScript(() => ({ messages: ['¡Hola de nuevo, Rosa!'] }));
  await say('Hola, otra vez yo', P);
  const d = await detail(P);
  assert.deepEqual(d.requests.map((r: any) => [r.number, r.reason]), [[1, 'inicio'], [2, 'reapertura']]);
  assert.deepEqual(d.requests[0].data, { fecha_llegada: '1 de marzo' });
  assert.equal(d.contact.data.nombre, 'Rosa');
  assert.equal(d.contact.data.fecha_llegada, undefined);
});
