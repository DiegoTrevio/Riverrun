/**
 * Invitaciones con límites: solo invita quien tiene su correo verificado (y con el del dueño verificado), con topes por
 * cuenta y por correo, y a lo más 50 pendientes. El correo tiene texto fijo: los nombres van limpios y entre «». El
 * token va en la ruta del panel y en el cuerpo de las peticiones, no en la URL de la API.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
let h: Awaited<ReturnType<typeof createHarness>>;
type Api = Awaited<ReturnType<typeof h.loginAs>>;

const PASS = 'Pz-975-Qx-976-Kv';
let acc: string;
let paula: Api;
let quino: Api;
const verified = (email: string, yes: boolean) => pool.query(`UPDATE users SET email_verified_at = ${yes ? 'now()' : 'NULL'} WHERE email = $1`, [email]);
const invite = (api: Api | typeof h.authed, email: string, q = '') => api('POST', `/api/invitations${q}`, { email, role: 'agent' });
/** Una cuenta aparte con su dueño y lugar para mucha gente (el tope de usuarios no estorba). */
async function roomy(name: string, email: string) {
  const a = await h.addAccount({ name, admin: { name: 'Dueña', email, password: PASS } });
  await h.authed('PUT', `/api/accounts/${a.id}`, { limits_override: { users: 200 } });
  return { id: a.id, api: await h.loginAs(email, PASS) };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  acc = (await h.addAccount({ name: 'Estudio Paula', admin: { name: 'Paula', email: 'paula@estudio-inv.mx', password: PASS } })).id;
  await h.authed('PUT', `/api/accounts/${acc}`, { limits_override: { users: 200 } });
  await h.addUser({ account_id: acc, name: 'Quino', email: 'quino@estudio-inv.mx', password: PASS, role: 'admin' });
  paula = await h.loginAs('paula@estudio-inv.mx', PASS);
  quino = await h.loginAs('quino@estudio-inv.mx', PASS);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('cleanInviteName quita saltos, enlaces y dominios, junta espacios y corta a 60', async () => {
  const { cleanInviteName } = await import('../src/identity/invite-text.js');
  assert.equal(cleanInviteName('Ana\nVisita https://malo.mx'), 'Ana Visita');
  assert.equal(cleanInviteName('www.malo.mx Pedro'), 'Pedro');
  assert.equal(cleanInviteName('Paga en banco-falso.com'), 'Paga en');
  assert.equal(cleanInviteName('PAGA EN Banco-Falso.COM.mx ya'), 'PAGA EN ya');
  assert.equal(cleanInviteName('x'.repeat(200)).length, 60);
});

t('sin SMTP responde mail_sent: false; el correo trae el texto fijo, los nombres entre «» y el enlace en la ruta', async () => {
  const r = await paula('POST', '/api/invitations', { email: 'uno@inv.mx', name: 'Ana\nVisita https://malo.mx', role: 'agent' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().mail_sent, false);
  const mail = [...outbox].reverse().find((m) => m.to === 'uno@inv.mx')!;
  assert.equal(mail.subject, '«Paula» te invitó a «Estudio Paula»');
  assert.match(mail.text, /^Hola «Ana Visita»,\n\n«Paula» te invitó a unirte a «Estudio Paula» como agente\./);
  assert.doesNotMatch(mail.text, /malo\.mx/);
  assert.ok(mail.text.includes(`${config.publicBaseUrl}/#/invitacion/`), mail.text);
  assert.doesNotMatch(mail.text, /invitacion\?token=/);
  const resent = await paula('POST', `/api/invitations/${r.json().id}/resend`);
  assert.equal(resent.statusCode, 200, resent.body);
  assert.equal(resent.json().mail_sent, false);
});

t('sin correo verificado no se invita (quien invita, o el dueño); el superadministrador sí', async () => {
  await verified('quino@estudio-inv.mx', false);
  assert.deepEqual((await invite(quino, 'dos@inv.mx')).json(), { error: 'Verifica tu correo antes de invitar a alguien' });
  await verified('quino@estudio-inv.mx', true);
  await verified('paula@estudio-inv.mx', false);
  assert.deepEqual((await invite(quino, 'dos@inv.mx')).json(), { error: 'El dueño de la cuenta tiene que verificar su correo antes de invitar a alguien' });
  assert.deepEqual((await invite(paula, 'dos@inv.mx')).json(), { error: 'Verifica tu correo antes de invitar a alguien' });
  const pending = (await pool.query(`SELECT id FROM account_invitations WHERE account_id = $1 AND email = 'uno@inv.mx' AND revoked_at IS NULL`, [acc])).rows[0].id;
  assert.equal((await paula('POST', `/api/invitations/${pending}/resend`)).statusCode, 403, 'tampoco reenviar');
  assert.equal((await invite(h.authed, 'dos@inv.mx', `?account_id=${acc}`)).statusCode, 200, 'el superadministrador queda exento');
  await verified('paula@estudio-inv.mx', true);
});

t('a lo más 20 invitaciones por día por cuenta', async () => {
  const a = await roomy('Tope Diario', 'tope@inv.mx');
  for (let i = 0; i < 20; i++) assert.equal((await invite(a.api, `p${i}@tope.mx`)).statusCode, 200, `invitación ${i + 1}`);
  const r = await invite(a.api, 'p20@tope.mx');
  assert.equal(r.statusCode, 429);
  assert.deepEqual(r.json(), { error: 'Llegaste al límite de 20 invitaciones por día' });
});

t('al mismo correo, a lo más 3 veces por día', async () => {
  const a = await roomy('Mismo Correo', 'mismo@inv.mx');
  for (let i = 0; i < 3; i++) assert.equal((await invite(a.api, 'repetido@inv.mx')).statusCode, 200, `vez ${i + 1}`);
  const r = await invite(a.api, 'repetido@inv.mx');
  assert.equal(r.statusCode, 429);
  assert.deepEqual(r.json(), { error: 'Ya invitaste a ese correo 3 veces hoy' });
});

t('con 50 pendientes no se invita a más', async () => {
  const a = await roomy('Muchas Pendientes', 'pendientes@inv.mx');
  for (let i = 0; i < 50; i++) {
    await pool.query(`INSERT INTO account_invitations (account_id, email, role, token_hash, expires_at) VALUES ($1, $2, 'agent', $3, now() + interval '7 days')`, [a.id, `q${i}@pend.mx`, `hash-${a.id}-${i}`]);
  }
  const r = await invite(a.api, 'una-mas@pend.mx');
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json(), { error: 'Hay 50 invitaciones pendientes: cancela alguna antes de invitar a más' });
});

t('el token va en el cuerpo: GET /api/invitation ya no existe y peek responde lo mismo', async () => {
  const before = outbox.length;
  assert.equal((await invite(paula, 'peek@inv.mx')).statusCode, 200);
  const mail = outbox.slice(before).find((m) => m.to === 'peek@inv.mx')!;
  const token = decodeURIComponent(/#\/invitacion\/([^\s]+)/.exec(mail.text)![1]);
  assert.equal((await h.app.inject({ method: 'GET', url: `/api/invitation?token=${encodeURIComponent(token)}`, remoteAddress: '10.66.0.1' })).statusCode, 404);
  const peek = await h.app.inject({ method: 'POST', url: '/api/invitation/peek', remoteAddress: '10.66.0.1', payload: { token } });
  assert.equal(peek.statusCode, 200, peek.body);
  assert.deepEqual([peek.json().account, peek.json().email, peek.json().role, peek.json().invited_by, peek.json().via_google], ['Estudio Paula', 'peek@inv.mx', 'agent', 'Paula', false]);
});
