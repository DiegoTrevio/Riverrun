/** Cobros a los clientes del negocio: registro, recordatorios de pago por WhatsApp, «ya pagué», vencidos y pagado. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let contactId = '';
const TZ = 'America/Mexico_City';
const today = (offset = 0) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  return new Date(Date.parse(`${d}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
};
const acc = (url: string) => `${url}${url.includes('?') ? '&' : '?'}account_id=${h.accountId}`;
const jobsOf = async (id: string) => (await pool.query(`SELECT type, payload FROM jobs WHERE status = 'pending' AND payload->>'receivable_id' = $1 ORDER BY run_at`, [id])).rows;
const create = async (body: Record<string, unknown>) => {
  const r = await h.authed('POST', acc('/api/receivables'), { contact_id: contactId, concept: 'Mensualidad de octubre', amount_cents: 150000, due_date: today(5), ...body });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  // Alguien del equipo que reciba los avisos (pago reportado, vencido).
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Caja', email: 'caja@palmas.mx', password: 'clave-segura-1', role: 'admin' })).statusCode, 200);
  h.setScript(() => ({ messages: ['Gracias, el equipo lo revisa y te confirma.'] }));
  await h.webhook('Hola, buenas tardes');
  await h.idle();
  contactId = (await h.conversationFor()).contact_id;
  assert.ok(contactId);
  const s = await h.authed('PUT', acc('/api/receivables/settings'), { payment_instructions: 'Transferencia a la CLABE 012180001234567890 a nombre de Hotel Palmas.', default_reminders: [-3, 0, 3, 7], send_at: '10:00', respect_business_hours: false });
  assert.equal(s.statusCode, 200, s.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('registrar un cobro programa sus recordatorios (antes, el día y después) y la revisión de vencido', async () => {
  const { receivable: r, scheduled } = await create({});
  assert.equal(scheduled, 4);
  const jobs = await jobsOf(r.id);
  assert.deepEqual(jobs.filter((j) => j.type === 'receivable_reminder').map((j) => j.payload.offset), [-3, 0, 3, 7]);
  assert.equal(jobs.filter((j) => j.type === 'receivable_overdue').length, 1);
  // Uno con días propios y vencimiento mañana: el de 3 días antes ya pasó, no se programa.
  const own = await create({ concept: 'Anticipo', due_date: today(1), reminders: [-3, 1] });
  assert.equal(own.scheduled, 1);
  assert.deepEqual(own.receivable.reminders, [-3, 1]);
});

t('el recordatorio sale por WhatsApp con el monto, la fecha y las instrucciones de pago; cuenta como enviado', async () => {
  const { receivable: r } = await create({ concept: 'Colegiatura', amount_cents: 249950, reference: 'ALU-77' });
  h.reset();
  await h.service.receivables.runReminder({ receivable_id: r.id, offset: -3 });
  await h.idle();
  const msg = h.sent.find((s) => s.text.includes('Colegiatura'));
  assert.ok(msg, JSON.stringify(h.sent));
  assert.match(msg.text, /te recordamos que tu pago de Colegiatura por \$2,499\.50/);
  assert.match(msg.text, /vence el /);
  assert.match(msg.text, /CLABE 012180001234567890/);
  assert.match(msg.text, /Referencia: ALU-77/);
  const after = (await h.authed('GET', `/api/receivables/${r.id}`)).json().receivable;
  assert.equal(after.reminders_sent, 1);
  assert.ok(after.conversation_id, 'queda ligado a la conversación');
});

t('mensajes propios con variables; vencido usa el texto de «después de vencido»', async () => {
  await h.authed('PUT', acc('/api/receivables/settings'), {
    payment_instructions: 'Paga en recepción.', default_reminders: [-3, 0, 3, 7], send_at: '10:00', respect_business_hours: false,
    message_overdue: '{{nombre}}, tu {{pago.concepto}} lleva {{pago.dias_atraso}} días vencido. {{pago.instrucciones}}',
  });
  const { receivable: r } = await create({ concept: 'Renta', due_date: today(-4) });
  h.reset();
  const { getReceivable } = await import('../src/receivables/index.js');
  await h.service.receivables.remind((await getReceivable(r.id))!);
  await h.idle();
  const msg = h.sent.find((s) => s.text.includes('Renta'));
  assert.ok(msg);
  assert.match(msg.text, /^Ana, tu Renta lleva 4 días vencido\. Paga en recepción\.$/);
});

t('«ya te transferí»: avisa al equipo, pausa los recordatorios y el asistente no confirma el pago', async () => {
  const { receivable: r } = await create({ concept: 'Servicio de jardinería', due_date: today(1) });
  h.reset();
  await h.webhook('Ya te transferí, te mando el comprobante');
  await h.idle();
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'payment' AND title LIKE '%dice que ya pagó%'`)).rows[0].n > 0);
  const after = (await h.authed('GET', `/api/receivables/${r.id}`)).json().receivable;
  assert.ok(after.paused_until && new Date(after.paused_until) > new Date(), 'recordatorios en pausa');
  // Otro mensaje del mismo reporte no repite el aviso.
  await h.webhook('Ya pagué');
  await h.idle();
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'payment' AND title LIKE '%dice que ya pagó%'`)).rows[0].n, 1);
  // El asistente sabe del cobro y tiene la regla de no confirmar pagos.
  const prompt = JSON.stringify(h.calls.at(-1)?.messages ?? []);
  assert.match(prompt, /Pagos pendientes del cliente/);
  assert.match(prompt, /Nunca confirmes que el pago llegó/);
  // En pausa, el recordatorio programado no sale: se mueve al final de la pausa.
  h.reset();
  await h.service.receivables.runReminder({ receivable_id: r.id, offset: 0 });
  assert.equal(h.sent.filter((s) => s.text.includes('jardinería')).length, 0);
  assert.ok((await jobsOf(r.id)).some((j) => j.type === 'receivable_reminder' && j.payload.offset === 0));
});

t('marcar pagado detiene los recordatorios; ya no se puede volver a marcar ni recordar', async () => {
  const { receivable: r } = await create({ concept: 'Paquete de fotos' });
  assert.ok((await jobsOf(r.id)).length > 0);
  const paid = await h.authed('POST', `/api/receivables/${r.id}/paid`, { note: 'SPEI 1234' });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().receivable.status, 'paid');
  assert.equal(paid.json().receivable.paid_note, 'SPEI 1234');
  assert.equal((await jobsOf(r.id)).length, 0, 'sin recordatorios pendientes');
  h.reset();
  await h.service.receivables.runReminder({ receivable_id: r.id, offset: 0 });
  assert.equal(h.sent.length, 0);
  assert.equal((await h.authed('POST', `/api/receivables/${r.id}/paid`, {})).statusCode, 409);
  assert.equal((await h.authed('POST', `/api/receivables/${r.id}/remind`)).statusCode, 409);
});

t('vencido sin pagar: un solo aviso al equipo', async () => {
  const { receivable: r } = await create({ concept: 'Cuota vencida', due_date: today(-2) });
  await h.service.receivables.runOverdue({ receivable_id: r.id });
  await h.service.receivables.runOverdue({ receivable_id: r.id });
  const n = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'payment' AND title LIKE '%Pago vencido%' AND body LIKE '%Cuota vencida%'`)).rows[0].n;
  assert.equal(n, 1);
});

t('quien escribió la palabra de baja no recibe recordatorios de pago', async () => {
  await pool.query(`UPDATE contacts SET opted_out = true WHERE id = $1`, [contactId]);
  try {
    const { receivable: r } = await create({ concept: 'Membresía' });
    h.reset();
    const res = await h.authed('POST', `/api/receivables/${r.id}/remind`);
    assert.equal(res.statusCode, 422);
    assert.match(res.json().error, /se dio de baja/);
    assert.equal(h.sent.length, 0);
  } finally {
    await pool.query(`UPDATE contacts SET opted_out = false WHERE id = $1`, [contactId]);
  }
});

t('editar la fecha reprograma; validaciones y aislamiento entre cuentas', async () => {
  const { receivable: r } = await create({ concept: 'Curso' });
  const moved = await h.authed('PUT', `/api/receivables/${r.id}`, { due_date: today(20), reminders: [-1] });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().scheduled, 1);
  assert.deepEqual((await jobsOf(r.id)).filter((j) => j.type === 'receivable_reminder').map((j) => j.payload.offset), [-1]);
  assert.equal((await h.authed('POST', acc('/api/receivables'), { contact_id: contactId, concept: 'X', amount_cents: 0, due_date: today(1) })).statusCode, 400);
  assert.equal((await h.authed('POST', acc('/api/receivables'), { contact_id: contactId, concept: 'X', amount_cents: 100, due_date: today(1), payment_link: 'http://inseguro.mx' })).statusCode, 400);
  // Otra cuenta: no ve ni toca los cobros de esta.
  const other = await h.authed('POST', '/api/accounts', { name: 'Otra cuenta', admin: { name: 'Otro', email: 'otro@cobros.mx', password: 'clave-segura-1' } });
  assert.equal(other.statusCode, 200, other.body);
  const otherAdmin = await h.loginAs('otro@cobros.mx', 'clave-segura-1');
  assert.equal((await otherAdmin('GET', `/api/receivables/${r.id}`)).statusCode, 404);
  assert.equal((await otherAdmin('POST', `/api/receivables/${r.id}/paid`, {})).statusCode, 404);
  assert.equal((await otherAdmin('POST', '/api/receivables', { contact_id: contactId, concept: 'Ajeno', amount_cents: 100, due_date: today(1) })).statusCode, 400);
  assert.equal((await otherAdmin('GET', '/api/receivables')).json().data.length, 0);
});

t('lista con totales por cobrar, vencido y cobrado del mes', async () => {
  const r = await h.authed('GET', acc('/api/receivables?status=overdue'));
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().data.length > 0);
  assert.ok(r.json().data.every((x: any) => x.status === 'pending' && x.due_date < r.json().today));
  const mxn = r.json().totals.find((x: any) => x.currency === 'MXN');
  assert.ok(mxn.pending_cents > 0 && mxn.overdue_cents > 0 && mxn.paid_month_cents >= 150000);
});

t('API v1: registrar un cobro por teléfono, consultarlo y marcarlo pagado', async () => {
  const key = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Caja', scope: 'write' })).json().key;
  const call = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${key}` } });
  const made = await call('POST', '/api/v1/receivables', { channel_id: h.channelId, phone: '5215599998888', concept: 'Pedido 551', amount_cents: 89900, due_date: today(10) });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json().reminders_scheduled, 4);
  const list = await call('GET', '/api/v1/receivables?status=pending');
  assert.ok(list.json().data.some((x: any) => x.id === made.json().id));
  const paid = await call('POST', `/api/v1/receivables/${made.json().id}/paid`, { note: 'Caja 2' });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().status, 'paid');
});
