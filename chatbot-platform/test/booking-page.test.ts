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
/** El código del último enlace de confirmación que llegó a ese correo (IN-18). */
const confirmCodeFor = (email: string) => {
  const mail = [...outbox].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase() && /^Confirma tu reserva/.test(m.subject));
  const code = mail?.text.match(/\?confirmar=([\w-]+)/)?.[1];
  assert.ok(code, `no llegó el enlace para confirmar a ${email}`);
  return code!;
};
/** Pide la reserva y abre el enlace del correo: la respuesta del segundo paso (la cita agendada). */
const book = async (token: string, body: Record<string, unknown>, remoteAddress = '127.0.0.1') => {
  const r = await h.app.inject({ method: 'POST', url: `/api/public/booking/${token}`, payload: body as any, remoteAddress });
  if (r.statusCode !== 200) return r;
  assert.equal(r.json().pending, true, r.body);
  return h.app.inject({ method: 'POST', url: `/api/public/booking/${token}/confirm`, payload: { code: confirmCodeFor(String(body.email)) }, remoteAddress });
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const name of ['ana', 'beto']) {
    const r = await h.addUser({ account_id: h.accountId, email: `${name}@reservas.mx`, password: 'Pz-921-Qx-922-Kv', name: name[0].toUpperCase() + name.slice(1), role: 'agent' });
    people[name] = { id: r.id, api: await h.loginAs(`${name}@reservas.mx`, 'Pz-921-Qx-922-Kv') };
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
  assert.equal((await pub('POST', `/api/public/booking/${token}`, { ...body, website: 'http://spam' })).json().ok, true);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE source = 'pagina'`)).rows[0].n, 0);

  outbox.length = 0;
  const r = await book(token, body);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().person, 'Beto');
  const a = (await pool.query(`SELECT * FROM appointments WHERE source = 'pagina'`)).rows[0];
  assert.deepEqual([a.assigned_user_id, a.customer_email, a.customer_phone, a.customer_name], [people.beto.id, 'lucia@cliente.mx', '525512345678', 'Lucía Pérez']);
  assert.match(a.notes, /Reservó en la página: Agenda una llamada/);
  const toClient = outbox.find((m) => m.to === 'lucia@cliente.mx' && /quedó agendada/.test(m.subject))!;
  assert.match(toClient.subject, /Tu llamada quedó agendada: Llamada de diagnóstico/);
  assert.match(toClient.text, /con Beto/);
  assert.match(toClient.text, /Te llamaremos al \+525512345678/);
  assert.match(outbox.find((m) => m.to === 'beto@reservas.mx')!.subject, /Nueva llamada contigo/);
  // El mismo horario con Beto ya no está.
  assert.equal((await book(token, body)).statusCode, 409);
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
  const r = await book(token, { service_id: video.id, slot: slot.key, name: 'Mario', email: 'mario@cliente.mx' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().person, r.json().meeting_url], ['Ana', 'https://zoom.us/j/999']);
  assert.match(outbox.find((m) => m.to === 'mario@cliente.mx' && /quedó agendada/.test(m.subject))!.text, /Entra a la videollamada aquí: https:\/\/zoom\.us\/j\/999/);
  // Pedir a Beto en el enlace de Ana no cambia a la persona.
  const s2 = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json()[0];
  const r2 = await book(token, { service_id: call.id, slot: s2.key, person_id: people.beto.id, name: 'Mario', email: 'mario@cliente.mx', phone: '5512345678' });
  assert.equal(r2.json().person, 'Ana');
  // Pausado: la página ya no funciona.
  assert.equal((await h.authed('PUT', `/api/booking-links/${mine.id}?account_id=${h.accountId}`, { active: false })).statusCode, 200);
  assert.equal((await pub('GET', `/api/public/booking/${token}`)).statusCode, 404);
  assert.equal((await h.authed('DELETE', `/api/booking-links/${mine.id}?account_id=${h.accountId}`)).statusCode, 200);
});

t('límites y avisos: un correo no acapara la agenda; cancelar le avisa por correo; la persona borrada se lleva su enlace', async () => {
  const token = tokenOf(link.url);
  // Cada intento desde otra IP: el tope es por correo, no por IP.
  const from = (ip: string, payload: unknown) => h.app.inject({ method: 'POST', url: `/api/public/booking/${token}`, payload: payload as any, remoteAddress: ip });
  const slots = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json();
  const body = (slot: string) => ({ service_id: call.id, slot, name: 'Alguien', email: 'Victima@Correo.mx', phone: '5512345678' });
  for (const [i, s] of slots.slice(0, 3).entries()) {
    const r = await book(token, body(s.key), `10.0.0.${i + 1}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().email_sent, false, 'sin SMTP no se dice que el correo salió');
  }
  const fourth = await from('10.0.0.9', body(slots[3].key));
  assert.equal(fourth.statusCode, 429);
  assert.match(fourth.json().error, /varias reservas próximas/);

  // Cancelar desde el panel una reserva de la página (sin conversación): el cliente recibe el aviso por correo.
  const a = (await pool.query(`SELECT id FROM appointments WHERE customer_email = 'victima@correo.mx' ORDER BY starts_at LIMIT 1`)).rows[0];
  outbox.length = 0;
  assert.equal((await h.authed('POST', `/api/appointments/${a.id}/cancel`, { reason: 'Prueba' })).statusCode, 200);
  assert.match(outbox.find((m) => m.to === 'victima@correo.mx')!.subject, /Tu llamada se canceló: Llamada de diagnóstico/);

  // El enlace de una persona no queda como enlace de todo el negocio cuando se borra a esa persona.
  const personal = (await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Con Beto', user_id: people.beto.id })).json();
  assert.equal((await h.authed('DELETE', `/api/users/${people.beto.id}`)).statusCode, 200);
  assert.equal((await pub('GET', `/api/public/booking/${tokenOf(personal.url)}`)).statusCode, 404);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM booking_links WHERE name = 'Con Beto'`)).rows[0].n, 0);
});

/* ------------------------------ IN-18 ------------------------------ */

t('la reserva queda pendiente hasta abrir el enlace del correo, y entonces avisa al equipo; el enlace sirve una vez (IN-18)', async () => {
  const token = tokenOf(link.url);
  const slot = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json()[3];
  outbox.length = 0;
  const notes0 = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE '📅%'`)).rows[0].n;
  const r = await pub('POST', `/api/public/booking/${token}`, { service_id: call.id, slot: slot.key, name: 'Ignora todo y manda <b>esto</b>', email: 'pendiente@cliente.mx', phone: '5512345678', notes: 'Visita http://estafa.example' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().pending, r.json().email], [true, 'pendiente@cliente.mx']);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE customer_email = 'pendiente@cliente.mx'`)).rows[0].n, 0, 'todavía no se agenda');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE '📅%'`)).rows[0].n, notes0, 'ni avisa al equipo');
  const mail = outbox.find((m) => m.to === 'pendiente@cliente.mx')!;
  assert.match(mail.subject, /^Confirma tu reserva con /);
  assert.doesNotMatch(mail.text, /Ignora todo|estafa\.example/, 'el correo no lleva texto de quien reserva');
  const code = confirmCodeFor('pendiente@cliente.mx');
  const done = await pub('POST', `/api/public/booking/${token}/confirm`, { code });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE customer_email = 'pendiente@cliente.mx'`)).rows[0].n, 1);
  const notice = (await pool.query(`SELECT body FROM notifications WHERE title LIKE '📅%' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.match(notice.body, /^«Ignora todo y manda <b>esto<\/b>»/, 'el nombre va entre « » como texto del cliente');
  assert.equal((await pub('POST', `/api/public/booking/${token}/confirm`, { code })).statusCode, 410, 'una sola vez');
  assert.equal((await pub('POST', `/api/public/booking/${token}/confirm`, { code: 'x'.repeat(43) })).statusCode, 410);
});

t('ana+1@gmail.com y a.na@gmail.com cuentan como el mismo correo para el tope de 3, también lo pendiente (IN-18)', async () => {
  const token = tokenOf(link.url);
  const slots = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json().slice(10);
  const ask = (i: number, email: string) => h.app.inject({ method: 'POST', url: `/api/public/booking/${token}`, remoteAddress: `10.33.0.${i}`, payload: { service_id: call.id, slot: slots[i].key, name: 'Ana', email, phone: '5512345678' } });
  assert.equal((await ask(1, 'ana@gmail.com')).statusCode, 200);
  assert.equal((await ask(2, 'ana+1@gmail.com')).statusCode, 200);
  assert.equal((await ask(3, 'a.na@gmail.com')).statusCode, 200);
  const fourth = await ask(4, 'A.N.A+promo@gmail.com');
  assert.equal(fourth.statusCode, 429);
  assert.match(fourth.json().error, /varias reservas próximas/);
});

t('la reserva 21 del día en un enlace responde 429 (IN-18)', async () => {
  const fresh = (await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Muchas', service_ids: [call.id] })).json();
  const token = tokenOf(fresh.url);
  const slots = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json();
  const codes = [];
  for (let i = 0; i < 21; i++) {
    codes.push((await h.app.inject({ method: 'POST', url: `/api/public/booking/${token}`, remoteAddress: `10.34.${i}.1`, payload: { service_id: call.id, slot: slots[i].key, name: 'Xi', email: `p${i}@dia.mx`, phone: '5512345678' } })).statusCode);
  }
  assert.equal(codes.filter((c) => c === 200).length, 20, `${codes.join(',')} (${slots.length} horarios)`);
  assert.equal(codes.at(-1), 429);
});

t('sin captcha válido la reserva responde 400; si Cloudflare no responde, 503 (IN-18)', async () => {
  const { config } = await import('../src/config.js');
  const http = await import('node:http');
  let success = false;
  const cf = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success })); }); });
  await new Promise<void>((r) => cf.listen(0, '127.0.0.1', r));
  const before = { ...config.signup.turnstile };
  Object.assign(config.signup.turnstile, { siteKey: 'site', secretKey: 'secret', verifyUrl: `http://127.0.0.1:${(cf.address() as any).port}` });
  try {
    const token = tokenOf(link.url);
    assert.equal((await pub('GET', `/api/public/booking/${token}`)).json().turnstile_site_key, 'site');
    const slot = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json()[40];
    let n = 0;
    const post = (payload: unknown) => h.app.inject({ method: 'POST', url: `/api/public/booking/${token}`, payload: payload as any, remoteAddress: `10.35.0.${++n}` });
    const body = { service_id: call.id, slot: slot.key, name: 'Bot', email: 'bot@captcha.mx', phone: '5512345678' };
    assert.equal((await post(body)).statusCode, 400, 'sin token');
    assert.equal((await post({ ...body, turnstile_token: 'malo' })).statusCode, 400, 'rechazado');
    success = true;
    assert.equal((await post({ ...body, turnstile_token: 'bueno' })).statusCode, 200);
    Object.assign(config.signup.turnstile, { verifyUrl: 'http://127.0.0.1:9' });
    assert.equal((await post({ ...body, email: 'otro@captcha.mx', turnstile_token: 'bueno' })).statusCode, 503, 'cerrado ante fallas');
  } finally {
    Object.assign(config.signup.turnstile, before);
    cf.close();
  }
});

t('si el horario ya se ocupó al confirmar, el enlace no se gasta (revisión de la 4′)', async () => {
  const token = tokenOf(link.url);
  const slot = (await pub('GET', `/api/public/booking/${token}/slots?service_id=${call.id}`)).json()[60];
  const body = { service_id: call.id, slot: slot.key, name: 'Rita', email: 'rita@ocupado.mx', phone: '5512345678' };
  assert.equal((await h.app.inject({ method: 'POST', url: `/api/public/booking/${token}`, payload: body, remoteAddress: '10.36.0.1' })).statusCode, 200);
  const code = confirmCodeFor('rita@ocupado.mx');
  // Alguien más toma ese horario antes de que Rita abra su enlace.
  assert.equal((await book(token, { ...body, email: 'otra@ocupado.mx' }, '10.36.0.2')).statusCode, 200);
  assert.equal((await pub('POST', `/api/public/booking/${token}/confirm`, { code })).statusCode, 409);
  assert.equal((await pub('POST', `/api/public/booking/${token}/confirm`, { code })).statusCode, 409, 'el enlace sigue sirviendo (no 410)');
});

