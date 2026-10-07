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

t('un correo nuevo crea su cuenta de prueba ya verificada y entra', async () => {
  const r = await flow({ email: 'Nueva@Empresa.mx', email_verified: true, name: 'Nora' });
  assert.equal(r.location, '/#/');
  assert.ok(r.session, 'inicia sesión');
  const u = (await pool.query(`SELECT u.role, u.email_verified_at, a.status, a.name FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.email = 'nueva@empresa.mx'`)).rows[0];
  assert.deepEqual([u.role, u.status, !!u.email_verified_at], ['admin', 'trial', true]);
  const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${r.session!.name}=${r.session!.value}` } });
  assert.equal(me.json().user.email, 'nueva@empresa.mx');
});

t('un usuario existente entra sin crear otra cuenta', async () => {
  const before = (await pool.query(`SELECT count(*)::int n FROM accounts`)).rows[0].n;
  const r = await flow({ email: 'nueva@empresa.mx', email_verified: true, name: 'Nora' });
  assert.ok(r.session);
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
