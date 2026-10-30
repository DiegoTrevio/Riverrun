/**
 * Registro con cobro: la cuenta nueva espera la tarjeta (el pago ya no se abre al registrarse, se abre desde Mi plan),
 * paga y queda activa aunque el aviso del proveedor no llegue.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake, mpEvent, stripeEvent, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
const { syncPendingCheckouts } = await import('../src/billing/service.js');
const { checkTrials } = await import('../src/lifecycle.js');
const { unitAmount } = await import('../src/billing/stripe.js');

let ip = 0;
const signup = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.77.0.${++ip}`, headers,
    payload: { name: 'Ana Ruiz', company: 'Estética Ana', business_type: 'belleza', password: 'Pz-105-Qx-305-Kv', accept_terms: true, ...body },
  });
// La sesión de cada registro se abre una vez (el arnés hace el 2FA); después se reutiliza.
const sessions = new WeakMap<object, Promise<string>>();
const as = async (r: Parameters<typeof h.sessionFrom>[0]) => {
  if (!sessions.has(r)) sessions.set(r, h.sessionFrom(r));
  const cookie = await sessions.get(r)!;
  return (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
};
const accountOf = async (id: string) => (await pool.query(`SELECT status, plan, trial_ends_at FROM accounts WHERE id = $1`, [id])).rows[0];
const subOf = async (id: string) => (await pool.query(`SELECT * FROM subscriptions WHERE account_id = $1`, [id])).rows[0];
const lastSession = () => fake.stripe.requests.filter((x) => x.path === '/v1/checkout/sessions').at(-1)!;
const lastSessionCount = () => fake.stripe.requests.filter((x) => x.path === '/v1/checkout/sessions').length;
/** Lo que pasa en Stripe cuando el cliente paga: la sesión se completa y existe la suscripción. */
const payStripe = (session: string, accountId: string, subId: string, plan = 'pro') => {
  fake.stripe.subs[subId] = stripeSub({ id: subId, customer: `cus_${subId}`, metadata: { account_id: accountId, plan_key: plan } });
  Object.assign(fake.stripe.sessions[session], { status: 'complete', subscription: subId });
};
/** Registrarse y abrir el pago desde Mi plan, con el correo verificado (lo pide la verificación de tarjeta). */
async function signupPay(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await signup(body, headers);
  assert.equal(r.statusCode, 200, r.body);
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE lower(email) = lower($1)`, [body.email]);
  const api = await as(r);
  const co = await api('POST', '/api/billing/checkout', { plan: body.plan, provider: body.provider });
  return { r, api, co, accountId: r.json().account.id as string, url: co.json().url as string };
}
const superNotices = async (title: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.role = 'superadmin' AND n.title LIKE $1`, [`${title}%`])).rows[0].n;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499, currency: 'MXN' })).statusCode, 200);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'basico', name: 'Básico', price: 199, sort_order: -1 })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el registro muestra los planes que se pueden pagar', async () => {
  const info = (await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json();
  assert.equal(info.trial_days, 14);
  assert.deepEqual(info.plans.map((p: any) => p.key), ['basico', 'pro']);
  const pro = info.plans.find((p: any) => p.key === 'pro');
  assert.equal(pro.price, 499);
  assert.deepEqual(pro.providers.map((x: any) => x.name), ['stripe', 'mercadopago']);
  assert.equal(pro.stripe_price_id, '', 'no hace falta crear el precio en Stripe a mano');
});

t('un plan que no existe se rechaza sin dejar una cuenta a medias', async () => {
  const r = await signup({ email: 'nadie@ana.mx', plan: 'no-existe', provider: 'stripe' });
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'nadie@ana.mx'`)).rows[0].n, 0);
});

t('con cobro, registrarse deja la cuenta esperando tarjeta: sin pago abierto y con el plan recordado', async () => {
  const sessions = lastSessionCount();
  const r = await signup({ email: 'espera@tarjeta.mx', company: 'Espera', plan: 'pro', provider: 'stripe' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().checkout_url, undefined, 'ya no se abre el pago al registrarse');
  assert.equal(lastSessionCount(), sessions);
  const acc = (await pool.query(`SELECT status, pause_reason, paused_at, trial_ends_at, signup_plan FROM accounts WHERE id = $1`, [r.json().account.id])).rows[0];
  assert.deepEqual([acc.status, acc.pause_reason, !!acc.paused_at, acc.trial_ends_at, acc.signup_plan], ['paused', 'card', true, null, 'pro']);
});

t('sin ningún proveedor de cobro, la prueba sigue sin tarjeta como hoy', async () => {
  const prev = { stripe: config.billing.stripe.secretKey, mp: config.billing.mercadopago.accessToken };
  Object.assign(config.billing.stripe, { secretKey: '' });
  Object.assign(config.billing.mercadopago, { accessToken: '' });
  try {
    const r = await signup({ email: 'sincobro@prueba.mx', company: 'Sin cobro' });
    assert.equal(r.statusCode, 200, r.body);
    const acc = await accountOf(r.json().account.id);
    assert.equal(acc.status, 'trial');
    assert.ok(acc.trial_ends_at);
  } finally {
    Object.assign(config.billing.stripe, { secretKey: prev.stripe });
    Object.assign(config.billing.mercadopago, { accessToken: prev.mp });
  }
});

t('pagar desde Mi plan con Stripe: al volver del pago la cuenta queda activa sin esperar el aviso', async () => {
  const { r, api, co, accountId, url } = await signupPay({ email: 'ana@estetica.mx', plan: 'pro', provider: 'stripe' });
  assert.equal(co.statusCode, 200, co.body);
  assert.equal(r.json().account.status, 'paused', 'mientras no agrega la tarjeta, espera');
  assert.match(url, /^https:\/\/checkout\.stripe\.test\/c\/cs_\d+$/);

  // Stripe arma el precio con el monto del plan y crea su producto una sola vez.
  const req = lastSession();
  assert.equal(req.body.get('line_items[0][price_data][currency]'), 'mxn');
  assert.equal(req.body.get('line_items[0][price_data][unit_amount]'), '57884', 'se cobra el precio + 16 % de IVA');
  assert.equal(req.body.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(req.body.get('line_items[0][price_data][product]'), 'riverrun_pro');
  assert.equal(req.body.get('customer_email'), 'ana@estetica.mx');
  assert.equal(req.body.get('subscription_data[metadata][account_id]'), accountId);
  assert.equal(req.body.get('success_url'), 'https://bot.test/pago/stripe');
  assert.equal(fake.stripe.products.riverrun_pro.name, 'Pro');

  // Regreso desde Stripe: la dirección sin "#" lleva al panel.
  const back = await h.app.inject({ method: 'GET', url: '/pago/stripe' });
  assert.equal(back.statusCode, 302);
  assert.equal(back.headers.location, '/#/plan?pago=ok');
  assert.equal((await h.app.inject({ method: 'GET', url: '/pago/stripe?estado=cancelado' })).headers.location, '/#/plan?pago=cancelado');

  // Antes de pagar no se activa nada.
  const session = url.split('/').pop()!;
  let c = await api('POST', '/api/billing/confirm');
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().confirmed, false);
  assert.equal((await accountOf(accountId)).status, 'paused');

  // Pagó: se confirma preguntándole a Stripe (sin webhook).
  payStripe(session, accountId, 'sub_ana');
  c = await api('POST', '/api/billing/confirm');
  assert.equal(c.json().confirmed, true);
  assert.equal(c.json().account_status, 'active');
  assert.equal(c.json().subscription.status, 'active');
  const acc = await accountOf(accountId);
  assert.equal(acc.status, 'active');
  // Con cobro en línea, la lista de pendientes incluye el plan, y ya está hecho.
  const plan = (await api('GET', '/api/onboarding/checklist')).json().items.find((i: any) => i.key === 'plan');
  assert.deepEqual([plan?.done, plan?.href], [true, '#/plan']);
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.trial_ends_at, null);
  assert.equal((await subOf(accountId)).checkout_ref, '', 'pago aplicado: ya no queda pendiente');
  const active = () => outbox.filter((m) => m.to === 'ana@estetica.mx' && m.subject.includes('plan está activo')).length;
  assert.equal(active(), 1);

  // Llegan después los avisos de Stripe y se vuelve a confirmar: sin correos repetidos.
  const e = stripeEvent('checkout.session.completed', { client_reference_id: accountId, subscription: 'sub_ana', customer: 'cus_sub_ana' });
  assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers })).statusCode, 200);
  assert.equal((await api('POST', '/api/billing/confirm')).json().confirmed, false);
  assert.equal(active(), 1);

  // Otro registro con el mismo plan reutiliza el producto de Stripe.
  const creates = () => fake.stripe.requests.filter((x) => x.method === 'POST' && x.path === '/v1/products').length;
  const before = creates();
  assert.equal((await signupPay({ email: 'otra@estetica.mx', plan: 'pro', provider: 'stripe' })).co.statusCode, 200);
  assert.equal(creates(), before);
});

t('solo se confirma un pago de la propia cuenta', async () => {
  const { api, accountId, url } = await signupPay({ email: 'beto@taller.mx', company: 'Taller Beto', plan: 'pro', provider: 'stripe' });
  const other = (await pool.query(`SELECT id FROM accounts WHERE name = 'Estética Ana' ORDER BY created_at LIMIT 1`)).rows[0].id;
  // La sesión de Beto termina en una suscripción que dice ser de otra cuenta: no se aplica a ninguna.
  payStripe(url.split('/').pop()!, other, 'sub_ajena');
  assert.equal((await api('POST', '/api/billing/confirm')).json().confirmed, false);
  assert.equal((await accountOf(accountId)).status, 'paused');
  assert.notEqual((await subOf(other)).provider_subscription_id, 'sub_ajena');
});

t('Mercado Pago: la revisión periódica activa la cuenta aunque el cliente cierre la página y no llegue el aviso', async () => {
  const { accountId, url } = await signupPay({ email: 'caro@cafe.mx', company: 'Café Caro', plan: 'basico', provider: 'mercadopago' });
  assert.equal(url, 'https://mp.test/checkout/pre_new');
  const sent = fake.mp.requests.filter((x) => x.path === '/preapproval' && x.method === 'POST').at(-1)!.body;
  assert.equal(sent.back_url, 'https://bot.test/pago/mercadopago');
  assert.equal(sent.external_reference, `${accountId}:basico`);
  assert.equal((await subOf(accountId)).checkout_ref, 'pre_new');

  fake.mp.preapprovals.pre_new = { id: 'pre_new', status: 'pending', external_reference: `${accountId}:basico`, payer_id: 9 };
  assert.equal(await syncPendingCheckouts(), 0, 'pendiente de pago: no se activa');
  assert.equal((await accountOf(accountId)).status, 'paused');

  Object.assign(fake.mp.preapprovals.pre_new, { status: 'authorized', next_payment_date: new Date(Date.now() + 30 * 86400_000).toISOString() });
  assert.equal(await syncPendingCheckouts(), 1);
  const acc = await accountOf(accountId);
  assert.equal(acc.status, 'active');
  assert.equal(acc.plan, 'basico');
  assert.equal((await subOf(accountId)).provider, 'mercadopago');
  assert.equal(await syncPendingCheckouts(), 0, 'ya aplicado: no se consulta de nuevo');
});

t('dos pagos completados (dos pestañas): se conserva el vigente y el otro se cancela y se reembolsa solo, una vez', async () => {
  const { processBillingActions } = await import('../src/billing/autopilot.js');
  const { api, accountId, url } = await signupPay({ email: 'dani@spa.mx', company: 'Spa Dani', plan: 'pro', provider: 'stripe' });
  payStripe(url.split('/').pop()!, accountId, 'sub_dani_1');
  assert.equal((await api('POST', '/api/billing/confirm')).json().confirmed, true);

  fake.stripe.subs.sub_dani_2 = stripeSub({ id: 'sub_dani_2', customer: 'cus_dani', metadata: { account_id: accountId, plan_key: 'pro' } });
  fake.stripe.invoices.push({ id: 'in_dani_2', subscription: 'sub_dani_2', status: 'paid', amount_paid: 57884, currency: 'mxn', charge: 'ch_dani_2', created: Math.floor(Date.now() / 1000) });
  for (const id of ['evt_dup_1', 'evt_dup_2']) {
    const e = stripeEvent('customer.subscription.created', fake.stripe.subs.sub_dani_2, id);
    assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers })).statusCode, 200);
  }
  assert.equal((await subOf(accountId)).provider_subscription_id, 'sub_dani_1');
  assert.equal(outbox.filter((m) => m.to === 'dani@spa.mx' && m.subject.includes('plan está activo')).length, 1);

  await processBillingActions(new Date(Date.now() + 1000)); // el reloj de PostgreSQL puede ir unos ms adelante
  assert.equal(fake.stripe.subs.sub_dani_2.status, 'canceled');
  assert.equal(fake.stripe.subs.sub_dani_1.status, 'active', 'la vigente sigue');
  assert.deepEqual(fake.stripe.refunds.filter((x) => x.charge === 'ch_dani_2'), [{ charge: 'ch_dani_2', payment_intent: '' }]);
  assert.equal(outbox.filter((m) => m.to === 'dani@spa.mx' && m.subject === 'Te devolvimos un cobro doble').length, 1);
  assert.equal(await superNotices('Cobro duplicado resuelto'), 1);
  // Ya resuelto: otra revisión no repite nada.
  await processBillingActions(new Date(Date.now() + 86400_000));
  assert.equal(fake.stripe.refunds.filter((x) => x.charge === 'ch_dani_2').length, 1);
  assert.equal(await superNotices('Cobro duplicado resuelto'), 1);
});

t('si el proveedor falla al abrir el pago, la cuenta sigue esperando la tarjeta y puede reintentar', async () => {
  fake.stripe.fail = true;
  let api: Awaited<ReturnType<typeof signupPay>>['api'];
  try {
    const first = await signupPay({ email: 'eva@flores.mx', company: 'Flores Eva', plan: 'pro', provider: 'stripe' });
    api = first.api;
    assert.equal(first.co.statusCode, 502, first.co.body);
    assert.equal((await accountOf(first.accountId)).status, 'paused');
  } finally {
    fake.stripe.fail = false;
  }
  assert.equal((await api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).statusCode, 200, 'el reintento sí abre el pago');
});

t('si el proveedor no responde (red caída) al abrir el pago, se avisa sin romperse', async () => {
  fake.stripe.drop = true;
  try {
    const { co } = await signupPay({ email: 'ivan@red.mx', company: 'Red Iván', plan: 'pro', provider: 'stripe' });
    assert.equal(co.statusCode, 502, co.body);
  } finally {
    fake.stripe.drop = false;
  }
});

t('Mercado Pago: un cobro rechazado que ya informó el aviso no se deshace en la revisión periódica', async () => {
  const { accountId } = await signupPay({ email: 'hugo@pan.mx', company: 'Pan Hugo', plan: 'basico', provider: 'mercadopago' });
  // El simulado siempre crea "pre_new" (ya usado por otra cuenta): esta cuenta tiene su propia suscripción.
  await pool.query(`UPDATE subscriptions SET checkout_ref = 'pre_hugo' WHERE account_id = $1`, [accountId]);
  fake.mp.preapprovals.pre_hugo = { id: 'pre_hugo', status: 'authorized', external_reference: `${accountId}:basico`, payer_id: 11, next_payment_date: new Date(Date.now() + 30 * 86400_000).toISOString() };
  const post = (e: { url: string; payload: string; headers: Record<string, string> }) => h.app.inject({ method: 'POST', url: e.url, payload: e.payload, headers: e.headers });
  assert.equal((await post(mpEvent('subscription_preapproval', 'pre_hugo'))).statusCode, 200);
  assert.equal((await subOf(accountId)).status, 'active');
  // El primer cobro se rechaza: Mercado Pago deja la suscripción "autorizada" mientras reintenta.
  fake.mp.payments.pay_hugo = { id: 'pay_hugo', preapproval_id: 'pre_hugo', status: 'rejected' };
  assert.equal((await post(mpEvent('subscription_authorized_payment', 'pay_hugo'))).statusCode, 200);
  assert.equal((await subOf(accountId)).status, 'past_due');

  await syncPendingCheckouts();
  const s = await subOf(accountId);
  assert.equal(s.status, 'past_due', 'la revisión no vuelve a activar un cobro rechazado');
  assert.equal(s.checkout_ref, '', 'ya no queda como pago pendiente');
});

t('el aviso tardío de un plan reemplazado (que se cancela al final del periodo) no se toma como cobro duplicado', async () => {
  const { api, accountId, url } = await signupPay({ email: 'jose@libros.mx', company: 'Libros José', plan: 'pro', provider: 'stripe' });
  payStripe(url.split('/').pop()!, accountId, 'sub_jose_nuevo');
  assert.equal((await api('POST', '/api/billing/confirm')).json().confirmed, true);
  const old = stripeSub({ id: 'sub_jose_viejo', customer: 'cus_jose', cancel_at_period_end: true, metadata: { account_id: accountId, plan_key: 'pro' } });
  fake.stripe.subs.sub_jose_viejo = old;
  const e = stripeEvent('customer.subscription.updated', old);
  assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers })).statusCode, 200);
  assert.equal((await subOf(accountId)).provider_subscription_id, 'sub_jose_nuevo', 'se conserva el plan vigente');
  assert.equal(await superNotices('Cobro duplicado: Libros José'), 0);
});

t('con dominio de marca, el pago regresa a ese dominio; con uno desconocido, al principal', async () => {
  const b = await h.authed('POST', '/api/brands', { name: 'Agencia', domain: 'panel.agencia.test' });
  assert.equal(b.statusCode, 200, b.body);
  // El pago se abre desde el panel de ese dominio.
  for (const [email, host, base] of [['fer@agencia.mx', 'panel.agencia.test', 'https://panel.agencia.test'], ['gil@agencia.mx', 'otro.test', 'https://bot.test']]) {
    const r = await signup({ email, plan: 'pro', provider: 'stripe' }, { host });
    await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = $1`, [email]);
    const cookie = await h.sessionFrom(r);
    const co = await h.app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie, host }, payload: { plan: 'pro', provider: 'stripe' } });
    assert.equal(co.statusCode, 200, co.body);
    assert.equal(lastSession().body.get('success_url'), `${base}/pago/stripe`);
  }
});

t('sin prueba gratis (TRIAL_DAYS=0): la cuenta nace en pausa y el pago la activa', async () => {
  const days = config.signup.trialDays;
  config.signup.trialDays = 0;
  try {
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json().trial_days, 0);
    const { r, api, accountId, url } = await signupPay({ email: 'hugo@gym.mx', company: 'Gym Hugo', plan: 'pro', provider: 'stripe' });
    assert.equal(r.json().account.status, 'paused');
    assert.equal(r.json().account.trial_ends_at, null);
    payStripe(url.split('/').pop()!, accountId, 'sub_hugo');
    assert.equal((await api('POST', '/api/billing/confirm')).json().account_status, 'active');
  } finally {
    config.signup.trialDays = days;
  }
});

t('los correos de fin de prueba llevan al pago en línea', async () => {
  const r = await signup({ email: 'ines@libros.mx', company: 'Libros Inés' });
  // Una prueba que ya empezó (con su tarjeta): termina en 2 días.
  await pool.query(`UPDATE accounts SET status = 'trial', trial_ends_at = now() + interval '2 days' WHERE id = $1`, [r.json().account.id]);
  await checkTrials();
  const mail = outbox.find((m) => m.to === 'ines@libros.mx' && /por terminar/.test(m.subject));
  assert.ok(mail?.text.includes('https://bot.test/#/plan'), mail?.text);
});

t('monedas sin centavos: Stripe recibe unidades enteras', async () => {
  assert.equal(unitAmount(49900, 'MXN'), 49900);
  assert.equal(unitAmount(1_000_000, 'clp'), 10000);
});
