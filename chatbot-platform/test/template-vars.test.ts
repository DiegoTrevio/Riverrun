/** Variables nuevas en los mensajes: campo.*, asesor, fecha_hoy, saldo, pagos_pendientes, proxima_cita.*, cotizacion.* y pago.* en reglas. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const { renderTemplate } = await import('../src/automation/templates.js');
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let convId = '';
let contactId = '';
const TZ = 'America/Mexico_City';
const acc = (url: string) => `${url}${url.includes('?') ? '&' : '?'}account_id=${h.accountId}`;
const rule = async (trigger: Record<string, unknown>, text: string, delay = 0) => {
  const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: `Regla ${trigger.type}`, trigger, actions: [{ type: 'send_message', text, delay_minutes: delay }] });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().id as string;
};
const sentWith = (needle: string) => h.sent.find((s) => s.text.includes(needle))?.text;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  await h.authed('PUT', acc('/api/settings'), { timezone: TZ });
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  await h.webhook('Hola');
  await h.idle();
  const conv = await h.conversationFor();
  convId = conv.id;
  contactId = conv.contact_id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

test('renderTemplate: fecha_hoy, campo.* sin formato precargado y claves del prototipo vacías', () => {
  const now = new Date('2026-10-25T18:00:00Z');
  const out = renderTemplate('Hoy es {{fecha_hoy}}. Plan {{campo.plan}} / {{dato.plan}}.{{constructor}}{{campo.constructor}}', { contact: { name: 'Ana', push_name: '', phone: '5215511112222', data: { plan: 'Premium' } }, timezone: TZ, now });
  assert.equal(out, 'Hoy es domingo 25 de octubre. Plan Premium / Premium.');
});

t('un mensaje proactivo lee campo.* con formato, asesor, saldo, pagos pendientes y la próxima cita', async () => {
  const f = await h.authed('POST', acc('/api/contact-fields'), { label: 'Cumpleaños', key: 'cumpleanos', type: 'date' });
  assert.equal(f.statusCode, 201, f.body);
  await pool.query(`UPDATE contacts SET data = data || '{"cumpleanos":"1990-11-03"}' WHERE id = $1`, [contactId]);
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Laura Méndez', email: 'laura@palmas.mx', password: 'Pz-144-Qx-344-Kv', role: 'agent' });
  await pool.query(`UPDATE conversations SET assigned_user_id = $2 WHERE id = $1`, [convId, u.json().id]);
  for (const [amount, currency] of [[150000, 'MXN'], [50050, 'MXN'], [2000, 'USD']] as const) {
    await pool.query(`INSERT INTO receivables (account_id, contact_id, concept, amount_cents, currency, due_date) VALUES ($1, $2, 'Renta', $3, $4, current_date + 3)`, [h.accountId, contactId, amount, currency]);
  }
  await pool.query(`INSERT INTO receivables (account_id, contact_id, concept, amount_cents, due_date, status) VALUES ($1, $2, 'Pagado', 99900, current_date, 'paid')`, [h.accountId, contactId]);
  // La próxima cita confirmada (no la cancelada ni la pasada).
  await pool.query(`INSERT INTO appointments (account_id, contact_id, conversation_id, customer_name, service_name, starts_at, ends_at, status) VALUES
    ($1, $2, $3, 'Ana', 'Masaje', '2099-01-05T17:00:00Z', '2099-01-05T18:00:00Z', 'confirmed'),
    ($1, $2, $3, 'Ana', 'Facial', '2098-01-01T17:00:00Z', '2098-01-01T18:00:00Z', 'cancelled'),
    ($1, $2, $3, 'Ana', 'Corte', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'confirmed')`, [h.accountId, contactId, convId]);
  h.reset();
  const r = await h.service.outbound.send(convId, { text: 'Hola {{nombre}}, tu cumple es el {{campo.cumpleanos}}. Te atiende {{asesor}}. Debes {{saldo}} en {{pagos_pendientes}} pagos. Cita: {{proxima_cita.servicio}} el {{proxima_cita.fecha}} a las {{proxima_cita.hora}}.', source: 'api' });
  assert.ok(r.sent, JSON.stringify(r));
  const text = sentWith('cumple')!;
  assert.match(text, /tu cumple es el 3 de noviembre de 1990/);
  assert.match(text, /Te atiende Laura Méndez/);
  assert.match(text, /Debes \$2,000\.50 \+ USD\s20\.00 en 3 pagos/);
  assert.match(text, /Cita: Masaje el lunes 5 de enero a las 11:00/);
});

t('una regla de pagos con {{pago.*}} los llena al momento y también diferida', async () => {
  await rule({ type: 'payment_due' }, 'Ahora: {{pago.concepto}} por {{pago.monto}}');
  await rule({ type: 'payment_overdue' }, 'Después: {{pago.concepto}} por {{pago.monto}}, {{pago.dias_atraso}} días', 5);
  h.reset();
  h.service.automator.emit({ type: 'payment_due', conversationId: convId, payment: { 'pago.concepto': 'Colegiatura', 'pago.monto': '$2,499.50' } });
  h.service.automator.emit({ type: 'payment_overdue', conversationId: convId, payment: { 'pago.concepto': 'Inscripción', 'pago.monto': '$800.00', 'pago.dias_atraso': '4' } });
  await h.service.automator.settleAll();
  await h.idle();
  assert.equal(sentWith('Ahora:'), 'Ahora: Colegiatura por $2,499.50');
  assert.equal(sentWith('Después:'), undefined, 'la diferida espera');
  const job = (await pool.query(`SELECT payload FROM jobs WHERE type = 'automation_send' AND status = 'pending'`)).rows[0];
  assert.equal(job.payload.vars['pago.concepto'], 'Inscripción', 'el trabajo guarda las variables del evento');
  await h.fastForward();
  await waitFor(() => !!sentWith('Después:'));
  assert.equal(sentWith('Después:'), 'Después: Inscripción por $800.00, 4 días');
});

t('una regla de cotización aceptada lee {{cotizacion.*}}', async () => {
  await rule({ type: 'quote_accepted' }, 'Gracias por aceptar la cotización {{cotizacion.folio}} por {{cotizacion.total}} (vigente hasta el {{cotizacion.vigencia}}).');
  h.reset();
  h.service.automator.emit({ type: 'quote_accepted', conversationId: convId, quote: { id: '00000000-0000-0000-0000-000000000001', folio: 'COT-0042', kind: 'final', total: '$12,180.00', valid_until: '2026-11-30' } });
  await h.service.automator.settleAll();
  await h.idle();
  assert.equal(sentWith('COT-0042'), 'Gracias por aceptar la cotización COT-0042 por $12,180.00 (vigente hasta el lunes 30 de noviembre).');
});
