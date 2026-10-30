/** Iniciar sesión / registrarse con Google (con un Google falso). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool } from './harness.js';

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
  return { location: String(back.headers.location), session: back.cookies.find((c) => c.name !== 'g_nonce' && c.value) };
}

t('un correo nuevo acepta los términos antes de crear su cuenta de prueba (ya verificada) y entra', async () => {
  const r = await flow({ email: 'Nueva@Empresa.mx', email_verified: true, name: 'Nora' });
  assert.match(r.location, /^\/#\/registro-google\?token=/);
  assert.equal(r.session, undefined, 'todavía no hay sesión');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'nueva@empresa.mx'`)).rows[0].n, 0, 'ni cuenta');
  const token = decodeURIComponent(r.location.split('token=')[1]);

  const info = await h.app.inject({ method: 'GET', url: `/api/signup/google?token=${encodeURIComponent(token)}` });
  assert.equal(info.statusCode, 200, info.body);
  assert.deepEqual([info.json().email, info.json().name], ['nueva@empresa.mx', 'Nora']);

  const post = (body: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/api/signup/google', remoteAddress: '10.8.7.1', headers: { 'user-agent': 'Navegador de prueba' }, payload: { token, company: 'Estética Nora', business_type: 'belleza', ...body } });
  assert.equal((await post({ accept_terms: false })).statusCode, 400, 'sin aceptar términos no se crea');
  const done = await post({ accept_terms: true });
  assert.equal(done.statusCode, 200, done.body);
  // Antes de ver el panel configura su verificación en dos pasos (el arnés lo hace por la API).
  assert.equal(done.json().mfa, 'enroll');
  const session = await h.sessionFrom(done);
  const u = (await pool.query(`SELECT u.id, u.role, u.email_verified_at, a.status, a.name, a.business_type FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.email = 'nueva@empresa.mx'`)).rows[0];
  assert.deepEqual([u.role, u.status, !!u.email_verified_at, u.name, u.business_type], ['admin', 'trial', true, 'Estética Nora', 'belleza']);
  const terms = (await pool.query(`SELECT source, ip, user_agent, email FROM terms_acceptances WHERE user_id = $1`, [u.id])).rows;
  assert.deepEqual(terms, [{ source: 'google', ip: '10.8.7.1', user_agent: 'Navegador de prueba', email: 'nueva@empresa.mx' }]);
  const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session } });
  assert.equal(me.json().user.email, 'nueva@empresa.mx');
  assert.equal((await post({ accept_terms: true })).statusCode, 409, 'el mismo pase no crea otra cuenta');
});

t('el pase de registro con Google no se puede alterar ni usar vencido; los correos temporales no se registran', async () => {
  const { googleSignupPass } = await import('../src/signup-guard.js');
  const body = (token: string) => ({ token, company: 'Otra', accept_terms: true });
  const forged = googleSignupPass('ajeno@empresa.mx', 'X').replace(/\.[^.]+$/, '.firma-falsa');
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/signup/google', payload: body(forged) })).statusCode, 400);
  const old = googleSignupPass('ajeno@empresa.mx', 'X', Date.now() - 16 * 60_000);
  assert.equal((await h.app.inject({ method: 'GET', url: `/api/signup/google?token=${encodeURIComponent(old)}` })).statusCode, 400);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'ajeno@empresa.mx'`)).rows[0].n, 0);
  assert.match((await flow({ email: 'alguien@mailinator.com', email_verified: true })).location, /google=correo-temporal/);
});

t('un usuario existente entra sin crear otra cuenta', async () => {
  const before = (await pool.query(`SELECT count(*)::int n FROM accounts`)).rows[0].n;
  const r = await flow({ email: 'nueva@empresa.mx', email_verified: true, name: 'Nora' });
  // Google es el primer paso: falta el código de su app (ya la configuró al registrarse).
  assert.equal(r.location, '/#/login/codigo');
  assert.equal(r.session?.name, 'cp_mfa', 'deja el reto, no la sesión');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM accounts`)).rows[0].n, before);
});

t('se rechaza: correo sin verificar, state alterado, sin cookie, cancelación y superadmin', async () => {
  const fails = async (r: { location: string; session?: unknown }, re: RegExp) => { assert.match(r.location, re); assert.equal(r.session, undefined); };
  await fails(await flow({ email: 'x@y.mx', email_verified: false }), /google=sin-correo/);
  await fails(await flow({ email: 'x@y.mx', email_verified: true }, { tamper: true }), /google=error/);
  await fails(await flow({ email: 'x@y.mx', email_verified: true }, { noCookie: true }), /google=error/);
  await fails(await flow({ email: 'x@y.mx', email_verified: true }, { query: 'error=access_denied&state=x' }), /google=error/);
  await fails(await flow({ email: 'admin@test.mx', email_verified: true }), /google=solo-contrasena/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE email = 'x@y.mx'`)).rows[0].n, 0);
});

t('con el registro cerrado no crea cuentas nuevas, y el botón solo aparece en el dominio principal', async () => {
  const { config } = await import('../src/config.js');
  const prev = config.signup.enabled;
  config.signup.enabled = false;
  try {
    assert.match((await flow({ email: 'otro@nuevo.mx', email_verified: true })).location, /google=sin-cuenta/);
  } finally { config.signup.enabled = prev; }
  const info = (host: string) => h.app.inject({ method: 'GET', url: '/api/signup/info', headers: { host } }).then((r) => r.json().google_login);
  assert.equal(await info(new URL(config.publicBaseUrl).host), true);
  assert.equal(await info('panel.otra-marca.com'), false);
});

t('registrar un correo ajeno con contraseña y luego entrar el dueño con Google invalida esa contraseña', async () => {
  const { hashPassword } = await import('../src/auth.js');
  const attacker = await hashPassword('clave-del-atacante-1');
  await pool.query(`INSERT INTO accounts (name, status) VALUES ('Víctima SA', 'trial')`);
  const acc = (await pool.query(`SELECT id FROM accounts WHERE name = 'Víctima SA'`)).rows[0].id;
  await pool.query(`INSERT INTO users (account_id, role, name, email, password_hash) VALUES ($1, 'admin', 'Víctima', 'victima@empresa.mx', $2)`, [acc, attacker]); // sin verificar
  const login = (pw: string) => h.app.inject({ method: 'POST', url: '/api/login', remoteAddress: '10.8.8.9', payload: { email: 'victima@empresa.mx', password: pw } });
  assert.equal((await login('clave-del-atacante-1')).statusCode, 200, 'antes de Google la contraseña del atacante funciona');
  const r = await flow({ email: 'victima@empresa.mx', email_verified: true, name: 'Víctima' });
  assert.ok(r.session);
  assert.equal((await login('clave-del-atacante-1')).statusCode, 401, 'tras entrar con Google, esa contraseña ya no sirve');
  assert.ok((await pool.query(`SELECT email_verified_at FROM users WHERE email = 'victima@empresa.mx'`)).rows[0].email_verified_at);
});
