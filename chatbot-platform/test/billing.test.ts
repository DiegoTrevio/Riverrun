/** Cobro automático con Stripe y Mercado Pago (servicios simulados). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
// (Con import estático, ambos módulos con await de nivel superior se evalúan en paralelo.)
const { fake, mpEvent, stripeEvent, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');

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
    payload: { name: 'Laura Pérez', company: 'Clínica Sonrisa', business_type: 'salud', email: 'laura@sonrisa.mx', password: 'Pz-128-Qx-328-Kv', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  B.account = r.json().user.account_id;
  // La verificación de tarjeta pide el correo verificado; cada cuenta paga desde su propia conexión.
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = 'laura@sonrisa.mx'`);
  B.cookie = await h.sessionFrom(r);
  B.api = async (method, url, payload) => h.app.inject({ method: method as any, url, remoteAddress: '10.9.9.9', payload: payload as any, headers: { cookie: B.cookie } });
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
  assert.deepEqual(view.plans.find((p: any) => p.key === 'solo-mp').providers.map((x: any) => x.name), ['stripe', 'mercadopago'], 'sin ID de precio, Stripe arma el precio con el monto del plan');
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
  assert.equal((await sub()).checkout_ref, 'cs_1', 'se guarda la sesión para confirmar el pago sin esperar el aviso');
  assert.equal(req.body.get('success_url'), 'https://bot.test/pago/stripe?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(req.body.get('cancel_url'), 'https://bot.test/pago/stripe?estado=cancelado');
  assert.equal((await B.api('POST', '/api/billing/checkout', { plan: 'nada', provider: 'stripe' })).statusCode, 404);
  // Dentro de 30 minutos se reutiliza la misma página; vencida, se pide otra (y si Stripe falla, 502).
  assert.equal((await B.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).json().url, 'https://checkout.stripe.test/c/cs_1');
  await pool.query(`UPDATE card_checks SET opened_at = opened_at - interval '31 minutes' WHERE account_id = $1`, [B.account]);
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

t('una renovación (cuenta ya al corriente) no deshace una pausa manual, y repetir el mismo aviso no hace nada', async () => {
  await h.authed('PUT', `/api/accounts/${B.account}`, { status: 'paused' });
  const before = outbox.length;
  await stripeHook('invoice.paid', { subscription: 'sub_1' }, 'evt_renov1');
  assert.equal((await account()).status, 'paused', 'la pausa manual se respeta');
  const again = await stripeHook('invoice.paid', { subscription: 'sub_1' }, 'evt_renov1');
  assert.equal(again.statusCode, 200);
  assert.equal(outbox.length, before, 'sin correos nuevos');
  await h.authed('PUT', `/api/accounts/${B.account}`, { status: 'active' });
});

t('no se puede borrar un plan que tienen asignado cuentas', async () => {
  await pool.query(`UPDATE accounts SET plan = 'pro' WHERE id = $1`, [B.account]);
  const r = await h.authed('DELETE', '/api/plans/pro');
  assert.equal(r.statusCode, 409, r.body);
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
  // El plan de Stripe se canceló con días ya pagados: el primer cobro de Mercado Pago es cuando terminan (no se cobra dos veces).
  const paidUntil = new Date((await sub()).current_period_end);
  assert.ok(paidUntil > new Date());
  const r = await B.api('POST', '/api/billing/checkout', { plan: 'solo-mp', provider: 'mercadopago' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().url, 'https://mp.test/checkout/pre_new');
  const sent = fake.mp.requests.find((x) => x.path === '/preapproval' && x.method === 'POST')!.body;
  assert.equal(sent.external_reference, `${B.account}:solo-mp`);
  assert.equal(sent.payer_email, 'laura@sonrisa.mx');
  assert.deepEqual(sent.auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 230.84, currency_id: 'MXN', start_date: paidUntil.toISOString() }, 'precio + 16 % de IVA');

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

t('un aviso con un estado leído antes de otro más nuevo no lo pisa: con el candado se vuelve a leer al proveedor', async () => {
  const { applyState } = await import('../src/billing/service.js');
  const { stateFromSubscription } = await import('../src/billing/stripe.js');
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Clínica orden' })).json().id;
  await pool.query(`UPDATE accounts SET status = 'paused', pause_reason = 'payment' WHERE id = $1`, [acc]);
  // Lo que Stripe dice hoy: activa. Lo que un aviso leyó hace un momento: cancelada.
  fake.stripe.subs.sub_orden = stripeSub({ id: 'sub_orden', customer: 'cus_orden', status: 'active', metadata: { account_id: acc, plan_key: 'pro' } });
  const stale = stateFromSubscription({ ...fake.stripe.subs.sub_orden, status: 'canceled' }, []);
  await applyState(stale, new Date(), { refresh: true });
  assert.equal((await pool.query(`SELECT status FROM subscriptions WHERE account_id = $1`, [acc])).rows[0].status, 'active', 'queda el estado real');
  assert.equal((await pool.query(`SELECT status FROM accounts WHERE id = $1`, [acc])).rows[0].status, 'active');
});

t('planes privados: no salen en precios ni en el registro, y solo los contrata la cuenta a la que el superadmin se los asignó', async () => {
  const { payable } = await import('../src/billing/service.js');
  const { offeredPlans } = await import('../src/routes/billing.js');
  const r = await h.authed('POST', '/api/plans', { key: 'especial', name: 'Plan Especial Hotel', price: 2999, currency: 'MXN', public: false });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().public, false);
  assert.doesNotMatch((await h.app.inject({ method: 'GET', url: '/precios' })).body, /Plan Especial Hotel/);
  assert.ok(!(await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json().plans?.some((p: any) => p.key === 'especial'));
  assert.ok(!(await offeredPlans()).some((p) => p.key === 'especial'));
  await assert.rejects(payable('especial'), /no está disponible/);
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Hotel con trato especial' })).json().id;
  await assert.rejects(payable('especial', undefined, acc), /no está disponible/, 'sin asignar, tampoco');
  assert.equal((await h.authed('PUT', `/api/accounts/${acc}`, { plan: 'especial' })).statusCode, 200);
  assert.equal((await payable('especial', undefined, acc)).plan.key, 'especial');
  assert.ok((await offeredPlans(acc)).some((p) => p.key === 'especial'), 'en su Mi plan sí aparece');
  // Editar otra cosa del plan no lo vuelve público.
  assert.equal((await h.authed('PUT', '/api/plans/especial', { name: 'Plan Especial Hotel', price: 3199, currency: 'MXN' })).json().public, false);
});

t('un error del proveedor no llega al cliente: texto fijo con referencia, y el detalle solo en la bitácora del sistema (PAY-12)', async () => {
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Error del proveedor' })).json().id;
  await pool.query(`INSERT INTO subscriptions (account_id, provider, plan_key, status, provider_customer_id, provider_subscription_id, current_period_end)
                    VALUES ($1, 'stripe', 'pro', 'active', 'cus_err', 'sub_err', now() + interval '30 days')`, [acc]);
  fake.stripe.fail = true;
  try {
    const r = await h.authed('POST', `/api/billing/portal?account_id=${acc}`);
    assert.equal(r.statusCode, 502, r.body);
    assert.doesNotMatch(r.body, /Tu tarjeta fue rechazada/);
    const ref = /referencia (R-[A-Z0-9]{6})/.exec(r.json().error)?.[1];
    assert.ok(ref, r.body);
    const log = (await pool.query(`SELECT account_id, message FROM event_logs WHERE message LIKE $1`, [`%${ref}%`])).rows[0];
    assert.equal(log.account_id, null, 'no queda en la bitácora de la cuenta');
    assert.match(log.message, /Tu tarjeta fue rechazada/);
  } finally {
    fake.stripe.fail = false;
  }
});

t('los planes que ven el público y los clientes no llevan ids del proveedor ni datos internos (PAY-16)', async () => {
  await h.authed('PUT', '/api/plans/pro', { key: 'pro', name: 'Pro', price: 499, currency: 'MXN', stripe_price_id: 'price_secreto123' });
  const info = (await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json();
  const mine = (await B.api('GET', '/api/billing')).json();
  for (const list of [info.plans ?? [], mine.plans]) {
    assert.doesNotMatch(JSON.stringify(list), /price_secreto123|stripe_price_id|ai_usd_per_month|sort_order/);
  }
  assert.ok(mine.plans.length && mine.plans.every((p: any) => p.key && p.total > 0 && p.limits && p.providers), JSON.stringify(mine.plans));
});
