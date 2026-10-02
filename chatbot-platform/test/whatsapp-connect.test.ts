/** Conexión de WhatsApp: QR inmediato que se renueva solo, código por número, recuperación y confirmación del número. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, evo, ext, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let other: Awaited<ReturnType<typeof h.loginAs>>;
const C = { id: '', token: '', instance: '' };

const session = (body: Record<string, unknown> = {}, api = admin) => api('POST', `/api/channels/${C.id}/whatsapp/session`, body);
const evoCalls = (frag: string) => ext.requests.filter((r) => r.path.includes(frag));
const ageQr = (seconds: number) => pool.query(`UPDATE channels SET qr_at = now() - make_interval(secs => $2) WHERE id = $1`, [C.id, seconds]);
const webhook = (payload: Record<string, unknown>) => h.app.inject({ method: 'POST', url: `/webhook/${C.token}`, payload: { instance: C.instance, ...payload } });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  for (const [name, email] of [['Clínica Sonrisa', 'duena@sonrisa.mx'], ['Otra', 'otra@otra.mx']]) {
    const r = await h.authed('POST', '/api/accounts', { name, admin: { name: 'Dueña', email, password: 'clave-segura-1' } });
    assert.equal(r.statusCode, 200, r.body);
  }
  admin = await h.loginAs('duena@sonrisa.mx', 'clave-segura-1');
  other = await h.loginAs('otra@otra.mx', 'clave-segura-1');
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'WhatsApp' })).json();
  Object.assign(C, { id: ch.id, token: ch.webhook_token, instance: ch.config.instance });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la primera consulta crea la instancia y entrega el QR de inmediato (con la llave global, nunca expuesta)', async () => {
  ext.requests.length = 0;
  const r = await session();
  assert.equal(r.statusCode, 200, r.body);
  const s = r.json();
  assert.equal(s.state, 'connecting');
  assert.equal(s.qr, 'data:image/png;base64,QR1');
  assert.equal(s.expires_in, 30);
  assert.ok(evo.instances.has(C.instance));
  const create = evoCalls('/instance/create')[0];
  assert.deepEqual(create.body.webhook.events, ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'], 'escucha los QR nuevos');
  assert.ok(ext.requests.every((x) => x.headers.apikey === 'llave-global-de-pruebas'));
  // El QR no viaja en el listado de canales.
  const list = JSON.stringify((await admin('GET', '/api/channels')).json());
  assert.ok(!list.includes('QR1') && !list.includes('qr_code'));
});

t('mientras se escanea, el mismo QR se reutiliza; al vencer (30 s) se pide uno nuevo', async () => {
  ext.requests.length = 0;
  const again = (await session()).json();
  assert.equal(again.qr, 'data:image/png;base64,QR1');
  assert.equal(evoCalls('/instance/connect/').length, 0, 'consultar cada 3 s no reinicia la vinculación');
  await ageQr(31);
  const fresh = (await session()).json();
  assert.equal(fresh.qr, 'data:image/png;base64,QR2');
  assert.equal(evoCalls('/instance/connect/').length, 1);
  assert.equal(evoCalls('/webhook/set/').length, 1, 'el webhook se reconfigura al renovar');
  // "Reintentar" fuerza uno nuevo aunque no haya vencido.
  assert.equal((await session({ refresh: true })).json().qr, 'data:image/png;base64,QR3');
});

t('el QR que Evolution manda por webhook (qrcode.updated) se usa en la siguiente consulta', async () => {
  const r = await webhook({ event: 'QRCODE_UPDATED', data: { qrcode: { instance: C.instance, base64: 'data:image/png;base64,QRWEB' } } });
  assert.equal(r.statusCode, 200);
  await waitFor(async () => (await session()).json().qr === 'data:image/png;base64,QRWEB');
});

t('código por número: valida, agrega la lada de México y entrega el código de 8 caracteres', async () => {
  assert.equal((await session({ mode: 'code', number: '12345' })).statusCode, 400);
  ext.requests.length = 0;
  const r = await session({ mode: 'code', number: '81 1111 2222' });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.json().pairingCode, /^PAIR\d{4}$/);
  assert.equal(r.json().expires_in, 120);
  assert.equal(evoCalls('/instance/connect/')[0].query.get('number'), '528111112222');
  // Mientras lo teclea, el código no cambia.
  assert.equal((await session({ mode: 'code', number: '528111112222' })).json().pairingCode, r.json().pairingCode);
});

t('instancia trabada (no genera QR): se recrea sola una vez y entrega un QR', async () => {
  evo.stuck.add(C.instance);
  await ageQr(60);
  ext.requests.length = 0;
  const r = await session();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().qr, 'data:image/png;base64,QR1', 'QR de la instancia recién creada');
  assert.equal(evoCalls('/instance/delete/').length, 1);
  assert.equal(evoCalls('/instance/create').length, 1);
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE channel_id = $1`, [C.id])).rows.map((x) => x.message);
  assert.ok(logs.some((m) => /no generó código; se recrea/.test(m)));
});

t('Evolution caído: mensaje claro (el detalle técnico queda en Registros)', async () => {
  evo.down = true;
  try {
    await ageQr(60);
    const r = await session();
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /No pudimos comunicarnos con el servidor de WhatsApp/);
    assert.ok(!/503|Evolution/.test(r.json().error));
  } finally {
    evo.down = false;
  }
});

t('al conectar: se borra el QR, se guarda el número y el nombre, y avisa si el número ya está en otro canal', async () => {
  evo.instances.get(C.instance)!.state = 'open';
  await webhook({ event: 'connection.update', data: { state: 'open' } });
  const s = (await session()).json();
  assert.equal(s.state, 'open');
  assert.equal(s.qr, null);
  assert.deepEqual(s.profile, { number: '5218111112222', name: 'Clínica Sonrisa' });
  assert.equal(s.warning, undefined);
  const ch = (await admin('GET', `/api/channels/${C.id}`)).json();
  assert.equal(ch.connection_state, 'open');
  assert.equal(ch.config.number, '5218111112222');
  assert.equal(ch.config.profile_name, 'Clínica Sonrisa');
  const row = (await pool.query(`SELECT qr_code, pairing_code FROM channels WHERE id = $1`, [C.id])).rows[0];
  assert.deepEqual(row, { qr_code: null, pairing_code: null });

  // Segundo canal de la misma cuenta vinculado con el mismo teléfono → aviso.
  const ch2 = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'WhatsApp 2' })).json();
  const r2 = (await admin('POST', `/api/channels/${ch2.id}/whatsapp/session`, {})).json();
  assert.equal(r2.state, 'connecting');
  evo.instances.get(ch2.config.instance)!.state = 'open';
  const w = (await admin('POST', `/api/channels/${ch2.id}/whatsapp/session`, {})).json();
  assert.match(w.warning, /también está conectado en el canal "WhatsApp"/);
});

t('desconectar a propósito: sin alerta de "se desconectó"; otra cuenta no puede pedir el QR', async () => {
  assert.equal((await session({}, other)).statusCode, 404);
  const r = await admin('POST', `/api/channels/${C.id}/whatsapp/logout`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await admin('GET', `/api/channels/${C.id}`)).json().connection_state, 'close');
  const notes = (await admin('GET', '/api/notifications')).json().items;
  assert.ok(!notes.some((n: any) => n.title === 'Tu WhatsApp se desconectó'));
  // Para volver a vincular, el QR aparece de nuevo al instante.
  const again = (await session()).json();
  assert.equal(again.state, 'connecting');
  assert.ok(again.qr);
});
