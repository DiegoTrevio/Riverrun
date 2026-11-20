/**
 * Velocidad del panel: caché del navegador para fuentes e imágenes, copias Brotli/gzip hechas al construir la imagen,
 * imágenes de la ayuda en AVIF/WebP y el aviso de peticiones lentas en /metrics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { staticCacheControl, staticOptions } from '../src/static-cache.js';
import { precompressDir } from '../scripts/minify-public.mjs';
import { recordHttpTiming, resetHttpTiming, routeGroup, httpTimingStats, registerHttpTiming } from '../src/observability/http-timing.js';
import { renderMetrics } from '../src/observability/metrics.js';

const root = path.resolve(import.meta.dirname, '..');

test('las fuentes se guardan un año; las imágenes una semana; JS, CSS y HTML siempre preguntan', () => {
  assert.equal(staticCacheControl('fonts/figtree-latin-400-normal.woff2'), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('img/ayuda/01-importar.webp'), 'public, max-age=604800');
  assert.equal(staticCacheControl('img/logo.svg.br'), 'public, max-age=604800', 'la copia comprimida guarda lo mismo que el original');
  for (const f of ['app.js', 'js/core.js', 'styles.css', 'index.html', 'fonts/Figtree-OFL.txt']) assert.equal(staticCacheControl(f), null, f);
});

function tempPublic(files: Record<string, string | Buffer>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riverrun-speed-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const BIG = `export const x = ${JSON.stringify('Hola '.repeat(2000))};\n`;

test('al construir, cada archivo de texto grande queda con su copia Brotli y gzip idéntica al original; lo chico no', () => {
  const dir = tempPublic({ 'js/big.js': BIG, 'small.css': 'a{b:c}', 'img/foto.jpg': Buffer.alloc(4000, 7) });
  try {
    precompressDir(dir);
    assert.equal(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'js/big.js.br'))).toString(), BIG);
    assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'js/big.js.gz'))).toString(), BIG);
    assert.ok(!fs.existsSync(path.join(dir, 'small.css.br')), 'un archivo de menos de 1 KB no se comprime');
    assert.ok(!fs.existsSync(path.join(dir, 'img/foto.jpg.br')), 'las imágenes ya vienen comprimidas');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el backend entrega la copia Brotli a quien la acepta, el original a quien no, y la caché de cada archivo', async () => {
  const dir = tempPublic({ 'js/big.js': BIG, 'fonts/f.woff2': Buffer.alloc(10, 1) });
  precompressDir(dir);
  const app = Fastify();
  await app.register(fastifyStatic, staticOptions(dir));
  try {
    const br = await app.inject({ url: '/js/big.js', headers: { 'accept-encoding': 'br, gzip' } });
    assert.equal(br.statusCode, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.match(String(br.headers['content-type']), /javascript/);
    assert.match(String(br.headers.vary), /accept-encoding/i);
    assert.equal(zlib.brotliDecompressSync(br.rawPayload).toString(), BIG);
    const gz = await app.inject({ url: '/js/big.js', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    const plain = await app.inject({ url: '/js/big.js' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body, BIG);
    assert.equal(plain.headers['cache-control'], 'public, max-age=0', 'los módulos siempre preguntan si cambiaron');
    const font = await app.inject({ url: '/fonts/f.woff2' });
    assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('las capturas de la ayuda van en AVIF y WebP con la JPG de respaldo, con tamaño fijo y carga diferida', () => {
  const html = fs.readFileSync(path.join(root, 'public/ayuda.html'), 'utf8');
  const pictures = [...html.matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((m) => m[1]);
  assert.ok(pictures.length >= 4);
  assert.equal((html.match(/<img /g) ?? []).length, pictures.length, 'cada imagen va dentro de un <picture>');
  for (const p of pictures) {
    const jpg = /<img src="\/(img\/ayuda\/[\w-]+)\.jpg"/.exec(p)?.[1];
    assert.ok(jpg, p);
    assert.match(p, new RegExp(`srcset="/${jpg}\\.avif" type="image/avif"`));
    assert.match(p, new RegExp(`srcset="/${jpg}\\.webp" type="image/webp"`));
    assert.match(p, /width="\d+" height="\d+"/);
    assert.match(p, /loading="lazy"/);
    const size = (ext: string) => fs.statSync(path.join(root, 'public', `${jpg}.${ext}`)).size;
    assert.ok(size('webp') < size('jpg') && size('avif') < size('jpg'), `${jpg}: las versiones nuevas pesan menos`);
  }
});

test('cada respuesta se agrupa por sección de la ruta del código, sin la URL real', () => {
  assert.equal(routeGroup('/api/conversations/:id'), 'conversations');
  assert.equal(routeGroup('/api/v1/contacts'), 'api_v1');
  assert.equal(routeGroup('/webhook/:token'), 'webhook');
  assert.equal(routeGroup('/*'), 'archivos');
  assert.equal(routeGroup(undefined), 'sin_ruta');
});

test('una petición que pasa del límite cuenta como lenta y aparece en /metrics', () => {
  resetHttpTiming();
  assert.equal(recordHttpTiming('/api/quotes', 120, 2000), false);
  assert.equal(recordHttpTiming('/api/quotes', 2500, 2000), true);
  assert.equal(recordHttpTiming('/api/quotes', 9000, 0), false, 'con 0 no se avisa');
  assert.deepEqual(httpTimingStats(), [{ group: 'quotes', requests: 3, slow: 1, durationMsSum: 11620 }]);
  const text = renderMetrics([], { incidents: {}, channels: [], ai: [], inbound: [], uptimeSeconds: 1, rssBytes: 1, pool: { total: 0, idle: 0, waiting: 0 }, http: httpTimingStats() });
  assert.match(text, /riverrun_http_requests\{group="quotes"\} 3/);
  assert.match(text, /riverrun_http_slow_requests\{group="quotes"\} 1/);
  assert.match(text, /riverrun_http_duration_ms_sum\{group="quotes"\} 11620/);
  resetHttpTiming();
});

test('la petición lenta queda en el registro con la ruta del código, sin el token de la URL', async () => {
  resetHttpTiming();
  const lines: string[] = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (l: string) => { lines.push(l); } } } });
  registerHttpTiming(app, 20);
  app.get('/webhook/:token', async () => { await new Promise((r) => setTimeout(r, 40)); return { ok: true }; });
  app.get('/health', async () => { await new Promise((r) => setTimeout(r, 40)); return { ok: true }; });
  try {
    await app.inject({ url: '/webhook/secreto-de-la-url-1234567890' });
    await app.inject({ url: '/health' });
    const slow = lines.map((l) => JSON.parse(l)).filter((l) => /Petición lenta/.test(l.msg));
    assert.equal(slow.length, 1, 'la salud no se mide');
    assert.equal(slow[0].route, '/webhook/:token');
    assert.doesNotMatch(lines.join(''), /secreto-de-la-url/);
    assert.deepEqual(httpTimingStats().map((s) => s.group), ['webhook']);
  } finally {
    await app.close();
    resetHttpTiming();
  }
});
