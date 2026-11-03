/**
 * Etapa 7 (detección): bitácora de seguridad, reglas que avisan al superadmin y quién la ve.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const { outbox } = await import('../src/mailer.js');
const { notifyUser } = await import('../src/identity/notices.js');
const { pruneSecurityEvents, recordSecurity, RULES } = await import('../src/security-log.js');
let h: Awaited<ReturnType<typeof createHarness>>;

const PASS = 'Pz-771-Qx-772-Kv';
const events = async (where: string, params: unknown[] = []) => (await pool.query(`SELECT * FROM security_events WHERE ${where} ORDER BY id`, params)).rows;
const alertsTo = (re: RegExp) => outbox.filter((m) => m.to === 'operador@seguridad.mx' && re.test(m.subject));
const failLogin = (email: string, ip: string) => h.app.inject({ method: 'POST', url: '/api/login', remoteAddress: ip, payload: { email, password: 'equivocada-123' } });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  config.signup.superadminEmail = 'operador@seguridad.mx';
  await h.addUser({ account_id: h.accountId, email: 'duena@seguridad.mx', name: 'Dueña', password: PASS, role: 'admin' });
  await h.addUser({ account_id: h.accountId, email: 'agente@seguridad.mx', name: 'Agente', password: PASS, role: 'agent' });
});
after(async () => {
  config.signup.superadminEmail = '';
  if (h) await h.app.close();
  await pool.end();
});

t('entrar y fallar al entrar quedan en la bitácora (sin guardar lo que no es un correo)', async () => {
  await h.loginAs('duena@seguridad.mx', PASS);
  const okRows = await events(`kind = 'login.ok' AND email = 'duena@seguridad.mx'`);
  assert.equal(okRows.length, 1);
  assert.equal(okRows[0].account_id, h.accountId);
  assert.equal(okRows[0].details.mfa, true);
  assert.equal((await failLogin('duena@seguridad.mx', '10.9.0.1')).statusCode, 401);
  assert.equal((await failLogin('mi-contraseña-secreta', '10.9.0.1')).statusCode, 401);
  const failed = await events(`kind = 'login.failed' AND ip = '10.9.0.1'`);
  assert.deepEqual(failed.map((r) => r.email), ['duena@seguridad.mx', ''], 'la contraseña escrita en el correo no se guarda');
});

t('muchas contraseñas fallidas desde una IP contra varias personas: un aviso al superadmin (no uno por intento)', async () => {
  const ip = '10.9.1.1';
  for (let i = 0; i < RULES.stuffingFailures + 5; i++) await failLogin(`victima${i % 6}@lista.mx`, ip);
  assert.equal((await events(`kind = 'alert.stuffing' AND ip = $1`, [ip])).length, 1);
  assert.equal(alertsTo(/Muchos accesos fallidos desde una IP/).length, 1);
  assert.match(alertsTo(/Muchos accesos fallidos/)[0].text, /10\.9\.1\.1/);
  // Los intentos frenados por el límite de la IP también cuentan.
  assert.ok((await events(`kind = 'login.blocked' AND ip = $1`, [ip])).length > 0);
});

t('muchas contraseñas fallidas contra una persona (desde varias IP): aviso de fuerza bruta', async () => {
  for (let i = 0; i < RULES.bruteForceFailures; i++) await failLogin('objetivo@seguridad.mx', `10.9.2.${i + 1}`);
  const a = await events(`kind = 'alert.bruteforce' AND target = 'objetivo@seguridad.mx'`);
  assert.equal(a.length, 1);
  assert.equal(alertsTo(/adivinar la contraseña/).length, 1);
});

t('un superadmin desde un dispositivo nuevo avisa al momento; un administrador, no', async () => {
  const sup = (await pool.query(`SELECT id, email, name, account_id FROM users WHERE role = 'superadmin' LIMIT 1`)).rows[0];
  const before = alertsTo(/Acceso de superadmin/).length;
  await notifyUser(sup, 'new_device', { device: 'Firefox en Linux', ip: '203.0.113.9' });
  assert.equal(alertsTo(/Acceso de superadmin/).length, before + 1);
  assert.equal((await events(`kind = 'notice.new_device' AND user_id = $1`, [sup.id])).at(-1).ip, '203.0.113.9');
  const admin = (await pool.query(`SELECT id, email, name, account_id FROM users WHERE email = 'duena@seguridad.mx'`)).rows[0];
  await notifyUser(admin, 'new_device', { device: 'Chrome', ip: '203.0.113.10' });
  assert.equal(alertsTo(/Acceso de superadmin/).length, before + 1, 'solo los superadmin');
});

t('muchas descargas de datos de una persona en una hora: aviso; quedan con quién y desde dónde', async () => {
  const owner = await h.loginAs('duena@seguridad.mx', PASS);
  for (let i = 0; i < RULES.exportsPerHour; i++) {
    const r = await owner('GET', '/api/export/contacts.csv');
    assert.equal(r.statusCode, 200, r.body);
  }
  const rows = await events(`kind = 'export.contacts' AND email = 'duena@seguridad.mx'`);
  assert.equal(rows.length, RULES.exportsPerHour);
  assert.equal(rows[0].account_id, h.accountId);
  assert.equal((await events(`kind = 'alert.exports'`)).length, 1);
  assert.equal(alertsTo(/Muchas descargas de datos/).length, 1);
});

t('quién la ve: el superadmin todo; el administrador lo de su cuenta, sin avisos ni IP completas de otros; el agente no', async () => {
  const all = (await h.authed('GET', '/api/system/security-events?limit=500')).json();
  assert.ok(all.some((r: any) => r.kind === 'alert.stuffing'), 'el superadmin ve los avisos');
  assert.ok((await h.authed('GET', '/api/system/security-events?kind=alert')).json().every((r: any) => r.kind.startsWith('alert.')));
  const owner = await h.loginAs('duena@seguridad.mx', PASS);
  assert.equal((await owner('GET', '/api/system/security-events')).statusCode, 403);
  const mine = (await owner('GET', '/api/security-events?limit=500')).json();
  assert.ok(mine.length > 0);
  assert.ok(mine.every((r: any) => r.account_id === h.accountId && !r.kind.startsWith('alert.')));
  const other = mine.find((r: any) => r.user_id && r.email !== 'duena@seguridad.mx' && r.ip);
  if (other) assert.match(other.ip, /…$/, 'la IP de otra persona va recortada');
  const agent = await h.loginAs('agente@seguridad.mx', PASS);
  assert.equal((await agent('GET', '/api/security-events')).statusCode, 403);
});

t('cambios de seguridad (avisos al usuario) y llaves de la API quedan anotados', async () => {
  const owner = await h.loginAs('duena@seguridad.mx', PASS);
  const k = await owner('POST', '/api/api-keys', { name: 'Integración X', scope: 'read' });
  assert.equal(k.statusCode, 200, k.body);
  assert.equal((await owner('DELETE', `/api/api-keys/${k.json().id}`)).statusCode, 200);
  assert.deepEqual((await events(`kind LIKE 'apikey.%' AND account_id = $1`, [h.accountId])).map((r) => r.kind), ['apikey.created', 'apikey.revoked']);
  const admin = (await pool.query(`SELECT id, email, name, account_id FROM users WHERE email = 'duena@seguridad.mx'`)).rows[0];
  await notifyUser(admin, 'role_changed', { by: 'admin@test.mx', role: 'administrador' });
  const n = (await events(`kind = 'notice.role_changed' AND user_id = $1`, [admin.id])).at(-1);
  assert.equal(n.details.by, 'admin@test.mx');
});

t('se conserva SECURITY_LOG_DAYS aunque la cuenta ya no exista; lo más viejo se depura', async () => {
  await recordSecurity({ kind: 'account.deleted', accountId: '00000000-0000-4000-8000-000000000001', target: 'Cuenta que ya no existe' });
  await pool.query(`INSERT INTO security_events (kind, at) VALUES ('login.ok', now() - make_interval(days => $1))`, [config.securityLogDays + 1]);
  const removed = await pruneSecurityEvents();
  assert.ok(removed >= 1);
  assert.equal((await events(`at < now() - make_interval(days => $1)`, [config.securityLogDays])).length, 0);
  assert.equal((await events(`kind = 'account.deleted' AND target = 'Cuenta que ya no existe'`)).length, 1);
});
