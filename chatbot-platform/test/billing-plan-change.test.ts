/** Cambiar de plan, cambiar la tarjeta y reanudar desde el panel, con Stripe y con Mercado Pago. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake, mpEvent, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const store = await import('../src/store/index.js');

type Api = (method: string, url: string, payload?: unknown) => ReturnType<typeof h.app.inject>;
let ip = 0;
const DAY = 86400_000;
const periodEnd = new Date(Date.now() + 20 * DAY);

async function signup(email: string, plan: string, provider: 'stripe' | 'mercadopago') {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.88.0.${++ip}`,
    payload: { name: 'Eva Ruiz', company: `Negocio ${ip}`, business_type: 'belleza', email, password: 'clave-eva-123', accept_terms: true, plan, provider },
  });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const api: Api = (method, url, payload) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { api, accountId: r.json().account.id as string, checkout: r.json().checkout_url as string };
}

/** Cuenta que ya paga `plan` con Stripe (suscripción `subId`). */
async function paidStripe(email: string, plan: string, subId: string) {
  const a = await signup(email, plan, 'stripe');
  const session = a.checkout.split('/').pop()!;
  fake.stripe.subs[subId] = stripeSub({ id: subId, customer: `cus_${subId}`, metadata: { account_id: a.accountId, plan_key: plan }, items: { data: [{ id: `si_${subId}`, price: { id: `price_${plan}` } }] } });
  Object.assign(fake.stripe.sessions[session], { status: 'complete', subscription: subId });
  assert.equal((await a.api('POST', '/api/billing/confirm')).json().confirmed, true);
  return a;
}

/** Cuenta que ya paga `plan` con Mercado Pago (suscripción `preId`). */
async function paidMp(email: string, plan: string, preId: string) {
  fake.mp.nextId = preId;
  const a = await signup(email, plan, 'mercadopago');
  fake.mp.preapprovals[preId] = { id: preId, status: 'authorized', external_reference: `${a.accountId}:${plan}`, payer_id: 7, next_payment_date: periodEnd.toISOString(), auto_recurring: { transaction_amount: 230.84, currency_id: 'MXN' } };
  assert.equal((await a.api('POST', '/api/billing/confirm')).json().confirmed, true);
  return a;
}

const subOf = async (id: string) => (await pool.query(`SELECT * FROM subscriptions WHERE account_id = $1`, [id])).rows[0];
const planOf = async (id: string) => (await pool.query(`SELECT plan FROM accounts WHERE id = $1`, [id])).rows[0].plan;
const lastStripe = (path: string) => fake.stripe.requests.filter((x) => x.method === 'POST' && x.path === path).at(-1)!.body;
const lastMp = (method: string, path: string) => fake.mp.requests.filter((x) => x.method === method && x.path === path).at(-1)!.body;
const superNotices = async (title: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.role = 'superadmin' AND n.title LIKE $1`, [`${title}%`])).rows[0].n;
const mpHook = (type: string, id: string) => {
  const e = mpEvent(type, id);
  return h.app.inject({ method: 'POST', url: e.url, payload: e.payload, headers: e.headers });
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  for (const p of [
    { key: 'basico', name: 'Básico', price: 199, limits: { channels: 1 } },
    { key: 'pro', name: 'Pro', price: 499 },
    { key: 'anual', name: 'Pro anual', price: 4990, interval: 'year' },
  ]) assert.equal((await h.authed('POST', '/api/plans', p)).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('Stripe: subir de plan cobra hoy la diferencia proporcional y cambia el plan y sus límites', async () => {
  const a = await paidStripe('eva@salon.mx', 'basico', 'sub_eva');
  outbox.length = 0;
  const r = await a.api('POST', '/api/billing/change', { plan: 'pro' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().url, undefined, 'sin pasar por la página de pago');
  const body = lastStripe('/v1/subscriptions/sub_eva');
  assert.equal(body.get('items[0][id]'), 'si_sub_eva');
  assert.equal(body.get('items[0][price_data][unit_amount]'), '57884', 'precio + IVA');
  assert.equal(body.get('items[0][price_data][recurring][interval]'), 'month');
  assert.equal(body.get('proration_behavior'), 'always_invoice');
  assert.equal(body.get('payment_behavior'), 'error_if_incomplete', 'si el cobro falla, no cambia nada');
  assert.equal(body.get('metadata[plan_key]'), 'pro');
  assert.equal((await subOf(a.accountId)).plan_key, 'pro');
  assert.equal(await planOf(a.accountId), 'pro');
  assert.equal(r.json().subscription.plan_key, 'pro');
  const mail = outbox.find((m) => m.to === 'eva@salon.mx' && m.subject === 'Cambiaste al plan Pro');
  assert.match(mail!.text, /diferencia proporcional/);
  assert.ok(!outbox.some((m) => m.to === 'eva@salon.mx' && /plan está activo/.test(m.subject)), 'no es una contratación nueva');
});

t('Stripe: bajar de plan deja saldo a favor; antes, la cuenta tiene que caber en los límites', async () => {
  const a = await paidStripe('ian@salon.mx', 'pro', 'sub_ian');
  const bot = (await a.api('POST', '/api/chatbots', { name: 'Ian' })).json();
  const chs = [];
  for (const n of ['Uno', 'Dos']) chs.push(await store.createChannel({ account_id: a.accountId, chatbot_id: bot.id, type: 'webchat', name: n, config: {} }));
  const r = await a.api('POST', '/api/billing/change', { plan: 'basico' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /2 canales .*permite 1/);
  assert.equal((await subOf(a.accountId)).plan_key, 'pro', 'no se tocó nada');

  await pool.query(`DELETE FROM channels WHERE id = $1`, [chs[1].id]);
  const ok2 = await a.api('POST', '/api/billing/change', { plan: 'basico' });
  assert.equal(ok2.statusCode, 200, ok2.body);
  const body = lastStripe('/v1/subscriptions/sub_ian');
  assert.equal(body.get('proration_behavior'), 'create_prorations');
  assert.equal(body.get('payment_behavior'), null);
  assert.equal(await planOf(a.accountId), 'basico');
});

t('Stripe: de mensual a anual en el mismo paso; mismo plan, plan inexistente, agente y proveedor caído', async () => {
  const a = await paidStripe('ana@salon.mx', 'pro', 'sub_ana');
  assert.equal((await a.api('POST', '/api/billing/change', { plan: 'pro' })).statusCode, 400);
  assert.equal((await a.api('POST', '/api/billing/change', { plan: 'nada' })).statusCode, 404);

  assert.equal((await h.authed('POST', '/api/users', { account_id: a.accountId, name: 'Beto', email: 'beto@salon.mx', password: 'clave-beto-123', role: 'agent' })).statusCode, 200);
  assert.equal((await (await h.loginAs('beto@salon.mx', 'clave-beto-123'))('POST', '/api/billing/change', { plan: 'anual' })).statusCode, 403);

  fake.stripe.fail = true;
  try {
    const r = await a.api('POST', '/api/billing/change', { plan: 'anual' });
    assert.equal(r.statusCode, 502);
    assert.match(r.json().error, /tarjeta fue rechazada/);
  } finally {
    fake.stripe.fail = false;
  }
  assert.equal((await subOf(a.accountId)).plan_key, 'pro');

  assert.equal((await a.api('POST', '/api/billing/change', { plan: 'anual' })).statusCode, 200);
  assert.equal(lastStripe('/v1/subscriptions/sub_ana').get('items[0][price_data][recurring][interval]'), 'year');
  assert.equal(await planOf(a.accountId), 'anual');

  // Con la cancelación pendiente, primero hay que mantener el plan.
  assert.equal((await a.api('POST', '/api/billing/cancel', {})).statusCode, 200);
  assert.equal((await a.api('POST', '/api/billing/change', { plan: 'pro' })).statusCode, 400);
});

t('Mercado Pago: cambio en el mismo periodo, el nuevo monto desde el siguiente cobro', async () => {
  const a = await paidMp('lia@cafe.mx', 'basico', 'pre_lia');
  outbox.length = 0;
  const r = await a.api('POST', '/api/billing/change', { plan: 'pro' });
  assert.equal(r.statusCode, 200, r.body);
  const body = lastMp('PUT', '/preapproval/pre_lia');
  assert.deepEqual(body.auto_recurring, { transaction_amount: 578.84, currency_id: 'MXN' });
  assert.equal(body.external_reference, `${a.accountId}:pro`);
  assert.equal(body.reason, 'Pro');
  assert.equal((await subOf(a.accountId)).plan_key, 'pro');
  assert.equal(await planOf(a.accountId), 'pro');
  assert.match(outbox.find((m) => m.subject === 'Cambiaste al plan Pro')!.text, /desde tu siguiente cobro/);
});

t('Mercado Pago: de mensual a anual por sustitución; al autorizarla, la anterior se cancela sin aviso de cobro duplicado', async () => {
  const a = await paidMp('ole@cafe.mx', 'pro', 'pre_ole');
  fake.mp.nextId = 'pre_ole2';
  const r = await a.api('POST', '/api/billing/change', { plan: 'anual' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().url, 'https://mp.test/checkout/pre_ole2');
  const created = lastMp('POST', '/preapproval');
  assert.equal(created.external_reference, `${a.accountId}:anual`);
  assert.equal(created.auto_recurring.frequency, 12);
  assert.equal(new Date(created.auto_recurring.start_date).getTime(), periodEnd.getTime(), 'primer cobro al terminar lo pagado');
  assert.equal((await subOf(a.accountId)).plan_key, 'pro', 'mientras no autoriza, sigue igual');

  fake.mp.preapprovals.pre_ole2 = { id: 'pre_ole2', status: 'authorized', external_reference: `${a.accountId}:anual`, payer_id: 7, next_payment_date: periodEnd.toISOString() };
  outbox.length = 0;
  assert.equal((await mpHook('subscription_preapproval', 'pre_ole2')).statusCode, 200);
  const sub = await subOf(a.accountId);
  assert.deepEqual([sub.provider_subscription_id, sub.plan_key, sub.status], ['pre_ole2', 'anual', 'active']);
  assert.equal(await planOf(a.accountId), 'anual');
  assert.equal(lastMp('PUT', '/preapproval/pre_ole').status, 'cancelled', 'la anterior deja de cobrar');
  assert.equal(await superNotices('Cobro duplicado: Negocio'), 0);
  assert.deepEqual(outbox.filter((m) => m.to === 'ole@cafe.mx').map((m) => m.subject), ['Actualizamos tu plan']);

  // El aviso de la anterior ya cancelada no pisa a la nueva.
  assert.equal((await mpHook('subscription_preapproval', 'pre_ole')).statusCode, 200);
  assert.equal((await subOf(a.accountId)).provider_subscription_id, 'pre_ole2');
});

t('Mercado Pago: cambiar la tarjeta y reanudar tras cancelar, sin cobrar dos veces el periodo pagado', async () => {
  const a = await paidMp('rui@cafe.mx', 'pro', 'pre_rui');
  fake.mp.nextId = 'pre_rui2';
  const card = await a.api('POST', '/api/billing/payment-method');
  assert.equal(card.statusCode, 200, card.body);
  assert.equal(card.json().url, 'https://mp.test/checkout/pre_rui2');
  let created = lastMp('POST', '/preapproval');
  assert.equal(created.external_reference, `${a.accountId}:pro`);
  assert.equal(new Date(created.auto_recurring.start_date).getTime(), periodEnd.getTime());

  // Reanudar: Mercado Pago cancela en el acto; volver a autorizar el mismo plan empieza a cobrar al terminar lo pagado.
  assert.equal((await a.api('POST', '/api/billing/cancel', {})).statusCode, 200);
  assert.equal(lastMp('PUT', '/preapproval/pre_rui').status, 'cancelled');
  fake.mp.nextId = 'pre_rui3';
  const resume = await a.api('POST', '/api/billing/cancel', { resume: true });
  assert.equal(resume.statusCode, 200, resume.body);
  assert.equal(resume.json().url, 'https://mp.test/checkout/pre_rui3');
  created = lastMp('POST', '/preapproval');
  assert.equal(new Date(created.auto_recurring.start_date).getTime(), periodEnd.getTime());

  fake.mp.preapprovals.pre_rui3 = { id: 'pre_rui3', status: 'authorized', external_reference: `${a.accountId}:pro`, payer_id: 7, next_payment_date: periodEnd.toISOString() };
  assert.equal((await mpHook('subscription_preapproval', 'pre_rui3')).statusCode, 200);
  const sub = await subOf(a.accountId);
  assert.deepEqual([sub.provider_subscription_id, sub.status, sub.cancel_at_period_end], ['pre_rui3', 'active', false]);
  assert.equal(await superNotices('Cobro duplicado: Negocio'), 0);

  // Stripe cambia la tarjeta en su propia página.
  const s = await paidStripe('sol@salon.mx', 'pro', 'sub_sol');
  assert.equal((await s.api('POST', '/api/billing/payment-method')).json().url, 'https://billing.stripe.test/p/1');
});

t('un segundo cobro que nadie pidió sigue avisando al superadmin', async () => {
  const a = await paidMp('uma@cafe.mx', 'pro', 'pre_uma');
  fake.mp.preapprovals.pre_uma2 = { id: 'pre_uma2', status: 'authorized', external_reference: `${a.accountId}:pro`, payer_id: 7, next_payment_date: periodEnd.toISOString() };
  assert.equal((await mpHook('subscription_preapproval', 'pre_uma2')).statusCode, 200);
  assert.equal((await subOf(a.accountId)).provider_subscription_id, 'pre_uma');
  assert.equal(await superNotices('Cobro duplicado: Negocio'), 1);
});

t('Mercado Pago con el cobro rechazado: cambiar la tarjeta cobra ya y la cuenta queda al corriente, sin contarse como nueva', async () => {
  const a = await paidMp('ari@cafe.mx', 'pro', 'pre_ari');
  await pool.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = now() WHERE account_id = $1`, [a.accountId]);
  fake.mp.nextId = 'pre_ari2';
  assert.equal((await a.api('POST', '/api/billing/payment-method')).statusCode, 200);
  assert.equal(lastMp('POST', '/preapproval').auto_recurring.start_date, undefined, 'lo vencido se cobra ya');

  fake.mp.preapprovals.pre_ari2 = { id: 'pre_ari2', status: 'authorized', external_reference: `${a.accountId}:pro`, payer_id: 7, next_payment_date: periodEnd.toISOString() };
  outbox.length = 0;
  const before = await superNotices('Nueva suscripción: Negocio');
  assert.equal((await mpHook('subscription_preapproval', 'pre_ari2')).statusCode, 200);
  const sub = await subOf(a.accountId);
  assert.deepEqual([sub.provider_subscription_id, sub.status, sub.past_due_since], ['pre_ari2', 'active', null]);
  assert.equal(lastMp('PUT', '/preapproval/pre_ari').status, 'cancelled');
  assert.deepEqual(outbox.filter((m) => m.to === 'ari@cafe.mx').map((m) => m.subject), ['Recibimos tu pago, ¡gracias!']);
  assert.equal(await superNotices('Nueva suscripción: Negocio'), before);
});
