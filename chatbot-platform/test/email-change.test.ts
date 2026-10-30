/**
 * Cambiar el correo: cada quien desde Mi perfil, con su contraseña actual y la verificación reciente, y el cambio se aplica al abrir el enlace
 * que llega al correo nuevo. Al confirmarlo queda verificado, los enlaces anteriores (restablecer, verificar) dejan de
 * servir y a la dirección anterior le llega el aviso. Si alguien tomó ese correo mientras tanto, no cambia nada.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-983-Qx-984-Kv';
let elsaId: string;
let elsa: Awaited<ReturnType<typeof h.loginAs>>;
const email = async () => (await pool.query(`SELECT email, email_verified_at, google_sub FROM users WHERE id = $1`, [elsaId])).rows[0];
const linkTo = (to: string) => {
  const mail = [...outbox].reverse().find((m) => m.to === to && /#\/cambiar-correo\//.test(m.text));
  assert.ok(mail, `sin enlace para ${to}`);
  return mail;
};
const tokenIn = (text: string) => /#\/cambiar-correo\/([A-Za-z0-9_-]+)/.exec(text)![1];
const confirm = (token: string) => h.app.inject({ method: 'POST', url: '/api/email-change/confirm', remoteAddress: '10.77.0.1', payload: { token } });
const step = async () => elsa('POST', '/api/2fa/step-up', { code: await h.codeFor('elsa@viejo.mx') });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  const acc = await h.addAccount({ name: 'Papelería Elsa', admin: { name: 'Elsa', email: 'elsa@viejo.mx', password: PASS } });
  elsaId = acc.admin!.id;
  await h.addUser({ account_id: acc.id, name: 'Otro', email: 'ocupado@correo.mx', password: PASS, role: 'agent' });
  await h.addUser({ account_id: acc.id, name: 'Iván', email: 'ivan@papeleria.mx', password: PASS, role: 'agent' });
  elsa = await h.loginAs('elsa@viejo.mx', PASS);
  await pool.query(`UPDATE users SET google_sub = 'g-elsa-123' WHERE id = $1`, [elsaId]);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('pedir el cambio pide la verificación reciente; un correo ocupado o el mismo no se aceptan', async () => {
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes' WHERE user_id = $1`, [elsaId]);
  assert.equal((await elsa('PUT', '/api/me/email', { email: 'elsa@nuevo.mx', current: PASS })).json().code, 'step_up');
  assert.equal((await step()).statusCode, 200);
  assert.deepEqual((await elsa('PUT', '/api/me/email', { email: 'OCUPADO@correo.mx', current: PASS })).json(), { error: 'Ese correo ya tiene una cuenta' });
  assert.equal((await elsa('PUT', '/api/me/email', { email: 'elsa@viejo.mx', current: PASS })).statusCode, 400);
  assert.equal((await elsa('PUT', '/api/me/email', { email: 'no-es-correo', current: PASS })).statusCode, 400);
  assert.equal((await email()).email, 'elsa@viejo.mx');
});

t('con la sesión sola no basta: pide la contraseña actual, y una equivocada cuenta como intento a la cuenta', async () => {
  assert.equal((await elsa('PUT', '/api/me/email', { email: 'robo@nuevo.mx' })).statusCode, 400, 'sin la contraseña');
  const wrong = await elsa('PUT', '/api/me/email', { email: 'robo@nuevo.mx', current: 'Otra-Contraseña-999' });
  assert.equal(wrong.statusCode, 400);
  assert.deepEqual(wrong.json(), { error: 'La contraseña actual no es correcta' });
  assert.equal((await pool.query(`SELECT hits FROM rate_limits WHERE key = 'login-acct:elsa@viejo.mx'`)).rows[0]?.hits, 1, 'cuenta como intento');
  assert.equal(outbox.filter((m) => m.to === 'robo@nuevo.mx').length, 0, 'no salió ningún enlace');
  await pool.query(`DELETE FROM rate_limits WHERE key = 'login-acct:elsa@viejo.mx'`);
});

t('preguntar por correos también cuenta para el tope: el sexto intento en una hora es 429 aunque el correo esté ocupado', async () => {
  const ivan = await h.loginAs('ivan@papeleria.mx', PASS);
  for (let i = 0; i < 5; i++) assert.equal((await ivan('PUT', '/api/me/email', { email: 'ocupado@correo.mx', current: PASS })).statusCode, 409);
  const sixth = await ivan('PUT', '/api/me/email', { email: 'ocupado@correo.mx', current: PASS });
  assert.equal(sixth.statusCode, 429, 'no dice si el correo tiene cuenta');
});

t('el enlace va al correo nuevo, al dominio principal; al abrirlo cambia, queda verificado, avisa al anterior y los enlaces viejos dejan de servir', async () => {
  const reset = await store.createAuthToken(elsaId, 'reset_password', 60);
  await pool.query(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [elsaId]);
  const r = await elsa('PUT', '/api/me/email', { email: 'Elsa@Nuevo.mx', current: PASS });
  assert.deepEqual(r.json(), { ok: true, pending: 'elsa@nuevo.mx' });
  assert.equal((await email()).email, 'elsa@viejo.mx', 'todavía no cambia');
  const mail = linkTo('elsa@nuevo.mx');
  assert.ok(mail.text.includes(`${config.publicBaseUrl}/#/cambiar-correo/`), mail.text);
  const sent = outbox.length;
  const done = await confirm(tokenIn(mail.text));
  assert.equal(done.statusCode, 200, done.body);
  const now = await email();
  assert.equal(now.email, 'elsa@nuevo.mx');
  assert.ok(now.email_verified_at, 'queda verificado');
  assert.equal(now.google_sub, 'g-elsa-123', 'entrar con Google sigue igual');
  const notice = outbox.slice(sent).find((m) => m.to === 'elsa@viejo.mx');
  assert.equal(notice?.subject, 'Cambiaste tu correo');
  assert.match(notice!.text, /El correo de tu cuenta cambió a elsa@nuevo\.mx el /);
  assert.match(notice!.text, /se pidió con tu contraseña/);
  assert.match(notice!.text, /entras con ese correo; si no fuiste tú, entra con él y vuelve a poner el tuyo desde Mi perfil/, 'qué hacer, aunque ya no entre con el correo de antes');
  const late = await h.app.inject({ method: 'POST', url: '/api/reset-password', remoteAddress: '10.77.0.2', payload: { token: reset, password: 'Pz-981-Qx-982-Kv' } });
  assert.equal(late.statusCode, 400, `el enlace de restablecer de antes ya no sirve: ${late.body}`);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'elsa@nuevo.mx', password: PASS } })).statusCode, 200, 'entra con el correo nuevo');
  assert.equal((await confirm(tokenIn(mail.text))).statusCode, 400, 'el mismo enlace no sirve dos veces');
});

t('un enlace vencido o inventado no sirve', async () => {
  h.totpSecrets.set('elsa@nuevo.mx', h.totpSecrets.get('elsa@viejo.mx')!); // el arnés guarda su app por correo
  elsa = await h.loginAs('elsa@nuevo.mx', PASS);
  assert.equal((await elsa('PUT', '/api/me/email', { email: 'elsa@otro.mx', current: PASS })).statusCode, 200);
  await pool.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND kind = 'change_email' AND used_at IS NULL`, [elsaId]);
  assert.equal((await confirm(tokenIn(linkTo('elsa@otro.mx').text))).statusCode, 400);
  assert.equal((await confirm('inventado')).statusCode, 400);
  assert.equal((await email()).email, 'elsa@nuevo.mx');
});

t('si alguien toma el correo antes de abrir el enlace, no cambia nada (Review Focus 3)', async () => {
  assert.equal((await elsa('PUT', '/api/me/email', { email: 'tomado@correo.mx', current: PASS })).statusCode, 200);
  const other = await h.addAccount({ name: 'Otra', admin: { name: 'Toma', email: 'tomado@correo.mx', password: PASS } });
  assert.ok(other.admin);
  const r = await confirm(tokenIn(linkTo('tomado@correo.mx').text));
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(r.json(), { error: 'Ese correo ya tiene una cuenta' });
  assert.equal((await email()).email, 'elsa@nuevo.mx');
});
