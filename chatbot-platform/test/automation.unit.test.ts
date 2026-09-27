import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, spreadSlots } from '../src/automation/agenda.js';
import { conditionsMatch, stepTime, triggerMatches } from '../src/automation/automator.js';
import { renderTemplate } from '../src/automation/templates.js';
import { isOpen, localParts, nextOpen, nextTimeOfDay, slotKey, spanishDate, zonedToUtc } from '../src/automation/time.js';
import { AccountSettingsSchema, ServiceBodySchema, TriggerSchema, type Service } from '../src/automation/types.js';

const MX = 'America/Mexico_City'; // UTC-6 sin horario de verano
const settings = AccountSettingsSchema.parse({ timezone: MX, holidays: ['2026-10-12'] });

test('zonas horarias: conversión local ↔ UTC, incluido horario de verano', () => {
  assert.equal(zonedToUtc('2026-09-29', '10:00', MX).toISOString(), '2026-09-29T16:00:00.000Z');
  // Nueva York: verano (UTC-4) e invierno (UTC-5)
  assert.equal(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z');
  const lp = localParts(new Date('2026-09-29T16:00:00Z'), MX);
  assert.deepEqual([lp.date, lp.time, lp.day], ['2026-09-29', '10:00', 'tue']);
  assert.equal(spanishDate(new Date('2026-09-29T16:00:00Z'), MX), 'martes 29 de septiembre');
  assert.equal(slotKey(new Date('2026-09-29T16:00:00Z'), MX), '2026-09-29T10:00');
});

test('horario del negocio: abierto, cerrado, festivos y siguiente apertura', () => {
  const tueNoon = zonedToUtc('2026-09-29', '12:00', MX);
  assert.equal(isOpen(settings.business_hours, settings.holidays, tueNoon, MX), true);
  const tueNight = zonedToUtc('2026-09-29', '22:00', MX);
  assert.equal(isOpen(settings.business_hours, settings.holidays, tueNight, MX), false);
  assert.equal(nextOpen(settings.business_hours, settings.holidays, tueNight, MX).toISOString(), zonedToUtc('2026-09-30', '09:00', MX).toISOString());
  // Sábado 14:30 → cerrado; domingo cerrado → lunes 9:00
  const sat = zonedToUtc('2026-10-03', '14:30', MX);
  assert.equal(nextOpen(settings.business_hours, settings.holidays, sat, MX).toISOString(), zonedToUtc('2026-10-05', '09:00', MX).toISOString());
  // Lunes 12 de octubre es festivo → martes 13
  const beforeHoliday = zonedToUtc('2026-10-09', '19:00', MX); // viernes noche
  assert.equal(nextOpen(settings.business_hours, ['2026-10-10', '2026-10-12'], beforeHoliday, MX).toISOString(), zonedToUtc('2026-10-13', '09:00', MX).toISOString());
  assert.equal(nextTimeOfDay(zonedToUtc('2026-09-29', '11:00', MX), '10:00', MX).toISOString(), zonedToUtc('2026-09-30', '10:00', MX).toISOString());
});

test('secuencias: espera + hora del día + horario del negocio', () => {
  const from = zonedToUtc('2026-09-29', '17:30', MX);
  const step = (o: Record<string, unknown>) => ({ delay_value: 0, delay_unit: 'hours', at_time: '', text: '', image_id: '', conditions: [], ...o }) as any;
  assert.equal(stepTime(from, step({ delay_value: 2 }), settings, false).toISOString(), zonedToUtc('2026-09-29', '19:30', MX).toISOString());
  // 2 h después serían 19:30 (cerrado) → siguiente apertura
  assert.equal(stepTime(from, step({ delay_value: 2 }), settings, true).toISOString(), zonedToUtc('2026-09-30', '09:00', MX).toISOString());
  // 1 día después a las 10:00
  assert.equal(stepTime(from, step({ delay_value: 1, delay_unit: 'days', at_time: '10:00' }), settings, true).toISOString(), zonedToUtc('2026-10-01', '10:00', MX).toISOString());
});

const svc = (o: Partial<Service> = {}): Service => ({ id: 's1', account_id: 'a', ...ServiceBodySchema.parse({ name: 'Consulta', duration_minutes: 60, min_notice_minutes: 60, max_days_ahead: 7 }), ...o });

test('horarios libres: anticipación, capacidad, festivos y personas asignadas', () => {
  const now = zonedToUtc('2026-09-29', '09:30', MX); // martes 9:30
  let slots = computeSlots(svc(), settings, [], now, { days: 1 });
  // Martes: 9-18 con 60 min → 9,10..17; con 60 min de anticipación desde 9:30 → desde 11:00 (10:00 < 10:30)
  assert.equal(slots[0].key, '2026-09-29T11:00');
  assert.ok(slots.some((s) => s.key === '2026-09-30T09:00'));
  // Ocupado a las 11:00 (capacidad 1)
  const busy = [{ service_id: 's1', assigned_user_id: null, starts_at: zonedToUtc('2026-09-29', '11:00', MX), ends_at: zonedToUtc('2026-09-29', '12:00', MX) }];
  slots = computeSlots(svc(), settings, busy, now, { days: 0 });
  assert.ok(!slots.some((s) => s.key === '2026-09-29T11:00'));
  assert.ok(slots.some((s) => s.key === '2026-09-29T12:00'));
  // Capacidad 2: sigue disponible
  assert.ok(computeSlots(svc({ capacity: 2 }), settings, busy, now, { days: 0 }).some((s) => s.key === '2026-09-29T11:00'));
  // Persona asignada ocupada en otro servicio a las 13:00
  const userBusy = [{ service_id: 'otro', assigned_user_id: 'u1', starts_at: zonedToUtc('2026-09-29', '13:00', MX), ends_at: zonedToUtc('2026-09-29', '14:00', MX) }];
  assert.ok(!computeSlots(svc({ assigned_user_ids: ['u1'] }), settings, userBusy, now, { days: 0 }).some((s) => s.key === '2026-09-29T13:00'));
  assert.ok(computeSlots(svc({ assigned_user_ids: ['u1', 'u2'] }), settings, userBusy, now, { days: 0 }).some((s) => s.key === '2026-09-29T13:00'));
  // Festivo: sin horarios
  assert.equal(computeSlots(svc(), settings, [], zonedToUtc('2026-10-12', '08:00', MX), { onlyDate: '2026-10-12' }).length, 0);
  // Horario propio del servicio
  const evening = svc({ hours: { mon: [], tue: [['19:00', '21:00']], wed: [], thu: [], fri: [], sat: [], sun: [] } });
  assert.deepEqual(computeSlots(evening, settings, [], now, { days: 0 }).map((s) => s.key), ['2026-09-29T19:00', '2026-09-29T20:00']);
  // Reparto: máximo 4 por día
  const spread = spreadSlots(computeSlots(svc(), settings, [], now, { days: 7 }));
  assert.ok(spread.length <= 20);
  assert.ok(new Set(spread.map((s) => s.key.slice(0, 10))).size >= 4);
});

test('plantillas: variables, datos, cita y variables desconocidas vacías', () => {
  const t = renderTemplate('Hola {{nombre}}, tu {{cita.tipo}} de {{cita.servicio}} es el {{cita.fecha}} a las {{cita.hora}}. Correo: {{dato.correo}}{{desconocida}}', {
    contact: { name: 'Ana López', push_name: '', phone: '521', data: { correo: 'ana@x.mx' } },
    timezone: MX,
    appointment: { service_name: 'Consulta', kind: 'appointment', starts_at: zonedToUtc('2026-09-29', '10:00', MX) } as any,
  });
  assert.equal(t, 'Hola Ana, tu cita de Consulta es el martes 29 de septiembre a las 10:00. Correo: ana@x.mx');
  assert.equal(renderTemplate('Hola {{nombre}}, ¿cómo estás?', { contact: { name: '', push_name: '', phone: '', data: {} }, timezone: MX }), 'Hola, ¿cómo estás?');
});

test('reglas: coincidencia de disparadores y condiciones', () => {
  const kw = TriggerSchema.parse({ type: 'message_received', match: 'keywords', keywords: ['precio', 'cuánto cuesta'] });
  assert.ok(triggerMatches(kw, { type: 'message_received', conversationId: 'c', text: '¿Cuanto cuesta la suite?' }));
  assert.ok(!triggerMatches(kw, { type: 'message_received', conversationId: 'c', text: 'preciosa vista' }));
  const exact = TriggerSchema.parse({ type: 'message_received', match: 'exact', keywords: ['menu'] });
  assert.ok(triggerMatches(exact, { type: 'message_received', conversationId: 'c', text: 'Menú!' }));
  assert.ok(!triggerMatches(exact, { type: 'message_received', conversationId: 'c', text: 'quiero ver el menú' }));
  const first = TriggerSchema.parse({ type: 'message_received', match: 'any', first_message_only: true });
  assert.ok(!triggerMatches(first, { type: 'message_received', conversationId: 'c', text: 'hola', isFirstMessage: false }));
  const intent = TriggerSchema.parse({ type: 'intent', intent: 'queja' });
  assert.ok(triggerMatches(intent, { type: 'intent', conversationId: 'c', intents: ['cotizar', 'queja'] }));
  assert.ok(!triggerMatches(intent, { type: 'message_received', conversationId: 'c' }));

  const ctx: any = {
    conv: { status: 'bot' },
    contact: { name: 'Ana', tags: ['VIP'], data: { correo: 'a@b.mx' } },
    channel: { type: 'whatsapp' },
    settings: AccountSettingsSchema.parse({ business_hours: { mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']], thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']], sun: [['00:00', '23:59']] } }),
  };
  assert.ok(conditionsMatch([{ type: 'has_tag', tag: 'vip', negate: false }, { type: 'channel', channel_types: ['whatsapp'] }, { type: 'business_hours', inside: true }], ctx));
  assert.ok(!conditionsMatch([{ type: 'field', field: 'telefono', op: 'present', value: '' }], ctx));
  assert.ok(conditionsMatch([{ type: 'field', field: 'correo', op: 'contains', value: '@b.mx' }, { type: 'status', status: 'bot' }], ctx));
  assert.ok(!conditionsMatch([{ type: 'has_tag', tag: 'vip', negate: true }], ctx));
});

test('plantillas: {{cliente}} nunca queda vacío en alertas', () => {
  const anon = { name: '', push_name: '', phone: '', data: {} };
  assert.equal(renderTemplate('🚨 {{cliente}} escribió', { contact: anon, timezone: MX }), '🚨 Un cliente escribió');
  assert.equal(renderTemplate('{{cliente}}', { contact: { ...anon, phone: '5215511112222' }, timezone: MX }), '+5215511112222');
});
