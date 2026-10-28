/**
 * Horario para mensajes programados, de punta a punta: de noche (en la zona del negocio) lo que sale solo espera a la
 * hora de inicio; si el cliente está conversando sale normal; las campañas conservan su ritmo; los recordatorios de
 * cita se adelantan; y apagarlo deja todo como antes. Para que «sean las 22:00» sin falsear el reloj, la cuenta usa una
 * zona Etc/GMT±N en la que ahora es esa hora.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

// Después del arnés (que lo apaga para las demás pruebas): aquí se prueba encendido.
const { config } = await import('../src/config.js');
const { localParts, zonedToUtc } = await import('../src/automation/time.js');
const astore = await import('../src/automation/store.js');
const { advanceQuietReminders } = await import('../src/automation/agenda.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));

/** Una zona horaria en la que ahora son las `hour` (en Etc/GMT±N el signo va al revés). */
function zoneAt(hour: number) {
  let o = (hour - new Date().getUTCHours() + 48) % 24;
  if (o > 14) o -= 24;
  return o === 0 ? 'UTC' : o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`;
}
const NIGHT = zoneAt(22); // las 22:xx: de noche y lejos de la medianoche (las fechas esperadas no cambian a media prueba)
const settings = (body: Record<string, unknown>) => h.authed('PUT', `/api/settings?account_id=${h.accountId}`, body);
const local = (at: Date | string, tz = NIGHT) => localParts(new Date(at), tz);
const dayIn = (days: number, tz = NIGHT) => localParts(new Date(Date.now() + days * 86400_000), tz).date;
/** El cliente escribió hace dos horas: ya no está conversando. */
const quiet = (conversationId: string) => pool.query(`UPDATE messages SET created_at = created_at - interval '2 hours' WHERE conversation_id = $1`, [conversationId]);
const job = async (type: string, conversationId: string) => (await pool.query(`SELECT * FROM jobs WHERE type = $1 AND payload->>'conversation_id' = $2 ORDER BY id DESC LIMIT 1`, [type, conversationId])).rows[0];
/** Entre las 8:00 y las 8:29 del día siguiente: lo que esperó la noche se reparte en esa media hora. */
const morning = (at: Date | string, tz = NIGHT) => local(at, tz).date === dayIn(1, tz) && local(at, tz).time >= '08:00' && local(at, tz).time < '08:30';
const sentTo = (phone: string) => h.sent.filter((s) => s.to === phone && s.kind !== 'notify').map((s) => s.text.split('\n\n')[0]);

async function customer(phone: string, text: string) {
  await h.webhook(text, { phone });
  await h.idle();
  return h.conversationFor(phone);
}
async function rule(body: Record<string, unknown>) {
  const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, stop_ai: true, ...body });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

before(async () => {
  if (!ok) return;
  config.sendWindow.enforced = true;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Claro, te ayudo.'] }));
  const s = await settings({ timezone: NIGHT, business_hours: ALL_DAY, consent: { require_for_campaigns: false } });
  assert.equal(s.statusCode, 200, s.body);
  assert.deepEqual(s.json().sending.window, { enabled: true, start: '08:00', end: '21:00' }, 'encendido por omisión');
});
after(async () => {
  config.sendWindow.enforced = false;
  if (h) await h.app.close();
  await pool.end();
});

t('un mensaje de regla con espera que cae de noche espera a las 8:00 (sin gastar intentos) y sale de día', async () => {
  await rule({ name: 'Cotización después', trigger: { type: 'message_received', match: 'keywords', keywords: ['cotizar ya'] }, actions: [{ type: 'send_message', text: 'Aquí está tu cotización.', delay_minutes: 60 }] });
  const conv = await customer('5215530000001', 'cotizar ya');
  await quiet(conv.id);
  h.reset();
  await h.fastForward();
  assert.deepEqual(sentTo('5215530000001'), [], 'de noche no sale');
  const held = await job('automation_send', conv.id);
  assert.equal(held.status, 'pending');
  assert.equal(held.attempts, 0, 'esperar no gasta un intento');
  assert.equal(held.last_error, 'quiet_hours');
  assert.ok(morning(held.run_at), `mañana entre 8:00 y 8:29 (${local(held.run_at).date} ${local(held.run_at).time})`);
  const log = (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1 AND message LIKE 'Mensaje programado en espera%'`, [conv.id])).rows;
  assert.equal(log.length, 1, 'queda anotado en la conversación');

  // Ya de día (otra zona en la que ahora son las 12): lo que esperaba se vuelve a decidir en la próxima media hora y sale.
  assert.equal((await settings({ timezone: zoneAt(12) })).statusCode, 200);
  assert.ok(new Date((await job('automation_send', conv.id)).run_at).getTime() <= Date.now() + 30 * 60_000, 'al cambiar el horario ya no espera a mañana');
  await h.fastForward();
  assert.deepEqual(sentTo('5215530000001'), ['Aquí está tu cotización.']);
  await settings({ timezone: NIGHT });
});

t('si el cliente está conversando (escribió hace menos de 30 minutos), sale aunque sea de noche', async () => {
  await rule({ name: 'Cotización en vivo', trigger: { type: 'message_received', match: 'keywords', keywords: ['cotizar ahora'] }, actions: [{ type: 'send_message', text: 'Va tu cotización.', delay_minutes: 1 }] });
  const conv = await customer('5215530000002', 'cotizar ahora');
  h.reset();
  await h.fastForward();
  assert.deepEqual(sentTo('5215530000002'), ['Va tu cotización.']);
  assert.equal((await job('automation_send', conv.id)).status, 'done');
});

t('apagado, todo sale a su hora como antes; un cambio parcial de «sending» no lo vuelve a encender', async () => {
  assert.equal((await settings({ sending: { daily_cap_per_number: 0, window: { enabled: false, start: '08:00', end: '21:00' } } })).statusCode, 200);
  const partial = await settings({ sending: { daily_cap_per_number: 50 } });
  assert.equal(partial.json().sending.window.enabled, false, 'cambiar el tope diario no lo enciende');
  await rule({ name: 'Cotización apagado', trigger: { type: 'message_received', match: 'keywords', keywords: ['cotizar luego'] }, actions: [{ type: 'send_message', text: 'Tu cotización.', delay_minutes: 30 }] });
  const conv = await customer('5215530000003', 'cotizar luego');
  await quiet(conv.id);
  h.reset();
  await h.fastForward();
  assert.deepEqual(sentTo('5215530000003'), ['Tu cotización.']);
  const bad = await settings({ sending: { window: { enabled: true, start: '21:00', end: '08:00' } } });
  assert.equal(bad.statusCode, 400, 'empezar después de terminar se rechaza');
  assert.equal((await settings({ sending: { daily_cap_per_number: 0, window: { enabled: true, start: '08:00', end: '21:00' } } })).statusCode, 200);
});

t('flujos: un paso que cae de noche queda para las 8:00 (y el panel lo ve); el que inicia el equipo sale ya', async () => {
  const seq = (await h.authed('POST', '/api/sequences', {
    account_id: h.accountId, name: 'Seguimiento nocturno', business_hours_only: false, stop_on_reply: false,
    steps: [{ delay_value: 0, delay_unit: 'minutes', text: 'Hola, te escribe el equipo' }, { delay_value: 2, delay_unit: 'hours', text: 'Segundo mensaje' }],
  })).json();
  const conv = await customer('5215530000004', 'hola');
  await quiet(conv.id);
  h.reset();
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/sequences`, { sequence_id: seq.id })).statusCode, 200);
  assert.equal((await job('sequence_step', conv.id)).payload.team, true, 'el primer paso lo pidió el equipo');
  await h.service.scheduler.runDue();
  await h.idle();
  assert.deepEqual(sentTo('5215530000004'), ['Hola, te escribe el equipo'], 'lo que inicia el equipo sale aunque sea de noche');
  const next = await job('sequence_step', conv.id);
  assert.ok(morning(next.run_at), 'el siguiente, 2 h después, cae de noche: mañana a primera hora');
  // Forzado a correr ya (como lo atrasado tras una caída): vuelve a esperar y el panel ve la misma hora.
  await pool.query(`UPDATE sequence_enrollments SET next_run_at = NULL WHERE sequence_id = $1`, [seq.id]);
  await h.fastForward();
  assert.deepEqual(sentTo('5215530000004'), ['Hola, te escribe el equipo']);
  const held = await job('sequence_step', conv.id);
  const en = (await h.authed('GET', `/api/conversations/${conv.id}/automation`)).json().enrollments.find((e: any) => e.sequence_id === seq.id);
  assert.ok(en.next_run_at, 'la espera quedó anotada en el flujo');
  assert.equal(new Date(en.next_run_at).toISOString(), new Date(held.run_at).toISOString());
  assert.ok(morning(held.run_at));
});

t('«si no contesta»: el que solo pone etiquetas corre de noche; el que le escribe al cliente espera', async () => {
  const conv = await customer('5215530000005', 'una pregunta');
  await quiet(conv.id);
  const tag = await rule({ name: 'Marcar sin respuesta', stop_ai: false, trigger: { type: 'no_reply', minutes: 60 }, actions: [{ type: 'add_tag', tag: 'sin_respuesta' }] });
  const nudge = await rule({ name: 'Recordarle', stop_ai: false, trigger: { type: 'no_reply', minutes: 60 }, actions: [{ type: 'send_message', text: '¿Pudiste verlo?' }] });
  const last = (await pool.query(`SELECT max(id)::int AS id FROM messages WHERE conversation_id = $1`, [conv.id])).rows[0].id;
  await pool.query(`UPDATE jobs SET status = 'cancelled' WHERE type = 'no_reply' AND status = 'pending'`);
  for (const r of [tag, nudge]) await astore.scheduleJob({ account_id: h.accountId, type: 'no_reply', payload: { automation_id: r.id, conversation_id: conv.id, after_message_id: last }, run_at: new Date(Date.now() - 1000) });
  h.reset();
  await h.service.scheduler.runDue();
  await h.idle();
  const contact = (await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [conv.contact_id])).rows[0];
  assert.ok(contact.tags.includes('sin_respuesta'), 'la etiqueta se puso de noche');
  assert.deepEqual(sentTo('5215530000005'), [], 'el mensaje al cliente espera');
  const held = (await pool.query(`SELECT * FROM jobs WHERE type = 'no_reply' AND payload->>'automation_id' = $1`, [nudge.id])).rows[0];
  assert.equal(held.status, 'pending');
  assert.ok(morning(held.run_at));
  await pool.query(`UPDATE jobs SET status = 'cancelled' WHERE type = 'no_reply' AND status = 'pending'`);
  await pool.query(`UPDATE automations SET active = false WHERE id = ANY($1)`, [[tag.id, nudge.id]]);
});

t('campañas lanzadas de noche: empiezan a las 8:00 con su ritmo, y lo atrasado tampoco sale todo junto', async () => {
  for (const p of ['5215530000011', '5215530000012', '5215530000013']) await quiet((await customer(p, 'hola')).id);
  const r = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Promo nocturna', message: 'Promo de temporada', business_hours_only: false, rate_per_minute: 1 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await h.authed('POST', `/api/campaigns/${r.json().id}/launch`)).statusCode, 200);
  const runAts = async () => (await pool.query(`SELECT run_at FROM jobs WHERE type = 'campaign_send' AND status = 'pending' AND payload->>'campaign_id' = $1 ORDER BY run_at`, [r.json().id])).rows.map((x) => new Date(x.run_at));
  const planned = await runAts();
  assert.ok(planned.length >= 3);
  assert.deepEqual([local(planned[0]).date, local(planned[0]).time], [dayIn(1), '08:00'], 'el primero, a la hora de inicio');
  assert.equal(planned[1].getTime() - planned[0].getTime(), 60_000, 'y conserva el ritmo (1 por minuto)');
  // Todos vencidos de golpe (como tras una caída) y de noche: vuelven a esperar, cada uno en su turno (nadie conversando).
  await pool.query(`UPDATE messages SET created_at = created_at - interval '2 hours'`);
  h.reset();
  await h.fastForward();
  assert.equal(h.sent.filter((s) => s.text.startsWith('Promo de temporada')).length, 0);
  const held = await runAts();
  assert.equal(held.length, planned.length);
  for (let i = 1; i < held.length; i++) assert.ok(held[i].getTime() - held[i - 1].getTime() >= 60_000, 'sin salir todos juntos');
  assert.deepEqual([local(held[0]).date, local(held[0]).time >= '08:00'], [dayIn(1), true], 'mañana desde la hora de inicio');
  await h.authed('POST', `/api/campaigns/${r.json().id}/cancel`);
});

t('recordatorios de cita ya programados de noche: se adelantan antes de la noche, salen a las 8:00 si aún da tiempo, o salen como uno', async () => {
  const mk = (appt: string, starts: Date, minutes: number) => astore.scheduleJob({ account_id: h.accountId, type: 'appointment_reminder', payload: { appointment_id: appt, minutes, starts_at: starts.toISOString() }, run_at: new Date(starts.getTime() - minutes * 60_000), dedupe_key: `reminder:${appt}:${minutes}` });
  const rows = async (appt: string) => Object.fromEntries((await pool.query(`SELECT payload->>'minutes' AS m, status, run_at FROM jobs WHERE type = 'appointment_reminder' AND payload->>'appointment_id' = $1`, [appt])).rows.map((x) => [x.m, x]));
  // Pasado mañana a las 8:30: el de un día antes cae de día; los de 2 h y 1 h (6:30 y 7:30) se adelantan a la noche anterior y salen como uno.
  const a = '00000000-0000-4000-8000-000000000001';
  for (const m of [1440, 120, 60]) await mk(a, zonedToUtc(dayIn(2), '08:30', NIGHT), m);
  // Mañana a las 8:30 y a las 7:45, con aviso 1 h antes (7:30 y 6:45): adelantarlos a esta noche ya pasó (son las 22:xx).
  const b = '00000000-0000-4000-8000-000000000002';
  const c = '00000000-0000-4000-8000-000000000003';
  await mk(b, zonedToUtc(dayIn(1), '08:30', NIGHT), 60);
  await mk(c, zonedToUtc(dayIn(1), '07:45', NIGHT), 60);
  assert.ok((await advanceQuietReminders(h.accountId)) >= 4);
  const ra = await rows(a);
  assert.deepEqual([ra['1440'].status, local(ra['1440'].run_at).time], ['pending', '08:30'], 'el que cae de día no se mueve');
  assert.equal(ra['120'].status, 'pending');
  assert.equal(local(ra['120'].run_at).date, dayIn(1));
  assert.ok(local(ra['120'].run_at).time >= '20:30' && local(ra['120'].run_at).time <= '20:59', 'la noche anterior, antes de las 21:00');
  assert.equal(ra['60'].status, 'cancelled', 'el de 1 h quedaría a la misma hora: sale uno');
  assert.deepEqual([(await rows(b))['60'].status, local((await rows(b))['60'].run_at).time], ['pending', '08:00'], 'a las 8:00 aún es antes de la cita de las 8:30');
  assert.equal((await rows(c))['60'].status, 'cancelled', 'a las 8:00 la cita de las 7:45 ya empezó');
  await pool.query(`UPDATE jobs SET status = 'cancelled' WHERE type = 'appointment_reminder' AND status = 'pending'`);
});

t('cobros con hora de envío de noche: salen ese mismo día antes de la noche', async () => {
  const conv = await customer('5215530000020', 'hola, ¿cuánto debo?');
  const s = await h.authed('PUT', `/api/receivables/settings?account_id=${h.accountId}`, { default_reminders: [-1], send_at: '22:30', respect_business_hours: false });
  assert.equal(s.statusCode, 200, s.body);
  const r = await h.authed('POST', `/api/receivables?account_id=${h.accountId}`, { contact_id: conv.contact_id, concept: 'Mensualidad', amount_cents: 100000, due_date: dayIn(5) });
  assert.equal(r.statusCode, 201, r.body);
  const jobs = (await pool.query(`SELECT type, run_at FROM jobs WHERE status = 'pending' AND payload->>'receivable_id' = $1 ORDER BY run_at`, [r.json().receivable.id])).rows;
  assert.ok(jobs.length >= 2);
  for (const j of jobs) assert.ok(local(j.run_at).time >= '20:30' && local(j.run_at).time <= '20:59', `${j.type}: antes de la noche, no a las 22:30 (${local(j.run_at).time})`);
  assert.deepEqual(jobs.map((j) => local(j.run_at).date), [dayIn(4), dayIn(6)], 'el mismo día que tocaba (recordatorio y aviso de vencido)');
});

t('una tarea que vuelve a esperar y choca con otra pendiente de la misma clave: gana la más nueva', async () => {
  const running = (await pool.query(`INSERT INTO jobs (account_id, type, payload, run_at, status, attempts, dedupe_key) VALUES ($1, 'automation_send', '{}', now(), 'running', 1, 'prueba:choque') RETURNING id`, [h.accountId])).rows[0];
  await pool.query(`INSERT INTO jobs (account_id, type, payload, run_at, dedupe_key) VALUES ($1, 'automation_send', '{}', now() + interval '1 hour', 'prueba:choque')`, [h.accountId]);
  assert.equal(await astore.holdJob(Number(running.id), new Date(Date.now() + 3600_000)), false);
  assert.equal((await pool.query(`SELECT status FROM jobs WHERE id = $1`, [running.id])).rows[0].status, 'cancelled');
  await pool.query(`UPDATE jobs SET status = 'cancelled' WHERE dedupe_key = 'prueba:choque'`);
});
