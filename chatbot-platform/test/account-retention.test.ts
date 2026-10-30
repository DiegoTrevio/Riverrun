/** Retención: una cuenta pausada sola y sin reactivar se borra a los 90 días, con aviso 7 días antes. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
const { checkAccountRetention } = await import('../src/accounts/retention.js');
const { checkTrials } = await import('../src/lifecycle.js');

let ip = 0;
async function newAccount(email: string, company: string) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.77.7.${++ip}`,
    payload: { name: 'Teo Paz', company, business_type: 'servicios', email, password: 'Pz-150-Qx-350-Kv', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().account.id as string;
}
/** Pausada sola hace `days` días (y, si se indica, avisada hace `warned` días). */
const paused = (id: string, days: number, warned?: number) => pool.query(
  `UPDATE accounts SET status = 'paused', paused_at = now() - make_interval(days => $2), pause_reason = 'trial',
     deletion_warned_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END WHERE id = $1`,
  [id, days, warned ?? null]);
const row = async (id: string) => (await pool.query(`SELECT * FROM accounts WHERE id = $1`, [id])).rows[0];
const mails = (to: string) => outbox.filter((m) => m.to === to).map((m) => m.subject);

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la prueba vencida pausa la cuenta con fecha y motivo, y avisa cuánto se conservan los datos', async () => {
  const id = await newAccount('teo@taller.mx', 'Taller Teo');
  await pool.query(`UPDATE accounts SET trial_ends_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  outbox.length = 0;
  await checkTrials();
  const acc = await row(id);
  assert.deepEqual([acc.status, acc.pause_reason], ['paused', 'trial']);
  assert.ok(acc.paused_at);
  assert.match(outbox.find((m) => m.to === 'teo@taller.mx' && /terminó/.test(m.subject))!.text, /se conservan 90 días/);
});

t('aviso 7 días antes, una vez; borrado al cumplir el plazo y con 7 días desde el aviso', async () => {
  const id = await newAccount('ivo@taller.mx', 'Taller Ivo');
  await pool.query(
    `INSERT INTO billing_payments (account_id, provider, provider_payment_id, currency, total_cents, subtotal_cents, tax_cents, tax_percent, paid_at)
     VALUES ($1, 'stripe', 'in_ivo', 'MXN', 11600, 10000, 1600, 16, now() - interval '100 days')`, [id]);
  await paused(id, 82);
  outbox.length = 0;
  assert.deepEqual(await checkAccountRetention(), { warned: 0, deleted: 0 }, 'faltan más de 7 días');

  await paused(id, 84);
  assert.deepEqual(await checkAccountRetention(), { warned: 1, deleted: 0 });
  const [subject] = mails('ivo@taller.mx');
  assert.match(subject, /^Tu cuenta "Taller Ivo" se borrará el /);
  assert.match(outbox.find((m) => m.subject === subject)!.text, /No se puede deshacer[\s\S]*#\/plan/);
  assert.deepEqual(await checkAccountRetention(), { warned: 0, deleted: 0 }, 'el aviso no se repite');

  // Ya pasaron los 90 días, pero el aviso fue hace 2: todavía no.
  await paused(id, 91, 2);
  assert.deepEqual(await checkAccountRetention(), { warned: 0, deleted: 0 });
  const listed = (await h.authed('GET', '/api/accounts')).json().find((a: any) => a.id === id);
  assert.ok(new Date(listed.deletion_date).getTime() > Date.now(), 'el superadmin ve cuándo se borra');

  await paused(id, 91, 8);
  assert.deepEqual(await checkAccountRetention(), { warned: 0, deleted: 1 });
  assert.equal(await row(id), undefined);
  const pay = (await pool.query(`SELECT account_id FROM billing_payments WHERE provider_payment_id = 'in_ivo'`)).rows[0];
  assert.deepEqual(pay, { account_id: null }, 'el pago se conserva sin la cuenta');
});

t('reactivar la cuenta cancela el borrado; una pausa manual no se borra sola', async () => {
  const id = await newAccount('ruy@taller.mx', 'Taller Ruy');
  await paused(id, 95, 10);
  assert.equal((await h.authed('PUT', `/api/accounts/${id}`, { status: 'active' })).statusCode, 200);
  const acc = await row(id);
  assert.deepEqual([acc.paused_at, acc.deletion_warned_at, acc.pause_reason], [null, null, '']);

  // El superadmin la pausa a mano: no tiene fecha de pausa automática.
  assert.equal((await h.authed('PUT', `/api/accounts/${id}`, { status: 'paused' })).statusCode, 200);
  assert.equal((await row(id)).paused_at, null);
  assert.deepEqual(await checkAccountRetention(), { warned: 0, deleted: 0 });
  assert.ok(await row(id));
});

t('no se borran: con «Conservar sus datos», del superadmin, con suscripción viva o con la retención apagada', async () => {
  const keep = await newAccount('ana@taller.mx', 'Taller Ana');
  const admin = await newAccount('bea@taller.mx', 'Taller Bea');
  const paying = await newAccount('cia@taller.mx', 'Taller Cía');
  for (const id of [keep, admin, paying]) await paused(id, 95, 10);
  assert.equal((await h.authed('PUT', `/api/accounts/${keep}`, { keep_data: true })).statusCode, 200);
  assert.equal((await h.authed('GET', '/api/accounts')).json().find((a: any) => a.id === keep).deletion_date, null);
  await pool.query(`UPDATE accounts SET signup_source = 'admin' WHERE id = $1`, [admin]);
  await pool.query(`INSERT INTO subscriptions (account_id, provider, provider_subscription_id, plan_key, status) VALUES ($1, 'stripe', 'sub_cia', 'pro', 'past_due')`, [paying]);

  const days = config.billing.retentionDays;
  config.billing.retentionDays = 0;
  let other = '';
  try {
    other = await newAccount('dan@taller.mx', 'Taller Dan');
    await paused(other, 200, 30);
    assert.deepEqual(await checkAccountRetention(), { warned: 0, deleted: 0 }, 'ACCOUNT_RETENTION_DAYS=0');
    assert.ok(await row(other));
  } finally {
    config.billing.retentionDays = days;
  }

  // Con la retención encendida solo se borra «Taller Dan», que cumple todo.
  assert.equal((await checkAccountRetention()).deleted, 1);
  assert.equal(await row(other), undefined);
  for (const id of [keep, admin, paying]) assert.ok(await row(id), id);
});
