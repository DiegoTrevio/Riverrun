/**
 * Que nada quede desatendido 24/7: el vigilante reinicia un proceso colgado, una tarea programada colgada no detiene a
 * las demás, WhatsApp se vigila y se reconecta solo (y se vuelve a avisar si sigue caído), los avisos urgentes llegan
 * también por correo y el equipo recibe recordatorios si un cliente espera a una persona.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, dbAvailable, evo, ext, pool, store, waitFor } from './harness.js';

const { stalledLoops, startWatchdog, tick } = await import('../src/watchdog.js');
const { Scheduler } = await import('../src/automation/scheduler.js');
const astore = await import('../src/automation/store.js');
const { config } = await import('../src/config.js');
const { outbox } = await import('../src/mailer.js');
const { watchWhatsapp } = await import('../src/whatsapp-watch.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const ADMIN = 'dueno@resiliencia.mx';
const setAlerts = async (patch: Record<string, unknown>) => {
  const s = await astore.getSettings(h.accountId);
  await astore.saveSettings(h.accountId, { ...s, connection_alerts: { ...s.connection_alerts, ...patch } });
};
const notices = async (like: string) => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND title LIKE $2`, [h.accountId, like])).rows[0].n;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, email: ADMIN, name: 'Dueño', password: 'clave-dueno-1', role: 'admin' })).statusCode, 200);
  // Estas pruebas avisan de inmediato; la espera configurable tiene sus propias pruebas al final.
  await setAlerts({ after_minutes: 0 });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

/* ------------------------------ Vigilante ------------------------------ */

test('vigilante: detecta un bucle de trabajo que dejó de avanzar', () => {
  tick('prueba');
  const now = Date.now();
  assert.deepEqual(stalledLoops(['prueba'], 60_000, now + 1000), []);
  const stalled = stalledLoops(['prueba'], 60_000, now + 61_000);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].name, 'prueba');
});

test('vigilante: avisa (para reiniciar) cuando un bucle no avanza', async () => {
  const fired: string[][] = [];
  const w = startWatchdog({ loops: ['quieto'], stallMs: 1500, blockMs: 600_000, onStall: (l) => { fired.push(l.map((x) => x.name)); } });
  try {
    await waitFor(() => fired.length > 0, 8000);
    assert.deepEqual(fired[0], ['quieto']);
  } finally {
    w.stop();
  }
});

test('vigilante: un proceso con el bucle de eventos bloqueado se termina solo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilante-'));
  const script = path.join(dir, 'bloqueado.mts');
  const watchdog = path.resolve('src/watchdog.ts');
  fs.writeFileSync(script, `import { startWatchdog } from ${JSON.stringify(watchdog)};
startWatchdog({ loops: [], stallMs: 600000, blockMs: 1500, onStall: () => {} });
setTimeout(() => { const end = Date.now() + 60000; while (Date.now() < end) {} }, 300);
`);
  const child = fork(script, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += d; });
  const started = Date.now();
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(signal, 'SIGKILL', `código ${code}; ${stderr}`);
  assert.ok(Date.now() - started < 30_000, 'se terminó antes de que el bloqueo acabara solo');
  assert.match(stderr, /dejó de responder/);
});

/* ------------------------------ Tareas programadas ------------------------------ */

t('una tarea programada colgada se corta y se reintenta sin detener a las demás', async () => {
  const prev = config.jobTimeoutMs;
  config.jobTimeoutMs = 300;
  const done: string[] = [];
  const s = new Scheduler({
    colgada: () => new Promise(() => undefined),
    normal: async (p) => { done.push(String(p.n)); },
  });
  try {
    const stuck = await astore.scheduleJob({ account_id: h.accountId, type: 'colgada', payload: {}, run_at: new Date(Date.now() - 1000) });
    await astore.scheduleJob({ account_id: h.accountId, type: 'normal', payload: { n: 1 }, run_at: new Date() });
    await s.runDue();
    assert.deepEqual(done, ['1'], 'la tarea siguiente sí corrió');
    const row = (await pool.query('SELECT status, last_error FROM jobs WHERE id = $1', [stuck!.id])).rows[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.last_error, 'job_timeout');
  } finally {
    config.jobTimeoutMs = prev;
    await s.stop();
    await pool.query(`DELETE FROM jobs WHERE type IN ('colgada','normal')`);
  }
});

/* ------------------------------ WhatsApp ------------------------------ */

const waState = async () => (await pool.query(`SELECT connection_state, down_since, disconnect_notified_at FROM channels WHERE id = $1`, [h.channelId])).rows[0];
const connects = () => ext.requests.filter((r) => r.path === '/instance/connect/palmas').length;
/** Canal conectado y en línea, sin avisos previos. */
async function linked() {
  evo.instances.set('palmas', { state: 'open', qrN: 1 });
  const ch = (await store.getChannel(h.channelId))!;
  await store.updateChannel(ch.id, { config: { ...ch.config, number: '5218111112222' } });
  await pool.query(`UPDATE channels SET connection_state = 'open', connection_state_at = now(), down_since = NULL, disconnect_notified_at = NULL, qr_at = NULL, pairing_at = NULL WHERE id = $1`, [ch.id]);
  await pool.query(`DELETE FROM notifications WHERE account_id = $1 AND title LIKE 'Tu WhatsApp%'`, [h.accountId]);
  await watchWhatsapp(Date.now()); // limpia el conteo de revisiones fallidas
  return ch;
}

t('WhatsApp: una sesión caída se detecta, se avisa una vez, se intenta reconectar y vuelve a quedar en línea', async () => {
  await linked();
  let now = Date.now() + 3600_000;
  evo.instances.get('palmas')!.state = 'close';
  const before = connects();
  const first = await watchWhatsapp(now);
  assert.equal(first.down, 0, 'una sola revisión no basta (Evolution puede estar reconectando)');
  assert.equal((await waState()).connection_state, 'open');
  now += 5 * 60_000;
  const second = await watchWhatsapp(now);
  assert.equal(second.down, 1);
  const st = await waState();
  assert.equal(st.connection_state, 'close');
  assert.ok(st.down_since, 'se marca desde cuándo está caído');
  assert.equal(await notices('Tu WhatsApp se desconectó'), 1, 'un solo aviso');
  assert.ok(outbox.some((m) => m.to === ADMIN && /WhatsApp se desconectó/.test(m.subject)), 'aviso por correo');
  assert.equal(connects(), before + 1, 'se intentó reconectar');
  now += 5 * 60_000;
  await watchWhatsapp(now);
  assert.equal(connects(), before + 1, 'el siguiente intento espera 15 minutos');
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 1, 'sin avisos repetidos antes de 6 horas');
  evo.instances.get('palmas')!.state = 'open';
  await watchWhatsapp(now + 60_000);
  const back = await waState();
  assert.equal(back.connection_state, 'open');
  assert.equal(back.down_since, null);
});

t('WhatsApp: los eventos repetidos de Evolution no reinician la cuenta; si sigue caído se avisa cada 6 horas', async () => {
  const ch = await linked();
  evo.instances.get('palmas')!.state = 'close';
  await pool.query(`UPDATE channels SET connection_state = 'close', down_since = now() - interval '7 hours', disconnect_notified_at = now() - interval '7 hours' WHERE id = $1`, [ch.id]);
  // Evolution vuelve a mandar "close" (por ejemplo, tras un intento de reconexión): no cambia desde cuándo está caído.
  const { recordConnectionState } = await import('../src/lifecycle.js');
  await recordConnectionState(ch, 'close');
  assert.ok(Date.now() - new Date((await waState()).down_since).getTime() > 6.9 * 3600_000);
  const now = Date.now() + 1000;
  await watchWhatsapp(now);
  const r = await watchWhatsapp(now + 1000);
  assert.equal(r.notified, 1);
  assert.equal(await notices('%sigue así desde hace 7 h%'), 1);
  assert.equal((await watchWhatsapp(now + 2000)).notified, 0, 'no se repite antes de 6 horas');
});

t('WhatsApp: si la caída pasa por "connecting" (sin aviso del webhook), la vigilancia avisa', async () => {
  const ch = await linked();
  const { recordConnectionState } = await import('../src/lifecycle.js');
  await recordConnectionState(ch, 'connecting');
  await recordConnectionState(ch, 'close');
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 0, 'el webhook no avisó');
  evo.instances.get('palmas')!.state = 'close';
  const now = Date.now() + 1000;
  await watchWhatsapp(now);
  assert.equal((await watchWhatsapp(now + 1000)).notified, 1);
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 1);
});

t('WhatsApp: no se toca un canal desconectado a propósito ni se pide otro QR mientras alguien escanea', async () => {
  const ch = await linked();
  evo.instances.get('palmas')!.state = 'close';
  await store.setConnectionStateQuiet(ch.id, 'close');
  const before = connects();
  let now = Date.now() + 1000;
  await watchWhatsapp(now);
  await watchWhatsapp(now + 1000);
  assert.equal(connects(), before, 'sin reconexión');
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 0, 'sin avisos');
  // Caída real, pero con un QR recién mostrado en el panel: no se pide otro.
  await linked();
  evo.instances.get('palmas')!.state = 'close';
  await pool.query(`UPDATE channels SET qr_at = now() WHERE id = $1`, [ch.id]);
  now = Date.now() + 2000;
  await watchWhatsapp(now);
  await watchWhatsapp(now + 1000);
  assert.equal(connects(), before, 'no se invalida el QR que se está escaneando');
  evo.instances.get('palmas')!.state = 'open';
  await watchWhatsapp(now + 2000);
});

/* ------------------------------ Avisos por correo y espera de una persona ------------------------------ */

t('los avisos urgentes al equipo también llegan por correo', async () => {
  const before = outbox.length;
  await h.service.automator.alertTeam(h.accountId, { title: '⚠️ Un cliente espera respuesta', body: 'Ana escribió y el asistente no pudo responder.', link: '#/conversations', kind: 'ai_error' });
  const mail = outbox.slice(before).find((m) => m.to === ADMIN);
  assert.ok(mail, 'correo al administrador');
  assert.equal(mail!.subject, 'Un cliente espera respuesta');
  const quiet = outbox.length;
  await h.service.automator.alertTeam(h.accountId, { title: 'Aviso informativo', body: 'Nada urgente', kind: 'info' });
  assert.equal(outbox.length, quiet, 'lo no urgente no se manda por correo');
});

t('cliente esperando a una persona: el equipo recibe un recordatorio y se repite cada 2 horas', async () => {
  await h.webhook('quiero hablar con alguien', { phone: '5215577778888' });
  await waitFor(async () => !!(await pool.query(`SELECT 1 FROM contacts WHERE phone = '5215577778888'`)).rows.length, 10000);
  await h.idle();
  const conv = await h.conversationFor('5215577778888');
  await pool.query(`UPDATE conversations SET status = 'human', human_reminded_at = NULL WHERE id = $1`, [conv.id]);
  await pool.query(`UPDATE messages SET created_at = now() - interval '40 minutes' WHERE conversation_id = $1`, [conv.id]);
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, processed, created_at) VALUES ($1, 'in', 'customer', 'text', '¿hola?', true, now() - interval '31 minutes')`, [conv.id]);
  assert.equal(await h.service.remindHumanWaiting(), 1);
  assert.equal(await notices('⏳ Un cliente espera a una persona'), 1);
  assert.equal(await h.service.remindHumanWaiting(), 0, 'no se repite enseguida');
  await pool.query(`UPDATE conversations SET human_reminded_at = now() - interval '3 hours' WHERE id = $1`, [conv.id]);
  assert.equal(await h.service.remindHumanWaiting(), 1, 'se repite pasadas 2 horas');
  // Ya le respondió una persona: no hay recordatorio.
  await pool.query(`UPDATE conversations SET human_reminded_at = NULL WHERE id = $1`, [conv.id]);
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, processed) VALUES ($1, 'out', 'human', 'text', 'Hola, ¿en qué te ayudo?', true)`, [conv.id]);
  assert.equal(await h.service.remindHumanWaiting(), 0);
});

/* ------------------------------ Avisos de desconexión según lo que define el negocio ------------------------------ */

const close = (reason?: number) => h.app.inject({ method: 'POST', url: `/webhook/${h.token}`, payload: { event: 'connection.update', instance: 'palmas', data: { state: 'close', ...(reason ? { statusReason: reason } : {}) } } });
const open = () => h.app.inject({ method: 'POST', url: `/webhook/${h.token}`, payload: { event: 'connection.update', instance: 'palmas', data: { state: 'open' } } });

t('espera definida: no se avisa de un corte breve; si sigue caído al cumplirse los minutos, sí', async () => {
  await linked();
  await setAlerts({ after_minutes: 5, enabled: true, notify_admins: true });
  evo.instances.get('palmas')!.state = 'close';
  assert.equal((await close()).statusCode, 200);
  await waitFor(async () => (await waState()).connection_state === 'close', 5000);
  const now = Date.now();
  await watchWhatsapp(now);
  await watchWhatsapp(now + 60_000);
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 0, 'antes de 5 minutos no se avisa');
  await pool.query(`UPDATE channels SET down_since = now() - interval '6 minutes' WHERE id = $1`, [h.channelId]);
  assert.equal((await watchWhatsapp(now + 120_000)).notified, 1);
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 1);
  // Vuelve: se avisa que regresó.
  evo.instances.get('palmas')!.state = 'open';
  await open();
  await waitFor(async () => (await notices('Tu WhatsApp volvió a conectarse')) === 1, 5000);
  await setAlerts({ after_minutes: 0 });
});

t('sesión cerrada desde el teléfono: se avisa de inmediato que hay que escanear el QR y no se intenta reconectar', async () => {
  await linked();
  await setAlerts({ after_minutes: 30 });
  evo.instances.get('palmas')!.state = 'close';
  await close(401);
  await waitFor(async () => (await notices('Hay que volver a vincular tu WhatsApp')) === 1, 5000);
  assert.equal((await waState()).connection_state, 'close');
  assert.equal((await pool.query(`SELECT disconnect_reason FROM channels WHERE id = $1`, [h.channelId])).rows[0].disconnect_reason, 'logged_out');
  const mail = outbox.filter((m) => m.to === ADMIN && /volver a vincular/.test(m.subject)).at(-1);
  assert.match(mail?.text ?? '', /escanear el código QR/);
  const before = connects();
  const now = Date.now() + 1000;
  await watchWhatsapp(now);
  await watchWhatsapp(now + 1000);
  assert.equal(connects(), before, 'reconectar no sirve: solo generaría QR nuevos');
  await setAlerts({ after_minutes: 0 });
  evo.instances.get('palmas')!.state = 'open';
  await open();
});

t('a quién avisar: correos y WhatsApp adicionales (desde otro WhatsApp conectado); sin administradores si así se define', async () => {
  await linked();
  const other = (await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'whatsapp', name: 'WhatsApp recepción', chatbot_id: h.botId, config: { instance: 'recepcion' } })).json();
  evo.instances.set('recepcion', { state: 'open', qrN: 1 });
  await pool.query(`UPDATE channels SET connection_state = 'open' WHERE id = $1`, [other.id]);
  await setAlerts({ after_minutes: 0, notify_admins: false, emails: ['soporte@resiliencia.mx'], phones: ['5215566667777'] });
  h.reset();
  const mails = outbox.length;
  await close();
  await waitFor(async () => outbox.slice(mails).some((m) => m.to === 'soporte@resiliencia.mx'), 5000);
  await waitFor(() => h.sent.some((s) => s.to === '5215566667777' && /se desconectó/.test(s.text)), 5000);
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 0, 'sin aviso en el panel a los administradores');
  assert.ok(!outbox.slice(mails).some((m) => m.to === ADMIN), 'ni por correo');
  // La alerta de prueba llega a los mismos destinatarios.
  const test = (await h.authed('POST', `/api/settings/test-connection-alert?account_id=${h.accountId}`)).json();
  assert.deepEqual({ admins: test.admins, emails: test.emails, phones: test.phones, failed: test.failed }, { admins: 0, emails: 1, phones: 1, failed: [] });
  await setAlerts({ notify_admins: true, emails: [], phones: [] });
  await pool.query(`UPDATE channels SET active = false WHERE id = $1`, [other.id]);
  await open();
});

t('avisos apagados: no se envía nada, pero se sigue intentando reconectar', async () => {
  await linked();
  await setAlerts({ enabled: false, after_minutes: 0 });
  evo.instances.get('palmas')!.state = 'close';
  await close();
  const before = connects();
  const now = Date.now() + 10 * 3600_000; // después de los intentos de las pruebas anteriores (cada 15 min)
  await watchWhatsapp(now);
  await watchWhatsapp(now + 1000);
  assert.equal(await notices('Tu WhatsApp se desconectó%'), 0);
  assert.equal(connects(), before + 1, 'la reconexión automática sigue');
  await setAlerts({ enabled: true });
  evo.instances.get('palmas')!.state = 'open';
  await open();
});

t('ajustes: un correo o número inválido no se guarda', async () => {
  const s = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  const bad = await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { ...s, connection_alerts: { ...s.connection_alerts, emails: ['no-es-correo'] } });
  assert.equal(bad.statusCode, 400);
  const badPhone = await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { ...s, connection_alerts: { ...s.connection_alerts, phones: ['abc'] } });
  assert.equal(badPhone.statusCode, 400);
});
