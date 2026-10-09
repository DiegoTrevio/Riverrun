/** Activadores y desactivadores del asistente, reglas que lo pausan/activan y los probadores del panel. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// El arnés va primero: define las variables de entorno antes de que se cargue la configuración.
import { createHarness, dbAvailable, pool, sleep, waitFor } from './harness.js';
const { agentActive, gate, offAfterReply } = await import('../src/engine/activation.js');
const { RulesSchema } = await import('../src/types.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const setActivation = async (activation: Record<string, unknown>) => {
  const r = await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { activation: RulesSchema.parse({ activation }).activation } });
  assert.equal(r.statusCode, 200, r.body);
};
const detail = async (phone: string) => (await h.authed('GET', `/api/conversations/${(await h.conversationFor(phone)).id}`)).json();
const logs = async (phone: string) => (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1 ORDER BY id`, [(await h.conversationFor(phone)).id])).rows.map((r) => r.message).join('\n');
/** Envía un mensaje y espera a que todo termine (respondiera o no). */
const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(350); // más que la espera de agrupación (0.2 s)
  // En un servidor lento el temporizador de agrupación puede tardar más: se espera a que no queden mensajes sin procesar.
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.phone = $1 AND m.direction = 'in' AND NOT m.processed`, [phone])).rows[0].n === 0, 8000);
  await h.idle();
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({
    flow: { goal: 'Que el cliente deje sus fechas', on_goal_action: 'none' },
    data_fields: [
      { key: 'fechas', label: 'Fechas', type: 'text' },
      { key: 'correo', label: 'Correo', type: 'email' },
    ],
  });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

test('gate: modo palabras, pausa, reactivación y vencimiento (función pura)', () => {
  const a = RulesSchema.parse({ activation: { mode: 'keywords', on_keywords: ['quiero info'], off_keywords: ['ya no'] } }).activation;
  const fresh = { agent_off_at: null, agent_off_until: null, agent_off_reason: '', agent_on_at: null };
  assert.deepEqual(gate(a, fresh, 'hola'), { reply: false, reason: 'esperando una palabra de activación' });
  assert.equal(gate(a, fresh, 'Hola, QUIERO INFORMACIÓN').reply, false, 'frase completa: "quiero info" no es "quiero información"');
  assert.equal(gate(a, fresh, 'hola, quiero info!').change, 'on');
  const on = { ...fresh, agent_on_at: new Date() };
  assert.equal(gate(a, on, 'precio?').reply, true);
  assert.equal(gate(a, on, 'Ya no, gracias').change, 'off');
  const paused = { ...on, agent_off_at: new Date(), agent_off_reason: 'x' };
  assert.equal(gate(a, paused, 'precio?').reply, false);
  assert.equal(gate(a, paused, 'quiero info').change, 'on');
  const expired = { ...paused, agent_off_until: new Date(Date.now() - 1000) };
  assert.equal(agentActive({ rules: { activation: a } } as any, expired), true);
  assert.deepEqual(gate(a, expired, 'precio?'), { reply: true, change: 'on', reason: 'terminó el tiempo de pausa' });

  const f = RulesSchema.parse({ activation: { off_when_fields: ['fechas', 'correo'] } }).activation;
  const before = { name: '', data: { fechas: '10 oct' } };
  assert.equal(offAfterReply(f, { goalReached: false, booked: false, before, after: { name: '', data: { fechas: '10 oct', correo: 'a@b.mx' } } }), 'el cliente ya dio: fechas, correo');
  assert.equal(offAfterReply(f, { goalReached: false, booked: false, before: { name: '', data: { fechas: '1', correo: 'a@b.mx' } }, after: { name: '', data: { fechas: '2', correo: 'a@b.mx' } } }), null, 'solo cuenta el turno en que se completan');
});

t('modo "solo con palabras": no responde hasta la palabra de activación; después responde normal', async () => {
  await setActivation({ mode: 'keywords', on_keywords: ['quiero info'] });
  h.reset();
  // Respuestas distintas según la pregunta: repetir el saludo a otra pregunta ya no está permitido.
  h.setScript((req) => ({ messages: [/alberca/.test(String(req.messages.at(-1)?.content)) ? 'Con gusto te cuento; ¿para qué fecha lo necesitas?' : '¡Hola! Con gusto te ayudo.'] }));
  const phone = '5215530000001';
  await say('hola', phone);
  assert.equal(h.calls.length, 0, 'sin palabra de activación no se llama a la IA');
  assert.equal(h.sent.length, 0);
  assert.equal((await detail(phone)).agent.state, 'waiting');
  await say('Hola, quiero info de las habitaciones', phone);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sent.length, 1);
  await say('¿y tienen alberca?', phone);
  assert.equal(h.calls.length, 2, 'ya activado, responde sin la palabra');
  assert.match(await logs(phone), /Asistente activado: el cliente escribió "quiero info"/);
  // "Reactivar" desde la conversación también lo activa.
  const other = '5215530000002';
  await say('hola', other);
  const c = await h.conversationFor(other);
  assert.equal((await h.authed('POST', `/api/conversations/${c.id}/release`)).statusCode, 200);
  assert.equal((await detail(other)).agent.on, true);
});

t('palabra de apagado: envía el mensaje configurado, no llama a la IA y queda en pausa hasta reactivarlo', async () => {
  await setActivation({ off_keywords: ['ya no'], on_keywords: ['menu'], off_message: 'Entendido, ya no te escribo. Escribe MENU si me necesitas.' });
  h.reset();
  h.setScript(() => ({ messages: ['Claro, te ayudo.'] }));
  const phone = '5215530000003';
  await say('hola', phone);
  assert.equal(h.calls.length, 1);
  await say('Ya no, gracias', phone);
  assert.equal(h.calls.length, 1, 'el apagado no consulta a la IA');
  assert.equal(h.sent.at(-1)!.text, 'Entendido, ya no te escribo. Escribe MENU si me necesitas.');
  const d = await detail(phone);
  assert.equal(d.conversation.status, 'bot', 'no pasa a una persona: solo se pausa el asistente');
  assert.equal(d.agent.state, 'paused');
  assert.match(d.agent.reason, /el cliente escribió "ya no"/);
  await say('¿Y el precio?', phone);
  assert.equal(h.calls.length, 1, 'en pausa no responde');
  await say('MENU', phone);
  assert.equal(h.calls.length, 2, 'la palabra de activación lo reactiva');
});

t('al tener todos los datos elegidos: responde ese mensaje y después se pausa', async () => {
  await setActivation({ off_when_fields: ['fechas', 'correo'] });
  h.reset();
  const phone = '5215530000004';
  h.setScript(() => ({ messages: ['¿Me compartes tu correo?'], save_data: [{ field: 'fechas', value: '10 al 12 de octubre' }] }));
  await say('para el 10 al 12 de octubre', phone);
  assert.equal((await detail(phone)).agent.on, true, 'falta el correo');
  h.setScript(() => ({ messages: ['¡Gracias! Alguien del equipo te confirma.'], save_data: [{ field: 'correo', value: 'ana@correo.mx' }] }));
  await say('ana@correo.mx', phone);
  assert.equal(h.sent.at(-1)!.text, '¡Gracias! Alguien del equipo te confirma.', 'responde ese mensaje');
  const d = await detail(phone);
  assert.equal(d.agent.state, 'paused');
  assert.match(d.agent.reason, /el cliente ya dio: fechas, correo/);
  const calls = h.calls.length;
  await say('ok', phone);
  assert.equal(h.calls.length, calls);
});

t('al cumplir el objetivo con "pasar a una persona": queda en humano, sin mensaje extra', async () => {
  await setActivation({ off_on_goal: true, off_action: 'handoff' });
  h.reset();
  const phone = '5215530000005';
  h.setScript(() => ({ messages: ['Listo, anoté tus fechas.'], goal_completed: true, save_data: [{ field: 'fechas', value: 'del 3 al 5' }] }));
  await say('del 3 al 5 de noviembre', phone);
  const d = await detail(phone);
  assert.equal(d.conversation.status, 'human');
  assert.match(d.conversation.handoff_reason, /Asistente desactivado: se cumplió el objetivo/);
  assert.deepEqual(h.sent.filter((s) => s.kind === 'text').map((s) => s.text), ['Listo, anoté tus fechas.'], 'sin mensaje de transferencia extra');
});

t('pausa con tiempo: pasado el plazo vuelve a responder solo', async () => {
  await setActivation({ off_keywords: ['pausa'], resume_after_hours: 2 });
  h.reset();
  h.setScript(() => ({ messages: ['Aquí sigo.'] }));
  const phone = '5215530000006';
  await say('pausa', phone);
  const d = await detail(phone);
  assert.equal(d.agent.state, 'paused');
  assert.ok(d.agent.until, 'tiene fecha de reactivación');
  await say('hola', phone);
  assert.equal(h.calls.length, 0);
  await pool.query(`UPDATE conversations SET agent_off_until = now() - interval '1 second' WHERE id = $1`, [d.conversation.id]);
  await say('hola de nuevo', phone);
  assert.equal(h.calls.length, 1);
  assert.match(await logs(phone), /Asistente activado: terminó el tiempo de pausa/);
});

t('reglas: pausar y activar al asistente, condición "asistente en pausa" y disparador "se desactiva"', async () => {
  await setActivation({});
  const rule = async (body: Record<string, unknown>) => {
    const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, ...body });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  await rule({ name: 'Pausar', trigger: { type: 'message_received', keywords: ['pausar asistente'] }, actions: [{ type: 'pause_bot', reason: 'lo pidió el cliente' }] });
  await rule({ name: 'Reanudar', trigger: { type: 'message_received', keywords: ['reanudar'] }, actions: [{ type: 'resume_bot' }] });
  await rule({ name: 'Escribió en pausa', trigger: { type: 'message_received', match: 'any' }, conditions: [{ type: 'agent', state: 'off' }], actions: [{ type: 'add_tag', tag: 'escribio_en_pausa' }] });
  await rule({ name: 'Al pausarse', trigger: { type: 'agent_off' }, actions: [{ type: 'add_tag', tag: 'pausado' }] });
  h.reset();
  h.setScript(() => ({ messages: ['Hola de nuevo.'] }));
  const phone = '5215530000007';
  await say('pausar asistente', phone);
  assert.equal(h.calls.length, 0, 'la regla pausa antes de la IA');
  let d = await detail(phone);
  assert.equal(d.agent.state, 'paused');
  assert.equal(d.agent.reason, 'lo pidió el cliente');
  assert.ok(d.contact.tags.includes('pausado'), 'el disparador "se desactiva" corre');
  await say('hola?', phone);
  assert.equal(h.calls.length, 0);
  d = await detail(phone);
  assert.ok(d.contact.tags.includes('escribio_en_pausa'), 'la condición "asistente en pausa" se cumple');
  await say('reanudar', phone);
  assert.equal(h.calls.length, 1, 'la regla lo activa y responde ese mensaje');
  assert.equal((await detail(phone)).agent.on, true);
});

t('probador de palabras: dice qué reglas y activadores se dispararían, sin IA ni envíos', async () => {
  await setActivation({ mode: 'keywords', on_keywords: ['quiero info'], off_keywords: ['ya no'] });
  h.reset();
  const before = (await pool.query(`SELECT count(*)::int AS n FROM conversations`)).rows[0].n;
  const test = (body: Record<string, unknown>) => h.authed('POST', `/api/chatbots/${h.botId}/test-message`, body);

  let r = (await test({ text: 'hola' })).json();
  assert.equal(r.ai_replies, false);
  assert.match(r.why, /esperando una palabra de activación/);
  const pause = r.rules.find((x: any) => x.name === 'Pausar');
  assert.equal(pause.matched, false);
  assert.match(pause.reason, /no coincide con: pausar asistente/);

  r = (await test({ text: 'hola, quiero info' })).json();
  assert.equal(r.ai_replies, true);
  assert.ok(r.steps.some((s: any) => /Se activa: el cliente escribió "quiero info"/.test(s.detail)));

  r = (await test({ text: 'ya no', agent: 'on' })).json();
  assert.equal(r.ai_replies, false);
  assert.match(r.steps.find((s: any) => s.kind === 'agent').detail, /Se apaga: el cliente escribió "ya no" \(queda en pausa\)/);

  r = (await test({ text: 'pausar asistente', agent: 'on' })).json();
  assert.equal(r.rules.find((x: any) => x.name === 'Pausar').matched, true);
  assert.equal(r.why, 'Una regla pausa al asistente.');

  r = (await test({ text: 'hola', agent: 'paused' })).json();
  assert.equal(r.rules.find((x: any) => x.name === 'Escribió en pausa').matched, true);
  r = (await test({ text: 'hola', agent: 'on' })).json();
  assert.match(r.rules.find((x: any) => x.name === 'Escribió en pausa').reason, /no se cumple la condición: asistente en pausa/);

  r = (await test({ text: 'quiero hablar con un asesor', agent: 'on' })).json();
  assert.match(r.why, /Pasa con una persona/);
  r = (await test({ text: 'BAJA' })).json();
  assert.match(r.why, /se da de baja/);

  assert.equal(h.calls.length, 0, 'no se llamó a la IA');
  assert.equal(h.sent.length, 0, 'no se envió nada');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM conversations`)).rows[0].n, before, 'no crea conversaciones');
  assert.equal((await test({ text: '' })).statusCode, 400);
});

t('simulador: muestra qué se activó y el estado del asistente; se puede reactivar', async () => {
  await setActivation({ off_keywords: ['ya no'] });
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const play = async (text: string) => {
    const r = await h.authed('POST', `/api/chatbots/${h.botId}/playground`, { session: 'activ', text });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  let r = await play('hola');
  assert.equal(r.result.status, 'replied');
  assert.equal(r.agent.on, true);
  r = await play('pausar asistente');
  assert.equal(r.result.status, 'paused');
  assert.equal(r.agent.state, 'paused');
  assert.ok(r.events.some((e: any) => e.message === 'Regla ejecutada: "Pausar"'), JSON.stringify(r.events));
  assert.ok(r.events.some((e: any) => /Asistente en pausa: lo pidió el cliente/.test(e.message)));
  assert.equal((await h.authed('POST', `/api/conversations/${r.conversation.id}/release`)).statusCode, 200);
  r = await play('ya no');
  assert.equal(r.result.status, 'paused');
  assert.ok(r.events.some((e: any) => /Asistente en pausa: el cliente escribió "ya no"/.test(e.message)));
  r = await play('reanudar');
  assert.equal(r.result.status, 'replied');
});
