/**
 * La prueba gratis empieza cuando el proveedor confirma la tarjeta (con el fin de prueba que dice el proveedor), una
 * sola vez aunque el aviso llegue repetido, y deja sus marcas. Una tarjeta que ya tuvo prueba no da otra: en Stripe la
 * prueba termina al momento (se cobra); en Mercado Pago se cancela esa suscripción. Una prueba con tarjeta no se pausa
 * por vencida mientras su suscripción siga viva: el proveedor hace el primer cobro.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake, mpEvent, stripeEvent, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
const { mpCardKey, recordTrialClaims } = await import('../src/billing/trial-claims.js');
const { checkTrials } = await import('../src/lifecycle.js');
let h: Awaited<ReturnType<typeof createHarness>>;

let n = 0;
async function waiting(email: string) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.64.0.${++n}`,
    payload: { name: 'Tere', company: `Negocio ${n}`, business_type: 'otro', email, password: 'Pz-181-Qx-381-Kv', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = $1`, [email]);
  const cookie = await h.sessionFrom(r);
  const own = `10.64.1.${n}`;
  const api = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, remoteAddress: own, payload: payload as any, headers: { cookie } });
  return { api, accountId: r.json().account.id as string, email };
}
const accountOf = async (id: string) => (await pool.query(`SELECT status, pause_reason, trial_ends_at FROM accounts WHERE id = $1`, [id])).rows[0];
const claimsOf = async (id: string) => (await pool.query(`SELECT kind FROM trial_claims WHERE account_id = $1 ORDER BY kind`, [id])).rows.map((r) => r.kind);
const mails = (to: string, subject: RegExp) => outbox.filter((m) => m.to === to && subject.test(m.subject)).length;
const trialEnd = () => Math.floor(Date.now() / 1000) + 14 * 86400;
const lastMp = () => fake.mp.requests.filter((x) => x.method === 'POST' && x.path === '/preapproval').at(-1)!.body;
const post = (e: { url: string; payload: string; headers: Record<string, string> }) => h.app.inject({ method: 'POST', url: e.url, payload: e.payload, headers: e.headers });
/** Lo que pasa en Stripe al confirmar la tarjeta: la sesión se completa con una suscripción en prueba. */
function cardOnStripe(session: string, accountId: string, subId: string, fingerprint: string, end = trialEnd()) {
  fake.stripe.subs[subId] = stripeSub({ id: subId, customer: `cus_${subId}`, status: 'trialing', trial_end: end, default_payment_method: { id: `pm_${subId}`, card: { fingerprint } }, metadata: { account_id: accountId, plan_key: 'pro' } });
  Object.assign(fake.stripe.sessions[session], { status: 'complete', subscription: subId });
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499, currency: 'MXN' })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('Stripe: al confirmar la tarjeta empieza la prueba con el fin que dice Stripe, deja sus marcas y avisa una vez (Review Focus 1)', async () => {
  const a = await waiting('nueva@prueba.mx');
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  assert.equal(co.json().trial, true, co.body);
  const end = trialEnd();
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_nueva', 'fp_nueva', end);
  // «Ya pagué» antes que el aviso, y luego el aviso dos veces.
  assert.equal((await a.api('POST', '/api/billing/confirm')).json().confirmed, true);
  for (const id of ['evt_t1', 'evt_t2']) {
    const e = stripeEvent('checkout.session.completed', { client_reference_id: a.accountId, subscription: 'sub_nueva', customer: 'cus_sub_nueva' }, id);
    assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers })).statusCode, 200);
  }
  const acc = await accountOf(a.accountId);
  assert.equal(acc.status, 'trial');
  assert.equal(acc.pause_reason, '');
  assert.equal(new Date(acc.trial_ends_at).getTime(), end * 1000, 'el fin de prueba es el de Stripe');
  assert.deepEqual(await claimsOf(a.accountId), ['card', 'email']);
  assert.ok((await pool.query(`SELECT completed_at FROM card_checks WHERE account_id = $1`, [a.accountId])).rows[0].completed_at, 'la verificación quedó completa');
  assert.equal(mails('nueva@prueba.mx', /Tu prueba gratis empezó/), 1);
  assert.equal(mails('nueva@prueba.mx', /plan está activo/), 0, 'todavía no se cobra');
});

t('Stripe: una tarjeta que ya tuvo prueba termina la prueba al momento y se cobra', async () => {
  const old = await waiting('vieja@prueba.mx');
  await recordTrialClaims({ accountId: old.accountId, email: 'vieja@prueba.mx', cardKey: 'fp_usada', provider: 'stripe' });
  const a = await waiting('otra@prueba.mx');
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  assert.equal(co.json().trial, true, 'el correo es nuevo: se ofrece la prueba');
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_usada', 'fp_usada');
  await a.api('POST', '/api/billing/confirm');
  const end = fake.stripe.requests.filter((x) => x.method === 'POST' && x.path === '/v1/subscriptions/sub_usada').at(-1)?.body;
  assert.equal(end?.get('trial_end'), 'now', 'la prueba termina ya');
  assert.notEqual((await accountOf(a.accountId)).status, 'trial');
  assert.equal(mails('otra@prueba.mx', /Esta tarjeta ya tuvo una prueba gratis/), 1);
  // Stripe cobra y avisa: la cuenta queda activa.
  const e = stripeEvent('customer.subscription.updated', fake.stripe.subs.sub_usada);
  assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers })).statusCode, 200);
  assert.equal((await accountOf(a.accountId)).status, 'active');
  assert.equal((await pool.query(`SELECT paused_at FROM accounts WHERE id = $1`, [a.accountId])).rows[0].paused_at, null, 'activa ya no cuenta como pausada (revisión final I2)');
});

t('Mercado Pago: autorizada con el primer cobro a futuro empieza la prueba; con una tarjeta repetida se cancela', async () => {
  const a = await waiting('mp@prueba.mx');
  await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'mercadopago' });
  const start = new Date(Date.now() + 14 * 86400_000);
  fake.mp.cards.card_mp = { first_six_digits: '450995', last_four_digits: '3704', expiration_month: 11, expiration_year: 2030 };
  await pool.query(`UPDATE subscriptions SET checkout_ref = 'pre_mp_t' WHERE account_id = $1`, [a.accountId]);
  fake.mp.preapprovals.pre_mp_t = { id: 'pre_mp_t', status: 'authorized', external_reference: `${a.accountId}:pro`, payer_id: 31, card_id: 'card_mp', auto_recurring: { start_date: start.toISOString() }, next_payment_date: start.toISOString() };
  const post = (e: { url: string; payload: string; headers: Record<string, string> }) => h.app.inject({ method: 'POST', url: e.url, payload: e.payload, headers: e.headers });
  assert.equal((await post(mpEvent('subscription_preapproval', 'pre_mp_t'))).statusCode, 200);
  const acc = await accountOf(a.accountId);
  assert.equal(acc.status, 'trial');
  assert.equal(new Date(acc.trial_ends_at).getTime(), start.getTime());
  assert.deepEqual(await claimsOf(a.accountId), ['card', 'email']);

  const b = await waiting('mp2@prueba.mx');
  await b.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'mercadopago' });
  await pool.query(`UPDATE subscriptions SET checkout_ref = 'pre_mp_r' WHERE account_id = $1`, [b.accountId]);
  fake.mp.preapprovals.pre_mp_r = { id: 'pre_mp_r', status: 'authorized', external_reference: `${b.accountId}:pro`, payer_id: 32, card_id: 'card_mp', auto_recurring: { start_date: start.toISOString() }, next_payment_date: start.toISOString() };
  assert.equal((await post(mpEvent('subscription_preapproval', 'pre_mp_r'))).statusCode, 200);
  assert.equal(fake.mp.preapprovals.pre_mp_r.status, 'cancelled', 'la suscripción con la tarjeta repetida se cancela');
  const bb = await accountOf(b.accountId);
  assert.deepEqual([bb.status, bb.pause_reason], ['paused', 'card'], 'sigue esperando otra tarjeta');
  assert.equal(mails('mp2@prueba.mx', /Esta tarjeta ya tuvo una prueba gratis/), 1);
});

t('una prueba con tarjeta vencida no se pausa mientras su suscripción siga viva; sin suscripción, sí (Review Focus 3)', async () => {
  const a = await waiting('vence@prueba.mx');
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_vence', 'fp_vence');
  await a.api('POST', '/api/billing/confirm');
  await pool.query(`UPDATE accounts SET trial_ends_at = now() - interval '1 hour' WHERE id = $1`, [a.accountId]);
  await checkTrials();
  assert.equal((await accountOf(a.accountId)).status, 'trial', 'el proveedor hace el primer cobro');

  const sinTarjeta = await waiting('sinsub@prueba.mx');
  await pool.query(`UPDATE accounts SET status = 'trial', trial_ends_at = now() - interval '1 hour' WHERE id = $1`, [sinTarjeta.accountId]);
  await checkTrials();
  assert.equal((await accountOf(sinTarjeta.accountId)).status, 'paused');
});

t('una cuenta con prueba vieja (sin tarjeta) pasa a activa al pagar, como hoy', async () => {
  const a = await waiting('vieja-prueba@prueba.mx');
  await pool.query(`UPDATE accounts SET status = 'trial', pause_reason = '', trial_ends_at = now() + interval '10 days' WHERE id = $1`, [a.accountId]);
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  assert.equal(co.json().trial, false, 'la prueba ya la tiene: no se dan más días');
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_vieja', 'fp_vieja');
  await a.api('POST', '/api/billing/confirm');
  assert.equal((await accountOf(a.accountId)).status, 'active');
});

t('el aviso de prueba por terminar de una prueba con tarjeta habla del primer cobro, no de la pausa', async () => {
  const a = await waiting('aviso@prueba.mx');
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_aviso', 'fp_aviso');
  await a.api('POST', '/api/billing/confirm');
  await pool.query(`UPDATE accounts SET trial_ends_at = now() + interval '2 days' WHERE id = $1`, [a.accountId]);
  await checkTrials();
  const mail = outbox.filter((m) => m.to === 'aviso@prueba.mx' && /está por terminar/.test(m.subject)).at(-1);
  assert.ok(mail, 'se avisa');
  assert.match(mail.text, /primer cobro/);
  assert.doesNotMatch(mail.text, /dejará de responder/);
});

t('dos cuentas de la misma persona que confirman la misma tarjeta a la vez: solo una empieza su prueba (revisión final C1)', async () => {
  const a = await waiting('carrera+1@gmail.com');
  const b = await waiting('carrera+2@gmail.com');
  const ca = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  const cb = await b.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  assert.deepEqual([ca.json().trial, cb.json().trial], [true, true], 'las dos tenían prueba al abrir el pago');
  cardOnStripe(ca.json().url.split('/').pop(), a.accountId, 'sub_c1a', 'fp_carrera');
  cardOnStripe(cb.json().url.split('/').pop(), b.accountId, 'sub_c1b', 'fp_carrera');
  await Promise.all([a.api('POST', '/api/billing/confirm'), b.api('POST', '/api/billing/confirm')]);
  const statuses = [(await accountOf(a.accountId)).status, (await accountOf(b.accountId)).status];
  assert.equal(statuses.filter((s) => s === 'trial').length, 1, statuses.join());
});

t('Mercado Pago: tras una tarjeta repetida, «Contratar» cobra hoy, sin los días de la suscripción cancelada (revisión final I1)', async () => {
  fake.mp.cards.card_rep = { first_six_digits: '450995', last_four_digits: '1111', expiration_month: 1, expiration_year: 2031 };
  const old = await waiting('mprep-vieja@prueba.mx');
  await recordTrialClaims({ accountId: old.accountId, email: 'mprep-vieja@prueba.mx', cardKey: mpCardKey(fake.mp.cards.card_rep), provider: 'mercadopago' });
  const c = await waiting('mprep@prueba.mx');
  await c.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'mercadopago' });
  await pool.query(`UPDATE subscriptions SET checkout_ref = 'pre_rep' WHERE account_id = $1`, [c.accountId]);
  const start = new Date(Date.now() + 14 * 86400_000);
  fake.mp.preapprovals.pre_rep = { id: 'pre_rep', status: 'authorized', external_reference: `${c.accountId}:pro`, payer_id: 33, card_id: 'card_rep', auto_recurring: { start_date: start.toISOString() }, next_payment_date: start.toISOString() };
  assert.equal((await post(mpEvent('subscription_preapproval', 'pre_rep'))).statusCode, 200);
  assert.equal(fake.mp.preapprovals.pre_rep.status, 'cancelled');
  const again = await c.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'mercadopago', trial: false });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(lastMp().auto_recurring.start_date, undefined, 'el primer cobro es hoy');
});

t('al empezar la prueba la cuenta deja de contar como pausada: Cuentas no muestra su fecha de borrado (revisión final I2)', async () => {
  const a = await waiting('borrado@prueba.mx');
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_borrado', 'fp_borrado');
  await a.api('POST', '/api/billing/confirm');
  const listed = (await h.authed('GET', '/api/accounts')).json().find((x: any) => x.id === a.accountId);
  assert.deepEqual([listed.status, listed.paused_at, listed.deletion_date ?? null], ['trial', null, null]);
});

t('negada por el correo (otra cuenta de la misma persona empezó antes): Mi plan no dice «esta tarjeta» (menor 1)', async () => {
  fake.mp.cards.card_motivo = { first_six_digits: '450995', last_four_digits: '2222', expiration_month: 2, expiration_year: 2031 };
  const a = await waiting('motivo@prueba.mx');
  await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'mercadopago' });
  const other = await waiting('motivo+otra@prueba.mx');
  await recordTrialClaims({ accountId: other.accountId, email: 'motivo+otra@prueba.mx', provider: 'mercadopago' });
  await pool.query(`UPDATE subscriptions SET checkout_ref = 'pre_motivo' WHERE account_id = $1`, [a.accountId]);
  const start = new Date(Date.now() + 14 * 86400_000);
  fake.mp.preapprovals.pre_motivo = { id: 'pre_motivo', status: 'authorized', external_reference: `${a.accountId}:pro`, payer_id: 34, card_id: 'card_motivo', auto_recurring: { start_date: start.toISOString() }, next_payment_date: start.toISOString() };
  assert.equal((await post(mpEvent('subscription_preapproval', 'pre_motivo'))).statusCode, 200);
  assert.equal(mails('motivo@prueba.mx', /Ya usaste tu prueba gratis con este correo/), 1);
  const cc = (await a.api('GET', '/api/billing')).json().card_check;
  assert.deepEqual([cc.waiting, cc.trial_available, cc.card_used], [true, false, false]);
});

t('Stripe con una tarjeta que ya tuvo prueba: mientras llega el primer cobro, el panel dice que el plan se está activando (menor 11)', async () => {
  const old = await waiting('cobro-vieja@prueba.mx');
  await recordTrialClaims({ accountId: old.accountId, email: 'cobro-vieja@prueba.mx', cardKey: 'fp_cobro', provider: 'stripe' });
  const a = await waiting('cobro@prueba.mx');
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_cobro', 'fp_cobro');
  await a.api('POST', '/api/billing/confirm');
  const cc = (await a.api('GET', '/api/billing')).json().card_check;
  assert.deepEqual([cc.waiting, cc.card_used, cc.charging], [true, false, true], 'no ofrece «Usar otra tarjeta»: ya se está cobrando');
  assert.equal((await a.api('GET', '/api/me')).json().card_check.charging, true);
});

t('el aviso de prueba por terminar a quien ya canceló dice que no se cobrará (menor 6)', async () => {
  const a = await waiting('cancelo@prueba.mx');
  const co = await a.api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  cardOnStripe(co.json().url.split('/').pop(), a.accountId, 'sub_cancelo', 'fp_cancelo');
  await a.api('POST', '/api/billing/confirm');
  assert.equal((await accountOf(a.accountId)).status, 'trial');
  await pool.query(`UPDATE subscriptions SET cancel_at_period_end = true WHERE account_id = $1`, [a.accountId]);
  await pool.query(`UPDATE accounts SET trial_ends_at = now() + interval '2 days' WHERE id = $1`, [a.accountId]);
  await checkTrials();
  const mail = outbox.filter((m) => m.to === 'cancelo@prueba.mx' && /está por terminar/.test(m.subject)).at(-1);
  assert.ok(mail, 'se avisa');
  assert.match(mail.text, /cancelaste/);
  assert.doesNotMatch(mail.text, /primer cobro/);
});
