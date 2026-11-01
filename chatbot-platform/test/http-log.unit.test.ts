/** HTTP_LOG=true: el registro de cada petición no trae tokens (van en la ruta o en la query de los enlaces públicos). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errSerializer, reqSerializer, safeMessage, safeUrl } from '../src/http-log.js';

test('el registro de la petición no trae la query ni los segmentos de /webhook/, /calendar/, /reservar/ y /q/', () => {
  const cases: [string, string][] = [
    ['/webhook/tok_SECRETO123/messages-upsert', '/webhook/[oculto]/[oculto]'],
    ['/calendar/cal-SECRETO.ics', '/calendar/[oculto]'],
    ['/reservar/SECRETO-reserva', '/reservar/[oculto]'],
    ['/q/0b7c9a3e-1111-4222-8333-444455556666', '/q/[oculto]'],
    ['/wa/SECRETO', '/wa/[oculto]'],
    ['/webchat/SECRETO/messages', '/webchat/[oculto]/[oculto]'],
    ['/conectar-red/SECRETO', '/conectar-red/[oculto]'],
    ['/zernio/callback/SECRETO/estado', '/zernio/callback/[oculto]/[oculto]'],
    ['/api/public/booking/SECRETO/confirm', '/api/public/booking/[oculto]/[oculto]'],
    ['/borrar-cuenta?t=eyJ.SECRETO', '/borrar-cuenta'],
    ['/api/auth/google/callback?code=SECRETO&state=x', '/api/auth/google/callback'],
    ['/api/conversations/0b7c9a3e-1111-4222-8333-444455556666', '/api/conversations/0b7c9a3e-1111-4222-8333-444455556666'],
    ['/api/x/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY', '/api/x/[oculto]'],
  ];
  for (const [url, safe] of cases) {
    assert.equal(safeUrl(url), safe, url);
    const out = reqSerializer({ method: 'GET', url, ip: '10.0.0.1', headers: { host: 'p.mx', authorization: 'Bearer x', cookie: 'sid=1' } } as any);
    assert.equal(out.url, safe);
    assert.ok(!JSON.stringify(out).includes('SECRETO'), JSON.stringify(out));
    assert.ok(!JSON.stringify(out).includes('Bearer') && !JSON.stringify(out).includes('sid='), 'sin cabeceras de sesión');
  }
});

test('el aviso de ruta no encontrada de Fastify tampoco trae el token', () => {
  assert.equal(safeMessage('Route GET:/webhook/SECRETO/x?y=1 not found'), 'Route GET:/webhook/[oculto]/[oculto] not found');
  assert.equal(safeMessage('incoming request'), 'incoming request');
});

test('con HTTP_LOG el servidor registra la ruta sin el token', async () => {
  const Fastify = (await import('fastify')).default;
  const { Writable } = await import('node:stream');
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  const { httpLoggerOptions } = await import('../src/http-log.js');
  const app = Fastify({ logger: { ...httpLoggerOptions, stream } });
  app.get('/webhook/:token', async () => ({ ok: true }));
  await app.inject({ method: 'GET', url: '/webhook/SECRETO?x=1' });
  await app.inject({ method: 'GET', url: '/borrar-cuenta?t=SECRETO' });
  await app.close();
  const all = lines.join('');
  assert.match(all, /\/webhook\/\[oculto\]/);
  assert.ok(!all.includes('SECRETO'), all);
});

test('mayúsculas, barras repetidas, tokens cortos y errores tampoco dejan pasar el token', () => {
  assert.equal(safeUrl('/Webhook/SECRETO'), '/webhook/[oculto]');
  assert.equal(safeUrl('//webhook/SECRETO'), '/webhook/[oculto]');
  assert.equal(safeUrl('/api/algo/ab12cd34ef56gh78'), '/api/algo/[oculto]');
  assert.equal(safeUrl('/api/chatbots/knowledge-import'), '/api/chatbots/knowledge-import');
  const e = Object.assign(new Error('Route GET:/webhook/SECRETO not found'), { statusCode: 404 });
  const out = errSerializer(e);
  assert.ok(!JSON.stringify(out).includes('SECRETO'), JSON.stringify(out));
  assert.equal(out.statusCode, 404);
});
