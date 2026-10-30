/**
 * Avisos al equipo confiables: cada entrega por WhatsApp o correo queda registrada y se reintenta; lo urgente sale por el
 * otro canal si uno falla; si no llega por ningún lado, el panel lo dice y los administradores se enteran; nada se da por
 * avisado sin estar registrado; y el panel muestra qué llegó.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Servidor de correo falso (antes de cargar la configuración): acepta o rechaza los envíos según `smtp.fail`.
const smtp = { fail: false, received: [] as string[] };
const smtpServer = net.createServer((sock) => {
  sock.write('220 prueba ESMTP\r\n');
  let data = false;
  let body = '';
  sock.on('data', (chunk) => {
    for (const line of chunk.toString().split('\r\n')) {
      if (data) {
        if (line === '.') { data = false; smtp.received.push(body); body = ''; sock.write('250 OK\r\n'); } else body += `${line}\n`;
        continue;
      }
      if (!line) continue;
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 prueba\r\n');
      else if (cmd === 'MAIL') sock.write(smtp.fail ? '451 Falla temporal de prueba\r\n' : '250 OK\r\n');
      else if (cmd === 'RCPT') sock.write('250 OK\r\n');
      else if (cmd === 'DATA') { data = true; sock.write('354 Adelante\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 Adiós\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => undefined);
});
await new Promise<void>((r) => smtpServer.listen(0, '127.0.0.1', r));
process.env.SMTP_URL = `smtp://127.0.0.1:${(smtpServer.address() as net.AddressInfo).port}`;
process.env.SUPERADMIN_EMAIL = 'duena@plataforma.mx';

const { createHarness, dbAvailable, pool, waitFor } = await import('./harness.js');
const { attemptDelivery, newAlertKey, processAlertReceipts, queueDelivery } = await import('../src/automation/alert-delivery.js');
const { pruneAutomationData } = await import('../src/automation/store.js');
const { notifyDisconnected } = await import('../src/lifecycle.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let boss = '';
const BOSS_PHONE = '5215511110001';
const BOSS_EMAIL = 'jefa@entregas.mx';

const alertTeam = (o: Record<string, unknown>) => h.service.automator.alertTeam(h.accountId, { title: 'Aviso', body: 'Texto', userIds: [boss], ...o } as any);
const receipts = async (title: string) => (await pool.query(`SELECT * FROM alert_receipts WHERE payload->>'title' = $1 ORDER BY id`, [title])).rows;
const toBoss = () => h.sent.filter((s) => s.to === BOSS_PHONE);
const setPrefs = async (alert_prefs: object) => assert.equal((await h.authed('PUT', `/api/users/${boss}`, { alert_prefs })).statusCode, 200);
/** Que el siguiente reintento toque ya (sin esperar los minutos de espera). */
const dueNow = (title: string, attempts?: number) =>
  pool.query(`UPDATE alert_receipts SET next_attempt_at = now()${attempts ? `, attempts = ${attempts}` : ''} WHERE payload->>'title' = $1 AND status = 'pending'`, [title]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  await pool.query(`UPDATE channels SET connection_state = 'open' WHERE id = $1`, [h.channelId]);
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Jefa', email: BOSS_EMAIL, password: 'Pz-120-Qx-320-Kv', role: 'admin', phone: BOSS_PHONE, notify_whatsapp: true });
  assert.equal(r.statusCode, 200, r.body);
  boss = r.json().id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
  smtpServer.close();
});

t('un WhatsApp que falla queda registrado y sale en el reintento (sin respaldo si no es urgente)', async () => {
  h.failNext.text = 1;
  await alertTeam({ title: 'Cita nueva', kind: 'appointment' });
  let [r, ...rest] = await receipts('Cita nueva');
  assert.equal(rest.length, 0, 'un aviso que no es urgente no sale por correo');
  assert.equal(r.channel, 'whatsapp');
  assert.equal(r.status, 'pending');
  assert.equal(r.attempts, 1);
  assert.match(r.last_error, /HTTP 500/);
  assert.equal(toBoss().length, 0);
  await dueNow('Cita nueva');
  await processAlertReceipts();
  [r] = await receipts('Cita nueva');
  assert.equal(r.status, 'sent');
  assert.equal(r.attempts, 2);
  assert.ok(r.sent_at);
  assert.equal(toBoss().filter((s) => s.text.includes('Cita nueva')).length, 1);
});

t('un correo que falla se reintenta y sale', async () => {
  await setPrefs({ agenda: { whatsapp: false, email: true } });
  smtp.fail = true;
  await alertTeam({ title: 'Cita por correo', kind: 'appointment' });
  smtp.fail = false;
  let [r] = await receipts('Cita por correo');
  assert.equal(r.channel, 'email');
  assert.equal(r.status, 'pending');
  await dueNow('Cita por correo');
  await processAlertReceipts();
  [r] = await receipts('Cita por correo');
  assert.equal(r.status, 'sent');
  await setPrefs({});
});

t('urgente: si falla el WhatsApp, el aviso llega por correo aunque la persona tenga el correo apagado', async () => {
  await setPrefs({ errors: { email: false } });
  const mails = smtp.received.length;
  h.failNext.text = 1;
  await alertTeam({ title: '🚨 Posible emergencia', kind: 'safety' });
  const [wa, mail] = await receipts('🚨 Posible emergencia');
  assert.equal(wa.channel, 'whatsapp');
  assert.equal(wa.status, 'pending');
  assert.equal(mail.channel, 'email');
  assert.equal(mail.destination, BOSS_EMAIL);
  assert.equal(mail.fallback_of, wa.id);
  assert.equal(mail.status, 'sent');
  assert.equal(smtp.received.length, mails + 1);
  assert.match(smtp.received.at(-1)!, /Posible emergencia/);
  await setPrefs({});
});

t('si fallan los dos canales, el aviso del panel lo dice y los administradores reciben un solo aviso', async () => {
  const fail = async (title: string) => {
    smtp.fail = true;
    h.failNext.text = 10;
    await alertTeam({ title, kind: 'safety' });
    await dueNow(title, 3);
    await processAlertReceipts();
    smtp.fail = false;
    h.failNext.text = 0;
    return receipts(title);
  };
  const rows = await fail('🚨 Falla doble');
  assert.deepEqual(rows.map((r) => r.status).sort(), ['failed', 'failed']);
  const n = (await pool.query(`SELECT body FROM notifications WHERE user_id = $1 AND title = '🚨 Falla doble'`, [boss])).rows[0];
  assert.match(n.body, /No se pudo entregar por WhatsApp ni por correo/);
  const told = async () => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND title LIKE '%Un aviso no le llegó a Jefa'`, [h.accountId])).rows[0].n;
  assert.equal(await told(), 1);
  // Otra falla el mismo día no vuelve a avisar a los administradores (pero su aviso del panel sí lleva la marca).
  await fail('🚨 Falla doble otra vez');
  assert.equal(await told(), 1);
});

t('un WhatsApp del negocio desconectado no se usa: el aviso urgente sale por correo', async () => {
  await setPrefs({ errors: { email: false } });
  await pool.query(`UPDATE channels SET connection_state = 'close' WHERE id = $1`, [h.channelId]);
  const before = toBoss().length;
  try {
    await alertTeam({ title: '⚠️ Error con línea caída', kind: 'ai_error' });
  } finally {
    await pool.query(`UPDATE channels SET connection_state = 'open' WHERE id = $1`, [h.channelId]);
  }
  const [wa, mail] = await receipts('⚠️ Error con línea caída');
  assert.match(wa.last_error, /desconectado/);
  assert.equal(toBoss().length, before, 'no se intentó por la línea caída');
  assert.equal(mail.channel, 'email');
  assert.equal(mail.status, 'sent');
  await setPrefs({});
});

t('si el aviso de «espera a una persona» falla antes de registrarse, la marca se devuelve y la siguiente vuelta lo manda', async () => {
  const phone = '5215530007001';
  await h.webhook('hola', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  await h.idle();
  const conv = await h.conversationFor(phone);
  await pool.query(`UPDATE conversations SET status = 'human', human_reminded_at = NULL WHERE id = $1`, [conv.id]);
  await h.webhook('¿me atienden?', { phone });
  await h.idle();
  await pool.query(`UPDATE messages SET created_at = now() - interval '60 minutes' WHERE conversation_id = $1`, [conv.id]);
  const original = h.service.automator.alertTeam;
  h.service.automator.alertTeam = async () => { throw new Error('base caída'); };
  try {
    await h.service.remindHumanWaiting();
  } finally {
    h.service.automator.alertTeam = original;
  }
  const mark = async () => (await pool.query(`SELECT human_reminded_at FROM conversations WHERE id = $1`, [conv.id])).rows[0].human_reminded_at;
  assert.equal(await mark(), null, 'el recordatorio no quedó como enviado');
  assert.ok(await h.service.remindHumanWaiting() >= 1);
  assert.ok(await mark());
  const n = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'handoff_wait' AND link = $2`, [boss, `#/conversation/${conv.id}`]);
  assert.equal(n.rowCount, 1);
});

t('dos avisos iguales al mismo tiempo llegan una sola vez', async () => {
  const phone = '5215530007002';
  await h.webhook('hola', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  await h.idle();
  const conv = await h.conversationFor(phone);
  const link = `#/conversation/${conv.id}`;
  const o = { title: '🙋 Quiere hablar con alguien', body: 'Igual', link, conversationId: conv.id, kind: 'handoff', userIds: undefined, roles: ['admin'] };
  await Promise.all([alertTeam(o), alertTeam(o), alertTeam(o)]);
  const n = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND link = $2 AND title = $3`, [boss, link, o.title]);
  assert.equal(n.rowCount, 1);
});

t('un aviso urgente sin nadie que lo reciba queda en la bitácora y le llega al superadmin una vez al día', async () => {
  const mails = smtp.received.length;
  await alertTeam({ title: 'Nadie', kind: 'safety', userIds: ['00000000-0000-0000-0000-000000000000'] });
  await alertTeam({ title: 'Nadie otra vez', kind: 'safety', userIds: ['00000000-0000-0000-0000-000000000000'] });
  const logs = await pool.query(`SELECT 1 FROM event_logs WHERE account_id = $1 AND details->>'reason' = 'alert_no_recipients'`, [h.accountId]);
  assert.equal(logs.rowCount, 2);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await pool.query(`SELECT 1 FROM system_state WHERE key = $1`, [`alert-no-recipients:${h.accountId}:${day}`])).rowCount, 1);
  await waitFor(async () => smtp.received.length > mails, 4000);
  assert.equal(smtp.received.slice(mails).filter((m) => /Avisos sin destinatario/.test(m)).length, 1);
});

t('el WhatsApp del equipo se guarda solo con la lada del país', async () => {
  const bad = await h.authed('PUT', `/api/users/${boss}`, { phone: '5512345678' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /lada del país/);
  const created = await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Corto', email: 'corto@entregas.mx', password: 'Pz-121-Qx-321-Kv', role: 'agent', phone: '55 1234 5678' });
  assert.equal(created.statusCode, 400);
  assert.equal((await h.authed('PUT', '/api/me', { phone: '123' })).statusCode, 400);
  assert.equal((await h.authed('PUT', `/api/users/${boss}`, { phone: `+${BOSS_PHONE}` })).statusCode, 200);
  // Un número guardado antes, sin lada, no impide guardar lo demás (el panel siempre manda el teléfono).
  await pool.query(`UPDATE users SET phone = '5512345678' WHERE id = $1`, [boss]);
  assert.equal((await h.authed('PUT', `/api/users/${boss}`, { name: 'Jefa', phone: '55 1234 5678' })).statusCode, 200);
  const jefa = await h.loginAs(BOSS_EMAIL, 'Pz-120-Qx-320-Kv');
  assert.equal((await jefa('PUT', '/api/me', { name: 'Jefa', phone: '5512345678', available: true })).statusCode, 200);
  assert.equal((await jefa('PUT', '/api/me', { phone: '5598765432' })).statusCode, 400, 'cambiarlo sí exige la lada');
  assert.equal((await h.authed('PUT', `/api/users/${boss}`, { phone: BOSS_PHONE })).statusCode, 200);
});

t('un intento que tardó de más no pisa el resultado de quien retomó la entrega', async () => {
  const r = await queueDelivery({ accountId: h.accountId, userId: boss, alertKey: newAlertKey(), kind: 'appointment', channel: 'whatsapp', destination: BOSS_PHONE, payload: { title: 'Lento', body: 'x' } });
  // Mientras tanto otra revisión lo retomó y ya va en su segundo intento.
  await pool.query(`UPDATE alert_receipts SET attempts = 1, last_error = 'otro intento' WHERE id = $1`, [r.id]);
  assert.equal(await attemptDelivery(r), 'sent');
  const [row] = await receipts('Lento');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'otro intento');
});

t('panel: cada aviso dice por dónde llegó, el administrador ve lo que no llegó y lo puede reintentar', async () => {
  const jefa = await h.loginAs(BOSS_EMAIL, 'Pz-120-Qx-320-Kv');
  const list = (await jefa('GET', '/api/notifications')).json();
  const emergency = list.items.find((n: any) => n.title === '🚨 Posible emergencia');
  assert.deepEqual(emergency.deliveries.map((d: any) => [d.channel, d.fallback]), [['whatsapp', false], ['email', true]]);
  assert.equal(emergency.deliveries[1].status, 'sent');
  assert.equal(typeof list.whatsapp_failing, 'boolean');

  const failed = (await jefa('GET', '/api/alert-deliveries')).json();
  const row = failed.find((d: any) => d.title === '🚨 Falla doble' && d.channel === 'email');
  assert.ok(row, 'la entrega fallida aparece');
  assert.equal(row.user_name, 'Jefa');
  const retry = await jefa('POST', `/api/alert-deliveries/${row.id}/retry`);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().status, 'sent');
  assert.equal((await jefa('POST', `/api/alert-deliveries/${row.id}/retry`)).statusCode, 404, 'una entrega que ya salió no se reintenta');
  assert.equal((await jefa('POST', '/api/alert-deliveries/abc/retry')).statusCode, 404);

  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Agente', email: 'agente@entregas.mx', password: 'Pz-122-Qx-322-Kv', role: 'agent' })).statusCode, 200);
  const agent = await h.loginAs('agente@entregas.mx', 'Pz-122-Qx-322-Kv');
  assert.equal((await agent('GET', '/api/alert-deliveries')).statusCode, 403);
  assert.equal((await agent('POST', `/api/alert-deliveries/${row.id}/retry`)).statusCode, 403);
});

t('los avisos urgentes sin leer no se borran a los 60 días', async () => {
  const add = (title: string, kind: string) => pool.query(
    `INSERT INTO notifications (account_id, user_id, title, body, kind, created_at) VALUES ($1, $2, $3, '', $4, now() - interval '90 days')`, [h.accountId, boss, title, kind]);
  await add('viejo urgente', 'safety');
  await add('viejo normal', 'appointment');
  await pruneAutomationData(60);
  const left = (await pool.query(`SELECT title FROM notifications WHERE title LIKE 'viejo %'`)).rows.map((r) => r.title);
  assert.deepEqual(left, ['viejo urgente']);
});

t('el aviso de WhatsApp desconectado queda registrado y es urgente (lleva respaldo)', async () => {
  await notifyDisconnected({ id: h.channelId, account_id: h.accountId, name: 'palmas', type: 'whatsapp' });
  const rows = (await pool.query(`SELECT * FROM alert_receipts WHERE kind = 'channel' AND user_id = $1`, [boss])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'email');
  assert.equal(rows[0].status, 'sent');
  assert.ok(rows[0].notification_id, 'ligado a su aviso del panel');
  assert.equal(rows[0].payload.excludeChannelId, h.channelId, 'el respaldo por WhatsApp no usa la línea que se cayó');
});
