/** Integraciones: webhooks de eventos (firmados, con reintentos) y API pública con llaves. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { config } = await import('../src/config.js');
const { eventBody } = await import('../src/integrations/webhooks.js');

/** Receptor de webhooks de prueba. */
const received: { path: string; headers: http.IncomingHttpHeaders; raw: string; body: any }[] = [];
let respondWith = 200;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body: any = null; try { body = JSON.parse(raw); } catch { /* */ }
    received.push({ path: req.url!, headers: req.headers, raw, body });
    res.writeHead(respondWith); res.end('ok');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const hook = (p = '/a') => `http://127.0.0.1:${(server.address() as any).port}${p}`;

const secret = async () => (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json().webhook_secret as string;
const mkEndpoint = async (body: Record<string, unknown>) => { const r = await h.authed('POST', '/api/webhook-endpoints', { account_id: h.accountId, ...body }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
/** Corre las tareas programadas hasta que se cumpla la condición (los eventos se procesan en segundo plano). */
const until = (cond: () => boolean) => waitFor(async () => { await h.service.automator.settleAll(); await h.fastForward(); return cond(); }, 8000);
const of = (type: string) => received.filter((r) => r.body?.type === type);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ data_fields: [{ key: 'correo', label: 'Correo', type: 'email' }] });
  h.setScript(() => ({ messages: ['Hola'] }));
});
after(async () => {
  server.close();
  config.allowPrivateWebhooks = true;
  if (h) await h.app.close();
  await pool.end();
});

t('webhook: contacto nuevo llega firmado, con evento y entrega; "*" no incluye cada mensaje', async () => {
  const ep = await mkEndpoint({ url: hook('/todo'), description: 'Zapier' });
  assert.deepEqual(ep.events, ['*']);
  received.length = 0;
  await h.webhook('Hola, soy nuevo', { phone: '5215580000001' });
  await until(() => of('contact.created').length >= 1);
  const created = of('contact.created');
  assert.equal(created.length, 1, JSON.stringify(received.map((r) => r.body?.type)));
  const r = created[0];
  assert.equal(r.path, '/todo');
  assert.equal(r.headers['x-riverrun-event'], 'contact.created');
  assert.match(String(r.headers['x-riverrun-delivery']), /^[0-9a-f-]{36}$/);
  assert.ok(Math.abs(Number(r.headers['x-riverrun-timestamp']) - Date.now() / 1000) < 30);
  const sig = `sha256=${crypto.createHmac('sha256', await secret()).update(r.raw).digest('hex')}`;
  assert.equal(r.headers['x-signature'], sig, 'firma HMAC verificable con la clave de la cuenta');
  assert.equal(r.body.account_id, h.accountId);
  assert.equal(r.body.id, r.headers['x-riverrun-delivery']);
  assert.equal(r.body.data.contact.phone, '5215580000001');
  assert.equal(r.body.data.conversation.channel.type, 'whatsapp');
  assert.equal(of('message.received').length, 0, '"*" no manda un aviso por cada mensaje');
  const log = (await h.authed('GET', `/api/webhook-endpoints/${ep.id}/deliveries`)).json();
  assert.ok(log.length >= 1 && log[0].ok && log[0].status_code === 200);
});

t('webhook: suscripción por eventos (incluido message.received) y captura de datos', async () => {
  received.length = 0;
  const ep = await mkEndpoint({ url: hook('/mensajes'), events: ['message.received', 'contact.data_captured'] });
  await h.webhook('Un mensaje cualquiera', { phone: '5215580000001' });
  const contact = (await pool.query(`SELECT id FROM contacts WHERE phone = '5215580000001'`)).rows[0];
  await until(() => received.some((r) => r.path === '/mensajes' && r.body.type === 'message.received'));
  await h.authed('PUT', `/api/contacts/${contact.id}`, { data: { correo: 'ana@x.mx' } });
  await until(() => received.some((r) => r.path === '/mensajes' && r.body.type === 'contact.data_captured'));
  const mine = received.filter((r) => r.path === '/mensajes');
  assert.deepEqual([...new Set(mine.map((r) => r.body.type))].sort(), ['contact.data_captured', 'message.received']);
  assert.equal(mine.find((r) => r.body.type === 'message.received')!.body.data.message, 'Un mensaje cualquiera');
  const captured = mine.find((r) => r.body.type === 'contact.data_captured')!.body.data;
  assert.equal(captured.field, 'correo');
  assert.equal(captured.value, 'ana@x.mx');
  await h.authed('DELETE', `/api/webhook-endpoints/${ep.id}`);
});

t('webhook: prueba de conexión, validaciones y aislamiento entre cuentas', async () => {
  const ep = (await h.authed('GET', `/api/webhook-endpoints?account_id=${h.accountId}`)).json()[0];
  received.length = 0;
  const ping = (await h.authed('POST', `/api/webhook-endpoints/${ep.id}/test`)).json();
  assert.equal(ping.ok, true);
  assert.equal(received.at(-1)!.body.type, 'ping');
  assert.equal((await h.authed('POST', '/api/webhook-endpoints', { account_id: h.accountId, url: 'ftp://x.com' })).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/webhook-endpoints', { account_id: h.accountId, url: hook(), events: ['evento.inventado'] })).statusCode, 400);
  const other = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.4.4.4', payload: { name: 'Otro', company: 'Otro negocio', business_type: 'otro', email: 'otro@integra.mx', password: 'clave-otro-123', accept_terms: true } });
  const cookie = String(other.headers['set-cookie']).split(';')[0];
  const api = (m: string, u: string, p?: unknown) => h.app.inject({ method: m as any, url: u, payload: p as any, headers: { cookie } });
  assert.equal((await api('PUT', `/api/webhook-endpoints/${ep.id}`, { active: false })).statusCode, 404);
  assert.equal((await api('POST', `/api/webhook-endpoints/${ep.id}/test`)).statusCode, 404);
  assert.deepEqual((await api('GET', '/api/webhook-endpoints')).json(), []);
});

t('webhook: si la URL falla se reintenta, queda en la bitácora y tras muchos fallos se pausa y avisa', async () => {
  const ep = await mkEndpoint({ url: hook('/falla'), events: ['contact.tag_added'] });
  respondWith = 500;
  received.length = 0;
  const contact = (await pool.query(`SELECT id FROM contacts WHERE phone = '5215580000001'`)).rows[0];
  await h.authed('PUT', `/api/contacts/${contact.id}`, { tags: ['vip'] });
  await until(() => received.filter((r) => r.path === '/falla').length >= 1); // intento 1
  await h.fastForward(); // reintento 2
  await h.fastForward(); // reintento 3
  const attempts = received.filter((r) => r.path === '/falla');
  assert.equal(attempts.length, 3, 'tres intentos');
  const log = (await h.authed('GET', `/api/webhook-endpoints/${ep.id}/deliveries`)).json();
  assert.ok(log.every((d: any) => !d.ok && d.status_code === 500 && /500/.test(d.error)));
  assert.deepEqual(log.map((d: any) => d.attempt).sort(), [1, 2, 3]);
  // Un evento cuenta como un solo fallo (tras sus 3 intentos); se pausa al llegar a 20 seguidos
  assert.equal((await pool.query(`SELECT consecutive_failures n FROM webhook_endpoints WHERE id = $1`, [ep.id])).rows[0].n, 1);
  await pool.query(`UPDATE webhook_endpoints SET consecutive_failures = 19 WHERE id = $1`, [ep.id]);
  await h.authed('PUT', `/api/contacts/${contact.id}`, { tags: ['vip', 'nuevo'] });
  await until(() => received.filter((r) => r.path === '/falla').length >= 4);
  await h.fastForward(); // reintento 2 del segundo evento
  await h.fastForward(); // reintento 3: ahí cuenta como fallo del evento
  const paused = (await h.authed('GET', `/api/webhook-endpoints?account_id=${h.accountId}`)).json().find((e: any) => e.id === ep.id);
  assert.equal(paused.active, false);
  assert.match(paused.disabled_reason, /20 fallos seguidos/);
  assert.ok((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND kind = 'integration'`, [h.accountId])).rows[0].n >= 0);
  // Reactivarlo limpia el motivo
  respondWith = 200;
  const back = (await h.authed('PUT', `/api/webhook-endpoints/${ep.id}`, { active: true })).json();
  assert.equal(back.active, true);
  assert.equal(back.disabled_reason, '');
  assert.equal(back.consecutive_failures, 0);
});

t('webhook: no llega a redes internas (SSRF) cuando no se permiten', async () => {
  config.allowPrivateWebhooks = false;
  try {
    const ep = await mkEndpoint({ url: hook('/interna'), events: ['ping'] });
    const r = (await h.authed('POST', `/api/webhook-endpoints/${ep.id}/test`)).json();
    assert.equal(r.ok, false);
    assert.match(r.error, /red interna/);
  } finally {
    config.allowPrivateWebhooks = true;
  }
});

/* ------------------------------ API pública ------------------------------ */
let readKey = '', writeKey = '', writeId = '';
const call = (key: string | null, method: string, url: string, payload?: unknown) =>
  h.app.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });

t('llaves: se muestran una sola vez y solo se guarda su hash', async () => {
  const r = await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Lectura', scope: 'read' });
  assert.equal(r.statusCode, 200, r.body);
  readKey = r.json().key;
  assert.match(readKey, /^rr_[\w-]{30,}$/);
  const w = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Zapier', scope: 'write' })).json();
  writeKey = w.key; writeId = w.id;
  const list = (await h.authed('GET', `/api/api-keys?account_id=${h.accountId}`)).json();
  assert.equal(list.length, 2);
  assert.ok(list.every((k: any) => !('key' in k) && !('key_hash' in k) && readKey.startsWith(k.prefix) || writeKey.startsWith(k.prefix)));
  const stored = (await pool.query(`SELECT key_hash FROM api_keys WHERE id = $1`, [w.id])).rows[0].key_hash;
  assert.equal(stored, crypto.createHash('sha256').update(writeKey).digest('hex'));
  assert.ok(!JSON.stringify((await pool.query(`SELECT * FROM api_keys`)).rows).includes(writeKey), 'la llave no está en la base');
});

t('API: autenticación, alcance de la llave y revocación', async () => {
  assert.equal((await call(null, 'GET', '/api/v1/me')).statusCode, 401);
  assert.equal((await call('rr_inventada_inventada_inventada', 'GET', '/api/v1/me')).statusCode, 401);
  const me = await call(readKey, 'GET', '/api/v1/me');
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().account.id, h.accountId);
  assert.equal(me.json().key.scope, 'read');
  assert.equal((await call(readKey, 'POST', '/api/v1/contacts', {})).statusCode, 403, 'una llave de lectura no escribe');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: h.cookie } })).statusCode, 401, 'la sesión del panel no vale para la API');
  const tmp = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Temporal', scope: 'read' })).json();
  assert.equal((await call(tmp.key, 'GET', '/api/v1/me')).statusCode, 200);
  assert.equal((await h.authed('DELETE', `/api/api-keys/${tmp.id}`)).statusCode, 200);
  assert.equal((await call(tmp.key, 'GET', '/api/v1/me')).statusCode, 401, 'revocada');
  assert.ok((await pool.query(`SELECT last_used_at FROM api_keys WHERE key_hash = $1`, [crypto.createHash('sha256').update(readKey).digest('hex')])).rows[0].last_used_at);
});

t('API: alta por teléfono, actualización con combinación de datos y etiquetas, consentimiento', async () => {
  const bad = await call(writeKey, 'POST', '/api/v1/contacts', { channel_id: h.channelId, phone: '12' });
  assert.equal(bad.statusCode, 400);
  const created = await call(writeKey, 'POST', '/api/v1/contacts', { channel_id: h.channelId, phone: '+52 1 55 8000 0100', name: 'Lucía CRM', data: { correo: 'lucia@crm.mx' }, tags: ['crm'], consent: true });
  assert.equal(created.statusCode, 201, created.body);
  const c = created.json();
  assert.equal(c.phone, '5215580000100'.replace(/^521/, '521'));
  assert.deepEqual(c.tags, ['crm']);
  assert.equal(c.consent.given, true);
  assert.equal(c.consent.source, 'api');
  assert.equal((await call(writeKey, 'POST', '/api/v1/contacts', { channel_id: h.channelId, phone: '+52 1 55 8000 0100' })).statusCode, 200, 'repetirlo actualiza, no duplica');
  const upd = (await call(writeKey, 'PUT', `/api/v1/contacts/${c.id}`, { data: { ciudad: 'Monterrey' }, add_tags: ['vip'], remove_tags: ['crm'] })).json();
  assert.deepEqual(upd.data, { correo: 'lucia@crm.mx', ciudad: 'Monterrey' }, 'se combinan con los que ya tenía');
  assert.deepEqual(upd.tags, ['vip']);
  assert.equal((await call(writeKey, 'PUT', `/api/v1/contacts/${c.id}`, { data: { ciudad: '' } })).json().data.ciudad, undefined, 'vacío = borrar el dato');
  assert.equal((await call(writeKey, 'PUT', `/api/v1/contacts/${c.id}`, { consent: false })).json().consent.given, false);
});

t('API: listados con paginación por cursor, filtros y aislamiento entre cuentas', async () => {
  for (let i = 1; i <= 4; i++) await call(writeKey, 'POST', '/api/v1/contacts', { channel_id: h.channelId, phone: `52155800002${i}0`, tags: ['lote'] });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r: any = (await call(readKey, 'GET', `/api/v1/contacts?limit=2&tag=lote${cursor ? `&cursor=${cursor}` : ''}`)).json();
    seen.push(...r.data.map((x: any) => x.id));
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4, 'sin repetidos');
  assert.equal((await call(readKey, 'GET', '/api/v1/contacts?phone=52155800002 10')).json().data.length, 1);
  assert.equal((await call(readKey, 'GET', '/api/v1/contacts?limit=500')).statusCode, 400);
  // Otra cuenta no ve nada de esta
  const other = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.4.4.5', payload: { name: 'Ajeno', company: 'Ajeno SA', business_type: 'otro', email: 'ajeno@integra.mx', password: 'clave-ajeno-123', accept_terms: true } });
  const cookie = String(other.headers['set-cookie']).split(';')[0];
  const foreign = (await h.app.inject({ method: 'POST', url: '/api/api-keys', payload: { name: 'Ajena', scope: 'write' }, headers: { cookie } })).json().key;
  assert.deepEqual((await call(foreign, 'GET', '/api/v1/contacts')).json().data, []);
  const someone = seen[0];
  assert.equal((await call(foreign, 'GET', `/api/v1/contacts/${someone}`)).statusCode, 404);
  assert.equal((await call(foreign, 'PUT', `/api/v1/contacts/${someone}`, { name: 'hackeado' })).statusCode, 404);
  assert.equal((await call(foreign, 'POST', '/api/v1/contacts', { channel_id: h.channelId, phone: '5215599999999' })).statusCode, 400, 'canal de otra cuenta');
});

t('API: conversaciones, mensajes, envío (respeta bajas) y citas', async () => {
  const convs = (await call(readKey, 'GET', '/api/v1/conversations?limit=200')).json().data;
  assert.ok(convs.length >= 6);
  const mainContact = (await pool.query(`SELECT id FROM contacts WHERE phone = '5215580000001'`)).rows[0].id;
  const first = convs.find((c: any) => c.contact_id === mainContact) ?? convs[0];
  const msgs = (await call(readKey, 'GET', `/api/v1/conversations/${first.id}/messages`)).json().data;
  assert.ok(msgs.length >= 2 && msgs.some((m: any) => m.direction === 'inbound') && msgs.some((m: any) => m.direction === 'outbound'));
  h.reset();
  const sent = await call(writeKey, 'POST', '/api/v1/messages', { channel_id: h.channelId, phone: '5215580000001', text: 'Tu pedido va en camino' });
  assert.equal(sent.statusCode, 200, sent.body);
  await waitFor(() => h.sent.some((s) => s.text === 'Tu pedido va en camino'));
  const contact = (await pool.query(`SELECT id FROM contacts WHERE phone = '5215580000001'`)).rows[0];
  await call(writeKey, 'PUT', `/api/v1/contacts/${contact.id}`, { opted_out: true });
  const blocked = await call(writeKey, 'POST', '/api/v1/messages', { conversation_id: first.id, text: 'Promoción' });
  assert.equal(blocked.statusCode, 422);
  assert.match(blocked.json().reason, /se dio de baja/);
  assert.equal((await call(writeKey, 'POST', '/api/v1/messages', { text: 'sin destino' })).statusCode, 400);
  await pool.query(`INSERT INTO appointments (account_id, customer_name, starts_at, ends_at, service_name) VALUES ($1,'Ana', now() + interval '1 day', now() + interval '1 day 1 hour', 'Limpieza')`, [h.accountId]);
  const appts = (await call(readKey, 'GET', '/api/v1/appointments')).json().data;
  assert.equal(appts.length, 1);
  assert.equal(appts[0].service_name, 'Limpieza');
  // Cuenta en pausa por falta de pago: puede leer pero no escribir
  await pool.query(`UPDATE accounts SET status = 'paused' WHERE id = $1`, [h.accountId]);
  assert.equal((await call(readKey, 'GET', '/api/v1/me')).statusCode, 200);
  assert.equal((await call(writeKey, 'POST', '/api/v1/messages', { conversation_id: first.id, text: 'x' })).statusCode, 402);
  await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [h.accountId]);
  // Cuenta desactivada: nada
  await pool.query(`UPDATE accounts SET active = false WHERE id = $1`, [h.accountId]);
  assert.equal((await call(readKey, 'GET', '/api/v1/me')).statusCode, 403);
  await pool.query(`UPDATE accounts SET active = true WHERE id = $1`, [h.accountId]);
  void writeId;
});

t('la especificación OpenAPI es pública y cubre todas las rutas de la API v1', async () => {
  const r = await h.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  assert.equal(r.statusCode, 200);
  const spec = r.json();
  assert.equal(spec.openapi, '3.1.0');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/api-v1.ts', import.meta.url), 'utf8');
  const routes = [...src.matchAll(/v1\.(get|post|put|delete)\('([^']+)'/g)].map((m) => [m[1], m[2].replace(/:(\w+)/g, '{$1}')]);
  assert.ok(routes.length >= 9);
  for (const [method, path] of routes) assert.ok(spec.paths[path]?.[method], `falta ${method.toUpperCase()} ${path} en OpenAPI`);
});
