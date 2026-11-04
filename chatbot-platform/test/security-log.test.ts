/**
 * Etapa 7 (detección): bitácora de seguridad, reglas que avisan al superadmin y quién la ve.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const { outbox } = await import('../src/mailer.js');
const { notifyUser } = await import('../src/identity/notices.js');
const { pruneSecurityEvents, recordSecurity, RULES, settleSecurityAlerts } = await import('../src/security-log.js');
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
  await h.addUser({ account_id: h.accountId, email: 'objetivo@seguridad.mx', name: 'Objetivo', password: PASS, role: 'agent' });
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
  for (let i = 0; i < 40; i++) await failLogin(`victima${i % 6}@lista.mx`, ip);
  await settleSecurityAlerts();
  assert.equal((await events(`kind = 'alert.stuffing' AND ip = $1`, [ip])).length, 1);
  assert.equal(alertsTo(/Muchos accesos fallidos desde una IP/).length, 1);
  assert.match(alertsTo(/Muchos accesos fallidos desde una IP/)[0].text, /10\.9\.1\.1/);
  // Los correos que no son cuentas no se guardan (solo su huella); los frenados por el límite, una fila por ventana.
  const rows = await events(`ip = $1 AND kind LIKE 'login.%'`, [ip]);
  assert.ok(rows.every((r) => r.email === '' && /^[0-9a-f]{16}$/.test(r.details.who)));
  assert.equal(rows.filter((r) => r.kind === 'login.blocked').length, 1, '32 intentos frenados dejan una sola fila');
});

t('muchas contraseñas fallidas contra una persona (desde varias IP): aviso de fuerza bruta', async () => {
  for (let i = 0; i < RULES.bruteForceFailures; i++) await failLogin('objetivo@seguridad.mx', `10.9.2.${i + 1}`);
  await settleSecurityAlerts();
  const a = await events(`kind = 'alert.bruteforce' AND target = 'objetivo@seguridad.mx'`);
  assert.equal(a.length, 1);
  // El intento contra una persona de la cuenta queda en la cuenta: su administrador lo ve.
  const failed = await events(`kind = 'login.failed' AND email = 'objetivo@seguridad.mx'`);
  assert.ok(failed.every((r) => r.account_id === h.accountId && r.user_id));
  assert.equal(alertsTo(/adivinar la contraseña/).length, 1);
});

t('un superadmin desde un dispositivo nuevo avisa al momento; un administrador, no', async () => {
  const sup = (await pool.query(`SELECT id, email, name, account_id FROM users WHERE role = 'superadmin' LIMIT 1`)).rows[0];
  const before = alertsTo(/Acceso de superadmin/).length;
  await notifyUser(sup, 'new_device', { device: 'Firefox en Linux', ip: '203.0.113.9' });
  await settleSecurityAlerts();
  assert.equal(alertsTo(/Acceso de superadmin/).length, before + 1);
  assert.equal((await events(`kind = 'notice.new_device' AND user_id = $1`, [sup.id])).at(-1).ip, '203.0.113.9');
  const admin = (await pool.query(`SELECT id, email, name, account_id FROM users WHERE email = 'duena@seguridad.mx'`)).rows[0];
  await notifyUser(admin, 'new_device', { device: 'Chrome', ip: '203.0.113.10' });
  await settleSecurityAlerts();
  assert.equal(alertsTo(/Acceso de superadmin/).length, before + 1, 'solo los superadmin');
});

t('muchas descargas de datos de una persona en una hora: aviso; quedan con quién y desde dónde', async () => {
  const owner = await h.loginAs('duena@seguridad.mx', PASS);
  for (let i = 0; i < RULES.exportsPerHour; i++) {
    const r = await owner('GET', '/api/export/contacts.csv');
    assert.equal(r.statusCode, 200, r.body);
  }
  assert.equal((await owner('GET', '/api/export/contacts.csv?since=ayer')).statusCode, 400);
  await settleSecurityAlerts();
  const rows = await events(`kind = 'export.contacts' AND email = 'duena@seguridad.mx'`);
  assert.equal(rows.length, RULES.exportsPerHour, 'la petición mal formada no cuenta como descarga');
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

t('tope global: muchos avisos distintos en una hora mandan uno de «demasiados» y el resto solo se anota', async () => {
  const before = outbox.filter((m) => m.to === 'operador@seguridad.mx').length;
  // Quien controla el objetivo abre un aviso por correo atacado: aquí 15 personas distintas.
  for (let p = 0; p < 15; p++) {
    for (let i = 0; i < RULES.bruteForceFailures; i++) await recordSecurity({ kind: 'login.failed', email: `inunda${p}@lista.mx`, ip: `10.9.5.${i + 1}` });
  }
  await settleSecurityAlerts();
  const sent = outbox.filter((m) => m.to === 'operador@seguridad.mx').length - before;
  assert.ok(sent < 15, `se mandaron ${sent}`);
  assert.equal(alertsTo(/Demasiados avisos de seguridad/).length, 1);
  assert.equal((await events(`kind = 'alert.bruteforce' AND target LIKE 'inunda%'`)).length, 15, 'todos quedan en la bitácora');
});

t('el administrador ve los intentos fallidos contra su gente (sin la IP completa)', async () => {
  const owner = await h.loginAs('duena@seguridad.mx', PASS);
  const rows = (await owner('GET', '/api/security-events?kind=login.failed&limit=500')).json();
  const r = rows.find((x: any) => x.email === 'objetivo@seguridad.mx');
  assert.ok(r);
  assert.match(r.ip, /…$/);
  assert.equal(rows.length <= 500 && rows.every((x: any) => !x.kind.startsWith('alert.')), true);
});

t('sesiones, invitaciones, altas y bajas del equipo y restablecer la contraseña quedan en la bitácora', async () => {
  const owner = await h.loginAs('duena@seguridad.mx', PASS);
  // Cerrar las otras sesiones (pide verificación reciente: la de loginAs ya lo es).
  assert.equal((await owner('POST', '/api/me/sessions/revoke-others')).statusCode, 200);
  assert.ok((await events(`kind = 'session.revoked_others' AND account_id = $1`, [h.accountId])).length >= 1);
  // Invitar y cancelar.
  const inv = await owner('POST', '/api/invitations', { email: 'nuevo@seguridad.mx', role: 'agent' });
  assert.equal(inv.statusCode, 200, inv.body);
  assert.equal((await owner('DELETE', `/api/invitations/${inv.json().id}`)).statusCode, 200);
  const invites = await events(`kind LIKE 'invite.%' AND target = 'nuevo@seguridad.mx'`);
  assert.deepEqual(invites.map((r) => r.kind), ['invite.created', 'invite.revoked']);
  assert.equal(invites[0].email, 'duena@seguridad.mx', 'quién invitó');
  // Dar de baja, volver a dar de alta y eliminar a una persona.
  const temp = await h.addUser({ account_id: h.accountId, email: 'temporal@seguridad.mx', name: 'Temporal', password: PASS, role: 'agent' });
  assert.equal((await owner('PUT', `/api/users/${temp.id}`, { active: false })).statusCode, 200);
  assert.equal((await owner('PUT', `/api/users/${temp.id}`, { active: true })).statusCode, 200);
  assert.equal((await owner('DELETE', `/api/users/${temp.id}`)).statusCode, 200);
  assert.deepEqual((await events(`kind LIKE 'user.%' AND target = 'temporal@seguridad.mx'`)).map((r) => r.kind), ['user.deactivated', 'user.reactivated', 'user.deleted']);
  // Pedir restablecer la contraseña (solo si es una cuenta) y un enlace inválido.
  await h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: '10.9.7.1', payload: { email: 'agente@seguridad.mx' } });
  await h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: '10.9.7.1', payload: { email: 'nadie@seguridad.mx' } });
  await waitFor(async () => (await events(`kind = 'password_reset.requested' AND email = 'agente@seguridad.mx'`)).length === 1);
  assert.equal((await events(`kind = 'password_reset.requested' AND email = 'nadie@seguridad.mx'`)).length, 0);
  const bad = await h.app.inject({ method: 'POST', url: '/api/reset-password', remoteAddress: '10.9.7.2', payload: { token: 'enlace-que-no-existe-123', password: 'Pz-555-Qx-556-Kv' } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await events(`kind = 'password_reset.failed' AND ip = '10.9.7.2'`)).length, 1);
});

t('una IP que prueba listas de contraseñas queda bloqueada (aun con la contraseña buena) y el superadmin la desbloquea', async () => {
  const ip = '10.9.3.3';
  for (let i = 0; i < 12; i++) await failLogin(`lista${i % 6}@bloqueo.mx`, ip);
  const blocked = await events(`kind = 'ip.blocked' AND ip = $1`, [ip]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].details.minutes, RULES.autoblockMinutes);
  await settleSecurityAlerts();
  assert.match(alertsTo(/Muchos accesos fallidos desde una IP/).at(-1)!.text, /ya no puede entrar durante 60 minutos/);
  const good = () => h.app.inject({ method: 'POST', url: '/api/login', remoteAddress: ip, payload: { email: 'duena@seguridad.mx', password: PASS } });
  assert.equal((await good()).statusCode, 429, 'bloqueada aunque la contraseña sea la buena');
  // Un administrador no puede desbloquear; el superadmin sí, y queda anotado.
  const owner = await h.loginAs('duena@seguridad.mx', PASS);
  assert.equal((await owner('POST', '/api/system/security/unblock', { ip })).statusCode, 403);
  const r = await h.authed('POST', '/api/system/security/unblock', { ip });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().was_blocked, true);
  assert.equal((await events(`kind = 'ip.unblocked' AND target = $1`, [ip])).length, 1);
  assert.notEqual((await good()).statusCode, 429, 'vuelve a poder entrar');
  assert.equal((await h.authed('POST', '/api/system/security/unblock', { ip: 'no-es-ip' })).statusCode, 400);
});

t('las descargas se comparan con lo normal de cada persona: quien siempre descarga mucho no dispara el aviso', async () => {
  const heavy = await h.addUser({ account_id: h.accountId, email: 'contadora@seguridad.mx', name: 'Contadora', password: PASS, role: 'admin' });
  // Su costumbre: 8 descargas en una hora hace dos días.
  for (let i = 0; i < 8; i++) {
    await pool.query(`INSERT INTO security_events (kind, account_id, user_id, email, at) VALUES ('export.contacts', $1, $2, 'contadora@seguridad.mx', now() - interval '2 days')`, [h.accountId, heavy.id]);
  }
  const api = await h.loginAs('contadora@seguridad.mx', PASS);
  for (let i = 0; i < RULES.exportsPerHour + 2; i++) assert.equal((await api('GET', '/api/export/contacts.csv')).statusCode, 200);
  await settleSecurityAlerts();
  assert.equal((await events(`kind = 'alert.exports' AND target = $1`, [heavy.id])).length, 0, '7 en una hora es menos del doble de su costumbre (8)');
  // Al doble de lo de siempre, sí avisa.
  for (let i = 0; i < 9; i++) await api('GET', '/api/export/contacts.csv');
  await settleSecurityAlerts();
  assert.equal((await events(`kind = 'alert.exports' AND target = $1`, [heavy.id])).length, 1);
});

t('se conserva SECURITY_LOG_DAYS aunque la cuenta ya no exista; lo más viejo se depura', async () => {
  await recordSecurity({ kind: 'account.deleted', accountId: '00000000-0000-4000-8000-000000000001', target: 'Cuenta que ya no existe' });
  await pool.query(`INSERT INTO security_events (kind, at) VALUES ('login.ok', now() - make_interval(days => $1))`, [config.securityLogDays + 1]);
  const removed = await pruneSecurityEvents();
  assert.ok(removed >= 1);
  assert.equal((await events(`at < now() - make_interval(days => $1)`, [config.securityLogDays])).length, 0);
  assert.equal((await events(`kind = 'account.deleted' AND target = 'Cuenta que ya no existe'`)).length, 1);
});
