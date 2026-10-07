/** Google Calendar: conexión OAuth, copia de citas como eventos y bloqueo por horarios ocupados (con un Google falso). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const calls: { method: string; url: string; body: any; auth?: string }[] = [];
const events = new Map<string, any>();
let busy: { start: string; end: string }[] = [];
let failEvents = false;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body: any = raw;
    try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/token') {
      const idToken = `x.${Buffer.from(JSON.stringify({ email: 'dueno@gmail.com' })).toString('base64url')}.y`;
      return send(200, body.grant_type === 'authorization_code' ? { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, id_token: idToken } : { access_token: 'at-2', expires_in: 3600 });
    }
    if (req.url === '/revoke') return send(200, {});
    if (req.url!.endsWith('/freeBusy')) return send(200, { calendars: { primary: { busy } } });
    if (req.url!.includes('/events')) {
      if (failEvents) return send(500, { error: { message: 'Google caído' } });
      const id = decodeURIComponent(req.url!.split('/events/')[1] ?? '');
      if (req.method === 'POST') { const e = { ...body, id: `ev${events.size + 1}` }; events.set(e.id, e); return send(200, e); }
      if (req.method === 'PUT') { if (!events.has(id)) return send(404, {}); events.set(id, { ...body, id }); return send(200, { id }); }
      if (req.method === 'DELETE') { events.delete(id); return send(204, {}); }
    }
    send(404, {});
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csecret';
process.env.GOOGLE_OAUTH_URL = base;
process.env.GOOGLE_API_URL = base;
const google = await import('../src/integrations/google.js');

let serviceId = '';
const slots = async () => (await h.authed('GET', `/api/services/${serviceId}/slots`)).json() as { key: string }[];
const book = async (slot: string) => h.authed('POST', '/api/appointments', { service_id: serviceId, slot, customer_name: 'Ana', customer_phone: '5215500001111' });
const sync = () => waitFor(async () => { await h.fastForward(); return (await pool.query(`SELECT 1 FROM jobs WHERE type = 'gcal_sync' AND status IN ('pending','running')`)).rowCount === 0; }, 8000);

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

t('conectar: el estado va firmado, el código se canjea y el permiso queda cifrado', async () => {
  const before = (await h.authed('GET', `/api/integrations/google?account_id=${h.accountId}`)).json();
  assert.deepEqual([before.available, before.connected], [true, false]);
  const url = new URL((await h.authed('POST', '/api/integrations/google/connect', { account_id: h.accountId })).json().url);
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), `${(await import('../src/config.js')).config.publicBaseUrl}/oauth/google/callback`);
  const state = url.searchParams.get('state')!;
  assert.equal(google.readState(state), h.accountId);
  assert.equal(google.readState(state.replace(/.$/, 'x')), null, 'firma alterada');
  assert.equal(google.readState(state, Date.now() + 16 * 60_000), null, 'caduca a los 15 minutos');
  // Estado inválido o usuario que cancela
  assert.match(String((await h.app.inject({ method: 'GET', url: '/oauth/google/callback?code=c&state=malo' })).headers.location), /google=error/);
  assert.match(String((await h.app.inject({ method: 'GET', url: `/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}` })).headers.location), /google=cancelado/);
  const r = await h.app.inject({ method: 'GET', url: `/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}` });
  assert.match(String(r.headers.location), /google=ok/);
  const stored = (await pool.query(`SELECT refresh_token, google_email FROM google_calendar WHERE account_id = $1`, [h.accountId])).rows[0];
  assert.equal(stored.google_email, 'dueno@gmail.com');
  assert.ok(!stored.refresh_token.includes('rt-1'), 'el token no se guarda en claro');
  const after = (await h.authed('GET', `/api/integrations/google?account_id=${h.accountId}`)).json();
  assert.deepEqual([after.connected, after.email], [true, 'dueno@gmail.com']);
  assert.ok(!JSON.stringify(after).includes('rt-1'));
});

t('una cita agendada, reprogramada y cancelada se refleja como evento de Google', async () => {
  events.clear();
  const s = await slots();
  const r = await book(s[0].key);
  assert.equal(r.statusCode, 200, r.body);
  await sync();
  assert.equal(events.size, 1);
  const ev = [...events.values()][0];
  assert.match(ev.summary, /Consulta · Ana/);
  assert.match(ev.description, /\+5215500001111/);
  assert.equal(new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime(), 3600_000);
  assert.equal(calls.filter((c) => c.url.startsWith('/calendar') && c.method === 'POST').at(-1)!.auth, 'Bearer at-2', 'usa el token renovado');
  const id = r.json().id;
  assert.equal((await pool.query(`SELECT google_event_id FROM appointments WHERE id = $1`, [id])).rows[0].google_event_id, ev.id);
  // Reprogramar
  assert.equal((await h.authed('PUT', `/api/appointments/${id}`, { slot: s[3].key })).statusCode, 200);
  await sync();
  assert.equal(events.size, 1);
  assert.notEqual([...events.values()][0].start.dateTime, ev.start.dateTime);
  // Cancelar
  assert.equal((await h.authed('POST', `/api/appointments/${id}/cancel`, { reason: 'x' })).statusCode, 200);
  await sync();
  assert.equal(events.size, 0);
});

t('si Google falla, la cita se agenda igual, queda el error visible y se reintenta', async () => {
  events.clear();
  failEvents = true;
  const s = await slots();
  const r = await book(s[5].key);
  assert.equal(r.statusCode, 200, 'agendar no depende de Google');
  await waitFor(async () => { await h.fastForward(); return !!(await google.getLink(h.accountId))?.last_error; }, 8000);
  assert.match((await h.authed('GET', `/api/integrations/google?account_id=${h.accountId}`)).json().last_error, /Google caído/);
  failEvents = false;
  await waitFor(async () => { await h.fastForward(60_000 * 10); return events.size === 1; }, 10000);
});

t('los horarios ocupados en Google no se ofrecen (y si Google falla, la agenda sigue)', async () => {
  const s = await slots();
  const taken = s[1].key;
  // Ocupa en Google el rango completo del primer día con horarios.
  const day = taken.slice(0, 10);
  busy = [{ start: new Date(`${day}T00:00:00Z`).toISOString(), end: new Date(`${day}T23:59:59Z`).toISOString() }];
  google.clearBusyCache(h.accountId);
  const blocked = await slots();
  assert.ok(!blocked.some((x) => x.key.startsWith(day)), 'el día ocupado desaparece de la oferta');
  assert.ok(blocked.length > 0);
  // Apagar el bloqueo
  assert.equal((await h.authed('PUT', '/api/integrations/google', { account_id: h.accountId, block_busy: false })).statusCode, 200);
  assert.ok((await slots()).some((x) => x.key.startsWith(day)));
  // Google responde mal: no bloquea nada
  await h.authed('PUT', '/api/integrations/google', { account_id: h.accountId, block_busy: true });
  busy = [];
  google.clearBusyCache(h.accountId);
  assert.ok((await slots()).some((x) => x.key.startsWith(day)));
});

t('desconectar revoca el permiso y borra el vínculo', async () => {
  assert.equal((await h.authed('DELETE', `/api/integrations/google?account_id=${h.accountId}`)).statusCode, 200);
  assert.ok(calls.some((c) => c.url === '/revoke' && c.body.token === 'rt-1'));
  assert.equal((await google.getLink(h.accountId)), null);
  assert.equal((await h.authed('GET', `/api/integrations/google?account_id=${h.accountId}`)).json().connected, false);
});
