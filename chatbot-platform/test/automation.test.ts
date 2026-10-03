/** Automatización de extremo a extremo: reglas, alertas, secuencias, seguimientos, bajas, campañas y agenda. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, ext, pool, sleep, store, waitFor } from './harness.js';

// Después del arnés (que define las variables de entorno de prueba).
const { config } = await import('../src/config.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
let teamUserId = '';
let convOf: (phone: string) => Promise<any>;

async function rule(body: Record<string, unknown>) {
  const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, ...body });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const pendingJobs = async (type?: string) =>
  (await pool.query(`SELECT * FROM jobs WHERE status = 'pending' ${type ? `AND type = '${type}'` : ''}`)).rows;
const lastTexts = (n = 5) => h.sent.slice(-n).map((s) => s.text);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  convOf = async (phone: string) => (await h.authed('GET', `/api/conversations?chatbot_id=${h.botId}&search=${phone}`)).json()[0];
  const s = await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: ALL_DAY });
  assert.equal(s.statusCode, 200, s.body);
  // Miembro del equipo que recibe alertas por WhatsApp
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'lucia@hotel.mx', name: 'Lucía', password: 'clave-lucia-1', role: 'agent', phone: '5215588880000', notify_whatsapp: true });
  assert.equal(u.statusCode, 200, u.body);
  teamUserId = u.json().id;
  await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { title: 'Precios', content: 'Doble: $1,650 MXN por noche.' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('regla por palabra clave: responde sin IA, etiqueta y alerta al equipo (panel + WhatsApp)', async () => {
  await rule({
    name: 'Lista de precios',
    trigger: { type: 'message_received', match: 'keywords', keywords: ['lista de precios'] },
    stop_ai: true,
    actions: [
      { type: 'send_message', text: 'Hola {{nombre}}, te comparto nuestra lista de precios 👇' },
      { type: 'add_tag', tag: 'interesado' },
      { type: 'alert_team', message: '{{nombre}} pidió la lista de precios: "{{mensaje}}"', roles: ['agent'] },
    ],
  });
  h.reset();
  h.setScript(() => ({ messages: ['respuesta de la IA'] }));
  await h.webhook('me pasas la lista de precios?', { phone: '5215510001001' });
  await waitFor(() => h.sent.length >= 2);
  await sleep(400);
  assert.equal(h.calls.length, 0, 'la IA no respondió');
  assert.equal(h.sent[0].text, 'Hola Ana, te comparto nuestra lista de precios 👇');
  const alert = h.sent.find((s) => s.to === '5215588880000');
  assert.ok(alert && /pidió la lista de precios: "me pasas la lista de precios\?"/.test(alert.text), JSON.stringify(h.sent));
  const conv = await convOf('5215510001001');
  const detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
  assert.deepEqual(detail.contact.tags, ['interesado']);
  const lucia = await h.loginAs('lucia@hotel.mx', 'clave-lucia-1');
  const notes = (await lucia('GET', '/api/notifications')).json();
  assert.equal(notes.unread, 1);
  assert.match(notes.items[0].title, /Lista de precios/);
  await lucia('POST', '/api/notifications/read', {});
  assert.equal((await lucia('GET', '/api/notifications')).json().unread, 0);
});

t('encadenado: etiqueta → secuencia con pasos programados; se detiene si el cliente responde', async () => {
  const seq = (await h.authed('POST', '/api/sequences', {
    account_id: h.accountId,
    name: 'Seguimiento de interesados',
    business_hours_only: true,
    stop_on_reply: true,
    steps: [
      { delay_value: 0, delay_unit: 'minutes', text: 'Paso 1: ¿te ayudo a elegir habitación, {{nombre}}?' },
      { delay_value: 1, delay_unit: 'days', text: 'Paso 2: seguimos a tus órdenes' },
    ],
  })).json();
  await rule({ name: 'Interesado → secuencia', trigger: { type: 'tag_added', tag: 'interesado' }, actions: [{ type: 'start_sequence', sequence_id: seq.id }] });
  h.reset();
  await h.webhook('lista de precios porfa', { phone: '5215510001002' });
  await waitFor(() => h.sent.length >= 1);
  const conv = await convOf('5215510001002');
  let auto: any;
  await waitFor(async () => {
    auto = (await h.authed('GET', `/api/conversations/${conv.id}/automation`)).json();
    return auto.enrollments.length > 0;
  });
  assert.equal(auto.enrollments[0].status, 'active');
  // La inscripción se guarda antes que su primer envío programado: esperar a ambos.
  await waitFor(async () => (await pendingJobs('sequence_step')).length === 1);
  await h.service.scheduler.runDue();
  await waitFor(() => lastTexts().some((x) => x.startsWith('Paso 1')));
  // El paso 2 es mañana: no se envía todavía
  await h.service.scheduler.runDue();
  assert.ok(!lastTexts().some((x) => x.startsWith('Paso 2')));
  await h.fastForward();
  assert.ok(lastTexts().some((x) => x.startsWith('Paso 2')));
  auto = (await h.authed('GET', `/api/conversations/${conv.id}/automation`)).json();
  assert.equal(auto.enrollments[0].status, 'completed');

  // Nueva inscripción manual y el cliente responde → se detiene
  const en = await h.authed('POST', `/api/conversations/${conv.id}/sequences`, { sequence_id: seq.id });
  assert.equal(en.statusCode, 200, en.body);
  const dup = await h.authed('POST', `/api/conversations/${conv.id}/sequences`, { sequence_id: seq.id });
  assert.equal(dup.statusCode, 409);
  h.setScript(() => ({ messages: ['Claro'] }));
  await h.webhook('gracias, lo pienso', { phone: '5215510001002' });
  await waitFor(() => lastTexts(1)[0] === 'Claro');
  auto = (await h.authed('GET', `/api/conversations/${conv.id}/automation`)).json();
  assert.equal(auto.enrollments[0].status, 'stopped');
  assert.equal(auto.enrollments[0].stop_reason, 'el cliente respondió');
  const before = h.sent.length;
  await h.fastForward();
  assert.equal(h.sent.length, before, 'no se envió nada más');
});

t('seguimiento si el cliente no responde (una sola vez) y se cancela si responde', async () => {
  const r = await rule({ name: 'Seguimiento 30 min', trigger: { type: 'no_reply', minutes: 30 }, actions: [{ type: 'send_message', text: '¿Sigues ahí, {{nombre}}? Aquí estoy para ayudarte.' }] });
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola! ¿En qué te ayudo?'] }));
  await h.webhook('hola', { phone: '5215510001003' });
  await waitFor(() => h.sent.length === 1);
  // El seguimiento se programa al terminar el envío.
  await waitFor(async () => (await pendingJobs('no_reply')).length === 1);
  await h.service.scheduler.runDue();
  assert.equal(h.sent.length, 1, 'aún no pasan 30 min');
  await h.fastForward();
  assert.equal(lastTexts(1)[0], '¿Sigues ahí, Ana? Aquí estoy para ayudarte.');
  assert.equal((await pendingJobs('no_reply')).length, 0, 'el seguimiento no se re-programa a sí mismo');
  // Si responde antes, no se envía
  h.reset();
  await h.webhook('hola otra vez', { phone: '5215510001004' });
  await waitFor(() => h.sent.length === 1);
  await h.webhook('perdón, sigo aquí', { phone: '5215510001004' });
  await waitFor(() => h.sent.length === 2);
  // El seguimiento se programa justo después del envío: se espera a que termine para no ganarle la carrera.
  await h.idle();
  await pool.query(`UPDATE jobs SET payload = jsonb_set(payload, '{after_message_id}', '0') WHERE type = 'no_reply' AND status = 'pending'`);
  await h.fastForward();
  assert.ok(!h.sent.some((s) => s.text.startsWith('¿Sigues ahí') && s.to === '5215510001004'));
  await h.authed('DELETE', `/api/automations/${r.id}`);
});

t('intención detectada por la IA: queja → transferir y alertar', async () => {
  await rule({ name: 'Quejas', trigger: { type: 'intent', intent: 'queja', description: 'El cliente está molesto o reporta un problema' }, actions: [{ type: 'handoff', reason: 'Queja del cliente' }, { type: 'alert_team', message: 'Queja de {{nombre}}: {{mensaje}}' }] });
  h.reset();
  h.setScript((req) => {
    assert.match(req.messages[0].content, /Intenciones a detectar[\s\S]*`queja`: El cliente está molesto/);
    return { messages: ['Lamento mucho lo ocurrido, lo reviso de inmediato.'], intents: ['queja', 'inventada'] };
  });
  await h.webhook('el cuarto estaba sucio, pésimo servicio', { phone: '5215510001005' });
  await waitFor(async () => (await convOf('5215510001005'))?.status === 'human');
  await waitFor(() => h.sent.some((s) => s.to === '5215588880000' && s.text.includes('Queja de Ana')));
  const logs = (await h.authed('GET', `/api/logs?conversation_id=${(await convOf('5215510001005')).id}`)).json();
  assert.ok(logs.some((l: any) => l.message.includes('Intenciones desconocidas ignoradas: inventada')));
});

t('bajas: BAJA detiene mensajes promocionales; ALTA los reactiva; recordatorios sí llegan', async () => {
  h.reset();
  await h.webhook('BAJA', { phone: '5215510001006' });
  await waitFor(() => h.sent.length === 1);
  assert.match(h.sent[0].text, /ya no te enviaremos/);
  assert.equal(h.calls.length, 0);
  const conv = await convOf('5215510001006');
  let c = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().contact;
  assert.equal(c.opted_out, true);
  const promo = await h.service.outbound.send(conv.id, { text: 'Promo', source: 'campaign' });
  assert.deepEqual(promo, { sent: false, reason: 'el cliente se dio de baja' });
  const service = await h.service.outbound.send(conv.id, { text: 'Recordatorio de tu cita', source: 'reminder', transactional: true });
  assert.equal(service.sent, true);
  await h.webhook('alta', { phone: '5215510001006' });
  await waitFor(() => lastTexts(1)[0].includes('Volverás a recibir'));
  c = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().contact;
  assert.equal(c.opted_out, false);
});

t('condición de horario: respuesta automática fuera de horario', async () => {
  await rule({ name: 'Fuera de horario', trigger: { type: 'message_received', match: 'any' }, conditions: [{ type: 'business_hours', inside: false }], actions: [{ type: 'send_message', text: 'Estamos fuera de horario; te respondemos mañana a primera hora.' }] });
  h.reset();
  h.setScript(() => ({ messages: ['Hola'] }));
  await h.webhook('hola', { phone: '5215510001007' });
  await waitFor(() => h.sent.length === 1);
  await sleep(300);
  assert.ok(!lastTexts().some((x) => x.includes('fuera de horario')), 'abierto 24/7: no aplica');
  const closed = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, []]));
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: closed });
  await h.webhook('¿siguen ahí?', { phone: '5215510001007' });
  await waitFor(() => lastTexts().some((x) => x.includes('fuera de horario')));
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { business_hours: ALL_DAY });
  for (const a of (await h.authed('GET', '/api/automations')).json()) if (a.name === 'Fuera de horario') await h.authed('DELETE', `/api/automations/${a.id}`);
});

t('webhook saliente firmado (n8n/Zapier/CRM) y bloqueo de redes internas', async () => {
  const hookUrl = `${process.env.TELEGRAM_API_URL}/hook`;
  await rule({ name: 'CRM', trigger: { type: 'data_captured', field: 'correo' }, actions: [{ type: 'webhook', url: hookUrl }] });
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { data_fields: [{ key: 'correo', label: 'Correo', type: 'email' }] });
  ext.requests.length = 0;
  h.reset();
  h.setScript(() => ({ messages: ['¡Gracias! Anotado.'], save_data: [{ field: 'correo', value: 'Ana@Mail.com' }] }));
  await h.webhook('mi correo es ana@mail.com', { phone: '5215510001008' });
  await waitFor(() => ext.requests.some((r) => r.path === '/hook'));
  const hook = ext.requests.find((r) => r.path === '/hook')!;
  assert.equal(hook.body.event, 'data_captured');
  assert.equal(hook.body.contact.data.correo, 'ana@mail.com');
  assert.match(String(hook.headers['x-signature']), /^sha256=[0-9a-f]{64}$/);
  // Sin permiso explícito, las IP internas se bloquean
  const { postWebhook } = await import('../src/automation/automator.js');
  config.allowPrivateWebhooks = false;
  await assert.rejects(() => postWebhook(hookUrl, {}, 'x'), /red interna/);
  await assert.rejects(() => postWebhook('http://169.254.169.254/latest', {}, 'x'), /red interna/);
  // Un dominio que resuelve a la red interna se bloquea al conectar (también protege contra "DNS rebinding").
  await assert.rejects(() => postWebhook(hookUrl.replace('127.0.0.1', 'localhost'), {}, 'x'), /red interna/);
  config.allowPrivateWebhooks = true;
});

t('ventana de 24 h de Meta: no se escribe a quien no ha escrito recientemente', async () => {
  const conv = await convOf('5215510001001');
  await pool.query(`UPDATE channels SET type = 'messenger' WHERE id = $1`, [conv.channel_id]);
  await pool.query(`UPDATE messages SET created_at = now() - interval '25 hours' WHERE conversation_id = $1`, [conv.id]);
  const r = await h.service.outbound.send(conv.id, { text: 'hola', source: 'campaign' });
  assert.equal(r.sent, false);
  assert.match((r as any).reason, /24 h/);
  await pool.query(`UPDATE channels SET type = 'whatsapp' WHERE id = $1`, [conv.channel_id]);
});

t('campañas: segmento por etiquetas, excluye bajas, ritmo controlado y estadísticas', async () => {
  const c1 = await convOf('5215510001001'); // etiqueta interesado
  const c2 = await convOf('5215510001002'); // interesado
  const c3 = await convOf('5215510001003'); // sin etiqueta
  await h.authed('PUT', `/api/contacts/${(await h.authed('GET', `/api/conversations/${c3.id}`)).json().contact.id}`, { opted_out: true });
  const camp = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Promo octubre', message: 'Hola {{nombre}}, 20% en la suite este mes', audience: { tags_any: ['interesado'] }, rate_per_minute: 60 })).json();
  const preview = (await h.authed('POST', `/api/campaigns/${camp.id}/preview`)).json();
  assert.equal(preview.count, 2);
  assert.match(preview.warning, /WhatsApp puede bloquear/);
  h.reset();
  const launched = (await h.authed('POST', `/api/campaigns/${camp.id}/launch`)).json();
  assert.equal(launched.status, 'sending');
  const jobs = await pendingJobs('campaign_send');
  const gaps = jobs.map((j: any) => new Date(j.run_at).getTime()).sort();
  assert.ok(gaps[1] - gaps[0] >= 900, 'envíos espaciados');
  await h.fastForward();
  const sentTo = h.sent.filter((s) => s.text.includes('20% en la suite')).map((s) => s.to).sort();
  assert.deepEqual(sentTo, ['5215510001001', '5215510001002']);
  const after = (await h.authed('GET', '/api/campaigns')).json().find((x: any) => x.id === camp.id);
  assert.equal(after.status, 'sent');
  assert.equal(after.stats.sent, 2);
  // Programada a futuro y cancelada
  const later = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Navidad', message: 'Felices fiestas', scheduled_at: new Date(Date.now() + 86400_000).toISOString() })).json();
  assert.equal((await h.authed('POST', `/api/campaigns/${later.id}/launch`)).json().status, 'scheduled');
  await h.authed('POST', `/api/campaigns/${later.id}/cancel`);
  await h.fastForward();
  assert.ok(!h.sent.some((s) => s.text === 'Felices fiestas'));
  void c1;
  void c2;
});

/* ------------------------------ Agenda ------------------------------ */
let serviceId = '';
t('agenda por IA: ofrece horarios reales, rechaza inventados, agenda, recuerda y avisa al equipo', async () => {
  const s = await h.authed('POST', '/api/services', {
    account_id: h.accountId,
    name: 'Visita guiada',
    kind: 'appointment',
    duration_minutes: 60,
    min_notice_minutes: 0,
    max_days_ahead: 5,
    location: 'Recepción del hotel',
    reminders: [1440, 60],
    assigned_user_ids: [teamUserId],
  });
  assert.equal(s.statusCode, 200, s.body);
  serviceId = s.json().id;
  let realSlot = '';
  h.reset();
  h.setScript((req, i) => {
    const prompt = req.messages[0].content;
    assert.match(prompt, /# Agenda \(citas y llamadas\)/);
    realSlot = [...prompt.matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)].at(-1)![1];
    if (i === 0) return { messages: ['Listo, quedó el 1 de enero'], booking: { action: 'book', service_id: serviceId, slot: '2099-01-01T10:00', appointment_id: '' } };
    return { messages: [`Perfecto Ana, quedó agendada tu visita.`], booking: { action: 'book', service_id: serviceId, slot: realSlot, appointment_id: '' } };
  });
  await h.webhook('quiero agendar la visita guiada en el último horario que tengas', { phone: '5215510002001' });
  await waitFor(() => h.sent.some((x) => x.text.includes('quedó agendada')));
  assert.equal(h.calls.length, 2, 'el horario inventado se rechazó y se reintentó');
  assert.match(h.calls[1].messages.at(-1)!.content, /no está disponible/);
  const appts = (await h.authed('GET', '/api/appointments')).json();
  const a = appts.find((x: any) => x.service_id === serviceId && x.status === 'confirmed');
  assert.ok(a, JSON.stringify(appts));
  assert.equal(a.assigned_user_id, teamUserId);
  assert.equal(a.source, 'bot');
  // Aviso al equipo asignado (panel + WhatsApp)
  await waitFor(() => h.sent.some((x) => x.to === '5215588880000' && x.text.includes('Cita agendada: Visita guiada')));
  // Recordatorios programados (solo los que caen en el futuro)
  const reminders = await pendingJobs('appointment_reminder');
  assert.ok(reminders.length >= 1 && reminders.every((j: any) => j.payload.appointment_id === a.id));
  // El horario ya no se ofrece a otro cliente (capacidad 1)
  const slots = (await h.authed('GET', `/api/services/${serviceId}/slots`)).json();
  assert.ok(!slots.some((x: any) => x.key === realSlot));
  // Recordatorio
  h.reset();
  await pool.query(`UPDATE jobs SET run_at = now() WHERE type = 'appointment_reminder' AND status = 'pending' AND id = (SELECT min(id) FROM jobs WHERE type = 'appointment_reminder' AND status = 'pending')`);
  await h.service.scheduler.runDue();
  assert.match(h.sent[0].text, /te recordamos tu cita de Visita guiada el \S+ \d+ de \S+ a las \d{2}:\d{2}/);
});

t('agenda por IA: cancelar su cita (solo las suyas) cancela recordatorios y avisa', async () => {
  const appt = (await h.authed('GET', '/api/appointments')).json().find((x: any) => x.service_id === serviceId && x.status === 'confirmed');
  h.reset();
  h.setScript((req, i) => {
    assert.match(req.messages[0].content, new RegExp(`Citas del cliente[\\s\\S]*${appt.id}`));
    if (i === 0) return { messages: ['Cancelada'], booking: { action: 'cancel', service_id: '', slot: '', appointment_id: '00000000-0000-0000-0000-000000000000' } };
    return { messages: ['Listo, cancelé tu visita.'], booking: { action: 'cancel', service_id: '', slot: '', appointment_id: appt.id } };
  });
  await h.webhook('cancela mi visita porfa', { phone: '5215510002001' });
  await waitFor(() => h.sent.some((x) => x.text === 'Listo, cancelé tu visita.'));
  const after = (await h.authed('GET', '/api/appointments')).json().find((x: any) => x.id === appt.id);
  assert.equal(after.status, 'cancelled');
  assert.equal((await pendingJobs('appointment_reminder')).filter((j: any) => j.payload.appointment_id === appt.id).length, 0);
  await waitFor(() => h.sent.some((x) => x.to === '5215588880000' && x.text.includes('Cita cancelada')));
});

t('agenda desde el panel: agendar con confirmación, reprogramar, completar, cancelar y calendario .ics', async () => {
  const conv = await convOf('5215510002001');
  const slots = (await h.authed('GET', `/api/services/${serviceId}/slots`)).json();
  h.reset();
  const agent = await h.loginAs('lucia@hotel.mx', 'clave-lucia-1');
  const r = await agent('POST', '/api/appointments', { service_id: serviceId, slot: slots[0].key, conversation_id: conv.id, notes: 'Trae identificación' });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(h.sent.find((s) => s.to === '5215510002001')!.text, /quedó agendada para el .* Lugar: Recepción del hotel\./);
  const dup = await agent('POST', '/api/appointments', { service_id: serviceId, slot: slots[0].key, customer_name: 'Otro' });
  assert.equal(dup.statusCode, 409, 'doble reserva rechazada');
  assert.equal((await agent('POST', '/api/appointments', { service_id: serviceId, slot: '2099-01-01T10:00', customer_name: 'X', force: true })).statusCode, 403, 'forzar es solo de administradores');
  const id = r.json().id;
  const moved = await agent('PUT', `/api/appointments/${id}`, { slot: slots[1].key });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((await agent('PUT', `/api/appointments/${id}`, { status: 'completed' })).json().status, 'completed');
  const second = (await agent('POST', '/api/appointments', { service_id: serviceId, slot: slots[2].key, conversation_id: conv.id, notify_customer: false })).json();
  h.reset();
  await agent('POST', `/api/appointments/${second.id}/cancel`, { reason: 'El cliente llamó para cancelar' });
  assert.match(h.sent.find((s) => s.to === '5215510002001')!.text, /fue cancelada/);
  assert.ok(h.sent.some((s) => s.to === '5215588880000' && s.text.includes('Cita cancelada')), 'el equipo también se entera');
  const settings = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  const ics = await h.app.inject({ method: 'GET', url: settings.ics_url.replace('https://bot.test', '') });
  assert.equal(ics.statusCode, 200);
  assert.match(ics.headers['content-type'] as string, /text\/calendar/);
  assert.match(ics.body, /BEGIN:VEVENT[\s\S]*Visita guiada/);
  assert.equal((await h.app.inject({ method: 'GET', url: '/calendar/token-falso.ics' })).statusCode, 404);
});

t('simulador: reglas y citas de prueba sin molestar al equipo ni ocupar horarios reales', async () => {
  await rule({ name: 'Alerta VIP', trigger: { type: 'message_received', match: 'keywords', keywords: ['vip'] }, actions: [{ type: 'alert_team', message: 'Cliente VIP escribió' }] });
  h.reset();
  let slot = '';
  h.setScript((req) => {
    slot = [...req.messages[0].content.matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)][0][1];
    return { messages: ['Agendado'], booking: { action: 'book', service_id: serviceId, slot, appointment_id: '' } };
  });
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/playground`, { session: 'auto1', text: 'soy vip, agéndame' });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!h.sent.some((s) => s.to === '5215588880000'), 'no se alertó al equipo real');
  const hist = (await h.authed('GET', `/api/chatbots/${h.botId}/playground/auto1`)).json().messages;
  assert.ok(hist.some((m: any) => m.sender === 'system' && m.content.includes('(simulador) 🔔 Alerta al equipo')));
  const sim = (await h.authed('GET', '/api/appointments')).json().find((a: any) => a.source === 'simulador');
  assert.ok(sim, 'la cita de prueba queda marcada');
  const slots = (await h.authed('GET', `/api/services/${serviceId}/slots`)).json();
  assert.ok(slots.some((x: any) => x.key === slot), 'la cita de prueba no ocupa el horario real');
});

t('acceso: otra cuenta no ve ni toca la automatización; el agente no configura reglas', async () => {
  const other = await h.authed('POST', '/api/accounts', { name: 'Otra', admin: { email: 'admin@otra.mx', password: 'clave-otra-1' } });
  const api = await h.loginAs('admin@otra.mx', 'clave-otra-1');
  for (const path of ['/api/automations', '/api/sequences', '/api/campaigns', '/api/services', '/api/appointments']) {
    assert.deepEqual((await api('GET', path)).json(), [], path);
  }
  const mine = (await h.authed('GET', `/api/automations?account_id=${h.accountId}`)).json()[0];
  assert.equal((await api('PUT', `/api/automations/${mine.id}`, { name: 'x' })).statusCode, 404);
  assert.equal((await api('PUT', `/api/services/${serviceId}`, { name: 'x' })).statusCode, 404);
  assert.equal((await api('GET', `/api/services/${serviceId}/slots`)).statusCode, 404);
  // No puede apuntar una regla a una secuencia o imagen de otra cuenta
  const seq = (await h.authed('GET', `/api/sequences?account_id=${h.accountId}`)).json()[0];
  const bad = await api('POST', '/api/automations', { name: 'x', trigger: { type: 'new_contact' }, actions: [{ type: 'start_sequence', sequence_id: seq.id }] });
  assert.equal(bad.statusCode, 400);
  const agent = await h.loginAs('lucia@hotel.mx', 'clave-lucia-1');
  assert.equal((await agent('POST', '/api/automations', { name: 'x', trigger: { type: 'new_contact' }, actions: [{ type: 'close_conversation' }] })).statusCode, 403);
  assert.equal((await agent('GET', '/api/campaigns')).statusCode, 403);
  void other;
  void store;
});
