/**
 * Página pública para reservar (como Calendly): enlaces del negocio o de una persona, la página sin sesión, la reserva con
 * la persona elegida o la del enlace, la confirmación y el recordatorio por correo y el aviso a quien atiende.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';
const { outbox } = await import('../src/mailer.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const people: Record<string, { id: string; api: Awaited<ReturnType<typeof h.loginAs>> }> = {};
let call: any;
let video: any;
let link: any;
const pub = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, ...(payload ? { payload } : {}) });
const tokenOf = (url: string) => url.split('/').pop()!;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const name of ['ana', 'beto']) {
    const r = await h.authed('POST', '/api/users', { account_id: h.accountId, email: `${name}@reservas.mx`, password: 'secreto123', name: name[0].toUpperCase() + name.slice(1), role: 'agent' });
    people[name] = { id: r.json().id, api: await h.loginAs(`${name}@reservas.mx`, 'secreto123') };
  }
  const svc = async (body: Record<string, unknown>) => (await h.authed('POST', '/api/services', { account_id: h.accountId, duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 14, ...body })).json();
  call = await svc({ name: 'Llamada de diagnóstico', kind: 'call', assigned_user_ids: [people.ana.id, people.beto.id], customer_choice: true });
  video = await svc({ name: 'Asesoría en video', kind: 'call', call_mode: 'video', assigned_user_ids: [people.ana.id] });
  await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { hours: null, time_off: [], meeting_url: 'https://zoom.us/j/999' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('enlaces: solo el administrador los crea, con servicios y personas del negocio', async () => {
  assert.equal((await people.ana.api('POST', '/api/booking-links', { name: 'Mío' })).statusCode, 403);
  const other = (await h.authed('POST', '/api/accounts', { name: 'Otro negocio' })).json();
  const foreign = (await h.authed('POST', '/api/services', { account_id: other.id, name: 'Ajeno' })).json();
  assert.equal((await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Mal', service_ids: [foreign.id] })).statusCode, 400);
  const r = await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Agenda una llamada', service_ids: [call.id] });
  assert.equal(r.statusCode, 200, r.body);
  link = r.json();
  assert.match(link.url, /^https:\/\/bot\.test\/reservar\/[\w-]{16}$/);
  assert.deepEqual(link.services, ['Llamada de diagnóstico']);
  const list = (await h.authed('GET', `/api/booking-links?account_id=${h.accountId}`)).json();
  assert.equal(list.length, 1);
});

t('la página pública muestra el negocio, los servicios y las personas, sin iniciar sesión', async () => {
  const token = tokenOf(link.url);
  const html = await pub('GET', `/reservar/${token}`);
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /\/reservar\.js/);
  assert.equal(html.headers['cache-control'], 'no-store');
  const info = (await pub('GET', `/api/public/booking/${token}`)).json();
  assert.equal(info.title, 'Agenda una llamada');
  assert.equal(info.business.name, 'Cuenta de pruebas');
  assert.deepEqual(info.services.map((s: any) => [s.name, s.call_mode, s.people.map((p: any) => p.name)]), [['Llamada de diagnóstico', 'phone', ['Ana', 'Beto']]]);
  assert.ok(!JSON.stringify(info).includes('@reservas.mx'), 'no expone correos del equipo');
  assert.equal((await pub('GET', '/api/public/booking/no-existe-este')).statusCode, 404);
  const all = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json();
  const beto = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}&person_id=${people.beto.id}`)).json();
  assert.ok(all.length > 0 && beto.length > 0 && beto.length <= all.length);
  assert.equal((await pub('GET', `/api/public/booking/${token}/slots?service_id=${video.id}`)).statusCode, 404, 'el servicio no está en el enlace');
});

t('reservar: valida datos, agenda con la persona elegida, confirma por correo y avisa a quien atiende', async () => {
  const token = tokenOf(link.url);
  const slot = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}&person_id=${people.beto.id}`)).json()[0];
  const body = { service_id: call.id, slot: slot.key, person_id: people.beto.id, name: 'Lucía Pérez', email: 'lucia@cliente.mx', phone: '+52 55 1234 5678', notes: 'Prefiero por la tarde' };
  assert.equal((await pub('POST', `/api/public/booking/${token}`, { ...body, email: 'no-es-correo' })).statusCode, 400);
  const noPhone = await pub('POST', `/api/public/booking/${token}`, { ...body, phone: '' });
  assert.equal(noPhone.statusCode, 400);
  assert.match(noPhone.json().error, /teléfono/);
  // Un robot llena el campo trampa: parece que funcionó, pero no se agenda.
  assert.deepEqual((await pub('POST', `/api/public/booking/${token}`, { ...body, website: 'http://spam' })).json(), { ok: true });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE source = 'pagina'`)).rows[0].n, 0);

  outbox.length = 0;
  const r = await pub('POST', `/api/public/booking/${token}`, body);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().person, 'Beto');
  const a = (await pool.query(`SELECT * FROM appointments WHERE source = 'pagina'`)).rows[0];
  assert.deepEqual([a.assigned_user_id, a.customer_email, a.customer_phone, a.customer_name], [people.beto.id, 'lucia@cliente.mx', '525512345678', 'Lucía Pérez']);
  assert.match(a.notes, /Reservó en la página: Agenda una llamada/);
  const toClient = outbox.find((m) => m.to === 'lucia@cliente.mx')!;
  assert.match(toClient.subject, /Tu llamada quedó agendada: Llamada de diagnóstico/);
  assert.match(toClient.text, /con Beto/);
  assert.match(toClient.text, /Te llamaremos al \+525512345678/);
  assert.match(outbox.find((m) => m.to === 'beto@reservas.mx')!.subject, /Nueva llamada contigo/);
  // El mismo horario con Beto ya no está.
  assert.equal((await pub('POST', `/api/public/booking/${token}`, body)).statusCode, 409);
  // Recordatorio por correo (sin conversación).
  outbox.length = 0;
  await h.service.agenda.sendReminder({ appointment_id: a.id });
  assert.match(outbox.find((m) => m.to === 'lucia@cliente.mx')!.subject, /Recordatorio: tu llamada/);
});

t('enlace de una persona: solo sus servicios y siempre con ella; la videollamada lleva su enlace; pausado ya no sirve', async () => {
  const mine = (await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Agenda con Ana', user_id: people.ana.id })).json();
  const token = tokenOf(mine.url);
  const info = (await pub('GET', `/api/public/booking/${token}`)).json();
  assert.equal(info.person, 'Ana');
  assert.deepEqual(info.services.map((s: any) => s.name).sort(), ['Asesoría en video', 'Llamada de diagnóstico']);
  assert.ok(info.services.every((s: any) => !s.people.length), 'en el enlace de una persona no se elige a otra');
  const slot = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${video.id}`)).json()[0];
  outbox.length = 0;
  const r = await pub('POST', `/api/public/booking/${token}`, { service_id: video.id, slot: slot.key, name: 'Mario', email: 'mario@cliente.mx' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().person, r.json().meeting_url], ['Ana', 'https://zoom.us/j/999']);
  assert.match(outbox.find((m) => m.to === 'mario@cliente.mx')!.text, /Entra a la videollamada aquí: https:\/\/zoom\.us\/j\/999/);
  // Pedir a Beto en el enlace de Ana no cambia a la persona.
  const s2 = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json()[0];
  const r2 = await pub('POST', `/api/public/booking/${token}`, { service_id: call.id, slot: s2.key, person_id: people.beto.id, name: 'Mario', email: 'mario@cliente.mx', phone: '5512345678' });
  assert.equal(r2.json().person, 'Ana');
  // Pausado: la página ya no funciona.
  assert.equal((await h.authed('PUT', `/api/booking-links/${mine.id}?account_id=${h.accountId}`, { active: false })).statusCode, 200);
  assert.equal((await pub('GET', `/api/public/booking/${token}`)).statusCode, 404);
  assert.equal((await h.authed('DELETE', `/api/booking-links/${mine.id}?account_id=${h.accountId}`)).statusCode, 200);
});
