/** Monitoreo: salud, alertas con confirmación, latido y estado de respaldos. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { config } = await import('../src/config.js');
const mon = await import('../src/monitor.js');

const hits: { url: string; body: string }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { hits.push({ url: req.url!, body: Buffer.concat(chunks).toString() }); res.writeHead(200); res.end('OK'); });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-backups-'));
const writeStatus = (s: Record<string, unknown>) => fs.writeFileSync(path.join(backupDir, 'status.json'), JSON.stringify(s));
const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
const by = (checks: any[], name: string) => checks.find((c) => c.name === name)!;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  config.openai.apiKey = 'clave-de-prueba';
  config.monitor.backupDir = backupDir;
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('/health/ready: 200 con el sistema sano y sin exponer detalles', async () => {
  const r = await h.app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(['ok', 'warn'].includes(body.status));
  assert.deepEqual(body.checks.map((c: any) => c.name), ['database', 'whatsapp', 'scheduler', 'ai', 'backup', 'disk']);
  assert.ok(body.checks.every((c: any) => !('detail' in c)));
  assert.equal((await h.app.inject({ method: 'GET', url: '/health' })).json().ok, true);
});

t('tareas atrasadas ponen el sistema en rojo (503)', async () => {
  await pool.query(`INSERT INTO jobs (type, run_at) VALUES ('prueba', now() - interval '20 minutes')`);
  const r = await h.app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(r.statusCode, 503);
  assert.equal(by(r.json().checks, 'scheduler').status, 'fail');
  await pool.query(`DELETE FROM jobs WHERE type = 'prueba'`);
  assert.equal((await h.app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
});

t('sin clave de IA el asistente no puede responder: es un fallo', async () => {
  config.openai.apiKey = '';
  try {
    assert.equal(by(await mon.runChecks(), 'ai').status, 'fail');
  } finally {
    config.openai.apiKey = 'clave-de-prueba';
  }
});

t('respaldos: sin respaldo, correcto, viejo, fallido y sin nube', async () => {
  fs.rmSync(path.join(backupDir, 'status.json'), { force: true });
  assert.equal(by(await mon.runChecks(), 'backup').status, 'warn');
  writeStatus({ ok: true, last_success_at: hoursAgo(3), remote: '', remote_ok: null, error: '' });
  assert.equal(by(await mon.runChecks(), 'backup').status, 'ok');
  writeStatus({ ok: true, last_success_at: hoursAgo(50), remote: '', error: '' });
  assert.equal(by(await mon.runChecks(), 'backup').status, 'fail');
  writeStatus({ ok: false, last_success_at: hoursAgo(5), error: 'Falló la verificación' });
  const failed = by(await mon.runChecks(), 'backup');
  assert.equal(failed.status, 'warn');
  assert.match(failed.detail, /Falló la verificación/);
  writeStatus({ ok: false, last_success_at: hoursAgo(60), error: 'sin espacio' });
  assert.equal(by(await mon.runChecks(), 'backup').status, 'fail');
  writeStatus({ ok: true, last_success_at: hoursAgo(1), remote: 'bk:bucket/riverrun', remote_ok: false, error: '' });
  assert.equal(by(await mon.runChecks(), 'backup').status, 'warn');
});

t('alertas: avisa al segundo fallo seguido, no repite y avisa al recuperarse', async () => {
  const sent: string[] = [];
  const send = async (title: string) => { sent.push(title); };
  const st = mon.newAlertState();
  const bad = [{ name: 'database', label: 'Base de datos', status: 'fail' as const, detail: 'caída' }];
  const good = [{ name: 'database', label: 'Base de datos', status: 'ok' as const, detail: '' }];
  const t0 = Date.now();
  await mon.evaluateAlerts(bad, st, send, t0);
  assert.equal(sent.length, 0, 'un solo fallo puede ser pasajero');
  await mon.evaluateAlerts(bad, st, send, t0 + 60_000);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Base de datos/);
  await mon.evaluateAlerts(bad, st, send, t0 + 120_000);
  assert.equal(sent.length, 1, 'no repite enseguida');
  await mon.evaluateAlerts(bad, st, send, t0 + 7 * 3600_000);
  assert.equal(sent.length, 2, 'recuerda cada 6 horas');
  await mon.evaluateAlerts(good, st, send, t0 + 7 * 3600_000 + 60_000);
  assert.equal(sent.length, 3);
  assert.match(sent[2], /recuperó/);
  await mon.evaluateAlerts(good, st, send, t0 + 8 * 3600_000);
  assert.equal(sent.length, 3, 'estar sano no genera avisos');
  await mon.evaluateAlerts([{ ...bad[0], status: 'warn' }], st, send, t0 + 9 * 3600_000);
  assert.equal(sent.length, 3, 'las advertencias no alertan');
});

t('el aviso llega por webhook y por correo', async () => {
  const { outbox } = await import('../src/mailer.js');
  config.monitor.alertWebhookUrl = `${base}/alerta`;
  config.signup.superadminEmail = 'operador@riverrun.mx';
  try {
    await mon.sendAlert('🔴 Riverrun: prueba', 'detalle del problema');
    const hook = hits.find((x) => x.url === '/alerta')!;
    assert.ok(hook, 'llegó al webhook');
    assert.match(JSON.parse(hook.body).text, /detalle del problema/);
    assert.ok(outbox.some((m) => m.to === 'operador@riverrun.mx' && m.subject.includes('prueba')));
  } finally {
    config.monitor.alertWebhookUrl = '';
    config.signup.superadminEmail = '';
  }
});

t('latido: se envía si lo esencial funciona y se calla si no', async () => {
  config.monitor.heartbeatUrl = `${base}/latido`;
  try {
    const good = await mon.runChecks();
    assert.equal(await mon.heartbeat(good), true);
    assert.equal(hits.filter((x) => x.url === '/latido').length, 1);
    const bad = good.map((c) => (c.name === 'database' ? { ...c, status: 'fail' as const } : c));
    assert.equal(await mon.heartbeat(bad), false);
    assert.equal(hits.filter((x) => x.url === '/latido').length, 1, 'con la base caída no manda latido');
    config.monitor.heartbeatUrl = '';
    assert.equal(await mon.heartbeat(good), false);
  } finally {
    config.monitor.heartbeatUrl = '';
  }
});

t('estado del sistema: solo el superadmin', async () => {
  const r = await h.authed('GET', '/api/system/status');
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(Array.isArray(body.checks) && body.checks.length === 6);
  assert.equal(typeof body.uptime_seconds, 'number');
  assert.ok(body.backup && body.backup.remote_ok === false);
  const signup = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.8.8.8', payload: { name: 'Ana', company: 'Otra', business_type: 'otro', email: 'ana@otra.mx', password: 'clave-ana-123', accept_terms: true } });
  assert.equal(signup.statusCode, 200, signup.body);
  const cookie = String(signup.headers['set-cookie']).split(';')[0];
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/system/status', headers: { cookie } })).statusCode, 403);
});
