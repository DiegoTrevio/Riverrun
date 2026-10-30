/**
 * Con HTTPS (`SECURE_COOKIES=true`) las cookies del panel llevan el prefijo `__Host-`, y el navegador ignora cualquier
 * `Set-Cookie` de ese nombre sin `Secure`: borrarlas (salir, terminar el reto del código) también tiene que llevarlo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const setCookies = (r: { headers: Record<string, unknown> }) => [r.headers['set-cookie'] ?? []].flat().map(String);
const cleared = (r: { headers: Record<string, unknown> }, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=;`));

before(async () => {
  if (!ok) return;
  h = await createHarness();
  config.secureCookies = true;
});
after(async () => {
  config.secureCookies = false;
  if (h) await h.app.close();
  await pool.end();
});

t('salir borra __Host-cp_session con Secure', async () => {
  const value = h.cookie.slice(h.cookie.indexOf('=') + 1);
  const r = await h.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: `__Host-cp_session=${value}` } });
  assert.equal(r.statusCode, 200, r.body);
  const c = cleared(r, '__Host-cp_session');
  assert.ok(c, `no borró la cookie: ${setCookies(r).join(' | ')}`);
  assert.match(c!, /; Secure/i);
  assert.match(c!, /; Path=\//i);
});

t('terminar el reto borra __Host-cp_mfa con Secure', async () => {
  const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@test.mx', password: 'secreto123' } });
  const challenge = setCookies(login).find((c) => c.startsWith('__Host-cp_mfa='))!.split(';')[0];
  assert.ok(challenge, setCookies(login).join(' | '));
  const done = await h.app.inject({ method: 'POST', url: '/api/login/2fa', headers: { cookie: challenge }, payload: { code: await h.codeFor('admin@test.mx') } });
  assert.equal(done.statusCode, 200, done.body);
  const c = cleared(done, '__Host-cp_mfa');
  assert.ok(c, `no borró el reto: ${setCookies(done).join(' | ')}`);
  assert.match(c!, /; Secure/i);
});
