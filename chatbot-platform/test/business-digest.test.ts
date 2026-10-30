/** Tu negocio: cifras del tablero, avisos urgentes al momento y lo demás en un solo correo al día. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let outbox: { to: string; subject: string; text: string }[];
let digest: typeof import('../src/platform/digest.js');
let config: typeof import('../src/config.js').config;
const SUPER = 'yo@plataforma.mx';
const toSuper = () => outbox.filter((m) => m.to === SUPER);
// 15:00 UTC = 9:00 en la Ciudad de México (después de las 8, la hora del resumen).
const at = (day: string, hourUtc: number) => new Date(`${day}T${String(hourUtc).padStart(2, '0')}:00:00Z`);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  outbox = (await import('../src/mailer.js')).outbox as any;
  digest = await import('../src/platform/digest.js');
  config = (await import('../src/config.js')).config;
  config.signup.superadminEmail = SUPER;
});
after(async () => {
  if (config) config.signup.superadminEmail = '';
  if (h) await h.app.close();
  await pool.end();
});

t('lo urgente sale al momento; lo demás espera al resumen (y sin resumen, sale al momento como antes)', async () => {
  const n = toSuper().length;
  await digest.emailSuperadmin('Nueva empresa registrada: Spa Luna', 'Ana se registró.');
  assert.equal(toSuper().length, n, 'no urgente: no sale correo');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM superadmin_digest WHERE sent_at IS NULL AND title LIKE 'Nueva empresa%'`)).rows[0].n, 1);
  await digest.emailSuperadmin('Contracargo: Spa Luna', 'Responde la disputa.', { urgent: true });
  assert.deepEqual(toSuper().slice(n).map((m) => m.subject), ['Contracargo: Spa Luna']);

  config.signup.superadminDigest = false;
  try {
    await digest.emailSuperadmin('Prueba terminada: Spa Sol', 'Quedó en pausa.');
    assert.equal(toSuper().at(-1)!.subject, 'Prueba terminada: Spa Sol');
  } finally {
    config.signup.superadminDigest = true;
  }
});

t('los avisos de la plataforma pasan por el resumen: el registro de una cuenta no manda correo al superadmin', async () => {
  const n = toSuper().length;
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.88.0.1', payload: { name: 'Leo Paz', company: 'Barbería Paz', business_type: 'belleza', email: 'leo@barberia.mx', password: 'Pz-129-Qx-329-Kv', accept_terms: true } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(toSuper().length, n);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM superadmin_digest WHERE sent_at IS NULL AND title LIKE '%Barbería Paz%'`)).rows[0].n, 1);
  // En el panel sí llega al momento.
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.role = 'superadmin' AND n.title LIKE '%Barbería Paz%'`)).rows[0].n, 1);
});

t('el resumen sale una vez al día, desde la hora configurada, con los avisos y las cifras', async () => {
  const day = '2030-03-10';
  assert.equal(await digest.sendSuperadminDigest(at(day, 12)), 0, 'a las 6:00 de México todavía no');
  const n = toSuper().length;
  const sent = await digest.sendSuperadminDigest(at(day, 15));
  assert.ok(sent >= 2, `avisos enviados: ${sent}`);
  const mail = toSuper().slice(n);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /^Resumen del día: \d+ aviso\(s\)$/);
  assert.match(mail[0].text, /Nueva empresa registrada: Spa Luna/);
  assert.match(mail[0].text, /Barbería Paz/);
  assert.match(mail[0].text, /Ingreso recurrente sin IVA/);
  assert.match(mail[0].text, /#\/negocio/);
  assert.doesNotMatch(mail[0].text, /Contracargo: Spa Luna/, 'lo urgente ya había salido');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM superadmin_digest WHERE sent_at IS NULL`)).rows[0].n, 0);

  // Más avisos el mismo día: esperan al siguiente, aunque haya varias vueltas.
  await digest.emailSuperadmin('Cobro fallido: Spa Luna', 'Se reintenta solo.');
  assert.equal(await digest.sendSuperadminDigest(at(day, 20)), 0);
  assert.equal(await digest.sendSuperadminDigest(at(day, 23)), 0);
  assert.equal(toSuper().length, n + 1);
  assert.equal(await digest.sendSuperadminDigest(at('2030-03-11', 15)), 1);
  assert.match(toSuper().at(-1)!.text, /Cobro fallido: Spa Luna/);
  // Sin avisos nuevos no hay correo.
  assert.equal(await digest.sendSuperadminDigest(at('2030-03-12', 15)), 0);
  assert.equal(toSuper().length, n + 2);
});

t('cifras del negocio: registros, conversión, MRR y ARR sin IVA, bajas, cobros fallidos, contracargos y facturas', async () => {
  const before = await digest.businessMetrics();
  await pool.query(`INSERT INTO plans (key, name, price_cents, currency, billing_interval) VALUES ('m-499', 'Mensual', 49900, 'MXN', 'month'), ('a-4990', 'Anual', 499000, 'MXN', 'year') ON CONFLICT (key) DO NOTHING`);
  const acc = async (name: string, extra = '') => (await pool.query(`INSERT INTO accounts (name, signup_source, status, trial_ends_at) VALUES ($1, 'signup', ${extra || `'trial', now() + interval '5 days'`}) RETURNING id`, [name])).rows[0].id as string;
  const paid1 = await acc('Pagó mensual', `'active', now() - interval '10 days'`);
  const paid2 = await acc('Pagó anual', `'active', now() - interval '20 days'`);
  await acc('No pagó', `'paused', now() - interval '3 days'`);
  await acc('En prueba');
  const late = await acc('Cobro pendiente', `'active', now() - interval '40 days'`);
  const gone = await acc('Se fue', `'paused', now() - interval '50 days'`);
  await pool.query(`INSERT INTO subscriptions (account_id, provider, plan_key, status) VALUES ($1, 'stripe', 'm-499', 'active'), ($2, 'stripe', 'a-4990', 'active'), ($3, 'mercadopago', 'm-499', 'past_due'), ($4, 'stripe', 'm-499', 'canceled')`, [paid1, paid2, late, gone]);
  await pool.query(
    `INSERT INTO billing_payments (account_id, provider, provider_payment_id, currency, subtotal_cents, tax_cents, total_cents, tax_percent, paid_at, dispute_status)
     VALUES ($1, 'stripe', 'pay-m1', 'MXN', 49900, 7984, 57884, 16, now() - interval '9 days', ''),
            ($2, 'stripe', 'pay-a1', 'MXN', 499000, 79840, 578840, 16, now() - interval '19 days', 'open')`, [paid1, paid2]);
  await pool.query(`INSERT INTO cfdi_invoices (kind, account_id, status, amount_cents) VALUES ('payment', $1, 'failed', 57884), ('payment', $1, 'pending', 57884)`, [paid1]);

  const m = await digest.businessMetrics();
  assert.equal(m.signups.last_30d - before.signups.last_30d, 6);
  assert.equal(m.trials_active - before.trials_active, 1);
  // De las pruebas terminadas en 90 días (pagó mensual, pagó anual, no pagó, cobro pendiente y se fue), pagaron 2.
  assert.equal(m.conversion.ended - before.conversion.ended, 5);
  assert.equal(m.conversion.paid - before.conversion.paid, 2);
  assert.equal(m.subscriptions.active - before.subscriptions.active, 2);
  assert.equal(m.subscriptions.past_due - before.subscriptions.past_due, 1);
  assert.equal(m.subscriptions.canceled_30d - before.subscriptions.canceled_30d, 1);
  // MRR sin IVA: 499 + 499 (el cobro pendiente cuenta) + 4990/12; el ARR es 12 veces.
  const mxn = (x: typeof m) => x.revenue.find((r) => r.currency === 'MXN') ?? { mrr: 0, arr: 0 };
  const mrrCents = 49900 + 49900 + Math.round(499000 / 12);
  assert.equal(Math.round((mxn(m).mrr - mxn(before).mrr) * 100), mrrCents);
  assert.equal(Math.round((mxn(m).arr - mxn(before).arr) * 100), mrrCents * 12);
  const col = (x: typeof m) => x.collected_30d.find((r) => r.currency === 'MXN')?.amount ?? 0;
  assert.equal(Math.round((col(m) - col(before)) * 100), 49900 + 499000, 'lo cobrado, sin IVA');
  assert.equal(m.disputes.open - before.disputes.open, 1);
  assert.equal(m.cfdi.failed - before.cfdi.failed, 1);
  assert.equal(m.cfdi.pending - before.cfdi.pending, 1);
  assert.match(digest.metricsText(m), /contracargo\(s\) abierto\(s\)/);
});

t('el tablero es solo del superadmin y trae lo que falta para cobrar de verdad, sin valores secretos', async () => {
  const r = await h.authed('GET', '/api/platform/business');
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.ok(b.metrics && typeof b.metrics.trials_active === 'number');
  assert.ok(Array.isArray(b.golive));
  for (const g of b.golive) assert.ok(g.message && g.fix && ['critical', 'warning'].includes(g.level));
  const leo = await h.loginAs('leo@barberia.mx', 'Pz-129-Qx-329-Kv');
  assert.equal((await leo('GET', '/api/platform/business')).statusCode, 403);
});
