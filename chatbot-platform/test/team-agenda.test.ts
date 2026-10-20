/**
 * Agenda del equipo: varias personas por servicio, reparto por turnos o por porcentajes, citas al mismo tiempo por
 * persona, horario y días libres de cada quien, y el calendario propio de cada persona (Google u Outlook).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
const { outbox } = await import('../src/mailer.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

/* ---------- Google y Microsoft falsos: cada persona tiene su propio calendario (se distingue por su permiso) ---------- */
const gBusy: Record<string, { start: string; end: string }[]> = {};
const gEvents = new Map<string, { owner: string; body: any }>();
const oEvents = new Map<string, { owner: string; body: any }>();
let n = 0;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body: any = raw;
    try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const url = new URL(req.url!, base);
    const owner = String(req.headers.authorization ?? '').replace(/^Bearer a-/, '');
    // Permisos: el código «c» entrega el permiso «r-c» y el acceso «a-c».
    const grant = () => {
      const who = body.grant_type === 'authorization_code' ? body.code : String(body.refresh_token).replace(/^r-/, '');
      return { access_token: `a-${who}`, refresh_token: `r-${who}`, expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: `${who}@gmail.com` })).toString('base64url')}.y` };
    };
    if (url.pathname === '/token' || url.pathname === '/common/oauth2/v2.0/token') return send(200, grant());
    if (url.pathname === '/revoke') return send(200, {});
    if (url.pathname.endsWith('/freeBusy')) return send(200, { calendars: { primary: { busy: gBusy[owner] ?? [] } } });
    if (url.pathname.includes('/calendar/v3/') && url.pathname.includes('/events')) {
      const id = decodeURIComponent(url.pathname.split('/events/')[1] ?? '');
      // Videollamada: con conferenceDataVersion=1 y createRequest, Google crea la sala de Meet.
      const meet = (e: string) => (url.searchParams.get('conferenceDataVersion') === '1' && body.conferenceData?.createRequest ? { hangoutLink: `https://meet.google.com/${e}-sala` } : {});
      if (req.method === 'POST') { const e = `g${++n}`; gEvents.set(e, { owner, body }); return send(200, { id: e, ...meet(e) }); }
      if (req.method === 'PUT') { if (!gEvents.has(id)) return send(404, {}); gEvents.set(id, { owner, body }); return send(200, { id, ...meet(id) }); }
      if (req.method === 'DELETE') { gEvents.delete(id); res.writeHead(204); return res.end(); }
    }
    if (url.pathname === '/v1.0/me') return send(200, { mail: `${owner}@outlook.com` });
    if (url.pathname === '/v1.0/me/calendarView') return send(200, { value: [] });
    if (url.pathname.startsWith('/v1.0/me/events')) {
      const id = decodeURIComponent(url.pathname.split('/events/')[1] ?? '');
      // Videollamada: con isOnlineMeeting, Outlook crea la reunión de Teams.
      const teams = (e: string) => (body.isOnlineMeeting ? { onlineMeeting: { joinUrl: `https://teams.microsoft.com/l/${e}` } } : {});
      if (req.method === 'POST') { const e = `o${++n}`; oEvents.set(e, { owner, body }); return send(201, { id: e, ...teams(e) }); }
      if (req.method === 'PATCH') { if (!oEvents.has(id)) return send(404, {}); oEvents.set(id, { owner, body }); return send(200, { id, ...teams(id) }); }
      if (req.method === 'DELETE') { oEvents.delete(id); res.writeHead(204); return res.end(); }
    }
    send(404, { error: { message: `sin ruta ${url.pathname}` } });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_OAUTH_URL: base, GOOGLE_API_URL: base, GOOGLE_AUTH_URL: `${base}/auth`,
  MICROSOFT_CLIENT_ID: '11111111-2222-3333-4444-555555555555', MICROSOFT_CLIENT_SECRET: 'msecret', MICROSOFT_LOGIN_URL: base, MICROSOFT_GRAPH_URL: base,
});

const people: Record<string, { id: string; api: Awaited<ReturnType<typeof h.loginAs>> }> = {};
const createService = async (body: Record<string, unknown>) => {
  const r = await h.authed('POST', '/api/services', { account_id: h.accountId, duration_minutes: 60, min_notice_minutes: 0, max_days_ahead: 30, assigned_user_ids: [people.ana.id, people.beto.id], ...body });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const slotsOf = async (serviceId: string) => (await h.authed('GET', `/api/services/${serviceId}/slots?days=30`)).json() as { key: string; date: string; users: string[] }[];
const book = (serviceId: string, slot: string, extra: Record<string, unknown> = {}) =>
  h.authed('POST', '/api/appointments', { service_id: serviceId, slot, customer_name: 'Cliente', customer_phone: '5215500001111', notify_customer: false, ...extra });
const who = (id: string | null) => Object.entries(people).find(([, p]) => p.id === id)?.[0] ?? null;
const sync = () => waitFor(async () => { await h.fastForward(); return (await pool.query(`SELECT 1 FROM jobs WHERE type = 'staff_cal_sync' AND status IN ('pending','running')`)).rowCount === 0; }, 8000);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const name of ['ana', 'beto']) {
    const r = await h.authed('POST', '/api/users', { account_id: h.accountId, email: `${name}@equipo.mx`, password: 'secreto123', name: name[0].toUpperCase() + name.slice(1), role: 'agent' });
    assert.equal(r.statusCode, 200, r.body);
    people[name] = { id: r.json().id, api: await h.loginAs(`${name}@equipo.mx`, 'secreto123') };
  }
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
  server.close();
});

t('reparto: por turnos alterna; por porcentajes se acerca a lo pedido; con 0 % solo si nadie más puede', async () => {
  const { pickStaff } = await import('../src/automation/staff.js');
  const stats = new Map<string, { last: Date | null; count: number }>([['a', { last: null, count: 0 }], ['b', { last: null, count: 0 }]]);
  const rr = { assigned_user_ids: ['a', 'b'], user_weights: {}, assignment_mode: 'round_robin' as const };
  const seq: string[] = [];
  for (let i = 0; i < 4; i++) {
    const u = pickStaff(rr, ['a', 'b'], stats)!;
    seq.push(u);
    stats.set(u, { last: new Date(1000 + i), count: stats.get(u)!.count + 1 });
  }
  assert.deepEqual(seq, ['a', 'b', 'a', 'b']);
  assert.equal(pickStaff(rr, ['b'], stats), 'b', 'si solo una está libre, le toca a ella');

  const w = { assigned_user_ids: ['a', 'b'], user_weights: { a: 70, b: 30 }, assignment_mode: 'weighted' as const };
  const counts = new Map<string, { last: Date | null; count: number }>([['a', { last: null, count: 0 }], ['b', { last: null, count: 0 }]]);
  for (let i = 0; i < 10; i++) {
    const u = pickStaff(w, ['a', 'b'], counts)!;
    counts.set(u, { last: new Date(i), count: counts.get(u)!.count + 1 });
  }
  assert.deepEqual([counts.get('a')!.count, counts.get('b')!.count], [7, 3]);
  const zero = { ...w, user_weights: { a: 100, b: 0 } };
  assert.equal(pickStaff(zero, ['a', 'b'], counts), 'a');
  assert.equal(pickStaff(zero, ['b'], counts), 'b', 'con 0 % recibe solo si nadie más está libre');
});

t('por turnos: las citas se alternan; a la misma hora cada persona atiende una y la tercera ya no cabe', async () => {
  const svc = await createService({ name: 'Consulta', assignment_mode: 'round_robin', capacity: 1 });
  const slots = await slotsOf(svc.id);
  assert.deepEqual([...slots[0].users].sort(), [people.ana.id, people.beto.id].sort(), 'el horario dice quién está libre');
  const assigned: (string | null)[] = [];
  for (const s of slots.slice(0, 4)) {
    const r = await book(svc.id, s.key);
    assert.equal(r.statusCode, 200, r.body);
    assigned.push(who(r.json().assigned_user_id));
  }
  assert.deepEqual(assigned, ['ana', 'beto', 'ana', 'beto']);

  // Misma hora: cada persona puede tener una cita; la tercera no cabe.
  const same = slots[10].key;
  const a = (await book(svc.id, same)).json();
  const b = (await book(svc.id, same)).json();
  assert.notEqual(a.assigned_user_id, b.assigned_user_id);
  assert.equal((await book(svc.id, same)).statusCode, 409);
  assert.ok(!(await slotsOf(svc.id)).some((s) => s.key === same), 'el horario ya no se ofrece');

  // Si cada persona puede atender a dos al mismo tiempo (clase grupal), vuelve a haber lugar.
  assert.equal((await h.authed('PUT', `/api/services/${svc.id}`, { capacity: 2 })).statusCode, 200);
  assert.ok((await slotsOf(svc.id)).some((s) => s.key === same));
  assert.equal((await book(svc.id, same)).statusCode, 200);
});

t('por porcentajes: 70 / 30 entre Ana y Beto', async () => {
  const svc = await createService({ name: 'Asesoría', assignment_mode: 'weighted', user_weights: { [people.ana.id]: 70, [people.beto.id]: 30 } });
  // Horarios donde las dos personas están libres (sin las citas de la prueba anterior).
  const slots = (await slotsOf(svc.id)).filter((s) => s.users.length === 2);
  const tally: Record<string, number> = { ana: 0, beto: 0 };
  for (let i = 0; i < 10; i++) {
    const r = await book(svc.id, slots[i * 3].key);
    assert.equal(r.statusCode, 200, r.body);
    tally[who(r.json().assigned_user_id)!]++;
  }
  assert.deepEqual(tally, { ana: 7, beto: 3 });
});

t('horario y días libres de cada persona: el servicio solo ofrece lo que alguien puede atender', async () => {
  const svc = await createService({ name: 'Revisión' });
  // El último día entre semana que ofrece el servicio (Beto no trabaja sábado ni domingo; depende de la fecha de hoy).
  const day = (await slotsOf(svc.id)).map((s) => s.date).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())).at(-1)!;
  const mornings = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['09:00', '12:00']]]));
  // Beto solo trabaja en las mañanas; Ana tiene ese día libre.
  assert.equal((await people.beto.api('PUT', `/api/team/${people.beto.id}/schedule`, { hours: { ...mornings, sat: [], sun: [] }, time_off: [] })).statusCode, 200);
  assert.equal((await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { time_off: [{ from: day, to: day, note: 'Vacaciones' }] })).statusCode, 200);
  // Quien atiende solo cambia su propia disponibilidad.
  assert.equal((await people.beto.api('PUT', `/api/team/${people.ana.id}/schedule`, { time_off: [] })).statusCode, 403);

  const that = (await slotsOf(svc.id)).filter((s) => s.date === day);
  assert.ok(that.length > 0);
  for (const s of that) {
    assert.deepEqual(s.users, [people.beto.id], `${s.key}: solo Beto`);
    assert.ok(s.key.slice(11) < '12:00', `${s.key}: solo en la mañana`);
  }
  // Pedir a Ana ese día no se puede (tiene el día libre); sin pedir a nadie, le toca a Beto.
  assert.equal((await book(svc.id, that[0].key, { assigned_user_id: people.ana.id })).statusCode, 409);
  assert.equal(who((await book(svc.id, that[0].key)).json().assigned_user_id), 'beto');

  const team = (await h.authed('GET', `/api/team/agenda?account_id=${h.accountId}`)).json();
  assert.equal(team.find((p: any) => p.id === people.ana.id).time_off[0].note, 'Vacaciones');
  assert.deepEqual((await people.beto.api('GET', '/api/team/agenda')).json().map((p: any) => p.id), [people.beto.id], 'un agente solo se ve a sí mismo');
  // Se limpia para la prueba siguiente.
  await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { time_off: [] });
  await h.authed('PUT', `/api/team/${people.beto.id}/schedule`, { hours: null, time_off: [] });
});

/** Conecta el calendario de una persona como lo haría su navegador (también reinicia su caché de ocupados). */
async function connect(name: string, provider: 'google' | 'outlook') {
  const p = people[name];
  const r = await p.api('POST', '/api/me/calendar/connect', { provider });
  assert.equal(r.statusCode, 200, r.body);
  const state = new URL(r.json().url).searchParams.get('state')!;
  const cookie = r.cookies.find((c) => c.name === (provider === 'google' ? 'g_cal_nonce' : 'o_cal_nonce'))!;
  const back = await h.app.inject({ method: 'GET', url: `/oauth/${provider}/callback?state=${encodeURIComponent(state)}&code=${name}`, headers: { cookie: `${cookie.name}=${cookie.value}` } });
  assert.equal(back.statusCode, 302);
  assert.match(String(back.headers.location), /#\/agenda\/equipo\?calendario=ok/);
}

t('calendario de cada persona: sus ocupados la bloquean solo a ella y sus citas aparecen en su calendario', async () => {
  const svc = await createService({ name: 'Llamada de ventas' });
  await connect('beto', 'outlook');
  const first = (await slotsOf(svc.id)).find((s) => s.users.length === 2)!;
  // Ana tiene ocupada esa hora en su Google.
  const start = new Date((await pool.query(`SELECT ($1::timestamp AT TIME ZONE 'America/Mexico_City') AS t`, [first.key.replace('T', ' ')])).rows[0].t);
  gBusy.ana = [{ start: start.toISOString(), end: new Date(start.getTime() + 3600_000).toISOString() }];
  await connect('ana', 'google');
  assert.equal((await people.ana.api('GET', '/api/me/calendar')).json().provider, 'google');
  const team = (await h.authed('GET', `/api/team/agenda?account_id=${h.accountId}`)).json();
  assert.deepEqual(team.filter((p: any) => p.calendar.connected).map((p: any) => [p.name, p.calendar.provider]).sort(), [['Ana', 'google'], ['Beto', 'outlook']]);
  assert.deepEqual((await slotsOf(svc.id)).find((s) => s.key === first.key)!.users, [people.beto.id], 'Ana está ocupada en su calendario');
  // Al conectar, las citas que ya tenía cada quien se copian a su calendario.
  await sync();
  const future = async (id: string) => Number((await pool.query(`SELECT count(*) FROM appointments WHERE assigned_user_id = $1 AND status = 'confirmed' AND starts_at > now()`, [id])).rows[0].count);
  assert.equal(oEvents.size, await future(people.beto.id));
  assert.equal(gEvents.size, await future(people.ana.id));
  assert.ok([...oEvents.values()].every((e) => e.owner === 'beto') && [...gEvents.values()].every((e) => e.owner === 'ana'));
  oEvents.clear();
  gEvents.clear();

  // Se agenda: le toca a Beto y aparece en su Outlook.
  const appt = (await book(svc.id, first.key)).json();
  assert.equal(who(appt.assigned_user_id), 'beto');
  await sync();
  assert.deepEqual([...oEvents.values()].map((e) => e.owner), ['beto']);
  assert.match([...oEvents.values()][0].body.subject, /Llamada de ventas · Cliente/);

  // Se reasigna a Ana: sale del Outlook de Beto y entra al Google de Ana.
  assert.equal((await h.authed('PUT', `/api/appointments/${appt.id}`, { assigned_user_id: people.ana.id })).statusCode, 200);
  await sync();
  assert.equal(oEvents.size, 0);
  assert.deepEqual([...gEvents.values()].map((e) => e.owner), ['ana']);

  // Se cancela: sale de su calendario.
  assert.equal((await h.authed('POST', `/api/appointments/${appt.id}/cancel`, { notify_customer: false })).statusCode, 200);
  await sync();
  assert.equal(gEvents.size, 0);

  // Desconectar: ya no bloquea.
  assert.equal((await people.ana.api('DELETE', '/api/me/calendar')).statusCode, 200);
  assert.equal((await people.ana.api('GET', '/api/me/calendar')).json().connected, false);
  assert.equal((await slotsOf(svc.id)).find((s) => s.key === first.key)!.users.length, 2);
});

/* ------------------------------ Llamadas con el equipo ------------------------------ */

t('llamadas: primero con quien ya atiende al cliente; una persona desactivada no recibe; sin horario propio, solo el del negocio', async () => {
  const svc = await createService({ name: 'Llamada de bienvenida', kind: 'call', prefer_owner: true });
  await h.webhook('Hola, quiero que me llamen', { phone: '5215577770001' });
  await h.idle();
  const conv = await h.conversationFor('5215577770001');
  assert.equal((await h.authed('PUT', `/api/conversations/${conv.id}/assign`, { user_id: people.beto.id })).statusCode, 200);
  const both = (await slotsOf(svc.id)).filter((s) => s.users.length === 2);
  // Beto ya atiende al cliente: la llamada es con él (dos veces seguidas, aunque por turnos le tocaría a Ana).
  for (const slot of both.slice(0, 2)) {
    const r = await book(svc.id, slot.key, { conversation_id: conv.id });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(who(r.json().assigned_user_id), 'beto');
  }
  // Si Beto está ocupado a esa hora, se reparte entre los libres.
  const busyBeto = both[0];
  const other = await book(svc.id, busyBeto.key, { conversation_id: conv.id });
  assert.equal(who(other.json().assigned_user_id), 'ana');

  // Ana desactivada: ya no aparece en los horarios ni recibe llamadas.
  assert.equal((await h.authed('PUT', `/api/users/${people.ana.id}`, { active: false })).statusCode, 200);
  try {
    const slots = await slotsOf(svc.id);
    assert.ok(slots.length && slots.every((s) => !s.users.includes(people.ana.id)));
    assert.equal(who((await book(svc.id, slots.at(-1)!.key)).json().assigned_user_id), 'beto');
  } finally {
    assert.equal((await h.authed('PUT', `/api/users/${people.ana.id}`, { active: true })).statusCode, 200);
  }

  // Ana atiende en la noche (horario propio); Beto no tiene horario propio: solo el del negocio (hasta las 18:00).
  const nights = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['09:00', '21:00']]]));
  await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { hours: { ...nights, sat: [], sun: [] }, time_off: [] });
  try {
    const late = (await slotsOf(svc.id)).filter((s) => s.key.slice(11) >= '18:00');
    assert.ok(late.length > 0, 'hay horarios de noche por Ana');
    for (const s of late) assert.deepEqual(s.users, [people.ana.id], `${s.key}: Beto no trabaja de noche`);
  } finally {
    await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { hours: null, time_off: [] });
  }
});

t('videollamadas: el enlace sale del calendario de la persona (Meet o Teams) o de su enlace fijo; llega al cliente y a quien atiende', async () => {
  const svc = await createService({ name: 'Asesoría', kind: 'call', call_mode: 'video' });
  // Beto tiene Outlook conectado (de la prueba anterior); Ana, su enlace fijo de Zoom.
  assert.equal((await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { hours: null, time_off: [], meeting_url: 'https://zoom.us/j/123456' })).statusCode, 200);
  assert.equal((await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { hours: null, time_off: [], meeting_url: 'http://inseguro.test' })).statusCode, 400);
  const team = (await h.authed('GET', `/api/team/agenda?account_id=${h.accountId}`)).json();
  assert.equal(team.find((p: any) => p.id === people.ana.id).meeting_url, 'https://zoom.us/j/123456');
  // Guardar el horario sin enviar el enlace lo conserva.
  await h.authed('PUT', `/api/team/${people.ana.id}/schedule`, { hours: null, time_off: [] });
  const slots = (await slotsOf(svc.id)).filter((s) => s.users.length === 2);

  outbox.length = 0;
  const withBeto = (await book(svc.id, slots[0].key, { assigned_user_id: people.beto.id })).json();
  assert.match(withBeto.meeting_url, /^https:\/\/teams\.microsoft\.com\/l\/o\d+$/);
  assert.equal([...oEvents.values()].at(-1)!.body.isOnlineMeeting, true);
  const mail = outbox.find((m) => m.to === 'beto@equipo.mx')!;
  assert.match(mail.subject, /Nueva videollamada contigo: Asesoría/);
  assert.ok(mail.text.includes(withBeto.meeting_url));

  const withAna = (await book(svc.id, slots[1].key, { assigned_user_id: people.ana.id })).json();
  assert.equal(withAna.meeting_url, 'https://zoom.us/j/123456');

  // Ana conecta Google: su próxima videollamada tiene sala de Meet propia.
  await connect('ana', 'google');
  const meet = (await book(svc.id, slots[2].key, { assigned_user_id: people.ana.id })).json();
  assert.match(meet.meeting_url, /^https:\/\/meet\.google\.com\/g\d+-sala$/);
  assert.deepEqual([...gEvents.values()].at(-1)!.body.conferenceData.createRequest.conferenceSolutionKey, { type: 'hangoutsMeet' });

  // Desde una conversación: la confirmación al cliente lleva el enlace; al cancelar, la persona recibe el aviso.
  await h.webhook('Quiero una asesoría', { phone: '5215577770002' });
  await h.idle();
  const conv = await h.conversationFor('5215577770002');
  h.sent.length = 0;
  const fromChat = await book(svc.id, slots[3].key, { conversation_id: conv.id, assigned_user_id: people.beto.id, notify_customer: true });
  assert.equal(fromChat.statusCode, 200, fromChat.body);
  await waitFor(() => h.sent.some((x) => x.text.includes('Enlace para la videollamada: https://teams.microsoft.com/')));
  assert.ok(h.sent.some((x) => /quedó agendada para el .* con Beto/.test(x.text)));
  outbox.length = 0;
  assert.equal((await h.authed('POST', `/api/appointments/${fromChat.json().id}/cancel`, { notify_customer: false })).statusCode, 200);
  assert.match(outbox.find((m) => m.to === 'beto@equipo.mx')!.subject, /Se canceló tu videollamada/);
  // Los recordatorios usan el enlace y la persona.
  const { renderTemplate } = await import('../src/automation/templates.js');
  const a = (await pool.query(`SELECT a.*, 'Beto' AS assigned_user_name FROM appointments a WHERE id = $1`, [fromChat.json().id])).rows[0];
  assert.equal(renderTemplate('Con {{cita.persona}}: {{cita.enlace}}', { appointment: a, timezone: 'America/Mexico_City' } as any), `Con Beto: ${a.meeting_url}`);
});

t('el cliente pide con quién: el agente ve los horarios de cada persona y agenda con la elegida', async () => {
  const svc = await createService({ name: 'Llamada con asesor', kind: 'call', customer_choice: true });
  // Un horario en que los dos están libres: por turnos le tocaría a Ana (primera de la lista, servicio nuevo).
  const both = new Set((await slotsOf(svc.id)).filter((s) => s.users.length === 2).map((s) => s.key));
  let betoSlot = '';
  h.reset();
  h.setScript((req, i) => {
    const prompt = req.messages[0].content;
    assert.match(prompt, /El cliente puede pedir con quién\. Personas y sus horarios:/);
    assert.match(prompt, /· Ana: `/);
    const line = prompt.split('\n').find((l: string) => l.includes('· Beto: '))!;
    betoSlot = [...line.matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})`/g)].map((m) => m[1]).find((k) => both.has(k))!;
    assert.ok(betoSlot, 'Beto tiene un horario en que Ana también está libre');
    if (i === 0) return { messages: ['Listo'], booking: { action: 'book', service_id: svc.id, slot: betoSlot, appointment_id: '', person: 'Carlos' } };
    return { messages: ['Perfecto, quedó tu llamada con Beto.'], booking: { action: 'book', service_id: svc.id, slot: betoSlot, appointment_id: '', person: 'beto' } };
  });
  await h.webhook('Quiero una llamada con Beto', { phone: '5215577770003' });
  await waitFor(() => h.sent.some((x) => x.text.includes('Te llamará Beto a esa hora')));
  assert.equal(h.calls.length, 2, 'una persona que no está en la lista se rechazó y se reintentó');
  assert.match(h.calls[1].messages.at(-1)!.content, /"Carlos" no está en la lista/);
  const a = (await pool.query(`SELECT assigned_user_id, source FROM appointments WHERE service_id = $1 AND status = 'confirmed'`, [svc.id])).rows;
  assert.equal(a.length, 1);
  assert.equal(who(a[0].assigned_user_id), 'beto');
});
