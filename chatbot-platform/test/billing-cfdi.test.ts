/** Facturas (CFDI) con Facturapi: una por pago con factura, la global del mes, notas de crédito, reintentos y descargas. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake, mpEvent, stripeEvent, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { checkGlobalInvoice, mexicoMonth, processCfdi } = await import('../src/billing/cfdi.js');
const { config } = await import('../src/config.js');
const { outbox } = await import('../src/mailer.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

type Api = (m: string, u: string, p?: unknown) => Promise<any>;
const F = { account: '', api: null as unknown as Api, email: 'ema@factura.mx' };
const P = { account: '', api: null as unknown as Api, email: 'pepe@publico.mx' };
const Q = { account: '', api: null as unknown as Api, email: 'quique@publico.mx' };
const S = { account: '', api: null as unknown as Api, email: 'sara@cambia.mx' };
/** Empresa de prueba del SAT. */
const MORAL = { wants_invoice: true, rfc: 'EKU9003173C9', legal_name: 'Escuela Kemper Urgate', tax_regime: '601', zip: '42501', cfdi_use: 'G03', invoice_email: '' };
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const later = (min: number) => new Date(Date.now() + min * 60_000);
const post = (url: string, e: { payload: string; headers: Record<string, string> }) => h.app.inject({ method: 'POST', url, payload: e.payload, headers: e.headers });
const stripeHook = (type: string, obj: unknown) => post('/webhook/billing/stripe', stripeEvent(type, obj));
const posted = () => fake.facturapi.requests.filter((r) => r.method === 'POST' && r.path === '/v2/invoices');
const rowsOf = async (where: string, args: unknown[] = []) => (await pool.query(`SELECT * FROM cfdi_invoices WHERE ${where} ORDER BY created_at`, args)).rows;
const paymentId = async (providerId: string) => (await pool.query(`SELECT id FROM billing_payments WHERE provider_payment_id = $1`, [providerId])).rows[0].id;

async function signup(o: typeof F, ip: string) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: ip,
    payload: { name: 'Dueña', company: `Negocio ${o.email}`, business_type: 'servicios', email: o.email, password: 'Pz-144-Qx-344-Kv', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = await h.sessionFrom(r);
  o.account = r.json().user.account_id;
  o.api = (method, url, payload) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
}

/** Factura pagada de Stripe para la suscripción `sub`. */
const paid = (id: string, sub: string, amount = 57884) => {
  const now = new Date();
  return stripeHook('invoice.paid', {
    id, object: 'invoice', status: 'paid', subscription: sub, customer: `cus_${sub}`, amount_paid: amount, currency: 'mxn', charge: `ch_${id}`,
    status_transitions: { paid_at: unix(now) }, lines: { data: [{ period: { start: unix(now), end: unix(later(30 * 1440)) } }] },
  });
};
const refund = (id: string, amount: number) => stripeHook('charge.refunded', { id: `ch_${id}`, object: 'charge', invoice: id, currency: 'mxn', amount_refunded: amount });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499 })).statusCode, 200);
  await signup(F, '10.8.8.1');
  await signup(P, '10.8.8.2');
  await signup(Q, '10.8.8.3');
  await signup(S, '10.8.8.4');
  assert.equal((await F.api('PUT', '/api/billing/fiscal', MORAL)).statusCode, 200);
  for (const [o, sub] of [[F, 'sub_f'], [P, 'sub_p'], [S, 'sub_s']] as const) fake.stripe.subs[sub] = stripeSub({ id: sub, customer: `cus_${sub}`, metadata: { account_id: o.account, plan_key: 'pro' } });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('con factura: un CFDI por pago con el total cobrado, y llega por correo con su PDF y XML', async () => {
  assert.equal((await paid('in_f1', 'sub_f')).statusCode, 200);
  // Stripe repite avisos: sigue siendo un solo CFDI.
  assert.equal((await paid('in_f1', 'sub_f')).statusCode, 200);
  const [row] = await rowsOf(`account_id = $1`, [F.account]);
  assert.deepEqual([row.kind, row.status, row.receiver.rfc, row.receiver.email], ['payment', 'pending', 'EKU9003173C9', F.email]);
  outbox.length = 0;
  assert.equal(await processCfdi(), 1);
  assert.equal(await processCfdi(), 0, 'no se vuelve a emitir');
  assert.equal(posted().length, 1);
  const body = posted()[0].body;
  assert.equal(body.external_id, row.id);
  assert.deepEqual([body.type, body.payment_form, body.payment_method, body.use], ['I', '04', 'PUE', 'G03']);
  assert.deepEqual(body.customer, { legal_name: 'ESCUELA KEMPER URGATE', tax_id: 'EKU9003173C9', tax_system: '601', email: F.email, address: { zip: '42501' } });
  assert.equal(body.items.length, 1);
  const product = body.items[0].product;
  assert.deepEqual([product.price, product.tax_included, product.product_key, product.unit_key], [578.84, true, '81112106', 'E48']);
  assert.deepEqual(product.taxes, [{ type: 'IVA', rate: 0.16 }]);
  assert.match(product.description, /^Suscripción Pro del /);

  const issued = (await rowsOf(`id = $1`, [row.id]))[0];
  assert.deepEqual([issued.status, issued.sat_uuid, issued.amount_cents], ['issued', 'UUID-1', 57884]);
  assert.equal((await pool.query(`SELECT invoiced_cents FROM billing_payments WHERE provider_payment_id = 'in_f1'`)).rows[0].invoiced_cents, 57884);
  const mail = outbox.find((m) => m.to === F.email && m.subject === 'Tu factura');
  assert.ok(mail, 'manda la factura al dueño (no capturó correo de facturas)');
  assert.deepEqual(mail.attachments!.map((a) => [a.filename, a.content.toString()]), [['A1.pdf', '%PDF-fac_1'], ['A1.xml', '<cfdi:Comprobante Folio="fac_1"/>']]);

  const b = (await F.api('GET', '/api/billing')).json();
  assert.equal(b.invoicing, true);
  assert.deepEqual(b.payments[0].cfdi, { status: 'issued', id: row.id, error: '', credits: [] });
});

t('descargas: solo el administrador de la cuenta (o el superadmin)', async () => {
  const [row] = await rowsOf(`account_id = $1 AND kind = 'payment'`, [F.account]);
  const pdf = await F.api('GET', `/api/billing/invoices/${row.id}/pdf`);
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.body, '%PDF-fac_1');
  assert.match(String(pdf.headers['content-disposition']), /attachment; filename="A1\.pdf"/);
  assert.equal((await F.api('GET', `/api/billing/invoices/${row.id}/xml`)).headers['content-type'], 'application/xml');
  assert.equal((await P.api('GET', `/api/billing/invoices/${row.id}/pdf`)).statusCode, 404, 'otra cuenta no sabe que existe');
  assert.equal((await F.api('GET', `/api/billing/invoices/${row.id}/zip`)).statusCode, 404);
  assert.equal((await h.authed('GET', `/api/billing/invoices/${row.id}/pdf`)).statusCode, 200);
  await h.addUser({ account_id: F.account, name: 'Iker', email: 'iker@factura.mx', password: 'Pz-126-Qx-326-Kv', role: 'agent' });
  const agent = await h.loginAs('iker@factura.mx', 'Pz-126-Qx-326-Kv');
  assert.equal((await agent('GET', `/api/billing/invoices/${row.id}/pdf`)).statusCode, 403);
});

t('si se pierde la respuesta del PAC, el reintento encuentra el CFDI y no timbra dos veces', async () => {
  assert.equal((await paid('in_f2', 'sub_f')).statusCode, 200);
  const before = fake.facturapi.invoices.length;
  fake.facturapi.drop = true;
  await processCfdi();
  fake.facturapi.drop = false;
  let [row] = await rowsOf(`payment_id = $1`, [await paymentId('in_f2')]);
  assert.equal(row.status, 'pending');
  assert.equal(fake.facturapi.invoices.length, before + 1, 'el PAC sí lo timbró');
  assert.equal(await processCfdi(), 0, 'espera antes de reintentar');
  await processCfdi(later(6));
  [row] = await rowsOf(`id = $1`, [row.id]);
  assert.equal(row.status, 'issued');
  assert.equal(fake.facturapi.invoices.length, before + 1, 'no hay un segundo CFDI');
  assert.equal(row.provider_invoice_id, fake.facturapi.invoices.at(-1).id);
});

t('el PAC no responde: reintentos con espera y, al agotarlos, aviso al superadmin', async () => {
  const saved = [config.billing.cfdi.maxAttempts, config.signup.superadminEmail] as const;
  Object.assign(config.billing.cfdi, { maxAttempts: 2 });
  Object.assign(config.signup, { superadminEmail: 'dueno@plataforma.mx' });
  try {
    assert.equal((await paid('in_f3', 'sub_f')).statusCode, 200);
    fake.facturapi.fail5xx = true;
    await processCfdi();
    let [row] = await rowsOf(`payment_id = $1`, [await paymentId('in_f3')]);
    assert.deepEqual([row.status, row.attempts], ['pending', 1]);
    assert.ok(row.next_attempt_at > later(4) && row.next_attempt_at < later(6), 'primer reintento en 5 minutos');
    await processCfdi(later(6));
    [row] = await rowsOf(`id = $1`, [row.id]);
    assert.deepEqual([row.status, row.attempts, row.data_error], ['failed', 2, false]);
    assert.match(row.last_error, /Servicio no disponible/);
    assert.ok(outbox.some((m) => m.to === 'dueno@plataforma.mx' && m.subject === 'CFDI sin emitir'));
  } finally {
    fake.facturapi.fail5xx = false;
    Object.assign(config.billing.cfdi, { maxAttempts: saved[0] });
    Object.assign(config.signup, { superadminEmail: saved[1] });
  }
});

t('el SAT rechaza los datos: se avisa al cliente y, al corregirlos, se emite', async () => {
  assert.equal((await paid('in_f4', 'sub_f')).statusCode, 200);
  fake.facturapi.reject = 'El código postal del receptor no corresponde con el RFC';
  outbox.length = 0;
  await processCfdi();
  fake.facturapi.reject = '';
  let [row] = await rowsOf(`payment_id = $1`, [await paymentId('in_f4')]);
  assert.deepEqual([row.status, row.data_error, row.attempts], ['failed', true, 1]);
  const mail = outbox.find((m) => m.to === F.email && m.subject === 'No pudimos emitir tu factura');
  assert.match(mail!.text, /El código postal del receptor no corresponde con el RFC/);
  const b = (await F.api('GET', '/api/billing')).json();
  assert.match(b.payments.find((p: any) => p.cfdi.id === row.id).cfdi.error, /código postal/);
  assert.equal(await processCfdi(later(60 * 24)), 0, 'no se insiste con los mismos datos');

  assert.equal((await F.api('PUT', '/api/billing/fiscal', { ...MORAL, zip: '42502', invoice_email: 'facturas@kemper.mx' })).statusCode, 200);
  [row] = await rowsOf(`id = $1`, [row.id]);
  assert.deepEqual([row.status, row.receiver.zip, row.receiver.email], ['pending', '42502', 'facturas@kemper.mx']);
  await processCfdi();
  [row] = await rowsOf(`id = $1`, [row.id]);
  assert.equal(row.status, 'issued');
  assert.equal(posted().at(-1)!.body.customer.address.zip, '42502');
});

t('reembolsos: nota de crédito por lo que falta acreditar, sin repetirse', async () => {
  const origin = (await rowsOf(`payment_id = $1 AND kind = 'payment'`, [await paymentId('in_f1')]))[0];
  assert.equal((await refund('in_f1', 10000)).statusCode, 200);
  await processCfdi();
  assert.equal((await refund('in_f1', 10000)).statusCode, 200, 'aviso repetido');
  await processCfdi();
  let credits = await rowsOf(`kind = 'credit' AND related_id = $1`, [origin.id]);
  assert.deepEqual(credits.map((c) => [c.status, c.amount_cents]), [['issued', 10000]]);
  const body = posted().at(-1)!.body;
  assert.deepEqual([body.type, body.use, body.payment_form, body.payment_method], ['E', 'G02', '04', undefined]);
  assert.deepEqual(body.related_documents, [{ relationship: '01', documents: [origin.sat_uuid] }]);
  assert.equal(body.items[0].product.price, 100);

  assert.equal((await refund('in_f1', 57884)).statusCode, 200);
  await processCfdi();
  credits = await rowsOf(`kind = 'credit' AND related_id = $1`, [origin.id]);
  assert.deepEqual(credits.map((c) => [c.status, c.amount_cents]), [['issued', 10000], ['issued', 47884]]);
  assert.ok(outbox.some((m) => m.subject === 'Tu nota de crédito'));
  const b = (await F.api('GET', '/api/billing')).json();
  assert.deepEqual(b.payments.find((p: any) => p.cfdi.id === origin.id).cfdi.credits.map((c: any) => c.amount), [100, 478.84]);
});

t('un pago reembolsado completo antes de facturarse ya no se factura', async () => {
  assert.equal((await paid('in_f5', 'sub_f')).statusCode, 200);
  assert.equal((await refund('in_f5', 57884)).statusCode, 200);
  const n = posted().length;
  await processCfdi();
  const [row] = await rowsOf(`payment_id = $1`, [await paymentId('in_f5')]);
  assert.equal(row.status, 'void');
  assert.equal(posted().length, n);
});

t('pedir factura a mitad de mes: los pagos del mes reciben la suya y no entran a la global', async () => {
  assert.equal((await paid('in_s1', 'sub_s')).statusCode, 200);
  assert.equal((await rowsOf(`account_id = $1`, [S.account])).length, 0, 'sin factura no se crea CFDI propio');
  assert.equal((await S.api('GET', '/api/billing')).json().payments[0].cfdi.status, 'none');
  assert.equal((await S.api('PUT', '/api/billing/fiscal', { ...MORAL, rfc: 'CACX7605101P8', legal_name: 'Xochitl Casas Chavez', tax_regime: '612' })).statusCode, 200);
  const [row] = await rowsOf(`account_id = $1`, [S.account]);
  assert.equal(row.kind, 'payment');
  await processCfdi();
  assert.equal((await rowsOf(`id = $1`, [row.id]))[0].status, 'issued');
  assert.equal(posted().at(-1)!.body.customer.tax_system, '612');
});

t('global del mes: una por forma de pago con los pagos sin factura, una sola vez', async () => {
  assert.equal((await paid('in_p1', 'sub_p', 23084)).statusCode, 200);
  assert.equal((await paid('in_p2', 'sub_p')).statusCode, 200);
  const next = new Date(Date.now() + 40 * 86400_000);
  fake.mp.preapprovals.pre_q = { id: 'pre_q', status: 'authorized', external_reference: `${Q.account}:pro`, payer_id: 77, next_payment_date: next.toISOString() };
  fake.mp.payments.ap_q1 = { id: 'ap_q1', preapproval_id: 'pre_q', status: 'processed', transaction_amount: 578.84, currency_id: 'MXN', debit_date: new Date().toISOString(), payment: { id: 881, status: 'approved' } };
  const e = mpEvent('subscription_authorized_payment', 'ap_q1');
  assert.equal((await post(e.url, e)).statusCode, 200);

  // Primer día del mes siguiente (hora de México).
  const [y, m] = mexicoMonth(new Date()).split('-').map(Number);
  const nextMonth = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 18));
  assert.equal(await checkGlobalInvoice(new Date()), 0, 'el mes en curso todavía no cierra');
  assert.equal(await checkGlobalInvoice(nextMonth), 2);
  assert.equal(await checkGlobalInvoice(nextMonth), 0, 'una sola vez');
  const globals = await rowsOf(`kind = 'global'`);
  assert.deepEqual(globals.map((g) => [g.payment_form, g.global_period]).sort(), [['04', mexicoMonth(new Date())], ['31', mexicoMonth(new Date())]]);
  const inGlobal = (await pool.query(`SELECT provider_payment_id FROM billing_payments WHERE global_cfdi_id IS NOT NULL ORDER BY 1`)).rows.map((r) => r.provider_payment_id);
  assert.deepEqual(inGlobal, ['ap_q1', 'in_p1', 'in_p2'], 'sin los pagos con factura propia');

  await processCfdi();
  const stripeGlobal = posted().find((r) => r.body.global && r.body.payment_form === '04')!.body;
  assert.deepEqual(stripeGlobal.customer, { legal_name: 'PUBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '64000' } });
  assert.deepEqual([stripeGlobal.use, stripeGlobal.payment_method], ['S01', 'PUE']);
  assert.deepEqual(stripeGlobal.global, { periodicity: 'month', months: String(m).padStart(2, '0'), year: y });
  assert.deepEqual(stripeGlobal.items.map((i: any) => i.product.price).sort(), [230.84, 578.84]);
  assert.equal(posted().find((r) => r.body.global && r.body.payment_form === '31')!.body.items.length, 1);
  assert.deepEqual((await rowsOf(`kind = 'global'`)).map((g) => g.status), ['issued', 'issued']);

  const b = (await P.api('GET', '/api/billing')).json();
  assert.deepEqual(b.payments.map((p: any) => p.cfdi.status), ['global', 'global']);
  const g = globals.find((x) => x.payment_form === '04');
  assert.equal((await P.api('GET', `/api/billing/invoices/${g.id}/pdf`)).statusCode, 404, 'la global solo la ve el superadmin');
  assert.equal((await h.authed('GET', `/api/billing/invoices/${g.id}/pdf`)).statusCode, 200);

  // Reembolso de un pago que ya está en la global: nota de crédito a público en general.
  assert.equal((await refund('in_p1', 5000)).statusCode, 200);
  await processCfdi();
  const credit = posted().at(-1)!.body;
  assert.deepEqual([credit.type, credit.customer.tax_id, credit.use, credit.payment_form], ['E', 'XAXX010101000', 'S01', '04']);
  assert.equal(credit.items[0].product.price, 50);

  const ov = (await h.authed('GET', '/api/billing/overview')).json();
  assert.equal(ov.invoicing.enabled, true);
  assert.ok(ov.invoicing.counts.some((c: any) => c.kind === 'global' && c.status === 'issued' && c.n === 2));
});

t('un pago que llega después de emitida la global de su mes entra en otra global del mismo mes, una sola vez (PAY-22)', async () => {
  const [y, m] = mexicoMonth(new Date()).split('-').map(Number);
  const nextMonth = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 18));
  // La global de este mes (Stripe, 04) ya se emitió en la prueba anterior; el reintento del aviso trae otro pago del mes.
  assert.equal((await paid('in_p3', 'sub_p')).statusCode, 200);
  assert.equal(await checkGlobalInvoice(nextMonth), 1);
  assert.equal(await checkGlobalInvoice(nextMonth), 0, 'una sola vez');
  const late = (await pool.query(`SELECT c.global_period, c.payment_form, c.seq FROM billing_payments p JOIN cfdi_invoices c ON c.id = p.global_cfdi_id WHERE p.provider_payment_id = 'in_p3'`)).rows[0];
  assert.deepEqual([late.global_period, late.payment_form, late.seq], [mexicoMonth(new Date()), '04', 2]);
  await processCfdi();
  assert.equal((await rowsOf(`kind = 'global' AND seq = 2`))[0].status, 'issued');
});

t('un pago de hace más de 3 meses sin CFDI avisa una vez al día (PAY-22)', async () => {
  await pool.query(`UPDATE billing_payments SET global_cfdi_id = NULL, paid_at = now() - interval '4 months' WHERE provider_payment_id = 'in_p3'`);
  const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE message LIKE 'Pagos sin CFDI:%'`)).rows[0].n;
  const before = await count();
  await checkGlobalInvoice(new Date());
  await checkGlobalInvoice(new Date());
  assert.equal(await count(), before + 1);
});

t('sin Facturapi (o con clave de producción en sandbox) no se llama al PAC y los CFDI esperan', async () => {
  assert.equal((await paid('in_f6', 'sub_f')).statusCode, 200);
  const n = fake.facturapi.requests.length;
  const key = config.billing.cfdi.apiKey;
  try {
    Object.assign(config.billing.cfdi, { apiKey: '' });
    assert.equal(await processCfdi(), 0);
    Object.assign(config.billing.cfdi, { apiKey: 'sk_live_real' });
    Object.assign(config.outbound, { mode: 'sandbox' });
    assert.equal(await processCfdi(), 0);
  } finally {
    Object.assign(config.billing.cfdi, { apiKey: key });
    Object.assign(config.outbound, { mode: 'live' });
  }
  assert.equal(fake.facturapi.requests.length, n);
  const [row] = await rowsOf(`payment_id = $1`, [await paymentId('in_f6')]);
  assert.equal(row.status, 'pending');
  await processCfdi();
  assert.equal((await rowsOf(`id = $1`, [row.id]))[0].status, 'issued');
});

t('borrar la cuenta conserva sus CFDI (son contabilidad)', async () => {
  const n = (await rowsOf(`account_id = $1`, [F.account])).length;
  assert.ok(n > 3);
  assert.equal((await h.authed('DELETE', `/api/accounts/${F.account}`)).statusCode, 200);
  assert.equal((await rowsOf(`account_id IS NULL AND receiver->>'rfc' = 'EKU9003173C9'`)).length, n);
});
