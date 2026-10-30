/**
 * Peticiones de otros sitios: con la cookie del panel (sesión o reto del código), un POST/PUT/DELETE que el navegador
 * marca como de otro sitio (`Sec-Fetch-Site`, o `Origin` distinto del host en navegadores viejos) se rechaza. Sin cookie
 * (webhooks, el chat de la web del cliente) o sin esas cabeceras (curl, integraciones) todo sigue igual.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const REJECTED = { error: 'Petición rechazada: viene de otro sitio' };

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const revokeOthers = (headers: Record<string, string>) =>
  h.app.inject({ method: 'POST', url: '/api/me/sessions/revoke-others', headers: { cookie: h.cookie, host: 'panel.test', ...headers } });

t('con la sesión: solo pasa lo que viene del mismo sitio (o sin cabeceras)', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await revokeOthers({ 'sec-fetch-site': site });
    assert.equal(r.statusCode, 403, site);
    assert.deepEqual(r.json(), REJECTED, site);
  }
  assert.equal((await revokeOthers({ 'sec-fetch-site': 'same-origin' })).statusCode, 200);
  assert.equal((await revokeOthers({ 'sec-fetch-site': 'none' })).statusCode, 200, 'la persona escribió la dirección');
  assert.deepEqual((await revokeOthers({ origin: 'https://malo.example' })).json(), REJECTED, 'navegador viejo: Origin de otro sitio');
  assert.equal((await revokeOthers({ origin: 'null' })).statusCode, 403, 'Origin opaco');
  assert.equal((await revokeOthers({ origin: 'https://panel.test' })).statusCode, 200, 'Origin del mismo host');
  assert.equal((await revokeOthers({})).statusCode, 200, 'sin cabeceras (curl, integraciones)');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: h.cookie, 'sec-fetch-site': 'cross-site' } })).statusCode, 200, 'leer no cambia nada');
});

t('con la cookie del reto: escribir el código desde otro sitio no pasa (ni gasta intentos)', async () => {
  const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@test.mx', password: 'secreto123' } });
  const challenge = [login.headers['set-cookie']].flat().map(String).find((c) => c.startsWith('cp_mfa='))!.split(';')[0];
  for (let i = 0; i < 6; i++) {
    const r = await h.app.inject({ method: 'POST', url: '/api/login/2fa', headers: { cookie: challenge, 'sec-fetch-site': 'cross-site' }, payload: { code: '000000' } });
    assert.deepEqual(r.json(), REJECTED);
  }
  const done = await h.app.inject({ method: 'POST', url: '/api/login/2fa', headers: { cookie: challenge, 'sec-fetch-site': 'same-origin' }, payload: { code: await h.codeFor('admin@test.mx') } });
  assert.equal(done.statusCode, 200, done.body);
});

t('sin cookie del panel (webhooks) o en el chat de la web del cliente, todo sigue igual', async () => {
  const plain = await h.app.inject({ method: 'POST', url: '/webhook/no-existe', payload: {} });
  const cross = await h.app.inject({ method: 'POST', url: '/webhook/no-existe', headers: { 'sec-fetch-site': 'cross-site' }, payload: {} });
  assert.equal(cross.statusCode, plain.statusCode);
  assert.notDeepEqual(cross.json(), REJECTED);
  // Quien administra el panel prueba el chat en su propia web: el navegador manda su cookie, pero el chat no la usa.
  const chatPlain = await h.app.inject({ method: 'POST', url: '/webchat/no-existe/session', payload: {} });
  const chatCross = await h.app.inject({ method: 'POST', url: '/webchat/no-existe/session', headers: { cookie: h.cookie, 'sec-fetch-site': 'same-site', origin: 'https://www.negocio.test' }, payload: {} });
  assert.equal(chatCross.statusCode, chatPlain.statusCode);
  assert.notDeepEqual(chatCross.json(), REJECTED);
});
