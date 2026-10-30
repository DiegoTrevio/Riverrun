/**
 * Una prueba gratis por persona: marcas del correo normalizado, de la cuenta de Google y de la tarjeta, guardadas como
 * HMAC con una llave que vive en la base (nunca el correo ni la tarjeta en claro). Vencen a los 2 años.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, migrate, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const claims = await import('../src/billing/trial-claims.js');

before(async () => {
  if (!ok) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
});
after(async () => {
  await pool.end();
});

const CASES: [string, string][] = [
  ['Ana.Ruiz+prueba@GMail.com', 'anaruiz@gmail.com'],
  ['a.b+x@googlemail.com', 'ab@gmail.com'],
  ['Luis+1@empresa.mx', 'luis@empresa.mx'],
  ['luis.p@empresa.mx', 'luis.p@empresa.mx'],
  ['  Mar@Correo.MX ', 'mar@correo.mx'],
];

t('el correo normalizado: minúsculas, sin +etiqueta y, en Gmail, sin puntos', async () => {
  for (const [raw, want] of CASES) assert.equal(claims.canonicalEmail(raw), want, raw);
});

t('la migración normaliza igual que el servidor', async () => {
  for (const [raw, want] of CASES) assert.equal((await pool.query(`SELECT canonical_email($1) AS c`, [raw])).rows[0].c, want, raw);
});

t('la huella de una tarjeta de Mercado Pago', async () => {
  const card = { first_six_digits: '450995', last_four_digits: '3704', expiration_month: 11, expiration_year: 2030 };
  assert.equal(claims.mpCardKey(card), '450995:3704:11/2030:');
  assert.equal(claims.mpCardKey({ ...card, cardholder: { identification: { number: 'XAXX010101000' } } }), '450995:3704:11/2030:XAXX010101000');
  assert.equal(claims.mpCardKey({ first_six_digits: '450995' }), null);
});

t('las marcas: el mismo correo escrito distinto ya no da prueba, otra sí; la tarjeta queda marcada; dos veces no falla', async () => {
  const acc = (await pool.query(`INSERT INTO accounts (name) VALUES ('Marcas') RETURNING id`)).rows[0].id;
  assert.equal(await claims.trialAvailable({ email: 'pepe.lopez@gmail.com' }), true);
  for (let i = 0; i < 2; i++) await claims.recordTrialClaims({ accountId: acc, email: 'Pepe.Lopez@gmail.com', googleSub: 'g-pepe', cardKey: 'fp_pepe', provider: 'stripe' });
  assert.equal(await claims.trialAvailable({ email: 'pepelopez+2@gmail.com' }), false);
  assert.equal(await claims.trialAvailable({ email: 'otra@gmail.com' }), true);
  assert.equal(await claims.trialAvailable({ email: 'otra@gmail.com', googleSub: 'g-pepe' }), false, 'la misma cuenta de Google');
  assert.deepEqual(await claims.cardClaim('fp_pepe'), { claimed: true, disputed: false });
  assert.deepEqual(await claims.cardClaim('fp_otra'), { claimed: false, disputed: false });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM trial_claims WHERE account_id = $1`, [acc])).rows[0].n, 3);
});

t('en la base no queda el correo ni la huella en claro; la llave tiene 32 bytes', async () => {
  const rows = (await pool.query(`SELECT kind, encode(digest, 'escape') AS raw, encode(digest, 'hex') AS hex FROM trial_claims`)).rows;
  for (const r of rows) for (const plain of ['pepelopez', 'g-pepe', 'fp_pepe']) assert.ok(!r.raw.includes(plain) && !r.hex.includes(plain), `${r.kind} en claro`);
  assert.equal((await pool.query(`SELECT length(value) AS n FROM system_keys WHERE name = 'trial_claims'`)).rows[0].n, 32);
});

t('una marca vencida no cuenta', async () => {
  const acc = (await pool.query(`INSERT INTO accounts (name) VALUES ('Vieja') RETURNING id`)).rows[0].id;
  await claims.recordTrialClaims({ accountId: acc, email: 'vieja@correo.mx', cardKey: 'fp_vieja', provider: 'stripe' });
  await pool.query(`UPDATE trial_claims SET expires_at = now() - interval '1 day' WHERE account_id = $1`, [acc]);
  assert.equal(await claims.trialAvailable({ email: 'vieja@correo.mx' }), true);
  assert.deepEqual(await claims.cardClaim('fp_vieja'), { claimed: false, disputed: false });
});
