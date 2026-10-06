/** Cobro automático con Stripe y Mercado Pago (servicios simulados). */
import { fake, mpEvent, stripeEvent, stripeSub } from './billing-fakes.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const { enforceAccess } = await import('../src/billing/service.js');

const B = { cookie: '', account: '', api: null as unknown as (m: string, u: string, p?: unknown) => Promise<any> };
const account = async () => (await pool.query(`SELECT status, plan, trial_ends_at FROM accounts WHERE id = $1`, [B.account])).rows[0];
const sub = async () => (await pool.query(`SELECT * FROM subscriptions WHERE account_id = $1`, [B.account])).rows[0];
const post = (url: string, e: { payload: string; headers: Record<string, string> }) => h.app.inject({ method: 'POST', url, payload: e.payload, headers: e.headers });
const stripeHook = (type: string, obj: unknown, id?: string) => post('/webhook/billing/stripe', stripeEvent(type, obj, id));
const mails = (subject: string) => outbox.filter((m) => m.to === 'laura@sonrisa.mx' && m.subject.includes(subject)).length;
const days = (n: number) => new Date(Date.now() + n * 86400_000);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: '10.9.9.9',
    payload: { name: 'Laura Pérez', company: 'Clínica Sonrisa', business_type: 'salud', email: 'laura@sonrisa.mx', password: 'clave-laura-1', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  B.account = r.json().user.account_id;
  B.cookie = String(r.headers['set-cookie']).split(';')[0];
  B.api = async (method, url, payload) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: B.cookie } });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el superadmin define planes; el cliente solo los ve', async () => {
  assert.equal((await B.api('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499, stripe_price_id: 'price_pro' })).statusCode, 403);
  const made = await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499, currency: 'mxn', stripe_price_id: 'price_pro' });
  assert.equal(made.statusCode, 200, made.body);
  assert.equal(made.json().price_cents, 49900);
  assert.equal(made.json().currency, 'MXN');
  assert.equal((await h.authed('POST', '/api/plans', { key: 'solo-mp', name: 'Básico MP', price: 199 })).statusCode, 200);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'Mal Clave', name: 'x', price: 1 })).statusCode, 400);
  const view = (await B.api('GET', '/api/billing')).json();
  assert.deepEqual(view.plans.map((p: any) => p.key), ['solo-mp', 'pro']);
  assert.deepEqual(view.plans.find((p: any) => p.key === 'solo-mp').providers.map((x: any) => x.name), ['mercadopago'], 'sin ID de precio Stripe no se ofrece');
  assert.equal(view.account.status, 'trial');
  assert.equal((await B.api('GET', '/api/meta')).json().billing_enabled, true);
});

t('Stripe: contratar abre el pago y registra el intento', async () => {
  const r = await B.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().url, 'https://checkout.stripe.test/c/cs_1');
  const req = fake.stripe.requests.find((x) => x.path === '/v1/checkout/sessions')!;
  assert.equal(req.body.get('mode'), 'subscription');
  assert.equal(req.body.get('line_items[0][price]'), 'price_pro');
  assert.equal(req.body.get('client_reference_id'), B.account);
  assert.equal(req.body.get('subscription_data[metadata][account_id]'), B.account);
  assert.equal((await sub()).status, 'incomplete');
  assert.equal((await B.api('POST', '/api/billing/checkout', { plan: 'solo-mp', provider: 'stripe' })).statusCode, 400);
  assert.equal((await B.api('POST', '/api/billing/checkout', { plan: 'nada', provider: 'stripe' })).statusCode, 404);
  fake.stripe.fail = true;
  assert.equal((await B.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).statusCode, 502);
  fake.stripe.fail = false;
});

t('Stripe: avisos con firma inválida, vencida o ajena se rechazan', async () => {
  const bad = stripeEvent('invoice.paid', {}, 'evt_x', undefined, 'otra_clave');
  assert.equal((await post('/webhook/billing/stripe', bad)).statusCode, 400);
  const old = stripeEvent('invoice.paid', {}, 'evt_y', Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await post('/webhook/billing/stripe', old)).statusCode, 400);
  const noSig = await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(noSig.statusCode, 400);
  const tampered = stripeEvent('invoice.paid', {}, 'evt_z');
  assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: tampered.payload.replace('evt_z', 'evt_w'), headers: tampered.headers })).statusCode, 400);
});

t('Stripe: el pago activa la cuenta (sale de prueba) y repetir el aviso no duplica correos', async () => {
  fake.stripe.subs.sub_1 = stripeSub({ metadata: { account_id: B.account, plan_key: 'pro' } });
  const before = mails('plan está activo');
  const res = await stripeHook('checkout.session.completed', { client_reference_id: B.account, subscription: 'sub_1', customer: 'cus_1' }, 'evt_a');
  assert.equal(res.statusCode, 200, res.body);
  const acc = await account();
  assert.equal(acc.status, 'active');
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.trial_ends_at, null);
  const s = await sub();
  assert.equal(s.status, 'active');
  assert.equal(s.provider_customer_id, 'cus_1');
  assert.equal(mails('plan está activo'), before + 1);
  await stripeHook('checkout.session.completed', { client_reference_id: B.account, subscription: 'sub_1' }, 'evt_a');
  await stripeHook('invoice.paid', { subscription: 'sub_1' }, 'evt_b');
  assert.equal(mails('plan está activo'), before + 1, 'avisos repetidos no mandan otro correo');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM billing_events WHERE event_id IN ('evt_a','evt_b')`)).rows[0].n, 2);
});

t('Stripe: ya con plan activo no se vuelve a cobrar; se administra en el portal', async () => {
  assert.equal((await B.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).statusCode, 409);
  const portal = await B.api('POST', '/api/billing/portal');
  assert.equal(portal.json().url, 'https://billing.stripe.test/p/1');
  assert.equal(fake.stripe.requests.at(-1)!.body.get('customer'), 'cus_1');
  assert.equal((await B.api('GET', '/api/billing')).json().subscription.can_portal, true);
});

t('Stripe: cobro fallido → gracia → pausa; el pago recupera la cuenta', async () => {
  fake.stripe.subs.sub_1.status = 'past_due';
  await stripeHook('invoice.payment_failed', { subscription: 'sub_1' });
  assert.equal((await sub()).status, 'past_due');
  assert.equal((await account()).status, 'active', 'durante la gracia sigue funcionando');
  assert.equal(mails('No pudimos cobrar'), 1);
  await stripeHook('invoice.payment_failed', { subscription: 'sub_1' }, 'evt_again');
  assert.equal(mails('No pudimos cobrar'), 1, 'no repite el aviso');
  assert.equal(await enforceAccess(days(3)), 0, 'dentro de los 5 días no se pausa');
  assert.equal(await enforceAccess(days(6)), 1);
  assert.equal((await account()).status, 'paused');
  assert.equal(mails('en pausa'), 1);
  assert.equal(await enforceAccess(days(7)), 0, 'se pausa una sola vez');
  fake.stripe.subs.sub_1.status = 'active';
  await stripeHook('invoice.paid', { subscription: 'sub_1' });
  assert.equal((await account()).status, 'active');
  assert.equal((await sub()).access_ended_at, null);
  assert.equal(mails('Recibimos tu pago'), 1);
});

t('si el superadmin reactiva a mano una cuenta pausada por pago, no se vuelve a pausar', async () => {
  fake.stripe.subs.sub_1.status = 'past_due';
  await stripeHook('invoice.payment_failed', { subscription: 'sub_1' }, 'evt_pf2');
  await enforceAccess(days(10));
  assert.equal((await account()).status, 'paused');
  await h.authed('PUT', `/api/accounts/${B.account}`, { status: 'active' });
  await enforceAccess(days(11));
  assert.equal((await account()).status, 'active');
  fake.stripe.subs.sub_1.status = 'active';
  await stripeHook('invoice.paid', { subscription: 'sub_1' }, 'evt_paid3');
});

t('Stripe: cancelar conserva el acceso hasta el fin del periodo pagado', async () => {
  const c = await B.api('POST', '/api/billing/cancel', {});
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(fake.stripe.subs.sub_1.cancel_at_period_end, true);
  assert.equal((await B.api('GET', '/api/billing')).json().subscription.cancel_at_period_end, true);
  const r = await B.api('POST', '/api/billing/cancel', { resume: true });
  assert.equal(r.statusCode, 200);
  assert.equal(fake.stripe.subs.sub_1.cancel_at_period_end, false);
  fake.stripe.subs.sub_1.status = 'canceled';
  await stripeHook('customer.subscription.deleted', fake.stripe.subs.sub_1, 'evt_del');
  assert.equal((await sub()).status, 'canceled');
  assert.equal((await account()).status, 'active', 'ya pagó el mes en curso');
  assert.equal(mails('se canceló'), 1);
  assert.equal(await enforceAccess(days(29)), 0);
  assert.equal(await enforceAccess(days(31)), 1);
  assert.equal((await account()).status, 'paused');
});

t('Mercado Pago: contratar, activar, cobro rechazado y cancelar', async () => {
  const r = await B.api('POST', '/api/billing/checkout', { plan: 'solo-mp', provider: 'mercadopago' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().url, 'https://mp.test/checkout/pre_new');
  const sent = fake.mp.requests.find((x) => x.path === '/preapproval' && x.method === 'POST')!.body;
  assert.equal(sent.external_reference, `${B.account}:solo-mp`);
  assert.equal(sent.payer_email, 'laura@sonrisa.mx');
  assert.deepEqual(sent.auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 199, currency_id: 'MXN' });

  const next = days(30).toISOString();
  fake.mp.preapprovals.pre_1 = { id: 'pre_1', status: 'authorized', external_reference: `${B.account}:solo-mp`, payer_id: 777, next_payment_date: next };
  const bad = mpEvent('subscription_preapproval', 'pre_1', 'otra_clave');
  assert.equal((await post(bad.url, bad)).statusCode, 400);
  const e1 = mpEvent('subscription_preapproval', 'pre_1');
  assert.equal((await post(e1.url, e1)).statusCode, 200);
  let s = await sub();
  assert.equal(s.provider, 'mercadopago');
  assert.equal(s.status, 'active');
  assert.equal(s.plan_key, 'solo-mp');
  assert.equal((await account()).status, 'active');
  assert.equal((await account()).plan, 'solo-mp');

  fake.mp.payments.pay_1 = { id: 'pay_1', preapproval_id: 'pre_1', status: 'rejected' };
  const e2 = mpEvent('subscription_authorized_payment', 'pay_1');
  assert.equal((await post(e2.url, e2)).statusCode, 200);
  assert.equal((await sub()).status, 'past_due');

  fake.mp.payments.pay_1.status = 'processed';
  const e3 = mpEvent('subscription_authorized_payment', 'pay_1');
  await post(e3.url, e3);
  assert.equal((await sub()).status, 'active');

  const c = await B.api('POST', '/api/billing/cancel', {});
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(fake.mp.preapprovals.pre_1.status, 'cancelled');
  const e4 = mpEvent('subscription_preapproval', 'pre_1');
  await post(e4.url, e4);
  s = await sub();
  assert.equal(s.status, 'canceled');
  assert.ok(new Date(s.current_period_end) > new Date(), 'conserva lo ya pagado');
});

t('resumen para el superadmin y permisos', async () => {
  const o = await h.authed('GET', '/api/billing/overview');
  assert.equal(o.statusCode, 200);
  assert.ok(o.json().providers.every((p: any) => p.enabled && p.webhook_url.endsWith(`/webhook/billing/${p.name}`)));
  assert.equal((await B.api('GET', '/api/billing/overview')).statusCode, 403);
  assert.equal((await h.authed('DELETE', '/api/plans/pro')).statusCode, 200, 'sin suscripciones activas se puede borrar');
});
