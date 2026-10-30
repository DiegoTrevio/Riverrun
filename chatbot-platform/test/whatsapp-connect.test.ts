/** Conexión de WhatsApp: QR inmediato que se renueva solo, código por número, recuperación y confirmación del número. */
import { after, afterEach, before, test } from 'node:test';
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
const { attempts } = await import('../src/channels/whatsapp-session.js');
const webhook = (payload: Record<string, unknown>) => h.app.inject({ method: 'POST', url: `/webhook/${C.token}`, payload: { instance: C.instance, ...payload } });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  for (const [name, email] of [['Clínica Sonrisa', 'duena@sonrisa.mx'], ['Otra', 'otra@otra.mx']]) {
    const r = await h.authed('POST', '/api/accounts', { name, admin: { name: 'Dueña', email, password: 'Pz-144-Qx-344-Kv' } });
    assert.equal(r.statusCode, 200, r.body);
  }
  admin = await h.loginAs('duena@sonrisa.mx', 'Pz-144-Qx-344-Kv');
  other = await h.loginAs('otra@otra.mx', 'Pz-144-Qx-344-Kv');
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'WhatsApp' })).json();
  Object.assign(C, { id: ch.id, token: ch.webhook_token, instance: ch.config.instance });
});
// Session scenarios reserve temporary profiles; keep only the shared fixture between cases.
afterEach(async () => {
  if (h && C.id) await pool.query("DELETE FROM channels WHERE type = 'whatsapp' AND id <> $1 AND account_id = (SELECT account_id FROM channels WHERE id = $1)", [C.id]);
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
  assert.equal(create.body.webhook.enabled, true, 'el webhook se activa al crear la instancia');
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

t('código por número: valida, agrega la lada de México y reinicia la vinculación con el número (Evolution no lo toma mientras espera un QR)', async () => {
  assert.equal((await session({ mode: 'code', number: '12345' })).statusCode, 400);
  ext.requests.length = 0;
  const r = await session({ mode: 'code', number: '81 1111 2222', refresh: true }); // el clic en "Obtener código" fuerza la solicitud
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().pairingCode, 'NEWC0DE1', 'el código de la instancia creada con el número');
  assert.equal(r.json().expires_in, 40, 'se reutiliza menos de lo que Evolution tarda en cambiarlo (45 s)');
  assert.equal(evoCalls('/instance/create')[0]?.body.number, '528111112222', 'la instancia se crea con el número');
  assert.equal(evoCalls('/instance/delete/').length, 1, 'la que esperaba un QR se descarta (aún no tenía sesión)');
  // Mientras lo teclea, el código no cambia ni se reinicia la vinculación.
  ext.requests.length = 0;
  assert.equal((await session({ mode: 'code', number: '528111112222' })).json().pairingCode, 'NEWC0DE1');
  assert.equal(evoCalls('/instance/').filter((x) => /create|delete|connect\//.test(x.path)).length, 0);
  // "Pedir otro": la instancia ya vincula con ese número; Evolution entrega el código vigente, sin recrear.
  const another = (await session({ mode: 'code', number: '528111112222', refresh: true })).json();
  assert.match(another.pairingCode, /^PAIR\d{4}$/);
  assert.equal(evoCalls('/instance/delete/').length, 0);
  assert.equal(evoCalls('/instance/connect/')[0].query.get('number'), '528111112222');
  // Evolution pide un código nuevo con cada QR y solo el último sirve: el que llega por webhook es el que se muestra.
  await webhook({ event: 'QRCODE_UPDATED', data: { qrcode: { instance: C.instance, base64: 'data:image/png;base64,QRX', pairingCode: 'LAST0001' } } });
  await waitFor(async () => (await session({ mode: 'code', number: '528111112222' })).json().pairingCode === 'LAST0001');
  // Otro número: la vinculación vuelve a empezar con él (el código anterior era de otro teléfono).
  ext.requests.length = 0;
  attempts.get(C.id)!.recreateAt = 0;
  const changed = (await session({ mode: 'code', number: '5215599998888', refresh: true })).json();
  assert.equal(changed.pairingCode, 'NEWC0DE1');
  assert.equal(evoCalls('/instance/create')[0]?.body.number, '5215599998888');
});

t('un código por webhook no aparece si nadie está vinculando por número', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Solo QR' })).json();
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${ch.webhook_token}`, payload: { instance: ch.config.instance, event: 'qrcode.updated', data: { qrcode: { base64: 'QRSOLO', pairingCode: 'AJENO001' } } } });
  assert.equal(r.statusCode, 200);
  await waitFor(async () => (await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {})).json().qr === 'data:image/png;base64,QRSOLO');
  assert.equal((await pool.query(`SELECT pairing_code FROM channels WHERE id = $1`, [ch.id])).rows[0].pairing_code, null);
});

t('sin código todavía: no reinicia la vinculación en cada consulta ni recrea la instancia antes de tiempo', async () => {
  evo.stuck.add(C.instance);
  await ageQr(60);
  attempts.delete(C.id);
  ext.requests.length = 0;
  for (let i = 0; i < 4; i++) {
    const r = (await session()).json();
    assert.equal(r.state, 'connecting');
    assert.equal(r.qr, null);
    assert.equal(r.preparing, true);
  }
  assert.equal(evoCalls('/instance/connect/').length, 1, 'una sola solicitud en 4 consultas (máximo una cada 15 s)');
  assert.equal(evoCalls('/instance/delete/').length, 0, 'no se recrea mientras no lleve 45 s sin código');
  // Si mientras tanto llega el QR por webhook, se muestra de inmediato.
  await webhook({ event: 'qrcode.updated', data: { qrcode: { base64: 'data:image/png;base64,QRLATE' } } });
  // El webhook responde de inmediato y procesa después: se espera a que el QR quede guardado.
  await waitFor(async () => (await session()).json().qr === 'data:image/png;base64,QRLATE');
});

t('instancia trabada (45 s sin código): se recrea sola una vez y entrega un QR', async () => {
  evo.slowDeleteMs = 700; // como Evolution real, el nombre sigue ocupado un momento tras borrarla
  evo.stuck.add(C.instance);
  await ageQr(60);
  attempts.set(C.id, { connectAt: 0, recreateAt: 0, waitingSince: Date.now() - 60_000 });
  ext.requests.length = 0;
  const r = await session();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().qr, 'data:image/png;base64,QR1', 'QR de la instancia recién creada');
  assert.equal(evoCalls('/instance/delete/').length, 1);
  assert.ok(evoCalls('/instance/create').length >= 2, 'reintenta la creación mientras Evolution libera el nombre');
  evo.slowDeleteMs = 0;
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE channel_id = $1`, [C.id])).rows.map((x) => x.message);
  assert.ok(logs.some((m) => /no generó código; se recrea/.test(m)));
  // Y no vuelve a recrearse enseguida aunque siguiera sin código.
  evo.stuck.add(C.instance);
  await ageQr(60);
  attempts.get(C.id)!.connectAt = 0;
  attempts.get(C.id)!.waitingSince = Date.now() - 60_000;
  ext.requests.length = 0;
  assert.equal((await session()).json().preparing, true);
  assert.equal(evoCalls('/instance/delete/').length, 0, 'máximo una recreación cada 2 minutos');
  evo.stuck.delete(C.instance);
});

t('Evolution caído: mensaje claro (el detalle técnico queda en Registros)', async () => {
  evo.down = true;
  try {
    await ageQr(60);
    attempts.delete(C.id);
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

t('dos pestañas y el endpoint anterior reutilizan el mismo QR sin reiniciar la vinculación', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Dos pestañas' })).json();
  ext.requests.length = 0;
  const [a, b] = await Promise.all([
    admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {}),
    admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {}),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(a.json().qr, b.json().qr);
  assert.ok(a.json().qr);
  assert.equal(evoCalls('/instance/create').length, 1);
  assert.equal(evoCalls('/instance/connect/').length, 0);
  const old = await admin('POST', `/api/channels/${ch.id}/whatsapp/connect`, {});
  assert.equal(old.statusCode, 200, old.body);
  assert.equal(old.json().qr, a.json().qr);
  assert.equal(evoCalls('/instance/connect/').length, 0);
});

t('cada cuenta prepara su propia instancia y webhook; un QR nuevo no cambia el de otra cuenta', async () => {
  const a = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Cuenta A' })).json();
  const b = (await other('POST', '/api/channels', { type: 'whatsapp', name: 'Cuenta B' })).json();
  assert.notEqual(a.config.instance, b.config.instance);
  ext.requests.length = 0;
  const results = await Promise.all([
    admin('POST', `/api/channels/${a.id}/whatsapp/session`, {}),
    other('POST', `/api/channels/${b.id}/whatsapp/session`, {}),
  ]);
  assert.ok(results.every((r) => r.statusCode === 200 && r.json().qr));
  const creates = evoCalls('/instance/create');
  assert.equal(creates.length, 2);
  assert.equal(creates.find((r) => r.body.instanceName === a.config.instance)?.body.webhook.url, `http://backend:3000/webhook/${a.webhook_token}`);
  assert.equal(creates.find((r) => r.body.instanceName === b.config.instance)?.body.webhook.url, `http://backend:3000/webhook/${b.webhook_token}`);
  const update = await h.app.inject({ method: 'POST', url: `/webhook/${a.webhook_token}`, payload: { instance: a.config.instance, event: 'qrcode.updated', data: { qrcode: { base64: 'QROFA' } } } });
  assert.equal(update.statusCode, 200);
  await waitFor(async () => (await admin('POST', `/api/channels/${a.id}/whatsapp/session`, {})).json().qr === 'data:image/png;base64,QROFA');
  assert.equal((await other('POST', `/api/channels/${b.id}/whatsapp/session`, {})).json().qr, results[1].json().qr);
  assert.equal((await other('POST', `/api/channels/${a.id}/whatsapp/session`, {})).statusCode, 404);
});

t('un error al pedir QR no se oculta ni elimina una instancia; el siguiente intento se recupera', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Fallo temporal' })).json();
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  await pool.query('UPDATE channels SET qr_at = now() - interval \'1 minute\' WHERE id = $1', [ch.id]);
  attempts.set(ch.id, { connectAt: 0, recreateAt: 0, waitingSince: Date.now() - 60_000 });
  evo.connectErrors.set(ch.config.instance, 400);
  ext.requests.length = 0;
  try {
    const r = await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /WhatsApp no aceptó la solicitud/);
    assert.equal(evoCalls('/instance/delete/').length, 0);
    assert.equal(evoCalls('/instance/logout/').length, 0);
  } finally { evo.connectErrors.delete(ch.config.instance); }
  const recovered = await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.ok(recovered.json().qr);
});

t('si el escaneo termina durante connect, confirma la conexión sin recrear la instancia', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Escaneo terminado' })).json();
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  await pool.query('UPDATE channels SET qr_at = now() - interval \'1 minute\' WHERE id = $1', [ch.id]);
  attempts.set(ch.id, { connectAt: 0, recreateAt: 0, waitingSince: Date.now() - 60_000 });
  evo.openOnConnect.add(ch.config.instance);
  ext.requests.length = 0;
  try {
    const r = await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().state, 'open');
    assert.equal(r.json().qr, null);
    assert.equal(evoCalls('/instance/delete/').length, 0);
  } finally { evo.openOnConnect.delete(ch.config.instance); }
});

t('un 403 por autorización al crear la instancia no se confunde con un nombre ocupado', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Autorización' })).json();
  ext.requests.length = 0;
  evo.createDenied = true;
  try {
    const r = await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /WhatsApp no aceptó la solicitud/);
    assert.equal(evoCalls('/instance/create').length, 1);
    assert.equal(evo.instances.has(ch.config.instance), false);
  } finally { evo.createDenied = false; }
});

/** Canal vinculado que se cae sin que nadie cierre la sesión: Evolution lo reconecta solo (sin QR: la sesión sigue guardada). */
async function linkedThenDown(name: string) {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name })).json();
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  evo.instances.get(ch.config.instance)!.state = 'open';
  assert.equal((await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {})).json().state, 'open');
  evo.instances.get(ch.config.instance)!.state = 'connecting';
  evo.stuck.add(ch.config.instance);
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${ch.webhook_token}`, payload: { instance: ch.config.instance, event: 'connection.update', data: { state: 'connecting' } } });
  assert.equal(r.statusCode, 200);
  assert.ok((await pool.query(`SELECT down_since FROM channels WHERE id = $1`, [ch.id])).rows[0].down_since, 'quedó marcado como caído');
  return ch;
}
const closeWebhook = (ch: { webhook_token: string }) => async (instance: string) => {
  await h.app.inject({ method: 'POST', url: `/webhook/${ch.webhook_token}`, payload: { instance, event: 'connection.update', data: { state: 'close', statusReason: 401 } } });
};
const relinkNotices = async (accountId: string) =>
  (await pool.query(`SELECT title FROM notifications WHERE account_id = $1 AND (title LIKE 'Hay que volver a vincular%' OR title LIKE 'Tu WhatsApp se desconectó%')`, [accountId])).rows;

t('una sesión vinculada que se reconecta sola no se borra al abrir el panel (ni con QR ni por número)', async () => {
  const ch = await linkedThenDown('Se recupera sola');
  attempts.set(ch.id, { connectAt: 0, recreateAt: 0, waitingSince: Date.now() - 10 * 60_000 });
  ext.requests.length = 0;
  for (const body of [{}, { refresh: true }, { mode: 'code', number: '5218111112222', refresh: true }]) {
    const r = await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, body);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().reconnecting, true, JSON.stringify(body));
    assert.equal(r.json().qr, null);
  }
  assert.equal(evoCalls('/instance/delete/').length + evoCalls('/instance/logout/').length, 0, 'la sesión guardada no se toca');
  assert.ok(evo.instances.has(ch.config.instance));
  // Vuelve sola: la siguiente consulta lo confirma.
  evo.stuck.delete(ch.config.instance);
  evo.instances.get(ch.config.instance)!.state = 'open';
  assert.equal((await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {})).json().state, 'open');
});

t('si la sesión que se recuperaba ya no existe en Evolution (pide QR), el QR se muestra', async () => {
  const ch = await linkedThenDown('Perdió la sesión');
  evo.stuck.delete(ch.config.instance);
  attempts.delete(ch.id);
  const r = (await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {})).json();
  assert.match(String(r.qr), /^data:image\/png;base64,QR\d+$/);
  assert.equal(r.reconnecting, undefined);
});

t('"Vincular de nuevo" descarta la sesión a pedido, entrega un QR nuevo y no se avisa como desconexión', async () => {
  const ch = await linkedThenDown('Vincular de nuevo');
  evo.onLogout = closeWebhook(ch); // Evolution avisa del cierre (401) antes de responder
  try {
    ext.requests.length = 0;
    const r = await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, { relink: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().qr, 'data:image/png;base64,QR1', 'QR de la instancia nueva');
    assert.equal(evoCalls('/instance/delete/').length, 1);
  } finally { evo.onLogout = null; }
  assert.deepEqual(await relinkNotices(ch.account_id), []);
  const row = (await pool.query(`SELECT connection_state, down_since FROM channels WHERE id = $1`, [ch.id])).rows[0];
  assert.equal(row.down_since, null, 'ya no cuenta como caída que se recupera sola');
  // Pulsarlo dos veces seguidas no recrea dos veces.
  ext.requests.length = 0;
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, { relink: true });
  assert.equal(evoCalls('/instance/delete/').length, 0);
});

t('desconectar desde el panel: aunque el aviso de Evolution llegue antes, no se avisa de una caída; ya cerrada no es error', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Desconexión a propósito' })).json();
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  evo.instances.get(ch.config.instance)!.state = 'open';
  assert.equal((await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {})).json().state, 'open');
  evo.onLogout = closeWebhook(ch);
  try {
    const r = await admin('POST', `/api/channels/${ch.id}/whatsapp/logout`);
    assert.equal(r.statusCode, 200, r.body);
  } finally { evo.onLogout = null; }
  assert.deepEqual(await relinkNotices(ch.account_id), [], 'sin "Hay que volver a vincular tu WhatsApp"');
  const row = (await pool.query(`SELECT connection_state, down_since FROM channels WHERE id = $1`, [ch.id])).rows[0];
  assert.deepEqual([row.connection_state, row.down_since], ['close', null]);
  // Evolution responde 400 "is not connected" a una sesión ya cerrada: para el panel es lo mismo.
  const again = await admin('POST', `/api/channels/${ch.id}/whatsapp/logout`);
  assert.equal(again.statusCode, 200, again.body);
});

t('si no se puede desconectar (Evolution caído): mensaje claro y el estado queda como estaba', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'Desconexión fallida' })).json();
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  evo.instances.get(ch.config.instance)!.state = 'open';
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  evo.down = true;
  try {
    const r = await admin('POST', `/api/channels/${ch.id}/whatsapp/logout`);
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /No pudimos desconectar tu WhatsApp/);
    assert.ok(!/Evolution|HTTP/.test(r.json().error));
  } finally { evo.down = false; }
  assert.equal((await pool.query(`SELECT connection_state FROM channels WHERE id = $1`, [ch.id])).rows[0].connection_state, 'open');
});

t('QR agotados ("refused"): queda como cerrada y conserva el motivo anterior', async () => {
  const ch = (await admin('POST', '/api/channels', { type: 'whatsapp', name: 'QR agotados' })).json();
  await admin('POST', `/api/channels/${ch.id}/whatsapp/session`, {});
  await pool.query(`UPDATE channels SET disconnect_reason = 'logged_out' WHERE id = $1`, [ch.id]);
  const r = await h.app.inject({ method: 'POST', url: `/webhook/${ch.webhook_token}`, payload: { instance: ch.config.instance, event: 'connection.update', data: { state: 'refused', statusReason: 428 } } });
  assert.equal(r.statusCode, 200);
  const row = (await pool.query(`SELECT connection_state, disconnect_reason FROM channels WHERE id = $1`, [ch.id])).rows[0];
  assert.deepEqual([row.connection_state, row.disconnect_reason], ['close', 'logged_out']);
});
