/**
 * Contraseñas nuevas: 12 caracteres o más, sin el correo ni el nombre del negocio, fuera de las 100 000 más comunes y no
 * filtradas según Have I Been Pwned (al que solo salen los primeros 5 caracteres del SHA-1, con relleno).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { isCommonPassword, passwordIssue, pwnedCount } = await import('../src/identity/passwords.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();
const seen = { path: '', padding: '' };
let url = '';
let slowUrl = '';
const servers: http.Server[] = [];
const listen = (handler: http.RequestListener) => new Promise<string>((resolve) => {
  const s = http.createServer(handler);
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}/range/`));
});

before(async () => {
  const leaked = sha1('caballo-bateria-grapa');
  url = await listen((req, res) => {
    seen.path = req.url ?? '';
    seen.padding = String(req.headers['add-padding'] ?? '');
    res.end(req.url === `/range/${leaked.slice(0, 5)}` ? `0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n${leaked.slice(5)}:7\r\n` : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3\r\n');
  });
  slowUrl = await listen((_req, res) => { setTimeout(() => res.end(''), 3000).unref(); });
  if (ok) h = await createHarness();
});
after(async () => {
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  if (h) await h.app.close();
  await pool.end();
});

test('largo, correo y negocio', async () => {
  assert.equal(await passwordIssue('corta-11ch', {}), 'La contraseña debe tener al menos 12 caracteres');
  assert.equal(await passwordIssue('x'.repeat(129), {}), 'La contraseña puede tener hasta 128 caracteres');
  assert.equal(await passwordIssue('MarianaRuiz-2026!', { email: 'mariana@negocio.mx' }), 'La contraseña no puede incluir tu correo ni el nombre de tu negocio');
  // Cada palabra de 4 letras o más del correo y del negocio, sin acentos ni mayúsculas.
  assert.equal(await passwordIssue('mi-Estetica-Lupita-77', { businessName: 'Estética Lupita' }), 'La contraseña no puede incluir tu correo ni el nombre de tu negocio');
  assert.equal(await passwordIssue('ruiz-y-asociados-2026', { email: 'mariana.ruiz@negocio.mx' }), 'La contraseña no puede incluir tu correo ni el nombre de tu negocio');
  assert.equal(await passwordIssue('una-frase-para-la-esquina', { businessName: 'Café La Luz' }), null, 'palabras de menos de 4 letras no cuentan');
  assert.equal(await passwordIssue('estudio-ana-de-cerca', { email: 'ana@x.mx' }), null, 'una parte local de 3 letras no cuenta');
});

test('lista local sin distinguir mayúsculas', async () => {
  assert.equal(isCommonPassword('password1234'), true);
  assert.equal(isCommonPassword('caballo-bateria-grapa'), false);
  assert.match((await passwordIssue('PASSWORD1234', {}))!, /de las más usadas/);
});

test('HIBP: solo salen 5 caracteres, con relleno; filtrada, limpia, lenta y apagada', async () => {
  assert.equal(await pwnedCount('caballo-bateria-grapa', url), 7);
  assert.equal(seen.path, `/range/${sha1('caballo-bateria-grapa').slice(0, 5)}`);
  assert.equal(seen.padding, 'true');
  assert.equal(await pwnedCount('otra-frase-muy-rara-77', url), 0);
  const started = Date.now();
  assert.equal(await pwnedCount('lo-que-sea-largo-1', slowUrl), null);
  assert.ok(Date.now() - started < 2500, 'no espera más de 1,5 s');
  assert.equal(await pwnedCount('lo-que-sea-largo-1', 'off'), null);
  assert.equal(await passwordIssue('caballo-bateria-grapa', {}, url), 'Esta contraseña apareció en filtraciones de datos: elige otra');
});

t('las rutas rechazan una contraseña común o corta', async () => {
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.70.0.1', payload: { name: 'Eva', company: 'Negocio Eva', business_type: 'belleza', email: 'eva@n.mx', password: 'password1234', accept_terms: true } });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error, /de las más usadas/);
  assert.equal((await h.authed('PUT', '/api/me/password', { current: 'secreto123', password: 'corta-larga' })).statusCode, 400);
  const created = await h.authed('POST', '/api/users', { account_id: null, name: 'Otro', email: 'otro@n.mx', password: 'qwertyuiop12', role: 'superadmin' });
  assert.equal(created.statusCode, 400, created.body);
});
