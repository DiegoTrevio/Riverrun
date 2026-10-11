/**
 * Prueba de carga de solo lectura: se niega a correr fuera de loopback, sin confirmación de staging o sin token; y con
 * un servidor local (que solo acepta GET) mide, y sale con código 1 cuando se superan los umbrales.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'load-test.mjs');
const { parseArgs, refusal, percentile, summarize, verdict } = await import('../scripts/load-test.mjs');
const TOKEN = 'token-de-carga-prueba-0123456789';

const methods: string[] = [];
const authSeen: Record<string, string> = {};
let metricsStatus = 200;
const server = http.createServer((req, res) => {
  methods.push(req.method ?? '');
  const path = req.url ?? '';
  if (path.startsWith('/health/functional') || path === '/metrics') authSeen[path] = String(req.headers.authorization ?? '');
  const authed = req.headers.authorization === `Bearer ${TOKEN}`;
  if (path === '/metrics' && metricsStatus !== 200) {
    res.writeHead(metricsStatus);
    return res.end('fallo inyectado');
  }
  if ((path === '/health/functional' || path === '/metrics') && !authed) {
    res.writeHead(401);
    return res.end('{}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

/** Ejecuta el script como lo haría una persona, con el entorno que se le pasa. */
function runScript(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test('se niega fuera de loopback, aunque tenga confirmación y token (no sale ninguna petición)', async () => {
  const r = await runScript([], { BASE_URL: 'http://10.0.0.5:3000', LOAD_TEST_TARGET: 'staging', HEALTH_TOKEN: TOKEN });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no es loopback/);
});

test('se niega sin la confirmación LOAD_TEST_TARGET=staging, y también con otro valor', async () => {
  for (const target of ['', 'production']) {
    const r = await runScript([], { BASE_URL: base, HEALTH_TOKEN: TOKEN, ...(target ? { LOAD_TEST_TARGET: target } : {}) });
    assert.equal(r.code, 2, `target="${target}"`);
    assert.match(r.stderr, /LOAD_TEST_TARGET=staging/);
  }
});

test('se niega sin HEALTH_TOKEN', async () => {
  const r = await runScript([], { BASE_URL: base, LOAD_TEST_TARGET: 'staging' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /HEALTH_TOKEN/);
});

test('con todo en orden solo hace GET, cumple los umbrales y reporta por endpoint', async () => {
  methods.length = 0;
  const r = await runScript(['--duration', '2', '--concurrency', '3'], { BASE_URL: base, LOAD_TEST_TARGET: 'staging', HEALTH_TOKEN: TOKEN });
  assert.equal(r.code, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.ok(summary.requests > 0);
  assert.equal(summary.error_rate, 0);
  for (const p of ['/health', '/health/ready', '/health/functional', '/metrics']) {
    assert.ok(summary.endpoints[p].requests > 0, `sin peticiones a ${p}`);
  }
  assert.ok(methods.length > 0 && methods.every((m) => m === 'GET'), 'solo lectura');
  assert.equal(authSeen['/metrics'], `Bearer ${TOKEN}`);
});

test('un endpoint que falla hace salir con código 1 y lo dice', async () => {
  metricsStatus = 500;
  try {
    const r = await runScript(['--duration', '2', '--concurrency', '3'], { BASE_URL: base, LOAD_TEST_TARGET: 'staging', HEALTH_TOKEN: TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /NO CUMPLE/);
    assert.ok(JSON.parse(r.stdout).error_rate > 0.01);
  } finally {
    metricsStatus = 200;
  }
});

test('parseArgs rechaza opciones desconocidas; refusal rechaza duraciones y concurrencias fuera de rango', () => {
  assert.throws(() => parseArgs(['--rapido'], {}), /Opción desconocida/);
  const base0 = parseArgs([], { LOAD_TEST_TARGET: 'staging', HEALTH_TOKEN: TOKEN });
  assert.equal(refusal(base0), null);
  assert.match(refusal({ ...base0, durationS: 601 }) ?? '', /--duration/);
  assert.match(refusal({ ...base0, concurrency: 51 }) ?? '', /--concurrency/);
  assert.match(refusal({ ...base0, baseUrl: 'no es una url' }) ?? '', /no es una URL válida/);
});

test('percentiles y verdicto: el p95 y la tasa de errores se calculan y se comparan bien', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile([], 95), null);
  const samples = [
    { path: '/health', status: 200, ms: 10 },
    { path: '/health', status: 500, ms: 20 },
    { path: '/metrics', status: 0, ms: 30, error: 'timeout' },
    { path: '/health/ready', status: 200, ms: 40 },
  ];
  const s = summarize(samples, 1);
  assert.equal(s.requests, 4);
  assert.equal(s.error_rate, 0.5);
  assert.equal(s.endpoints['/health'].errors, 1);
  assert.equal(s.endpoints['/metrics'].errors, 1);
  assert.equal(s.endpoints['/health/functional'].requests, 0);
  assert.equal(verdict({ ...s, error_rate: 0 }, 1000).length, 0);
  assert.equal(verdict({ ...s, error_rate: 0, p95_ms: 1500 }, 1000).length, 1);
  assert.equal(verdict(s, 1000).length, 1, 'la tasa de errores también cuenta');
});
