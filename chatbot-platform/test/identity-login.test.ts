/**
 * Verificación en dos pasos obligatoria: ninguna puerta (contraseña, registro, invitación, restablecer) abre sesión sin el
 * código. La primera vez se configura la app (QR + 10 códigos de recuperación); después se pide el código, que sirve una
 * sola vez, con 5 intentos por reto.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';

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
/** El reto tras la contraseña; para configurar la app, ya con el enlace del correo abierto en este navegador (ID-16). */
const challenge = async (email: string, password: string) => {
  const r = await login(email, password);
  const c = cookieOf(r, 'cp_mfa')!;
  if (r.json().mfa !== 'enroll') return c;
  if ((await get('/api/2fa/enroll', c)).statusCode !== 403) return c;
  const l = await post('/api/2fa/enroll/link', c, { token: h.enrollTokenFor(email) });
  assert.equal(l.statusCode, 200, l.body);
  return cookieOf(l, 'cp_mfa')!;
};
const resetStep = (email: string) => pool.query(`UPDATE users SET totp_last_step = 0 WHERE email = $1`, [email]);
/** La misma cookie de reto con otros datos, firmada como la firma el servidor. */
const resign = (cookie: string, patch: Record<string, unknown>) => {
  const data = { ...JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString()), ...patch };
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `cp_mfa=${payload}.${hmac(`mfa-challenge:${payload}`)}`;
};
const PASS = 'Pz-931-Qx-932-Kv';
const newUser = async (email: string, role = 'agent') => {
  return (await h.addUser({ account_id: h.accountId, name: 'Persona', email, password: PASS, role: role as 'admin' | 'agent' })).id;
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

t('un secreto pendiente de más de una hora se cambia por uno nuevo: nadie lo deja preparado para después', async () => {
  await newUser('sembrado@login.mx');
  const c = await challenge('sembrado@login.mx', PASS);
  const { secret } = (await get('/api/2fa/enroll', c)).json();
  await pool.query(`UPDATE users SET totp_pending_at = now() - interval '59 minutes' WHERE email = 'sembrado@login.mx'`);
  assert.equal((await get('/api/2fa/enroll', await challenge('sembrado@login.mx', PASS))).json().secret, secret, 'dentro de la hora, el mismo');
  await pool.query(`UPDATE users SET totp_pending_at = now() - interval '61 minutes' WHERE email = 'sembrado@login.mx'`);
  const again = await challenge('sembrado@login.mx', PASS);
  const fresh = (await get('/api/2fa/enroll', again)).json().secret;
  assert.notEqual(fresh, secret);
  assert.equal((await post('/api/2fa/enroll', again, { code: totpAt(secret, currentStep()) })).statusCode, 400, 'el viejo ya no sirve');
  assert.equal((await post('/api/2fa/enroll', again, { code: totpAt(fresh, currentStep()) })).statusCode, 200);
  assert.equal((await pool.query(`SELECT totp_pending_at FROM users WHERE email = 'sembrado@login.mx'`)).rows[0].totp_pending_at, null);
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
  const { hashPassword } = await import('../src/auth.js');
  await store.updateUser(id, { password_hash: await hashPassword('Pz-933-Qx-934-Kv') }); // la cambió (Mi perfil o el enlace del correo)
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
  const token = decodeURIComponent(/#\/invitacion\/([^\s]+)/.exec(mail.text)![1]);
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
  // El correo sale en segundo plano, después de responder.
  await waitFor(() => outbox.some((m) => m.to === 'olvida@login.mx' && m.subject === 'Restablece tu contraseña'));
  const mail = [...outbox].reverse().find((m) => m.to === 'olvida@login.mx' && m.subject === 'Restablece tu contraseña')!;
  const token = decodeURIComponent(/restablecer\?token=([^\s&]+)/.exec(mail.text)![1]);
  const reset = await h.app.inject({ method: 'POST', url: '/api/reset-password', remoteAddress: '10.62.0.4', payload: { token, password: 'Pz-937-Qx-938-Kv' } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(cookieOf(reset, 'cp_session'), undefined);
  assert.equal(cookieOf(reset, 'cp_mfa'), undefined);
  await waitFor(() => outbox.some((m) => m.to === 'olvida@login.mx' && m.subject === 'Restableciste tu contraseña'), 3000);
  assert.deepEqual((await login('olvida@login.mx', 'Pz-937-Qx-938-Kv')).json(), { mfa: 'verify' });
});

/** Pide el enlace para restablecer la contraseña y lo usa. */
const resetByEmail = async (email: string, password: string) => {
  outbox.length = 0;
  await h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: `10.62.1.${++ip}`, payload: { email } });
  await waitFor(() => outbox.some((m) => m.to === email && m.subject === 'Restablece tu contraseña'));
  const mail = outbox.find((m) => m.to === email && m.subject === 'Restablece tu contraseña')!;
  const token = decodeURIComponent(/restablecer\?token=([^\s&]+)/.exec(mail.text)![1]);
  const r = await h.app.inject({ method: 'POST', url: '/api/reset-password', remoteAddress: `10.62.1.${++ip}`, payload: { token, password } });
  assert.equal(r.statusCode, 200, r.body);
};

t('una cuenta existente sin app recibe un enlace al correo y sin él no ve el QR (ID-16)', async () => {
  await newUser('filtrada@login.mx');
  outbox.length = 0;
  const r = await login('filtrada@login.mx', PASS);
  assert.deepEqual(r.json(), { mfa: 'enroll' });
  const c = cookieOf(r, 'cp_mfa')!;
  const q = await get('/api/2fa/enroll', c);
  assert.equal(q.statusCode, 403);
  assert.equal(q.json().code, 'email_required');
  assert.equal(q.json().secret, undefined, 'sin QR');
  assert.match(q.json().error, /^Te mandamos un enlace a f•+@login\.mx/);
  const mail = outbox.find((m) => m.to === 'filtrada@login.mx' && m.subject === 'Configura tu verificación en dos pasos');
  assert.ok(mail, 'llega el enlace');
  assert.match(mail!.text, /mismo navegador/);
  assert.equal((await post('/api/2fa/enroll', c, { code: '123456' })).json().code, 'email_required', 'tampoco confirma una app');
  // Recargar no manda otro correo ni invalida el que llegó (tampoco pasados 2 minutos): eso es «Mandar otro enlace».
  await get('/api/2fa/enroll', c);
  await pool.query(`UPDATE users SET mfa_enroll_sent_at = now() - interval '3 minutes' WHERE email = 'filtrada@login.mx'`);
  for (let i = 0; i < 8; i++) await get('/api/2fa/enroll', c);
  assert.equal(outbox.filter((m) => m.subject === 'Configura tu verificación en dos pasos').length, 1);
  const resent = await post('/api/2fa/enroll/resend', c, {});
  assert.equal(resent.json().sent, true, 'recargar no gastó el tope de correos');
  assert.equal(outbox.filter((m) => m.subject === 'Configura tu verificación en dos pasos').length, 2);
  assert.equal((await post('/api/2fa/enroll/resend', c, {})).json().sent, false, 'otro antes de 2 minutos, no');
  // El enlace abierto en otro navegador (sin el reto) no abre nada; uno inventado tampoco.
  const token = h.enrollTokenFor('filtrada@login.mx');
  const other = await h.app.inject({ method: 'POST', url: '/api/2fa/enroll/link', payload: { token } });
  assert.deepEqual([other.statusCode, other.json().code], [400, 'other_browser']);
  assert.equal((await post('/api/2fa/enroll/link', c, { token: 'x'.repeat(43) })).statusCode, 400);
  assert.equal((await get('/api/2fa/enroll', c)).statusCode, 403, 'sigue sin QR');
});

t('con el enlace del correo enrola normal; el enlace sirve una vez (ID-16)', async () => {
  await newUser('conenlace@login.mx');
  const r = await login('conenlace@login.mx', PASS);
  const c = cookieOf(r, 'cp_mfa')!;
  await get('/api/2fa/enroll', c);
  const token = h.enrollTokenFor('conenlace@login.mx');
  const l = await post('/api/2fa/enroll/link', c, { token });
  assert.equal(l.statusCode, 200, l.body);
  const proven = cookieOf(l, 'cp_mfa')!;
  assert.equal((await post('/api/2fa/enroll/link', proven, { token })).statusCode, 400, 'un solo uso');
  const { secret } = (await get('/api/2fa/enroll', proven)).json();
  assert.ok(secret);
  assert.equal((await post('/api/2fa/enroll', proven, { code: totpAt(secret, currentStep()) })).statusCode, 200);
  assert.equal((await pool.query(`SELECT totp_email_confirmed FROM users WHERE email = 'conenlace@login.mx'`)).rows[0].totp_email_confirmed, true);
});

t('abrir el enlace del correo verifica el correo; restablecer la contraseña no quita la app (ID-18)', async () => {
  await newUser('enlace-verifica@login.mx');
  // Entra solo con la contraseña, sin correo verificado (como quien se registró y nunca abrió el enlace de verificación).
  await pool.query(`UPDATE users SET email_verified_at = NULL WHERE email = 'enlace-verifica@login.mx'`);
  const verifiedAt = async () => (await pool.query(`SELECT email_verified_at FROM users WHERE email = 'enlace-verifica@login.mx'`)).rows[0].email_verified_at;
  const c = await challenge('enlace-verifica@login.mx', PASS);
  assert.ok(await verifiedAt(), 'abrir el enlace del correo prueba el buzón: queda verificado');
  await enrollWith(c);
  const row = await userRow('enlace-verifica@login.mx');
  assert.ok(row.totp_enabled_at);
  assert.equal(row.totp_email_confirmed, true);
  await resetByEmail('enlace-verifica@login.mx', 'Pz-961-Qx-962-Kv');
  assert.ok((await userRow('enlace-verifica@login.mx')).totp_enabled_at, 'la app sigue');
  assert.deepEqual((await login('enlace-verifica@login.mx', 'Pz-961-Qx-962-Kv')).json(), { mfa: 'verify' });
});

t('una cuenta nueva del registro (o por Google o invitación) enrola sin enlace (ID-16)', async () => {
  const s = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.62.0.9', payload: { name: 'Lalo', company: 'Taller Lalo', business_type: 'servicios', email: 'lalo@taller.mx', password: PASS, accept_terms: true } });
  assert.equal(s.statusCode, 200, s.body);
  const q = await get('/api/2fa/enroll', cookieOf(s, 'cp_mfa')!);
  assert.equal(q.statusCode, 200, q.body);
  assert.ok(q.json().secret);
});

t('restablecer la contraseña por correo quita una app que se configuró sin pasar por el correo (ID-16)', async () => {
  await newUser('vieja@login.mx');
  await enroll('vieja@login.mx');
  // Como una app configurada antes de este cambio (solo con la contraseña).
  await pool.query(`UPDATE users SET totp_email_confirmed = false WHERE email = 'vieja@login.mx'`);
  await resetByEmail('vieja@login.mx', 'Pz-941-Qx-942-Kv');
  assert.equal((await pool.query(`SELECT totp_enabled_at FROM users WHERE email = 'vieja@login.mx'`)).rows[0].totp_enabled_at, null);
  assert.deepEqual((await login('vieja@login.mx', 'Pz-941-Qx-942-Kv')).json(), { mfa: 'enroll' }, 'la configura otra vez, con el enlace');
  // Una configurada por correo se queda.
  await newUser('buena@login.mx');
  await enroll('buena@login.mx');
  await resetByEmail('buena@login.mx', 'Pz-943-Qx-944-Kv');
  assert.deepEqual((await login('buena@login.mx', 'Pz-943-Qx-944-Kv')).json(), { mfa: 'verify' });
});

t('ninguna ruta abre sesión por su cuenta', async () => {
  for (const f of fs.readdirSync('src/routes')) assert.doesNotMatch(fs.readFileSync(`src/routes/${f}`, 'utf8'), /setSessionCookie|openSession/, f);
});

// ID-18: registrarse con un correo ajeno no cuenta como correo comprobado.
const userRow = async (email: string) => (await pool.query(`SELECT totp_enabled_at, totp_email_confirmed FROM users WHERE email = $1`, [email])).rows[0];
/** Se registra (sin verificar el correo) y devuelve el reto para configurar la app; con `patch` re-firma la cookie. */
const signupChallenge = async (email: string) => {
  const s = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: `10.63.0.${++ip}`, payload: { name: 'Quien sea', company: `Empresa ${email}`, business_type: 'servicios', email, password: PASS, accept_terms: true } });
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().verification_sent, true, 'el registro deja el correo sin verificar');
  return cookieOf(s, 'cp_mfa')!;
};
const enrollWith = async (c: string) => {
  const { secret } = (await get('/api/2fa/enroll', c)).json();
  const r = await post('/api/2fa/enroll', c, { code: totpAt(secret, currentStep()) });
  assert.equal(r.statusCode, 200, r.body);
};

t('quien se registra con un correo sin verificar y configura su app la pierde si el dueño del correo restablece la contraseña', async () => {
  const c = await signupChallenge('victima@prueba.mx');
  await enrollWith(c);
  assert.equal((await userRow('victima@prueba.mx')).totp_email_confirmed, false);
  assert.ok((await userRow('victima@prueba.mx')).totp_enabled_at);
  await resetByEmail('victima@prueba.mx', 'Otra-Clave-Larga-951');
  assert.equal((await userRow('victima@prueba.mx')).totp_enabled_at, null);
});

t('quien se registra y verifica su correo después no pierde la app al entrar', async () => {
  const c = await signupChallenge('duena@prueba.mx');
  await enrollWith(c);
  const mail = [...outbox].reverse().find((m) => m.to === 'duena@prueba.mx' && m.text.includes('#/verificar?token='))!;
  const token = decodeURIComponent(/#\/verificar\?token=([^\s]+)/.exec(mail.text)![1]);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/verify-email', payload: { token } })).statusCode, 200);
  const row = await userRow('duena@prueba.mx');
  assert.ok(row.totp_enabled_at);
  assert.equal(row.totp_email_confirmed, false, 'verificar el correo después no confirma una app ya configurada');
  assert.deepEqual((await login('duena@prueba.mx', PASS)).json().mfa, 'verify', 'entrar sigue pidiendo el código y la app sigue');
});

t('un reto de registro emitido antes del cambio (sin ec) se trata como correo sin comprobar; invitación y Google siguen comprobados', async () => {
  const c = await signupChallenge('vieja@prueba.mx');
  const legacy = resign(c, { ec: undefined });
  await enrollWith(legacy);
  assert.equal((await userRow('vieja@prueba.mx')).totp_email_confirmed, false);
  // Un reto viejo de invitación o Google (ev sin ec) sigue contando como comprobado.
  await newUser('inv-vieja@login.mx');
  const r = await login('inv-vieja@login.mx', PASS);
  const viejo = resign(cookieOf(r, 'cp_mfa')!, { via: 'invite', ev: true, ec: undefined });
  await enrollWith(viejo);
  assert.equal((await userRow('inv-vieja@login.mx')).totp_email_confirmed, true);
});
