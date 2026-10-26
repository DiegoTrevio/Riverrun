import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EvolutionClient } from '../src/evolution/client.js';

test('EvolutionClient: rutas, apikey, cuerpo; los envíos no se repiten ante 5xx y lo demás sí se reintenta', async () => {
  const seen: { method: string; url: string; key: string; body: any }[] = [];
  let failMedia = true;
  let failWebhook = true;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, key: String(req.headers.apikey), body: raw ? JSON.parse(raw) : null });
      if (req.url!.startsWith('/message/sendMedia') && failMedia) {
        failMedia = false;
        res.writeHead(502).end('bad gateway');
        return;
      }
      if (req.url!.startsWith('/webhook/set') && failWebhook) {
        failWebhook = false;
        res.writeHead(502).end('bad gateway');
        return;
      }
      if (req.url!.startsWith('/instance/connectionState/nope')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 404, response: { message: ['not found'] } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url!.startsWith('/instance/connectionState')) return res.end(JSON.stringify({ instance: { instanceName: 'palmas', state: 'open' } }));
      res.end(JSON.stringify({ key: { id: 'MSG-1', fromMe: true } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const evo = new EvolutionClient(`http://127.0.0.1:${port}`, 'KEY');
  try {
    assert.equal(await evo.sendText('palmas', '5215511112222', 'hola', 1500), 'MSG-1');
    // Un 502 al enviar no se repite: Evolution pudo haberlo entregado (la capa durable decide).
    await assert.rejects(() => evo.sendImage('palmas', '5215511112222', 'BASE64', 'image/png', 'a.png', 'pie'), (e: any) => e.status === 502);
    assert.equal(await evo.sendImage('palmas', '5215511112222', 'BASE64', 'image/png', 'a.png', 'pie'), 'MSG-1');
    assert.equal(await evo.connectionState('palmas'), 'open');
    await assert.rejects(() => evo.connectionState('nope'), (e: any) => e.status === 404);
    await evo.setWebhook('palmas', 'http://backend:3000/webhook/abc');

    assert.deepEqual(seen[0], { method: 'POST', url: '/message/sendText/palmas', key: 'KEY', body: { number: '5215511112222', text: 'hola', delay: 1500 } });
    assert.equal(seen[1].url, '/message/sendMedia/palmas');
    assert.equal(seen[2].url, '/message/sendMedia/palmas'); // el segundo envío, pedido por quien llama
    assert.equal(seen[2].body.mediatype, 'image');
    assert.equal(seen[2].body.media, 'BASE64');
    assert.equal(seen.filter((s) => s.url.startsWith('/webhook/set')).length, 2, 'configurar el webhook sí se reintenta tras un 502');
    const wh = seen.find((s) => s.url.startsWith('/webhook/set'))!;
    assert.equal(wh.body.webhook.url, 'http://backend:3000/webhook/abc');
    assert.deepEqual(wh.body.webhook.events, ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']);
  } finally {
    server.close();
  }
});

test('EvolutionClient: la sonda de la llave distingue aceptada (200/404), rechazada (401/403) y error (5xx)', async () => {
  let status = 404;
  const server = http.createServer((req, res) => {
    res.writeHead(req.url!.startsWith('/instance/fetchInstances') ? status : 200, { 'content-type': 'application/json' });
    res.end(req.url === '/' ? JSON.stringify({ status: 200, version: '2.3.7', clientName: 'evolution' }) : JSON.stringify({ response: { message: ['x'] } }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const evo = new EvolutionClient(`http://127.0.0.1:${(server.address() as any).port}`, 'KEY', 2000);
  try {
    // Evolution 2.3.7 real: valida la llave y después responde 404 porque la instancia de la sonda no existe.
    assert.equal(await evo.checkApiKey(), true);
    status = 200;
    assert.equal(await evo.checkApiKey(), true);
    status = 401;
    assert.equal(await evo.checkApiKey(), false);
    status = 403;
    assert.equal(await evo.checkApiKey(), false);
    status = 503;
    await assert.rejects(() => evo.checkApiKey(), (e: any) => e.status === 503);
    assert.deepEqual(await evo.serverInfo(), { version: '2.3.7', clientName: 'evolution' });
  } finally {
    server.close();
  }
});

test('EvolutionClient: si la conexión ni siquiera se abrió, el envío se repite una vez (no llegó a Evolution)', async () => {
  // Un puerto libre: el primer intento encuentra la conexión rechazada; durante la espera, Evolution «vuelve».
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const evo = new EvolutionClient(`http://127.0.0.1:${port}`, 'KEY');
  let posts = 0;
  const server = http.createServer((req, res) => {
    posts++;
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ key: { id: 'MSG-2' } })));
  });
  setTimeout(() => server.listen(port, '127.0.0.1'), 200);
  try {
    assert.equal(await evo.sendText('palmas', '5215511112222', 'hola'), 'MSG-2');
    assert.equal(posts, 1);
  } finally {
    server.close();
  }
});
