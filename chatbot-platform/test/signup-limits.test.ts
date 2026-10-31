/**
 * Topes del registro guardados en la base (formulario y Google): por conexión, 5 intentos por hora y 3 cuentas creadas
 * por hora o 10 por día (IPv6 agrupada por /64); en toda la plataforma, SIGNUP_DAILY_MAX cuentas por día, con un aviso
 * al superadministrador al 80 %. Un registro que no se crea no cuenta para los topes de cuentas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
const { ipKey } = await import('../src/auth.js');
let h: Awaited<ReturnType<typeof createHarness>>;

let n = 0;
const signup = (ip: string, over: Record<string, unknown> = {}) =>
  h.app.inject({
    method: 'POST',
    url: '/api/signup',
    remoteAddress: ip,
    payload: { name: 'Prueba', company: `Negocio ${++n}`, business_type: 'otro', email: `alta${n}@topes.mx`, password: 'Pz-161-Qx-361-Kv', accept_terms: true, ...over },
  });
const hits = async (key: string) => (await pool.query(`SELECT hits FROM rate_limits WHERE key = $1 AND expires_at > now()`, [key])).rows[0]?.hits ?? 0;
const clearDay = () => pool.query(`DELETE FROM rate_limits WHERE key = 'signup-day'`);

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('desde una conexión, la cuarta cuenta en una hora no se crea (aunque sean pocos intentos)', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await signup('10.20.0.1')).statusCode, 200);
  const fourth = await signup('10.20.0.1');
  assert.equal(fourth.statusCode, 429, fourth.body);
  assert.match(fourth.json().error, /intenta más tarde/i);
});

t('dos IPv6 del mismo /64 cuentan juntas', async () => {
  for (const tail of ['1', '2', '3']) assert.equal((await signup(`2001:db8:5:6::${tail}`)).statusCode, 200);
  assert.equal((await signup('2001:db8:5:6::99')).statusCode, 429);
  assert.equal((await signup('2001:db8:5:7::1')).statusCode, 200, 'otro /64 sí');
});

t('la cuenta 11 del día desde una conexión no se crea', async () => {
  await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, 10, now() + interval '20 hours') ON CONFLICT (key) DO UPDATE SET hits = 10, expires_at = now() + interval '20 hours'`, [`signup-ip-d:${ipKey('10.20.0.9')}`]);
  assert.equal((await signup('10.20.0.9')).statusCode, 429);
});

t('en toda la plataforma: aviso al 80 % (uno) y al pasar SIGNUP_DAILY_MAX ya no se crean', async () => {
  const prev = { max: config.signup.dailyMax, email: config.signup.superadminEmail };
  Object.assign(config.signup, { dailyMax: 5, superadminEmail: 'super@topes.mx' });
  await clearDay();
  const alerts = () => outbox.filter((m) => m.to === 'super@topes.mx' && m.subject === 'Muchos registros hoy').length;
  try {
    for (let i = 1; i <= 5; i++) {
      assert.equal((await signup(`10.21.0.${i}`)).statusCode, 200, `registro ${i}`);
      assert.equal(alerts(), i >= 4 ? 1 : 0, `aviso tras el registro ${i}`);
    }
    const sixth = await signup('10.21.0.6');
    assert.equal(sixth.statusCode, 429, sixth.body);
    assert.equal(sixth.json().error, 'Intenta más tarde');
    assert.equal(await hits('signup-day'), 5, 'el rechazado no cuenta');
  } finally {
    Object.assign(config.signup, { dailyMax: prev.max, superadminEmail: prev.email });
    await clearDay();
  }
});

t('un registro rechazado (correo temporal o repetido) no cuenta para los topes de cuentas', async () => {
  await clearDay();
  assert.equal((await signup('10.22.0.1', { email: 'alguien@mailinator.com' })).statusCode, 400);
  assert.equal((await signup('10.22.0.1', { email: 'alta1@topes.mx' })).statusCode, 409);
  assert.equal(await hits('signup-day'), 0);
  assert.equal(await hits(`signup-ip-h:${ipKey('10.22.0.1')}`), 0);
});

t('el registro con Google comparte los topes de la conexión', async () => {
  await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, 5, now() + interval '1 hour') ON CONFLICT (key) DO UPDATE SET hits = 5, expires_at = now() + interval '1 hour'`, [`signup-try:${ipKey('10.23.0.1')}`]);
  const r = await h.app.inject({ method: 'POST', url: '/api/signup/google', remoteAddress: '10.23.0.1', payload: { token: 'x', company: 'Con Google', accept_terms: true } });
  assert.equal(r.statusCode, 429, r.body);
});
