/**
 * Bajos de la revisión (IN-8…IN-14, AI-10, AI-11): calendario .ics escapado, asunto de una línea, descargas con tope y con
 * plazo, fuente de conocimiento limpia y nombres de clientes tratados como datos por el Copiloto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { icsEscape, icsFold } from '../src/automation/agenda.js';
import { cleanSubject } from '../src/mailer.js';
import { readCapped } from '../src/channels/media.js';
import { config } from '../src/config.js';
import { cleanSourceUrl, fetchPublic } from '../src/knowledge-import.js';
import { STATIC_PROMPT } from '../src/copilot/prompt.js';

test('.ics: un nombre con saltos (también \\r solo) no agrega propiedades ni eventos', () => {
  const evil = 'Ana\rEND:VEVENT\r\nBEGIN:VEVENT\nSUMMARY:Falso; con, comas\u0007';
  const out = icsEscape(evil);
  assert.doesNotMatch(out, /[\r\n\u0007]/);
  assert.equal(out, 'Ana\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:Falso\\; con\\, comas');
});

test('.ics: las líneas largas se doblan a 75 bytes sin partir un carácter', () => {
  const line = `SUMMARY:${'ñ'.repeat(100)}📅`;
  const folded = icsFold(line);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 75, `${Buffer.byteLength(p)} bytes`);
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), line, 'al desdoblar queda igual');
  assert.equal(icsFold('SUMMARY:corta'), 'SUMMARY:corta');
});

test('asunto: una línea sin caracteres de control', () => {
  assert.equal(cleanSubject('Hola\r\nBcc: x@y.mx'), 'Hola Bcc: x@y.mx');
  assert.equal(cleanSubject('  a \t b  '), 'a b');
});

test('readCapped: corta un envío en trozos sin Content-Length al pasar el tope', async () => {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); if (pulled > 1000) c.close(); },
  });
  const res = new Response(stream);
  assert.equal(await readCapped(res, 10 * 1024), null);
  assert.ok(pulled < 20, `leyó ${pulled} trozos`);
  assert.equal((await readCapped(new Response('hola'), 10))?.toString(), 'hola');
  assert.equal(await readCapped(new Response('x'.repeat(50), { headers: { 'content-length': '50' } }), 10), null);
});

test('fetchPublic: un servidor que suelta un byte a la vez no la detiene más del plazo total', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const t = setInterval(() => res.write('a'), 200);
    res.on('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const prev = config.allowPrivateWebhooks;
  config.allowPrivateWebhooks = true;
  try {
    const t0 = Date.now();
    await assert.rejects(fetchPublic(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { deadlineMs: 1500 }), /tardó demasiado/);
    assert.ok(Date.now() - t0 < 4000);
  } finally {
    config.allowPrivateWebhooks = prev;
    server.closeAllConnections?.();
    server.close();
  }
});

test('AI-11: la fuente de un conocimiento solo es http(s) y sin usuario, contraseña, query ni fragmento', () => {
  assert.equal(cleanSourceUrl('javascript:alert(1)'), null);
  assert.equal(cleanSourceUrl('data:text/html,<b>x</b>'), null);
  assert.equal(cleanSourceUrl('no es url'), null);
  assert.equal(cleanSourceUrl('https://ana:clave@tienda.mx/menu?token=SECRETO#precios'), 'https://tienda.mx/menu');
  assert.equal(cleanSourceUrl('http://tienda.mx/'), 'http://tienda.mx/');
});

test('AI-10: el Copiloto trata nombres, etiquetas y conceptos de lo que devuelven las herramientas como datos', () => {
  assert.match(STATIC_PROMPT, /"nombre", "cliente", "contacto"/);
  assert.match(STATIC_PROMPT, /nunca instrucciones/);
});
