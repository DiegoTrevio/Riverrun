/**
 * `./riverrun rotate-secret` cambia SESSION_SECRET: antes, los secretos de la verificación en dos pasos (los activos y los
 * pendientes) se vuelven a cifrar con el nuevo, todos o ninguno.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { decryptSecret } = await import('../src/secret.js');
const { rekeyMfaSecrets } = await import('../src/cli/rekey-mfa.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-993-Qx-994-Kv';
const NEW = 'secreto-nuevo-de-la-plataforma-0123456789';
const rows = async () => (await pool.query(`SELECT email, totp_secret, totp_pending FROM users WHERE totp_secret IS NOT NULL OR totp_pending IS NOT NULL ORDER BY email`)).rows;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const email of ['lia@clave.mx', 'max@clave.mx']) {
    await h.addUser({ account_id: h.accountId, name: email, email, password: PASS, role: 'admin' });
    await h.loginAs(email, PASS);
  }
  // Max empezó a cambiar de app: su secreto pendiente también se re-cifra.
  const max = await h.loginAs('max@clave.mx', PASS);
  assert.equal((await max('POST', '/api/me/2fa/authenticator')).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('si uno no se puede descifrar, no cambia ninguno', async () => {
  const before = await rows();
  const lia = before.find((r) => r.email === 'lia@clave.mx')!;
  await pool.query(`UPDATE users SET totp_secret = 'v1.dañado.dañado.dañado' WHERE email = 'lia@clave.mx'`);
  await assert.rejects(() => rekeyMfaSecrets(NEW), /^Error: No se pudo re-cifrar el 2FA de 1 persona: no se cambió nada$/);
  const afterRows = await rows();
  for (const r of before.filter((x) => x.email !== 'lia@clave.mx')) assert.deepEqual(afterRows.find((x) => x.email === r.email), r);
  await pool.query(`UPDATE users SET totp_secret = $1 WHERE email = 'lia@clave.mx'`, [lia.totp_secret]);
});

t('re-cifra los activos y los pendientes con el secreto nuevo', async () => {
  const before = await rows();
  assert.ok(before.length >= 3, 'el superadmin, Lía y Max');
  const plain = before.map((r) => ({ email: r.email, secret: decryptSecret(r.totp_secret), pending: r.totp_pending && decryptSecret(r.totp_pending) }));
  assert.ok(plain.every((p) => p.secret), 'hoy se leen con el secreto actual');
  assert.ok(plain.find((p) => p.email === 'max@clave.mx')!.pending);
  assert.equal(await rekeyMfaSecrets(NEW), before.length);
  for (const r of await rows()) {
    const p = plain.find((x) => x.email === r.email)!;
    assert.equal(decryptSecret(r.totp_secret, NEW), p.secret, r.email);
    assert.equal(decryptSecret(r.totp_secret), null, `${r.email}: ya no con el anterior`);
    assert.equal(r.totp_pending && decryptSecret(r.totp_pending, NEW), p.pending, r.email);
  }
});
