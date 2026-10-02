/** Flujos: recorrido de la conversación (etapas y objetivo) y flujos automáticos (secuencias y campañas). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
const CLOSED = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [] as string[][]]));

const FLOW = {
  goal: 'Que el cliente deje fechas y correo para que el equipo confirme la reservación',
  steps: [{ title: 'Resolver dudas' }, { title: 'Pedir fechas' }, { title: 'Pedir correo' }],
  on_goal_completed: 'Agradece y avisa que el equipo confirmará',
  on_goal_action: 'handoff',
};
const conv = async (phone: string) => (await h.authed('GET', `/api/conversations?search=${phone}`)).json()[0];
const detail = async (id: string) => (await h.authed('GET', `/api/conversations/${id}`)).json();
const lastSystemPrompt = () => String(h.calls[h.calls.length - 1].messages[0].content);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({
    flow: FLOW,
    data_fields: [
      { key: 'fechas', label: 'Fechas', type: 'text', required: true },
      { key: 'correo', label: 'Correo', type: 'email', required: true },
    ],
  });
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: ALL_DAY, timezone: 'America/Bogota' });
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'equipo@hotel.mx', name: 'Equipo', password: 'clave-equipo-1', role: 'admin' });
  assert.equal(u.statusCode, 200, u.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('recorrido: la etapa avanza y la IA la recibe; el objetivo no se cumple si faltan datos importantes', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola! ¿Para qué fechas sería?'], flow_step: 2, goal_completed: true }));
  await h.webhook('hola, quiero reservar', { phone: '5215520000001' });
  await waitFor(() => h.sent.length === 1);
  await h.idle();
  const c = await conv('5215520000001');
  const d = await detail(c.id);
  assert.equal(d.conversation.flow_step, 2);
  assert.equal(d.conversation.goal_completed_at, null, 'faltan fechas y correo: el objetivo no cuenta');
  assert.equal(d.conversation.status, 'bot');
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1`, [c.id])).rows.map((r) => r.message).join('\n');
  assert.match(logs, /faltan datos importantes \(Fechas, Correo\)/);

  // En el siguiente turno la IA sabe en qué etapa va, qué falta, el horario y la zona horaria de la cuenta.
  h.setScript(() => ({ messages: ['Perfecto, ¿me compartes tu correo?'], flow_step: 3, save_data: [{ field: 'fechas', value: '10 al 12 de octubre' }] }));
  await h.webhook('del 10 al 12 de octubre', { phone: '5215520000001' });
  await waitFor(() => h.sent.length === 2);
  const prompt = lastSystemPrompt();
  assert.match(prompt, /Etapa actual: 2\. Pedir fechas/);
  assert.match(prompt, /Datos importantes que faltan para cumplir el objetivo: Fechas, Correo/);
  assert.match(prompt, /# Horario de atención del negocio\nLunes: 00:00 a 23:59/);
  assert.match(prompt, /En este momento el negocio está ABIERTO/);
  assert.match(prompt, /\(America\/Bogota\)/, 'la hora sale de "Horario y ajustes", no del chatbot');
  assert.match(prompt, /pasará la conversación a una persona/);
  await h.idle();
});

t('recorrido: al cumplir el objetivo (con los datos) se pasa a una persona una sola vez, sin mensaje extra', async () => {
  h.reset();
  h.setScript(() => ({
    messages: ['¡Gracias! Con esto el equipo te confirma la reservación en breve.'],
    flow_step: 3,
    goal_completed: true,
    save_data: [{ field: 'correo', value: 'ana@correo.mx' }],
  }));
  await h.webhook('ana@correo.mx', { phone: '5215520000001' });
  await waitFor(async () => (await detail((await conv('5215520000001')).id)).conversation.status === 'human');
  await h.idle();
  const c = await conv('5215520000001');
  const d = await detail(c.id);
  assert.ok(d.conversation.goal_completed_at, 'objetivo cumplido');
  assert.equal(d.conversation.handoff_reason, 'Se cumplió el objetivo de la conversación');
  assert.deepEqual(h.sent.map((m) => m.text), ['¡Gracias! Con esto el equipo te confirma la reservación en breve.'], 'no se manda además el mensaje de transferencia');
  // El equipo recibe la alerta de "esperando a una persona".
  const equipo = await h.loginAs('equipo@hotel.mx', 'clave-equipo-1');
  await waitFor(async () => (await equipo('GET', '/api/notifications')).json().items.some((n: any) => /esperando a una persona/.test(n.title)));

  // Con una persona atendiendo, el asistente ya no responde.
  h.reset();
  await h.webhook('¿ya quedó?', { phone: '5215520000001' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(h.calls.length, 0);
});

t('recorrido: "avisar al equipo", disparador de reglas y reinicio al reabrir', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { flow: { on_goal_action: 'notify' } });
  const rule = await h.authed('POST', '/api/automations', {
    account_id: h.accountId,
    name: 'Objetivo → etiqueta',
    trigger: { type: 'goal_completed' },
    actions: [{ type: 'add_tag', tag: 'reservó' }],
  });
  assert.equal(rule.statusCode, 200, rule.body);
  h.reset();
  h.setScript(() => ({
    messages: ['¡Listo! El equipo te confirma pronto.'],
    flow_step: 3,
    goal_completed: true,
    save_data: [{ field: 'fechas', value: '1 al 3 de noviembre' }, { field: 'correo', value: 'leo@correo.mx' }],
  }));
  await h.webhook('1 al 3 de nov, leo@correo.mx', { phone: '5215520000002' });
  await waitFor(() => h.sent.length === 1);
  const c = await conv('5215520000002');
  await waitFor(async () => (await detail(c.id)).contact.tags.includes('reservó'));
  let d = await detail(c.id);
  assert.equal(d.conversation.status, 'bot', '"avisar" no transfiere');
  const equipo = await h.loginAs('equipo@hotel.mx', 'clave-equipo-1');
  assert.ok((await equipo('GET', '/api/notifications')).json().items.some((n: any) => n.title === '🎯 Objetivo cumplido'));

  // Un segundo "cumplido" en la misma conversación no repite la acción.
  await h.idle();
  const before = (await equipo('GET', '/api/notifications')).json().items.filter((n: any) => n.title === '🎯 Objetivo cumplido').length;
  h.setScript(() => ({ messages: ['Con gusto.'], flow_step: 3, goal_completed: true }));
  await h.webhook('gracias!', { phone: '5215520000002' });
  await waitFor(() => h.sent.length === 2);
  await h.idle();
  assert.equal((await equipo('GET', '/api/notifications')).json().items.filter((n: any) => n.title === '🎯 Objetivo cumplido').length, before);
  assert.match(lastSystemPrompt(), /El objetivo YA se cumplió/);

  // Se cierra y el cliente vuelve otro día: el recorrido empieza de nuevo.
  await h.authed('POST', `/api/conversations/${c.id}/close`);
  h.setScript(() => ({ messages: ['¡Hola de nuevo!'], flow_step: 1 }));
  await h.webhook('hola, otra reservación', { phone: '5215520000002' });
  await waitFor(() => h.sent.length === 3);
  await h.idle();
  d = await detail(c.id);
  assert.equal(d.conversation.goal_completed_at, null);
  assert.equal(d.conversation.flow_step, 1);
});

t('validación del recorrido: etapa fuera de rango, objetivo sin recorrido y sin responder', async () => {
  const { validateDecision } = await import('../src/engine/validator.js');
  const { hydrateChatbot } = await import('../src/types.js');
  const mk = (flow: Record<string, unknown>) => hydrateChatbot({ id: 'b', account_id: 'a', name: 'X', active: true, personality: {}, rules: {}, data_fields: [], flow, ai: {}, created_at: new Date(), updated_at: new Date() } as any);
  const run = (bot: any, d: Record<string, unknown>) =>
    validateDecision({ raw: { thinking: '', action: 'reply', messages: ['ok'], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, intents: [], ...d }, bot, images: [], sentImageIds: [], groundingSources: [], customerText: 'x' }).plan;
  assert.equal(run(mk(FLOW), { flow_step: 9 }).flowStep, 3);
  assert.equal(run(mk(FLOW), { flow_step: -2 }).flowStep, 0);
  assert.equal(run(mk({}), { flow_step: 2, goal_completed: true }).flowStep, 0);
  assert.equal(run(mk({}), { goal_completed: true }).goalCompleted, false, 'sin objetivo configurado no hay nada que cumplir');
  assert.equal(run(mk(FLOW), { goal_completed: true }).goalCompleted, true);
  assert.equal(run(mk(FLOW), { action: 'no_reply', messages: [], goal_completed: true }).goalCompleted, false);
});

t('campañas: solo en horario de atención y nunca interrumpen a una persona', async () => {
  // Hoy y mañana cerrado; abre pasado mañana a las 10:00 (en la zona de la cuenta).
  const { localParts, addDays, zonedToUtc } = await import('../src/automation/time.js');
  const tz = 'America/Bogota';
  const in2 = addDays(localParts(new Date(), tz).date, 2);
  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${in2}T12:00:00Z`).getUTCDay()];
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: { ...CLOSED, [dayKey]: [['10:00', '18:00']] } });

  const mk = async (body: Record<string, unknown>) => {
    const r = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Promo', message: 'Promo de temporada', ...body });
    assert.equal(r.statusCode, 200, r.body);
    const l = await h.authed('POST', `/api/campaigns/${r.json().id}/launch`);
    assert.equal(l.statusCode, 200, l.body);
    return r.json().id as string;
  };
  const jobsOf = async (id: string) => (await pool.query(`SELECT run_at FROM jobs WHERE type = 'campaign_send' AND payload->>'campaign_id' = $1 ORDER BY run_at`, [id])).rows;

  const inHours = await mk({});
  const jobs = await jobsOf(inHours);
  assert.ok(jobs.length >= 2);
  assert.equal(new Date(jobs[0].run_at).toISOString(), zonedToUtc(in2, '10:00', tz).toISOString(), 'el primer envío espera a la apertura');
  assert.ok(new Date(jobs[1].run_at).getTime() > new Date(jobs[0].run_at).getTime(), 'y conserva el ritmo');

  const anyTime = await mk({ business_hours_only: false });
  assert.ok(new Date((await jobsOf(anyTime))[0].run_at).getTime() < Date.now() + 5000, 'sin la opción, sale de inmediato');
  await h.authed('POST', `/api/campaigns/${inHours}/cancel`);

  // La conversación del primer cliente sigue con una persona: se omite.
  await h.fastForward();
  const rec = (await h.authed('GET', `/api/campaigns/${anyTime}/recipients`)).json();
  const human = rec.find((r: any) => r.status === 'skipped');
  assert.ok(human, JSON.stringify(rec));
  assert.match(human.reason, /una persona está atendiendo/);
  assert.ok(rec.some((r: any) => r.status === 'sent'));
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: ALL_DAY });
});

t('secuencias: con la cuenta en pausa esperan (no se pierden) y siguen al reactivarla', async () => {
  const seq = (await h.authed('POST', '/api/sequences', {
    account_id: h.accountId,
    name: 'Seguimiento',
    business_hours_only: false,
    stop_on_reply: false,
    steps: [{ delay_value: 0, delay_unit: 'minutes', text: 'Seguimiento 1' }],
  })).json();
  const c = await conv('5215520000002');
  assert.equal((await h.authed('POST', `/api/conversations/${c.id}/sequences`, { sequence_id: seq.id })).statusCode, 200);
  await pool.query(`UPDATE accounts SET status = 'paused' WHERE id = $1`, [h.accountId]);
  h.reset();
  await h.service.scheduler.runDue();
  assert.equal(h.sent.length, 0);
  let en = (await h.authed('GET', `/api/conversations/${c.id}/automation`)).json().enrollments.find((e: any) => e.sequence_id === seq.id);
  assert.equal(en.status, 'active', 'sigue inscrito');
  assert.ok(new Date(en.next_run_at).getTime() > Date.now() + 50 * 60_000, 'reintenta en una hora');

  await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [h.accountId]);
  await h.fastForward();
  assert.deepEqual(h.sent.map((m) => m.text), ['Seguimiento 1']);
  en = (await h.authed('GET', `/api/conversations/${c.id}/automation`)).json().enrollments.find((e: any) => e.sequence_id === seq.id);
  assert.equal(en.status, 'completed');
});

t('si la IA no responde ni al reintentar, el equipo recibe un aviso (el cliente no queda en el olvido)', async () => {
  const { ConversationQueue } = await import('../src/engine/queue.js');
  // La cola: falla, reintenta una vez y entonces avisa.
  const gaveUp: string[] = [];
  let runs = 0;
  const q = new ConversationQueue(async () => { runs++; return { status: 'error' }; }, 2, 50, (id) => gaveUp.push(id));
  q.schedule('conv-x', 0);
  await waitFor(() => gaveUp.length === 1);
  assert.equal(runs, 2, 'un intento y un reintento');

  // El servicio: aviso en el panel al equipo de la cuenta, con enlace a la conversación.
  const c = (await h.authed('GET', `/api/conversations?search=5215520000002`)).json()[0];
  await pool.query(`UPDATE conversations SET status = 'bot' WHERE id = $1`, [c.id]);
  await (h.service as any).aiUnavailable(c.id);
  const equipo = await h.loginAs('equipo@hotel.mx', 'clave-equipo-1');
  const n = (await equipo('GET', '/api/notifications')).json().items.find((x: any) => x.title === '⚠️ Un cliente espera respuesta');
  assert.ok(n, 'aviso al equipo');
  assert.equal(n.link, `#/conversation/${c.id}`);
});
