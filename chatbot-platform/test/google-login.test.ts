/**
 * Iniciar sesión / registrarse con Google (con un Google falso). Se entra por el identificador estable de Google (`sub`);
 * por correo solo se liga si los dos lados lo tienen verificado. El pase para terminar el registro sirve solo en el
 * navegador que entró con Google (cookie cp_gpass).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool } from './harness.js';
const { config } = await import('../src/config.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

let claims: Record<string, unknown> = {};
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const id = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'a', expires_in: 3600, id_token: id }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'cs';
process.env.GOOGLE_OAUTH_URL = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.GOOGLE_AUTH_URL = 'https://accounts.example/auth';

before(async () => { if (ok) h = await createHarness(); });
after(async () => { server.close(); if (h) await h.app.close(); await pool.end(); });

/** Recorre el flujo: inicia, "Google" regresa con el state y el mismo navegador (cookie g_nonce). */
async function flow(who: Record<string, unknown>, opts: { tamper?: boolean; noCookie?: boolean; query?: string } = {}) {
  claims = who;
  const start = await h.app.inject({ method: 'GET', url: '/oauth/google/login', remoteAddress: '10.8.8.8' });
  assert.equal(start.statusCode, 302);
  const loc = new URL(String(start.headers.location));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.example/auth');
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  const nonce = start.cookies.find((c) => c.name === 'g_nonce')!.value;
  const state = opts.tamper ? loc.searchParams.get('state')!.replace(/.$/, 'x') : loc.searchParams.get('state')!;
  const back = await h.app.inject({
    method: 'GET',
    url: `/oauth/google/login/callback?${opts.query ?? `code=abc&state=${encodeURIComponent(state)}`}`,
    remoteAddress: '10.8.8.8',
    headers: opts.noCookie ? {} : { cookie: `g_nonce=${nonce}` },
  });
  const gpass = back.cookies.find((c) => c.name === 'cp_gpass');
  return { location: String(back.headers.location), session: back.cookies.find((c) => !['g_nonce', 'cp_gpass'].includes(c.name) && c.value), gpass, cookie: gpass ? `cp_gpass=${gpass.value}` : '' };
}

t('un correo nuevo acepta los términos antes de crear su cuenta de prueba (ya verificada, con su sub) y entra', async () => {
  const r = await flow({ sub: 'g-nora', email: 'Nueva@Empresa.mx', email_verified: true, name: 'Nora' });
  assert.match(r.location, /^\/#\/registro-google\/[^?]+$/);
  assert.equal(r.session, undefined, 'todavía no hay sesión');
  assert.ok(r.gpass?.httpOnly && r.gpass.sameSite === 'Strict', 'el pase queda ligado a este navegador');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'nueva@empresa.mx'`)).rows[0].n, 0, 'ni cuenta');
  const token = decodeURIComponent(r.location.split('/registro-google/')[1]);

  assert.equal((await h.app.inject({ method: 'GET', url: `/api/signup/google?token=${encodeURIComponent(token)}` })).statusCode, 404, 'el token ya no va en la URL');
  const peek = (cookie: string) => h.app.inject({ method: 'POST', url: '/api/signup/google/peek', headers: cookie ? { cookie } : {}, payload: { token } });
  assert.equal((await peek('')).statusCode, 401, 'en otro navegador no sirve');
  assert.equal((await peek('cp_gpass=otro-navegador')).statusCode, 401);
  const info = await peek(r.cookie);
  assert.equal(info.statusCode, 200, info.body);
  assert.deepEqual([info.json().email, info.json().name], ['nueva@empresa.mx', 'Nora']);

  const post = (body: Record<string, unknown>, cookie = r.cookie) => h.app.inject({ method: 'POST', url: '/api/signup/google', remoteAddress: '10.8.7.1', headers: { 'user-agent': 'Navegador de prueba', ...(cookie ? { cookie } : {}) }, payload: { token, company: 'Estética Nora', business_type: 'belleza', ...body } });
  assert.equal((await post({ accept_terms: true }, '')).statusCode, 401, 'sin la cookie no se crea');
  assert.equal((await post({ accept_terms: false })).statusCode, 400, 'sin aceptar términos no se crea');
  const done = await post({ accept_terms: true });
  assert.equal(done.statusCode, 200, done.body);
  // Antes de ver el panel configura su verificación en dos pasos (el arnés lo hace por la API).
  assert.equal(done.json().mfa, 'enroll');
  const session = await h.sessionFrom(done);
  const u = (await pool.query(`SELECT u.id, u.role, u.email_verified_at, u.google_sub, a.status, a.name, a.business_type FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.email = 'nueva@empresa.mx'`)).rows[0];
  assert.deepEqual([u.role, u.status, !!u.email_verified_at, u.google_sub, u.name, u.business_type], ['admin', 'trial', true, 'g-nora', 'Estética Nora', 'belleza']);
  const terms = (await pool.query(`SELECT source, ip, user_agent, email FROM terms_acceptances WHERE user_id = $1`, [u.id])).rows;
  assert.deepEqual(terms, [{ source: 'google', ip: '10.8.7.1', user_agent: 'Navegador de prueba', email: 'nueva@empresa.mx' }]);
  const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session } });
  assert.equal(me.json().user.email, 'nueva@empresa.mx');
  assert.equal((await post({ accept_terms: true })).statusCode, 409, 'el mismo pase no crea otra cuenta');
});

t('el pase de registro con Google no se puede alterar ni usar vencido; los correos temporales no se registran', async () => {
  const { googleSignupPass } = await import('../src/signup-guard.js');
  const who = { email: 'ajeno@empresa.mx', name: 'X', sub: 'g-ajeno' };
  const body = (token: string) => ({ token, company: 'Otra', accept_terms: true });
  const headers = { cookie: 'cp_gpass=navegador-1' };
  const forged = googleSignupPass(who, 'navegador-1').replace(/\.[^.]+$/, '.firma-falsa');
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/signup/google', headers, payload: body(forged) })).statusCode, 400);
  const old = googleSignupPass(who, 'navegador-1', Date.now() - 16 * 60_000);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/signup/google/peek', headers, payload: { token: old } })).statusCode, 400);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'ajeno@empresa.mx'`)).rows[0].n, 0);
  assert.match((await flow({ sub: 'g-temp', email: 'alguien@mailinator.com', email_verified: true })).location, /google=correo-temporal/);
});

t('un usuario existente entra por su sub, también si cambió su correo aquí', async () => {
  const before = (await pool.query(`SELECT count(*)::int n FROM accounts`)).rows[0].n;
  const r = await flow({ sub: 'g-nora', email: 'nueva@empresa.mx', email_verified: true, name: 'Nora' });
  // Google es el primer paso: falta el código de su app (ya la configuró al registrarse).
  assert.equal(r.location, '/#/login/codigo');
  assert.equal(r.session?.name, 'cp_mfa', 'deja el reto, no la sesión');
  await pool.query(`UPDATE users SET email = 'nora@otro-correo.mx' WHERE email = 'nueva@empresa.mx'`);
  assert.equal((await flow({ sub: 'g-nora', email: 'nueva@empresa.mx', email_verified: true, name: 'Nora' })).location, '/#/login/codigo', 'por su sub, no por el correo');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM accounts`)).rows[0].n, before);
});

t('por correo solo se liga si los dos lo tienen verificado, y entonces guarda el sub', async () => {
  const u = await h.addUser({ account_id: (await h.addAccount({ name: 'Liga SA' })).id, name: 'Lía', email: 'lia@liga.mx', password: 'Pz-979-Qx-980-Kv', role: 'admin' });
  assert.match((await flow({ sub: 'g-lia', email: 'lia@liga.mx', email_verified: false })).location, /google=sin-correo/);
  assert.equal((await pool.query(`SELECT google_sub FROM users WHERE id = $1`, [u.id])).rows[0].google_sub, null);
  const r = await flow({ sub: 'g-lia', email: 'Lia@Liga.mx', email_verified: true, name: 'Lía' });
  assert.equal(r.session?.name, 'cp_mfa');
  assert.equal((await pool.query(`SELECT google_sub FROM users WHERE id = $1`, [u.id])).rows[0].google_sub, 'g-lia');
  // Ya ligada: otra cuenta de Google con el mismo correo no entra.
  const other = await flow({ sub: 'g-impostor', email: 'lia@liga.mx', email_verified: true });
  assert.match(other.location, /google=otra-cuenta/);
  assert.equal(other.session, undefined);
});

t('con el correo sin verificar aquí, Google no entra: no cambia la contraseña ni lo marca verificado', async () => {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('clave-de-quien-registro-1');
  await pool.query(`INSERT INTO accounts (name, status) VALUES ('Sin Verificar SA', 'trial')`);
  const acc = (await pool.query(`SELECT id FROM accounts WHERE name = 'Sin Verificar SA'`)).rows[0].id;
  await pool.query(`INSERT INTO users (account_id, role, name, email, password_hash) VALUES ($1, 'admin', 'Vic', 'vic@empresa.mx', $2)`, [acc, hash]); // sin verificar
  const r = await flow({ sub: 'g-vic', email: 'vic@empresa.mx', email_verified: true, name: 'Vic' });
  assert.equal(r.location, '/#/login?google=sin-verificar');
  assert.equal(r.session, undefined);
  const row = (await pool.query(`SELECT password_hash, email_verified_at, google_sub FROM users WHERE email = 'vic@empresa.mx'`)).rows[0];
  assert.deepEqual(row, { password_hash: hash, email_verified_at: null, google_sub: null });
});

t('se rechaza: correo sin verificar en Google, state alterado, sin cookie, cancelación, sin sub y superadmin', async () => {
  const fails = async (r: { location: string; session?: unknown }, re: RegExp) => { assert.match(r.location, re); assert.equal(r.session, undefined); };
  await fails(await flow({ sub: 'g-x', email: 'x@y.mx', email_verified: false }), /google=sin-correo/);
  await fails(await flow({ sub: 'g-x', email: 'x@y.mx', email_verified: true }, { tamper: true }), /google=error/);
  await fails(await flow({ sub: 'g-x', email: 'x@y.mx', email_verified: true }, { noCookie: true }), /google=error/);
  await fails(await flow({ sub: 'g-x', email: 'x@y.mx', email_verified: true }, { query: 'error=access_denied&state=x' }), /google=error/);
  await fails(await flow({ email: 'x@y.mx', email_verified: true }), /google=error/);
  await fails(await flow({ sub: 'g-admin', email: 'admin@test.mx', email_verified: true }), /google=solo-contrasena/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'x@y.mx'`)).rows[0].n, 0);
});

t('con el registro cerrado no crea cuentas nuevas, y el botón solo aparece en el dominio principal', async () => {
  const { config } = await import('../src/config.js');
  const prev = config.signup.enabled;
  config.signup.enabled = false;
  try {
    assert.match((await flow({ sub: 'g-otro', email: 'otro@nuevo.mx', email_verified: true })).location, /google=sin-cuenta/);
  } finally { config.signup.enabled = prev; }
  const info = (host: string) => h.app.inject({ method: 'GET', url: '/api/signup/info', headers: { host } }).then((r) => r.json().google_login);
  assert.equal(await info(new URL(config.publicBaseUrl).host), true);
  assert.equal(await info('panel.otra-marca.com'), false);
});

t('con el captcha activo, terminar el registro con Google pide el captcha (entrar a una cuenta que existe, no)', async () => {
  let valid = true;
  const turnstile = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: valid })); }); });
  await new Promise<void>((r) => turnstile.listen(0, '127.0.0.1', r));
  const prev = { ...config.signup.turnstile };
  Object.assign(config.signup.turnstile, { siteKey: 'sitio', secretKey: 'secreto', verifyUrl: `http://127.0.0.1:${(turnstile.address() as any).port}` });
  try {
    const r = await flow({ sub: 'g-capi', email: 'capi@empresa.mx', email_verified: true, name: 'Capi' });
    const token = decodeURIComponent(r.location.split('/registro-google/')[1]);
    const post = (extra: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/api/signup/google', remoteAddress: '10.8.9.1', headers: { cookie: r.cookie }, payload: { token, company: 'Capi SA', accept_terms: true, ...extra } });
    const sinToken = await post({});
    assert.equal(sinToken.statusCode, 400, sinToken.body);
    assert.equal(sinToken.json().error, 'Confirma que no eres un robot e intenta de nuevo.');
    valid = false;
    assert.equal((await post({ turnstile_token: 'malo' })).statusCode, 400);
    valid = true;
    const done = await post({ turnstile_token: 'bueno' });
    assert.equal(done.statusCode, 200, done.body);
    // Ya con cuenta, entrar con Google no pide captcha.
    const back = await flow({ sub: 'g-capi', email: 'capi@empresa.mx', email_verified: true, name: 'Capi' });
    assert.doesNotMatch(back.location, /registro-google/);
  } finally {
    Object.assign(config.signup.turnstile, prev);
    turnstile.close();
  }
});

t('con cobro configurado, la cuenta creada con Google también espera la tarjeta', async () => {
  const prev = { ...config.billing.stripe };
  Object.assign(config.billing.stripe, { secretKey: 'sk_test_google', webhookSecret: 'whsec_google' });
  // Con un plan que se pueda pagar (sin plan no hay pago que abrir y la prueba sigue sin tarjeta).
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499, currency: 'MXN' })).statusCode, 200);
  try {
    const r = await flow({ sub: 'g-tarjeta', email: 'tarjeta@empresa.mx', email_verified: true, name: 'Tere' });
    const token = decodeURIComponent(r.location.split('/registro-google/')[1]);
    const done = await h.app.inject({ method: 'POST', url: '/api/signup/google', remoteAddress: '10.8.9.9', headers: { cookie: r.cookie }, payload: { token, company: 'Tere SA', accept_terms: true } });
    assert.equal(done.statusCode, 200, done.body);
    const acc = (await pool.query(`SELECT a.status, a.pause_reason, a.trial_ends_at FROM accounts a JOIN users u ON u.account_id = a.id WHERE u.email = 'tarjeta@empresa.mx'`)).rows[0];
    assert.deepEqual([acc.status, acc.pause_reason, acc.trial_ends_at], ['paused', 'card', null]);
  } finally {
    Object.assign(config.billing.stripe, prev);
  }
});
