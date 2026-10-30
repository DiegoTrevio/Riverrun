/** Cobro fallido: recordatorios a los 3 días y antes de pausar, y la franja «Actualiza tu pago» en todo el panel. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake, stripeSub } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
const { applyState, checkDunning, enforceAccess } = await import('../src/billing/service.js');

const DAY = 86400_000;
let ip = 0;

/** Cuenta que paga Pro con Stripe y cuyo cobro falló `ago` días atrás. */
async function failedAccount(email: string, subId: string, ago = 0) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.99.0.${++ip}`,
    payload: { name: 'Mar Gil', company: `Salón ${ip}`, business_type: 'belleza', email, password: 'Pz-134-Qx-334-Kv', accept_terms: true, plan: 'pro', provider: 'stripe' },
  });
  assert.equal(r.statusCode, 200, r.body);
  const accountId = r.json().account.id as string;
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const api = (method: string, url: string) => h.app.inject({ method: method as any, url, headers: { cookie } });
  const session = r.json().checkout_url.split('/').pop();
  fake.stripe.subs[subId] = stripeSub({ id: subId, customer: `cus_${subId}`, metadata: { account_id: accountId, plan_key: 'pro' } });
  Object.assign(fake.stripe.sessions[session], { status: 'complete', subscription: subId });
  assert.equal((await api('POST', '/api/billing/confirm')).json().confirmed, true);
  await pool.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = now() - make_interval(days => $2) WHERE account_id = $1`, [accountId, ago]);
  return { accountId, api, subId };
}
const subjects = (to: string) => outbox.filter((m) => m.to === to).map((m) => m.subject);
const step = async (id: string) => (await pool.query(`SELECT dunning_step FROM subscriptions WHERE account_id = $1`, [id])).rows[0].dunning_step;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499 })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('recordatorios: a los 3 días y un día antes de pausar, una vez cada uno', async () => {
  const a = await failedAccount('mar@salon.mx', 'sub_mar');
  const now = Date.now();
  outbox.length = 0;
  assert.equal(await checkDunning(new Date(now + 1 * DAY)), 0, 'el primer aviso ya salió al fallar');

  assert.equal(await checkDunning(new Date(now + 3.1 * DAY)), 1);
  assert.deepEqual(subjects('mar@salon.mx'), ['Tu pago sigue pendiente']);
  const mail = outbox.find((m) => m.subject === 'Tu pago sigue pendiente')!;
  assert.match(mail.text, /«Administrar pago»/);
  assert.match(mail.text, /https:\/\/bot\.test\/#\/plan/);
  assert.equal(await checkDunning(new Date(now + 3.5 * DAY)), 0, 'no se repite');

  assert.equal(await checkDunning(new Date(now + 4.1 * DAY)), 1);
  assert.deepEqual(subjects('mar@salon.mx'), ['Tu pago sigue pendiente', 'Mañana se pausa tu asistente']);
  assert.equal(await checkDunning(new Date(now + 4.5 * DAY)), 0);
  assert.equal(await step(a.accountId), 2);

  // Pausada, ya no hay recordatorios.
  assert.equal(await enforceAccess(new Date(now + 6 * DAY)), 1);
  const acc = (await pool.query(`SELECT status, paused_at, pause_reason FROM accounts WHERE id = $1`, [a.accountId])).rows[0];
  assert.deepEqual([acc.status, acc.pause_reason], ['paused', 'payment']);
  assert.ok(acc.paused_at);
  assert.match(outbox.find((m) => m.subject === 'Tu asistente está en pausa')!.text, /se conservan 90 días/);
});

t('franja de pago pendiente en el panel; al pagar se quita y los recordatorios vuelven a empezar', async () => {
  const a = await failedAccount('ana@salon.mx', 'sub_ana', 1);
  const me = (await a.api('GET', '/api/me')).json();
  const ends = new Date(me.account.payment_due.grace_ends_at).getTime();
  const since = (await pool.query(`SELECT past_due_since FROM subscriptions WHERE account_id = $1`, [a.accountId])).rows[0].past_due_since.getTime();
  assert.equal(ends, since + config.billing.graceDays * DAY);
  assert.equal(me.account.payment_due.provider, 'stripe');

  // Un agente no ve la franja.
  assert.equal((await h.authed('POST', '/api/users', { account_id: a.accountId, name: 'Leo', email: 'leo@salon.mx', password: 'Pz-129-Qx-329-Kv', role: 'agent' })).statusCode, 200);
  assert.equal((await (await h.loginAs('leo@salon.mx', 'Pz-129-Qx-329-Kv'))('GET', '/api/me')).json().account.payment_due, null);

  await pool.query(`UPDATE subscriptions SET past_due_since = now() - interval '3 days 1 hour' WHERE account_id = $1`, [a.accountId]);
  assert.equal(await checkDunning(), 1);
  assert.equal(await step(a.accountId), 1);

  await applyState({ provider: 'stripe', accountId: a.accountId, customerId: 'cus_sub_ana', subscriptionId: 'sub_ana', planKey: 'pro', status: 'active', periodEnd: new Date(Date.now() + 30 * DAY), cancelAtPeriodEnd: false });
  assert.equal(await step(a.accountId), 0, 'la próxima caída vuelve a empezar');
  assert.equal((await a.api('GET', '/api/me')).json().account.payment_due, null);
});

t('con una gracia corta, el recordatorio de los 3 días se salta', async () => {
  const grace = config.billing.graceDays;
  config.billing.graceDays = 2;
  try {
    const a = await failedAccount('eli@salon.mx', 'sub_eli');
    outbox.length = 0;
    assert.equal(await checkDunning(new Date(Date.now() + 1.1 * DAY)), 1);
    assert.deepEqual(subjects('eli@salon.mx'), ['Mañana se pausa tu asistente']);
    assert.equal(await checkDunning(new Date(Date.now() + 1.9 * DAY)), 0);
    assert.equal(await step(a.accountId), 2);
  } finally {
    config.billing.graceDays = grace;
  }
});
