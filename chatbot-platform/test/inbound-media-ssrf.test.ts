/** Auditoría S-M1: los medios que mandan los clientes (Meta, Zernio) no se descargan de la red interna del servidor y la llave de Zernio solo va a Zernio. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ext } from './harness.js';
// Después del arnés (define las variables de entorno).
const { config } = await import('../src/config.js');
const { adapterFor } = await import('../src/channels/index.js');

let server: http.Server;
let hits = 0;
let port = 0;
before(async () => {
  server = http.createServer((_req, res) => { hits++; res.end('secreto-interno'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
  config.allowPrivateWebhooks = false;
});
after(async () => {
  config.allowPrivateWebhooks = true;
  await new Promise((r) => server.close(r));
});

const msg = (url: string) => ({ media: { url } }) as any;
const zernioChannel = { id: 'c1', account_id: 'a1', type: 'zernio', config: { platform: 'whatsapp' } } as any;

test('Meta: un audio con URL interna o sin https no se descarga', async () => {
  const meta = adapterFor('messenger');
  for (const url of [`http://127.0.0.1:${port}/x`, 'http://169.254.169.254/latest/meta-data/', `https://127.0.0.1:${port}/x`, `https://localhost:${port}/x`]) {
    assert.equal(await meta.downloadAudio!({} as any, msg(url)), null, url);
  }
  assert.equal(hits, 0, 'nunca se tocó el servidor interno');
});

test('Zernio: la llave solo va al origen exacto de Zernio; lo demás no llega a la red interna', async () => {
  const zernio = adapterFor('zernio');
  const own = new URL(config.zernioApiUrl);
  // Un nombre que solo empieza igual que el servidor de Zernio no es Zernio.
  const lookalike = `${own.protocol}//${own.hostname}.evil.test:${own.port || 80}/media/1`;
  ext.requests.length = 0;
  assert.equal(await zernio.downloadAudio!(zernioChannel, msg(lookalike)), null);
  for (const url of [`https://127.0.0.1:${port}/x`, `https://localhost:${port}/x`, `http://127.0.0.1:${port}/x`]) {
    assert.equal(await zernio.downloadMedia!(zernioChannel, msg(url)), null, url);
  }
  assert.equal(hits, 0);
  // El de Zernio sí se descarga, con su llave.
  await zernio.downloadMedia!(zernioChannel, msg(`${own.origin}/api/v1/media/abc.jpg`));
  const req = ext.requests.find((r) => r.path.includes('/media/abc.jpg'));
  assert.ok(req, 'se pidió a Zernio');
  assert.match(String(req!.headers.authorization), /^Bearer /);
});
