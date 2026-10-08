/** Fidelidad de los datos: lo que se escribe se guarda tal cual, sin perder notas, datos, mensajes ni historial de costo. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let phoneN = 0;
const newPhone = () => `52155${String(7000000 + ++phoneN)}`;
const convOf = (phone: string) => h.conversationFor(phone);
const detailOf = async (convId: string) => (await h.authed('GET', `/api/conversations/${convId}`)).json();
/** Un cliente nuevo que escribe y recibe respuesta: deja creados su contacto y su conversación. */
async function chat(phone: string, text = 'Hola') {
  h.setScript(() => ({ messages: ['¡Hola! ¿En qué te ayudo?'] }));
  await h.webhook(text, { phone });
  await waitFor(() => h.sent.some((s) => s.to === phone));
  await h.idle();
  return convOf(phone);
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ personality: { prompt: 'Eres Sofi, la asistente de un restaurante.' } });
  // Los avisos llegan al equipo de la cuenta: sin integrantes no hay a quién avisar.
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'equipo@clinica.mx', name: 'Equipo', password: 'clave-equipo-1', role: 'agent' });
  assert.equal(u.statusCode, 200, u.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('notas: guardar un dato desde la IA no borra las notas existentes (límite de 50, igual que el panel)', async () => {
  const conv = await chat(newPhone());
  const contactId = (await detailOf(conv.id)).contact.id;
  const notes = Array.from({ length: 40 }, (_, i) => `Nota ${i + 1}`);
  assert.equal((await h.authed('PUT', `/api/contacts/${contactId}`, { notes })).statusCode, 200);
  await store.saveConversationMemory(conv.id, contactId, { data: { ciudad: 'Puebla' }, remember: ['Le gustan los tacos al pastor'] });
  const saved = (await detailOf(conv.id)).contact.notes as string[];
  assert.equal(saved.length, 41, 'ninguna nota se pierde');
  assert.equal(saved[0], 'Nota 1');
});

t('panel: si la IA guardó datos después de abrir el formulario, el guardado se rechaza y no pisa esos datos', async () => {
  const conv = await chat(newPhone());
  const before = await detailOf(conv.id);
  const contactId = before.contact.id;
  const seenVersion = before.conversation.data_version;
  await store.saveConversationMemory(conv.id, contactId, { data: { nombre_completo: 'Luis Pérez' }, remember: [] });
  const stale = await h.authed('PUT', `/api/contacts/${contactId}`, { data: { ciudad: 'Puebla' }, base_data_version: seenVersion });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.match(stale.json().error, /Recarga/);
  const now = await detailOf(conv.id);
  assert.equal(now.contact.data.nombre_completo, 'Luis Pérez', 'el dato de la IA sigue ahí');
  assert.equal(now.contact.data.ciudad, undefined, 'el guardado rechazado no se aplicó');
  const fresh = await h.authed('PUT', `/api/contacts/${contactId}`, { data: { nombre_completo: 'Luis Pérez', ciudad: 'Puebla' }, base_data_version: now.conversation.data_version });
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal((await detailOf(conv.id)).contact.data.ciudad, 'Puebla');
});

t('onboarding: repetirlo no reemplaza el prompt que la persona escribió ni crea otro asistente', async () => {
  const botCount = async () => (await pool.query('SELECT count(*)::int AS n FROM chatbots WHERE account_id = $1', [h.accountId])).rows[0].n as number;
  const before = await botCount();
  const r = await h.authed('POST', `/api/onboarding/assistant?account_id=${h.accountId}`, {
    business_type: 'restaurante', assistant_name: 'Sofi', description: '', knowledge: { catalog: 'Tacos al pastor $25 la orden' },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().kept_configuration, true);
  assert.equal(await botCount(), before, 'no crea otro asistente');
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.equal(bot.personality.prompt, 'Eres Sofi, la asistente de un restaurante.', 'el prompt escrito se conserva');
});

t('onboarding: dos envíos seguidos de una cuenta nueva crean un solo asistente', async () => {
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Cafetería nueva' })).json();
  const body = { business_type: 'cafeteria', assistant_name: 'Lu', description: '', knowledge: { catalog: 'Café americano $30' } };
  const [a, b] = await Promise.all([
    h.authed('POST', `/api/onboarding/assistant?account_id=${acc.id}`, body),
    h.authed('POST', `/api/onboarding/assistant?account_id=${acc.id}`, body),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM chatbots WHERE account_id = $1', [acc.id])).rows[0].n, 1);
});

t('reinicio: los mensajes sin respuesta de hace más de 15 minutos avisan al equipo y quedan registrados', async () => {
  const conv = await chat(newPhone());
  const old = await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', type: 'text', content: '¿Tienen mesas para 10?', processed: false });
  await pool.query(`UPDATE messages SET created_at = now() - interval '1 hour' WHERE id = $1`, [old!.id]);
  await h.service.resumePending();
  const [row] = (await pool.query('SELECT processed FROM messages WHERE id = $1', [old!.id])).rows;
  assert.equal(row.processed, true, 'ya no se contesta fuera de tiempo');
  const alerts = (await pool.query(`SELECT title FROM notifications WHERE account_id = $1 AND title LIKE '%sin respuesta tras un reinicio%'`, [h.accountId])).rows;
  assert.ok(alerts.length >= 1, 'el equipo se entera');
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE account_id = $1 AND message LIKE 'Reinicio:%'`, [h.accountId])).rows;
  assert.ok(logs.length >= 1, 'queda registrado');
});

t('equipo: borrar a una persona la quita de los servicios que atendía', async () => {
  const u = (await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'temporal@equipo.mx', name: 'Temporal', password: 'clave-temporal-1', role: 'agent' })).json();
  const s = await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Limpieza', kind: 'appointment', duration_minutes: 30, assigned_user_ids: [u.id] });
  assert.equal(s.statusCode, 200, s.body);
  assert.equal((await h.authed('DELETE', `/api/users/${u.id}`)).statusCode, 200);
  const row = (await pool.query('SELECT assigned_user_ids FROM services WHERE id = $1', [s.json().id])).rows[0];
  assert.deepEqual(row.assigned_user_ids, []);
});

t('costo de IA: borrar un asistente conserva su historial de costo', async () => {
  const bot = (await h.authed('POST', '/api/chatbots', { account_id: h.accountId, name: 'Asistente temporal', active: false, ai: {} })).json();
  await pool.query(`INSERT INTO ai_runs (account_id, chatbot_id, kind, model, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, 'decision', 'modelo-prueba', 100, 20, 0.25)`, [h.accountId, bot.id]);
  assert.equal((await h.authed('DELETE', `/api/chatbots/${bot.id}`)).statusCode, 200);
  const rows = (await pool.query(`SELECT chatbot_id, cost_usd FROM ai_runs WHERE account_id = $1 AND model = 'modelo-prueba'`, [h.accountId])).rows;
  assert.equal(rows.length, 1, 'el costo sigue registrado');
  assert.equal(rows[0].chatbot_id, null);
  assert.equal(Number(rows[0].cost_usd), 0.25);
});

t('planes: una cuenta solo acepta un plan que existe; si la clave queda inválida, no se queda sin límites', async () => {
  assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { plan: 'plan-que-no-existe' })).statusCode, 400);
  await pool.query(`UPDATE accounts SET plan = 'borrado' WHERE id = $1`, [h.accountId]);
  const { effectiveLimits } = await import('../src/billing/limits.js');
  const eff = await effectiveLimits(h.accountId);
  assert.ok(Object.keys(eff.limits).length > 0, 'con un plan inválido se aplican límites restrictivos, no ilimitados');
  await pool.query(`UPDATE accounts SET plan = '' WHERE id = $1`, [h.accountId]);
});

t('base de datos: rechaza servicios de menos de 5 minutos y conteos de mensajes negativos', async () => {
  const s = (await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Consulta', kind: 'appointment', duration_minutes: 30 })).json();
  await assert.rejects(pool.query('UPDATE services SET duration_minutes = 0 WHERE id = $1', [s.id]), (e: any) => e.code === '23514');
  await assert.rejects(pool.query(`INSERT INTO usage_counters (account_id, month, messages) VALUES ($1, '2000-01', -1)`, [h.accountId]), (e: any) => e.code === '23514');
});

t('mensajes con caracteres raros: un NUL se guarda visible y el mensaje no se pierde', async () => {
  const phone = newPhone();
  h.setScript(() => ({ messages: ['Claro'] }));
  await h.webhook('hola\u0000 mundo', { phone });
  await waitFor(() => h.sent.some((s) => s.to === phone));
  await h.idle();
  const conv = await convOf(phone);
  const rows = (await pool.query(`SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [conv.id])).rows as { content: string }[];
  assert.ok(rows.some((r) => r.content === 'hola\\u0000 mundo'), JSON.stringify(rows));
});

t('texto: el corte por caracteres no parte un emoji y los surrogates sueltos se reemplazan', async () => {
  const { truncateChars, cleanText } = await import('../src/engine/text.js');
  const cut = truncateChars('a'.repeat(1999) + '😀' + 'b', 2000);
  assert.equal(Array.from(cut).length, 2000);
  assert.equal(cut.slice(-2), '😀', 'el emoji entero');
  assert.equal(cleanText('x\ud83dy'), 'x�y');
  assert.equal(cleanText('ok\u0000!'), 'ok\\u0000!');
});

const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
/** Sube una foto al asistente de pruebas, con el mismo formato que usa el panel. */
async function uploadPhoto(code: string) {
  const b = '----x';
  const part = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const fields = { code, name: code, caption: '', send_when: JSON.stringify({ mode: 'rules', keywords: ['foto'] }) };
  const body = Buffer.concat([
    Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join('')),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${code}.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: body, headers: { cookie: h.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
}

t('fotos: la huella SHA-256 guardada es la del archivo subido, y una foto cortada se rechaza', async () => {
  const { completeImage } = await import('../src/routes/util.js');
  assert.equal(completeImage(PNG, 'image/png'), true);
  assert.equal(completeImage(PNG.subarray(0, PNG.length - 30), 'image/png'), false, 'sin el final del archivo no es una foto completa');
  const up = await uploadPhoto('huella');
  assert.equal(up.statusCode, 200, up.body);
  const row = (await pool.query(`SELECT sha256 FROM images WHERE chatbot_id = $1 AND code = 'huella'`, [h.botId])).rows[0];
  assert.equal(row.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
  const cut = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: Buffer.concat([Buffer.from('--x\r\nContent-Disposition: form-data; name="code"\r\n\r\ncortada\r\n--x\r\nContent-Disposition: form-data; name="name"\r\n\r\ncortada\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n'), PNG.subarray(0, 60), Buffer.from('\r\n--x--\r\n')]), headers: { cookie: h.cookie, 'content-type': 'multipart/form-data; boundary=x' } });
  assert.equal(cut.statusCode, 400, cut.body);
});

t('duplicar un asistente: si falta una foto no se crea una copia a medias', async () => {
  await h.authed('PUT', `/api/accounts/${h.accountId}`, { limits_override: { chatbots: 10 } });
  const up = await uploadPhoto('carta');
  assert.equal(up.statusCode, 200, up.body);
  const row = (await pool.query(`SELECT file_path FROM images WHERE chatbot_id = $1 AND code = 'carta'`, [h.botId])).rows[0];
  await fs.rm(path.join(process.env.UPLOADS_DIR as string, row.file_path), { force: true }); // el arnés fija UPLOADS_DIR
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM chatbots WHERE account_id = $1', [h.accountId])).rows[0].n as number;
  const before = await count();
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/duplicate`, {});
  assert.equal(r.statusCode, 500, r.body);
  assert.equal(await count(), before, 'no queda una copia sin fotos');
});

t('IMEI y tarjetas: un IMEI no se enmascara; una tarjeta sí', async () => {
  const { cardNumbersIn, maskSensitive } = await import('../src/engine/safety.js');
  assert.deepEqual(cardNumbersIn('Mi IMEI es 490154203237518'), [], 'un IMEI de 15 dígitos no es una tarjeta');
  assert.equal(maskSensitive('Mi IMEI es 490154203237518'), 'Mi IMEI es 490154203237518');
  assert.equal(maskSensitive('Mi tarjeta 4111 1111 1111 1111'), 'Mi tarjeta •••• 1111');
  assert.equal(maskSensitive('Amex 3782 822463 10005'), 'Amex •••• 0005');
});

t('correo: un "De:" dentro del mensaje no lo corta; un reenvío sí se quita; htmlToText convierte correos en HTML', async () => {
  const { stripQuoted } = await import('../src/channels/email.js');
  const { htmlToText } = await import('../src/knowledge-import.js');
  assert.equal(stripQuoted('Hola\nDe: lunes a viernes\nQuiero cita'), 'Hola\nDe: lunes a viernes\nQuiero cita');
  assert.equal(stripQuoted('Quiero cita\n\nDe: Ana <ana@x.mx>\nEnviado: lunes\nAsunto: hola\nmensaje viejo'), 'Quiero cita');
  assert.equal(stripQuoted('Hola\nEl lun, 5 oct, Ana escribió:\n> mensaje viejo'), 'Hola');
  assert.equal(htmlToText('<p>Quiero <b>cita</b> el martes</p>'), 'Quiero cita el martes');
});

t('archivos de conocimiento: un CSV en Windows-1252 conserva sus acentos', async () => {
  const { decodeText, sourceFromFile } = await import('../src/knowledge-import.js');
  assert.equal(decodeText(Buffer.from([0xd1, 0x61, 0x6e, 0x64, 0xfa])), 'Ñandú');
  assert.equal(decodeText(Buffer.from('Ñandú', 'utf8')), 'Ñandú', 'UTF-8 sigue funcionando');
  const src = sourceFromFile({ buffer: Buffer.concat([Buffer.from('producto;precio\n'), Buffer.from([0xd1, 0x61, 0x6e, 0x64, 0xfa, 0x3b, 0x32, 0x35, 0x0a])]), mime: 'text/csv', filename: 'productos.csv' });
  assert.equal(src.kind, 'text');
  assert.equal((src as any).text, 'producto;precio\nÑandú;25\n');
});

t('datos del cliente: se aceptan si cada palabra salió de lo que escribió; un dato inventado no', async () => {
  const { customerProvided } = await import('../src/engine/customer-data.js');
  const direccion = { key: 'direccion', label: 'Dirección', type: 'text', options: [], description: '', required: false, ask_when: '' } as any;
  const said = ['calle Juárez 15 col centro'];
  assert.equal(customerProvided(direccion, 'Calle Juárez 15, Col. Centro', said), true);
  assert.equal(customerProvided(direccion, 'Calle Reforma 200', said), false);
});

t('palabras clave: los emojis y otros alfabetos también disparan; solo palabras completas', async () => {
  const { matchKeyword } = await import('../src/engine/engine.js');
  assert.equal(matchKeyword('🙋 quiero hablar', ['🙋']), '🙋');
  assert.equal(matchKeyword('quiero hablar con alguien', ['hablar con alguien']), 'hablar con alguien');
  assert.equal(matchKeyword('человек пожалуйста', ['человек']), 'человек');
  assert.equal(matchKeyword('hablaremos mañana', ['habla']), null, 'solo palabras completas');
});

t('correos por encima del freno: se guardan en el historial sin respuesta', async () => {
  const channel = await store.getChannel(h.channelId);
  h.reset();
  const r = await h.service.handleIncoming(channel!, { messageId: 'cap-1', externalId: 'ana@cliente.mx', phone: '', displayName: 'Ana', fromMe: false, type: 'text', text: 'Quiero una cita el martes', timestamp: Math.floor(Date.now() / 1000), captureOnly: true });
  await h.idle();
  assert.equal(h.calls.length, 0, 'no se contesta');
  const msg = (await pool.query(`SELECT content, processed, meta FROM messages WHERE id = $1`, [r.messageId])).rows[0];
  assert.equal(msg.content, 'Quiero una cita el martes');
  assert.equal(msg.processed, true);
  assert.equal(msg.meta.held, 'limite_de_correos');
});
