/** Registro con pago inmediato: crear la cuenta desde cero, pagar y quedar activa aunque el aviso del proveedor no llegue. */
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
    payload: { name: 'Ana Ruiz', company: 'Estética Ana', business_type: 'belleza', password: 'clave-ana-123', accept_terms: true, ...body },
  });
const as = (r: { headers: Record<string, unknown> }) => {
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  return (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
};
const accountOf = async (id: string) => (await pool.query(`SELECT status, plan, trial_ends_at FROM accounts WHERE id = $1`, [id])).rows[0];
const subOf = async (id: string) => (await pool.query(`SELECT * FROM subscriptions WHERE account_id = $1`, [id])).rows[0];
const lastSession = () => fake.stripe.requests.filter((x) => x.path === '/v1/checkout/sessions').at(-1)!;
/** Lo que pasa en Stripe cuando el cliente paga: la sesión se completa y existe la suscripción. */
const payStripe = (session: string, accountId: string, subId: string, plan = 'pro') => {
  fake.stripe.subs[subId] = stripeSub({ id: subId, customer: `cus_${subId}`, metadata: { account_id: accountId, plan_key: plan } });
  Object.assign(fake.stripe.sessions[session], { status: 'complete', subscription: subId });
};
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

t('crear la cuenta y pagar ahí mismo con Stripe: al volver del pago la cuenta queda activa sin esperar el aviso', async () => {
  const r = await signup({ email: 'ana@estetica.mx', plan: 'pro', provider: 'stripe' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  const accountId = body.account.id;
  assert.equal(body.account.status, 'trial', 'mientras no paga, conserva su prueba');
  assert.match(body.checkout_url, /^https:\/\/checkout\.stripe\.test\/c\/cs_\d+$/);
  const api = as(r);

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
  const session = body.checkout_url.split('/').pop();
  let c = await api('POST', '/api/billing/confirm');
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().confirmed, false);
  assert.equal((await accountOf(accountId)).status, 'trial');

  // Pagó: se confirma preguntándole a Stripe (sin webhook).
  payStripe(session, accountId, 'sub_ana');
  c = await api('POST', '/api/billing/confirm');
  assert.equal(c.json().confirmed, true);
  assert.equal(c.json().account_status, 'active');
  assert.equal(c.json().subscription.status, 'active');
  const acc = await accountOf(accountId);
  assert.equal(acc.status, 'active');
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
  assert.equal((await signup({ email: 'otra@estetica.mx', plan: 'pro', provider: 'stripe' })).statusCode, 200);
  assert.equal(creates(), before);
});

t('solo se confirma un pago de la propia cuenta', async () => {
  const r = await signup({ email: 'beto@taller.mx', company: 'Taller Beto', plan: 'pro', provider: 'stripe' });
  const accountId = r.json().account.id;
  const other = (await pool.query(`SELECT id FROM accounts WHERE name = 'Estética Ana' ORDER BY created_at LIMIT 1`)).rows[0].id;
  // La sesión de Beto termina en una suscripción que dice ser de otra cuenta: no se aplica a ninguna.
  payStripe(r.json().checkout_url.split('/').pop(), other, 'sub_ajena');
  assert.equal((await as(r)('POST', '/api/billing/confirm')).json().confirmed, false);
  assert.equal((await accountOf(accountId)).status, 'trial');
  assert.notEqual((await subOf(other)).provider_subscription_id, 'sub_ajena');
});

t('Mercado Pago: la revisión periódica activa la cuenta aunque el cliente cierre la página y no llegue el aviso', async () => {
  const r = await signup({ email: 'caro@cafe.mx', company: 'Café Caro', plan: 'basico', provider: 'mercadopago' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().checkout_url, 'https://mp.test/checkout/pre_new');
  const accountId = r.json().account.id;
  const sent = fake.mp.requests.filter((x) => x.path === '/preapproval' && x.method === 'POST').at(-1)!.body;
  assert.equal(sent.back_url, 'https://bot.test/pago/mercadopago');
  assert.equal(sent.external_reference, `${accountId}:basico`);
  assert.equal((await subOf(accountId)).checkout_ref, 'pre_new');

  fake.mp.preapprovals.pre_new = { id: 'pre_new', status: 'pending', external_reference: `${accountId}:basico`, payer_id: 9 };
  assert.equal(await syncPendingCheckouts(), 0, 'pendiente de pago: no se activa');
  assert.equal((await accountOf(accountId)).status, 'trial');

  Object.assign(fake.mp.preapprovals.pre_new, { status: 'authorized', next_payment_date: new Date(Date.now() + 30 * 86400_000).toISOString() });
  assert.equal(await syncPendingCheckouts(), 1);
  const acc = await accountOf(accountId);
  assert.equal(acc.status, 'active');
  assert.equal(acc.plan, 'basico');
  assert.equal((await subOf(accountId)).provider, 'mercadopago');
  assert.equal(await syncPendingCheckouts(), 0, 'ya aplicado: no se consulta de nuevo');
});

t('dos pagos completados (dos pestañas): se conserva el vigente y se avisa una vez al superadmin', async () => {
  const r = await signup({ email: 'dani@spa.mx', company: 'Spa Dani', plan: 'pro', provider: 'stripe' });
  const accountId = r.json().account.id;
  payStripe(r.json().checkout_url.split('/').pop(), accountId, 'sub_dani_1');
  assert.equal((await as(r)('POST', '/api/billing/confirm')).json().confirmed, true);

  fake.stripe.subs.sub_dani_2 = stripeSub({ id: 'sub_dani_2', customer: 'cus_dani', metadata: { account_id: accountId, plan_key: 'pro' } });
  for (const id of ['evt_dup_1', 'evt_dup_2']) {
    const e = stripeEvent('customer.subscription.created', fake.stripe.subs.sub_dani_2, id);
    assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers })).statusCode, 200);
  }
  assert.equal((await subOf(accountId)).provider_subscription_id, 'sub_dani_1');
  assert.equal(await superNotices('Cobro duplicado: Spa Dani'), 1);
  assert.equal(outbox.filter((m) => m.to === 'dani@spa.mx' && m.subject.includes('plan está activo')).length, 1);
});

t('si el proveedor falla al registrarse, la cuenta queda creada y puede reintentar el pago', async () => {
  fake.stripe.fail = true;
  try {
    const r = await signup({ email: 'eva@flores.mx', company: 'Flores Eva', plan: 'pro', provider: 'stripe' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().checkout_url, undefined);
    assert.match(r.json().checkout_error, /cuenta quedó creada/);
    assert.equal(r.json().account.status, 'trial');
  } finally {
    fake.stripe.fail = false;
  }
});

t('si el proveedor no responde (red caída) al registrarse, la cuenta queda creada y el reintento avisa sin romperse', async () => {
  fake.stripe.drop = true;
  try {
    const r = await signup({ email: 'ivan@red.mx', company: 'Red Iván', plan: 'pro', provider: 'stripe' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().checkout_url, undefined);
    assert.match(r.json().checkout_error, /cuenta quedó creada.*No se pudo conectar con Stripe/);
    const retry = await as(r)('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
    assert.equal(retry.statusCode, 502, retry.body);
  } finally {
    fake.stripe.drop = false;
  }
});

t('Mercado Pago: un cobro rechazado que ya informó el aviso no se deshace en la revisión periódica', async () => {
  const r = await signup({ email: 'hugo@pan.mx', company: 'Pan Hugo', plan: 'basico', provider: 'mercadopago' });
  const accountId = r.json().account.id;
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
  const r = await signup({ email: 'jose@libros.mx', company: 'Libros José', plan: 'pro', provider: 'stripe' });
  const accountId = r.json().account.id;
  payStripe(r.json().checkout_url.split('/').pop(), accountId, 'sub_jose_nuevo');
  assert.equal((await as(r)('POST', '/api/billing/confirm')).json().confirmed, true);
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
  assert.equal((await signup({ email: 'fer@agencia.mx', plan: 'pro', provider: 'stripe' }, { host: 'panel.agencia.test' })).statusCode, 200);
  assert.equal(lastSession().body.get('success_url'), 'https://panel.agencia.test/pago/stripe');
  assert.equal((await signup({ email: 'gil@agencia.mx', plan: 'pro', provider: 'stripe' }, { host: 'otro.test' })).statusCode, 200);
  assert.equal(lastSession().body.get('success_url'), 'https://bot.test/pago/stripe');
});

t('sin prueba gratis (TRIAL_DAYS=0): la cuenta nace en pausa y el pago la activa', async () => {
  const days = config.signup.trialDays;
  config.signup.trialDays = 0;
  try {
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json().trial_days, 0);
    const r = await signup({ email: 'hugo@gym.mx', company: 'Gym Hugo', plan: 'pro', provider: 'stripe' });
    assert.equal(r.statusCode, 200, r.body);
    const accountId = r.json().account.id;
    assert.equal(r.json().account.status, 'paused');
    assert.equal(r.json().account.trial_ends_at, null);
    payStripe(r.json().checkout_url.split('/').pop(), accountId, 'sub_hugo');
    assert.equal((await as(r)('POST', '/api/billing/confirm')).json().account_status, 'active');
  } finally {
    config.signup.trialDays = days;
  }
});

t('los correos de fin de prueba llevan al pago en línea', async () => {
  const r = await signup({ email: 'ines@libros.mx', company: 'Libros Inés' });
  await pool.query(`UPDATE accounts SET trial_ends_at = now() + interval '2 days' WHERE id = $1`, [r.json().account.id]);
  await checkTrials();
  const mail = outbox.find((m) => m.to === 'ines@libros.mx' && /por terminar/.test(m.subject));
  assert.ok(mail?.text.includes('https://bot.test/#/plan'), mail?.text);
});

t('monedas sin centavos: Stripe recibe unidades enteras', async () => {
  assert.equal(unitAmount(49900, 'MXN'), 49900);
  assert.equal(unitAmount(1_000_000, 'clp'), 10000);
});
