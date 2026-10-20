/** Panel de cotizaciones: lista de precios y ajustes (solo administradores), consulta de precios para el equipo. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let agent: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({});
  await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Agente', email: 'agente@cotiza.test', password: 'clave-agente-1', role: 'agent' });
  agent = await h.loginAs('agente@cotiza.test', 'clave-agente-1');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('lista de precios: el administrador la arma; los errores se explican; el agente solo la consulta', async () => {
  const acct = `?account_id=${h.accountId}`;
  const made = await h.authed('POST', `/api/price-items${acct}`, { code: 'SALON', name: 'Renta de salón', unit: 'evento', price_mode: 'exact', price_min: 1500000 });
  assert.equal(made.statusCode, 200, made.body);
  const range = await h.authed('POST', `/api/price-items${acct}`, { code: 'DECO', name: 'Decoración', price_mode: 'range', price_min: 500000, price_max: 300000 });
  assert.equal(range.statusCode, 400);
  assert.match(range.json().error, /mínimo debe ser menor/);
  const dup = await h.authed('POST', `/api/price-items${acct}`, { code: 'SALON', name: 'Otro', price_mode: 'tbd' });
  assert.equal(dup.statusCode, 400);
  assert.match(dup.json().error, /Ya hay un concepto/);
  const cents = await h.authed('POST', `/api/price-items${acct}`, { code: 'X', name: 'X', price_mode: 'exact', price_min: 12.5 });
  assert.equal(cents.statusCode, 400, 'los montos van en centavos enteros');

  const id = made.json().id;
  const upd = await h.authed('PUT', `/api/price-items/${id}`, { price_mode: 'from', price_min: 1200000 });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().price_mode, 'from');
  assert.equal(upd.json().name, 'Renta de salón', 'lo que no se manda se conserva');

  assert.equal((await agent('GET', '/api/price-items')).json().length, 1);
  assert.equal((await agent('POST', '/api/price-items', { code: 'Y', name: 'Y', price_mode: 'tbd' })).statusCode, 403);
  assert.equal((await agent('PUT', `/api/price-items/${id}`, {})).statusCode, 403);
  assert.equal((await agent('GET', '/api/quotes')).statusCode, 403);
  assert.equal((await agent('GET', '/api/quote-settings')).statusCode, 403);

  assert.equal((await h.authed('DELETE', `/api/price-items/${id}`)).statusCode, 200);
  assert.equal((await h.authed('GET', `/api/price-items${acct}`)).json().length, 0);
});

t('ajustes de cotización: valores iniciales, cambios y validación', async () => {
  const acct = `?account_id=${h.accountId}`;
  const s = (await h.authed('GET', `/api/quote-settings${acct}`)).json();
  assert.equal(s.iva_rate, 0.16);
  const bad = await h.authed('PUT', `/api/quote-settings${acct}`, { folio_prefix: 'con espacio' });
  assert.equal(bad.statusCode, 400);
  const good = await h.authed('PUT', `/api/quote-settings${acct}`, { iva_rate: 0.08, validity_days: 7, currency: 'usd' });
  assert.equal(good.statusCode, 200, good.body);
  assert.deepEqual([good.json().iva_rate, good.json().validity_days, good.json().currency], [0.08, 7, 'USD']);
});

t('historial de cotizaciones: lista con filtros y detalle con su historial', async () => {
  const { createQuote } = await import('../src/store/quotes.js');
  const q = await createQuote({ accountId: h.accountId, kind: 'approximate', status: 'sent', source: 'panel', today: '2026-10-20',
    customer: { nombre: 'Ana López' }, lines: [{ name: 'Renta', qty: 1, price_mode: 'range', price_min: 100000, price_max: 150000, iva_mode: 'plus' }] });
  const list = (await h.authed('GET', `/api/quotes?account_id=${h.accountId}&search=ana`)).json();
  assert.equal(list.length, 1);
  assert.equal((await h.authed('GET', `/api/quotes?account_id=${h.accountId}&kind=final`)).json().length, 0);
  assert.equal((await h.authed('GET', `/api/quotes?account_id=${h.accountId}&chatbot_id=no-es-uuid`)).statusCode, 200);
  const detail = (await h.authed('GET', `/api/quotes/${q.id}`)).json();
  assert.equal(detail.lines[0].amount_max, 150000);
  assert.deepEqual(detail.events.map((e: any) => e.type), ['created']);
  assert.equal((await h.authed('GET', '/api/quotes/no-es-uuid')).statusCode, 404);
});
