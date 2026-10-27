/**
 * Encabezados de seguridad: el panel no se puede meter en un iframe y solo corre su propio código; reservar sí se puede
 * incrustar; el widget, el chat web y la API conservan lo suyo; y lo que una ruta ya puso no se pisa.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { PANEL_CSP } = await import('../src/security-headers.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el panel lleva la CSP estricta y no se puede incrustar', async () => {
  for (const url of ['/', '/index.html']) {
    const r = await get(url);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-security-policy'], PANEL_CSP);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  }
  assert.doesNotMatch(PANEL_CSP, /unsafe-inline|unsafe-eval/);
  assert.match(PANEL_CSP, /frame-ancestors 'none'/);
  assert.match(PANEL_CSP, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
});

t('las páginas del servidor tampoco se pueden incrustar', async () => {
  const r = await get('/precios');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.match(String(r.headers['content-security-policy']), /object-src 'none'/);
});

t('reservar y la ayuda sí se pueden poner en el sitio del negocio', async () => {
  const link = (await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Agenda' })).json();
  const r = await get(new URL(link.url).pathname);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['x-frame-options'], undefined);
  assert.match(String(r.headers['content-security-policy']), /frame-ancestors \*/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer', 'conserva el que pone la ruta');
  const help = await get('/ayuda.html');
  assert.equal(help.headers['x-frame-options'], undefined);
  assert.match(String(help.headers['content-security-policy']), /frame-ancestors \*/);
});

t('el widget, el chat web y la API no llevan restricciones de página', async () => {
  const widget = await get('/widget.js');
  assert.equal(widget.statusCode, 200);
  assert.equal(widget.headers['content-security-policy'], undefined);
  assert.equal(widget.headers['x-frame-options'], undefined);
  assert.equal(widget.headers['cross-origin-resource-policy'], undefined);
  const chat = await h.app.inject({ method: 'OPTIONS', url: '/webchat/no-existe/config', headers: { origin: 'https://cliente.mx', 'access-control-request-method': 'GET' } });
  assert.equal(chat.headers['x-frame-options'], undefined);
  const api = await h.authed('GET', '/api/me');
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['content-security-policy'], undefined);
});

t('la salud del contenedor revisa la base de datos', async () => {
  const r = await get('/health/db');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true });
});
