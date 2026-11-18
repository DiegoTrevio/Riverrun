/** Plan único: 5,000 MXN + IVA al mes (México) y 270 USD sin IVA (Estados Unidos), con límites que cubren Zernio y la IA. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const single = await import('../src/billing/single-plan.js');
const tax = await import('../src/billing/tax.js');

test('el plan único cuesta 5,000 MXN + IVA y 270 USD al mes', () => {
  const [mx, us] = single.singlePlans();
  assert.deepEqual([mx.key, mx.price, mx.currency, mx.interval, mx.public], ['riverrun', 5000, 'MXN', 'month', true]);
  assert.deepEqual([us.key, us.price, us.currency, us.interval], ['riverrun-usd', 270, 'USD', 'month']);
  assert.deepEqual(mx.limits, us.limits, 'los dos precios dan lo mismo');
  assert.equal(mx.ai_usd_per_month, us.ai_usd_per_month);
});

test('el plan no limita los mensajes y aun con 100,000 al mes cuesta menos de la mitad de lo que se cobra', () => {
  const [mx, us] = single.singlePlans();
  assert.equal(mx.limits.messages_per_month, undefined, 'sin límite de mensajes');
  assert.ok(us.ai_usd_per_month > 0, 'lo que frena al asistente es el tope de IA');
  const cost = single.monthCostUsd(us.limits, us.ai_usd_per_month, 100_000);
  // 10 redes a 6 USD (tarifa más alta de Zernio), 100,000 mensajes a 0.0001 USD y el tope de IA.
  assert.equal(cost, 10 * 6 + 100_000 * 0.0001 + 50);
  assert.ok(cost < us.price / 2, `cuesta ${cost} USD de ${us.price}`);
});

test('el IVA se suma solo a los planes en pesos', () => {
  assert.equal(tax.taxPercent('MXN'), 16);
  assert.equal(tax.taxPercent('mxn'), 16);
  assert.equal(tax.taxPercent('USD'), 0);
  assert.equal(tax.chargeCents({ price_cents: 500_000, currency: 'MXN' }), 580_000);
  assert.equal(tax.chargeCents({ price_cents: 27_000, currency: 'USD' }), 27_000);
});

test('el precio en dólares se paga con Stripe: Mercado Pago solo cobra en pesos', async () => {
  const { mercadopago } = await import('../src/billing/mercadopago.js');
  const { stripe } = await import('../src/billing/stripe.js');
  const plan = (currency: string) => ({ currency }) as Parameters<typeof mercadopago.supportsPlan>[0];
  assert.equal(mercadopago.supportsPlan(plan('MXN')), true);
  assert.equal(mercadopago.supportsPlan(plan('USD')), false);
  assert.equal(stripe.supportsPlan(plan('USD')), true);
});

before(async () => {
  if (ok) h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  if (ok) await pool.end();
});

t('aplicar el plan único crea los dos precios y apaga los demás planes sin borrarlos', async () => {
  for (const p of [{ key: 'basico', name: 'Básico', price: 199 }, { key: 'pro', name: 'Pro', price: 499 }]) assert.equal((await h.authed('POST', '/api/plans', p)).statusCode, 200);
  const first = await single.applySinglePlan();
  assert.deepEqual(first.deactivated.sort(), ['basico', 'pro']);
  // Un ID de precio de Stripe viejo cobraría otro monto: volver a aplicar el plan lo borra.
  await pool.query(`UPDATE plans SET stripe_price_id = 'price_viejo' WHERE key = 'riverrun'`);
  const again = await single.applySinglePlan();
  assert.equal((await pool.query(`SELECT stripe_price_id FROM plans WHERE key = 'riverrun'`)).rows[0].stripe_price_id, '');
  assert.deepEqual(again.deactivated, [], 'se puede correr dos veces');
  const rows = (await pool.query(`SELECT key, price_cents, currency, active, public, billing_interval, limits, ai_usd_per_month::float AS ai FROM plans ORDER BY key`)).rows;
  assert.deepEqual(rows.map((r) => [r.key, r.active]), [['basico', false], ['pro', false], ['riverrun', true], ['riverrun-usd', true]]);
  const mx = rows.find((r) => r.key === 'riverrun')!;
  const us = rows.find((r) => r.key === 'riverrun-usd')!;
  assert.deepEqual([mx.price_cents, mx.currency, mx.public, mx.billing_interval, mx.ai], [500_000, 'MXN', true, 'month', 50]);
  assert.deepEqual([us.price_cents, us.currency, us.public], [27_000, 'USD', false], 'el de dólares queda privado hasta tener la versión en inglés');
  assert.equal(mx.limits.social_accounts, 10);

  // Precios publica solo el plan en pesos, con su total con IVA.
  const page = await h.app.inject({ method: 'GET', url: '/precios' });
  assert.match(page.body, /\$5,000<\/strong> <span>MXN \+ IVA \/ mes/);
  assert.match(page.body, /Total con IVA: \$5,800 MXN al mes/);
  assert.match(page.body, /<li>Mensajes del asistente sin límite<\/li>/);
  assert.doesNotMatch(page.body, /Básico|USD/);

  // Con usdPublic, el de dólares se publica, sin IVA, para quien entra en inglés; en español sigue el de pesos.
  await single.applySinglePlan({ usdPublic: true });
  const page2 = await h.app.inject({ method: 'GET', url: '/precios', headers: { 'accept-language': 'en-US' } });
  assert.match(page2.body, /\$270<\/strong> <span>USD \/ month/);
  assert.doesNotMatch(page2.body, /MXN/);
  const page3 = await h.app.inject({ method: 'GET', url: '/precios' });
  assert.match(page3.body, /\$5,000<\/strong> <span>MXN \+ IVA \/ mes/);
  assert.doesNotMatch(page3.body, /USD/);
});

t('con el plan único, topar un límite pide escribirnos en lugar de cambiar de plan', async () => {
  await single.applySinglePlan();
  await pool.query(`UPDATE plans SET limits = limits || '{"channels": 1}' WHERE key = 'riverrun'`);
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.9.1.1', payload: { name: 'Dueño', company: 'Negocio único', business_type: 'otro', email: 'unico@plan.mx', password: 'Pz-144-Qx-344-Kv', accept_terms: true } });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().user.account_id as string;
  await pool.query(`UPDATE accounts SET status = 'active', plan = 'riverrun', trial_ends_at = NULL WHERE id = $1`, [id]);
  const cookie = await h.sessionFrom(r);
  const add = (name: string) => h.app.inject({ method: 'POST', url: '/api/channels', payload: { type: 'webchat', name }, headers: { cookie } });
  assert.equal((await add('Web')).statusCode, 200);
  const res = await add('Otra web');
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().limit.next_plan, null);
  assert.match(res.json().error, /Tu plan permite hasta 1 canal y ya tienes 1\. Para ampliarlo, escríbenos/);
  assert.doesNotMatch(res.json().error, /cambia de plan/);

  // El de dólares, aunque se publique, no se le ofrece a quien paga en pesos.
  await single.applySinglePlan({ usdPublic: true });
  await pool.query(`UPDATE plans SET limits = limits || '{"channels": 1}' WHERE key = 'riverrun'`);
  assert.equal((await add('Otra más')).json().limit.next_plan, null);
});
