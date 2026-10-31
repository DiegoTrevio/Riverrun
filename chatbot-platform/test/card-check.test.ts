/**
 * La verificación de tarjeta (el pago de Mi plan): pide el correo del dueño verificado y la verificación reciente, abre
 * una sesión de pago de 30 minutos con 3D Secure y sin códigos sueltos, con 14 días gratis si la persona tiene prueba
 * disponible, reutiliza la sesión vigente y tiene topes en la base (por cuenta, por conexión y en toda la plataforma).
 * Si en la última hora se abren muchas y casi ninguna termina (alguien probando tarjetas), un freno las cierra una hora.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
const { fake } = await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { ipKey } = await import('../src/auth.js');
const { recordTrialClaims } = await import('../src/billing/trial-claims.js');
const { pruneCardChecks } = await import('../src/billing/card-check.js');
const { config } = await import('../src/config.js');
const { outbox } = await import('../src/mailer.js');
let h: Awaited<ReturnType<typeof createHarness>>;

let n = 0;
/** Cuenta nueva del registro: espera la tarjeta. `verified`: con el correo ya verificado. */
async function waiting(email: string, verified = true, plan = '') {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.66.0.${++n}`,
    payload: { name: 'Tere', company: `Negocio ${n}`, business_type: 'otro', email, password: 'Pz-171-Qx-371-Kv', accept_terms: true, plan },
  });
  assert.equal(r.statusCode, 200, r.body);
  if (verified) await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = $1`, [email]);
  const cookie = await h.sessionFrom(r);
  const own = `10.65.0.${n}`; // cada cuenta paga desde su conexión
  const api = (body: Record<string, unknown> = { plan: 'pro', provider: 'stripe' }, ip = own) =>
    h.app.inject({ method: 'POST', url: '/api/billing/checkout', remoteAddress: ip, headers: { cookie }, payload: body });
  const as = (method: string, url: string) => h.app.inject({ method: method as any, url, remoteAddress: own, headers: { cookie } });
  return { api, as, accountId: r.json().account.id as string, userId: r.json().user.id as string };
}
const lastStripe = () => fake.stripe.requests.filter((x) => x.method === 'POST' && x.path === '/v1/checkout/sessions').at(-1)!.body as URLSearchParams;
const lastMp = () => fake.mp.requests.filter((x) => x.method === 'POST' && x.path === '/preapproval').at(-1)!.body;
const checks = async (accountId: string) => (await pool.query(`SELECT count(*)::int AS n FROM card_checks WHERE account_id = $1`, [accountId])).rows[0].n;
const age = (accountId: string) => pool.query(`UPDATE card_checks SET opened_at = opened_at - interval '31 minutes' WHERE account_id = $1`, [accountId]);
const setHits = (key: string, hits: number) =>
  pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, $2, now() + interval '1 day') ON CONFLICT (key) DO UPDATE SET hits = $2, expires_at = now() + interval '1 day'`, [key, hits]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499, currency: 'MXN' })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('sin el correo verificado no se abre la verificación de tarjeta', async () => {
  const a = await waiting('sinverificar@tarjeta.mx', false);
  const r = await a.api();
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(r.json().error, 'Falta verificar tu correo');
  assert.equal(await checks(a.accountId), 0);
});

t('sin verificación reciente pide el código (como todo Mi plan)', async () => {
  const a = await waiting('reciente@tarjeta.mx');
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes' WHERE user_id = $1`, [a.userId]);
  assert.equal((await a.api()).json().code, 'step_up');
});

t('Stripe con prueba disponible: 14 días, tarjeta obligatoria, 30 minutos, 3D Secure y sin códigos sueltos', async () => {
  const a = await waiting('stripe@tarjeta.mx');
  const r = await a.api();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().trial, true);
  const body = lastStripe();
  assert.equal(body.get('subscription_data[trial_period_days]'), '14');
  assert.equal(body.get('payment_method_collection'), 'always');
  const expires = Number(body.get('expires_at')) * 1000;
  assert.ok(expires >= Date.now() + 30 * 60_000 && expires <= Date.now() + 32 * 60_000, `expires_at ${new Date(expires).toISOString()}`);
  assert.equal(body.get('payment_method_options[card][request_three_d_secure]'), 'any');
  assert.match(String(body.get('success_url')), /\{CHECKOUT_SESSION_ID\}/);
  assert.equal(body.get('allow_promotion_codes'), null);
  assert.equal(await checks(a.accountId), 1);
});

t('sin prueba disponible (el correo ya tuvo una), la verificación es el primer cobro', async () => {
  const a = await waiting('repetida@tarjeta.mx');
  await recordTrialClaims({ accountId: a.accountId, email: 'repetida+vieja@tarjeta.mx', provider: 'stripe' });
  const r = await a.api();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().trial, false);
  assert.equal(lastStripe().get('subscription_data[trial_period_days]'), null);
});

t('Mercado Pago: con prueba, el primer cobro a los 14 días; sin prueba, ya', async () => {
  const a = await waiting('mp@tarjeta.mx');
  assert.equal((await a.api({ plan: 'pro', provider: 'mercadopago' })).statusCode, 200);
  const start = new Date(lastMp().auto_recurring.start_date).getTime();
  assert.ok(Math.abs(start - (Date.now() + 14 * 86400_000)) < 60_000, new Date(start).toISOString());
  const b = await waiting('mp2@tarjeta.mx');
  await recordTrialClaims({ accountId: b.accountId, email: 'mp2@tarjeta.mx', provider: 'mercadopago' });
  assert.equal((await b.api({ plan: 'pro', provider: 'mercadopago' })).statusCode, 200);
  assert.equal(lastMp().auto_recurring.start_date, undefined);
});

t('la sesión vigente se reutiliza sin contar; pasados 30 minutos se abre otra (Review Focus 2)', async () => {
  const a = await waiting('vuelve@tarjeta.mx');
  const first = (await a.api()).json().url;
  const sessions = fake.stripe.requests.filter((x) => x.path === '/v1/checkout/sessions').length;
  const again = await a.api();
  assert.equal(again.json().url, first, 'la misma página');
  assert.equal(fake.stripe.requests.filter((x) => x.path === '/v1/checkout/sessions').length, sessions, 'no se pidió otra a Stripe');
  assert.equal(await checks(a.accountId), 1);
  await age(a.accountId);
  const later = await a.api();
  assert.notEqual(later.json().url, first);
  assert.equal(await checks(a.accountId), 2);
});

t('topes: 5 por día por cuenta, 10 por conexión y 300 en toda la plataforma', async () => {
  const a = await waiting('topes@tarjeta.mx');
  for (let i = 0; i < 5; i++) {
    assert.equal((await a.api()).statusCode, 200, `verificación ${i + 1}`);
    await age(a.accountId);
  }
  const sixth = await a.api();
  assert.equal(sixth.statusCode, 429, sixth.body);
  assert.equal(sixth.json().error, 'Intenta más tarde');

  const b = await waiting('conexion@tarjeta.mx');
  await setHits(`card-check-ip:${ipKey('10.67.0.1')}`, 10);
  assert.equal((await b.api(undefined, '10.67.0.1')).statusCode, 429);
  assert.equal((await b.api(undefined, '10.67.0.2')).statusCode, 200, 'desde otra conexión sí');

  const c = await waiting('global@tarjeta.mx');
  await setHits('card-check-day', 300);
  try {
    assert.equal((await c.api()).statusCode, 429);
  } finally {
    await pool.query(`DELETE FROM rate_limits WHERE key = 'card-check-day'`);
  }
});

/** Verificaciones de la última hora: `opened` abiertas por alguien más y `completed` de ellas terminadas. */
const seed = async (accountId: string, opened: number, completed: number) => {
  await pool.query(`DELETE FROM card_checks`);
  await pool.query(
    `INSERT INTO card_checks (account_id, provider, plan_key, ref, url, ip_key, opened_at, completed_at)
     SELECT $1, 'stripe', 'pro', 'cs_seed_' || g, '', 'seed', now() - interval '10 minutes', CASE WHEN g <= $3 THEN now() END FROM generate_series(1, $2) g`,
    [accountId, opened, completed],
  );
};

t('freno: con 20 abiertas en la última hora y menos del 20 % completas se cierran las nuevas, con un solo aviso urgente; el superadmin lo quita', async () => {
  const prev = config.signup.superadminEmail;
  config.signup.superadminEmail = 'super@freno.mx';
  const alerts = () => outbox.filter((m) => m.to === 'super@freno.mx' && /Freno/.test(m.subject)).length;
  try {
    const a = await waiting('freno@tarjeta.mx');
    await seed(a.accountId, 20, 4);
    assert.equal((await a.api()).statusCode, 200, 'con el 20 % completas no frena');

    const b = await waiting('frenada@tarjeta.mx');
    await seed(b.accountId, 20, 3);
    const braked = await b.api();
    assert.equal(braked.statusCode, 429, braked.body);
    assert.equal(braked.json().error, 'Intenta más tarde');
    assert.equal((await b.api(undefined, '10.68.0.9')).statusCode, 429, 'desde cualquier conexión');
    assert.equal(alerts(), 1, 'un solo aviso aunque sigan los intentos');
    const log = await pool.query(`SELECT 1 FROM event_logs WHERE message LIKE 'Freno de verificaciones de tarjeta puesto%'`);
    assert.equal(log.rowCount, 1, 'queda en la bitácora');

    assert.equal((await b.as('DELETE', '/api/billing/card-check-brake')).statusCode, 403, 'un administrador no lo quita');
    const off = await h.authed('DELETE', '/api/billing/card-check-brake');
    assert.equal(off.statusCode, 200, off.body);
    assert.equal((await b.api()).statusCode, 200, 'quitado, cuentan solo las de después');
  } finally {
    config.signup.superadminEmail = prev;
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'card-check-brake%'`);
  }
});

t('«Activar sin tarjeta»: el superadmin deja la cuenta en prueba de TRIAL_DAYS, con bitácora; un administrador no puede', async () => {
  const a = await waiting('sintarjeta@tarjeta.mx');
  const listed = (await h.authed('GET', '/api/accounts')).json().find((x: any) => x.id === a.accountId);
  assert.deepEqual([listed.status, listed.pause_reason], ['paused', 'card'], 'Cuentas ve «Esperando tarjeta»');
  assert.equal((await a.as('POST', `/api/accounts/${a.accountId}/trial-without-card`)).statusCode, 403);
  const r = await h.authed('POST', `/api/accounts/${a.accountId}/trial-without-card`);
  assert.equal(r.statusCode, 200, r.body);
  const acc = (await pool.query(`SELECT status, pause_reason, trial_ends_at FROM accounts WHERE id = $1`, [a.accountId])).rows[0];
  assert.deepEqual([acc.status, acc.pause_reason], ['trial', '']);
  assert.equal((await pool.query(`SELECT paused_at FROM accounts WHERE id = $1`, [a.accountId])).rows[0].paused_at, null, 'ya no cuenta como pausada (revisión final I2)');
  const days = (new Date(acc.trial_ends_at).getTime() - Date.now()) / 86400_000;
  assert.ok(days > 13.9 && days <= 14, String(days));
  const log = await pool.query(`SELECT 1 FROM event_logs WHERE account_id = $1 AND message LIKE 'Prueba sin tarjeta activada por admin@test.mx%'`, [a.accountId]);
  assert.equal(log.rowCount, 1, 'la bitácora dice quién fue');
  assert.equal((await pool.query(`SELECT kind FROM trial_claims WHERE account_id = $1`, [a.accountId])).rows.map((x) => x.kind).join(), 'email', 'la prueba de esa persona ya se usó');
  assert.equal((await a.as('GET', '/api/billing')).json().card_check, null, 'ya no espera tarjeta: Mi plan no la calcula (menor 9)');
  const again = await h.authed('POST', `/api/accounts/${a.accountId}/trial-without-card`);
  assert.equal(again.statusCode, 400, 'solo a una cuenta que espera tarjeta');
});

t('Mi plan trae el estado de la verificación de tarjeta: correo, prueba disponible, plan elegido y freno', async () => {
  const state = async (a: Awaited<ReturnType<typeof waiting>>) => (await a.as('GET', '/api/billing')).json().card_check;
  const a = await waiting('estado@tarjeta.mx', false, 'pro');
  assert.deepEqual(await state(a), { required: true, waiting: true, trial_available: true, trial_days: 14, email_verified: false, signup_plan: 'pro', card_used: false, charging: false, brake: false });
  const b = await waiting('estado2@tarjeta.mx');
  await recordTrialClaims({ accountId: b.accountId, email: 'estado2@tarjeta.mx', provider: 'stripe' });
  assert.deepEqual(await state(b), { required: true, waiting: true, trial_available: false, trial_days: 14, email_verified: true, signup_plan: '', card_used: false, charging: false, brake: false });
  await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ('card-check-brake', 1, now() + interval '1 hour') ON CONFLICT (key) DO UPDATE SET hits = 1, expires_at = now() + interval '1 hour'`);
  try {
    assert.equal((await state(b)).brake, true);
    assert.deepEqual((await h.authed('GET', '/api/billing/card-check-brake')).json(), { on: true }, 'Cuentas sabe si está puesto');
  } finally {
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'card-check-brake%'`);
  }
});

t('el panel: «Contratar» sin prueba aunque haya una disponible; /api/me trae el estado de la cuenta que espera tarjeta; el registro dice si pide tarjeta', async () => {
  const a = await waiting('panel@tarjeta.mx');
  await seed(a.accountId, 0, 0); // sin las verificaciones sembradas por la prueba del freno
  const r = await a.api({ plan: 'pro', provider: 'stripe', trial: false });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().trial, false);
  assert.equal(lastStripe().get('subscription_data[trial_period_days]'), null);
  const me = (await a.as('GET', '/api/me')).json();
  assert.equal(me.account.pause_reason, 'card');
  assert.equal(me.card_check.waiting, true);
  assert.equal(me.card_check.trial_available, true);
  assert.equal((await h.authed('GET', '/api/me')).json().card_check, null, 'sin cuenta que espere tarjeta, nada');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json().card_required, true);
});

t('las páginas de tarjeta por sustitución (Mercado Pago: cambiar tarjeta) cuentan para los topes, el freno y card_checks (revisión final I3)', async () => {
  const a = await waiting('sustituye@tarjeta.mx');
  await seed(a.accountId, 0, 0);
  fake.mp.nextId = 'pre_sust';
  assert.equal((await a.api({ plan: 'pro', provider: 'mercadopago', trial: false })).statusCode, 200);
  fake.mp.nextId = '';
  fake.mp.preapprovals.pre_sust = { id: 'pre_sust', status: 'authorized', external_reference: `${a.accountId}:pro`, payer_id: 41,
    next_payment_date: new Date(Date.now() + 30 * 86400_000).toISOString(), auto_recurring: { transaction_amount: 578.84, currency_id: 'MXN' } };
  assert.equal((await a.as('POST', '/api/billing/confirm')).json().confirmed, true);
  const before = await checks(a.accountId);
  const change = await a.as('POST', '/api/billing/payment-method');
  assert.equal(change.statusCode, 200, change.body);
  assert.equal(await checks(a.accountId), before + 1, 'la página de cambiar tarjeta queda en card_checks');
  await setHits(`card-check-acct:${a.accountId}`, 5);
  const r = await a.as('POST', '/api/billing/payment-method');
  assert.equal(r.statusCode, 429, r.body);
  assert.equal(r.json().error, 'Intenta más tarde');
  await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ('card-check-brake', 1, now() + interval '1 hour') ON CONFLICT (key) DO UPDATE SET hits = 1, expires_at = now() + interval '1 hour'`);
  try {
    await pool.query(`UPDATE rate_limits SET hits = 0 WHERE key = $1`, [`card-check-acct:${a.accountId}`]);
    assert.equal((await a.as('POST', '/api/billing/payment-method')).statusCode, 429, 'con el freno puesto tampoco');
  } finally {
    await pool.query(`UPDATE rate_limits SET expires_at = now() WHERE key LIKE 'card-check-brake%'`);
  }
});

t('una página abierta hace más de 25 minutos ya no se reutiliza: le quedaría muy poco antes de que Stripe la cierre (menor 2)', async () => {
  const a = await waiting('poco@tarjeta.mx');
  await seed(a.accountId, 0, 0);
  const first = (await a.api()).json().url;
  await pool.query(`UPDATE card_checks SET opened_at = opened_at - interval '26 minutes' WHERE account_id = $1`, [a.accountId]);
  assert.notEqual((await a.api()).json().url, first);
});

t('dos clics a la vez en «Agregar tarjeta» abren una sola página (menor 3)', async () => {
  const a = await waiting('dobleclic@tarjeta.mx');
  await seed(a.accountId, 0, 0);
  const [r1, r2] = await Promise.all([a.api(), a.api()]);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().url, r2.json().url);
  assert.equal(await checks(a.accountId), 1);
});

t('las marcas vencidas y las verificaciones de más de 30 días se depuran (menor 8)', async () => {
  const a = await waiting('depura@tarjeta.mx');
  await pool.query(
    `INSERT INTO card_checks (account_id, provider, plan_key, ref, url, ip_key, opened_at) VALUES
       ($1, 'stripe', 'pro', 'cs_vieja', '', 'x', now() - interval '31 days'), ($1, 'stripe', 'pro', 'cs_reciente', '', 'x', now() - interval '1 day')`,
    [a.accountId],
  );
  await pool.query(
    `INSERT INTO trial_claims (kind, digest, account_id, expires_at) VALUES
       ('email', convert_to('vencida', 'UTF8'), $1, now() - interval '1 day'), ('email', convert_to('vigente', 'UTF8'), $1, now() + interval '1 day')`,
    [a.accountId],
  );
  await pruneCardChecks();
  assert.deepEqual((await pool.query(`SELECT ref FROM card_checks WHERE account_id = $1 ORDER BY ref`, [a.accountId])).rows.map((r) => r.ref), ['cs_reciente']);
  assert.deepEqual((await pool.query(`SELECT convert_from(digest, 'UTF8') AS d FROM trial_claims WHERE account_id = $1`, [a.accountId])).rows.map((r) => r.d), ['vigente']);
});
