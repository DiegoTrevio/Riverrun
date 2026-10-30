/**
 * Recorrido completo de un cliente: se presenta, agenda una cita, se cumple el objetivo y pide hablar con una persona.
 * En cada paso se revisa lo que recibe el equipo (panel y WhatsApp) y lo que llega, firmado, a otro sistema (webhook),
 * y que la API pública devuelva lo mismo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createHarness, dbAvailable, pool, sleep, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

/** Sistema externo (CRM, Zapier, n8n…) que recibe los webhooks. */
const received: { headers: http.IncomingHttpHeaders; raw: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    received.push({ headers: req.headers, raw, body: JSON.parse(raw) });
    res.writeHead(200); res.end('ok');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const of = (type: string) => received.filter((r) => r.body.type === type);
const until = (cond: () => boolean) => waitFor(async () => { await h.service.automator.settleAll(); await h.fastForward(); return cond(); }, 8000);

const ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
const CUSTOMER = '5215510030001';
const TEAM_PHONE = '5215577770000';
const GOAL_PHONE = '5215577770001';
let serviceId = '';
let teamUserId = '';
let secret = '';
let apiKey = '';

const say = async (text: string) => {
  const r = await h.webhook(text, { phone: CUSTOMER });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(400);
  await h.idle();
  await h.service.automator.settleAll();
};
const toPhone = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text);
const api = (method: string, url: string) => h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${apiKey}` } });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({
    flow: { goal: 'Agendar la visita guiada con nombre y fecha de llegada' },
    data_fields: [
      { key: 'nombre', label: 'Nombre', type: 'name', required: true, question: '¿Cuál es tu nombre?' },
      { key: 'fecha_llegada', label: 'Fecha de llegada', type: 'text', required: true, question: '¿Qué día llegas?' },
    ],
    rules: { handoff_message: 'En un momento te atiende una persona del equipo.' },
  });
  assert.equal((await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: ALL_DAY, notify_team_on_handoff: true })).statusCode, 200);
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'sofia@hotel.mx', name: 'Sofía', password: 'Pz-148-Qx-348-Kv', role: 'admin', phone: TEAM_PHONE, notify_whatsapp: true });
  assert.equal(u.statusCode, 200, u.body);
  teamUserId = u.json().id;
  const s = await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Visita guiada', kind: 'appointment', duration_minutes: 60, min_notice_minutes: 0, max_days_ahead: 5, location: 'Recepción', assigned_user_ids: [teamUserId] });
  assert.equal(s.statusCode, 200, s.body);
  serviceId = s.json().id;
  // Aviso al equipo al cumplirse el objetivo (Avisos al equipo del agente).
  const rule = await h.authed('POST', '/api/automations', { account_id: h.accountId, chatbot_id: h.botId, name: 'Visita agendada', active: true, once_per_conversation: true,
    trigger: { type: 'goal_completed' }, conditions: [], actions: [{ type: 'alert_team', message: '🎯 {{cliente}} agendó: {{dato.fecha_llegada}}', roles: [], phones: [GOAL_PHONE] }] });
  assert.equal(rule.statusCode, 200, rule.body);
  // Otro sistema suscrito a todos los eventos, y una llave de la API pública.
  const ep = await h.authed('POST', '/api/webhook-endpoints', { account_id: h.accountId, url: `http://127.0.0.1:${(server.address() as any).port}/crm`, description: 'CRM' });
  assert.equal(ep.statusCode, 200, ep.body);
  secret = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json().webhook_secret;
  apiKey = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'CRM', scope: 'read' })).json().key;
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('1) se presenta: el otro sistema recibe el contacto nuevo y su nombre', async () => {
  h.setScript(() => ({ messages: ['¡Hola, Ana! Con gusto.'], save_data: [{ field: 'nombre', value: 'Ana López' }] }));
  await say('Hola, soy Ana López');
  await until(() => of('contact.created').length === 1 && of('contact.data_captured').some((r) => r.body.data.field === 'nombre'));
  const created = of('contact.created')[0].body;
  assert.equal(created.data.contact.phone, CUSTOMER);
  assert.equal(created.data.conversation.channel.type, 'whatsapp');
  const name = of('contact.data_captured').find((r) => r.body.data.field === 'nombre')!.body;
  assert.equal(name.data.value, 'Ana López');
  assert.equal(name.data.contact.name, 'Ana López');
});

t('2) agenda la cita: queda en la agenda, avisa a quien atiende el servicio, se cumple el objetivo y el otro sistema recibe todo', async () => {
  let slot = '';
  h.reset();
  h.setScript((req) => {
    slot = [...String(req.messages[0].content).matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)].at(-1)![1];
    return { messages: ['Listo, Ana: quedó agendada tu visita guiada.'], save_data: [{ field: 'fecha_llegada', value: '20 de noviembre' }],
      booking: { action: 'book', service_id: serviceId, slot, appointment_id: '' }, goal_completed: true };
  });
  await say('Quiero agendar la visita guiada en el último horario; llego el 20 de noviembre');

  // Agenda: la cita existe, del cliente y con la persona asignada.
  const appts = (await h.authed('GET', '/api/appointments')).json();
  const appt = appts.find((a: any) => a.service_id === serviceId && a.status === 'confirmed');
  assert.ok(appt, JSON.stringify(appts));
  assert.equal(appt.customer_phone, CUSTOMER);
  assert.equal(appt.assigned_user_id, teamUserId);
  assert.equal(appt.source, 'bot');

  // Equipo: aviso de la cita a quien la atiende y aviso del objetivo con el dato capturado.
  await until(() => toPhone(TEAM_PHONE).some((x) => x.includes('Cita agendada: Visita guiada')) && toPhone(GOAL_PHONE).length === 1);
  assert.match(toPhone(GOAL_PHONE)[0], /🎯 Ana López agendó: 20 de noviembre/);
  const panel = (await (await h.loginAs('sofia@hotel.mx', 'Pz-148-Qx-348-Kv'))('GET', '/api/notifications')).json().items;
  assert.ok(panel.some((n: any) => /Cita agendada: Visita guiada/.test(n.title)), 'también en el panel');

  // Otro sistema: la cita y el objetivo, con los datos correctos.
  await until(() => of('appointment.booked').length === 1 && of('goal.completed').length === 1);
  const booked = of('appointment.booked')[0].body.data;
  assert.equal(booked.appointment.id, appt.id);
  assert.equal(booked.appointment.service_id, serviceId);
  assert.equal(new Date(booked.appointment.starts_at).toISOString(), new Date(appt.starts_at).toISOString());
  assert.equal(booked.contact.phone, CUSTOMER);
  const goal = of('goal.completed')[0].body.data;
  assert.equal(goal.contact.data.fecha_llegada, '20 de noviembre');
  assert.equal(goal.contact.data.nombre, 'Ana López');
  assert.ok(goal.conversation.goal_completed_at, 'marca cuándo se cumplió');
  assert.ok(goal.conversation.summary, 'lleva el resumen de la conversación');
});

t('3) pide una persona: pasa al equipo con el motivo y el resumen, y el otro sistema lo recibe', async () => {
  h.reset();
  h.setScript(() => ({ action: 'handoff', messages: [], handoff_reason: 'Pide factura de su reserva' }));
  await say('Necesito factura, ¿me pasas con alguien?');
  const d = (await h.authed('GET', `/api/conversations/${(await h.conversationFor(CUSTOMER)).id}`)).json();
  assert.equal(d.conversation.status, 'human');
  assert.equal(d.conversation.handoff_reason, 'Pide factura de su reserva');
  assert.ok(h.sent.some((s) => s.to === CUSTOMER && s.text === 'En un momento te atiende una persona del equipo.'), 'el cliente sabe que lo atiende una persona');
  await until(() => toPhone(TEAM_PHONE).some((x) => x.includes('Conversación esperando a una persona')) && of('conversation.handoff').length === 1);
  const alert = toPhone(TEAM_PHONE).find((x) => x.includes('Conversación esperando a una persona'))!;
  assert.match(alert, /Ana López[\s\S]*Pide factura de su reserva/);
  const handoff = of('conversation.handoff')[0].body.data;
  assert.equal(handoff.conversation.status, 'human');
  assert.equal(handoff.conversation.handoff_reason, 'Pide factura de su reserva');
  assert.equal(handoff.contact.data.fecha_llegada, '20 de noviembre');
});

t('4) todo lo que salió hacia el otro sistema va firmado, una vez por evento, y queda en la bitácora', async () => {
  const types = received.map((r) => r.body.type);
  for (const r of received) {
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(r.raw).digest('hex')}`;
    assert.equal(r.headers['x-signature'], sig, `firma de ${r.body.type}`);
    assert.equal(r.headers['x-riverrun-event'], r.body.type);
    assert.equal(r.body.account_id, h.accountId);
  }
  assert.equal(new Set(received.map((r) => r.body.id)).size, received.length, `sin entregas repetidas: ${types.join(', ')}`);
  for (const type of ['contact.created', 'appointment.booked', 'goal.completed', 'conversation.handoff']) assert.equal(of(type).length, 1, `${type} una vez`);
  const ep = (await h.authed('GET', `/api/webhook-endpoints?account_id=${h.accountId}`)).json()[0];
  const log = (await h.authed('GET', `/api/webhook-endpoints/${ep.id}/deliveries`)).json();
  assert.ok(log.length >= received.length && log.every((l: any) => l.ok && l.status_code === 200));
});

t('5) la API pública devuelve los mismos datos: contacto, conversación y cita', async () => {
  const contacts = (await api('GET', `/api/v1/contacts?phone=${CUSTOMER}`)).json().data;
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].data.fecha_llegada, '20 de noviembre');
  assert.equal(contacts[0].name, 'Ana López');
  const convs = (await api('GET', '/api/v1/conversations?limit=50')).json().data;
  const conv = convs.find((c: any) => c.contact_id === contacts[0].id);
  assert.equal(conv.status, 'human');
  const msgs = (await api('GET', `/api/v1/conversations/${conv.id}/messages`)).json().data;
  assert.ok(msgs.some((m: any) => m.direction === 'inbound' && /factura/.test(m.text ?? m.content)));
  const appts = (await api('GET', '/api/v1/appointments')).json().data;
  assert.ok(appts.some((a: any) => a.service_name === 'Visita guiada' && a.customer_phone === CUSTOMER && a.contact_id === contacts[0].id && a.status === 'confirmed'));
});

t('6) el equipo la devuelve al asistente; días después vuelve, cancela la cita anterior y agenda otra: todo llega de nuevo y con los datos nuevos', async () => {
  const conv = await h.conversationFor(CUSTOMER);
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/release`)).statusCode, 200);
  const first = (await h.authed('GET', '/api/appointments')).json().find((a: any) => a.service_id === serviceId && a.status === 'confirmed');
  // Tres días después (solicitud nueva por tiempo).
  for (const table of ['messages']) await pool.query(`UPDATE ${table} SET created_at = created_at - interval '72 hours' WHERE conversation_id = $1`, [conv.id]);
  received.length = 0;
  h.reset();
  let slot = '';
  let prompt = '';
  h.setScript((req) => {
    prompt = String(req.messages[0].content);
    // El horario más temprano (la cita anterior quedó en el último).
    slot = [...prompt.matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)][0][1];
    return { messages: ['Listo, Ana: cancelé la anterior y quedó tu nueva visita.'], save_data: [{ field: 'fecha_llegada', value: '3 de enero' }],
      booking: { action: 'cancel', appointment_id: first.id, service_id: '', slot: '' }, goal_completed: true };
  });
  await say('Hola de nuevo: cancela mi visita anterior, ahora llego el 3 de enero');
  assert.match(prompt, /Solicitud actual: la 2\.ª/);
  assert.match(prompt, new RegExp(`\`${first.id}\``), 'la IA ve la cita que puede cancelar');
  const appts = (await h.authed('GET', '/api/appointments')).json();
  assert.equal(appts.find((a: any) => a.id === first.id).status, 'cancelled');

  // El otro sistema recibe la cancelación y el objetivo de la solicitud nueva, con la fecha nueva.
  await until(() => of('appointment.cancelled').length === 1 && of('goal.completed').length === 1);
  assert.equal(of('appointment.cancelled')[0].body.data.appointment.id, first.id);
  const goal = of('goal.completed')[0].body.data;
  assert.equal(goal.contact.data.fecha_llegada, '3 de enero', 'los datos de la solicitud nueva, no los de la anterior');
  assert.equal(goal.conversation.status, 'bot');
  // El aviso «una vez» del objetivo vuelve a salir en la solicitud nueva.
  await until(() => toPhone(GOAL_PHONE).length === 1);
  assert.match(toPhone(GOAL_PHONE)[0], /agendó: 3 de enero/);
  // Y agenda la nueva visita.
  h.setScript((req) => {
    slot = [...String(req.messages[0].content).matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)][0][1];
    return { messages: ['Quedó agendada tu nueva visita.'], booking: { action: 'book', service_id: serviceId, slot, appointment_id: '' } };
  });
  await say('Agéndame la visita en el primer horario');
  await until(() => of('appointment.booked').length === 1);
  const booked = of('appointment.booked')[0].body.data.appointment;
  assert.notEqual(booked.id, first.id);
  assert.equal(booked.status, 'confirmed');
});
