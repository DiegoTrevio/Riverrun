/** Webhooks coherentes con la API: firma con hora, origen, eventos nuevos (citas, cobros), ejemplos reales y reenvío. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let writeKey = '';

const received: { path: string; headers: http.IncomingHttpHeaders; raw: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body: any = null; try { body = JSON.parse(raw); } catch { /* */ }
    received.push({ path: req.url!, headers: req.headers, raw, body });
    res.writeHead(req.url!.startsWith('/falla') ? 500 : 200); res.end('ok');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const hook = (p: string) => `http://127.0.0.1:${(server.address() as any).port}${p}`;
const call = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${writeKey}` } });
const mkEndpoint = async (body: Record<string, unknown>) => { const r = await h.authed('POST', '/api/webhook-endpoints', { account_id: h.accountId, ...body }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
const until = (cond: () => boolean) => waitFor(async () => { await h.service.automator.settleAll(); await h.fastForward(); return cond(); }, 8000);
const at = (path: string, type?: string) => received.filter((r) => r.path === path && (!type || r.body?.type === type));
const secret = async () => (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json().webhook_secret as string;
const today = (days = 0) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola'] }));
  writeKey = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'CRM', scope: 'write' })).json().key;
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('firma con hora, versión y origen: un cambio hecho por la API llega marcado como suyo', async () => {
  await mkEndpoint({ url: hook('/crm'), events: ['contact.tag_added'] });
  const c = (await call('POST', '/api/v1/contacts', { phone: '5215581100001', name: 'Rosa' })).json();
  await call('PUT', `/api/v1/contacts/${c.id}`, { add_tags: ['vip'] });
  await until(() => at('/crm', 'contact.tag_added').length >= 1);
  const d = at('/crm', 'contact.tag_added')[0];
  assert.equal(d.body.api_version, 1);
  assert.equal(d.body.origin, 'api', 'lo cambió tu sistema');
  assert.equal(d.body.data.contact.channel.id, h.channelId, 'el contacto trae su canal, como en la API');
  assert.equal(d.body.data.contact.name, 'Rosa');
  // x-riverrun-signature: t=<segundos>,v1=HMAC("t.cuerpo"); x-signature sigue igual.
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(d.headers['x-riverrun-signature']));
  assert.ok(m, String(d.headers['x-riverrun-signature']));
  const key = await secret();
  assert.equal(m![2], crypto.createHmac('sha256', key).update(`${m![1]}.${d.raw}`).digest('hex'));
  assert.ok(Math.abs(Date.now() / 1000 - Number(m![1])) < 60);
  assert.equal(d.headers['x-riverrun-timestamp'], m![1]);
  assert.equal(d.headers['x-signature'], `sha256=${crypto.createHmac('sha256', key).update(d.raw).digest('hex')}`);
  // Desde el panel el origen es riverrun.
  await h.authed('PUT', `/api/contacts/${c.id}`, { tags: ['vip', 'nuevo'] });
  await until(() => at('/crm', 'contact.tag_added').length >= 2);
  assert.equal(at('/crm', 'contact.tag_added')[1].body.origin, 'riverrun');
});

t('cobros: pagado llega con el cobro igual que en GET /receivables; «todos los eventos» no los incluye', async () => {
  await mkEndpoint({ url: hook('/pagos'), events: ['payment.paid', 'payment.due'] });
  await mkEndpoint({ url: hook('/todo') }); // "*": los de siempre
  const r = (await call('POST', '/api/v1/receivables', { phone: '5215581100002', concept: 'Mensualidad', amount_cents: 150000, due_date: today(5) })).json();
  assert.ok(r.id, JSON.stringify(r));
  assert.equal((await call('POST', `/api/v1/receivables/${r.id}/paid`, { note: 'transferencia' })).statusCode, 200);
  await until(() => at('/pagos', 'payment.paid').length >= 1);
  const ev = at('/pagos', 'payment.paid')[0].body;
  const listed = (await call('GET', '/api/v1/receivables?status=paid')).json().data.find((x: any) => x.id === r.id);
  const shape = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined && !['contact_name', 'contact_phone'].includes(k)).sort();
  assert.deepEqual(shape(ev.data.receivable), shape(listed), 'la misma forma que la API');
  assert.equal(ev.data.receivable.status, 'paid');
  assert.equal(ev.data.contact.phone, '5215581100002');
  assert.equal(ev.origin, 'api');
  await h.idle();
  assert.equal(at('/todo', 'payment.paid').length, 0, '"*" no recibe los eventos nuevos');
});

t('citas sin chat (panel), reprogramar y cancelar llegan con la cita como en GET /appointments', async () => {
  const s = (await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Consulta', kind: 'appointment', duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 5 })).json();
  await mkEndpoint({ url: hook('/citas'), events: ['appointment.booked', 'appointment.rescheduled', 'appointment.cancelled'] });
  const slots = (await h.authed('GET', `/api/services/${s.id}/slots`)).json();
  const a = await h.authed('POST', '/api/appointments', { service_id: s.id, slot: slots[0].key, customer_name: 'Mario sin chat', customer_phone: '5215581100003' });
  assert.equal(a.statusCode, 200, a.body);
  await until(() => at('/citas', 'appointment.booked').length >= 1);
  const booked = at('/citas', 'appointment.booked')[0].body.data;
  assert.equal(booked.appointment.id, a.json().id);
  assert.equal(booked.appointment.customer_name, 'Mario sin chat');
  assert.equal(booked.conversation, null, 'sin chat');
  const api = (await call('GET', '/api/v1/appointments')).json().data.find((x: any) => x.id === a.json().id);
  assert.deepEqual(Object.keys(booked.appointment).sort(), Object.keys(api).sort());
  assert.equal((await h.authed('PUT', `/api/appointments/${a.json().id}`, { slot: slots[1].key })).statusCode, 200);
  await until(() => at('/citas', 'appointment.rescheduled').length >= 1);
  const moved = at('/citas', 'appointment.rescheduled')[0].body.data.appointment;
  assert.equal(moved.id, a.json().id);
  assert.notEqual(moved.starts_at, booked.appointment.starts_at, 'con la hora nueva');
  assert.equal((await h.authed('POST', `/api/appointments/${a.json().id}/cancel`, { reason: 'Llamó para cancelar' })).statusCode, 200);
  await until(() => at('/citas', 'appointment.cancelled').length >= 1);
  assert.equal(at('/citas', 'appointment.cancelled')[0].body.data.appointment.cancel_reason, 'Llamó para cancelar');
});

t('«Enviar prueba» de un evento manda un ejemplo real marcado test; la entrega se ve y se reenvía', async () => {
  const ep = await mkEndpoint({ url: hook('/zap'), events: ['contact.tag_added'] });
  const test1 = (await h.authed('POST', `/api/webhook-endpoints/${ep.id}/test`, { event: 'payment.paid' })).json();
  assert.equal(test1.ok, true, JSON.stringify(test1));
  const sample = at('/zap', 'payment.paid')[0].body;
  assert.equal(sample.test, true);
  assert.ok(sample.data.receivable.id && sample.data.contact.id, 'con el cobro y el contacto reales de la cuenta');
  assert.equal((await h.authed('POST', `/api/webhook-endpoints/${ep.id}/test`, { event: 'nada' })).statusCode, 400);
  // Nombres heredados de los objetos de JavaScript no son eventos.
  assert.equal((await h.authed('POST', `/api/webhook-endpoints/${ep.id}/test`, { event: 'toString' })).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/webhook-endpoints', { account_id: h.accountId, url: hook('/x'), events: ['constructor'] })).statusCode, 400);
  // La prueba de conexión no lleva datos de clientes reales.
  assert.equal((await h.authed('POST', `/api/webhook-endpoints/${ep.id}/test`, {})).json().ok, true);
  const ping = at('/zap', 'ping').at(-1)!.body;
  assert.equal(ping.test, true);
  assert.equal(ping.data.contact.name, 'Ana López', 'el contacto de ejemplo');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM contacts WHERE id::text = $1`, [ping.data.contact.id])).rows[0].n, 0);
  // Un evento real: queda guardado y se puede ver y reenviar.
  const c = (await call('POST', '/api/v1/contacts', { phone: '5215581100004' })).json();
  await call('PUT', `/api/v1/contacts/${c.id}`, { add_tags: ['zap'] });
  await until(() => at('/zap', 'contact.tag_added').length >= 1);
  const first = at('/zap', 'contact.tag_added')[0];
  const log = (await h.authed('GET', `/api/webhook-endpoints/${ep.id}/deliveries`)).json();
  const real = log.find((d: any) => d.event === 'contact.tag_added');
  assert.equal(real.redeliverable, true);
  const detail = (await h.authed('GET', `/api/webhook-endpoints/${ep.id}/deliveries/${real.id}`)).json();
  assert.equal(detail.body.id, first.body.id);
  assert.equal((await h.authed('POST', `/api/webhook-endpoints/${ep.id}/deliveries/${real.id}/redeliver`)).statusCode, 200);
  await until(() => at('/zap', 'contact.tag_added').length >= 2);
  assert.equal(at('/zap', 'contact.tag_added')[1].raw, first.raw, 'el mismo evento, con el mismo id');
  assert.equal((await h.authed('GET', `/api/webhook-endpoints/${ep.id}/deliveries/999999999`)).statusCode, 404);
  // Al borrar los datos del cliente se borran sus eventos guardados.
  assert.equal((await h.authed('DELETE', `/api/contacts/${c.id}`)).statusCode, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM webhook_events WHERE body->'data'->'contact'->>'id' = $1`, [c.id])).rows[0].n, 0);
});

t('un reenvío manual conserva sus propios reintentos, sin pisar los de la entrega original', async () => {
  const ep = await mkEndpoint({ url: hook('/falla-cadena'), events: ['contact.tag_added'] });
  const c = (await call('POST', '/api/v1/contacts', { phone: '5215581100005' })).json();
  await call('PUT', `/api/v1/contacts/${c.id}`, { add_tags: ['cadena'] });
  // Solo lo que ya toca: el primer intento falla y deja pendiente el segundo (en un minuto).
  await waitFor(async () => { await h.service.automator.settleAll(); await h.service.scheduler.runDue(); return at('/falla-cadena').length >= 1; }, 8000);
  const pending = async () => (await pool.query(`SELECT dedupe_key FROM jobs WHERE type = 'webhook_delivery' AND status = 'pending' AND payload->>'endpoint_id' = $1`, [ep.id])).rows.map((r) => r.dedupe_key);
  assert.equal((await pending()).length, 1);
  const log = (await h.authed('GET', `/api/webhook-endpoints/${ep.id}/deliveries`)).json();
  assert.equal((await h.authed('POST', `/api/webhook-endpoints/${ep.id}/deliveries/${log[0].id}/redeliver`)).statusCode, 200);
  await h.service.scheduler.runDue(); // el reenvío también falla y programa su propio segundo intento
  assert.equal(at('/falla-cadena').length, 2);
  const keys = await pending();
  assert.equal(keys.length, 2, `dos cadenas de reintentos: ${keys.join(', ')}`);
  assert.equal(new Set(keys).size, 2);
});

t('el secreto de webhooks cambia solo, sin tocar el enlace del calendario', async () => {
  const before = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  const r = await h.authed('POST', '/api/settings/rotate-webhook-secret', { account_id: h.accountId });
  assert.equal(r.statusCode, 200, r.body);
  const after = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  assert.notEqual(after.webhook_secret, before.webhook_secret);
  assert.equal(r.json().webhook_secret, after.webhook_secret);
  assert.equal(after.calendar_token, before.calendar_token);
});
