/**
 * Ningún cliente sin respuesta: si la IA falla, el cliente recibe un mensaje de demora y el equipo un aviso; la
 * conversación se reintenta sola (cuando el cliente vuelve a escribir o cada 10 minutos); un envío incierto no se
 * repite pero el equipo recibe recordatorios; y el monitor marca como falla a los clientes que esperan más de 10 minutos.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let convId = '';
const PHONE = '5215511112222';
const DEMORA = '¡Gracias por escribirnos! Tenemos una pequeña demora; en un momento te respondemos.';
let aiDown = false;

const work = async () => (await pool.query('SELECT * FROM conversation_work WHERE conversation_id = $1', [convId])).rows[0];
const pendingCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'in' AND NOT processed`, [convId])).rows[0].n;
const notices = async (title: string) => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND title = $2`, [h.accountId, title])).rows[0].n;
const toCustomer = (text: string) => h.sent.filter((s) => s.to === PHONE && s.text === text).length;
/** Deja el trabajo como recién terminado: así la espera de abajo mide el intento de este mensaje, no uno anterior. */
const freshWork = () => pool.query(`UPDATE conversation_work SET state = 'done', attempts = 0, revivals = 0, reason = NULL WHERE conversation_id = $1`, [convId]);
/** Deja la conversación en revisión como lo haría la cola al agotar sus intentos (sin dueño: un reintento en curso ya no la sobrescribe). */
const markDead = (reason: string, minutesAgo = 0) =>
  pool.query(`UPDATE conversation_work SET state = 'dead', reason = $2, attempts = 3, updated_at = now() - make_interval(mins => $3), alerted_at = NULL, token = NULL, lease_until = NULL WHERE conversation_id = $1`, [convId, reason, minutesAgo]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  // Los avisos del equipo llegan a los usuarios de la cuenta.
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'dueno@disponible.mx', name: 'Dueño', password: 'Pz-118-Qx-318-Kv', role: 'admin' })).statusCode, 200);
  h.setScript(() => (aiDown ? new Error('proveedor de IA caído') : { messages: ['Hola, con gusto te ayudo'] }));
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { ai: { debounce_seconds: 0.2 } });
  await h.webhook('hola');
  await waitFor(() => h.sent.some((s) => s.to === PHONE));
  await h.idle();
  convId = (await h.conversationFor(PHONE)).id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la IA falla: el cliente recibe el mensaje de demora una sola vez y el equipo un aviso; el mensaje queda pendiente', async () => {
  aiDown = true;
  await h.webhook('¿tienen habitaciones?');
  await waitFor(async () => (await work())?.attempts >= 1, 20000);
  await markDead('processing_error');
  await (h.service as any).aiUnavailable(convId);
  assert.equal(toCustomer(DEMORA), 1, JSON.stringify(h.sent));
  assert.ok((await notices('⚠️ Un cliente espera respuesta')) >= 1);
  assert.ok(await pendingCount() >= 1, 'el mensaje se responde cuando vuelva la IA');
  assert.ok((await work()).alerted_at);
  await (h.service as any).aiUnavailable(convId);
  assert.equal(toCustomer(DEMORA), 1, 'no se repite mientras el último mensaje sea el de demora');
});

t('el cliente vuelve a escribir: la conversación sale de revisión y se le responde', async () => {
  aiDown = false;
  const before = h.sent.length;
  await h.webhook('¿sigues ahí?');
  await waitFor(() => h.sent.slice(before).some((s) => s.to === PHONE && /con gusto te ayudo/.test(s.text)), 15000);
  await h.idle();
  assert.equal(await pendingCount(), 0);
  assert.notEqual((await work()).state, 'dead');
});

t('sin mensaje nuevo: una falla de la IA se reintenta sola cada 10 minutos', async () => {
  aiDown = true;
  await h.webhook('quiero reservar');
  await waitFor(async () => (await work())?.attempts >= 1, 20000);
  await markDead('processing_error', 5);
  assert.deepEqual(await (h.service as any).reviveFailed(), { retried: 0, reminded: 0 }, 'todavía no pasan 10 minutos');
  await markDead('processing_error', 11);
  aiDown = false;
  const before = h.sent.length;
  const r = await (h.service as any).reviveFailed();
  assert.equal(r.retried, 1);
  assert.equal((await work()).revivals, 1);
  await waitFor(() => h.sent.slice(before).some((s) => s.to === PHONE && /con gusto te ayudo/.test(s.text)), 15000);
  await h.idle();
  assert.equal(await pendingCount(), 0);
});

t('envío incierto: un mensaje nuevo no lo repite, pero el equipo recibe un recordatorio cada 30 minutos', async () => {
  aiDown = true;
  await h.webhook('¿me confirmas?');
  await waitFor(async () => (await work())?.attempts >= 1, 20000);
  await markDead('delivery_uncertain');
  aiDown = false;
  const before = h.sent.length;
  await h.webhook('hola?');
  await new Promise((r) => setTimeout(r, 1500));
  await h.idle();
  assert.equal((await work()).state, 'dead', 'un envío que pudo haber llegado no se repite solo');
  assert.equal(h.sent.slice(before).filter((s) => s.to === PHONE).length, 0);
  assert.equal(toCustomer(DEMORA), 1, 'tampoco se agrega el mensaje de demora');
  const first = await (h.service as any).reviveFailed();
  assert.equal(first.reminded, 1);
  assert.equal(await notices('⏰ Un cliente sigue esperando respuesta'), 1);
  assert.equal((await (h.service as any).reviveFailed()).reminded, 0, 'el siguiente recordatorio espera 30 minutos');
  await pool.query(`UPDATE conversation_work SET alerted_at = now() - interval '31 minutes' WHERE conversation_id = $1`, [convId]);
  assert.equal((await (h.service as any).reviveFailed()).reminded, 1);
});

t('monitor: un cliente con el asistente encendido sin respuesta por más de 10 minutos es una falla', async () => {
  const { runChecks } = await import('../src/monitor.js');
  const queueCheck = async () => (await runChecks()).find((c) => c.name === 'queue')!;
  await pool.query(`UPDATE messages SET created_at = now() - interval '5 minutes' WHERE conversation_id = $1 AND direction = 'in' AND NOT processed`, [convId]);
  assert.notEqual((await queueCheck()).status, 'fail', 'menos de 10 minutos todavía no es falla');
  await pool.query(`UPDATE messages SET created_at = now() - interval '11 minutes' WHERE conversation_id = $1 AND direction = 'in' AND NOT processed`, [convId]);
  const c = await queueCheck();
  assert.equal(c.status, 'fail');
  assert.match(c.detail ?? '', /1 cliente sin respuesta/);
  // Si una persona atiende la conversación, no cuenta como cliente desatendido por el asistente.
  await pool.query(`UPDATE conversations SET status = 'human' WHERE id = $1`, [convId]);
  assert.notEqual((await queueCheck()).status, 'fail');
  await pool.query(`UPDATE conversations SET status = 'bot' WHERE id = $1`, [convId]);
});

t('los reintentos automáticos no repiten el aviso al equipo; el último sí', async () => {
  await pool.query(`UPDATE messages SET processed = true WHERE conversation_id = $1`, [convId]);
  await freshWork();
  aiDown = true;
  await h.webhook('¿hay lugar el sábado?');
  await waitFor(async () => (await work())?.attempts >= 1 && (await pendingCount()) >= 1, 20000);
  await markDead('processing_error');
  await pool.query(`UPDATE conversation_work SET revivals = 3 WHERE conversation_id = $1`, [convId]);
  const alerts = await notices('⚠️ Un cliente espera respuesta');
  await (h.service as any).aiUnavailable(convId);
  assert.equal(await notices('⚠️ Un cliente espera respuesta'), alerts, 'el reintento 3 no vuelve a avisar');
  await pool.query(`UPDATE conversation_work SET revivals = 12 WHERE conversation_id = $1`, [convId]);
  await (h.service as any).aiUnavailable(convId);
  assert.equal(await notices('⚠️ Un cliente espera respuesta'), alerts + 1, 'al agotar los reintentos sí');
  aiDown = false;
});

t('mensaje de demora vacío: no se envía nada al cliente, pero el equipo sí recibe el aviso', async () => {
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.equal((await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { ...bot.rules, unavailable_message: '' } })).statusCode, 200);
  await pool.query(`UPDATE messages SET processed = true WHERE conversation_id = $1`, [convId]);
  await freshWork();
  aiDown = true;
  await h.webhook('otra pregunta');
  await waitFor(async () => (await work())?.attempts >= 1 && (await pendingCount()) >= 1, 20000);
  await markDead('processing_error');
  const before = h.sent.length;
  const alerts = await notices('⚠️ Un cliente espera respuesta');
  await (h.service as any).aiUnavailable(convId);
  assert.equal(h.sent.slice(before).filter((s) => s.to === PHONE).length, 0);
  assert.equal(await notices('⚠️ Un cliente espera respuesta'), alerts + 1);
  aiDown = false;
});
