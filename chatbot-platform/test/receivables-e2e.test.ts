/**
 * Cobros de punta a punta, como los vive un negocio: ajustes, alta desde el panel, recordatorios que salen por la cola
 * de trabajos en su día, «ya te transferí», pausa, marcar pagado, vencido sin pagar y los casos de borde.
 * El paso del tiempo se simula moviendo el vencimiento y adelantando el trabajo del día que toca.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
const { config } = await import('../src/config.js');
const { todayIn } = await import('../src/receivables/index.js');
const { zonedToUtc } = await import('../src/automation/time.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let contactId = '';
let convId = '';
const TZ = 'America/Mexico_City';
const today = (offset = 0) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  return new Date(Date.parse(`${d}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
};
const acc = (url: string) => `${url}${url.includes('?') ? '&' : '?'}account_id=${h.accountId}`;
const jobsOf = async (id: string) => (await pool.query(`SELECT type, payload, run_at FROM jobs WHERE status = 'pending' AND payload->>'receivable_id' = $1 ORDER BY run_at`, [id])).rows;
const get = async (id: string) => (await h.authed('GET', `/api/receivables/${id}`)).json().receivable;
const create = async (body: Record<string, unknown>) => {
  const r = await h.authed('POST', acc('/api/receivables'), { contact_id: contactId, amount_cents: 180000, due_date: today(5), ...body });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
};
/** «Pasa el tiempo»: el vencimiento queda a la distancia de hoy que tendría ese día. */
const shiftDue = (id: string, due: string) => pool.query(`UPDATE receivables SET due_date = $2 WHERE id = $1`, [id, due]);
/** Llega la hora de un trabajo (el recordatorio de un desfase, o el de vencido): corre por la cola como en producción. */
async function runJob(id: string, type: 'receivable_reminder' | 'receivable_overdue', offset?: number) {
  const r = await pool.query(
    `UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = $2 AND payload->>'receivable_id' = $1 AND ($3::int IS NULL OR (payload->>'offset')::int = $3) RETURNING id`,
    [id, type, offset ?? null]);
  assert.ok(r.rowCount, `no había trabajo ${type} ${offset ?? ''} pendiente`);
  await h.service.scheduler.runDue();
  await h.idle();
}
const sentAbout = (concept: string) => h.sent.filter((s) => s.text.includes(concept));
const alerts = async (like: string, concept = '%') => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'payment' AND title LIKE $1 AND body LIKE $2`, [like, concept])).rows[0].n;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  await h.addUser({ account_id: h.accountId, name: 'Caja', email: 'caja@e2e.mx', password: 'Pz-144-Qx-344-Kv', role: 'admin' });
  h.setScript(() => ({ messages: ['Gracias, el equipo lo revisa y te confirma.'] }));
  await h.webhook('Hola, quiero reservar');
  await h.idle();
  const conv = await h.conversationFor();
  contactId = conv.contact_id;
  convId = conv.id;
  const s = await h.authed('PUT', acc('/api/receivables/settings'), {
    payment_instructions: 'Transferencia a la CLABE 012180001234567890 a nombre de Hotel Palmas.',
    default_reminders: [-3, 0, 3, 7], send_at: '10:00', respect_business_hours: false,
  });
  assert.equal(s.statusCode, 200, s.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('recorrido: alta → recordatorio antes → «ya te transferí» (aviso y pausa) → el día → marcar pagado y no se insiste más', async () => {
  const { receivable: r, scheduled } = await create({ concept: 'Reservación de octubre', payment_link: 'https://pagos.palmas.mx/r/77' });
  assert.equal(scheduled, 4);
  const jobs = await jobsOf(r.id);
  // Cada recordatorio a las 10:00 de su día, en la zona del negocio.
  const first = jobs.find((j) => j.type === 'receivable_reminder' && j.payload.offset === -3)!;
  assert.equal(new Date(first.run_at).toISOString(), zonedToUtc(today(2), '10:00', TZ).toISOString());

  // Día −3: sale el «antes», con monto, fecha, instrucciones y enlace, y queda en la conversación como recordatorio de pago.
  h.reset();
  await shiftDue(r.id, today(3));
  await runJob(r.id, 'receivable_reminder', -3);
  const before = sentAbout('Reservación de octubre');
  assert.equal(before.length, 1, JSON.stringify(h.sent));
  assert.match(before[0].text, /te recordamos que tu pago de Reservación de octubre por \$1,800\.00 vence el /);
  assert.match(before[0].text, /Paga aquí: https:\/\/pagos\.palmas\.mx\/r\/77/);
  assert.match(before[0].text, /CLABE 012180001234567890/);
  const stored = (await pool.query(`SELECT meta FROM messages WHERE conversation_id = $1 AND direction = 'out' AND meta->>'source' = 'payment_reminder'`, [convId])).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].meta.receivable_id, r.id);
  assert.equal((await get(r.id)).reminders_sent, 1);

  // El cliente avisa que ya pagó: el equipo recibe el aviso, se pausan los recordatorios y el asistente no lo confirma.
  await h.webhook('Ya te transferí, en un rato te paso el comprobante');
  await h.idle();
  await waitFor(async () => (await alerts('%dice que ya pagó%')) === 1);
  const paused = await get(r.id);
  assert.ok(paused.paused_until && new Date(paused.paused_until).getTime() > Date.now() + 47 * 3600_000, 'pausa de 48 h');
  assert.match(JSON.stringify(h.calls.at(-1)?.messages ?? []), /Nunca confirmes que el pago llegó/);

  // Llega el día del vencimiento durante la pausa: no sale; se mueve a la hora de envío después de la pausa.
  h.reset();
  await shiftDue(r.id, today(0));
  await runJob(r.id, 'receivable_reminder', 0);
  assert.equal(sentAbout('Reservación de octubre').length, 0);
  const moved = (await jobsOf(r.id)).find((j) => j.type === 'receivable_reminder' && j.payload.offset === 0)!;
  const end = new Date(paused.paused_until);
  assert.ok(new Date(moved.run_at) >= end, 'no antes de que termine la pausa');
  assert.ok(new Date(moved.run_at).getTime() - end.getTime() <= 86400_000, 'el primer día de envío después de la pausa');
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(moved.run_at)), '10:00');

  // El equipo verifica y lo marca pagado: se cancela todo lo pendiente y nada más sale aunque pase el tiempo.
  const paid = await h.authed('POST', `/api/receivables/${r.id}/paid`, { note: 'SPEI 0045' });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().receivable.status, 'paid');
  assert.deepEqual(await jobsOf(r.id), []);
  h.reset();
  await shiftDue(r.id, today(-8));
  await h.fastForward();
  await h.idle();
  assert.equal(sentAbout('Reservación de octubre').length, 0);
  assert.equal(await alerts('%Pago vencido%', '%Reservación de octubre%'), 0, 'un cobro pagado no avisa de vencido');
});

t('al terminar la pausa sigue pendiente: sale un solo recordatorio aunque la pausa haya juntado varios', async () => {
  const { receivable: r } = await create({ concept: 'Paquete de spa', reminders: [2, 3] });
  await h.webhook('Ya pagué');
  await h.idle();
  await waitFor(async () => Boolean((await get(r.id)).paused_until));
  await shiftDue(r.id, today(-3));
  await runJob(r.id, 'receivable_reminder', 2);
  await runJob(r.id, 'receivable_reminder', 3);
  const later = (await jobsOf(r.id)).filter((j) => j.type === 'receivable_reminder');
  assert.equal(later.length, 2, 'los dos quedaron para después de la pausa');
  // Termina la pausa y el equipo no lo marcó: los dos trabajos corren en el mismo momento, pero sale uno.
  await pool.query(`UPDATE receivables SET paused_until = now() - interval '1 minute' WHERE id = $1`, [r.id]);
  h.reset();
  await h.fastForward();
  await h.idle();
  const out = sentAbout('Paquete de spa');
  assert.equal(out.length, 1, JSON.stringify(h.sent));
  assert.match(out[0].text, /venció el /, 'ya vencido usa el texto de vencido');
  assert.equal((await get(r.id)).reminders_sent, 1);
});

t('vencido sin pagar: el aviso al equipo sale una vez y el recordatorio usa el texto de vencido', async () => {
  const { receivable: r } = await create({ concept: 'Mensualidad de gimnasio' });
  await shiftDue(r.id, today(-1));
  await runJob(r.id, 'receivable_overdue');
  await waitFor(async () => (await alerts('%Pago vencido%', '%Mensualidad de gimnasio%')) === 1);
  // Correr otra vez el trabajo (reintento) no repite el aviso.
  await h.service.receivables.runOverdue({ receivable_id: r.id });
  assert.equal(await alerts('%Pago vencido%', '%Mensualidad de gimnasio%'), 1);
  h.reset();
  await shiftDue(r.id, today(-3));
  await runJob(r.id, 'receivable_reminder', 3);
  const out = sentAbout('Mensualidad de gimnasio');
  assert.equal(out.length, 1);
  assert.match(out[0].text, /venció el .*Si ya pagaste, envíanos tu comprobante/s);
});

t('«Recordar ahora» desde el panel cuenta como el de hoy: el programado del mismo día ya no se repite', async () => {
  const { receivable: r } = await create({ concept: 'Clase muestra', reminders: [0] });
  h.reset();
  const now = await h.authed('POST', `/api/receivables/${r.id}/remind`);
  assert.equal(now.statusCode, 200, now.body);
  await shiftDue(r.id, today(0));
  await runJob(r.id, 'receivable_reminder', 0);
  assert.equal(sentAbout('Clase muestra').length, 1);
});

t('editar solo el concepto no toca la moneda, el enlace, la referencia ni los días propios', async () => {
  const { receivable: r } = await create({ concept: 'Hospedaje', currency: 'USD', payment_link: 'https://pagos.palmas.mx/r/9', reference: 'RES-9', reminders: [-1, 2] });
  const edited = await h.authed('PUT', `/api/receivables/${r.id}`, { concept: 'Hospedaje (2 noches)' });
  assert.equal(edited.statusCode, 200, edited.body);
  const after = edited.json().receivable;
  assert.equal(after.concept, 'Hospedaje (2 noches)');
  assert.equal(after.currency, 'USD');
  assert.equal(after.payment_link, 'https://pagos.palmas.mx/r/9');
  assert.equal(after.reference, 'RES-9');
  assert.deepEqual(after.reminders, [-1, 2]);
});

t('bordes: nada en el pasado, cambio de fecha reprograma y la fecha local cerca de medianoche', async () => {
  // Venció hace 2 días y su único recordatorio era el día del vencimiento: no se programa nada que ya pasó (ni su
  // aviso de vencido, que era ayer a las 10:00). Con «ayer» no basta: antes de las 10:00 locales su aviso sigue por venir.
  const old = await create({ concept: 'Cobro atrasado', due_date: today(-2), reminders: [0] });
  assert.equal(old.scheduled, 0);
  assert.deepEqual(await jobsOf(old.receivable.id), []);
  // Vence hoy: el aviso de vencido queda para mañana a las 10:00 locales, a cualquier hora que se registre.
  const dueToday = await create({ concept: 'Cobro de hoy', due_date: today(0), reminders: [0] });
  const overdue = (await jobsOf(dueToday.receivable.id)).filter((j) => j.type === 'receivable_overdue');
  assert.deepEqual(overdue.map((j) => new Date(j.run_at).toISOString()), [zonedToUtc(today(1), '10:00', TZ).toISOString()]);
  // Cambiar la fecha reprograma con los mismos días.
  const r = await create({ concept: 'Taller de cerámica' });
  const moved = await h.authed('PUT', `/api/receivables/${r.receivable.id}`, { due_date: today(30) });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().scheduled, 4);
  const first = (await jobsOf(r.receivable.id)).find((j) => j.payload.offset === -3)!;
  assert.equal(new Date(first.run_at).toISOString(), zonedToUtc(today(27), '10:00', TZ).toISOString());
  // 23:30 en Ciudad de México ya es el día siguiente en UTC: cuenta el día del negocio.
  assert.equal(todayIn(TZ, new Date('2026-10-26T05:30:00Z')), '2026-10-25');
  assert.equal(todayIn(TZ, new Date('2026-10-26T06:30:00Z')), '2026-10-26');
  assert.equal(zonedToUtc('2026-10-25', '23:30', TZ).toISOString(), '2026-10-26T05:30:00.000Z');
});

t('API v1: repetir el alta con el mismo source_id (reintento del ERP) no duplica el cobro', async () => {
  const key = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'ERP', scope: 'write' })).json().key;
  const v1 = (payload: unknown) => h.app.inject({ method: 'POST', url: '/api/v1/receivables', payload: payload as any, headers: { authorization: `Bearer ${key}` } });
  const body = { contact_id: contactId, concept: 'Factura A-120', amount_cents: 50000, due_date: today(9), source_id: 'erp-A-120' };
  const a = await v1(body);
  assert.equal(a.statusCode, 201, a.body);
  const b = await v1(body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.json().id, a.json().id);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM receivables WHERE source_id = 'erp-A-120'`)).rows[0].n, 1);
});

t('con RECEIVABLES_ENABLED=false la sección no existe: panel y API responden 404 y el menú no la muestra', async () => {
  const key = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Caja', scope: 'write' })).json().key;
  const v1 = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${key}` } });
  const { receivable: r } = await create({ concept: 'Apagado' });
  config.receivables.enabled = false;
  try {
    assert.equal((await h.authed('GET', acc('/api/receivables'))).statusCode, 404);
    assert.equal((await v1('GET', '/api/v1/receivables')).statusCode, 404);
    assert.equal((await v1('POST', `/api/v1/receivables/${r.id}/paid`, {})).statusCode, 404);
  } finally {
    config.receivables.enabled = true;
  }
});

t('un cliente pausa sus recordatorios dos veces por cobro; a la tercera solo se avisa al equipo', async () => {
  const { receivable: r } = await create({ concept: 'Mensualidad de clases', reminders: [1] });
  for (let i = 1; i <= 3; i++) {
    await pool.query(`UPDATE receivables SET paused_until = NULL WHERE id = $1`, [r.id]);
    await h.webhook(i === 2 ? 'Ya te pagué' : 'Ya pagué');
    await h.idle();
    await h.service.automator.settleAll();
    if (i <= 2) await waitFor(async () => Boolean((await get(r.id)).paused_until));
  }
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE message LIKE '%ya pausó sus recordatorios 2 veces%'`)).rows[0].n > 0);
  assert.equal((await get(r.id)).paused_until, null, 'la tercera vez ya no se pausa');
});
