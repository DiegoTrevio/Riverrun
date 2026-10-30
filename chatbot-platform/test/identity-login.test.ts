/**
 * Verificación en dos pasos obligatoria: ninguna puerta (contraseña, registro, invitación, restablecer) abre sesión sin el
 * código. La primera vez se configura la app (QR + 10 códigos de recuperación); después se pide el código, que sirve una
 * sola vez, con 5 intentos por reto.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { currentStep, totpAt } = await import('../src/identity/totp.js');
const { hmac } = await import('../src/secret.js');
const { outbox } = await import('../src/mailer.js');
let h: Awaited<ReturnType<typeof createHarness>>;

let ip = 0;
const cookieOf = (r: any, name: string) => [r.headers['set-cookie'] ?? []].flat().map(String).find((c: string) => c.startsWith(`${name}=`))?.split(';')[0];
const login = (email: string, password: string) => h.app.inject({ method: 'POST', url: '/api/login', remoteAddress: `10.61.0.${++ip}`, payload: { email, password } });
const get = (url: string, cookie: string) => h.app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, cookie: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as any });
const challenge = async (email: string, password: string) => cookieOf(await login(email, password), 'cp_mfa')!;
const resetStep = (email: string) => pool.query(`UPDATE users SET totp_last_step = 0 WHERE email = $1`, [email]);
/** La misma cookie de reto con otros datos, firmada como la firma el servidor. */
const resign = (cookie: string, patch: Record<string, unknown>) => {
  const data = { ...JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString()), ...patch };
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `cp_mfa=${payload}.${hmac(`mfa-challenge:${payload}`)}`;
};
const PASS = 'Pz-931-Qx-932-Kv';
const newUser = async (email: string, role = 'agent') => {
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Persona', email, password: PASS, role });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().id as string;
};
/** Configura el 2FA de alguien por la API y devuelve su secreto y sus códigos. */
const enroll = async (email: string) => {
  const c = await challenge(email, PASS);
  const { secret } = (await get('/api/2fa/enroll', c)).json();
  const r = await post('/api/2fa/enroll', c, { code: totpAt(secret, currentStep()) });
  assert.equal(r.statusCode, 200, r.body);
  return { secret: secret as string, codes: r.json().recovery_codes as string[] };
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('contraseña: sin código no hay sesión; la primera vez pide configurar', async () => {
  await newUser('nuevo@login.mx');
  const r = await login('nuevo@login.mx', PASS);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { mfa: 'enroll' });
  assert.equal(cookieOf(r, 'cp_session'), undefined);
  assert.ok(cookieOf(r, 'cp_mfa'));
  assert.equal((await get('/api/me', cookieOf(r, 'cp_mfa')!)).statusCode, 401, 'el reto no es una sesión');
  assert.equal((await login('nuevo@login.mx', 'otra-clave-que-no-es')).statusCode, 401);
});

t('configurar: QR, mismo secreto al recargar, 10 códigos y sesión', async () => {
  const c = await challenge('nuevo@login.mx', PASS);
  const a = (await get('/api/2fa/enroll', c)).json();
  const b = (await get('/api/2fa/enroll', c)).json();
  assert.equal(a.secret, b.secret, 'recargar o abrir otra pestaña muestra el mismo QR');
  assert.equal(a.account, 'nuevo@login.mx');
  assert.match(a.otpauth, /^otpauth:\/\/totp\//);
  assert.match(a.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal((await post('/api/2fa/enroll', c, { code: '000000' })).json().error, 'El código no es correcto');
  const r = await post('/api/2fa/enroll', c, { code: totpAt(a.secret, currentStep()) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().recovery_codes.length, 10);
  assert.equal(new Set(r.json().recovery_codes).size, 10);
  assert.match(r.json().recovery_codes[0], /^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
  const session = cookieOf(r, 'cp_session')!;
  assert.ok(session);
  assert.equal(cookieOf(r, 'cp_mfa'), 'cp_mfa=', 'el reto se borra');
  const me = await get('/api/me', session);
  assert.equal(me.statusCode, 200);
  assert.doesNotMatch(me.body + r.body.replace(/"recovery_codes":\[[^\]]*\]/, ''), /totp|password_hash/);
  const row = (await pool.query(`SELECT totp_secret, totp_pending, totp_enabled_at FROM users WHERE email = 'nuevo@login.mx'`)).rows[0];
  assert.ok(row.totp_enabled_at);
  assert.equal(row.totp_pending, null);
  assert.ok(!row.totp_secret.includes(a.secret), 'el secreto se guarda cifrado');
  await waitFor(() => outbox.some((m) => m.to === 'nuevo@login.mx' && m.subject === 'Activaste la verificación en dos pasos'), 3000);
  assert.equal((await post('/api/2fa/enroll', c, { code: totpAt(a.secret, currentStep()) })).statusCode, 401, 'el reto ya se usó');
});

t('verificar: el mismo código no sirve dos veces; dos peticiones a la vez, solo una entra', async () => {
  await newUser('dos@login.mx');
  const { secret } = await enroll('dos@login.mx');
  const r = await login('dos@login.mx', PASS);
  assert.deepEqual(r.json(), { mfa: 'verify' });
  const c = cookieOf(r, 'cp_mfa')!;
  // El paso usado queda anotado: ese código (o uno anterior) ya no sirve aunque siga en la ventana de tiempo.
  const step = currentStep();
  await pool.query(`UPDATE users SET totp_last_step = $1 WHERE email = 'dos@login.mx'`, [step]);
  assert.equal((await post('/api/login/2fa', c, { code: totpAt(secret, step) })).statusCode, 400, 'el código ya usado no sirve');
  const good = await post('/api/login/2fa', c, { code: totpAt(secret, step + 1) });
  assert.equal(good.statusCode, 200, good.body);
  assert.ok(cookieOf(good, 'cp_session'));
  assert.equal(good.json().user.email, 'dos@login.mx');
  await resetStep('dos@login.mx');
  const [c1, c2] = [await challenge('dos@login.mx', PASS), await challenge('dos@login.mx', PASS)];
  const code = totpAt(secret, currentStep());
  const both = await Promise.all([post('/api/login/2fa', c1, { code }), post('/api/login/2fa', c2, { code })]);
  assert.deepEqual(both.map((x) => x.statusCode).sort(), [200, 400]);
});

t('cinco códigos malos agotan el reto', async () => {
  await newUser('cinco@login.mx');
  const { secret } = await enroll('cinco@login.mx');
  await resetStep('cinco@login.mx');
  const c = await challenge('cinco@login.mx', PASS);
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/login/2fa', c, { code: '111111' })).statusCode, 400);
  const r = await post('/api/login/2fa', c, { code: totpAt(secret, currentStep()) });
  assert.equal(r.statusCode, 401);
  assert.deepEqual(r.json(), { error: 'Vuelve a escribir tu contraseña para continuar', code: 'challenge_expired' });
});

t('código de recuperación en mayúsculas y con O por 0; sirve una vez y avisa por correo', async () => {
  await newUser('rec@login.mx');
  const { codes } = await enroll('rec@login.mx');
  const typed = codes[0].toUpperCase().replaceAll('0', 'O').replace('-', ' ');
  const r = await post('/api/login/2fa', await challenge('rec@login.mx', PASS), { code: typed });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().recovery_remaining, 9);
  await waitFor(() => outbox.some((m) => m.to === 'rec@login.mx' && m.subject === 'Usaste un código de recuperación'), 3000);
  assert.equal((await post('/api/login/2fa', await challenge('rec@login.mx', PASS), { code: codes[0] })).statusCode, 400, 'ya se usó');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM user_recovery_codes c JOIN users u ON u.id = c.user_id WHERE u.email = 'rec@login.mx' AND c.used_at IS NULL`)).rows[0].n, 9);
});

t('reto vencido: challenge_expired, y el secreto pendiente sigue sirviendo al volver a entrar', async () => {
  await newUser('tarde@login.mx');
  const c = await challenge('tarde@login.mx', PASS);
  const { secret } = (await get('/api/2fa/enroll', c)).json();
  const old = resign(c, { exp: Date.now() - 1000 });
  assert.deepEqual((await get('/api/2fa/enroll', old)).json(), { error: 'Vuelve a escribir tu contraseña para continuar', code: 'challenge_expired' });
  assert.equal((await post('/api/2fa/enroll', old, { code: totpAt(secret, currentStep()) })).statusCode, 401);
  const again = await challenge('tarde@login.mx', PASS);
  assert.equal((await get('/api/2fa/enroll', again)).json().secret, secret, 'el QR que ya escaneó sigue sirviendo');
  assert.equal((await post('/api/2fa/enroll', again, { code: totpAt(secret, currentStep()) })).statusCode, 200);
  assert.equal((await post('/api/login/2fa', `${again.slice(0, -2)}xx`, { code: '123456' })).statusCode, 401, 'un reto con la firma alterada no vale');
});

t('si la desactivan o cambia su contraseña entre la contraseña y el código, el reto ya no abre sesión', async () => {
  const id = await newUser('cambia@login.mx');
  const { secret } = await enroll('cambia@login.mx');
  await resetStep('cambia@login.mx');
  const c = await challenge('cambia@login.mx', PASS);
  assert.equal((await h.authed('PUT', `/api/users/${id}`, { active: false })).statusCode, 200);
  assert.equal((await post('/api/login/2fa', c, { code: totpAt(secret, currentStep()) })).statusCode, 401);
  assert.equal((await h.authed('PUT', `/api/users/${id}`, { active: true })).statusCode, 200);
  await resetStep('cambia@login.mx');
  const c2 = await challenge('cambia@login.mx', PASS);
  assert.equal((await h.authed('PUT', `/api/users/${id}`, { password: 'Pz-933-Qx-934-Kv' })).statusCode, 200);
  assert.equal((await post('/api/login/2fa', c2, { code: totpAt(secret, currentStep()) })).statusCode, 401);
});

t('registro e invitación piden configurar antes de abrir sesión', async () => {
  const s = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.62.0.1', payload: { name: 'Rita', company: 'Taller Rita', business_type: 'servicios', email: 'rita@taller.mx', password: PASS, accept_terms: true } });
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().mfa, 'enroll');
  assert.ok(s.json().account.id, 'la cuenta ya existe');
  assert.equal(cookieOf(s, 'cp_session'), undefined);
  assert.ok(cookieOf(s, 'cp_mfa'));
  assert.equal((await get('/api/2fa/enroll', cookieOf(s, 'cp_mfa')!)).json().account, 'rita@taller.mx');

  assert.equal((await h.authed('POST', `/api/invitations?account_id=${h.accountId}`, { email: 'invitada@login.mx', name: 'Inés', role: 'agent' })).statusCode, 200);
  const mail = [...outbox].reverse().find((m) => m.to === 'invitada@login.mx')!;
  const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);
  const a = await h.app.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress: '10.62.0.2', payload: { token, name: 'Inés', password: PASS, accept_terms: true } });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().mfa, 'enroll');
  assert.equal(cookieOf(a, 'cp_session'), undefined);
  assert.ok(cookieOf(a, 'cp_mfa'));
});

t('cambiar la contraseña sigue en la sesión y avisa; restablecer por correo no abre sesión y avisa', async () => {
  await newUser('olvida@login.mx');
  const { secret } = await enroll('olvida@login.mx');
  await resetStep('olvida@login.mx');
  const r = await post('/api/login/2fa', await challenge('olvida@login.mx', PASS), { code: totpAt(secret, currentStep()) });
  const session = cookieOf(r, 'cp_session')!;
  const changed = await h.app.inject({ method: 'PUT', url: '/api/me/password', headers: { cookie: session }, payload: { current: PASS, password: 'Pz-935-Qx-936-Kv' } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await get('/api/me', cookieOf(changed, 'cp_session')!)).statusCode, 200);
  await waitFor(() => outbox.some((m) => m.to === 'olvida@login.mx' && m.subject === 'Tu contraseña cambió'), 3000);

  assert.equal((await h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: '10.62.0.3', payload: { email: 'olvida@login.mx' } })).statusCode, 200);
  const mail = [...outbox].reverse().find((m) => m.to === 'olvida@login.mx' && m.subject === 'Restablece tu contraseña')!;
  const token = decodeURIComponent(/restablecer\?token=([^\s&]+)/.exec(mail.text)![1]);
  const reset = await h.app.inject({ method: 'POST', url: '/api/reset-password', remoteAddress: '10.62.0.4', payload: { token, password: 'Pz-937-Qx-938-Kv' } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(cookieOf(reset, 'cp_session'), undefined);
  assert.equal(cookieOf(reset, 'cp_mfa'), undefined);
  await waitFor(() => outbox.some((m) => m.to === 'olvida@login.mx' && m.subject === 'Restableciste tu contraseña'), 3000);
  assert.deepEqual((await login('olvida@login.mx', 'Pz-937-Qx-938-Kv')).json(), { mfa: 'verify' });
});

t('ninguna ruta abre sesión por su cuenta', async () => {
  for (const f of fs.readdirSync('src/routes')) assert.doesNotMatch(fs.readFileSync(`src/routes/${f}`, 'utf8'), /setSessionCookie|openSession/, f);
});
