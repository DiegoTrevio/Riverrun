/**
 * Freno de pagos en sandbox: con credenciales de producción no se ofrece el pago ni se llama al proveedor, ni para cobrar
 * ni para leer. Con credenciales de prueba todo funciona igual. En live no cambia nada.
 * El proveedor es un servidor local que cuenta cada petición: si el freno falla, el contador lo delata.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { credentialAllowed } from '../src/outbound-guard.js';
import { stripe } from '../src/billing/stripe.js';
import { mercadopago } from '../src/billing/mercadopago.js';
import { ProviderError } from '../src/billing/types.js';

const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ url: 'https://pago.ejemplo.test/checkout', init_point: 'https://pago.ejemplo.test/mp', id: 'sub_1', status: 'active' }));
});
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const saved = {
  mode: config.outbound.mode,
  allow: config.outbound.allow,
  stripe: { ...config.billing.stripe },
  mp: { ...config.billing.mercadopago },
};
const restore = () => {
  config.outbound.mode = saved.mode;
  config.outbound.allow = saved.allow;
  Object.assign(config.billing.stripe, saved.stripe);
  Object.assign(config.billing.mercadopago, saved.mp);
};
beforeEach(() => {
  restore();
  hits.length = 0;
  config.billing.stripe.apiUrl = base;
  config.billing.mercadopago.apiUrl = base;
  config.billing.stripe.webhookSecret = 'whsec_prueba';
  config.billing.mercadopago.webhookSecret = 'mp_prueba';
});
after(restore);

const plan = { key: 'basico', name: 'Básico', stripe_price_id: 'price_1', price_cents: 50000, currency: 'MXN' } as any;
const checkout = { accountId: 'cuenta-1', email: 'dueno@ejemplo.test', plan, successUrl: 'https://app.ejemplo.test/ok', cancelUrl: 'https://app.ejemplo.test/no' } as any;

test('una clave es de prueba solo si lleva su prefijo; en live todo se acepta', () => {
  config.outbound.mode = 'sandbox';
  assert.equal(credentialAllowed('sk_test_123', ['sk_test_', 'rk_test_']), true);
  assert.equal(credentialAllowed('sk_live_123', ['sk_test_', 'rk_test_']), false);
  assert.equal(credentialAllowed('', ['sk_test_']), false);
  assert.equal(credentialAllowed('APP_USR-123', ['TEST-']), false);
  assert.equal(credentialAllowed('TEST-123', ['TEST-']), true);
  config.outbound.mode = 'live';
  assert.equal(credentialAllowed('sk_live_123', ['sk_test_']), true);
});

test('sandbox con clave de producción de Stripe: no se ofrece el pago y ninguna petición sale', async () => {
  config.outbound.mode = 'sandbox';
  config.billing.stripe.secretKey = 'sk_live_produccion';
  assert.equal(stripe.enabled(), false);
  await assert.rejects(stripe.createCheckout(checkout), (e: unknown) => e instanceof ProviderError && /sandbox/.test((e as Error).message));
  await assert.rejects(stripe.portal('cus_1', 'https://app.ejemplo.test/volver'), ProviderError);
  assert.deepEqual(hits, [], 'ninguna petición llegó al proveedor, ni para cobrar ni para leer');
});

test('sandbox con clave de prueba de Stripe: el pago funciona igual', async () => {
  config.outbound.mode = 'sandbox';
  config.billing.stripe.secretKey = 'sk_test_prueba';
  assert.equal(stripe.enabled(), true);
  const r = await stripe.createCheckout(checkout);
  assert.equal(r.url, 'https://pago.ejemplo.test/checkout');
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^POST \/v1\/checkout\/sessions Bearer sk_test_prueba$/);
});

test('sandbox con credencial de producción de Mercado Pago: no se ofrece el pago y ninguna petición sale', async () => {
  config.outbound.mode = 'sandbox';
  config.billing.mercadopago.accessToken = 'APP_USR-produccion';
  assert.equal(mercadopago.enabled(), false);
  await assert.rejects(mercadopago.createCheckout(checkout), ProviderError);
  assert.deepEqual(hits, []);
});

test('sandbox con credencial de prueba de Mercado Pago: el pago funciona igual', async () => {
  config.outbound.mode = 'sandbox';
  config.billing.mercadopago.accessToken = 'TEST-prueba';
  assert.equal(mercadopago.enabled(), true);
  const r = await mercadopago.createCheckout(checkout);
  assert.equal(r.url, 'https://pago.ejemplo.test/mp');
  assert.equal(hits.length, 1);
});

test('en live, las credenciales de producción siguen funcionando (no cambia producción)', async () => {
  config.outbound.mode = 'live';
  config.billing.stripe.secretKey = 'sk_live_produccion';
  config.billing.mercadopago.accessToken = 'APP_USR-produccion';
  assert.equal(stripe.enabled(), true);
  assert.equal(mercadopago.enabled(), true);
  assert.equal((await stripe.createCheckout(checkout)).url, 'https://pago.ejemplo.test/checkout');
  assert.equal((await mercadopago.createCheckout(checkout)).url, 'https://pago.ejemplo.test/mp');
  assert.equal(hits.length, 2);
});
