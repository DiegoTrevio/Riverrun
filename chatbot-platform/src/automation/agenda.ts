import { query, withTransaction } from '../db.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { ChannelType, Contact, Conversation } from '../types.js';
import * as astore from './store.js';
import { renderTemplate } from './templates.js';
import { addDays, dayOf, fromMinutes, localParts, slotKey, spanishDate, spanishTime, toMinutes, zonedToUtc } from './time.js';
import { DEFAULT_REMINDER, type AccountSettings, type Appointment, type Service } from './types.js';

export interface Slot {
  start: Date;
  end: Date;
  /** Clave local "YYYY-MM-DDTHH:MM" que ve la IA. */
  key: string;
}

interface Busy {
  service_id: string | null;
  assigned_user_id: string | null;
  starts_at: Date;
  ends_at: Date;
}

/**
 * Horarios libres de un servicio. Respeta horario (del servicio o de la cuenta), días festivos,
 * anticipación mínima, capacidad simultánea y disponibilidad de las personas asignadas.
 */
export function computeSlots(service: Service, settings: AccountSettings, busy: Busy[], now: Date, opts: { days?: number; onlyDate?: string } = {}): Slot[] {
  const tz = settings.timezone;
  const hours = service.hours ?? settings.business_hours;
  const today = localParts(now, tz).date;
  const horizon = Math.min(service.max_days_ahead, opts.days ?? service.max_days_ahead);
  const earliest = now.getTime() + service.min_notice_minutes * 60_000;
  const step = service.duration_minutes + service.buffer_minutes;
  const bufferMs = service.buffer_minutes * 60_000;
  const users = service.assigned_user_ids;
  const out: Slot[] = [];
  for (let i = 0; i <= horizon; i++) {
    const date = addDays(today, i);
    if (opts.onlyDate && date !== opts.onlyDate) continue;
    if (settings.holidays.includes(date)) continue;
    for (const [s, e] of hours[dayOf(date)] ?? []) {
      for (let t = toMinutes(s); t + service.duration_minutes <= toMinutes(e); t += step) {
        const start = zonedToUtc(date, fromMinutes(t), tz);
        if (start.getTime() < earliest) continue;
        const end = new Date(start.getTime() + service.duration_minutes * 60_000);
        const overlapping = busy.filter(
          (b) => new Date(b.starts_at).getTime() < end.getTime() + bufferMs && new Date(b.ends_at).getTime() + bufferMs > start.getTime(),
        );
        if (overlapping.filter((b) => b.service_id === service.id).length >= service.capacity) continue;
        if (users.length && !users.some((u) => !overlapping.some((b) => b.assigned_user_id === u))) continue;
        out.push({ start, end, key: slotKey(start, tz) });
      }
    }
  }
  return out;
}

/** Reparte los horarios para mostrarlos a la IA: pocos por día, varios días. */
export function spreadSlots(slots: Slot[], perDay = 4, max = 20): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const d = s.key.slice(0, 10);
    const list = byDay.get(d) ?? [];
    if (list.length < perDay) list.push(s);
    byDay.set(d, list);
  }
  const out: Slot[] = [];
  for (const list of byDay.values()) {
    // Mañana, mediodía y tarde en vez de solo los primeros horarios.
    out.push(...list);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

async function busyFor(service: Service, from: Date, to: Date, client?: { query: (q: string, p: unknown[]) => Promise<{ rows: Busy[] }> }, excludeId?: string) {
  const sql = `SELECT service_id, assigned_user_id, starts_at, ends_at FROM appointments
     WHERE status = 'confirmed' AND starts_at < $3 AND ends_at > $2
       AND (service_id = $1 OR assigned_user_id = ANY($4::uuid[])) AND ($5::uuid IS NULL OR id <> $5)
       AND source <> 'simulador'`;
  const params = [service.id, from, to, service.assigned_user_ids, excludeId ?? null];
  return client ? (await client.query(sql, params)).rows : query<Busy>(sql, params);
}

export interface AgendaContext {
  timezone: string;
  services: { id: string; name: string; kind: string; duration: number; description: string; location: string }[];
  slots: Record<string, { key: string; label: string }[]>;
  appointments: { id: string; service_name: string; kind: string; label: string }[];
  /** Para llamadas fuera de WhatsApp hace falta pedir un teléfono. */
  needsPhoneFor: string[];
}

export type BookResult = { ok: true; appointment: Appointment } | { ok: false; reason: string; alternatives: string[] };

export class Agenda {
  constructor(private chat: ChatService) {}

  /** Lo que la IA necesita para ofrecer y agendar: servicios, horarios libres y citas del cliente. */
  async contextFor(accountId: string, contact: Contact, channelType: ChannelType, now = new Date()): Promise<AgendaContext | null> {
    const services = await astore.listServices(accountId, true);
    const upcoming = await astore.listAppointments(accountId, { contactId: contact.id, from: now, status: 'confirmed' });
    if (!services.length && !upcoming.length) return null;
    const settings = await astore.getSettings(accountId);
    const tz = settings.timezone;
    const slots: AgendaContext['slots'] = {};
    for (const s of services) {
      const horizonEnd = new Date(now.getTime() + Math.min(s.max_days_ahead, 14) * 86400_000 + 86400_000);
      const busy = await busyFor(s, now, horizonEnd);
      slots[s.id] = spreadSlots(computeSlots(s, settings, busy, now, { days: 14 })).map((x) => ({
        key: x.key,
        label: `${spanishDate(x.start, tz)}, ${spanishTime(x.start, tz)}`,
      }));
    }
    return {
      timezone: tz,
      services: services.map((s) => ({ id: s.id, name: s.name, kind: s.kind, duration: s.duration_minutes, description: s.description, location: s.location })),
      slots,
      appointments: upcoming.map((a) => ({
        id: a.id,
        service_name: a.service_name,
        kind: a.kind,
        label: `${spanishDate(new Date(a.starts_at), tz)}, ${spanishTime(new Date(a.starts_at), tz)}`,
      })),
      needsPhoneFor: channelType === 'whatsapp' ? [] : services.filter((s) => s.kind === 'call').map((s) => s.id),
    };
  }

  /** Agenda de forma segura: vuelve a verificar el horario dentro de una transacción bloqueada. */
  async book(o: {
    accountId: string;
    serviceId: string;
    slotKey: string;
    conversation?: Conversation | null;
    contact?: Contact | null;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
    source: 'bot' | 'panel';
    force?: boolean;
    assignedUserId?: string | null;
  }): Promise<BookResult> {
    const service = await astore.getService(o.serviceId);
    if (!service || service.account_id !== o.accountId || !service.active) return { ok: false, reason: 'Servicio no disponible', alternatives: [] };
    const settings = await astore.getSettings(o.accountId);
    const tz = settings.timezone;
    // Citas creadas desde el simulador: se marcan, no ocupan horarios reales ni avisan al equipo.
    const simulated = !!o.conversation && (await store.getChannel(o.conversation.channel_id))?.type === 'playground';
    const source = simulated ? 'simulador' : o.source;
    const [date, time] = o.slotKey.split('T');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(time ?? '')) return { ok: false, reason: 'Horario inválido', alternatives: [] };
    const start = zonedToUtc(date, time, tz);
    const end = new Date(start.getTime() + service.duration_minutes * 60_000);

    const result = await withTransaction(async (client) => {
      // Una reserva a la vez por cuenta: evita dobles reservas simultáneas.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agenda:${o.accountId}`]);
      const dayStart = zonedToUtc(date, '00:00', tz);
      const busy = await busyFor(service, new Date(dayStart.getTime() - 86400_000), new Date(dayStart.getTime() + 2 * 86400_000), client as any);
      const free = computeSlots(service, settings, busy, new Date(), { onlyDate: date });
      const slot = free.find((s) => s.key === o.slotKey);
      if (!slot && !o.force) return null;
      const overlapping = busy.filter((b) => new Date(b.starts_at) < end && new Date(b.ends_at) > start);
      const assigned =
        o.assignedUserId ??
        (service.assigned_user_ids.find((u) => !overlapping.some((b) => b.assigned_user_id === u)) || null);
      const row = await client.query(
        `INSERT INTO appointments (account_id, service_id, service_name, kind, contact_id, conversation_id, assigned_user_id,
           customer_name, customer_phone, starts_at, ends_at, source, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          o.accountId,
          service.id,
          service.name,
          service.kind,
          o.contact?.id ?? null,
          o.conversation?.id ?? null,
          assigned,
          o.customerName ?? o.contact?.name ?? o.contact?.push_name ?? '',
          o.customerPhone ?? o.contact?.phone ?? o.contact?.data?.telefono ?? '',
          start,
          end,
          source,
          o.notes ?? '',
        ],
      );
      return row.rows[0] as Appointment;
    });

    if (!result) {
      const busy = await busyFor(service, new Date(), new Date(Date.now() + 15 * 86400_000));
      const alternatives = spreadSlots(computeSlots(service, settings, busy, new Date(), { days: 14 }), 3, 4).map(
        (s) => `${spanishDate(s.start, tz)} a las ${spanishTime(s.start, tz)}`,
      );
      return { ok: false, reason: 'El horario ya no está disponible', alternatives };
    }

    if (!simulated) await this.scheduleReminders(result, service);
    const when = `${spanishDate(new Date(result.starts_at), tz)} a las ${spanishTime(new Date(result.starts_at), tz)}`;
    const kindName = service.kind === 'call' ? 'Llamada' : 'Cita';
    await logEvent({ level: 'info', source: 'engine', message: `${kindName} agendada: ${service.name}, ${when} (${source})`, accountId: o.accountId, conversationId: o.conversation?.id ?? null });
    if (service.notify_team && !simulated) {
      await this.chat.automator.alertTeam(o.accountId, {
        title: `📅 ${kindName} agendada: ${service.name}`,
        body: `${result.customer_name || 'Cliente'}${result.customer_phone ? ` (+${result.customer_phone.replace(/^\+/, '')})` : ''} · ${when}${o.source === 'bot' ? ' · agendada por el bot' : ''}`,
        link: o.conversation ? `#/conversation/${o.conversation.id}` : '#/agenda',
        userIds: result.assigned_user_id ? [result.assigned_user_id] : undefined,
      });
    }
    if (o.conversation) this.chat.automator.emit({ type: 'appointment_booked', conversationId: o.conversation.id, appointment: result });
    return { ok: true, appointment: result };
  }

  async cancel(appointmentId: string, reason: string, by: 'bot' | 'panel') {
    const a = await astore.getAppointment(appointmentId);
    if (!a || a.status !== 'confirmed') return null;
    await query(`UPDATE appointments SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1`, [a.id, reason]);
    await astore.cancelJobs('appointment_id', a.id);
    const settings = await astore.getSettings(a.account_id);
    const when = `${spanishDate(new Date(a.starts_at), settings.timezone)} a las ${spanishTime(new Date(a.starts_at), settings.timezone)}`;
    await this.chat.automator.alertTeam(a.account_id, {
      title: `❌ ${a.kind === 'call' ? 'Llamada' : 'Cita'} cancelada: ${a.service_name}`,
      body: `${a.customer_name || 'Cliente'} · ${when} · ${by === 'bot' ? 'cancelada por el cliente en el chat' : reason}`,
      link: a.conversation_id ? `#/conversation/${a.conversation_id}` : '#/agenda',
      userIds: a.assigned_user_id ? [a.assigned_user_id] : undefined,
    });
    const updated = { ...a, status: 'cancelled' as const, cancel_reason: reason };
    if (a.conversation_id) this.chat.automator.emit({ type: 'appointment_cancelled', conversationId: a.conversation_id, appointment: updated });
    return updated;
  }

  /** Cambiar fecha/hora (desde el panel). Verifica disponibilidad salvo que se fuerce. */
  async reschedule(appointmentId: string, slotKeyLocal: string, force: boolean): Promise<BookResult> {
    const a = await astore.getAppointment(appointmentId);
    if (!a || a.status !== 'confirmed' || !a.service_id) return { ok: false, reason: 'Cita no encontrada', alternatives: [] };
    const service = await astore.getService(a.service_id);
    if (!service) return { ok: false, reason: 'Servicio no encontrado', alternatives: [] };
    const settings = await astore.getSettings(a.account_id);
    const [date, time] = slotKeyLocal.split('T');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(time ?? '')) return { ok: false, reason: 'Horario inválido', alternatives: [] };
    // Su propio lugar no cuenta como ocupado al validar el nuevo horario.
    const busy = await busyFor(service, new Date(Date.now() - 86400_000), new Date(Date.now() + (service.max_days_ahead + 2) * 86400_000), undefined, a.id);
    const ok = force || computeSlots(service, settings, busy, new Date(), { onlyDate: date }).some((s) => s.key === slotKeyLocal);
    if (!ok) return { ok: false, reason: 'Ese horario no está disponible', alternatives: [] };
    const start = zonedToUtc(date, time, settings.timezone);
    const end = new Date(start.getTime() + service.duration_minutes * 60_000);
    await query(`UPDATE appointments SET starts_at = $2, ends_at = $3, updated_at = now() WHERE id = $1`, [a.id, start, end]);
    await astore.cancelJobs('appointment_id', a.id);
    const updated = (await astore.getAppointment(a.id))!;
    await this.scheduleReminders(updated, service);
    return { ok: true, appointment: updated };
  }

  async scheduleReminders(a: Appointment, service: Service) {
    for (const minutes of service.reminders) {
      const runAt = new Date(new Date(a.starts_at).getTime() - minutes * 60_000);
      if (runAt.getTime() < Date.now() + 60_000 || !a.conversation_id) continue;
      await astore.scheduleJob({
        account_id: a.account_id,
        type: 'appointment_reminder',
        payload: { appointment_id: a.id, conversation_id: a.conversation_id, minutes },
        run_at: runAt,
        dedupe_key: `reminder:${a.id}:${minutes}`,
      });
    }
  }

  /** Tarea programada: recordatorio al cliente (mensaje de servicio, se envía aunque se haya dado de baja de promociones). */
  async sendReminder(payload: { appointment_id: string }) {
    const a = await astore.getAppointment(payload.appointment_id);
    if (!a || a.status !== 'confirmed' || !a.conversation_id) return;
    const service = a.service_id ? await astore.getService(a.service_id) : null;
    const r = await this.chat.outbound.send(a.conversation_id, {
      text: service?.reminder_message || DEFAULT_REMINDER,
      source: 'reminder',
      transactional: true,
      allowWhenHuman: true,
      appointment: a,
      location: service?.location,
    });
    if (!r.sent) {
      await logEvent({ level: 'warn', source: 'engine', message: `Recordatorio no enviado: ${r.reason}`, accountId: a.account_id, conversationId: a.conversation_id });
    }
  }

  /** Confirmación al cliente cuando la cita se crea desde el panel. */
  async sendConfirmation(a: Appointment) {
    if (!a.conversation_id) return { sent: false, reason: 'sin conversación' };
    const service = a.service_id ? await astore.getService(a.service_id) : null;
    return this.chat.outbound.send(a.conversation_id, {
      text: `Hola {{nombre}}, tu {{cita.tipo}} de {{cita.servicio}} quedó agendada para el {{cita.fecha}} a las {{cita.hora}}.${service?.location ? ' Lugar: {{cita.lugar}}.' : ''}`,
      source: 'booking',
      transactional: true,
      allowWhenHuman: true,
      appointment: a,
      location: service?.location,
    });
  }
}

/* ------------------------------ Calendario .ics ------------------------------ */

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export async function buildIcs(accountId: string, accountName: string) {
  const from = new Date(Date.now() - 30 * 86400_000);
  // Todo menos lo cancelado: las citas completadas siguen en el calendario como historial.
  const list = (await astore.listAppointments(accountId, { from })).filter((a) => a.status !== 'cancelled' && a.source !== 'simulador');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//chatbot-platform//agenda//ES', `X-WR-CALNAME:${icsEscape(`Agenda ${accountName}`)}`, 'CALSCALE:GREGORIAN'];
  for (const a of list) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${a.id}@chatbot-platform`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(new Date(a.starts_at))}`,
      `DTEND:${icsDate(new Date(a.ends_at))}`,
      `SUMMARY:${icsEscape(`${a.kind === 'call' ? '📞' : '📅'} ${a.service_name} · ${a.customer_name || 'Cliente'}${a.status === 'completed' ? ' (completada)' : a.status === 'no_show' ? ' (no asistió)' : ''}`)}`,
      `DESCRIPTION:${icsEscape([a.customer_phone && `Teléfono: ${a.customer_phone}`, a.notes].filter(Boolean).join('\n'))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export { renderTemplate, store };
