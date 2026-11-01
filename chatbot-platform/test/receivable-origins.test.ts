/** Cobros que se crean solos: pagos recurrentes, anticipo de una cita y desde una cotización que el cliente aceptó. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
const { dueAfter, dueOnOrAfter, runPlans } = await import('../src/receivables/plans.js');
const { addMonths, planCharges, acceptedTotal } = await import('../src/quotes/accept.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let agent: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
let contactId = '';
let convId = '';
const TZ = 'America/Mexico_City';
const ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
const today = (offset = 0) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  return new Date(Date.parse(`${d}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
};
const acc = (url: string) => `${url}${url.includes('?') ? '&' : '?'}account_id=${h.accountId}`;
const bySource = async (source: string, like: string) =>
  (await pool.query(`SELECT concept, amount_cents::int AS amount, to_char(due_date, 'YYYY-MM-DD') AS due, status, installment, source_id FROM receivables WHERE source = $1 AND source_id LIKE $2 ORDER BY due_date, source_id`, [source, like])).rows;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  await h.authed('PUT', acc('/api/settings'), { business_hours: ALL_DAY });
  await h.addUser({ account_id: h.accountId, name: 'Caja', email: 'caja@origenes.mx', password: 'Pz-144-Qx-344-Kv', role: 'admin' });
  const agentUser = await h.addUser({ account_id: h.accountId, name: 'Agente', email: 'agente@origenes.mx', password: 'Pz-144-Qx-344-Kv', role: 'agent' });
  agent = await h.loginAs('agente@origenes.mx', 'Pz-144-Qx-344-Kv');
  h.setScript(() => ({ messages: ['Claro, con gusto.'] }));
  await h.webhook('Hola, quiero agendar');
  await h.idle();
  const conv = await h.conversationFor();
  contactId = conv.contact_id;
  convId = conv.id;
  // El agente cobra a los clientes que tiene asignados (ID-11).
  assert.equal((await h.authed('PUT', `/api/conversations/${convId}/assign`, { user_id: agentUser.id })).statusCode, 200);
  assert.equal((await h.authed('PUT', acc('/api/receivables/settings'), { payment_instructions: 'CLABE 012180001234567890', default_reminders: [-1, 0], send_at: '10:00', respect_business_hours: false })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

/* ------------------------------ Pagos recurrentes ------------------------------ */

t('fechas de un plan: el día 31 cae en el último de los meses cortos; semanal y quincenal siguen su paso', async () => {
  const monthly = { frequency: 'monthly' as const, day: 31, starts_on: '2026-10-01' };
  assert.equal(dueOnOrAfter(monthly, '2026-10-01'), '2026-10-31');
  assert.equal(dueAfter(monthly, '2026-10-31'), '2026-11-30');
  assert.equal(dueAfter(monthly, '2026-11-30'), '2026-12-31');
  assert.equal(dueAfter(monthly, '2027-01-31'), '2027-02-28');
  assert.equal(dueAfter({ ...monthly, day: 15 }, '2026-12-15'), '2027-01-15');
  // 2026-10-25 es domingo: el primer lunes es el 26; quincenal cada 14 días desde ese primero.
  const weekly = { frequency: 'weekly' as const, day: 1, starts_on: '2026-10-25' };
  assert.equal(dueOnOrAfter(weekly, '2026-10-25'), '2026-10-26');
  assert.equal(dueAfter(weekly, '2026-10-26'), '2026-11-02');
  const biweekly = { frequency: 'biweekly' as const, day: 1, starts_on: '2026-10-25' };
  assert.equal(dueAfter(biweekly, '2026-10-26'), '2026-11-09');
  assert.equal(dueOnOrAfter(biweekly, '2026-11-03'), '2026-11-09', 'desde el primero, no desde hoy');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
});

t('pago recurrente: crea el cobro que ya toca, no lo duplica aunque la tarea corra dos veces y se termina al llegar al número de pagos', async () => {
  const day = Number(today(3).slice(8, 10));
  const r = await h.authed('POST', acc('/api/receivable-plans'), { contact_id: contactId, concept: 'Mensualidad del gimnasio', amount_cents: 75000, frequency: 'monthly', day, starts_on: today(0), max_payments: 2 });
  assert.equal(r.statusCode, 201, r.body);
  const plan = r.json().plan;
  assert.equal(r.json().created, 1, 'el de este mes vence en 3 días: se crea de una vez');
  assert.ok(plan.next_due > today(3));
  await runPlans(h.service.receivables);
  await runPlans(h.service.receivables);
  let rows = await bySource('recurring', `${plan.id}:%`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].due, today(3));
  assert.equal(rows[0].amount, 75000);
  // Un mes después: se crea el segundo y, con eso, el plan termina.
  await runPlans(h.service.receivables, new Date(Date.now() + 31 * 86400_000));
  rows = await bySource('recurring', `${plan.id}:%`);
  assert.equal(rows.length, 2);
  const after = (await h.authed('GET', acc('/api/receivable-plans'))).json().data.find((p: any) => p.id === plan.id);
  assert.equal(after.payments_created, 2);
  assert.equal(after.active, false);
  assert.equal(after.next_due, null);
  await runPlans(h.service.receivables, new Date(Date.now() + 70 * 86400_000));
  assert.equal((await bySource('recurring', `${plan.id}:%`)).length, 2, 'terminado: no crea más');
});

t('pausar un plan deja de crear cobros pero conserva los ya creados; borrar es solo del administrador', async () => {
  const r = await agent('POST', acc('/api/receivable-plans'), { contact_id: contactId, concept: 'Clase de natación', amount_cents: 40000, frequency: 'weekly', day: new Date(`${today(2)}T12:00:00Z`).getUTCDay(), starts_on: today(0) });
  assert.equal(r.statusCode, 201, r.body);
  const id = r.json().plan.id;
  // Lo que registra un agente queda por aprobar: sin cobros hasta que un administrador lo revisa.
  assert.equal((await bySource('recurring', `${id}:%`)).length, 0);
  assert.equal((await h.authed('POST', `/api/receivable-plans/${id}/approve`, {})).statusCode, 200);
  assert.ok((await bySource('recurring', `${id}:%`)).length >= 1);
  const paused = await agent('PUT', `/api/receivable-plans/${id}`, { active: false });
  assert.equal(paused.statusCode, 200, paused.body);
  const before = (await bySource('recurring', `${id}:%`)).length;
  await runPlans(h.service.receivables, new Date(Date.now() + 21 * 86400_000));
  assert.equal((await bySource('recurring', `${id}:%`)).length, before);
  assert.equal((await agent('DELETE', `/api/receivable-plans/${id}`)).statusCode, 403);
  assert.equal((await h.authed('DELETE', `/api/receivable-plans/${id}`)).statusCode, 200);
  assert.equal((await bySource('recurring', `${id}:%`)).length, before, 'los cobros se quedan');
  // Validaciones.
  assert.equal((await h.authed('POST', acc('/api/receivable-plans'), { contact_id: contactId, concept: 'X', amount_cents: 100, frequency: 'weekly', day: 9, starts_on: today(0) })).statusCode, 400);
  assert.equal((await h.authed('POST', acc('/api/receivable-plans'), { contact_id: contactId, concept: 'X', amount_cents: 100, frequency: 'monthly', day: 0, starts_on: today(0) })).statusCode, 400);
  assert.equal((await h.authed('POST', acc('/api/receivable-plans'), { contact_id: contactId, concept: 'X', amount_cents: 100, frequency: 'monthly', day: 5, starts_on: today(5), ends_on: today(1) })).statusCode, 400);
});

t('reanudar un plan pausado no cobra los periodos que pasaron mientras estuvo en pausa', async () => {
  const day = Number(today(2).slice(8, 10));
  const r = await h.authed('POST', acc('/api/receivable-plans'), { contact_id: contactId, concept: 'Cuota de mantenimiento', amount_cents: 50000, frequency: 'monthly', day, starts_on: today(0) });
  const id = r.json().plan.id;
  assert.equal((await bySource('recurring', `${id}:%`)).length, 1);
  await h.authed('PUT', `/api/receivable-plans/${id}`, { active: false });
  // Tres meses después se reanuda: solo se crea el que toca ahora, no los tres que pasaron.
  await h.authed('PUT', `/api/receivable-plans/${id}`, { active: true });
  await runPlans(h.service.receivables, new Date(Date.now() + 92 * 86400_000));
  const rows = await bySource('recurring', `${id}:%`);
  assert.ok(rows.length <= 2, JSON.stringify(rows));
  assert.ok(rows.every((x) => x.due === today(2) || x.due >= today(85)), JSON.stringify(rows));
});

t('API v1: registrar, consultar y desactivar un pago recurrente', async () => {
  const key = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'ERP', scope: 'write' })).json().key;
  const v1 = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${key}` } });
  const made = await v1('POST', '/api/v1/receivable-plans', { contact_id: contactId, concept: 'Renta del local', amount_cents: 1200000, frequency: 'monthly', day: 1, starts_on: today(40) });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json().receivables_created, 0, 'empieza en 40 días: aún no toca');
  assert.ok((await v1('GET', '/api/v1/receivable-plans')).json().data.some((p: any) => p.id === made.json().id));
  const off = await v1('POST', `/api/v1/receivable-plans/${made.json().id}/deactivate`);
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().active, false);
});

/* ------------------------------ Anticipo de cita ------------------------------ */

async function depositService(body: Record<string, unknown> = {}) {
  const r = await h.authed('POST', '/api/services', { account_id: h.accountId, name: `Masaje ${Math.random().toString(36).slice(2, 6)}`, duration_minutes: 60, min_notice_minutes: 0, max_days_ahead: 30, deposit_cents: 30000, deposit_due_hours: 24, ...body });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
/** Agenda desde el panel en un horario libre a partir de `minDay` (en la conversación del cliente). */
async function book(serviceId: string, minDay = today(4)) {
  const slots = (await h.authed('GET', `/api/services/${serviceId}/slots`)).json();
  const slot = slots.find((x: any) => x.key.slice(0, 10) >= minDay) ?? slots.at(-1);
  const r = await h.authed('POST', '/api/appointments', { service_id: serviceId, slot: slot.key, conversation_id: convId, notify_customer: false });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

t('anticipo: al agendar se registra el cobro con su vencimiento y al cliente le llega cuánto y cómo pagar', async () => {
  const svc = await depositService();
  const a = await book(svc.id);
  const [dep] = await bySource('appointment', a.id);
  assert.ok(dep, 'se creó el anticipo');
  assert.equal(dep.amount, 30000);
  assert.match(dep.concept, /^Anticipo: Masaje/);
  assert.equal(dep.due, localDay(new Date(Date.parse(a.starts_at) - 24 * 3600_000)), 'vence 24 h antes de la cita');
  // El aviso al cliente sale en un par de minutos (por la cola).
  h.reset();
  await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND dedupe_key LIKE '%:al-agendar'`);
  await h.service.scheduler.runDue();
  await h.idle();
  const msg = h.sent.find((s) => s.text.includes('Anticipo: Masaje'));
  assert.ok(msg, JSON.stringify(h.sent));
  assert.match(msg.text, /\$300\.00/);
  assert.match(msg.text, /CLABE 012180001234567890/);
  // Sin anticipo no se crea nada.
  const free = await depositService({ deposit_cents: 0 });
  const b = await book(free.id);
  assert.equal((await bySource('appointment', b.id)).length, 0);
});

t('anticipo desde la página pública (sin conversación): queda en Cobros y el correo de confirmación dice cuánto y cómo pagar', async () => {
  const { outbox } = await import('../src/mailer.js');
  const svc = await depositService();
  const slots = (await h.authed('GET', `/api/services/${svc.id}/slots`)).json();
  outbox.length = 0;
  const r = await h.service.agenda.book({ accountId: h.accountId, serviceId: svc.id, slotKey: (slots.find((x: any) => x.key.slice(0, 10) >= today(5)) ?? slots.at(-1)).key, customerName: 'Rosa Díaz', customerEmail: 'rosa@cliente.mx', source: 'pagina' });
  assert.ok(r.ok);
  const a = (r as any).appointment;
  const [dep] = await bySource('appointment', a.id);
  assert.equal(dep.amount, 30000);
  assert.equal(dep.status, 'pending');
  await h.service.agenda.mailCustomer(a, 'booked');
  const mail = outbox.find((m: any) => m.to === 'rosa@cliente.mx');
  assert.ok(mail, 'salió el correo de confirmación');
  assert.match(mail.text, /anticipo de \$300\.00/);
  assert.match(mail.text, /CLABE 012180001234567890/);
});

t('anticipo: cambiar la hora mueve su vencimiento; cancelar la cita cancela el anticipo', async () => {
  const svc = await depositService();
  const a = await book(svc.id);
  const slots = (await h.authed('GET', `/api/services/${svc.id}/slots`)).json();
  const later = slots.find((s: any) => s.key.slice(0, 10) >= today(9)) ?? slots.at(-1);
  const moved = await h.authed('PUT', `/api/appointments/${a.id}`, { slot: later.key });
  assert.equal(moved.statusCode, 200, moved.body);
  const appt = (await h.authed('GET', '/api/appointments')).json().find((x: any) => x.id === a.id);
  const [dep] = await bySource('appointment', a.id);
  assert.equal(dep.due, localDay(new Date(Date.parse(appt.starts_at) - 24 * 3600_000)));
  assert.equal(appt.deposit.status, 'pending', 'el detalle de la cita muestra su anticipo');
  assert.equal((await h.authed('POST', `/api/appointments/${a.id}/cancel`, { reason: 'El cliente no puede' })).statusCode, 200);
  assert.equal((await bySource('appointment', a.id))[0].status, 'canceled');
});

t('anticipo con «cancelar si no se pagó»: a la hora límite sin pago se cancela la cita y se avisa; pagado, la cita sigue', async () => {
  const svc = await depositService({ deposit_cancel_unpaid: true });
  const unpaid = await book(svc.id, today(4));
  const paid = await book(svc.id, today(6));
  assert.notEqual(unpaid.id, paid.id);
  const [dep] = (await pool.query(`SELECT id FROM receivables WHERE source = 'appointment' AND source_id = $1`, [paid.id])).rows;
  assert.equal((await h.authed('POST', `/api/receivables/${dep.id}/paid`, { note: 'SPEI' })).statusCode, 200);
  h.reset();
  await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'appointment_deposit_check'`);
  await h.service.scheduler.runDue();
  await h.idle();
  const status = async (id: string) => (await pool.query(`SELECT status, cancel_reason FROM appointments WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(await status(unpaid.id), { status: 'cancelled', cancel_reason: 'no se recibió el anticipo a tiempo' });
  assert.equal((await status(paid.id)).status, 'confirmed');
  assert.ok(h.sent.some((s) => /se canceló porque no recibimos el anticipo de \$300\.00/.test(s.text)), JSON.stringify(h.sent));
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE '%cancelada%' AND body LIKE '%se canceló sola%'`)).rows[0].n > 0);
  assert.equal((await bySource('appointment', unpaid.id))[0].status, 'canceled');
});

t('anticipo: si el cliente dijo «ya pagué», la cita no se cancela mientras el equipo lo verifica', async () => {
  const svc = await depositService({ deposit_cancel_unpaid: true });
  const a = await book(svc.id, today(10));
  await pool.query(`UPDATE receivables SET paused_until = now() + interval '1 day' WHERE source = 'appointment' AND source_id = $1`, [a.id]);
  await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'appointment_deposit_check' AND payload->>'appointment_id' = $1`, [a.id]);
  await h.service.scheduler.runDue();
  await h.idle();
  assert.equal((await pool.query(`SELECT status FROM appointments WHERE id = $1`, [a.id])).rows[0].status, 'confirmed');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'pending' AND type = 'appointment_deposit_check' AND payload->>'appointment_id' = $1`, [a.id])).rows[0].n, 1, 'se revisa otra vez al terminar la pausa');
});

/* ------------------------------ Desde una cotización ------------------------------ */

async function sentQuote(lines: any[], kind: 'final' | 'approximate' = 'final') {
  const { createQuote } = await import('../src/store/quotes.js');
  return createQuote({ accountId: h.accountId, kind, status: 'sent', source: 'panel', today: today(0), conversationId: convId, contactId, customer: { nombre: 'Ana' }, lines });
}

t('parcialidades: los centavos cuadran con el total y cada pago dice «n de N»', async () => {
  const three = planCharges('C-1', 100000, { type: 'installments', count: 3, every: 'month', first_due: '2026-11-30' });
  assert.deepEqual(three.map((c) => [c.amount_cents, c.due_date, c.installment]), [[33333, '2026-11-30', '1 de 3'], [33333, '2026-12-30', '2 de 3'], [33334, '2027-01-30', '3 de 3']]);
  const dep = planCharges('C-1', 100001, { type: 'deposit', percent: 30, due_date: '2026-11-01', rest_due_date: '2026-12-01' });
  assert.equal(dep[0].amount_cents + dep[1].amount_cents, 100001);
  assert.throws(() => planCharges('C-1', 1000, { type: 'deposit', percent: 30, due_date: '2026-12-01', rest_due_date: '2026-11-01' }), /resto no puede vencer antes/);
  assert.throws(() => acceptedTotal({ total_min: 100, total_max: 200, open_ended: false, has_tbd: false }), /rango/);
  assert.throws(() => acceptedTotal({ total_min: 100, total_max: 200, open_ended: false, has_tbd: false }, 250), /mayor que el máximo/);
  assert.equal(acceptedTotal({ total_min: 100, total_max: 200, open_ended: false, has_tbd: false }, 150), 150);
});

t('cotización aceptada: anticipo y resto como cobros con «2 de 2»; avisa a las reglas; no se acepta dos veces ni la acepta un agente', async () => {
  const rule = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Aceptó', trigger: { type: 'quote_accepted' }, actions: [{ type: 'add_tag', tag: 'acepto-cotizacion' }] });
  assert.equal(rule.statusCode, 200, rule.body);
  const q = await sentQuote([{ name: 'Renta de salón', qty: 1, price_mode: 'exact', price_min: 100000, price_max: null, iva_mode: 'plus' }]);
  assert.equal((await agent('POST', `/api/quotes/${q.id}/accept`, {})).statusCode, 403);
  const r = await h.authed('POST', `/api/quotes/${q.id}/accept`, { plan: { type: 'deposit', percent: 50, due_date: today(2), rest_due_date: today(30) } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().quote.status, 'accepted');
  assert.equal(r.json().receivables.length, 2);
  const rows = await bySource('quote', `${q.id}:%`);
  assert.deepEqual(rows.map((x) => [x.amount, x.due, x.installment]), [[58000, today(2), '1 de 2'], [58000, today(30), '2 de 2']]);
  assert.match(rows[0].concept, new RegExp(`^Cotización ${q.folio}: anticipo`));
  const events = (await pool.query(`SELECT type FROM quote_events WHERE quote_id = $1 ORDER BY id`, [q.id])).rows.map((e) => e.type);
  assert.ok(events.includes('accepted'));
  await waitFor(async () => ((await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [contactId])).rows[0].tags ?? []).includes('acepto-cotizacion'));
  // Repetir: 409 y sin cobros nuevos.
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/accept`, { plan: { type: 'full', due_date: today(3) } })).statusCode, 409);
  assert.equal((await bySource('quote', `${q.id}:%`)).length, 2);
  // Aceptada ya no se vence.
  const { expireQuotes } = await import('../src/store/quotes.js');
  await expireQuotes(today(400), h.accountId);
  assert.equal((await pool.query(`SELECT status FROM quotes WHERE id = $1`, [q.id])).rows[0].status, 'accepted');
  // {{pago.parcialidad}} en los textos.
  const { paymentVars } = await import('../src/receivables/index.js');
  assert.equal(paymentVars({ concept: 'x', amount_cents: 1, currency: 'MXN', due_date: today(1), payment_link: '', reference: '', installment: '2 de 2' }, { payment_instructions: '' }, TZ)['pago.parcialidad'], '2 de 2');
});

t('aceptar después de una falla a la mitad: no duplica los cobros que ya se habían creado', async () => {
  const q = await sentQuote([{ name: 'Banquete', qty: 1, price_mode: 'exact', price_min: 90000, price_max: null, iva_mode: 'exempt' }]);
  // Como si un intento anterior hubiera creado el primer pago y se hubiera caído antes de terminar.
  await h.service.receivables.create({ accountId: h.accountId, contactId, concept: `Cotización ${q.folio}: pago 1 de 3`, amountCents: 30000, dueDate: today(5), source: 'quote', sourceId: `${q.id}:1`, installment: '1 de 3', actor: 'prueba' });
  assert.equal((await pool.query(`SELECT status FROM quotes WHERE id = $1`, [q.id])).rows[0].status, 'sent', 'sin terminar, sigue enviada: se puede reintentar');
  const r = await h.authed('POST', `/api/quotes/${q.id}/accept`, { plan: { type: 'installments', count: 3, every: 'month', first_due: today(5) } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual((await bySource('quote', `${q.id}:%`)).map((x) => x.installment), ['1 de 3', '2 de 3', '3 de 3']);
});

t('cotización con rango: exige el monto final; sin plan solo se marca aceptada; una no enviada no se acepta', async () => {
  const range = await sentQuote([{ name: 'Decoración', qty: 1, price_mode: 'range', price_min: 100000, price_max: 200000, iva_mode: 'exempt' }], 'approximate');
  const noAmount = await h.authed('POST', `/api/quotes/${range.id}/accept`, { plan: { type: 'full', due_date: today(5) } });
  assert.equal(noAmount.statusCode, 400);
  assert.match(noAmount.json().error, /monto final/);
  assert.equal((await pool.query(`SELECT status FROM quotes WHERE id = $1`, [range.id])).rows[0].status, 'sent', 'si el plan no cuadra, sigue enviada');
  const okRange = await h.authed('POST', `/api/quotes/${range.id}/accept`, { amount_cents: 150000, plan: { type: 'installments', count: 2, every: 'fortnight', first_due: today(5) } });
  assert.equal(okRange.statusCode, 200, okRange.body);
  assert.deepEqual((await bySource('quote', `${range.id}:%`)).map((x) => [x.amount, x.due]), [[75000, today(5)], [75000, today(20)]]);
  const plain = await sentQuote([{ name: 'Sonido', qty: 1, price_mode: 'exact', price_min: 50000, price_max: null, iva_mode: 'exempt' }]);
  const marked = await h.authed('POST', `/api/quotes/${plain.id}/accept`, {});
  assert.equal(marked.statusCode, 200, marked.body);
  assert.equal(marked.json().receivables.length, 0);
  const { createQuote } = await import('../src/store/quotes.js');
  const draft = await createQuote({ accountId: h.accountId, kind: 'final', status: 'draft', source: 'panel', today: today(0), lines: [{ name: 'X', qty: 1, price_mode: 'exact', price_min: 100, price_max: null, iva_mode: 'exempt' }] });
  assert.equal((await h.authed('POST', `/api/quotes/${draft.id}/accept`, {})).statusCode, 409);
});

t('con más de 2 000 pagos recurrentes activos, el más nuevo también genera su cobro; una cuenta tiene hasta 500 (PAY-21)', async () => {
  const { runPlans } = await import('../src/receivables/plans.js');
  // 2 100 planes viejos de otra cuenta que todavía no tocan (empiezan en un año).
  const other = (await h.authed('POST', '/api/accounts', { name: 'Gimnasio grande' })).json().id;
  const ch = (await pool.query(`INSERT INTO channels (account_id, type, name, config, webhook_token) VALUES ($1, 'webchat', 'Web', '{}', md5(random()::text)) RETURNING id`, [other])).rows[0].id;
  const ct = (await pool.query(`INSERT INTO contacts (account_id, channel_id, external_id) VALUES ($1, $2, 'socio') RETURNING id`, [other, ch])).rows[0].id;
  await pool.query(`INSERT INTO receivable_plans (account_id, contact_id, concept, amount_cents, currency, frequency, day, starts_on, active, created_at)
                    SELECT $1, $2, 'Cuota ' || g, 10000, 'MXN', 'monthly', 1, (now() + interval '1 year')::date, true, now() - interval '1 day'
                      FROM generate_series(1, 2100) g`, [other, ct]);
  // El más nuevo, de esta cuenta, ya toca.
  const day = Number(today(2).slice(8, 10));
  const r = await h.authed('POST', acc('/api/receivable-plans'), { contact_id: contactId, concept: 'Cuota nueva', amount_cents: 20000, frequency: 'monthly', day, starts_on: today(0), active: false });
  assert.equal(r.statusCode, 201, r.body);
  const id = r.json().plan.id;
  await pool.query(`UPDATE receivable_plans SET active = true WHERE id = $1`, [id]);
  await runPlans(h.service.receivables);
  assert.ok((await bySource('recurring', `${id}:%`)).length >= 1, 'el plan más nuevo no quedó fuera');
  // Tope por cuenta: la otra ya tiene 2 100 activos.
  await pool.query(`INSERT INTO users (account_id, role, name, email, password_hash, email_verified_at) VALUES ($1, 'admin', 'Gym', 'gym@tope.mx', 'x', now())`, [other]);
  const over = await h.authed('POST', `/api/receivable-plans?account_id=${other}`, { contact_id: ct, concept: 'Una más', amount_cents: 100, frequency: 'monthly', day: 1, starts_on: today(0) });
  assert.equal(over.statusCode, 403, over.body);
  assert.match(over.json().error, /500 pagos recurrentes activos/);
  await pool.query(`UPDATE receivable_plans SET active = false WHERE account_id = $1`, [other]);
});

t('aceptar la misma cotización dos veces a la vez con planes distintos: una gana y no quedan cobros de más', async () => {
  const q = await sentQuote([{ name: 'Banquete', qty: 1, price_mode: 'exact', price_min: 90000, price_max: null, iva_mode: 'plus' }]);
  const [a, b] = await Promise.all([
    h.authed('POST', `/api/quotes/${q.id}/accept`, { plan: { type: 'full', due_date: today(3) } }),
    h.authed('POST', `/api/quotes/${q.id}/accept`, { plan: { type: 'installments', count: 3, every: 'month', first_due: today(5) } }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `${a.body} / ${b.body}`);
  const won = a.statusCode === 200 ? a.json() : b.json();
  const pending = (await pool.query(`SELECT count(*)::int AS n FROM receivables WHERE source = 'quote' AND source_id LIKE $1 AND status = 'pending'`, [`${q.id}:%`])).rows[0].n;
  assert.equal(pending, won.receivables.length, 'solo los cobros del plan que ganó');
});
