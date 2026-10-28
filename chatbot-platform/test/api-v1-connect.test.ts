/** API v1 fácil de conectar: canales y datos para descubrir, teléfonos en cualquier formato, códigos de error y reintentos seguros. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let writeKey = '', readKey = '';
const call = (key: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method: method as any, url, payload: payload as any, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
const contactsWith = async (digits: string) => (await pool.query(`SELECT id, external_id, phone FROM contacts WHERE account_id = $1 AND phone LIKE $2`, [h.accountId, `%${digits}`])).rows;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola'] }));
  writeKey = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'CRM', scope: 'write' })).json().key;
  readKey = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Tablero', scope: 'read' })).json().key;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('descubrir: canales, datos del cliente y el canal por omisión en /me', async () => {
  await h.authed('POST', `/api/contact-fields?account_id=${h.accountId}`, { key: 'edad', label: 'Edad', type: 'number' });
  const ch = (await call(readKey, 'GET', '/api/v1/channels')).json().data;
  assert.equal(ch.length, 1);
  assert.equal(ch[0].id, h.channelId);
  assert.equal(ch[0].type, 'whatsapp');
  assert.equal(ch[0].contacts_by_phone, true);
  assert.equal(ch[0].default, true);
  const me = (await call(readKey, 'GET', '/api/v1/me')).json();
  assert.equal(me.default_channel_id, h.channelId);
  assert.equal(me.timezone, 'America/Mexico_City');
  const fields = (await call(readKey, 'GET', '/api/v1/contact-fields')).json().data;
  assert.deepEqual(fields.map((f: any) => [f.key, f.type]), [['edad', 'number']]);
});

t('teléfono en cualquier formato: sin canal, con o sin lada y con o sin el 1 es el mismo contacto', async () => {
  const a = await call(writeKey, 'POST', '/api/v1/contacts', { phone: '(55) 8100-0001', name: 'Rosa' });
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(a.json().phone, '525581000001', 'a 10 dígitos se le pone la lada de México');
  assert.equal(a.json().channel.id, h.channelId, 'con un solo WhatsApp no hace falta channel_id');
  for (const phone of ['+52 1 55 8100 0001', '0052 55 8100 0001', 5215581000001]) {
    const r = await call(writeKey, 'POST', '/api/v1/contacts', { phone });
    assert.equal(r.statusCode, 200, `${phone}: ${r.body}`);
    assert.equal(r.json().id, a.json().id, `${phone} es el mismo contacto`);
  }
  assert.equal((await contactsWith('5581000001')).length, 1);
  const found = (await call(readKey, 'GET', `/api/v1/contacts?phone=${encodeURIComponent('+52 1 55 8100 0001')}`)).json().data;
  assert.deepEqual(found.map((c: any) => c.id), [a.json().id], 'la búsqueda prueba las dos formas');
  const bad = await call(writeKey, 'POST', '/api/v1/contacts', { phone: 'llámame' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'invalid_phone');
  assert.equal(bad.json().fields[0].field, 'phone');
});

t('cuando el cliente contesta no nace otro contacto (otra forma del número o identificador @lid)', async () => {
  const c = (await call(writeKey, 'POST', '/api/v1/contacts', { phone: '525581000002', name: 'Beto', tags: ['crm'] })).json();
  // WhatsApp lo identifica con el 1 después de la lada.
  const r = await h.webhook('Hola, soy Beto', { phone: '5215581000002' });
  assert.equal(r.statusCode, 200);
  await h.idle();
  const rows = await contactsWith('5581000002');
  assert.equal(rows.length, 1, 'el mismo contacto');
  assert.equal(rows[0].id, c.id);
  assert.equal(rows[0].external_id, '5215581000002@s.whatsapp.net');
  // Con @lid: el número real llega en remoteJidAlt.
  const d = (await call(writeKey, 'POST', '/api/v1/contacts', { phone: '5215581000003', name: 'Dana' })).json();
  await h.app.inject({ method: 'POST', url: `/webhook/${h.token}`, payload: { event: 'messages.upsert', instance: 'palmas', data: { key: { remoteJid: '99887766554433@lid', remoteJidAlt: '5215581000003@s.whatsapp.net', fromMe: false, id: `LID-${Date.now()}` }, pushName: 'Dana', message: { conversation: 'Hola' }, messageTimestamp: Math.floor(Date.now() / 1000) } } });
  await h.idle();
  const lid = await contactsWith('5581000003');
  assert.equal(lid.length, 1);
  assert.equal(lid[0].id, d.id);
  assert.equal(lid[0].external_id, '99887766554433@lid');
  // Y al darlo de alta otra vez por la API, lo encuentra por su teléfono aunque su identificador sea @lid.
  assert.equal((await call(writeKey, 'POST', '/api/v1/contacts', { phone: '55 8100 0003' })).json().id, d.id);
});

t('datos del cliente: números y sí/no se aceptan, los campos definidos se validan y null borra', async () => {
  await h.authed('POST', `/api/contact-fields?account_id=${h.accountId}`, { key: 'cumple', label: 'Cumpleaños', type: 'date' });
  await h.authed('POST', `/api/contact-fields?account_id=${h.accountId}`, { key: 'plan', label: 'Plan', type: 'option', options: ['Oro', 'Plata'] });
  const c = await call(writeKey, 'POST', '/api/v1/contacts', { phone: '5215581000004', data: { edad: 30, cumple: '03/11/1990', plan: 'oro', vip: true, ciudad: 'Monterrey' } });
  assert.equal(c.statusCode, 201, c.body);
  assert.deepEqual(c.json().data, { edad: '30', cumple: '1990-11-03', plan: 'Oro', vip: 'sí', ciudad: 'Monterrey' });
  const bad = await call(writeKey, 'PUT', `/api/v1/contacts/${c.json().id}`, { data: { edad: 'treinta', plan: 'Bronce' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'invalid_request');
  assert.deepEqual(bad.json().fields.map((f: any) => f.field), ['data.edad', 'data.plan']);
  assert.match(bad.json().fields[1].message, /Oro, Plata/);
  const cleared = (await call(writeKey, 'PUT', `/api/v1/contacts/${c.json().id}`, { data: { vip: null, ciudad: '' } })).json();
  assert.deepEqual(cleared.data, { edad: '30', cumple: '1990-11-03', plan: 'Oro' });
});

t('errores con código: llave, permiso, id mal formado, JSON roto y campos', async () => {
  const none = await call(null, 'GET', '/api/v1/me');
  assert.equal(none.json().code, 'missing_key');
  assert.equal((await call('rr_inventada_inventada_inventada', 'GET', '/api/v1/me')).json().code, 'invalid_key');
  const ro = await call(readKey, 'POST', '/api/v1/contacts', { phone: '5215581000005' });
  assert.equal(ro.statusCode, 403);
  assert.equal(ro.json().code, 'read_only_key');
  const badId = await call(readKey, 'GET', '/api/v1/contacts/no-es-un-id');
  assert.equal(badId.statusCode, 404);
  assert.equal(badId.json().code, 'not_found');
  assert.equal((await call(readKey, 'GET', '/api/v1/receivables/123/x')).json().code, 'route_not_found');
  const json = await h.app.inject({ method: 'POST', url: '/api/v1/contacts', payload: '{"phone": ', headers: { authorization: `Bearer ${writeKey}`, 'content-type': 'application/json' } });
  assert.equal(json.statusCode, 400);
  assert.equal(json.json().code, 'invalid_json');
  const msg = await call(writeKey, 'POST', '/api/v1/messages', { phone: '5215581000005' });
  assert.equal(msg.statusCode, 400);
  assert.deepEqual(msg.json().fields.map((f: any) => f.field), ['text']);
  assert.ok(Array.isArray(msg.json().issues) && typeof msg.json().error === 'string', 'se conservan error e issues');
});

t('Idempotency-Key: repetir devuelve lo mismo sin volver a enviar; otro cuerpo con la misma llave es un error', async () => {
  h.reset();
  const body = { phone: '5215581000006', text: 'Tu cita quedó confirmada' };
  const first = await call(writeKey, 'POST', '/api/v1/messages', body, { 'idempotency-key': 'pedido-77' });
  assert.equal(first.statusCode, 200, first.body);
  await waitFor(() => h.sent.some((s) => s.text === body.text));
  const again = await call(writeKey, 'POST', '/api/v1/messages', body, { 'idempotency-key': 'pedido-77' });
  assert.equal(again.statusCode, 200);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.deepEqual(again.json(), first.json());
  await h.idle();
  assert.equal(h.sent.filter((s) => s.text === body.text).length, 1, 'no se envió dos veces');
  const other = await call(writeKey, 'POST', '/api/v1/messages', { ...body, text: 'Otro texto' }, { 'idempotency-key': 'pedido-77' });
  assert.equal(other.statusCode, 409);
  assert.equal(other.json().code, 'idempotency_conflict');
  // Un error no se guarda: no hizo nada, así que con la misma llave se puede repetir ya corregido.
  const e1 = await call(writeKey, 'POST', '/api/v1/contacts', { phone: 'x' }, { 'idempotency-key': 'k2' });
  assert.equal(e1.statusCode, 400);
  const fixed = await call(writeKey, 'POST', '/api/v1/contacts', { phone: '5215581000009', name: 'Corregido' }, { 'idempotency-key': 'k2' });
  assert.equal(fixed.statusCode, 201, fixed.body);
  assert.equal(fixed.headers['idempotent-replayed'], undefined);
  // Un mensaje que no salió (se dio de baja) se reintenta con la misma llave cuando ya se puede.
  const c9 = fixed.json();
  await call(writeKey, 'PUT', `/api/v1/contacts/${c9.id}`, { opted_out: true });
  const no = await call(writeKey, 'POST', '/api/v1/messages', { contact_id: c9.id, text: 'Tu factura' }, { 'idempotency-key': 'msg-9' });
  assert.equal(no.statusCode, 422);
  await call(writeKey, 'PUT', `/api/v1/contacts/${c9.id}`, { opted_out: false });
  const yes = await call(writeKey, 'POST', '/api/v1/messages', { contact_id: c9.id, text: 'Tu factura' }, { 'idempotency-key': 'msg-9' });
  assert.equal(yes.statusCode, 200, yes.body);
  assert.equal(yes.json().sent, true);
  // Al borrar los datos del cliente se borran también las respuestas guardadas que los traen.
  assert.equal((await h.authed('DELETE', `/api/contacts/${c9.id}`)).statusCode, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM api_idempotency WHERE strpos(response, $1) > 0`, [c9.id])).rows[0].n, 0);
  const after = await call(writeKey, 'POST', '/api/v1/contacts', { phone: '5215581000009', name: 'Corregido' }, { 'idempotency-key': 'k2' });
  assert.notEqual(after.json().id, c9.id, 'una repetición ya no devuelve al cliente borrado');
  // Si la primera sigue en curso, se avisa en vez de correrla dos veces.
  const keyId = (await pool.query(`SELECT id FROM api_keys WHERE name = 'CRM' AND account_id = $1`, [h.accountId])).rows[0].id;
  const pending = { phone: '5215581000007' };
  const hash = crypto.createHash('sha256').update(`POST /api/v1/contacts\n${JSON.stringify(pending)}`).digest('hex');
  await pool.query(`INSERT INTO api_idempotency (api_key_id, idem_key, request_hash) VALUES ($1, 'corriendo', $2)`, [keyId, hash]);
  const busy = await call(writeKey, 'POST', '/api/v1/contacts', pending, { 'idempotency-key': 'corriendo' });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'idempotency_in_progress');
});

t('con dos WhatsApp hay que decir cuál, y la respuesta dice cuáles hay', async () => {
  const ch2 = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'whatsapp', name: 'Sucursal Norte', config: { instance: 'norte' } });
  assert.equal(ch2.statusCode, 200, ch2.body);
  const r = await call(writeKey, 'POST', '/api/v1/contacts', { phone: '5215581000008' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().code, 'channel_required');
  assert.deepEqual(r.json().channels.map((c: any) => c.name).sort(), ['Sucursal Norte', 'WhatsApp']);
  assert.equal((await call(writeKey, 'POST', '/api/v1/contacts', { phone: '5215581000008', channel_id: ch2.json().id })).statusCode, 201);
  assert.equal((await call(readKey, 'GET', '/api/v1/me')).json().default_channel_id, null);
});
