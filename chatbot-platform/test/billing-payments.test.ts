/** Precio + IVA y registro de cada cobro (con su IVA desglosado) y sus reembolsos, desde los avisos de Stripe y Mercado Pago. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake, mpEvent, stripeEvent, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { splitTax, withTax } = await import('../src/billing/tax.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

type Api = (m: string, u: string, p?: unknown) => Promise<any>;
const A = { account: '', api: null as unknown as Api };
const M = { account: '', api: null as unknown as Api };
const post = (url: string, e: { payload: string; headers: Record<string, string> }) => h.app.inject({ method: 'POST', url, payload: e.payload, headers: e.headers });
const stripeHook = (type: string, obj: unknown) => post('/webhook/billing/stripe', stripeEvent(type, obj));
const mpHook = async (type: string, id: string) => { const e = mpEvent(type, id); return post(e.url, e); };
const payments = async (accountId: string) => (await pool.query(`SELECT * FROM billing_payments WHERE account_id = $1 ORDER BY paid_at`, [accountId])).rows;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

async function signup(email: string, ip: string) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: ip,
    payload: { name: 'Dueña', company: `Negocio ${email}`, business_type: 'servicios', email, password: 'Pz-144-Qx-344-Kv', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = await h.sessionFrom(r);
  return { account: r.json().user.account_id as string, api: ((method, url, payload) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } })) as Api };
}

const invoice = (over: Record<string, unknown> = {}) => {
  const start = new Date();
  const end = new Date(Date.now() + 30 * 86400_000);
  return {
    id: 'in_1', object: 'invoice', status: 'paid', subscription: 'sub_pay', customer: 'cus_pay', amount_paid: 57884, currency: 'mxn', charge: 'ch_1',
    status_transitions: { paid_at: unix(start) }, lines: { data: [{ period: { start: unix(start), end: unix(end) } }] }, ...over,
  };
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  Object.assign(A, await signup('ana@pagos.mx', '10.7.7.1'));
  Object.assign(M, await signup('mara@pagos.mx', '10.7.7.2'));
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499 })).statusCode, 200);
  const anual = await h.authed('POST', '/api/plans', { key: 'anual', name: 'Pro anual', price: 4990, interval: 'year' });
  assert.equal(anual.statusCode, 200, anual.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

test('IVA en centavos: precio + IVA, y el desglose siempre suma el total', () => {
  assert.equal(withTax(49900, 16), 57884);
  assert.equal(withTax(19900, 16), 23084);
  assert.equal(withTax(49900, 0), 49900);
  assert.deepEqual(splitTax(57884, 16), { subtotal: 49900, tax: 7984 });
  for (let total = 1; total < 5000; total += 7) {
    const { subtotal, tax } = splitTax(total, 16);
    assert.equal(subtotal + tax, total);
    assert.ok(tax >= 0 && subtotal >= 0);
  }
});

t('los planes se publican sin IVA y muestran el total que se cobra', async () => {
  const b = (await A.api('GET', '/api/billing')).json();
  const pro = b.plans.find((p: any) => p.key === 'pro');
  assert.deepEqual([pro.price, pro.tax_percent, pro.total, pro.interval], [499, 16, 578.84, 'month']);
  const anual = b.plans.find((p: any) => p.key === 'anual');
  assert.deepEqual([anual.price, anual.total, anual.interval], [4990, 5788.4, 'year']);
  assert.deepEqual(b.payments, []);
  const info = (await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json();
  assert.equal(info.plans.find((p: any) => p.key === 'pro').total, 578.84, 'el registro también muestra el total');
});

t('plan anual: Stripe cobra precio + IVA cada año y Mercado Pago cada 12 meses', async () => {
  assert.equal((await A.api('POST', '/api/billing/checkout', { plan: 'anual', provider: 'stripe' })).statusCode, 200);
  const req = fake.stripe.requests.filter((x) => x.path === '/v1/checkout/sessions').at(-1)!;
  assert.equal(req.body.get('line_items[0][price_data][unit_amount]'), '578840');
  assert.equal(req.body.get('line_items[0][price_data][recurring][interval]'), 'year');
  assert.equal((await M.api('POST', '/api/billing/checkout', { plan: 'anual', provider: 'mercadopago' })).statusCode, 200);
  const sent = fake.mp.requests.filter((x) => x.path === '/preapproval' && x.method === 'POST').at(-1)!.body;
  // Las cuentas están en su prueba: el primer cobro es al terminarla (ver billing-autopilot.test.ts).
  const { start_date, ...recurring } = sent.auto_recurring;
  assert.deepEqual(recurring, { frequency: 12, frequency_type: 'months', transaction_amount: 5788.4, currency_id: 'MXN' });
  assert.ok(start_date);
});

t('Stripe: una factura pagada se registra una sola vez con el IVA desglosado', async () => {
  fake.stripe.subs.sub_pay = stripeSub({ id: 'sub_pay', customer: 'cus_pay', metadata: { account_id: A.account, plan_key: 'pro' } });
  assert.equal((await stripeHook('invoice.paid', invoice())).statusCode, 200);
  // Stripe manda también invoice.payment_succeeded, y reintenta avisos: el cobro no se duplica.
  assert.equal((await stripeHook('invoice.payment_succeeded', invoice())).statusCode, 200);
  assert.equal((await stripeHook('invoice.paid', invoice())).statusCode, 200);
  const rows = await payments(A.account);
  assert.equal(rows.length, 1);
  const p = rows[0];
  assert.deepEqual([p.provider, p.provider_payment_id, p.provider_charge_ref, p.plan_key, p.currency], ['stripe', 'in_1', 'ch_1', 'pro', 'MXN']);
  assert.deepEqual([p.total_cents, p.subtotal_cents, p.tax_cents, Number(p.tax_percent), p.status], [57884, 49900, 7984, 16, 'paid']);
  assert.ok(p.period_end > p.period_start);

  const b = (await A.api('GET', '/api/billing')).json();
  assert.equal(b.subscription.status, 'active');
  assert.deepEqual(b.payments.map((x: any) => [x.total, x.subtotal, x.tax, x.status]), [[578.84, 499, 79.84, 'paid']]);
  assert.equal((await M.api('GET', '/api/billing')).json().payments.length, 0, 'cada cuenta ve solo sus pagos');

  const ov = (await h.authed('GET', '/api/billing/overview')).json();
  assert.deepEqual(ov.monthly_revenue, [{ currency: 'MXN', amount: 499 }], 'el ingreso mensual va sin IVA');
});

t('Stripe: facturas sin cobro o ajenas a la plataforma no se registran', async () => {
  assert.equal((await stripeHook('invoice.paid', invoice({ id: 'in_free', amount_paid: 0 }))).statusCode, 200);
  fake.stripe.subs.sub_ajena = stripeSub({ id: 'sub_ajena', customer: 'cus_x', metadata: {} });
  assert.equal((await stripeHook('invoice.paid', invoice({ id: 'in_ajena', subscription: 'sub_ajena' }))).statusCode, 200);
  const n = (await pool.query(`SELECT count(*)::int AS n FROM billing_payments WHERE provider_payment_id IN ('in_free', 'in_ajena')`)).rows[0].n;
  assert.equal(n, 0);
});

t('Stripe: los reembolsos se acumulan y un aviso atrasado no los deshace', async () => {
  const refund = (amount: number) => stripeHook('charge.refunded', { id: 'ch_1', object: 'charge', invoice: 'in_1', currency: 'mxn', amount_refunded: amount });
  assert.equal((await refund(10000)).statusCode, 200);
  let p = (await payments(A.account))[0];
  assert.deepEqual([p.refunded_cents, p.status], [10000, 'partially_refunded']);
  assert.equal((await refund(5000)).statusCode, 200, 'aviso viejo, llegó tarde');
  p = (await payments(A.account))[0];
  assert.equal(p.refunded_cents, 10000);
  assert.equal((await refund(57884)).statusCode, 200);
  p = (await payments(A.account))[0];
  assert.deepEqual([p.refunded_cents, p.status], [57884, 'refunded']);
  // Un reembolso de un cargo que no es de una suscripción no falla.
  assert.equal((await stripeHook('charge.refunded', { id: 'ch_otro', currency: 'mxn', amount_refunded: 100 })).statusCode, 200);
});

t('Mercado Pago: el pago autorizado aprobado se registra; el rechazado no', async () => {
  const next = new Date(Date.now() + 30 * 86400_000).toISOString();
  fake.mp.preapprovals.pre_pay = { id: 'pre_pay', status: 'authorized', external_reference: `${M.account}:pro`, payer_id: 55, next_payment_date: next };
  fake.mp.payments.ap_bad = { id: 'ap_bad', preapproval_id: 'pre_pay', status: 'recycling', transaction_amount: 578.84, currency_id: 'MXN', payment: { id: 990, status: 'rejected' } };
  assert.equal((await mpHook('subscription_authorized_payment', 'ap_bad')).statusCode, 200);
  assert.equal((await payments(M.account)).length, 0);

  fake.mp.payments.ap_1 = { id: 'ap_1', preapproval_id: 'pre_pay', status: 'processed', transaction_amount: 578.84, currency_id: 'MXN', debit_date: new Date().toISOString(), payment: { id: 991, status: 'approved' } };
  assert.equal((await mpHook('subscription_authorized_payment', 'ap_1')).statusCode, 200);
  assert.equal((await mpHook('subscription_authorized_payment', 'ap_1')).statusCode, 200, 'aviso repetido');
  const rows = await payments(M.account);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].provider, rows[0].provider_payment_id, rows[0].provider_charge_ref, rows[0].total_cents, rows[0].subtotal_cents, rows[0].tax_cents], ['mercadopago', 'ap_1', '991', 57884, 49900, 7984]);
  assert.equal(new Date(rows[0].period_end).toISOString(), next, 'el periodo pagado llega hasta el siguiente cobro');
});

t('Mercado Pago: el reembolso llega como aviso del pago', async () => {
  fake.mp.charges['991'] = { id: 991, status: 'refunded', transaction_amount: 578.84, transaction_amount_refunded: 578.84 };
  assert.equal((await mpHook('payment', '991')).statusCode, 200);
  const p = (await payments(M.account))[0];
  assert.deepEqual([p.refunded_cents, p.status], [57884, 'refunded']);
});

t('al borrar la cuenta, sus pagos se conservan (contabilidad) sin la cuenta', async () => {
  const id = (await payments(M.account))[0].id;
  const r = await h.authed('DELETE', `/api/accounts/${M.account}`);
  assert.equal(r.statusCode, 200, r.body);
  const row = (await pool.query(`SELECT account_id, total_cents FROM billing_payments WHERE id = $1`, [id])).rows[0];
  assert.deepEqual([row.account_id, row.total_cents], [null, 57884]);
});
