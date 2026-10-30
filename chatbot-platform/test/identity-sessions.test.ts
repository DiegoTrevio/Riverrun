/**
 * Sesiones del panel: caducan por inactividad y tienen un máximo según el rol (equipo: 12 h sin uso y 7 días; superadmin:
 * 30 min y 12 h). Solo valen las cookies registradas (con `sid`) y firmadas con su prefijo; con HTTPS van con `__Host-`.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { cookieName } = await import('../src/auth.js');
const { hmac } = await import('../src/secret.js');
let h: Awaited<ReturnType<typeof createHarness>>;
let agent: Awaited<ReturnType<typeof h.loginAs>>;
const AGENT = { email: 'agente@s.mx', password: 'Pz-901-Qx-902-Kv' };

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Agente', role: 'agent', ...AGENT });
  assert.equal(r.statusCode, 200, r.body);
  agent = await h.loginAs(AGENT.email, AGENT.password);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const newestSession = async (email: string) =>
  (await pool.query(`SELECT s.id, extract(epoch FROM s.expires_at - s.created_at) AS secs FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1`, [email])).rows[0];
const me = (cookie: string) => h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
const payloadOf = (cookie: string) => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString());
const signed = (data: object, prefix: string) => {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `cp_session=${payload}.${hmac(prefix + payload)}`;
};

test('cookieName con y sin HTTPS', () => {
  assert.equal(cookieName('cp_session', true), '__Host-cp_session');
  assert.equal(cookieName('cp_session', false), 'cp_session');
  assert.equal(cookieName('cp_mfa', true), '__Host-cp_mfa');
});

t('máximo: 7 días para el equipo y 12 h para el superadmin', async () => {
  assert.equal(Math.round(Number((await newestSession(AGENT.email)).secs) / 3600), 7 * 24);
  assert.equal(Math.round(Number((await newestSession('admin@test.mx')).secs) / 3600), 12);
});

t('una cookie sin sid o firmada sin el prefijo no entra', async () => {
  const data = payloadOf(agent.cookie);
  assert.ok(data.sid, 'la cookie del panel lleva sid');
  assert.equal((await me(agent.cookie)).statusCode, 200);
  const { sid, ...noSid } = data;
  void sid;
  assert.equal((await me(signed(noSid, 'session:'))).statusCode, 401, 'sin sid');
  assert.equal((await me(signed(data, ''))).statusCode, 401, 'sin el prefijo de la firma');
});

t('el último uso se anota como mucho cada minuto', async () => {
  const { id } = await newestSession(AGENT.email);
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
  assert.equal((await agent('GET', '/api/me')).statusCode, 200);
  const age = (await pool.query(`SELECT extract(epoch FROM now() - last_seen_at) AS secs FROM user_sessions WHERE id = $1`, [id])).rows[0].secs;
  assert.ok(Number(age) < 30, `se actualizó (hace ${age} s)`);
});

t('lo que el panel consulta solo (la campana, refrescar la pantalla) no cuenta como uso, pero sí cierra la sesión vencida', async () => {
  const { id } = await newestSession(AGENT.email);
  const bell = () => h.app.inject({ method: 'GET', url: '/api/notifications?limit=1', headers: { cookie: agent.cookie, 'x-panel-background': '1' } });
  const age = async () => Number((await pool.query(`SELECT extract(epoch FROM now() - last_seen_at) AS secs FROM user_sessions WHERE id = $1`, [id])).rows[0].secs);
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
  assert.equal((await bell()).statusCode, 200);
  assert.ok((await age()) >= 299, 'la campana no movió el último uso');
  assert.equal((await agent('GET', '/api/notifications?limit=1')).statusCode, 200);
  assert.ok((await age()) < 30, 'una petición de la persona sí');
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '12 hours 1 minute' WHERE id = $1`, [id]);
  assert.equal((await bell()).json().code, 'session_idle', 'con la sesión vencida, la campana lleva a entrar');
  agent = await h.loginAs(AGENT.email, AGENT.password);
});

t('12 h sin uso cierran la sesión del equipo; 30 min la del superadmin', async () => {
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '11 hours 50 minutes' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [AGENT.email]);
  assert.equal((await agent('GET', '/api/me')).statusCode, 200, 'menos de 12 h: sigue');
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '12 hours 1 minute' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [AGENT.email]);
  const r = await agent('GET', '/api/me');
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().code, 'session_idle');
  assert.equal(r.json().error, 'Tu sesión se cerró por inactividad');
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id = (SELECT id FROM users WHERE email = 'admin@test.mx')`);
  assert.equal((await h.authed('GET', '/api/me')).json().code, 'session_idle');
});
