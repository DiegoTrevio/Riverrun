/**
 * Mensajes y trabajos confiables (auditoría, PR 3): correos que fallan se reintentan, el ciclo de vida no se encima,
 * los errores guardan su mensaje, el estado de conexión no rechaza el aviso, el recordatorio de pago se reintenta, la
 * IA tiene tiempo límite también al leer, los trabajos que tumban el proceso no se retoman para siempre, las citas se
 * mueven en un solo paso y un recordatorio viejo no sale.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
process.env.SUPERADMIN_DIGEST_HOUR = '0';

const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { lifecycleTick, checkTrials } = await import('../src/lifecycle.js');
const { sendSuperadminDigest } = await import('../src/platform/digest.js');
const { recoverStaleJobs } = await import('../src/automation/store.js');
const { OpenAiProvider } = await import('../src/ai/provider.js');
const { pruneRateLimits, rateLimited } = await import('../src/auth.js');
const { todayIn } = await import('../src/receivables/index.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const acc = (url: string) => `${url}${url.includes('?') ? '&' : '?'}account_id=${h.accountId}`;

/** Falla a propósito: un trigger que lanza un error al escribir en la tabla cuando la fila cumple `cond`. */
async function breakTable(table: string, cond: string, events = 'INSERT OR UPDATE') {
  await pool.query(`CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falla simulada'; END $$`);
  await pool.query(`CREATE TRIGGER test_boom BEFORE ${events} ON ${table} FOR EACH ROW WHEN (${cond}) EXECUTE FUNCTION test_boom()`);
  return () => pool.query(`DROP TRIGGER test_boom ON ${table}`);
}
const jobs = async (type: string) => (await pool.query(`SELECT * FROM jobs WHERE type = $1 ORDER BY id`, [type])).rows;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  // Un administrador de la cuenta: a quien le llegan los avisos del equipo.
  await h.addUser({ account_id: h.accountId, name: 'Caja', email: 'caja@confiable.mx', password: 'Pz-144-Qx-344-Kv', role: 'admin' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
  smtpServer.close();
});

t('correo: si el servidor de correo falla, el aviso de fin de prueba se reintenta solo (sin repetir el aviso del panel)', async () => {
  await pool.query(`UPDATE accounts SET status = 'trial', active = true, trial_warned_at = NULL, trial_ends_at = now() + interval '2 days', owner_user_id = (SELECT id FROM users WHERE email = 'admin@test.mx') WHERE id = $1`, [h.accountId]);
  smtp.fail = true;
  await checkTrials();
  const [job] = await jobs('mail_retry');
  assert.ok(job, 'el correo quedó para reintentarse');
  assert.equal(job.payload.mail.subject, 'Tu periodo de prueba está por terminar');
  // El reintento vuelve a fallar: queda pendiente con el mensaje del error.
  await pool.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
  await h.service.scheduler.runDue();
  const failed = (await pool.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [job.id])).rows[0];
  assert.equal(failed.status, 'pending');
  assert.match(failed.last_error, /^job_execution_failed: El servidor de correo sigue fallando/, 'el error guarda su mensaje');
  // Vuelve el servidor de correo: sale en el siguiente intento.
  smtp.fail = false;
  smtp.received.length = 0;
  await pool.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
  await h.service.scheduler.runDue();
  assert.equal((await pool.query(`SELECT status FROM jobs WHERE id = $1`, [job.id])).rows[0].status, 'done');
  assert.equal(smtp.received.length, 1);
  // La prueba ya estaba avisada: otra vuelta no lo vuelve a mandar.
  await checkTrials();
  assert.equal((await jobs('mail_retry')).length, 1);
});

t('resumen del superadmin: si el correo falla, los avisos no se dan por enviados y el día se libera para reintentar', async () => {
  await pool.query(`INSERT INTO superadmin_digest (title, body) VALUES ('Algo pasó', 'detalle')`);
  const unsent = async () => (await pool.query(`SELECT count(*)::int AS n FROM superadmin_digest WHERE sent_at IS NULL`)).rows[0].n;
  const before = await unsent();
  smtp.fail = true;
  assert.equal(await sendSuperadminDigest(), 0);
  assert.equal(await unsent(), before, 'siguen pendientes');
  smtp.fail = false;
  assert.equal(await sendSuperadminDigest(), before, 'en la siguiente vuelta salen');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM superadmin_digest WHERE sent_at IS NULL`)).rows[0].n, 0);
});

t('ciclo de vida: una vuelta no se encima con la anterior, y con varias instancias corre solo una', async () => {
  const [a, b] = await Promise.all([lifecycleTick(), lifecycleTick()]);
  assert.deepEqual([a, b].sort(), ['busy', 'ran']);
  const other = await pool.connect();
  try {
    await other.query(`SELECT pg_advisory_lock(hashtextextended('riverrun:lifecycle-tick', 0))`);
    assert.equal(await lifecycleTick(), 'locked');
    await other.query(`SELECT pg_advisory_unlock(hashtextextended('riverrun:lifecycle-tick', 0))`);
  } finally {
    other.release();
  }
  assert.equal(await lifecycleTick(), 'ran');
});

t('webhook: un error al guardar el estado de conexión no rechaza el aviso', async () => {
  const fix = await breakTable('channels', `NEW.connection_state IS DISTINCT FROM OLD.connection_state`, 'UPDATE');
  try {
    const r = await h.app.inject({ method: 'POST', url: `/webhook/${h.token}`, payload: { event: 'connection.update', instance: 'palmas', data: { state: 'open' } } });
    assert.equal(r.statusCode, 200, 'antes respondía 503 y el proveedor reintentaba el aviso entero');
  } finally {
    await fix();
  }
  const [log] = (await pool.query(`SELECT details FROM event_logs WHERE message = 'webhook_connection_state_failed' ORDER BY id DESC LIMIT 1`)).rows;
  assert.match(log.details.error, /falla simulada/);
});

t('trabajos: uno que se colgó (el proceso murió) se retoma, salvo si ya se tomó 3 veces', async () => {
  const ins = (attempts: number) => pool.query(
    `INSERT INTO jobs (account_id, type, payload, run_at, status, attempts, started_at) VALUES ($1, 'no_existe', '{}', now(), 'running', $2, now() - interval '10 minutes') RETURNING id`,
    [h.accountId, attempts]);
  const fresh = (await ins(1)).rows[0].id;
  const dead = (await ins(3)).rows[0].id;
  await recoverStaleJobs();
  const rows = (await pool.query(`SELECT id, status, last_error FROM jobs WHERE id = ANY($1) ORDER BY id`, [[fresh, dead]])).rows;
  assert.deepEqual(rows.map((r) => r.status), ['pending', 'failed']);
  assert.equal(rows[1].last_error, 'recovered_too_often');
  await pool.query(`UPDATE jobs SET status = 'cancelled' WHERE id = ANY($1)`, [[fresh, dead]]);
});

t('IA: un proveedor que manda los encabezados y luego se queda callado se corta por tiempo', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"choices":[');
    // Nunca termina el cuerpo.
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const ai = new OpenAiProvider('clave', `http://127.0.0.1:${port}/v1`, 300, 'openai', 1);
  const started = Date.now();
  try {
    await assert.rejects(() => ai.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hola' }] } as any), /Tiempo de espera agotado/);
    assert.ok(Date.now() - started < 5000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

t('límites en memoria: lo vencido se borra con el temporizador, sin esperar a 10,000 claves', async () => {
  assert.equal(rateLimited('prueba-limpieza', 1, 1), false);
  await new Promise((r) => setTimeout(r, 5));
  pruneRateLimits();
  // La ventana ya pasó y se olvidó: vuelve a empezar en el primer intento (no cuenta el anterior).
  assert.equal(rateLimited('prueba-limpieza', 1, 60_000), false);
  assert.equal(rateLimited('prueba-limpieza', 1, 60_000), true);
});

t('recordatorio de pago: si no sale por algo pasajero se reintenta en una hora (hasta 3) y luego avisa; una baja no se reintenta', async () => {
  await h.webhook('Hola, ¿cuánto debo?', { phone: '5215520003001' });
  await h.idle();
  const conv = await h.conversationFor('5215520003001');
  const r = await h.authed('POST', acc('/api/receivables'), { contact_id: conv.contact_id, concept: 'Renta de octubre', amount_cents: 150000, due_date: todayIn('America/Mexico_City'), reminders: [0] });
  assert.equal(r.statusCode, 201, r.body);
  const id = r.json().receivable.id;
  const pending = async () => (await pool.query(`SELECT payload, run_at FROM jobs WHERE status = 'pending' AND type = 'receivable_reminder' AND payload->>'receivable_id' = $1`, [id])).rows;
  const runReminder = async () => {
    const q = await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'receivable_reminder' AND payload->>'receivable_id' = $1 RETURNING id`, [id]);
    assert.ok(q.rowCount, 'había un recordatorio pendiente');
    await h.service.scheduler.runDue();
    await h.idle();
  };
  // Si el recordatorio de hoy ya pasó de hora, se programa a mano para que la prueba no dependa del reloj.
  if (!(await pending()).length) await pool.query(`INSERT INTO jobs (account_id, type, payload, run_at) VALUES ($1, 'receivable_reminder', $2, now())`, [h.accountId, { receivable_id: id, offset: 0 }]);

  // El canal está desconectado: no sale, pero es pasajero. (Un error 5xx al enviar es «entrega incierta» y no se
  // repite, para no duplicar; un rechazo seguro como este sí.)
  await pool.query(`UPDATE channels SET active = false WHERE id = $1`, [h.channelId]);
  await runReminder();
  const [next] = await pending();
  assert.equal(next?.payload.retry, 1, 'se reprogramó');
  assert.ok(new Date(next.run_at).getTime() > Date.now() + 50 * 60_000, 'para dentro de una hora');

  for (let i = 0; i < 3; i++) await runReminder();
  assert.equal((await pending()).length, 0, 'al tercer reintento ya no se programa otro');
  const alert = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'payment' AND title LIKE '💳 No salió un recordatorio de pago%'`)).rows[0].n;
  assert.ok(alert >= 1, 'se avisó al equipo');
  await pool.query(`UPDATE channels SET active = true WHERE id = $1`, [h.channelId]);

  // Con baja STOP no sale y no se reintenta: no es pasajero.
  await pool.query(`UPDATE contacts SET opted_out = true WHERE id = $1`, [conv.contact_id]);
  await pool.query(`INSERT INTO jobs (account_id, type, payload, run_at) VALUES ($1, 'receivable_reminder', $2, now())`, [h.accountId, { receivable_id: id, offset: 1 }]);
  await h.service.scheduler.runDue();
  assert.equal((await pending()).length, 0);
});

t('citas: mover una cita es un solo paso (si falla a la mitad no queda sin recordatorios) y un recordatorio de la hora anterior no sale', async () => {
  const s = await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Consulta', kind: 'appointment', duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 5, reminders: [60] });
  assert.equal(s.statusCode, 200, s.body);
  const serviceId = s.json().id;
  await h.webhook('Quiero una consulta', { phone: '5215520004001' });
  await h.idle();
  const conv = await h.conversationFor('5215520004001');
  const slots = (await h.authed('GET', `/api/services/${serviceId}/slots`)).json();
  const [first, second] = slots.slice(-2);
  const created = await h.authed('POST', '/api/appointments', { service_id: serviceId, slot: first.key, conversation_id: conv.id, notify_customer: false });
  assert.equal(created.statusCode, 200, created.body);
  const appt = created.json();
  const reminders = async () => (await pool.query(`SELECT payload FROM jobs WHERE status = 'pending' AND type = 'appointment_reminder' AND payload->>'appointment_id' = $1`, [appt.id])).rows;
  const before = await reminders();
  assert.equal(before.length, 1);

  // Falla al programar el recordatorio nuevo: la cita no se mueve y conserva el suyo.
  const fix = await breakTable('jobs', `NEW.type = 'appointment_reminder'`, 'INSERT');
  const moved = await h.authed('PUT', `/api/appointments/${appt.id}`, { slot: second.key });
  await fix();
  assert.notEqual(moved.statusCode, 200);
  const still = (await pool.query(`SELECT starts_at FROM appointments WHERE id = $1`, [appt.id])).rows[0];
  assert.equal(new Date(still.starts_at).getTime(), new Date(appt.starts_at).getTime(), 'la cita sigue a su hora');
  assert.deepEqual(await reminders(), before, 'con su recordatorio');

  // Sin falla se mueve, y su recordatorio lleva la hora nueva.
  assert.equal((await h.authed('PUT', `/api/appointments/${appt.id}`, { slot: second.key })).statusCode, 200);
  const [current] = await reminders();
  const startsAt = (await pool.query(`SELECT starts_at FROM appointments WHERE id = $1`, [appt.id])).rows[0].starts_at;
  assert.equal(new Date(current.payload.starts_at).getTime(), new Date(startsAt).getTime());

  // Un recordatorio que quedó con la hora anterior no sale.
  h.reset();
  await pool.query(`UPDATE jobs SET payload = jsonb_set(payload, '{starts_at}', to_jsonb($2::text)), run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'appointment_reminder' AND payload->>'appointment_id' = $1`,
    [appt.id, new Date(appt.starts_at).toISOString()]);
  await h.service.scheduler.runDue();
  await h.idle();
  assert.equal(h.sent.filter((x) => x.to === '5215520004001').length, 0);
});
