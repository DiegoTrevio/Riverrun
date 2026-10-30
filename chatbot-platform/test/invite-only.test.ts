/**
 * Nadie escribe la contraseña de otro: al equipo se le invita y cada persona elige la suya al aceptar. Tampoco se cambia
 * la contraseña ni el correo de otra persona (ni el superadministrador): cada quien en Mi perfil.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-989-Qx-990-Kv';
const INVITE = 'Invita a la persona: ella elige su contraseña al aceptar';
const OWN = 'Cada persona cambia su contraseña y su correo en Mi perfil';
let acc: string;
let ivan: string;
let vera: Awaited<ReturnType<typeof h.loginAs>>;
const row = async (email: string) => (await pool.query(`SELECT id, email, password_hash, email_verified_at FROM users WHERE lower(email) = lower($1)`, [email])).rows[0];
const step = async () => h.authed('POST', '/api/2fa/step-up', { code: await h.codeFor('admin@test.mx') });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  acc = (await h.addAccount({ name: 'Estudio Vera', admin: { name: 'Vera', email: 'vera@estudio.mx', password: PASS } })).id;
  ivan = (await h.addUser({ account_id: acc, name: 'Iván', email: 'ivan@estudio.mx', password: PASS, role: 'agent' })).id;
  vera = await h.loginAs('vera@estudio.mx', PASS);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('crear un usuario con contraseña ya no existe: 410, también para el superadministrador y el dueño', async () => {
  await step();
  for (const [who, api] of [['superadmin', h.authed], ['dueña', vera]] as const) {
    for (const role of ['agent', 'admin', 'superadmin']) {
      const r = await api('POST', '/api/users', { account_id: role === 'superadmin' ? null : acc, name: 'X', email: `x-${role}@estudio.mx`, password: PASS, role });
      assert.equal(r.statusCode, 410, `${who} ${role}: ${r.body}`);
      assert.deepEqual(r.json(), { error: INVITE });
      assert.equal(await row(`x-${role}@estudio.mx`), undefined);
    }
  }
});

t('nadie cambia la contraseña ni el correo de otra persona, ni el superadministrador; lo demás sí', async () => {
  await step();
  const before = await row('ivan@estudio.mx');
  for (const [who, api] of [['superadmin', h.authed], ['dueña', vera]] as const) {
    for (const body of [{ password: 'Pz-987-Qx-988-Kv' }, { email: 'nuevo@estudio.mx' }, { name: 'Iván Ruiz', password: 'Pz-987-Qx-988-Kv' }]) {
      const r = await api('PUT', `/api/users/${ivan}`, body);
      assert.equal(r.statusCode, 400, `${who} ${JSON.stringify(body)}: ${r.body}`);
      assert.equal(r.json().error, OWN);
    }
  }
  assert.deepEqual(await row('ivan@estudio.mx'), before, 'ni su correo ni su contraseña cambiaron');
  assert.equal((await vera('PUT', `/api/users/${ivan}`, { name: 'Iván Ruiz' })).statusCode, 200);
});

t('una cuenta nueva con su dueño: le llega la invitación y al aceptarla queda como dueño (Review Focus 4)', async () => {
  await step();
  const r = await h.authed('POST', '/api/accounts', { name: 'Dulcería Mar', owner: { name: 'Marina', email: 'Marina@Dulceria.mx' } });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id;
  assert.equal(r.json().owner_user_id ?? null, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE account_id = $1`, [id])).rows[0].n, 0, 'nadie entra sin aceptar');
  const inv = (await pool.query(`SELECT email, name, role, invited_by FROM account_invitations WHERE account_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [id])).rows;
  assert.deepEqual(inv, [{ email: 'marina@dulceria.mx', name: 'Marina', role: 'admin', invited_by: null }]);
  const mail = [...outbox].reverse().find((m) => m.to === 'marina@dulceria.mx');
  assert.ok(mail, 'le llegó la invitación');
  assert.match(mail.text, /Dulcería Mar/);
  const token = decodeURIComponent(/#\/invitacion\?token=([^\s]+)/.exec(mail.text)![1]);
  const accepted = await h.app.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress: '10.88.0.1', payload: { token, name: 'Marina', password: PASS, accept_terms: true } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const marina = accepted.json().user;
  assert.equal(marina.role, 'admin');
  assert.equal((await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [id])).rows[0].owner_user_id, marina.id);
});

t('una cuenta con un correo que ya tiene usuario no se crea (ni a medias)', async () => {
  await step();
  const before = (await pool.query(`SELECT count(*)::int AS n FROM accounts`)).rows[0].n;
  const r = await h.authed('POST', '/api/accounts', { name: 'Repetida', owner: { email: 'VERA@estudio.mx' } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM accounts`)).rows[0].n, before);
});

t('con admin y contraseña ya no: 400 con el mismo texto y sin crear la cuenta', async () => {
  await step();
  const r = await h.authed('POST', '/api/accounts', { name: 'Con Clave', admin: { email: 'clave@cuenta.mx', password: PASS } });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error, INVITE);
  assert.equal((await pool.query(`SELECT 1 FROM accounts WHERE name = 'Con Clave'`)).rowCount, 0);
  assert.equal(await row('clave@cuenta.mx'), undefined);
});

t('un usuario creado sin decir si está verificado queda sin verificar; el superadministrador del arranque y el de admin-password, verificados', async () => {
  const u = await store.createUser({ account_id: acc, role: 'agent', name: '', email: 'sin-verificar@estudio.mx', password_hash: 'x' });
  assert.equal((await row(u.email)).email_verified_at, null);
  assert.ok((await row('admin@test.mx')).email_verified_at, 'el del arranque');
  const { resetSuperadminPassword } = await import('../src/auth.js');
  assert.equal((await resetSuperadminPassword('respaldo@test.mx', 'Pz-985-Qx-986-Kv')).created, true);
  assert.ok((await row('respaldo@test.mx')).email_verified_at, 'el de admin-password');
});

t('con SIGNUP_REQUIRE_EMAIL=false quien se registra queda verificado (lo apagó quien instala)', async () => {
  const prev = config.signup.requireEmail;
  config.signup.requireEmail = false;
  try {
    const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.88.0.2', payload: { name: 'Sol', company: 'Negocio Sol', business_type: 'servicios', email: 'sol@negocio-sol.mx', password: PASS, accept_terms: true } });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok((await row('sol@negocio-sol.mx')).email_verified_at);
  } finally {
    config.signup.requireEmail = prev;
  }
});
