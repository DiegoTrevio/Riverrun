/**
 * Freno de avisos externos en sandbox: el webhook de alertas y el latido solo salen a destinos de OUTBOUND_SANDBOX_ALLOW.
 * El servidor local cuenta cada petición: si el freno falla, el contador lo delata. En live no cambia nada.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { heartbeat, sendAlert } from '../src/monitor.js';

const hits: { url: string; body: string }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits.push({ url: req.url!, body: Buffer.concat(chunks).toString() });
    res.writeHead(200);
    res.end('OK');
  });
});
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const saved = {
  mode: config.outbound.mode,
  allow: config.outbound.allow,
  webhook: config.monitor.alertWebhookUrl,
  heartbeat: config.monitor.heartbeatUrl,
  email: config.signup.superadminEmail,
};
const restore = () => {
  config.outbound.mode = saved.mode;
  config.outbound.allow = saved.allow;
  config.monitor.alertWebhookUrl = saved.webhook;
  config.monitor.heartbeatUrl = saved.heartbeat;
  config.signup.superadminEmail = saved.email;
};
beforeEach(() => {
  restore();
  hits.length = 0;
  config.signup.superadminEmail = '';
});
after(restore);

const ok = [{ name: 'database', label: 'Base de datos', status: 'ok', detail: '' }, { name: 'scheduler', label: 'Tareas', status: 'ok', detail: '' }] as any;

/** Silencia el aviso de consola mientras se ejecuta `fn` y devuelve lo que se escribió. */
async function captureWarn(fn: () => Promise<void>) {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('sandbox: el webhook de alertas no recibe avisos si su URL no está permitida', async () => {
  config.outbound.mode = 'sandbox';
  config.outbound.allow = [];
  config.monitor.alertWebhookUrl = `${base}/canal-produccion`;
  const warnings = await captureWarn(() => sendAlert('🔴 Riverrun: prueba', 'detalle'));
  assert.equal(hits.length, 0, 'ningún aviso llegó al canal de producción');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OUTBOUND_SANDBOX_ALLOW/);
});

test('sandbox: el webhook de alertas sí recibe avisos si su URL está en OUTBOUND_SANDBOX_ALLOW', async () => {
  config.outbound.mode = 'sandbox';
  config.monitor.alertWebhookUrl = `${base}/canal-pruebas`;
  config.outbound.allow = [`${base}/canal-pruebas`];
  await sendAlert('🔴 Riverrun: prueba', 'detalle');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, '/canal-pruebas');
  assert.match(hits[0].body, /Riverrun: prueba/);
});

test('sandbox: el latido no sale aunque el servicio esté sano', async () => {
  config.outbound.mode = 'sandbox';
  config.outbound.allow = [];
  config.monitor.heartbeatUrl = `${base}/latido-produccion`;
  assert.equal(await heartbeat(ok), false);
  assert.equal(hits.length, 0);
});

test('sandbox: el latido sí sale si su URL está en OUTBOUND_SANDBOX_ALLOW', async () => {
  config.outbound.mode = 'sandbox';
  config.monitor.heartbeatUrl = `${base}/latido-pruebas`;
  config.outbound.allow = [`${base}/latido-pruebas`];
  assert.equal(await heartbeat(ok), true);
  assert.equal(hits.length, 1);
});

test('live: el webhook y el latido funcionan igual que antes (no cambia producción)', async () => {
  config.outbound.mode = 'live';
  config.outbound.allow = [];
  config.monitor.alertWebhookUrl = `${base}/canal-produccion`;
  config.monitor.heartbeatUrl = `${base}/latido-produccion`;
  await sendAlert('🔴 Riverrun: prueba', 'detalle');
  assert.equal(await heartbeat(ok), true);
  assert.equal(hits.length, 2);
});
