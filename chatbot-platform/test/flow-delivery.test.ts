/** Recorrido: todo lo que se marca (etapa, objetivo) se envía de verdad — fotos con reintento, reporte al equipo, reglas por etapa. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let equipo: Awaited<ReturnType<typeof h.loginAs>>;
const TEAM_PHONE = '5215588880000';
const BOT_NOTIFY = '5215577770000';
let phoneN = 0;
const newPhone = () => `52155${String(6000000 + ++phoneN)}`;

const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(350);
  await h.idle();
  await h.service.automator.settleAll();
};
const photosTo = (phone: string) => h.sent.filter((s) => s.kind === 'image' && s.to === phone).map((s) => s.image);
const detail = async (phone: string) => (await h.authed('GET', `/api/conversations/${(await h.conversationFor(phone)).id}`)).json();
const notices = async () => (await equipo('GET', '/api/notifications')).json().items as { title: string; body: string; kind: string }[];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({
    flow: { goal: 'Que el cliente deje fechas y correo', steps: [{ title: 'Saludo' }, { title: 'Pedir fechas' }, { title: 'Pedir correo' }], on_goal_action: 'notify' },
    data_fields: [{ key: 'fechas', label: 'Fechas', type: 'text', required: true }, { key: 'correo', label: 'Correo', type: 'email', required: true }],
  });
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'equipo@hotel.mx', name: 'Equipo', password: 'clave-equipo-1', role: 'admin', phone: TEAM_PHONE, notify_whatsapp: true });
  assert.equal(u.statusCode, 200, u.body);
  equipo = await h.loginAs('equipo@hotel.mx', 'clave-equipo-1');
  await h.uploadImage('mapa', 'Mapa', { mode: 'rules', flow_steps: [2] });
  await h.uploadImage('gracias', 'Gracias', { mode: 'rules', on_goal: true });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('si WhatsApp rechaza la foto de la etapa, se reintenta sola y llega una sola vez', async () => {
  h.reset();
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¿Para qué fechas?'], flow_step: 2 }));
  h.failNext.image = 1;
  await say('quiero reservar', phone);
  assert.deepEqual(photosTo(phone), [], 'la primera vez falló');
  await h.fastForward();
  assert.deepEqual(photosTo(phone), ['mapa'], 'el reintento la entrega');
  await h.fastForward();
  assert.deepEqual(photosTo(phone), ['mapa'], 'sin duplicados');
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1`, [(await h.conversationFor(phone)).id])).rows.map((r) => r.message).join('\n');
  assert.match(logs, /Foto enviada por regla \(pendiente\): mapa \(se llegó a la etapa 2\)/);
});

t('el límite de fotos por respuesta no hace perder las de la etapa: las que sobran salen enseguida', async () => {
  const imgs = ['m1', 'm2', 'm3'];
  for (const code of imgs) await h.uploadImage(code, code, { mode: 'rules', flow_steps: [3] });
  try {
    h.reset();
    const phone = newPhone();
    h.setScript(() => ({ messages: ['¿Y tu correo?'], flow_step: 3 }));
    await say('del 3 al 5', phone);
    assert.equal(photosTo(phone).length, 2, 'el límite por respuesta (2) se respeta');
    await h.fastForward();
    assert.deepEqual([...photosTo(phone)].sort(), imgs, 'la tercera llega después, sin repetir ninguna');
    await h.fastForward();
    assert.equal(photosTo(phone).length, 3);
  } finally {
    for (const code of imgs) await pool.query(`UPDATE images SET active = false WHERE code = $1`, [code]);
  }
});

t('si una persona toma la conversación, las fotos pendientes del asistente ya no salen', async () => {
  const imgs = ['n1', 'n2', 'n3'];
  for (const code of imgs) await h.uploadImage(code, code, { mode: 'rules', flow_steps: [3] });
  try {
    h.reset();
    const phone = newPhone();
    h.setScript(() => ({ messages: ['¿Y tu correo?'], flow_step: 3 }));
    await say('del 3 al 5', phone);
    const conv = await h.conversationFor(phone);
    assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/takeover`)).statusCode, 200);
    await h.fastForward();
    assert.equal(photosTo(phone).length, 2, 'la tercera no se manda: ahora atiende una persona');
  } finally {
    for (const code of imgs) await pool.query(`UPDATE images SET active = false WHERE code = $1`, [code]);
  }
});

t('conversación reabierta: el recorrido empieza de nuevo y las fotos de etapa y objetivo vuelven a salir', async () => {
  h.reset();
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¿Para qué fechas?'], flow_step: 2 }));
  await say('quiero reservar', phone);
  h.setScript(() => ({ messages: ['¡Listo!'], flow_step: 3, goal_completed: true, save_data: [{ field: 'fechas', value: '1 al 3 de mayo' }, { field: 'correo', value: 'ana@correo.mx' }] }));
  await say('1 al 3 de mayo, ana@correo.mx', phone);
  assert.deepEqual(photosTo(phone), ['mapa', 'gracias']);
  const conv = await h.conversationFor(phone);
  await h.authed('POST', `/api/conversations/${conv.id}/close`);
  h.setScript(() => ({ messages: ['¡Hola de nuevo! ¿Fechas?'], flow_step: 2 }));
  await say('otra reservación', phone);
  assert.deepEqual(photosTo(phone), ['mapa', 'gracias', 'mapa'], 'nuevo recorrido: la foto de la etapa vuelve a salir');
  h.setScript(() => ({ messages: ['¡Listo otra vez!'], flow_step: 3, goal_completed: true, save_data: [{ field: 'fechas', value: '9 al 11 de junio' }] }));
  await say('9 al 11 de junio', phone);
  assert.deepEqual(photosTo(phone), ['mapa', 'gracias', 'mapa', 'gracias']);
});

t('objetivo cumplido (avisar): el equipo recibe el reporte completo, por panel y WhatsApp', async () => {
  h.reset();
  h.setSummary('Leo quiere reservar del 1 al 3 de noviembre.');
  h.setAnalysis({ intent: 'Reservar habitación', sentiment: 'positivo', interest: 'alto', agreements: ['Confirmar disponibilidad'], next_steps: ['Enviar cotización'] });
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¡Listo! El equipo te confirma.'], flow_step: 3, goal_completed: true, save_data: [{ field: 'fechas', value: '1 al 3 de noviembre' }, { field: 'correo', value: 'leo@correo.mx' }] }));
  await say('1 al 3 de nov, leo@correo.mx', phone);
  await waitFor(async () => (await notices()).some((n) => n.title === '🎯 Objetivo cumplido'));
  const n = (await notices()).find((x) => x.title === '🎯 Objetivo cumplido')!;
  for (const piece of ['Leo quiere reservar', 'fechas: 1 al 3 de noviembre', 'correo: leo@correo.mx', 'Enviar cotización']) assert.match(n.body, new RegExp(piece), `el aviso del panel incluye "${piece}"`);
  const wa = h.sent.find((s) => s.to === TEAM_PHONE && /Objetivo cumplido/.test(s.text));
  assert.ok(wa, 'también por WhatsApp');
  assert.match(wa!.text, /leo@correo\.mx/);
  assert.match(wa!.text, /Leo quiere reservar/);
  const d = await detail(phone);
  assert.ok(d.conversation.goal_completed_at);
  assert.equal(d.conversation.report_summary, 'Leo quiere reservar del 1 al 3 de noviembre.');
});

t('objetivo cumplido (pasar a una persona): la alerta de transferencia y el aviso al encargado llevan datos y resumen', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { flow: { on_goal_action: 'handoff' }, rules: { handoff_notify_number: BOT_NOTIFY } });
  h.reset();
  h.setSummary('Eva reservó del 5 al 7 de diciembre.');
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¡Gracias! Una persona te confirma.'], flow_step: 3, goal_completed: true, save_data: [{ field: 'fechas', value: '5 al 7 de diciembre' }, { field: 'correo', value: 'eva@correo.mx' }] }));
  await say('5 al 7 de dic, eva@correo.mx', phone);
  await waitFor(async () => (await notices()).some((n) => /esperando a una persona/.test(n.title) && /eva@correo\.mx/.test(n.body)));
  const alert = (await notices()).find((x) => /esperando a una persona/.test(x.title) && /eva@correo\.mx/.test(x.body))!;
  assert.match(alert.body, /Eva reservó/);
  assert.match(alert.body, /fechas: 5 al 7 de diciembre/);
  const notify = h.sent.find((s) => s.kind === 'notify' && s.to === BOT_NOTIFY);
  assert.ok(notify, 'aviso al encargado configurado');
  assert.match(notify!.text, /eva@correo\.mx/);
  assert.match(notify!.text, /Eva reservó/);
});

t('el panel recibe el recorrido del asistente para mostrar la etapa y el objetivo de cada conversación', async () => {
  h.reset();
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¿Fechas?'], flow_step: 2 }));
  await say('hola', phone);
  const d = await detail(phone);
  assert.equal(d.chatbot.flow.goal, 'Que el cliente deje fechas y correo');
  assert.deepEqual(d.chatbot.flow.steps.map((x: any) => x.title), ['Saludo', 'Pedir fechas', 'Pedir correo']);
  assert.equal(d.conversation.flow_step, 2);
});

t('regla "se llega a una etapa": se dispara solo en esa etapa (o en cualquiera)', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { flow: { on_goal_action: 'none' }, rules: { handoff_notify_number: '' } });
  const mk = (name: string, step: number, tag: string) => h.authed('POST', '/api/automations', { account_id: h.accountId, name, trigger: { type: 'stage_reached', step }, actions: [{ type: 'add_tag', tag }] });
  assert.equal((await mk('Etapa 3', 3, 'en-etapa-3')).statusCode, 200);
  assert.equal((await mk('Cualquier etapa', 0, 'avanzo')).statusCode, 200);
  h.reset();
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¿Fechas?'], flow_step: 2 }));
  await say('hola', phone);
  let tags = (await detail(phone)).contact.tags;
  assert.ok(tags.includes('avanzo') && !tags.includes('en-etapa-3'), JSON.stringify(tags));
  h.setScript(() => ({ messages: ['¿Y tu correo?'], flow_step: 3 }));
  await say('del 3 al 5', phone);
  tags = (await detail(phone)).contact.tags;
  assert.ok(tags.includes('en-etapa-3'), JSON.stringify(tags));
  // Quedarse en la misma etapa no vuelve a disparar la regla.
  const runs = (await pool.query(`SELECT run_count FROM automations WHERE name = 'Etapa 3'`)).rows[0].run_count;
  h.setScript(() => ({ messages: ['Ok'], flow_step: 3 }));
  await say('gracias', phone);
  assert.equal((await pool.query(`SELECT run_count FROM automations WHERE name = 'Etapa 3'`)).rows[0].run_count, runs);
});

t('regla "objetivo cumplido → enviar reporte": cuando corre ya existe el resumen con todos los datos', async () => {
  const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Reporte al cumplir', trigger: { type: 'goal_completed' }, actions: [{ type: 'send_report', roles: ['admin'], note: 'Objetivo cumplido' }] });
  assert.equal(r.statusCode, 200, r.body);
  h.reset();
  h.setSummary('Ivo dejó fechas y correo.');
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¡Listo!'], flow_step: 3, goal_completed: true, save_data: [{ field: 'fechas', value: '2 al 4 de enero' }, { field: 'correo', value: 'ivo@correo.mx' }] }));
  await say('2 al 4 de enero, ivo@correo.mx', phone);
  await waitFor(async () => (await notices()).some((n) => n.kind === 'report'));
  const wa = await waitFor(() => h.sent.some((s) => s.to === TEAM_PHONE && /REPORTE DE CONVERSACIÓN/.test(s.text) && /ivo@correo\.mx/.test(s.text)), 4000).then(() => true, () => false);
  assert.ok(wa, 'el reporte por WhatsApp trae el correo capturado');
});

t('objetivo cumplido → secuencia de seguimiento: todos los pasos salen, en orden, una sola vez', async () => {
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { consent: { require_for_campaigns: false } });
  const seq = (await h.authed('POST', '/api/sequences', { account_id: h.accountId, name: 'Seguimiento de reserva', business_hours_only: false, steps: [
    { delay_value: 0, delay_unit: 'minutes', text: 'Paso 1: gracias {{nombre}}' },
    { delay_value: 0, delay_unit: 'minutes', text: 'Paso 2: te confirmamos pronto' },
    { delay_value: 0, delay_unit: 'minutes', text: 'Paso 3: ¿alguna duda?' },
  ] })).json();
  const rule = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Objetivo → seguimiento', trigger: { type: 'goal_completed' }, actions: [{ type: 'start_sequence', sequence_id: seq.id }] });
  assert.equal(rule.statusCode, 200, rule.body);
  h.reset();
  const phone = newPhone();
  h.setScript(() => ({ messages: ['¡Listo!'], flow_step: 3, goal_completed: true, save_data: [{ field: 'fechas', value: '8 al 9 de marzo' }, { field: 'correo', value: 'zoe@correo.mx' }] }));
  await say('8 al 9 de marzo, zoe@correo.mx', phone);
  await waitFor(async () => (await pool.query(`SELECT count(*)::int n FROM jobs WHERE type = 'sequence_step' AND status = 'pending'`)).rows[0].n >= 1);
  // Cada paso programa el siguiente: el programador los va tomando en cada vuelta.
  for (let i = 0; i < 4; i++) await h.fastForward();
  const texts = h.sent.filter((s) => s.to === phone && s.kind === 'text').map((s) => s.text.split('\n\n')[0]);
  assert.deepEqual(texts, ['¡Listo!', 'Paso 1: gracias Ana', 'Paso 2: te confirmamos pronto', 'Paso 3: ¿alguna duda?']);
  await h.fastForward();
  assert.equal(h.sent.filter((s) => s.to === phone && s.kind === 'text').length, 4, 'sin repetir pasos');
  await pool.query(`UPDATE automations SET active = false WHERE name = 'Objetivo → seguimiento'`);
});

t('los webhooks de objetivo y transferencia llevan resumen, análisis y datos de la conversación', async () => {
  const { eventData } = await import('../src/integrations/webhooks.js');
  const conv: any = { id: 'c1', status: 'human', handoff_reason: 'x', report_summary: 'Resumen', report_analysis: { intent: 'Reservar' }, data: { fechas: 'hoy' }, flow_step: 3, goal_completed_at: new Date('2026-01-01') };
  const data: any = eventData({ type: 'goal_completed', conversationId: 'c1' } as any, { conv, contact: { id: 'k', name: 'Ana', phone: '1', tags: [], data: {} } as any, channel: { id: 'ch', type: 'whatsapp', name: 'WA' } as any });
  assert.equal(data.conversation.summary, 'Resumen');
  assert.deepEqual(data.conversation.analysis, { intent: 'Reservar' });
  assert.deepEqual(data.conversation.data, { fechas: 'hoy' });
  assert.equal(data.conversation.flow_step, 3);
  assert.ok(data.conversation.goal_completed_at);
});
