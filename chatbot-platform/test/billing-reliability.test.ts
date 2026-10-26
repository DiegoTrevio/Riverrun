/**
 * Cobros a prueba de fallas (auditoría, PR 2): nada queda a medias si el proceso muere entre dos pasos.
 * - Pausar por falta de pago y cancelar tras la pausa son una sola sentencia (P1, P2).
 * - Un aviso del proveedor solo se da por procesado al terminar; si quedó a medias, el reintento lo retoma (P4).
 * - El candado de `applyState` es por cuenta; la factura de un pago ya registrado no se pierde; las facturas se reservan
 *   de una en una; la global recupera los meses que se saltaron; un reembolso que llega antes que su cobro se reintenta.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake, stripeEvent, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { applyState, cancelLongUnpaid, claimEvent, enforceAccess, EVENT_CLAIM_MINUTES, finishEvent, releaseEvent } = await import('../src/billing/service.js');
const { recordMoney } = await import('../src/billing/ledger.js');
const { checkGlobalInvoice, invoicer, mexicoMonth, processCfdi } = await import('../src/billing/cfdi.js');
const { checkStuckEvents } = await import('../src/billing/autopilot.js');
const { config } = await import('../src/config.js');
const { dateStr } = await import('../src/dates.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const DAY = 86400_000;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
let ip = 0;

type Api = (m: string, u: string, p?: unknown) => ReturnType<typeof h.app.inject>;
async function signup(email: string) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.85.0.${++ip}`,
    payload: { name: 'Dueña', company: `Negocio ${email}`, business_type: 'servicios', email, password: 'clave-segura-1', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const api: Api = (method, url, payload) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { account: r.json().user.account_id as string, api, email };
}

/** Suscripción de Stripe de la cuenta, en el estado que se pida. */
async function subscribe(account: string, sub: string, over: Record<string, unknown> = {}) {
  fake.stripe.subs[sub] = stripeSub({ id: sub, customer: `cus_${sub}`, metadata: { account_id: account, plan_key: 'pro' } });
  const cols = { status: 'active', past_due_since: null, access_ended_at: null, ...over };
  await pool.query(
    `INSERT INTO subscriptions (account_id, provider, provider_customer_id, provider_subscription_id, plan_key, status, past_due_since, access_ended_at, current_period_end)
     VALUES ($1, 'stripe', $2, $3, 'pro', $4, $5, $6, now() + interval '20 days')
     ON CONFLICT (account_id) DO UPDATE SET provider_subscription_id = $3, status = $4, past_due_since = $5, access_ended_at = $6`,
    [account, `cus_${sub}`, sub, cols.status, cols.past_due_since, cols.access_ended_at],
  );
}
const subOf = async (id: string) => (await pool.query(`SELECT * FROM subscriptions WHERE account_id = $1`, [id])).rows[0];
const accOf = async (id: string) => (await pool.query(`SELECT status, pause_reason FROM accounts WHERE id = $1`, [id])).rows[0];
const stripeHook = (type: string, obj: unknown, id?: string) => {
  const e = stripeEvent(type, obj, id);
  return h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers });
};
const invoicePaid = (id: string, sub: string, paidAt = new Date()) => ({
  id, object: 'invoice', status: 'paid', subscription: sub, customer: `cus_${sub}`, amount_paid: 57884, currency: 'mxn', charge: `ch_${id}`,
  status_transitions: { paid_at: unix(paidAt) }, lines: { data: [{ period: { start: unix(paidAt), end: unix(new Date(paidAt.getTime() + 30 * DAY)) } }] },
});

/** Falla a propósito: un trigger que lanza un error al escribir en la tabla cuando la fila cumple `cond`. */
async function breakTable(table: string, cond: string) {
  await pool.query(`CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falla simulada'; END $$`);
  await pool.query(`CREATE TRIGGER test_boom BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${cond}) EXECUTE FUNCTION test_boom()`);
  return () => pool.query(`DROP TRIGGER test_boom ON ${table}`);
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499 })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('P1: si pausar la cuenta falla, la caída no queda anotada y la siguiente revisión la pausa', async () => {
  const a = await signup('p1@cobro.mx');
  await subscribe(a.account, 'sub_p1', { status: 'past_due', past_due_since: new Date(Date.now() - 30 * DAY) });
  await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [a.account]);
  const fix = await breakTable('accounts', `NEW.status = 'paused' AND NEW.id = '${a.account}'`);
  await assert.rejects(enforceAccess());
  await fix();
  assert.equal((await subOf(a.account)).access_ended_at, null, 'sin pausar la cuenta, la caída no se anota');
  assert.equal((await accOf(a.account)).status, 'active');
  await enforceAccess();
  assert.ok((await subOf(a.account)).access_ended_at);
  assert.deepEqual(await accOf(a.account), { status: 'paused', pause_reason: 'payment' });
});

t('P2: si no se puede encolar la cancelación en el proveedor, la suscripción no queda cancelada aquí', async () => {
  const a = await signup('p2@cobro.mx');
  const long = new Date(Date.now() - (config.billing.cancelAfterPauseDays + 1) * DAY);
  await subscribe(a.account, 'sub_p2', { status: 'past_due', past_due_since: long, access_ended_at: long });
  await pool.query(`UPDATE accounts SET status = 'paused', pause_reason = 'payment' WHERE id = $1`, [a.account]);
  const fix = await breakTable('billing_actions', `NEW.ref = 'sub_p2'`);
  await assert.rejects(cancelLongUnpaid());
  await fix();
  assert.equal((await subOf(a.account)).status, 'past_due', 'sin la cancelación encolada, sigue como estaba');
  assert.equal(await cancelLongUnpaid(), 1);
  assert.equal((await subOf(a.account)).status, 'canceled');
  const [action] = (await pool.query(`SELECT kind, reason, status FROM billing_actions WHERE ref = 'sub_p2'`)).rows;
  assert.deepEqual(action, { kind: 'cancel', reason: 'unpaid', status: 'pending' });
});

t('P4: un aviso que quedó a medias (el proceso murió) se procesa en el reintento; uno en curso pide reintentar', async () => {
  const a = await signup('p4@cobro.mx');
  await subscribe(a.account, 'sub_p4');
  const evt = 'evt_p4_muerto';
  // El proceso anterior reservó el aviso y murió antes de terminar.
  await pool.query(`INSERT INTO billing_events (provider, event_id, type, claimed_at, claim_token, processed_at) VALUES ('stripe', $1, 'invoice.paid', now() - make_interval(mins => $2), gen_random_uuid(), NULL)`, [evt, EVENT_CLAIM_MINUTES + 1]);
  assert.equal((await stripeHook('invoice.paid', invoicePaid('in_p4', 'sub_p4'), evt)).statusCode, 200);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM billing_payments WHERE provider_payment_id = 'in_p4'`)).rows[0].n, 1, 'el cobro quedó registrado');
  const [row] = (await pool.query(`SELECT processed_at, claimed_at, account_id FROM billing_events WHERE event_id = $1`, [evt])).rows;
  assert.ok(row.processed_at);
  assert.equal(row.claimed_at, null);
  assert.equal(row.account_id, a.account);
  // Repetido: no se vuelve a procesar.
  assert.equal((await stripeHook('invoice.paid', invoicePaid('in_p4', 'sub_p4'), evt)).statusCode, 200);

  // Otro proceso lo está atendiendo ahora mismo: el proveedor debe reintentar después.
  await pool.query(`INSERT INTO billing_events (provider, event_id, type, claimed_at, claim_token, processed_at) VALUES ('stripe', 'evt_p4_ocupado', 'invoice.paid', now(), gen_random_uuid(), NULL)`);
  assert.equal((await stripeHook('invoice.paid', invoicePaid('in_p4b', 'sub_p4'), 'evt_p4_ocupado')).statusCode, 503);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM billing_payments WHERE provider_payment_id = 'in_p4b'`)).rows[0].n, 0);
});

t('P4: un aviso que falla se libera, y el reintento del proveedor lo procesa', async () => {
  const a = await signup('p4b@cobro.mx');
  await subscribe(a.account, 'sub_p4b');
  const fix = await breakTable('billing_payments', `NEW.provider_payment_id = 'in_p4c'`);
  assert.equal((await stripeHook('invoice.paid', invoicePaid('in_p4c', 'sub_p4b'), 'evt_p4_falla')).statusCode, 500);
  await fix();
  const [row] = (await pool.query(`SELECT processed_at, claimed_at FROM billing_events WHERE event_id = 'evt_p4_falla'`)).rows;
  assert.deepEqual(row, { processed_at: null, claimed_at: null });
  assert.equal((await stripeHook('invoice.paid', invoicePaid('in_p4c', 'sub_p4b'), 'evt_p4_falla')).statusCode, 200);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM billing_payments WHERE provider_payment_id = 'in_p4c'`)).rows[0].n, 1);
});

t('P4: solo quien tiene la reserva la cierra o la libera (otro proceso pudo retomarla), y lo de una réplica vieja cuenta como hecho', async () => {
  const first = await claimEvent('stripe', 'evt_dueno', 'invoice.paid');
  assert.equal(first.status, 'claimed');
  // El primero tardó demasiado y otro proceso lo retomó.
  await pool.query(`UPDATE billing_events SET claimed_at = now() - make_interval(mins => $1) WHERE event_id = 'evt_dueno'`, [EVENT_CLAIM_MINUTES + 1]);
  const second = await claimEvent('stripe', 'evt_dueno', 'invoice.paid');
  assert.equal(second.status, 'claimed');
  if (first.status !== 'claimed' || second.status !== 'claimed') return;
  await releaseEvent('stripe', 'evt_dueno', first.token);
  assert.equal((await claimEvent('stripe', 'evt_dueno', 'invoice.paid')).status, 'busy', 'el primero no libera la reserva del segundo');
  await finishEvent('stripe', 'evt_dueno', first.token, null);
  assert.equal((await pool.query(`SELECT processed_at FROM billing_events WHERE event_id = 'evt_dueno'`)).rows[0].processed_at, null, 'ni la cierra');
  await finishEvent('stripe', 'evt_dueno', second.token, null);
  assert.equal((await claimEvent('stripe', 'evt_dueno', 'invoice.paid')).status, 'done');
  // Durante el despliegue, una réplica con el código anterior inserta sin processed_at: no queda como atorado.
  await pool.query(`INSERT INTO billing_events (provider, event_id, type) VALUES ('stripe', 'evt_viejo', 'invoice.paid')`);
  assert.equal((await claimEvent('stripe', 'evt_viejo', 'invoice.paid')).status, 'done');
});

t('P4: un aviso sin procesar de más de un día se avisa al superadmin, una sola vez', async () => {
  await pool.query(`INSERT INTO billing_events (provider, event_id, type, received_at, processed_at) VALUES ('stripe', 'evt_atorado', 'charge.refunded', now() - interval '2 days', NULL)`);
  assert.equal(await checkStuckEvents(), 1);
  assert.equal(await checkStuckEvents(), 0, 'una sola vez');
  // La marca es interna y ya procesada: no cuenta como otro aviso atorado.
  assert.equal((await pool.query(`SELECT processed_at IS NOT NULL AS done FROM billing_events WHERE event_id = 'stuck:evt_atorado'`)).rows[0].done, true);
});

t('applyState: el candado es por cuenta (otra cuenta no espera) y los avisos no se duplican', async () => {
  const a = await signup('candado-a@cobro.mx');
  const b = await signup('candado-b@cobro.mx');
  await subscribe(a.account, 'sub_lock_a', { status: 'past_due', past_due_since: new Date() });
  await subscribe(b.account, 'sub_lock_b', { status: 'past_due', past_due_since: new Date() });
  const state = (accountId: string, sub: string) => ({ provider: 'stripe' as const, accountId, customerId: `cus_${sub}`, subscriptionId: sub, planKey: 'pro', status: 'active' as const, periodEnd: new Date(Date.now() + 30 * DAY), cancelAtPeriodEnd: false });
  const paidNotices = async (id: string) => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND title = 'Recibimos tu pago, ¡gracias!'`, [id])).rows[0].n;
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtext('billing-apply:' || $1))`, [a.account]);
    let aDone = false;
    const pa = applyState(state(a.account, 'sub_lock_a')).then(() => { aDone = true; });
    // B no depende del candado de A.
    const tb = await Promise.race([applyState(state(b.account, 'sub_lock_b')).then(() => 'ok'), new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
    assert.equal(tb, 'ok', 'otra cuenta no espera');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(aDone, false, 'la misma cuenta sí espera');
    await holder.query('COMMIT');
    await pa;
  } finally {
    holder.release();
  }
  assert.equal(await paidNotices(a.account), 1);
  // Dos avisos de la misma cuenta a la vez: un solo «Recibimos tu pago».
  await subscribe(a.account, 'sub_lock_a', { status: 'past_due', past_due_since: new Date() });
  await Promise.all([applyState(state(a.account, 'sub_lock_a')), applyState(state(a.account, 'sub_lock_a'))]);
  assert.equal(await paidNotices(a.account), 2, 'uno más, no dos');
});

/** Datos fiscales completos (empresa de prueba del SAT): sus pagos llevan factura propia. */
const wantsInvoice = (account: string) => pool.query(
  `INSERT INTO account_fiscal (account_id, wants_invoice, rfc, legal_name, tax_regime, zip, cfdi_use) VALUES ($1, true, 'EKU9003173C9', 'ESCUELA KEMPER URGATE', '601', '42501', 'G03')`,
  [account],
);
const paymentInfo = (id: string, sub: string, paidAt = new Date()) =>
  ({ paymentId: id, chargeRef: `ch_${id}`, subscriptionId: sub, totalCents: 57884, currency: 'MXN', paidAt, periodStart: null, periodEnd: null });

t('CFDI: un pago ya registrado cuya factura no se preparó la recibe en el reintento', async () => {
  const a = await signup('cfdi-reintento@cobro.mx');
  await subscribe(a.account, 'sub_cfdi_r');
  await wantsInvoice(a.account);
  const payment = paymentInfo('in_cfdi_r', 'sub_cfdi_r');
  // El proceso registró el cobro y falló al preparar su factura.
  const fix = await breakTable('cfdi_invoices', `NEW.kind = 'payment' AND NEW.account_id = '${a.account}'`);
  await assert.rejects(recordMoney('stripe', { payment, state: null }, a.account));
  await fix();
  const cfdis = async () => (await pool.query(`SELECT count(*)::int AS n FROM cfdi_invoices WHERE account_id = $1 AND kind = 'payment'`, [a.account])).rows[0].n;
  assert.equal(await cfdis(), 0);
  assert.equal(await recordMoney('stripe', { payment, state: null }, a.account), false, 'el cobro ya estaba');
  assert.equal(await cfdis(), 1, 'pero su factura quedó lista');
  await recordMoney('stripe', { payment, state: null }, a.account);
  assert.equal(await cfdis(), 1, 'sin duplicarse');
});

t('CFDI: se reservan de una en una (la reserva no vence a medio lote)', async () => {
  await pool.query(`UPDATE cfdi_invoices SET status = 'void' WHERE status = 'pending'`);
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const a = await signup(`cfdi-lote${n}@cobro.mx`);
    await subscribe(a.account, `sub_lote${n}`);
    await wantsInvoice(a.account);
    await recordMoney('stripe', { payment: paymentInfo(`in_lote${n}`, `sub_lote${n}`), state: null }, a.account);
    ids.push((await pool.query(`SELECT id FROM cfdi_invoices WHERE account_id = $1`, [a.account])).rows[0].id);
  }
  const seen: number[] = [];
  const orig = invoicer.findByExternal;
  invoicer.findByExternal = async (id: string) => {
    const other = ids.find((x) => x !== id)!;
    seen.push((await pool.query(`SELECT attempts FROM cfdi_invoices WHERE id = $1`, [other])).rows[0].attempts);
    return orig.call(invoicer, id);
  };
  try {
    assert.equal(await processCfdi(), 2);
  } finally {
    invoicer.findByExternal = orig;
  }
  assert.equal(seen[0], 0, 'mientras se emite la primera, la segunda no está reservada');
});

t('CFDI: la global recupera los meses que se saltaron, no solo el anterior', async () => {
  const a = await signup('global@cobro.mx');
  await subscribe(a.account, 'sub_global');
  const now = new Date();
  const monthsAgo = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15, 18));
  // El de hace dos meses se saltó (no se armó su global a tiempo); el anterior, normal.
  for (const n of [1, 2]) await recordMoney('stripe', { payment: paymentInfo(`in_global${n}`, 'sub_global', monthsAgo(n)), state: null }, a.account);
  await checkGlobalInvoice(now);
  const want = [mexicoMonth(monthsAgo(2)), mexicoMonth(monthsAgo(1))];
  const periods = (await pool.query(`SELECT global_period FROM cfdi_invoices WHERE kind = 'global' AND global_period = ANY($1) ORDER BY 1`, [want])).rows.map((r) => r.global_period);
  assert.deepEqual(periods, want);
  const pending = (await pool.query(`SELECT count(*)::int AS n FROM billing_payments WHERE provider_payment_id IN ('in_global1', 'in_global2') AND global_cfdi_id IS NULL`)).rows[0].n;
  assert.equal(pending, 0);
});

t('un reembolso que llega antes que su cobro se reintenta, y se aplica cuando el cobro ya está', async () => {
  const a = await signup('reembolso@cobro.mx');
  await subscribe(a.account, 'sub_ref');
  const refund = { id: 'ch_in_ref', object: 'charge', invoice: 'in_ref', currency: 'mxn', amount_refunded: 57884 };
  assert.equal((await stripeHook('charge.refunded', refund, 'evt_ref')).statusCode, 500, 'el proveedor debe reintentar');
  assert.equal((await stripeHook('invoice.paid', invoicePaid('in_ref', 'sub_ref'), 'evt_ref_pago')).statusCode, 200);
  assert.equal((await stripeHook('charge.refunded', refund, 'evt_ref')).statusCode, 200);
  const [p] = (await pool.query(`SELECT refunded_cents, status FROM billing_payments WHERE provider_payment_id = 'in_ref'`)).rows;
  assert.deepEqual(p, { refunded_cents: 57884, status: 'refunded' });
  // Un reembolso cuyo cobro nunca llega: pasadas unas horas se deja de pedir reintentos (el proveedor no da el webhook por roto).
  await pool.query(`INSERT INTO billing_events (provider, event_id, type, received_at, processed_at) VALUES ('stripe', 'evt_ref_huerfano', 'charge.refunded', now() - interval '7 hours', NULL)`);
  assert.equal((await stripeHook('charge.refunded', { id: 'ch_in_nunca', object: 'charge', invoice: 'in_nunca', currency: 'mxn', amount_refunded: 100 }, 'evt_ref_huerfano')).statusCode, 200);
  assert.ok((await pool.query(`SELECT processed_at FROM billing_events WHERE event_id = 'evt_ref_huerfano'`)).rows[0].processed_at);
  // Un cargo sin factura no es de una suscripción de la plataforma: no se reintenta.
  assert.equal((await stripeHook('charge.refunded', { id: 'ch_ajeno', object: 'charge', currency: 'mxn', amount_refunded: 100 })).statusCode, 200);
});

t('fechas que no existen: 400 en lugar de un error de la base', async () => {
  assert.equal(dateStr().safeParse('2026-02-31').success, false);
  assert.equal(dateStr().safeParse('2026-02-28').success, true);
  assert.equal(dateStr().safeParse('2028-02-29').success, true);
  const a = await signup('fechas@cobro.mx');
  assert.equal((await a.api('GET', '/api/export/conversations.csv?from=2026-02-31')).statusCode, 400);
  assert.equal((await a.api('GET', '/api/export/conversations.csv?from=2026-02-28')).statusCode, 200);
});
