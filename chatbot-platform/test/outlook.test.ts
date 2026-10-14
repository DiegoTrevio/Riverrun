/** Outlook (Microsoft Graph): conexión, copia de citas como eventos, ocupados que bloquean horarios, y junto con Google. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

/** Microsoft falso (inicio de sesión y Graph) y un Google falso mínimo, para probar los dos calendarios juntos. */
const calls: { method: string; url: string; body: any; auth?: string; prefer?: string }[] = [];
const events = new Map<string, any>();
const googleEvents = new Map<string, any>();
let busy: { start: { dateTime: string }; end: { dateTime: string }; showAs: string; isCancelled?: boolean }[] = [];
let failEvents = false;
let refreshCount = 0;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body: any = raw;
    try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization, prefer: req.headers.prefer as string });
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const url = new URL(req.url!, base);
    if (url.pathname === '/common/oauth2/v2.0/token') {
      // El primer permiso caduca enseguida (se renueva al primer uso) y cada renovación entrega uno nuevo.
      if (body.grant_type === 'authorization_code') return send(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 10 });
      refreshCount++;
      return send(200, { access_token: `at-r${refreshCount}`, refresh_token: `rt-r${refreshCount}`, expires_in: 3600 });
    }
    if (url.pathname === '/v1.0/me') return send(200, { mail: 'dueno@empresa.com', userPrincipalName: 'dueno@empresa.onmicrosoft.com' });
    if (url.pathname === '/v1.0/me/calendarView') {
      // Dos páginas: la segunda llega por @odata.nextLink.
      if (url.searchParams.get('page') === '2') return send(200, { value: busy.slice(1) });
      return send(200, { value: busy.slice(0, 1), ...(busy.length > 1 ? { '@odata.nextLink': `${base}/v1.0/me/calendarView?page=2` } : {}) });
    }
    if (url.pathname.startsWith('/v1.0/me/events')) {
      if (failEvents) return send(503, { error: { code: 'ServiceUnavailable', message: 'Outlook caído' } });
      const id = decodeURIComponent(url.pathname.split('/events/')[1] ?? '');
      if (req.method === 'POST') { const e = { ...body, id: `ol${events.size + 1}` }; events.set(e.id, e); return send(201, e); }
      if (req.method === 'PATCH') { if (!events.has(id)) return send(404, { error: { message: 'no existe' } }); events.set(id, { ...events.get(id), ...body, id }); return send(200, { id }); }
      if (req.method === 'DELETE') { events.delete(id); res.writeHead(204); return res.end(); }
    }
    // Google mínimo
    if (url.pathname === '/token') return send(200, body.grant_type === 'authorization_code' ? { access_token: 'g1', refresh_token: 'grt', expires_in: 3600, id_token: `x.${Buffer.from('{"email":"dueno@gmail.com"}').toString('base64url')}.y` } : { access_token: 'g2', expires_in: 3600 });
    if (url.pathname.endsWith('/freeBusy')) return send(200, { calendars: { primary: { busy: [] } } });
    if (url.pathname.includes('/calendar/v3/') && url.pathname.includes('/events')) {
      if (req.method === 'POST') { const e = { ...body, id: `g${googleEvents.size + 1}` }; googleEvents.set(e.id, e); return send(200, e); }
      return send(200, {});
    }
    send(404, { error: { message: `sin ruta ${url.pathname}` } });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.MICROSOFT_CLIENT_ID = '11111111-2222-3333-4444-555555555555';
process.env.MICROSOFT_CLIENT_SECRET = 'msecret';
process.env.MICROSOFT_LOGIN_URL = base;
process.env.MICROSOFT_GRAPH_URL = base;
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csecret';
process.env.GOOGLE_OAUTH_URL = base;
process.env.GOOGLE_API_URL = base;
const outlook = await import('../src/integrations/outlook.js');

let serviceId = '';
const slots = async () => (await h.authed('GET', `/api/services/${serviceId}/slots`)).json() as { key: string }[];
const book = async (slot: string) => h.authed('POST', '/api/appointments', { service_id: serviceId, slot, customer_name: 'Ana', customer_phone: '5215500001111' });
const sync = () => waitFor(async () => { await h.fastForward(); return (await pool.query(`SELECT 1 FROM jobs WHERE type IN ('outlook_sync', 'gcal_sync') AND status IN ('pending','running')`)).rowCount === 0; }, 8000);

/** Conecta Outlook como lo haría el navegador: pide la URL, vuelve con el código y la cookie. */
async function connectOutlook() {
  const conn = await h.authed('POST', '/api/integrations/outlook/connect', { account_id: h.accountId });
  assert.equal(conn.statusCode, 200, conn.body);
  const url = new URL(conn.json().url);
  const nonce = conn.cookies.find((c) => c.name === 'o_cal_nonce')!.value;
  return { url, nonce, jar: { cookie: `o_cal_nonce=${nonce}` }, state: url.searchParams.get('state')! };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const s = await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Consulta', kind: 'appointment', duration_minutes: 60, min_notice_minutes: 0, max_days_ahead: 5 });
  assert.equal(s.statusCode, 200, s.body);
  serviceId = s.json().id;
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('conectar: pide los permisos correctos, el estado va firmado y el permiso queda cifrado', async () => {
  const before = (await h.authed('GET', `/api/integrations/outlook?account_id=${h.accountId}`)).json();
  assert.deepEqual([before.available, before.connected], [true, false]);
  const { url, nonce, jar, state } = await connectOutlook();
  assert.equal(url.pathname, '/common/oauth2/v2.0/authorize', 'cuentas de trabajo y personales');
  assert.equal(url.searchParams.get('client_id'), process.env.MICROSOFT_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), `${(await import('../src/config.js')).config.publicBaseUrl}/oauth/outlook/callback`);
  assert.deepEqual(url.searchParams.get('scope')!.split(' ').sort(), ['Calendars.ReadWrite', 'User.Read', 'email', 'offline_access', 'openid']);
  assert.equal(outlook.readState(state, nonce), h.accountId);
  assert.equal(outlook.readState(state, 'otra-persona'), null, 'solo en el navegador que lo pidió');
  assert.equal(outlook.readState(state.replace(/.$/, 'x'), nonce), null, 'firma alterada');
  assert.equal(outlook.readState(state, nonce, Date.now() + 16 * 60_000), null, 'caduca a los 15 minutos');
  // Un estado de Google no sirve para Outlook (firmas distintas).
  const google = await import('../src/integrations/google.js');
  assert.equal(outlook.readState(google.makeState(h.accountId, nonce), nonce), null);
  assert.match(String((await h.app.inject({ method: 'GET', url: '/oauth/outlook/callback?code=c&state=malo', headers: jar })).headers.location), /outlook=error/);
  assert.match(String((await h.app.inject({ method: 'GET', url: `/oauth/outlook/callback?error=access_denied&state=${encodeURIComponent(state)}`, headers: jar })).headers.location), /outlook=cancelado/);
  assert.match(String((await h.app.inject({ method: 'GET', url: `/oauth/outlook/callback?code=abc&state=${encodeURIComponent(state)}` })).headers.location), /outlook=error/, 'sin la cookie no se completa');
  const r = await h.app.inject({ method: 'GET', url: `/oauth/outlook/callback?code=abc&state=${encodeURIComponent(state)}`, headers: jar });
  assert.match(String(r.headers.location), /outlook=ok/);
  const stored = (await pool.query(`SELECT refresh_token, email FROM outlook_calendar WHERE account_id = $1`, [h.accountId])).rows[0];
  assert.equal(stored.email, 'dueno@empresa.com');
  assert.ok(!stored.refresh_token.includes('rt-1'), 'el permiso no se guarda en claro');
  const after = (await h.authed('GET', `/api/integrations/outlook?account_id=${h.accountId}`)).json();
  assert.deepEqual([after.connected, after.email], [true, 'dueno@empresa.com']);
  assert.ok(!JSON.stringify(after).includes('rt-1'));
});

t('una cita agendada, reprogramada y cancelada se refleja en Outlook; el permiso renovado se guarda', async () => {
  events.clear();
  const s = await slots();
  const r = await book(s[0].key);
  assert.equal(r.statusCode, 200, r.body);
  await sync();
  assert.equal(events.size, 1);
  const ev = [...events.values()][0];
  assert.match(ev.subject, /Consulta · Ana/);
  assert.match(ev.body.content, /\+5215500001111/);
  assert.equal(ev.start.timeZone, 'UTC');
  assert.equal(new Date(`${ev.start.dateTime}Z`).toISOString(), new Date(r.json().starts_at).toISOString(), 'la misma hora que la cita');
  assert.equal(new Date(`${ev.end.dateTime}Z`).getTime() - new Date(`${ev.start.dateTime}Z`).getTime(), 3600_000);
  assert.equal(ev.showAs, 'busy');
  assert.equal(ev.transactionId, `riverrun-${r.json().id}`, 'un reintento no duplica el evento');
  // El primer permiso caducaba: se renovó y Microsoft entregó uno nuevo, que quedó guardado (cifrado).
  assert.equal(calls.filter((c) => c.url === '/v1.0/me/events' && c.method === 'POST').at(-1)!.auth, 'Bearer at-r1');
  const stored = (await pool.query(`SELECT refresh_token FROM outlook_calendar WHERE account_id = $1`, [h.accountId])).rows[0].refresh_token;
  const { decryptSecret } = await import('../src/secret.js');
  assert.equal(decryptSecret(stored), 'rt-r1');
  const id = r.json().id;
  assert.equal((await pool.query(`SELECT outlook_event_id FROM appointments WHERE id = $1`, [id])).rows[0].outlook_event_id, ev.id);
  // Reprogramar: se actualiza el mismo evento.
  assert.equal((await h.authed('PUT', `/api/appointments/${id}`, { slot: s[3].key })).statusCode, 200);
  await sync();
  assert.equal(events.size, 1);
  assert.notEqual([...events.values()][0].start.dateTime, ev.start.dateTime);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url === `/v1.0/me/events/${ev.id}`));
  // Cancelar: se borra.
  assert.equal((await h.authed('POST', `/api/appointments/${id}/cancel`, { reason: 'x' })).statusCode, 200);
  await sync();
  assert.equal(events.size, 0);
  assert.equal((await pool.query(`SELECT outlook_event_id FROM appointments WHERE id = $1`, [id])).rows[0].outlook_event_id, null);
});

t('si Outlook falla, la cita se agenda igual, queda el error visible y se reintenta', async () => {
  events.clear();
  failEvents = true;
  const s = await slots();
  const r = await book(s[5].key);
  assert.equal(r.statusCode, 200, 'agendar no depende de Outlook');
  await waitFor(async () => { await h.fastForward(); return !!(await outlook.getLink(h.accountId))?.last_error; }, 8000);
  assert.match((await h.authed('GET', `/api/integrations/outlook?account_id=${h.accountId}`)).json().last_error, /Outlook caído/);
  failEvents = false;
  await waitFor(async () => { await h.fastForward(60_000 * 10); return events.size === 1; }, 10000);
  await waitFor(async () => !(await outlook.getLink(h.accountId))?.last_error, 4000);
});

t('los horarios ocupados en Outlook no se ofrecen (libre no cuenta; si Outlook falla, la agenda sigue)', async () => {
  const s = await slots();
  const day = s[1].key.slice(0, 10);
  const next = s.find((x) => !x.key.startsWith(day))!.key.slice(0, 10);
  // Página 1: el día completo ocupado. Página 2: otro día marcado «libre» (no bloquea) y uno cancelado (tampoco).
  busy = [
    { start: { dateTime: `${day}T00:00:00.0000000` }, end: { dateTime: `${day}T23:59:59.0000000` }, showAs: 'busy' },
    { start: { dateTime: `${next}T00:00:00.0000000` }, end: { dateTime: `${next}T23:59:59.0000000` }, showAs: 'free' },
    { start: { dateTime: `${next}T00:00:00.0000000` }, end: { dateTime: `${next}T23:59:59.0000000` }, showAs: 'busy', isCancelled: true },
  ];
  outlook.clearBusyCache(h.accountId);
  const blocked = await slots();
  assert.ok(!blocked.some((x) => x.key.startsWith(day)), 'el día ocupado desaparece');
  assert.ok(blocked.some((x) => x.key.startsWith(next)), 'libre y cancelado no bloquean');
  assert.equal(calls.filter((c) => c.url.startsWith('/v1.0/me/calendarView')).at(-1)!.prefer, 'outlook.timezone="UTC"');
  assert.ok(calls.some((c) => c.url.includes('page=2')), 'sigue las páginas');
  // Apagar el bloqueo
  assert.equal((await h.authed('PUT', '/api/integrations/outlook', { account_id: h.accountId, block_busy: false })).statusCode, 200);
  assert.ok((await slots()).some((x) => x.key.startsWith(day)));
  await h.authed('PUT', '/api/integrations/outlook', { account_id: h.accountId, block_busy: true });
  busy = [];
  outlook.clearBusyCache(h.accountId);
  assert.ok((await slots()).some((x) => x.key.startsWith(day)));
});

t('con Google y Outlook conectados, la cita se copia a los dos', async () => {
  const g = await h.authed('POST', '/api/integrations/google/connect', { account_id: h.accountId });
  const gUrl = new URL(g.json().url);
  const gNonce = g.cookies.find((c) => c.name === 'g_cal_nonce')!.value;
  const back = await h.app.inject({ method: 'GET', url: `/oauth/google/callback?code=abc&state=${encodeURIComponent(gUrl.searchParams.get('state')!)}`, headers: { cookie: `g_cal_nonce=${gNonce}` } });
  assert.match(String(back.headers.location), /google=ok/);
  // Al conectar Google se copian las citas futuras que ya había (la de la prueba anterior).
  await sync();
  assert.equal(googleEvents.size, 1, 'copia las citas que ya existían');
  events.clear();
  googleEvents.clear();
  const s = await slots();
  const r = await book(s[2].key);
  assert.equal(r.statusCode, 200, r.body);
  await sync();
  assert.equal(events.size, 1, 'en Outlook');
  assert.equal(googleEvents.size, 1, 'y en Google');
  assert.match([...googleEvents.values()][0].summary, /Consulta · Ana/);
});

t('desconectar borra el permiso y el vínculo; los eventos se quedan en el calendario', async () => {
  const before = events.size;
  assert.equal((await h.authed('DELETE', `/api/integrations/outlook?account_id=${h.accountId}`)).statusCode, 200);
  assert.equal(await outlook.getLink(h.accountId), null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE account_id = $1 AND outlook_event_id IS NOT NULL`, [h.accountId])).rows[0].n, 0);
  assert.equal(events.size, before);
  assert.equal((await h.authed('GET', `/api/integrations/outlook?account_id=${h.accountId}`)).json().connected, false);
  // Sin Outlook, una cita nueva ya no se copia ahí.
  const s = await slots();
  await book(s[4].key);
  await sync();
  assert.equal(events.size, before);
});
