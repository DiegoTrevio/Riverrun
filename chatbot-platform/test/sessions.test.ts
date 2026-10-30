/** Auditoría S-M2: las sesiones del panel quedan registradas; cerrar sesión las invalida en el servidor y cada persona ve y cierra las suyas. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const { createSession, passwordVersion } = await import('../src/auth.js');
const { hmac } = await import('../src/secret.js');
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const EMAIL = 'sesiones@palmas.mx';
const PASS = 'Pz-915-Qx-916-Kv';
let userId = '';

const login = async (ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0') => {
  const r = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: EMAIL, password: PASS }, headers: { 'user-agent': ua } });
  assert.equal(r.statusCode, 200, r.body);
  return await h.sessionFrom(r, EMAIL, { 'user-agent': ua });
};
const as = (cookie: string) => (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
const me = async (cookie: string) => (await as(cookie)('GET', '/api/me')).statusCode;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const u = await h.addUser({ account_id: h.accountId, email: EMAIL, name: 'Recepción', password: PASS, role: 'admin' });
  userId = u.id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('cerrar sesión invalida la cookie en el servidor (una copia ya no sirve)', async () => {
  const cookie = await login();
  assert.equal(await me(cookie), 200);
  assert.equal((await as(cookie)('POST', '/api/logout')).statusCode, 200);
  assert.equal(await me(cookie), 401, 'la cookie copiada ya no entra');
});

t('Mi perfil: ver las sesiones, cerrar una ajena a esta y cerrar todas las demás', async () => {
  const phone = await login('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1');
  const laptop = await login('Mozilla/5.0 (Macintosh; Mac OS X 14_0) Firefox/120.0');
  const desk = await login();
  const list = (await as(desk)('GET', '/api/me/sessions')).json();
  assert.ok(list.sessions.length >= 3);
  const current = list.sessions.filter((s: any) => s.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].device, 'Chrome en Windows');
  assert.ok(list.sessions.some((s: any) => s.device === 'Safari en iPhone o iPad'));
  assert.doesNotMatch(JSON.stringify(list), /user_agent|"ip":"\d+\.\d+\.\d+\.\d+"/, 'sin el navegador completo ni la IP completa');
  // Cerrar la del teléfono desde la computadora.
  const phoneId = list.sessions.find((s: any) => s.device === 'Safari en iPhone o iPad').id;
  assert.equal((await as(desk)('DELETE', `/api/me/sessions/${phoneId}`)).statusCode, 200);
  assert.equal(await me(phone), 401);
  assert.equal(await me(laptop), 200);
  // Cerrar todas las demás: solo queda esta.
  const r = await as(desk)('POST', '/api/me/sessions/revoke-others');
  assert.ok(r.json().closed >= 1);
  assert.equal(await me(laptop), 401);
  assert.equal(await me(desk), 200);
  assert.equal((await as(desk)('GET', '/api/me/sessions')).json().sessions.length, 1);
});

t('nadie cierra ni ve sesiones de otra persona', async () => {
  const mine = await login();
  const sid = (await pool.query(`SELECT id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0].id;
  // El superadmin (otra persona) no la puede cerrar desde su perfil.
  assert.equal((await h.authed('DELETE', `/api/me/sessions/${sid}`)).statusCode, 404);
  assert.ok(!(await h.authed('GET', '/api/me/sessions')).json().sessions.some((s: any) => s.id === sid));
  assert.equal(await me(mine), 200);
});

t('cambiar la contraseña, el rol o desactivar a la persona cierra sus sesiones', async () => {
  const a = await login();
  const b = await login();
  assert.equal((await as(a)('PUT', '/api/me/password', { current: PASS, password: PASS })).statusCode, 200);
  assert.equal(await me(b), 401, 'la otra sesión se cerró');
  const c = await login();
  assert.equal((await h.authed('PUT', `/api/users/${userId}`, { role: 'agent' })).statusCode, 200);
  assert.equal(await me(c), 401, 'entra otra vez con los permisos nuevos');
  assert.equal((await as(await login())('GET', '/api/users')).statusCode, 403, 'ya como agente');
  const d = await login();
  assert.equal((await h.authed('PUT', `/api/users/${userId}`, { active: false })).statusCode, 200);
  assert.equal(await me(d), 401);
  assert.equal((await h.authed('PUT', `/api/users/${userId}`, { active: true, role: 'admin' })).statusCode, 200);
});

t('una cookie de antes (sin sesión registrada) ya no entra; una sesión inventada tampoco', async () => {
  const hash = (await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId])).rows[0].password_hash;
  const payload = Buffer.from(JSON.stringify({ uid: userId, pv: passwordVersion(hash), exp: Date.now() + 3_600_000 })).toString('base64url');
  assert.equal(await me(`cp_session=${payload}.${hmac(`session:${payload}`)}`), 401);
  const forged = `cp_session=${createSession(userId, hash, '00000000-0000-0000-0000-000000000000', Date.now() + 3_600_000)}`;
  assert.equal(await me(forged), 401);
});

t('el último uso se anota como mucho cada minuto', async () => {
  const cookie = await login();
  const sid = (await pool.query(`SELECT id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0].id;
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '30 seconds' WHERE id = $1`, [sid]);
  const before = (await pool.query(`SELECT last_seen_at FROM user_sessions WHERE id = $1`, [sid])).rows[0].last_seen_at;
  await me(cookie);
  assert.equal((await pool.query(`SELECT last_seen_at FROM user_sessions WHERE id = $1`, [sid])).rows[0].last_seen_at.getTime(), before.getTime());
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [sid]);
  await me(cookie);
  const after = (await pool.query(`SELECT last_seen_at FROM user_sessions WHERE id = $1`, [sid])).rows[0].last_seen_at;
  assert.ok(Date.now() - after.getTime() < 60_000);
});
