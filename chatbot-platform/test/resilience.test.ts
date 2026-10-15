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
const { watchWhatsapp, WATCH } = await import('../src/whatsapp-watch.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const ADMIN = 'dueno@resiliencia.mx';
const notices = async (like: string) => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND title LIKE $2`, [h.accountId, like])).rows[0].n;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, email: ADMIN, name: 'Dueño', password: 'clave-dueno-1', role: 'admin' })).statusCode, 200);
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

t('WhatsApp: una sesión caída se detecta, se intenta reconectar, se avisa y vuelve a quedar en línea', async () => {
  evo.instances.set('palmas', { state: 'open', qrN: 1 });
  const ch = (await store.getChannel(h.channelId))!;
  await store.updateChannel(ch.id, { config: { ...ch.config, number: '5218111112222' } });
  await pool.query(`UPDATE channels SET connection_state = 'open', connection_state_at = now() WHERE id = $1`, [ch.id]);
  let now = Date.now();
  evo.instances.get('palmas')!.state = 'close';
  const connects = () => ext.requests.filter((r) => r.path === '/instance/connect/palmas').length;
  const before = connects();
  const first = await watchWhatsapp(now);
  assert.equal(first.down, 0, 'una sola revisión no basta (Evolution puede estar reconectando)');
  assert.equal((await store.getChannel(ch.id))!.connection_state, 'open');
  now += 5 * 60_000;
  const second = await watchWhatsapp(now);
  assert.equal(second.down, 1);
  assert.equal((await store.getChannel(ch.id))!.connection_state, 'close');
  assert.equal(await notices('Tu WhatsApp se desconectó'), 1);
  assert.ok(outbox.some((m) => m.to === ADMIN && /WhatsApp se desconectó/.test(m.subject)), 'aviso por correo');
  assert.equal(connects(), before + 1, 'se intentó reconectar');
  now += 5 * 60_000;
  await watchWhatsapp(now);
  assert.equal(connects(), before + 1, 'el siguiente intento espera 15 minutos');
  evo.instances.get('palmas')!.state = 'open';
  await watchWhatsapp(now + 60_000);
  assert.equal((await store.getChannel(ch.id))!.connection_state, 'open');
});

t('WhatsApp: si sigue desconectado se vuelve a avisar cada 6 horas', async () => {
  evo.instances.get('palmas')!.state = 'close';
  const ch = (await store.getChannel(h.channelId))!;
  await pool.query(`UPDATE channels SET connection_state = 'close', connection_state_at = now() - interval '7 hours', disconnect_notified_at = now() - interval '7 hours' WHERE id = $1`, [ch.id]);
  const now = Date.now() + WATCH.reconnectEveryMs * 10;
  await watchWhatsapp(now);
  const r = await watchWhatsapp(now + 1000);
  assert.equal(r.renotified, 1);
  assert.equal(await notices('%sigue así desde hace%'), 1);
  const again = await watchWhatsapp(now + 2000);
  assert.equal(again.renotified, 0, 'no se repite antes de 6 horas');
  evo.instances.get('palmas')!.state = 'open';
  await watchWhatsapp(now + 3000);
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
