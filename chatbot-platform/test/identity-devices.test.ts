/**
 * Dispositivos: «Recordar este dispositivo 30 días» salta el código (nunca la contraseña, nunca para el superadmin) y se
 * olvida al cambiar o restablecer la contraseña, al cerrar las demás sesiones o al dar de baja a la persona. Entrar desde
 * un dispositivo nuevo avisa por correo (no el primero de todos, que es el de la configuración).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-971-Qx-972-Kv';
let ip = 0;
/** Un navegador: guarda sus cookies entre peticiones. */
const browser = () => {
  const jar = new Map<string, string>();
  const send = async (method: string, url: string, payload?: unknown) => {
    const r = await h.app.inject({ method: method as any, url, payload: payload as any, remoteAddress: `10.63.0.${++ip}`, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0' } });
    for (const c of [r.headers['set-cookie'] ?? []].flat().map(String)) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) jar.set(pair.slice(0, i), pair.slice(i + 1));
      else jar.delete(pair.slice(0, i));
    }
    return r;
  };
  return { send, jar };
};
/** Entra con contraseña y, si se lo pide, con el código (remember: recordar el dispositivo). */
const enter = async (b: ReturnType<typeof browser>, email: string, password = PASS, remember = false) => {
  const r = await b.send('POST', '/api/login', { email, password });
  assert.equal(r.statusCode, 200, r.body);
  if (r.json().ok) return r.json();
  if (r.json().mfa === 'enroll') {
    const e = await b.send('GET', '/api/2fa/enroll');
    h.totpSecrets.set(email, e.json().secret);
    return (await b.send('POST', '/api/2fa/enroll', { code: await h.codeFor(email) })).json();
  }
  return (await b.send('POST', '/api/login/2fa', { code: await h.codeFor(email), remember })).json();
};
const newUser = async (email: string) => {
  const r = await h.addUser({ account_id: h.accountId, name: 'Dora', email, password: PASS, role: 'agent' });
  return r.id as string;
};
const mails = (to: string, subject: string) => outbox.filter((m) => m.to === to && m.subject === subject).length;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('recordar el dispositivo salta el código la próxima vez (sin dar verificación reciente)', async () => {
  await newUser('dora@disp.mx');
  const b = browser();
  await enter(b, 'dora@disp.mx');
  await b.send('POST', '/api/logout');
  assert.ok((await enter(b, 'dora@disp.mx', PASS, true)).ok);
  assert.ok(b.jar.has('cp_trust'), 'queda la cookie del dispositivo recordado');
  await b.send('POST', '/api/logout');
  const r = await b.send('POST', '/api/login', { email: 'dora@disp.mx', password: PASS });
  assert.equal(r.json().ok, true, r.body);
  assert.equal(r.json().user.email, 'dora@disp.mx');
  assert.equal((await b.send('GET', '/api/me')).statusCode, 200);
  const row = (await pool.query(`SELECT s.mfa_at FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'dora@disp.mx' ORDER BY s.created_at DESC LIMIT 1`)).rows[0];
  assert.equal(row.mfa_at, null, 'entrar con dispositivo recordado no cuenta como código escrito');
  assert.equal((await b.send('POST', '/api/login', { email: 'dora@disp.mx', password: 'otra-clave-equivocada' })).statusCode, 401, 'la contraseña se sigue pidiendo');
});

t('el superadmin nunca queda recordado', async () => {
  const b = browser();
  const r = await enter(b, 'admin@test.mx', 'secreto123', true);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(b.jar.has('cp_trust'), false);
  await b.send('POST', '/api/logout');
  assert.deepEqual((await b.send('POST', '/api/login', { email: 'admin@test.mx', password: 'secreto123' })).json(), { mfa: 'verify' });
});

t('el dispositivo recordado de otra persona no salta nada', async () => {
  await newUser('eli@disp.mx');
  const a = browser();
  await enter(a, 'dora@disp.mx', PASS, true);
  await a.send('POST', '/api/logout');
  assert.equal((await a.send('POST', '/api/login', { email: 'dora@disp.mx', password: PASS })).json().ok, true, 'a Dora sí la recuerda');
  const b = browser();
  await enter(b, 'eli@disp.mx');
  await b.send('POST', '/api/logout');
  b.jar.set('cp_trust', a.jar.get('cp_trust')!);
  assert.deepEqual((await b.send('POST', '/api/login', { email: 'eli@disp.mx', password: PASS })).json(), { mfa: 'verify' });
});

t('se olvida al cambiar o restablecer la contraseña, al cerrar las demás sesiones y al dar de baja', async () => {
  const id = await newUser('fer@disp.mx');
  let password = PASS;
  const trusted = async () => {
    const b = browser();
    await enter(b, 'fer@disp.mx', password, true);
    await b.send('POST', '/api/logout');
    assert.equal((await b.send('POST', '/api/login', { email: 'fer@disp.mx', password })).json().ok, true, 'quedó recordado');
    return b;
  };
  const asksCode = async (b: ReturnType<typeof browser>) => {
    await b.send('POST', '/api/logout');
    assert.deepEqual((await b.send('POST', '/api/login', { email: 'fer@disp.mx', password })).json(), { mfa: 'verify' });
  };
  await enter(browser(), 'fer@disp.mx');

  let b = await trusted();
  // Entró con el dispositivo recordado: cambiar la contraseña le pide el código (verificación reciente).
  assert.equal((await b.send('PUT', '/api/me/password', { current: password, password: 'Pz-973-Qx-974-Kv' })).json().code, 'step_up');
  assert.equal((await b.send('POST', '/api/2fa/step-up', { code: await h.codeFor('fer@disp.mx') })).statusCode, 200);
  assert.equal((await b.send('PUT', '/api/me/password', { current: password, password: 'Pz-973-Qx-974-Kv' })).statusCode, 200);
  password = 'Pz-973-Qx-974-Kv';
  await asksCode(b);

  b = await trusted();
  assert.equal((await b.send('POST', '/api/me/sessions/revoke-others')).statusCode, 200);
  await asksCode(b);

  b = await trusted();
  await h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: '10.63.1.1', payload: { email: 'fer@disp.mx' } });
  const mail = [...outbox].reverse().find((m) => m.to === 'fer@disp.mx' && m.subject === 'Restablece tu contraseña')!;
  const token = decodeURIComponent(/restablecer\?token=([^\s&]+)/.exec(mail.text)![1]);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/reset-password', remoteAddress: '10.63.1.2', payload: { token, password: 'Pz-975-Qx-976-Kv' } })).statusCode, 200);
  password = 'Pz-975-Qx-976-Kv';
  await asksCode(b);

  b = await trusted();
  assert.equal((await h.authed('PUT', `/api/users/${id}`, { active: false })).statusCode, 200);
  assert.equal((await h.authed('PUT', `/api/users/${id}`, { active: true })).statusCode, 200);
  await asksCode(b);
});

t('dispositivo nuevo avisa por correo; el mismo dispositivo y el primero de todos no', async () => {
  await newUser('gus@disp.mx');
  const first = browser();
  await enter(first, 'gus@disp.mx');
  assert.equal(mails('gus@disp.mx', 'Nuevo inicio de sesión en tu cuenta'), 0, 'el primero (al configurar) no avisa');
  await first.send('POST', '/api/logout');
  await enter(first, 'gus@disp.mx');
  assert.equal(mails('gus@disp.mx', 'Nuevo inicio de sesión en tu cuenta'), 0, 'el mismo dispositivo no avisa');
  await enter(browser(), 'gus@disp.mx');
  await waitFor(() => mails('gus@disp.mx', 'Nuevo inicio de sesión en tu cuenta') === 1, 3000);
  const text = outbox.filter((m) => m.to === 'gus@disp.mx' && m.subject === 'Nuevo inicio de sesión en tu cuenta')[0].text;
  assert.match(text, /Chrome en Windows/);
});
