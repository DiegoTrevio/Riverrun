/**
 * Cobro sin intervención: conciliación diaria (avisos perdidos), primer cobro de Mercado Pago, cancelación tras la pausa,
 * contracargos, pagos que el banco pide confirmar (3DS), acciones con reintento, pagar en la prueba y límites de uso.
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
const { cancelLongUnpaid, queueAction } = await import('../src/billing/service.js');
const { MAX_ACTION_ATTEMPTS, checkWebhookSilence, processBillingActions, reconcileSubscriptions } = await import('../src/billing/autopilot.js');

type Api = (method: string, url: string, payload?: unknown) => ReturnType<typeof h.app.inject>;
let ip = 0;
const DAY = 86400_000;
const periodEnd = new Date(Date.now() + 20 * DAY);
const nowSec = () => Math.floor(Date.now() / 1000);

async function signup(email: string, plan: string, provider: 'stripe' | 'mercadopago') {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.77.0.${++ip}`,
    payload: { name: 'Leo Paz', company: `Negocio ${ip}`, business_type: 'belleza', email, password: 'Pz-129-Qx-329-Kv', accept_terms: true, plan, provider },
  });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = await h.sessionFrom(r);
  const from = `10.77.0.${ip}`;
  const api: Api = (method, url, payload) => h.app.inject({ method: method as any, url, remoteAddress: from, payload: payload as any, headers: { cookie } });
  // El pago se abre desde Mi plan (ya no al registrarse), con el correo verificado.
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE lower(email) = lower($1)`, [email]);
  const co = await api('POST', '/api/billing/checkout', { plan, provider });
  assert.equal(co.statusCode, 200, co.body);
  return { api, accountId: r.json().account.id as string, checkout: co.json().url as string, email };
}

async function paidStripe(email: string, subId: string) {
  const a = await signup(email, 'pro', 'stripe');
  fake.stripe.subs[subId] = stripeSub({ id: subId, customer: `cus_${subId}`, metadata: { account_id: a.accountId, plan_key: 'pro' } });
  Object.assign(fake.stripe.sessions[a.checkout.split('/').pop()!], { status: 'complete', subscription: subId });
  assert.equal((await a.api('POST', '/api/billing/confirm')).json().confirmed, true);
  return a;
}

async function paidMp(email: string, preId: string, extra: Record<string, unknown> = {}) {
  fake.mp.nextId = preId;
  const a = await signup(email, 'pro', 'mercadopago');
  fake.mp.preapprovals[preId] = { id: preId, status: 'authorized', external_reference: `${a.accountId}:pro`, payer_id: 7, next_payment_date: periodEnd.toISOString(), date_created: new Date().toISOString(), ...extra };
  assert.equal((await a.api('POST', '/api/billing/confirm')).json().confirmed, true);
  return a;
}

/** Aviso de disputa: Stripe la relee, así que el estado que vale es el que tiene guardado. */
const disputeHook = (type: string, d: Record<string, any>) => {
  fake.stripe.disputes[d.id] = d;
  return stripeHook(type, d);
};
const subOf = async (id: string) => (await pool.query(`SELECT * FROM subscriptions WHERE account_id = $1`, [id])).rows[0];
const accOf = async (id: string) => (await pool.query(`SELECT status, pause_reason, plan FROM accounts WHERE id = $1`, [id])).rows[0];
const mails = (to: string) => outbox.filter((m) => m.to === to).map((m) => m.subject);
const superNotices = async (title: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.role = 'superadmin' AND n.title LIKE $1`, [`${title}%`])).rows[0].n;
const stripeHook = (type: string, obj: unknown) => {
  const e = stripeEvent(type, obj);
  return h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers });
};
const mpHook = (type: string, id: string) => {
  const e = mpEvent(type, id);
  return h.app.inject({ method: 'POST', url: e.url, payload: e.payload, headers: e.headers });
};
/** Concilia solo esta cuenta (las demás ya se revisaron hoy). */
async function reconcileOnly(accountId: string, now = new Date()) {
  await pool.query(`UPDATE subscriptions SET reconciled_at = $2 WHERE account_id <> $1`, [accountId, now]);
  await pool.query(`UPDATE subscriptions SET reconciled_at = NULL WHERE account_id = $1`, [accountId]);
  return reconcileSubscriptions(now);
}
const paymentsOf = async (id: string) => (await pool.query(`SELECT provider_payment_id, provider_charge_ref, total_cents, refunded_cents, dispute_status FROM billing_payments WHERE account_id = $1 ORDER BY paid_at`, [id])).rows;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499 })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

/* ------------------------------ Conciliación ------------------------------ */

t('conciliación: una renovación pagada cuyo aviso se perdió se registra una sola vez', async () => {
  const a = await paidStripe('ren@spa.mx', 'sub_ren');
  fake.stripe.invoices.push({ id: 'in_ren', subscription: 'sub_ren', status: 'paid', amount_paid: 57884, currency: 'mxn', charge: 'ch_ren', created: nowSec() });
  const r = await reconcileOnly(a.accountId);
  assert.equal(r.fixed, 1);
  assert.deepEqual((await paymentsOf(a.accountId)).map((p) => [p.provider_payment_id, p.total_cents]), [['in_ren', 57884]]);
  // Otra conciliación no lo repite.
  assert.equal((await reconcileOnly(a.accountId, new Date(Date.now() + DAY))).fixed, 0);
  assert.equal((await paymentsOf(a.accountId)).length, 1);
  // Un aviso que no llegó apunta a un webhook mal configurado: se avisa una vez por semana (la marca lo evita repetir).
  const marks = (await pool.query(`SELECT count(*)::int AS n FROM billing_events WHERE type = 'reconcile_fixed' AND provider = 'stripe'`)).rows[0].n;
  assert.equal(marks, 1);
});

t('conciliación: un cobro fallido o una cancelación cuyo aviso se perdió se reflejan, con su correo y su pausa', async () => {
  const f = await paidStripe('fal@spa.mx', 'sub_fal');
  fake.stripe.subs.sub_fal.status = 'past_due';
  outbox.length = 0;
  await reconcileOnly(f.accountId);
  assert.equal((await subOf(f.accountId)).status, 'past_due');
  assert.deepEqual(mails(f.email), ['No pudimos cobrar tu plan']);

  const c = await paidStripe('can@spa.mx', 'sub_can');
  Object.assign(fake.stripe.subs.sub_can, { status: 'canceled', current_period_end: nowSec() - 60 });
  await reconcileOnly(c.accountId);
  assert.equal((await subOf(c.accountId)).status, 'canceled');
  assert.equal((await accOf(c.accountId)).status, 'paused', 'el periodo pagado ya terminó');
});

t('conciliación: un pago que llegó sin aviso reactiva una cuenta en pausa', async () => {
  const a = await paidStripe('vuelve@spa.mx', 'sub_vuelve');
  await pool.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = now() - interval '7 days', access_ended_at = now() - interval '1 day' WHERE account_id = $1`, [a.accountId]);
  await pool.query(`UPDATE accounts SET status = 'paused', paused_at = now(), pause_reason = 'payment' WHERE id = $1`, [a.accountId]);
  fake.stripe.invoices.push({ id: 'in_vuelve', subscription: 'sub_vuelve', status: 'paid', amount_paid: 57884, currency: 'mxn', charge: 'ch_vuelve', created: nowSec() });
  outbox.length = 0;
  await reconcileOnly(a.accountId);
  assert.equal((await accOf(a.accountId)).status, 'active');
  assert.equal((await subOf(a.accountId)).status, 'active');
  assert.deepEqual(mails(a.email), ['Recibimos tu pago, ¡gracias!']);
  assert.equal((await paymentsOf(a.accountId)).length, 1);
});

t('conciliación (Mercado Pago): sigue "autorizada" con el último cobro rechazado → pago pendiente', async () => {
  const a = await paidMp('rej@cafe.mx', 'pre_rej');
  fake.mp.payments.ap_rej = { id: 'ap_rej', preapproval_id: 'pre_rej', status: 'rejected', payment: { id: 'p_rej', status: 'rejected' }, transaction_amount: 578.84, currency_id: 'MXN', date_created: new Date().toISOString() };
  outbox.length = 0;
  await reconcileOnly(a.accountId);
  assert.equal((await subOf(a.accountId)).status, 'past_due');
  assert.deepEqual(mails(a.email), ['No pudimos cobrar tu plan']);
});

t('conciliación (Mercado Pago): autorizada que nunca cobró pasa a pago pendiente solo después de 3 días', async () => {
  const a = await paidMp('nunca@cafe.mx', 'pre_nunca', { summarized: { charged_quantity: 0 }, date_created: new Date(Date.now() - DAY).toISOString() });
  await reconcileOnly(a.accountId);
  assert.equal((await subOf(a.accountId)).status, 'active', 'a 1 día todavía puede cobrar');
  fake.mp.preapprovals.pre_nunca.date_created = new Date(Date.now() - 4 * DAY).toISOString();
  await reconcileOnly(a.accountId, new Date(Date.now() + DAY));
  assert.equal((await subOf(a.accountId)).status, 'past_due');
});

t('conciliación (Mercado Pago): con su cobro aprobado sigue al corriente y el cobro queda registrado', async () => {
  const a = await paidMp('bien@cafe.mx', 'pre_bien', { summarized: { charged_quantity: 1 } });
  fake.mp.payments.ap_bien = { id: 'ap_bien', preapproval_id: 'pre_bien', status: 'processed', payment: { id: 'p_bien', status: 'approved' }, transaction_amount: 578.84, currency_id: 'MXN', date_created: new Date().toISOString(), debit_date: new Date().toISOString() };
  await reconcileOnly(a.accountId);
  assert.equal((await subOf(a.accountId)).status, 'active');
  assert.deepEqual((await paymentsOf(a.accountId)).map((p) => [p.provider_payment_id, p.provider_charge_ref]), [['ap_bien', 'p_bien']]);
});

t('conciliación: una suscripción que ya no existe en el proveedor se avisa una sola vez', async () => {
  const a = await paidStripe('fantasma@spa.mx', 'sub_real');
  await pool.query(`UPDATE subscriptions SET provider_subscription_id = 'sub_fantasma' WHERE account_id = $1`, [a.accountId]);
  const r = await reconcileOnly(a.accountId);
  assert.equal(r.failed, 1);
  assert.equal(await superNotices('Suscripción que no existe en el proveedor'), 1);
  await reconcileOnly(a.accountId, new Date(Date.now() + DAY));
  assert.equal(await superNotices('Suscripción que no existe en el proveedor'), 1);
  assert.equal((await subOf(a.accountId)).status, 'active', 'no se cambia sola');
});

/* ------------------------------ Cancelación tras la pausa ------------------------------ */

t('a los 30 días en pausa sin pago la suscripción se cancela en el proveedor (no antes) y se avisa', async () => {
  const a = await paidStripe('largo@spa.mx', 'sub_largo');
  const pause = async (days: number) => {
    await pool.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = now() - make_interval(days => $2 + 5), access_ended_at = now() - make_interval(days => $2) WHERE account_id = $1`, [a.accountId, days]);
    await pool.query(`UPDATE accounts SET status = 'paused', paused_at = now() - make_interval(days => $2), pause_reason = 'payment' WHERE id = $1`, [a.accountId, days]);
  };
  await pause(29);
  assert.equal(await cancelLongUnpaid(), 0);
  await pause(31);
  outbox.length = 0;
  assert.equal(await cancelLongUnpaid(), 1);
  assert.equal((await subOf(a.accountId)).status, 'canceled');
  assert.deepEqual(mails(a.email), ['Cancelamos tu suscripción']);
  assert.equal(await cancelLongUnpaid(), 0, 'una sola vez');
  await processBillingActions(new Date(Date.now() + 1000)); // el reloj de PostgreSQL puede ir unos ms adelante
  assert.equal(fake.stripe.subs.sub_largo.status, 'canceled');
  // Ya sin suscripción que cobre, la cuenta entra al plazo de retención.
  const candidate = (await pool.query(`SELECT 1 FROM accounts a WHERE a.id = $1 AND a.status = 'paused' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id AND s.status IN ('active', 'past_due'))`, [a.accountId])).rowCount;
  assert.equal(candidate, 1);
});

/* ------------------------------ Contracargos ------------------------------ */

async function paidInvoice(a: { accountId: string }, subId: string, invoice: string, charge: string) {
  const r = await stripeHook('invoice.paid', { id: invoice, subscription: subId, status: 'paid', amount_paid: 57884, currency: 'mxn', charge, created: nowSec() });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await paymentsOf(a.accountId)).at(-1).provider_charge_ref, charge);
}

t('contracargo abierto pausa la cuenta y avisa con el enlace; ganado la reactiva (y una renovación no la reactiva antes)', async () => {
  const a = await paidStripe('disputa@spa.mx', 'sub_disp');
  await paidInvoice(a, 'sub_disp', 'in_disp', 'ch_disp');
  outbox.length = 0;
  assert.equal((await disputeHook('charge.dispute.created', { id: 'dp_1', charge: 'ch_disp', amount: 57884, currency: 'mxn', status: 'needs_response' })).statusCode, 200);
  assert.deepEqual(await accOf(a.accountId), { status: 'paused', pause_reason: 'dispute', plan: 'pro' });
  assert.equal((await paymentsOf(a.accountId)).at(-1).dispute_status, 'open');
  assert.deepEqual(mails(a.email), ['Tu asistente está en pausa']);
  const notice = (await pool.query(`SELECT body FROM notifications WHERE title LIKE 'Contracargo:%' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.match(notice.body, /dashboard\.stripe\.com\/disputes\/dp_1/);
  // El aviso repetido no repite nada.
  assert.equal((await disputeHook('charge.dispute.created', { id: 'dp_1', charge: 'ch_disp', amount: 57884, currency: 'mxn', status: 'needs_response' })).statusCode, 200);
  assert.deepEqual(mails(a.email), ['Tu asistente está en pausa']);

  // Una renovación que falla y luego se cobra no levanta la pausa de la disputa.
  await pool.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = now() WHERE account_id = $1`, [a.accountId]);
  assert.equal((await stripeHook('customer.subscription.updated', fake.stripe.subs.sub_disp)).statusCode, 200);
  assert.equal((await accOf(a.accountId)).status, 'paused');

  assert.equal((await disputeHook('charge.dispute.closed', { id: 'dp_1', charge: 'ch_disp', amount: 57884, currency: 'mxn', status: 'won' })).statusCode, 200);
  assert.equal((await accOf(a.accountId)).status, 'active');
  assert.equal((await paymentsOf(a.accountId)).at(-1).dispute_status, 'won');
  assert.ok(mails(a.email).includes('Tu asistente volvió a responder'));
});

t('contracargo perdido: cuenta como reembolso, la suscripción se cancela y la cuenta sigue en pausa', async () => {
  const a = await paidStripe('perdida@spa.mx', 'sub_perd');
  await paidInvoice(a, 'sub_perd', 'in_perd', 'ch_perd');
  await disputeHook('charge.dispute.created', { id: 'dp_2', charge: 'ch_perd', amount: 57884, currency: 'mxn', status: 'needs_response' });
  assert.equal((await disputeHook('charge.dispute.closed', { id: 'dp_2', charge: 'ch_perd', amount: 57884, currency: 'mxn', status: 'lost' })).statusCode, 200);
  const p = (await paymentsOf(a.accountId)).at(-1);
  assert.deepEqual([p.dispute_status, p.refunded_cents], ['lost', 57884]);
  assert.equal((await subOf(a.accountId)).status, 'canceled');
  assert.equal((await accOf(a.accountId)).status, 'paused');
  await processBillingActions(new Date(Date.now() + 1000)); // el reloj de PostgreSQL puede ir unos ms adelante
  assert.equal(fake.stripe.subs.sub_perd.status, 'canceled');
  assert.equal(await superNotices('Contracargo perdido'), 1);
});

t('contracargo de Mercado Pago (pago "charged_back") también pausa la cuenta', async () => {
  const a = await paidMp('cb@cafe.mx', 'pre_cb');
  fake.mp.payments.ap_cb = { id: 'ap_cb', preapproval_id: 'pre_cb', status: 'processed', payment: { id: 'p_cb', status: 'approved' }, transaction_amount: 578.84, currency_id: 'MXN', date_created: new Date().toISOString() };
  assert.equal((await mpHook('subscription_authorized_payment', 'ap_cb')).statusCode, 200);
  fake.mp.charges.p_cb = { id: 'p_cb', status: 'charged_back', status_detail: 'in_process', transaction_amount: 578.84 };
  assert.equal((await mpHook('payment', 'p_cb')).statusCode, 200);
  assert.deepEqual(await accOf(a.accountId), { status: 'paused', pause_reason: 'dispute', plan: 'pro' });
  assert.equal((await paymentsOf(a.accountId)).at(-1).dispute_status, 'open');
});

t('disputa abierta: se detienen los cobros; ganada: se reanudan; un aviso viejo que llega tarde no la reabre (PAY-4)', async () => {
  const a = await paidStripe('detiene@spa.mx', 'sub_det');
  await paidInvoice(a, 'sub_det', 'in_det', 'ch_det');
  const open = { id: 'dp_det', charge: 'ch_det', amount: 57884, currency: 'mxn', status: 'needs_response' };
  const notices = await superNotices('Contracargo: ');
  assert.equal((await disputeHook('charge.dispute.created', open)).statusCode, 200);
  assert.deepEqual(fake.stripe.subs.sub_det.pause_collection, { behavior: 'void' }, 'Stripe deja de cobrar');
  assert.equal((await subOf(a.accountId)).collection_paused, true);
  // Los fondos se retiran: el aviso relee la disputa y no repite nada.
  assert.equal((await disputeHook('charge.dispute.funds_withdrawn', open)).statusCode, 200);
  assert.equal(await superNotices('Contracargo: '), notices + 1);
  assert.equal((await disputeHook('charge.dispute.closed', { ...open, status: 'won' })).statusCode, 200);
  assert.equal(fake.stripe.subs.sub_det.pause_collection, null, 'se reanudan los cobros');
  assert.equal((await subOf(a.accountId)).collection_paused, false);
  assert.equal((await accOf(a.accountId)).status, 'active');
  // El aviso de apertura llega tarde (su cuerpo dice abierta), pero Stripe dice ganada: no se reabre.
  assert.equal((await stripeHook('charge.dispute.created', open)).statusCode, 200);
  assert.equal((await accOf(a.accountId)).status, 'active');
  assert.equal((await paymentsOf(a.accountId)).at(-1).dispute_status, 'won');
  assert.equal(fake.stripe.subs.sub_det.pause_collection, null);
});

t('disputa perdida: la cuenta solo se reactiva con otra tarjeta; con la misma, se cancela y se reembolsa (PAY-5)', async () => {
  const a = await paidStripe('otra@spa.mx', 'sub_otra');
  fake.stripe.subs.sub_otra.default_payment_method = { id: 'pm_otra', card: { fingerprint: 'fp_disputada' } };
  await paidInvoice(a, 'sub_otra', 'in_otra', 'ch_otra');
  await disputeHook('charge.dispute.created', { id: 'dp_otra', charge: 'ch_otra', amount: 57884, currency: 'mxn', status: 'needs_response' });
  await disputeHook('charge.dispute.closed', { id: 'dp_otra', charge: 'ch_otra', amount: 57884, currency: 'mxn', status: 'lost' });
  assert.deepEqual(await accOf(a.accountId), { status: 'paused', pause_reason: 'dispute_lost', plan: 'pro' });
  const { cardClaim } = await import('../src/billing/trial-claims.js');
  assert.equal((await cardClaim('fp_disputada')).disputed, true, 'la tarjeta queda marcada');
  // Vuelve a contratar con la misma tarjeta: no se reactiva; esa suscripción se cancela y se reembolsa.
  fake.stripe.subs.sub_misma = stripeSub({ id: 'sub_misma', customer: 'cus_otra', metadata: { account_id: a.accountId, plan_key: 'pro' }, default_payment_method: { id: 'pm_m', card: { fingerprint: 'fp_disputada' } } });
  assert.equal((await stripeHook('customer.subscription.created', fake.stripe.subs.sub_misma)).statusCode, 200);
  assert.equal((await accOf(a.accountId)).status, 'paused');
  const acts = (await pool.query(`SELECT kind FROM billing_actions WHERE ref = 'sub_misma' ORDER BY kind`)).rows.map((r) => r.kind);
  assert.deepEqual(acts, ['cancel', 'refund_subscription']);
  assert.ok(mails(a.email).includes('Usa otra tarjeta'));
  // Con otra tarjeta, sí.
  fake.stripe.subs.sub_nueva = stripeSub({ id: 'sub_nueva', customer: 'cus_otra', metadata: { account_id: a.accountId, plan_key: 'pro' }, default_payment_method: { id: 'pm_n', card: { fingerprint: 'fp_limpia' } } });
  assert.equal((await stripeHook('customer.subscription.created', fake.stripe.subs.sub_nueva)).statusCode, 200);
  assert.deepEqual(await accOf(a.accountId), { status: 'active', pause_reason: '', plan: 'pro' });
});

t('alerta temprana de fraude: se reembolsa el cobro, se cancela la suscripción y la cuenta queda en pausa (PAY-5)', async () => {
  const a = await paidStripe('fraude@spa.mx', 'sub_efw');
  await paidInvoice(a, 'sub_efw', 'in_efw', 'ch_efw');
  fake.stripe.fraudWarnings.issfr_1 = { id: 'issfr_1', charge: 'ch_efw', actionable: true };
  assert.equal((await stripeHook('radar.early_fraud_warning.created', { id: 'issfr_1' })).statusCode, 200);
  assert.deepEqual(await accOf(a.accountId), { status: 'paused', pause_reason: 'dispute_lost', plan: 'pro' });
  assert.equal((await subOf(a.accountId)).status, 'canceled');
  assert.equal((await paymentsOf(a.accountId)).at(-1).refunded_cents, 57884);
  await processBillingActions(new Date(Date.now() + 1000));
  assert.ok(fake.stripe.refunds.some((r) => r.charge === 'ch_efw'), 'el cobro se reembolsó en Stripe');
  assert.equal(fake.stripe.subs.sub_efw.status, 'canceled');
  assert.equal(await superNotices('Alerta de fraude'), 1);
});

t('Mercado Pago: el contracargo (tema chargebacks) pausa los cobros; la suscripción en pausa no se toma como pago pendiente (PAY-4)', async () => {
  const a = await paidMp('cbmp@cafe.mx', 'pre_cbmp');
  fake.mp.payments.ap_cbmp = { id: 'ap_cbmp', preapproval_id: 'pre_cbmp', status: 'processed', payment: { id: 'p_cbmp', status: 'approved' }, transaction_amount: 578.84, currency_id: 'MXN', date_created: new Date().toISOString() };
  assert.equal((await mpHook('subscription_authorized_payment', 'ap_cbmp')).statusCode, 200);
  fake.mp.charges.p_cbmp = { id: 'p_cbmp', status: 'charged_back', status_detail: 'in_process', transaction_amount: 578.84 };
  fake.mp.chargebacks.cb_9 = { id: 'cb_9', payments: ['p_cbmp'] };
  assert.equal((await mpHook('chargebacks', 'cb_9')).statusCode, 200);
  assert.deepEqual(await accOf(a.accountId), { status: 'paused', pause_reason: 'dispute', plan: 'pro' });
  assert.equal(fake.mp.preapprovals.pre_cbmp.status, 'paused');
  assert.equal((await mpHook('subscription_preapproval', 'pre_cbmp')).statusCode, 200);
  assert.equal((await subOf(a.accountId)).status, 'active', 'pausada por nosotros, no por falta de pago');
  fake.mp.charges.p_cbmp.status_detail = 'reimbursed';
  assert.equal((await mpHook('chargebacks', 'cb_9')).statusCode, 200);
  assert.equal(fake.mp.preapprovals.pre_cbmp.status, 'authorized');
  assert.equal((await accOf(a.accountId)).status, 'active');
});

/* ------------------------------ 3DS ------------------------------ */

t('el banco pide confirmar el cobro (3DS): correo y franja con el enlace en lugar de "actualiza tu tarjeta"; al pagar se quita', async () => {
  const a = await paidStripe('tres@spa.mx', 'sub_3ds');
  fake.stripe.subs.sub_3ds.status = 'past_due';
  outbox.length = 0;
  const url = 'https://invoice.stripe.test/i/3ds';
  assert.equal((await stripeHook('invoice.payment_action_required', { id: 'in_3ds', subscription: 'sub_3ds', hosted_invoice_url: url })).statusCode, 200);
  assert.deepEqual(mails(a.email), ['Confirma tu pago con tu banco']);
  assert.ok(outbox.find((m) => m.subject === 'Confirma tu pago con tu banco')!.text.includes(url));
  assert.equal((await a.api('GET', '/api/me')).json().account.payment_due.action_url, url);
  // El aviso de la suscripción vencida que llega después no manda otro correo.
  await stripeHook('customer.subscription.updated', fake.stripe.subs.sub_3ds);
  assert.deepEqual(mails(a.email), ['Confirma tu pago con tu banco']);

  fake.stripe.subs.sub_3ds.status = 'active';
  await stripeHook('customer.subscription.updated', fake.stripe.subs.sub_3ds);
  assert.equal((await subOf(a.accountId)).payment_action_url, '');
  assert.equal((await a.api('GET', '/api/me')).json().account.payment_due, null);
});

/* ------------------------------ Acciones con reintento ------------------------------ */

t('una cancelación que el proveedor rechaza se reintenta con espera creciente y, agotada, se pide hacerla a mano', async () => {
  fake.stripe.subs.sub_terca = stripeSub({ id: 'sub_terca' });
  await queueAction({ provider: 'stripe', kind: 'cancel', ref: 'sub_terca', accountId: null, reason: 'replaced' });
  fake.stripe.refundFail = true;
  try {
    // queueAction fecha la acción con el reloj de PostgreSQL, que en CI puede ir unos ms adelante del de Node.
    let now = Date.now() + 1000;
    await processBillingActions(new Date(now));
    const first = (await pool.query(`SELECT attempts, status, next_attempt_at FROM billing_actions WHERE ref = 'sub_terca'`)).rows[0];
    assert.deepEqual([first.attempts, first.status], [1, 'pending']);
    assert.ok(first.next_attempt_at.getTime() >= now + 4 * 60_000, 'espera antes del siguiente intento');
    assert.equal(await processBillingActions(new Date(now + 60_000)), 0, 'no reintenta antes de tiempo');
    assert.equal((await pool.query(`SELECT attempts FROM billing_actions WHERE ref = 'sub_terca'`)).rows[0].attempts, 1);
    for (let i = 2; i <= MAX_ACTION_ATTEMPTS; i++) {
      now += 2 * DAY;
      await processBillingActions(new Date(now));
    }
    const last = (await pool.query(`SELECT attempts, status, last_error FROM billing_actions WHERE ref = 'sub_terca'`)).rows[0];
    assert.deepEqual([last.attempts, last.status], [MAX_ACTION_ATTEMPTS, 'failed']);
    assert.match(last.last_error, /Error interno/);
  } finally {
    fake.stripe.refundFail = false;
  }
  assert.equal(fake.stripe.subs.sub_terca.status, 'active');
});

/* ------------------------------ Pagar durante la prueba ------------------------------ */

t('pagar durante la prueba no la acorta: el primer cobro es al terminarla (con menos de 2 días, se cobra ya)', async () => {
  const a = await signup('prueba@spa.mx', 'pro', 'stripe');
  // Una cuenta en prueba de las de antes (sin tarjeta) que paga durante su prueba.
  await pool.query(`UPDATE accounts SET status = 'trial', trial_ends_at = now() + interval '10 days' WHERE id = $1`, [a.accountId]);
  const expire = () => pool.query(`UPDATE card_checks SET opened_at = opened_at - interval '31 minutes' WHERE account_id = $1`, [a.accountId]);
  await expire(); // la página del alta ya venció: se abre otra
  const ends = (await pool.query(`SELECT trial_ends_at FROM accounts WHERE id = $1`, [a.accountId])).rows[0].trial_ends_at as Date;
  assert.equal((await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).statusCode, 200);
  const session = fake.stripe.requests.filter((x) => x.method === 'POST' && x.path === '/v1/checkout/sessions').at(-1)!.body;
  assert.equal(session.get('subscription_data[trial_end]'), String(Math.floor(ends.getTime() / 1000)));

  assert.equal((await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'mercadopago' })).statusCode, 200);
  const pre = fake.mp.requests.filter((x) => x.method === 'POST' && x.path === '/preapproval').at(-1)!.body;
  assert.equal(new Date(pre.auto_recurring.start_date).getTime(), ends.getTime());

  await pool.query(`UPDATE accounts SET trial_ends_at = now() + interval '1 day' WHERE id = $1`, [a.accountId]);
  await expire();
  assert.equal((await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).statusCode, 200);
  const late = fake.stripe.requests.filter((x) => x.method === 'POST' && x.path === '/v1/checkout/sessions').at(-1)!.body;
  assert.equal(late.get('subscription_data[trial_end]'), null);
});

/* ------------------------------ Límites de uso ------------------------------ */

t('las rutas de cobro tienen límite por cuenta (429)', async () => {
  const a = await signup('ansioso@spa.mx', 'pro', 'stripe');
  const codes: number[] = [];
  // Páginas de pago: 5 por día por cuenta (el alta ya abrió una). Cada una vence a los 30 minutos.
  for (let i = 0; i < 5; i++) {
    await pool.query(`UPDATE card_checks SET opened_at = opened_at - interval '31 minutes' WHERE account_id = $1`, [a.accountId]);
    codes.push((await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).statusCode);
  }
  assert.deepEqual(codes.slice(0, 4), Array(4).fill(200));
  assert.equal(codes[4], 429);
});

/* ------------------------------ Avisos que no llegan ------------------------------ */

t('si un proveedor con suscripciones no manda ningún aviso en más de un ciclo, se avisa una vez por semana', async () => {
  await paidStripe('silencio@spa.mx', 'sub_silencio');
  await pool.query(`UPDATE subscriptions SET created_at = now() - interval '40 days' WHERE provider = 'stripe'`);
  await pool.query(`UPDATE billing_events SET received_at = now() - interval '20 days' WHERE provider = 'stripe'`);
  assert.deepEqual(await checkWebhookSilence(), [], '20 días sin avisos es normal con planes mensuales');
  await pool.query(`UPDATE billing_events SET received_at = now() - interval '36 days' WHERE provider = 'stripe'`);
  assert.deepEqual(await checkWebhookSilence(), ['stripe']);
  assert.deepEqual(await checkWebhookSilence(), [], 'una vez por semana');
  // Con un aviso reciente, aunque ya sea otra semana, no se avisa.
  await stripeHook('customer.subscription.updated', fake.stripe.subs.sub_silencio);
  assert.deepEqual(await checkWebhookSilence(new Date(Date.now() + 8 * DAY)), []);
});

t('contracargo ganado con el plan sin pagar: sigue en pausa por falta de pago y se reactiva sola al pagar', async () => {
  const a = await paidStripe('gana@spa.mx', 'sub_gana');
  await paidInvoice(a, 'sub_gana', 'in_gana', 'ch_gana');
  await disputeHook('charge.dispute.created', { id: 'dp_3', charge: 'ch_gana', amount: 57884, currency: 'mxn', status: 'needs_response' });
  fake.stripe.subs.sub_gana.status = 'past_due';
  await stripeHook('customer.subscription.updated', fake.stripe.subs.sub_gana);
  await disputeHook('charge.dispute.closed', { id: 'dp_3', charge: 'ch_gana', amount: 57884, currency: 'mxn', status: 'won' });
  assert.deepEqual(await accOf(a.accountId), { status: 'paused', pause_reason: 'payment', plan: 'pro' });
  fake.stripe.subs.sub_gana.status = 'active';
  await stripeHook('customer.subscription.updated', fake.stripe.subs.sub_gana);
  assert.equal((await accOf(a.accountId)).status, 'active');
});
