import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EvolutionClient } from '../src/evolution/client.js';

test('EvolutionClient: rutas, apikey, cuerpo y reintento ante 5xx', async () => {
  const seen: { method: string; url: string; key: string; body: any }[] = [];
  let failOnce = true;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, key: String(req.headers.apikey), body: raw ? JSON.parse(raw) : null });
      if (req.url!.startsWith('/message/sendMedia') && failOnce) {
        failOnce = false;
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
    assert.equal(await evo.sendImage('palmas', '5215511112222', 'BASE64', 'image/png', 'a.png', 'pie'), 'MSG-1');
    assert.equal(await evo.connectionState('palmas'), 'open');
    await assert.rejects(() => evo.connectionState('nope'), (e: any) => e.status === 404);
    await evo.setWebhook('palmas', 'http://backend:3000/webhook/abc');

    assert.deepEqual(seen[0], { method: 'POST', url: '/message/sendText/palmas', key: 'KEY', body: { number: '5215511112222', text: 'hola', delay: 1500 } });
    assert.equal(seen[1].url, '/message/sendMedia/palmas');
    assert.equal(seen[2].url, '/message/sendMedia/palmas'); // reintento tras 502
    assert.equal(seen[2].body.mediatype, 'image');
    assert.equal(seen[2].body.media, 'BASE64');
    const wh = seen.find((s) => s.url.startsWith('/webhook/set'))!;
    assert.equal(wh.body.webhook.url, 'http://backend:3000/webhook/abc');
    assert.deepEqual(wh.body.webhook.events, ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
  } finally {
    server.close();
  }
});
