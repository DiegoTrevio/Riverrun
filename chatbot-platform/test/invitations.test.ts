/** Invitaciones de equipo: invitar por correo, unirse con contraseña o con Google, límites del plan y permisos. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

// Google falso (como en google-login.test.ts): devuelve el id_token con los datos de `claims`.
let claims: Record<string, unknown> = {};
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'a', expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y` }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'cs';
process.env.GOOGLE_OAUTH_URL = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.GOOGLE_AUTH_URL = 'https://accounts.example/auth';

type Api = Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
const A = { account: '', admin: null as unknown as Api, agent: null as unknown as Api };
const B = { account: '', admin: null as unknown as Api };
let outbox: { to: string; subject: string; text: string }[];

const tokenFor = (to: string) => {
  const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes('#/invitacion/'));
  assert.ok(mail, `sin invitación para ${to}`);
  return decodeURIComponent(/#\/invitacion\/([^\s]+)/.exec(mail.text)![1]);
};
/** Ver la invitación: `q` es `token=…` o `google=…` (va en el cuerpo, no en la URL). */
const info = (q: string, cookie?: string) =>
  h.app.inject({ method: 'POST', url: '/api/invitation/peek', remoteAddress: '10.9.0.1', headers: cookie ? { cookie } : {}, payload: Object.fromEntries(new URLSearchParams(q)) });
let ip = 0;
const accept = (body: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress: `10.9.1.${++ip}`, headers: { 'user-agent': 'Navegador de prueba' }, payload: { name: 'Persona', accept_terms: true, ...body } });

async function account(name: string, email: string) {
  const r = await h.addAccount({ name, admin: { name: `Admin ${name}`, email, password: 'Pz-144-Qx-344-Kv' } });
  return r.id as string;
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  outbox = (await import('../src/mailer.js')).outbox;
  A.account = await account('Taller Ana', 'ana@taller.mx');
  B.account = await account('Cuenta Beto', 'beto@otra.mx');
  A.admin = await h.loginAs('ana@taller.mx', 'Pz-144-Qx-344-Kv');
  B.admin = await h.loginAs('beto@otra.mx', 'Pz-144-Qx-344-Kv');
  await h.addUser({ account_id: A.account, name: 'Agente', email: 'agente@taller.mx', password: 'Pz-144-Qx-344-Kv', role: 'agent' });
  A.agent = await h.loginAs('agente@taller.mx', 'Pz-144-Qx-344-Kv');
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('invitar por correo y unirse eligiendo contraseña: queda en la cuenta, con su rol y la constancia de términos', async () => {
  const r = await A.admin('POST', '/api/invitations', { email: 'Lalo@Taller.mx', name: 'Lalo', role: 'admin' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().email, r.json().role], ['lalo@taller.mx', 'admin']);
  assert.ok(!r.body.includes('token'), 'la respuesta no trae el enlace');
  const mail = [...outbox].reverse().find((m) => m.to === 'lalo@taller.mx')!;
  assert.equal(mail.subject, '«Admin Taller Ana» te invitó a «Taller Ana»');
  assert.match(mail.text, /como administrador/);
  const token = tokenFor('lalo@taller.mx');

  const i = await info(`token=${encodeURIComponent(token)}`);
  assert.equal(i.statusCode, 200, i.body);
  assert.deepEqual([i.json().account, i.json().email, i.json().name, i.json().role, i.json().invited_by], ['Taller Ana', 'lalo@taller.mx', 'Lalo', 'admin', 'Admin Taller Ana']);

  assert.equal((await accept({ token, password: 'corta' })).statusCode, 400);
  assert.equal((await accept({ token, password: 'Pz-111-Qx-311-Kv', accept_terms: false })).statusCode, 400, 'sin aceptar términos');
  const done = await accept({ token, password: 'Pz-111-Qx-311-Kv', name: 'Lalo Ruiz' });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().mfa, 'enroll', 'configura su verificación antes de entrar');
  const me = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: await h.sessionFrom(done) } })).json();
  assert.deepEqual([me.user.email, me.user.role, me.user.account_id, me.user.name], ['lalo@taller.mx', 'admin', A.account, 'Lalo Ruiz']);
  const u = (await pool.query(`SELECT id, email_verified_at FROM users WHERE email = 'lalo@taller.mx'`)).rows[0];
  assert.ok(u.email_verified_at, 'el enlace del correo prueba que el correo es suyo');
  const terms = (await pool.query(`SELECT source, account_id, ip FROM terms_acceptances WHERE user_id = $1`, [u.id])).rows;
  assert.deepEqual(terms, [{ source: 'invite', account_id: A.account, ip: `10.9.1.${ip}` }]);
  const lalo = await h.loginAs('lalo@taller.mx', 'Pz-111-Qx-311-Kv');
  assert.equal((await lalo('GET', '/api/me')).statusCode, 200, 'entra con la contraseña que eligió');

  // El enlace ya se usó.
  assert.match((await accept({ token, password: 'Pz-155-Qx-355-Kv' })).json().error, /ya se usó/);
  assert.equal((await info(`token=${encodeURIComponent(token)}`)).statusCode, 400);
  assert.deepEqual((await A.admin('GET', '/api/invitations')).json(), [], 'ya no está pendiente');
});

t('reenviar invalida el enlace anterior; cancelar y vencer también; un enlace inventado no sirve', async () => {
  const inv = (await A.admin('POST', '/api/invitations', { email: 'mia@taller.mx' })).json();
  const first = tokenFor('mia@taller.mx');
  assert.equal((await A.admin('POST', `/api/invitations/${inv.id}/resend`)).statusCode, 200);
  const second = tokenFor('mia@taller.mx');
  assert.notEqual(first, second);
  assert.match((await info(`token=${encodeURIComponent(first)}`)).json().error, /no es válida/);
  assert.equal((await info(`token=${encodeURIComponent(second)}`)).statusCode, 200);

  await pool.query(`UPDATE account_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.id]);
  assert.match((await accept({ token: second, password: 'Pz-112-Qx-312-Kv' })).json().error, /venció/);
  // Invitar de nuevo al mismo correo reemplaza la vencida.
  const again = (await A.admin('POST', '/api/invitations', { email: 'mia@taller.mx' })).json();
  assert.equal((await pool.query(`SELECT count(*)::int n FROM account_invitations WHERE lower(email) = 'mia@taller.mx' AND revoked_at IS NULL AND accepted_at IS NULL`)).rows[0].n, 1);
  assert.equal((await A.admin('DELETE', `/api/invitations/${again.id}`)).statusCode, 200);
  assert.match((await accept({ token: tokenFor('mia@taller.mx'), password: 'Pz-112-Qx-312-Kv' })).json().error, /se canceló/);
  assert.equal((await accept({ token: 'inventado', password: 'Pz-112-Qx-312-Kv' })).statusCode, 400);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'mia@taller.mx'`)).rows[0].n, 0);
});

t('límite del plan: cuentan las invitaciones pendientes, y se revisa otra vez al aceptar', async () => {
  // Ana tiene 3 usuarios (Ana, agente y Lalo).
  assert.equal((await h.authed('PUT', `/api/accounts/${A.account}`, { limits_override: { users: 4 } })).statusCode, 200);
  assert.equal((await A.admin('POST', '/api/invitations', { email: 'nico@taller.mx' })).statusCode, 200);
  const full = await A.admin('POST', '/api/invitations', { email: 'olga@taller.mx' });
  assert.equal(full.statusCode, 403);
  assert.deepEqual(full.json().issues, ['limit_reached']);
  assert.match(full.json().error, /1 invitación pendiente/);
  // El plan bajó después de invitar: al aceptar ya no cabe.
  assert.equal((await h.authed('PUT', `/api/accounts/${A.account}`, { limits_override: { users: 3 } })).statusCode, 200);
  const late = await accept({ token: tokenFor('nico@taller.mx'), password: 'Pz-113-Qx-313-Kv' });
  assert.equal(late.statusCode, 403);
  assert.deepEqual(late.json().issues, ['limit_reached']);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'nico@taller.mx'`)).rows[0].n, 0);
  assert.equal((await h.authed('PUT', `/api/accounts/${A.account}`, { limits_override: {} })).statusCode, 200);
  assert.equal((await accept({ token: tokenFor('nico@taller.mx'), password: 'Pz-113-Qx-313-Kv' })).statusCode, 200, 'con lugar, la misma invitación sirve');
});

t('correos que ya tienen cuenta o temporales no se invitan; agentes y otras cuentas no pueden', async () => {
  const taken = await A.admin('POST', '/api/invitations', { email: 'beto@otra.mx' });
  assert.equal(taken.statusCode, 409);
  assert.match(taken.json().error, /ya tiene cuenta/);
  assert.equal((await A.admin('POST', '/api/invitations', { email: 'x@mailinator.com' })).statusCode, 400);
  assert.equal((await A.admin('POST', '/api/invitations', { email: 'no-es-correo' })).statusCode, 400);
  assert.equal((await A.agent('POST', '/api/invitations', { email: 'pepe@taller.mx' })).statusCode, 403);
  assert.equal((await A.agent('GET', '/api/invitations')).statusCode, 403);

  const inv = (await A.admin('POST', '/api/invitations', { email: 'quique@taller.mx' })).json();
  assert.deepEqual((await B.admin('GET', '/api/invitations')).json(), [], 'cada cuenta ve solo las suyas');
  assert.equal((await B.admin('DELETE', `/api/invitations/${inv.id}`)).statusCode, 404);
  assert.equal((await B.admin('POST', `/api/invitations/${inv.id}/resend`)).statusCode, 404);
  assert.equal((await B.admin('GET', `/api/invitations?account_id=${A.account}`)).json().length, 0, 'pedir otra cuenta no sirve');
  // El superadmin invita a la cuenta que elige.
  assert.equal((await h.authed('POST', `/api/invitations?account_id=${B.account}`, { email: 'rosa@otra.mx' })).statusCode, 200);
  assert.deepEqual((await B.admin('GET', '/api/invitations')).json().map((i: any) => i.email), ['rosa@otra.mx']);

  // Si alguien registra ese correo antes de aceptar, la invitación ya no crea otro usuario.
  await h.addUser({ account_id: B.account, name: 'Quique', email: 'quique@taller.mx', password: 'Pz-144-Qx-344-Kv', role: 'agent' });
  assert.equal((await accept({ token: tokenFor('quique@taller.mx'), password: 'Pz-114-Qx-314-Kv' })).statusCode, 409);
});

t('con Google: un correo invitado se une a su equipo (aunque el registro público esté cerrado)', async () => {
  assert.equal((await A.admin('POST', '/api/invitations', { email: 'sofi@taller.mx', role: 'agent' })).statusCode, 200);
  const { config } = await import('../src/config.js');
  const enabled = config.signup.enabled;
  Object.assign(config.signup, { enabled: false });
  try {
    claims = { sub: 'g-sofi', email: 'Sofi@Taller.mx', email_verified: true, name: 'Sofía' };
    const start = await h.app.inject({ method: 'GET', url: '/oauth/google/login', remoteAddress: '10.9.2.1' });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const nonce = start.cookies.find((c) => c.name === 'g_nonce')!.value;
    const back = await h.app.inject({ method: 'GET', url: `/oauth/google/login/callback?code=abc&state=${encodeURIComponent(state)}`, remoteAddress: '10.9.2.1', headers: { cookie: `g_nonce=${nonce}` } });
    const location = String(back.headers.location);
    assert.match(location, /^\/#\/invitacion\/google\//);
    const pass = decodeURIComponent(location.split('/invitacion/google/')[1]);
    const gpass = back.cookies.find((c) => c.name === 'cp_gpass');
    assert.ok(gpass?.httpOnly && gpass.sameSite === 'Strict', 'el pase queda ligado a este navegador');
    const cookie = `cp_gpass=${gpass!.value}`;
    const viaGoogle = (body: Record<string, unknown>, c = cookie) =>
      h.app.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress: `10.9.2.${++ip}`, headers: c ? { cookie: c } : {}, payload: { accept_terms: true, ...body } });

    assert.equal((await info(`google=${encodeURIComponent(pass)}`)).statusCode, 401, 'en otro navegador (sin su cookie) no sirve');
    const i = (await info(`google=${encodeURIComponent(pass)}`, cookie)).json();
    assert.deepEqual([i.account, i.email, i.name, i.via_google], ['Taller Ana', 'sofi@taller.mx', 'Sofía', true]);
    assert.equal((await viaGoogle({ google: pass, name: 'Sofía' }, '')).statusCode, 401, 'ni al aceptar');
    const done = await viaGoogle({ google: pass, name: 'Sofía' });
    assert.equal(done.statusCode, 200, done.body);
    const u = (await pool.query(`SELECT account_id, role, google_sub FROM users WHERE email = 'sofi@taller.mx'`)).rows[0];
    assert.deepEqual([u.account_id, u.role, u.google_sub], [A.account, 'agent', 'g-sofi']);
    assert.equal((await viaGoogle({ google: pass, name: 'Sofía' })).statusCode, 400, 'el pase ya no tiene invitación pendiente');
  } finally {
    Object.assign(config.signup, { enabled });
  }
  // Un pase de Google sin invitación pendiente no sirve.
  const { googleSignupPass } = await import('../src/signup-guard.js');
  const lone = googleSignupPass({ email: 'nadie@taller.mx', name: 'X', sub: 'g-nadie' }, 'navegador-1');
  const r = await h.app.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress: '10.9.3.1', headers: { cookie: 'cp_gpass=navegador-1' }, payload: { google: lone, name: 'X', accept_terms: true } });
  assert.equal(r.statusCode, 400);
});

t('la lista de pendientes sugiere invitar y avisa las invitaciones por aceptar', async () => {
  await account('Cuenta Nueva', 'tere@nueva.mx');
  const admin = await h.loginAs('tere@nueva.mx', 'Pz-144-Qx-344-Kv');
  const team = async () => (await admin('GET', '/api/onboarding/checklist')).json().items.find((i: any) => i.key === 'team');
  let step = await team();
  assert.deepEqual([step.label, step.action, step.done], ['Invita a tu equipo', 'Invitar', false]);
  assert.equal((await admin('POST', '/api/invitations', { email: 'uli@nueva.mx' })).statusCode, 200);
  step = await team();
  assert.equal(step.hint, 'Tienes 1 invitación por aceptar.');
  assert.equal((await accept({ token: tokenFor('uli@nueva.mx'), password: 'Pz-115-Qx-315-Kv' })).statusCode, 200);
  step = await team();
  assert.equal(step.done, true);
});
