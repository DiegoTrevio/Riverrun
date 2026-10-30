/**
 * Transferir la cuenta: el dueño la pasa a otro administrador activo de la cuenta con su correo verificado y su
 * verificación en dos pasos. Queda en la bitácora y se avisa a los dos. Desde ese momento el anterior ya no maneja el
 * dinero ni la cuenta, aunque siga con la misma sesión (sigue como administrador).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
let h: Awaited<ReturnType<typeof createHarness>>;
type Api = Awaited<ReturnType<typeof h.loginAs>>;

const PASS = 'Pz-993-Qx-994-Kv';
const NOT_ELIGIBLE = 'Solo puedes transferirla a un administrador con su correo verificado y su verificación en dos pasos activa';
let acc: string;
const ids: Record<string, string> = {};
let lupe: Api;
let memo: Api;
const ownerId = async () => (await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [acc])).rows[0].owner_user_id;
const transfer = (api: Api | typeof h.authed, userId: string, q = '') => api('POST', `/api/account/transfer${q}`, { user_id: userId });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  acc = (await h.addAccount({ name: 'Panadería Luna', admin: { name: 'Lupe', email: 'lupe@luna.mx', password: PASS } })).id;
  const other = (await h.addAccount({ name: 'Otra', admin: { name: 'Rita', email: 'rita@otra.mx', password: PASS } })).id;
  for (const [name, email, role, account] of [
    ['Memo', 'memo@luna.mx', 'admin', acc], ['Nora', 'nora@luna.mx', 'admin', acc], ['Olga', 'olga@luna.mx', 'admin', acc],
    ['Pepe', 'pepe@luna.mx', 'agent', acc], ['Quique', 'quique@luna.mx', 'admin', acc],
  ] as const) {
    const r = await h.addUser({ account_id: account, name, email, password: PASS, role });
  }
  for (const r of (await pool.query(`SELECT id, email FROM users WHERE account_id IN ($1, $2)`, [acc, other])).rows) ids[r.email] = r.id;
  lupe = await h.loginAs('lupe@luna.mx', PASS);
  memo = await h.loginAs('memo@luna.mx', PASS);
  // Con su 2FA activa (entraron una vez); a Olga le falta el correo verificado y Quique está desactivado. Nora nunca entró.
  for (const email of ['olga@luna.mx', 'pepe@luna.mx', 'quique@luna.mx', 'rita@otra.mx']) await h.loginAs(email, PASS);
  await pool.query(`UPDATE users SET email_verified_at = NULL WHERE email = 'olga@luna.mx'`);
  await pool.query(`UPDATE users SET active = false WHERE email = 'quique@luna.mx'`);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('solo a un administrador activo de la cuenta con su correo verificado y su 2FA; a nadie más', async () => {
  assert.equal(await ownerId(), ids['lupe@luna.mx']);
  for (const email of ['pepe@luna.mx', 'quique@luna.mx', 'nora@luna.mx', 'olga@luna.mx']) {
    const r = await transfer(lupe, ids[email]);
    assert.equal(r.statusCode, 400, `${email}: ${r.body}`);
    assert.equal(r.json().error, NOT_ELIGIBLE, email);
  }
  for (const id of [ids['rita@otra.mx'], crypto.randomUUID()]) assert.equal((await transfer(lupe, id)).statusCode, 404);
  assert.deepEqual((await transfer(lupe, ids['lupe@luna.mx'])).json(), { error: 'Ya eres el dueño' });
  assert.equal(await ownerId(), ids['lupe@luna.mx'], 'nada cambió');
});

t('un administrador que no es dueño no la transfiere; sin verificación reciente se pide el código', async () => {
  assert.equal((await transfer(memo, ids['memo@luna.mx'])).json().code, 'owner_only');
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes' WHERE user_id = $1`, [ids['lupe@luna.mx']]);
  assert.equal((await transfer(lupe, ids['memo@luna.mx'])).json().code, 'step_up');
  assert.equal((await lupe('POST', '/api/2fa/step-up', { code: await h.codeFor('lupe@luna.mx') })).statusCode, 200);
  assert.equal(await ownerId(), ids['lupe@luna.mx']);
});

t('el dueño la transfiere: cambia el dueño, queda en la bitácora, avisa a los dos y el anterior pierde lo del dueño con su misma sesión', async () => {
  const sent = outbox.length;
  const r = await transfer(lupe, ids['memo@luna.mx']);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await ownerId(), ids['memo@luna.mx']);
  const mails = outbox.slice(sent);
  const toLupe = mails.find((m) => m.to === 'lupe@luna.mx');
  const toMemo = mails.find((m) => m.to === 'memo@luna.mx');
  assert.equal(toLupe?.subject, 'Transferiste tu cuenta');
  assert.match(toLupe!.text, /Transferiste la cuenta «Panadería Luna» a Memo el .+\. Sigues como administrador\./);
  assert.equal(toMemo?.subject, 'Ahora eres dueño de la cuenta');
  assert.match(toMemo!.text, /Lupe te transfirió la cuenta «Panadería Luna» el .+\. Revisa los datos de facturación en Mi plan\./);
  const logged = await pool.query(`SELECT message FROM event_logs WHERE account_id = $1 AND message LIKE '%transfirió la cuenta%'`, [acc]);
  assert.equal(logged.rowCount, 1);
  assert.match(logged.rows[0].message, /lupe@luna\.mx transfirió la cuenta a memo@luna\.mx/);

  // Review Focus 2: la sesión de Lupe sigue abierta, pero lo del dueño ya no es suyo.
  const late = await lupe('POST', '/api/billing/change', { plan: 'pro' });
  assert.deepEqual(late.json(), { error: 'Solo el dueño de la cuenta (Memo) puede hacer esto', code: 'owner_only' });
  assert.equal((await lupe('GET', '/api/users')).statusCode, 200, 'sigue como administradora');
  assert.equal((await memo('GET', '/api/me')).json().owner.id, ids['memo@luna.mx']);
});

t('el superadministrador la reasigna con ?account_id', async () => {
  await h.authed('POST', '/api/2fa/step-up', { code: await h.codeFor('admin@test.mx') });
  assert.equal((await transfer(h.authed, ids['lupe@luna.mx'])).statusCode, 400, 'sin cuenta elegida');
  const sent = outbox.length;
  const r = await transfer(h.authed, ids['lupe@luna.mx'], `?account_id=${acc}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await ownerId(), ids['lupe@luna.mx']);
  const toMemo = outbox.slice(sent).find((m) => m.to === 'memo@luna.mx');
  assert.match(toMemo!.text, /transfirió la cuenta «Panadería Luna» a Lupe/, 'al anterior le dice quién la transfirió');
  assert.doesNotMatch(toMemo!.text, /^Hola Memo,\n\nTransferiste/);
  assert.deepEqual((await transfer(h.authed, ids['lupe@luna.mx'], `?account_id=${acc}`)).json(), { error: 'Ya es el dueño de la cuenta' });
});
