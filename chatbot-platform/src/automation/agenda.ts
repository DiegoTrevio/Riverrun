import { calendarBusy, syncCalendars } from '../integrations/calendars.js';
import type pg from 'pg';
import { query, queryOne, withTransaction } from '../db.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { ChannelType, Contact, Conversation } from '../types.js';
import { staffBusy, syncStaffEvent } from '../integrations/staff-calendars.js';
import * as googleCal from '../integrations/google.js';
import * as outlookCal from '../integrations/outlook.js';
import { mailBrand } from '../brands.js';
import { config } from '../config.js';
import { formatMoney } from '../quotes/format.js';
import { getReceivableSettings, receivableBySource, todayIn, type Receivable } from '../receivables/index.js';
import { sendMail } from '../mailer.js';
import { activeStaff, assignmentStats, isOff, pickStaff, staffInfo, staffNames, worksDuring, type StaffInfo } from './staff.js';
import * as astore from './store.js';
import { renderTemplate } from './templates.js';
import { addDays, beforeQuiet, dayOf, fromMinutes, inSendWindow, localParts, sendableAt, slotKey, spanishDate, spanishTime, toMinutes, zonedToUtc } from './time.js';
import { spreadOf, windowOf } from './send-window.js';
import { DEFAULT_REMINDER, type AccountSettings, type Appointment, type SendWindow, type Service } from './types.js';

export interface Slot {
  start: Date;
  end: Date;
  /** Clave local "YYYY-MM-DDTHH:MM" que ve la IA. */
  key: string;
  /** Personas del servicio libres en ese horario (vacío si el servicio no tiene personas asignadas). */
  users: string[];
}

export interface Busy {
  service_id: string | null;
  assigned_user_id: string | null;
  starts_at: Date;
  ends_at: Date;
  /** Ocupado en el calendario de la cuenta: bloquea el horario para todos. */
  all?: boolean;
}

/**
 * Horarios libres de un servicio. Respeta horario (del servicio o de la cuenta), días festivos, anticipación mínima y
 * cuántas citas caben al mismo tiempo.
 * - Sin personas asignadas: `capacity` citas del servicio al mismo tiempo.
 * - Con personas: un horario sirve si al menos una está libre: dentro de su horario, sin días libres, sin citas de otros
 *   servicios ni eventos ocupados en su calendario, y con menos de `capacity` citas de este servicio a esa hora (1 = una
 *   persona atiende a un cliente a la vez). Sin horario propio del servicio, se ofrecen los horarios de las personas.
 */
export function computeSlots(service: Service, settings: AccountSettings, busy: Busy[], now: Date, opts: { days?: number; onlyDate?: string } = {}, staff: StaffInfo[] = []): Slot[] {
  const tz = settings.timezone;
  const today = localParts(now, tz).date;
  const horizon = Math.min(service.max_days_ahead, opts.days ?? service.max_days_ahead);
  const earliest = now.getTime() + service.min_notice_minutes * 60_000;
  const step = service.duration_minutes + service.buffer_minutes;
  const bufferMs = service.buffer_minutes * 60_000;
  const users = service.assigned_user_ids;
  const byId = new Map(staff.map((s) => [s.id, s]));
  const out: Slot[] = [];
  for (let i = 0; i <= horizon; i++) {
    const date = addDays(today, i);
    if (opts.onlyDate && date !== opts.onlyDate) continue;
    if (settings.holidays.includes(date)) continue;
    const day = dayOf(date);
    // Rejilla de horarios: la del servicio; si no tiene y hay personas, la de cada una (o la del negocio).
    const windows = service.hours
      ? service.hours[day] ?? []
      : users.length
        ? users.flatMap((u) => (byId.get(u)?.hours ?? settings.business_hours)[day] ?? [])
        : settings.business_hours[day] ?? [];
    const seen = new Set<number>();
    for (const [s, e] of windows) {
      for (let t = toMinutes(s); t + service.duration_minutes <= toMinutes(e); t += step) {
        if (seen.has(t)) continue;
        seen.add(t);
        const start = zonedToUtc(date, fromMinutes(t), tz);
        if (start.getTime() < earliest) continue;
        const end = new Date(start.getTime() + service.duration_minutes * 60_000);
        const overlapping = busy.filter(
          (b) => new Date(b.starts_at).getTime() < end.getTime() + bufferMs && new Date(b.ends_at).getTime() + bufferMs > start.getTime(),
        );
        if (overlapping.some((b) => b.all)) continue;
        if (!users.length) {
          if (overlapping.filter((b) => b.service_id === service.id).length >= service.capacity) continue;
          out.push({ start, end, key: slotKey(start, tz), users: [] });
          continue;
        }
        const free = users.filter((u) => {
          const info = byId.get(u);
          // Sin horario propio, la persona trabaja en el horario del servicio o, si el servicio no tiene, en el del
          // negocio (no en el horario extendido de otra persona).
          const own = info?.hours ?? (service.hours ? null : settings.business_hours);
          if (isOff(info, date) || !worksDuring({ id: u, hours: own, time_off: [] }, day, t, t + service.duration_minutes)) return false;
          const mine = overlapping.filter((b) => b.assigned_user_id === u);
          // Una cita de otro servicio o un evento de su calendario la ocupan; de este servicio caben `capacity`.
          return !mine.some((b) => b.service_id !== service.id) && mine.length < service.capacity;
        });
        if (free.length) out.push({ start, end, key: slotKey(start, tz), users: free });
      }
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
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

/** Citas que ocupan horarios del servicio o de sus personas (de la base de datos). */
export async function appointmentBusy(service: Service, from: Date, to: Date, client?: { query: (q: string, p: unknown[]) => Promise<{ rows: Busy[] }> }, excludeId?: string): Promise<Busy[]> {
  const sql = `SELECT service_id, assigned_user_id, starts_at, ends_at FROM appointments
     WHERE status = 'confirmed' AND starts_at < $3 AND ends_at > $2
       AND (service_id = $1 OR assigned_user_id = ANY($4::uuid[])) AND ($5::uuid IS NULL OR id <> $5)
       AND source <> 'simulador'`;
  const params = [service.id, from, to, service.assigned_user_ids, excludeId ?? null];
  return client ? (await client.query(sql, params)).rows : query<Busy>(sql, params);
}

/** Eventos ocupados de los calendarios conectados: el de la cuenta bloquea a todos; el de cada persona, solo a ella. */
export async function calendarBusyFor(service: Service, from: Date, to: Date): Promise<Busy[]> {
  const [account, people] = await Promise.all([calendarBusy(service.account_id, from, to), staffBusy(service.assigned_user_ids, from, to)]);
  return [
    ...account.filter((b) => b.starts_at < to && b.ends_at > from).map((b) => ({ service_id: null, assigned_user_id: null, starts_at: b.starts_at, ends_at: b.ends_at, all: true })),
    ...people.map((b) => ({ service_id: null, assigned_user_id: b.user_id, starts_at: b.starts_at, ends_at: b.ends_at })),
  ];
}

export async function busyFor(service: Service, from: Date, to: Date, excludeId?: string): Promise<Busy[]> {
  const [rows, calendars] = await Promise.all([appointmentBusy(service, from, to, undefined, excludeId), calendarBusyFor(service, from, to)]);
  return rows.concat(calendars);
}

/** Horarios libres del servicio con todo lo que los limita (citas, calendarios y disponibilidad de las personas). */
export async function freeSlots(input: Service, settings: AccountSettings, now: Date, opts: { days?: number; onlyDate?: string } = {}) {
  const service = await activeStaff(input);
  if (service.none) return [];
  const days = opts.days ?? service.max_days_ahead;
  const [busy, staff] = await Promise.all([busyFor(service, now, new Date(now.getTime() + (days + 1) * 86400_000)), staffInfo(service.assigned_user_ids)]);
  return computeSlots(service, settings, busy, now, opts, staff);
}

export interface AgendaContext {
  timezone: string;
  services: { id: string; name: string; kind: string; duration: number; description: string; location: string; call_mode?: string }[];
  slots: Record<string, { key: string; label: string }[]>;
  /** Servicios donde el cliente puede pedir a una persona: cada una con sus horarios libres. */
  people?: Record<string, { userId: string; name: string; slots: { key: string; label: string }[] }[]>;
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
    const people: NonNullable<AgendaContext['people']> = {};
    const label = (x: Slot) => ({ key: x.key, label: `${spanishDate(x.start, tz)}, ${spanishTime(x.start, tz)}` });
    for (const s of services) {
      const all = await freeSlots(s, settings, now, { days: Math.min(s.max_days_ahead, 14) });
      slots[s.id] = spreadSlots(all).map(label);
      // El cliente puede pedir a una persona: se le ofrecen los horarios de esa persona.
      if (s.customer_choice && s.assigned_user_ids.length) {
        const active = await activeStaff(s);
        const names = await staffNames(active.assigned_user_ids);
        people[s.id] = active.assigned_user_ids.slice(0, 8).map((userId) => ({
          userId,
          name: names.get(userId) ?? 'Persona',
          slots: spreadSlots(all.filter((x) => x.users.includes(userId)), 3, 8).map(label),
        }));
      }
    }
    return {
      timezone: tz,
      services: services.map((s) => ({ id: s.id, name: s.name, kind: s.kind, duration: s.duration_minutes, description: s.description, location: s.location, call_mode: s.call_mode })),
      slots,
      people,
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
    customerEmail?: string;
    notes?: string;
    /** bot: el agente en el chat; panel: el equipo; pagina: el cliente en la página pública para reservar. */
    source: 'bot' | 'panel' | 'pagina';
    force?: boolean;
    /** Persona pedida (por el cliente o el equipo). Si no, primero quien atiende la conversación (si el servicio lo pide) o el reparto. */
    assignedUserId?: string | null;
  }): Promise<BookResult> {
    const raw = await astore.getService(o.serviceId);
    if (!raw || raw.account_id !== o.accountId || !raw.active) return { ok: false, reason: 'Servicio no disponible', alternatives: [] };
    // Solo las personas activas del servicio.
    const service = await activeStaff(raw);
    if (service.none) return { ok: false, reason: 'No hay personas activas para este servicio', alternatives: [] };
    const settings = await astore.getSettings(o.accountId);
    const tz = settings.timezone;
    // Citas creadas desde el simulador: se marcan, no ocupan horarios reales ni avisan al equipo.
    const simulated = !!o.conversation && (await store.getChannel(o.conversation.channel_id))?.type === 'playground';
    const source = simulated ? 'simulador' : o.source;
    const [date, time] = o.slotKey.split('T');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(time ?? '')) return { ok: false, reason: 'Horario inválido', alternatives: [] };
    const start = zonedToUtc(date, time, tz);
    const end = new Date(start.getTime() + service.duration_minutes * 60_000);
    const dayStart = zonedToUtc(date, '00:00', tz);
    const window = [new Date(dayStart.getTime() - 86400_000), new Date(dayStart.getTime() + 2 * 86400_000)] as const;
    // Los calendarios (red) se consultan antes de bloquear; las citas, otra vez dentro de la transacción.
    const [calendars, staff] = await Promise.all([calendarBusyFor(service, window[0], window[1]), staffInfo(service.assigned_user_ids)]);

    const result = await withTransaction(async (client) => {
      // Una reserva a la vez por cuenta: evita dobles reservas simultáneas.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agenda:${o.accountId}`]);
      const busy = (await appointmentBusy(service, window[0], window[1], client as any)).concat(calendars);
      const free = computeSlots(service, settings, busy, new Date(), { onlyDate: date }, staff);
      const slot = free.find((s) => s.key === o.slotKey);
      if (!slot && !o.force) return null;
      // Quien se pidió debe estar libre (salvo que se fuerce); si no se pidió a nadie, le toca a quien corresponda.
      if (o.assignedUserId && slot && service.assigned_user_ids.length && !slot.users.includes(o.assignedUserId) && !o.force) return null;
      // Primero con quien ya atiende al cliente (si el servicio lo pide y esa persona está libre); si no, el reparto.
      const owner = service.prefer_owner ? o.conversation?.assigned_user_id ?? null : null;
      const assigned = o.assignedUserId
        ?? (owner && slot?.users.includes(owner) ? owner : null)
        ?? (slot?.users.length ? pickStaff(service, slot.users, await assignmentStats(service.id, slot.users, client)) : null);
      const row = await client.query(
        `INSERT INTO appointments (account_id, service_id, service_name, kind, contact_id, conversation_id, assigned_user_id,
           customer_name, customer_phone, starts_at, ends_at, source, notes, customer_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
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
          (o.customerEmail ?? '').trim().toLowerCase(),
        ],
      );
      return row.rows[0] as Appointment;
    });

    if (!result) {
      const alternatives = spreadSlots(await freeSlots(service, settings, new Date(), { days: 14 }), 3, 4).map(
        (s) => `${spanishDate(s.start, tz)} a las ${spanishTime(s.start, tz)}`,
      );
      return { ok: false, reason: 'El horario ya no está disponible', alternatives };
    }

    if (!simulated) await this.scheduleReminders(result, service);
    if (!simulated) await this.createDeposit(result, service, tz).catch((e) => logEvent({ level: 'error', source: 'engine', message: `No se pudo registrar el anticipo de la cita: ${e?.message ?? e}`, accountId: o.accountId, conversationId: o.conversation?.id ?? null }));
    // Videollamada: el enlace queda listo antes de confirmar (Meet o Teams del calendario, o el enlace fijo).
    if (!simulated && service.kind === 'call' && service.call_mode === 'video') result.meeting_url = await this.meetingFor(result, service);
    result.assigned_user_name = result.assigned_user_id ? (await staffNames([result.assigned_user_id])).get(result.assigned_user_id) ?? null : null;
    const when = `${spanishDate(new Date(result.starts_at), tz)} a las ${spanishTime(new Date(result.starts_at), tz)}`;
    const kindName = service.kind === 'call' ? 'Llamada' : 'Cita';
    await logEvent({ level: 'info', source: 'engine', message: `${kindName} agendada: ${service.name}, ${when} (${source})`, accountId: o.accountId, conversationId: o.conversation?.id ?? null });
    if (service.notify_team && !simulated) {
      await this.chat.automator.alertTeam(o.accountId, {
        title: `📅 ${kindName} agendada: ${service.name}`,
        body: `${result.customer_name || 'Cliente'}${result.customer_phone ? ` (+${result.customer_phone.replace(/^\+/, '')})` : ''} · ${when}${o.source === 'bot' ? ' · agendada por el bot' : ''}`,
        link: o.conversation ? `#/conversation/${o.conversation.id}` : '#/agenda',
        userIds: result.assigned_user_id ? [result.assigned_user_id] : undefined,
        staffId: result.assigned_user_id ?? null,
        kind: 'appointment',
      });
    }
    if (!simulated) await syncCalendars(o.accountId, result.id).catch(() => undefined);
    if (!simulated) await this.mailStaff(result, service, 'booked', when).catch(() => undefined);
    if (o.conversation) this.chat.automator.emit({ type: 'appointment_booked', conversationId: o.conversation.id, appointment: result });
    return { ok: true, appointment: result };
  }

  /**
   * Enlace de la videollamada: la sala de Meet o Teams que crea el calendario de la persona (o el del negocio, si la cita
   * no tiene persona); si no hay calendario, el enlace fijo de la persona o el lugar del servicio si es un enlace.
   */
  private async meetingFor(a: Appointment, service: Service): Promise<string> {
    try {
      if (a.assigned_user_id) await syncStaffEvent({ appointment_id: a.id });
      else {
        await googleCal.syncAppointment({ appointment_id: a.id });
        await outlookCal.syncAppointment({ appointment_id: a.id });
      }
    } catch (e: any) {
      await logEvent({ level: 'warn', source: 'engine', message: `No se pudo crear la sala de la videollamada en el calendario: ${e?.message ?? e}`, accountId: a.account_id });
    }
    const made = (await queryOne<{ meeting_url: string }>(`SELECT meeting_url FROM appointments WHERE id = $1`, [a.id]))?.meeting_url ?? '';
    if (made) return made;
    const fixed = a.assigned_user_id ? (await queryOne<{ meeting_url: string }>(`SELECT meeting_url FROM staff_schedules WHERE user_id = $1`, [a.assigned_user_id]))?.meeting_url ?? '' : '';
    const url = fixed || (/^https:\/\//.test(service.location) ? service.location : '');
    if (url) await query(`UPDATE appointments SET meeting_url = $2 WHERE id = $1`, [a.id, url]);
    else await logEvent({ level: 'warn', source: 'engine', message: `Videollamada sin enlace: conecta el calendario de la persona o pon su enlace fijo en Agenda → Equipo (${service.name})`, accountId: a.account_id });
    return url;
  }

  /** Correo al cliente que reservó sin conversación (página pública o panel): confirmación, recordatorio o cancelación. Dice si salió. */
  async mailCustomer(a: Appointment, what: 'booked' | 'reminder' | 'cancelled'): Promise<boolean> {
    if (!a.customer_email) return false;
    const settings = await astore.getSettings(a.account_id);
    const acc = await store.getAccount(a.account_id);
    const mb = await mailBrand(a.account_id);
    const business = mb.fromName || acc?.name || 'tu reservación';
    const when = `${spanishDate(new Date(a.starts_at), settings.timezone)} a las ${spanishTime(new Date(a.starts_at), settings.timezone)}`;
    const call = a.kind === 'call';
    const kind = call ? (a.meeting_url ? 'videollamada' : 'llamada') : 'cita';
    const subject = what === 'booked' ? `Tu ${kind} quedó agendada: ${a.service_name} · ${when}`
      : what === 'reminder' ? `Recordatorio: tu ${kind} de ${a.service_name} · ${when}` : `Tu ${kind} se canceló: ${a.service_name} · ${when}`;
    const service = a.service_id ? await astore.getService(a.service_id) : null;
    const first = (a.customer_name || '').split(/\s+/)[0];
    const main = what === 'cancelled'
      ? [`Tu ${kind} de ${a.service_name} del ${when} se canceló.`]
      : [
          `Tu ${kind} de ${a.service_name} es el ${when}${a.assigned_user_name ? ` con ${a.assigned_user_name}` : ''}.`,
          a.meeting_url ? `Entra a la videollamada aquí: ${a.meeting_url}` : '',
          call && !a.meeting_url && a.customer_phone ? `Te llamaremos al +${a.customer_phone.replace(/^\+/, '')}.` : '',
          call && !a.meeting_url && !a.customer_phone ? 'Antes de la hora te enviaremos el enlace o los datos para la llamada.' : '',
          !call && service?.location ? `Lugar: ${service.location}` : '',
        ].filter(Boolean);
    const deposit = what === 'booked' ? await this.depositOf(a) : null;
    if (deposit?.status === 'pending') {
      const how = (await getReceivableSettings(a.account_id)).payment_instructions.trim();
      main.push('', `Para confirmar tu ${kind} te pedimos un anticipo de ${formatMoney(Number(deposit.amount_cents), deposit.currency)}.`, ...(how ? ['Cómo pagar:', how] : []));
    }
    const text = [first ? `Hola ${first},` : 'Hola,', '', ...main, '', `— ${business}`].join('\n');
    return sendMail({ fromName: mb.fromName, to: a.customer_email, subject, text });
  }

  /** Correo a la persona que atiende la cita o llamada (agendada o cancelada), con lo que necesita para atenderla. */
  private async mailStaff(a: Appointment, service: Pick<Service, 'kind' | 'call_mode'> | null, what: 'booked' | 'cancelled', when: string) {
    if (!a.assigned_user_id) return;
    const user = await queryOne<{ email: string; name: string; active: boolean }>(`SELECT email, name, active FROM users WHERE id = $1`, [a.assigned_user_id]);
    if (!user?.email || !user.active) return;
    const mb = await mailBrand(a.account_id);
    const call = a.kind === 'call';
    const video = call && service?.call_mode === 'video';
    const what1 = call ? (video ? 'videollamada' : 'llamada') : 'cita';
    const subject = what === 'booked' ? `Nueva ${what1} contigo: ${a.service_name} · ${when}` : `Se canceló tu ${what1}: ${a.service_name} · ${when}`;
    const details = [
      `${what === 'booked' ? 'Te toca atender' : 'Se canceló'} esta ${what1}:`,
      `· ${a.service_name}, ${when}`,
      `· Cliente: ${a.customer_name || 'sin nombre'}`,
      a.customer_phone ? `· Teléfono: +${a.customer_phone.replace(/^\+/, '')}${call && !video ? ' (márcale a esa hora)' : ''}` : '',
      a.customer_email ? `· Correo: ${a.customer_email}` : '',
      video && a.meeting_url ? `· Enlace de la videollamada: ${a.meeting_url}` : '',
      video && !a.meeting_url && what === 'booked' ? '· No se pudo crear el enlace de la videollamada: envíale uno al cliente.' : '',
      a.notes ? `· Notas: ${a.notes}` : '',
    ].filter(Boolean);
    await sendMail({ fromName: mb.fromName, to: user.email, subject, text: [...details, '', `Agenda: ${mb.base}/#/agenda`].join('\n') });
  }

  async cancel(appointmentId: string, reason: string, by: 'bot' | 'panel' | 'pagina' | 'sistema') {
    const a = await astore.getAppointment(appointmentId);
    if (!a || a.status !== 'confirmed') return null;
    // Cancelar la cita y sus recordatorios en un solo paso: no puede quedar cancelada con recordatorios vivos.
    await withTransaction(async (c) => {
      await c.query(`UPDATE appointments SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1`, [a.id, reason]);
      await astore.cancelJobs('appointment_id', a.id, c);
    });
    // Su anticipo pendiente ya no se cobra.
    const deposit = await receivableBySource(a.account_id, 'appointment', a.id);
    if (deposit?.status === 'pending') await this.chat.receivables.settle(deposit, 'canceled', { userId: null, note: 'Se canceló la cita' });
    const settings = await astore.getSettings(a.account_id);
    const when = `${spanishDate(new Date(a.starts_at), settings.timezone)} a las ${spanishTime(new Date(a.starts_at), settings.timezone)}`;
    const service = a.service_id ? await astore.getService(a.service_id) : null;
    if (a.source !== 'simulador') await this.mailStaff(a, service, 'cancelled', when).catch(() => undefined);
    // Igual que al agendar: un servicio con «avisar al equipo» apagado tampoco avisa al cancelar, y el simulador no avisa.
    if (((service?.notify_team ?? true) || by === 'sistema') && a.source !== 'simulador') {
      await this.chat.automator.alertTeam(a.account_id, {
        title: `❌ ${a.kind === 'call' ? 'Llamada' : 'Cita'} cancelada: ${a.service_name}`,
        body: `${a.customer_name || 'Cliente'}${a.customer_phone ? ` (+${a.customer_phone.replace(/^\+/, '')})` : ''} · ${when} · ${by === 'bot' ? 'cancelada por el cliente en el chat' : by === 'pagina' ? 'cancelada por el cliente' : by === 'sistema' ? `se canceló sola: ${reason}` : reason}`,
        link: a.conversation_id ? `#/conversation/${a.conversation_id}` : '#/agenda',
        userIds: a.assigned_user_id ? [a.assigned_user_id] : undefined,
        staffId: a.assigned_user_id ?? null,
        kind: 'appointment',
      });
    }
    await syncCalendars(a.account_id, a.id).catch(() => undefined);
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
    const [busy, staff] = await Promise.all([
      busyFor(service, new Date(Date.now() - 86400_000), new Date(Date.now() + (service.max_days_ahead + 2) * 86400_000), a.id),
      staffInfo(service.assigned_user_ids),
    ]);
    const slot = computeSlots(service, settings, busy, new Date(), { onlyDate: date }, staff).find((s) => s.key === slotKeyLocal);
    if (!slot && !force) return { ok: false, reason: 'Ese horario no está disponible', alternatives: [] };
    // Sigue con la misma persona si está libre a la nueva hora; si no, le toca a otra del servicio.
    let assigned = a.assigned_user_id;
    if (slot?.users.length && (!assigned || !slot.users.includes(assigned))) assigned = pickStaff(service, slot.users, await assignmentStats(service.id, slot.users));
    const start = zonedToUtc(date, time, settings.timezone);
    const end = new Date(start.getTime() + service.duration_minutes * 60_000);
    // Mover la cita, cancelar sus recordatorios y programar los nuevos en un solo paso: si algo falla a la mitad, la
    // cita no queda movida sin recordatorios (ni con los de la hora anterior).
    await withTransaction(async (c) => {
      await c.query(`UPDATE appointments SET starts_at = $2, ends_at = $3, assigned_user_id = $4, updated_at = now() WHERE id = $1`, [a.id, start, end, assigned]);
      await astore.cancelJobs('appointment_id', a.id, c);
      await this.scheduleReminders({ ...a, starts_at: start, ends_at: end, assigned_user_id: assigned }, service, c, settings);
    });
    const updated = (await astore.getAppointment(a.id))!;
    await this.moveDeposit(updated, service, settings.timezone);
    await syncCalendars(a.account_id, a.id).catch(() => undefined);
    return { ok: true, appointment: updated };
  }

  /* ------------------------------ Anticipo ------------------------------ */

  /** El día en que vence el anticipo (zona del negocio): unas horas antes de la cita, o hoy si ya no da tiempo. */
  private depositDue(a: Appointment, service: Service, tz: string, now = new Date()) {
    const limit = new Date(new Date(a.starts_at).getTime() - service.deposit_due_hours * 3600_000);
    return { limit, due: todayIn(tz, service.deposit_due_hours && limit > now ? limit : now) };
  }

  /** La tarea que cancela la cita si a la hora límite el anticipo sigue sin pagarse (si el servicio lo pide). */
  private async armDepositCheck(a: Appointment, service: Service, limit: Date) {
    if (!service.deposit_cancel_unpaid || !service.deposit_due_hours || limit.getTime() <= Date.now()) return;
    // Sin conversación ni correo no hay cómo avisarle del anticipo ni de la cancelación: el equipo decide.
    if (!a.conversation_id && !a.customer_email) return;
    await astore.scheduleJob({ account_id: a.account_id, type: 'appointment_deposit_check', payload: { appointment_id: a.id }, run_at: limit, dedupe_key: `depcheck:${a.id}` });
  }

  /**
   * Al agendar un servicio con anticipo: se registra el cobro (con sus recordatorios de pago) y, si hay conversación, el
   * cliente recibe en un par de minutos el primer aviso con cuánto y cómo pagar.
   */
  private async createDeposit(a: Appointment, service: Service, tz: string) {
    if (!service.deposit_cents || !config.receivables.enabled) return null;
    const { limit, due } = this.depositDue(a, service, tz);
    const when = `${spanishDate(new Date(a.starts_at), tz)} a las ${spanishTime(new Date(a.starts_at), tz)}`;
    const { receivable, existed } = await this.chat.receivables.create({
      accountId: a.account_id, contactId: a.contact_id, conversationId: a.conversation_id,
      concept: `Anticipo: ${service.name} del ${when}`, amountCents: service.deposit_cents, currency: service.deposit_currency,
      dueDate: due, source: 'appointment', sourceId: a.id, actor: 'la agenda',
    });
    if (existed) return receivable;
    if (a.conversation_id) {
      await astore.scheduleJob({ account_id: a.account_id, type: 'receivable_reminder', payload: { receivable_id: receivable.id, offset: 0 }, run_at: new Date(Date.now() + 2 * 60_000), dedupe_key: `payrem:${receivable.id}:al-agendar` });
    }
    await this.armDepositCheck(a, service, limit);
    return receivable;
  }

  /** La cita cambió de hora: el anticipo pendiente vence en su nuevo día y la revisión se mueve a la nueva hora límite. */
  private async moveDeposit(a: Appointment, service: Service, tz: string) {
    const deposit = await receivableBySource(a.account_id, 'appointment', a.id);
    if (deposit?.status !== 'pending') return;
    const { limit, due } = this.depositDue(a, service, tz);
    await this.chat.receivables.moveDue(deposit, due);
    await this.armDepositCheck(a, service, limit);
  }

  /** Tarea programada: a la hora límite, si el anticipo sigue pendiente, la cita se cancela y se le avisa al cliente. */
  async checkDeposit(payload: { appointment_id: string }) {
    const a = await astore.getAppointment(payload.appointment_id);
    if (!a || a.status !== 'confirmed') return;
    const deposit: Receivable | null = await receivableBySource(a.account_id, 'appointment', a.id);
    if (deposit?.status !== 'pending') return;
    // El cliente dijo que ya pagó y el equipo lo está verificando: se vuelve a revisar al terminar esa pausa.
    if (deposit.paused_until && new Date(deposit.paused_until).getTime() > Date.now()) {
      await astore.scheduleJob({ account_id: a.account_id, type: 'appointment_deposit_check', payload, run_at: new Date(deposit.paused_until), dedupe_key: `depcheck:${a.id}:pausa` });
      return;
    }
    const cancelled = await this.cancel(a.id, 'no se recibió el anticipo a tiempo', 'sistema');
    if (!cancelled) return;
    if (a.conversation_id) {
      await this.chat.outbound.send(a.conversation_id, {
        text: `Hola {{nombre}}, tu {{cita.tipo}} de {{cita.servicio}} del {{cita.fecha}} a las {{cita.hora}} se canceló porque no recibimos el anticipo de ${formatMoney(Number(deposit.amount_cents), deposit.currency)}. Si ya pagaste o quieres agendar otra vez, escríbenos por aquí.`,
        source: 'booking', transactional: true, allowWhenHuman: true, appointment: cancelled,
      });
    } else if (a.customer_email) await this.mailCustomer(cancelled, 'cancelled').catch(() => undefined);
  }

  /** El anticipo de una cita, para su confirmación y el detalle en el panel. */
  async depositOf(a: Pick<Appointment, 'id' | 'account_id'>) {
    return receivableBySource(a.account_id, 'appointment', a.id);
  }

  /** `settings`: los de la cuenta, si ya se tienen (dentro de una transacción no se vuelve a consultar). */
  async scheduleReminders(a: Appointment, service: Service, db?: pg.PoolClient, settings?: AccountSettings) {
    // Sin conversación (reservas de la página pública), el recordatorio va por correo.
    if (!a.conversation_id && !a.customer_email) return;
    const st = settings ?? (await astore.getSettings(a.account_id));
    for (const { minutes, at: runAt } of reminderTimes(new Date(a.starts_at), service.reminders, windowOf(st), st.timezone, new Date(), a.id)) {
      await astore.scheduleJob({
        account_id: a.account_id,
        type: 'appointment_reminder',
        // La hora de la cita va en el recordatorio: si la cita se movió y este quedó vivo, no sale con la hora vieja.
        payload: { appointment_id: a.id, conversation_id: a.conversation_id, minutes, starts_at: new Date(a.starts_at).toISOString() },
        run_at: runAt,
        dedupe_key: `reminder:${a.id}:${minutes}`,
      }, db);
    }
  }

  /** Tarea programada: recordatorio al cliente (mensaje de servicio, se envía aunque se haya dado de baja de promociones). */
  async sendReminder(payload: { appointment_id: string; starts_at?: string }) {
    const a = await astore.getAppointment(payload.appointment_id);
    // Sigue en pie y a la misma hora (un recordatorio de la hora anterior a un cambio no sale).
    const current = (x: Appointment | null | undefined): x is Appointment =>
      !!x && x.status === 'confirmed' && (!payload.starts_at || new Date(x.starts_at).getTime() === new Date(payload.starts_at).getTime());
    if (!current(a)) return;
    const service = a.service_id ? await astore.getService(a.service_id) : null;
    if (!a.conversation_id) {
      if (a.customer_email) await this.mailCustomer(a, 'reminder');
      return;
    }
    const r = await this.chat.outbound.send(a.conversation_id, {
      text: withLink(service?.reminder_message || DEFAULT_REMINDER, a),
      source: 'reminder',
      transactional: true,
      allowWhenHuman: true,
      appointment: a,
      location: service?.location,
      waTemplate: service?.reminder_wa_template ?? null,
      // Se vuelve a revisar justo antes de enviar: pudo cancelarse o moverse mientras tanto.
      stillValid: async () => current(await astore.getAppointment(a.id)),
    });
    if (!r.sent) {
      // Una cita cancelada o movida justo antes es lo esperado, no una advertencia.
      await logEvent({ level: r.reason === 'ya no corresponde enviarlo' ? 'info' : 'warn', source: 'engine', message: `Recordatorio no enviado: ${r.reason}`, accountId: a.account_id, conversationId: a.conversation_id });
    }
  }

  /** Confirmación al cliente cuando la cita se crea desde el panel. */
  async sendConfirmation(a: Appointment) {
    if (!a.conversation_id) return { sent: false, reason: 'sin conversación' };
    const service = a.service_id ? await astore.getService(a.service_id) : null;
    return this.chat.outbound.send(a.conversation_id, {
      text: withLink(`Hola {{nombre}}, tu {{cita.tipo}} de {{cita.servicio}} quedó agendada para el {{cita.fecha}} a las {{cita.hora}}${a.assigned_user_name ? ' con {{cita.persona}}' : ''}.${service?.location && !/^https:\/\//.test(service.location) ? ' Lugar: {{cita.lugar}}.' : ''}`, a),
      source: 'booking',
      transactional: true,
      allowWhenHuman: true,
      appointment: a,
      location: service?.location,
    });
  }
}

/** Un mensaje al cliente de una videollamada lleva su enlace (si el texto no lo trae ya con {{cita.enlace}}). */
export function withLink(text: string, a: Pick<Appointment, 'meeting_url'>): string {
  if (!a.meeting_url || /\{\{\s*cita\.enlace\s*\}\}/i.test(text)) return text;
  return `${text}\n\nEnlace para la videollamada: {{cita.enlace}}`;
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

/**
 * Cuándo sale un recordatorio que debía salir en `raw`: si cae de noche, antes de que empiece la noche (el texto dice
 * la fecha y la hora de la cita, así que llegar antes no confunde), repartido en la media hora anterior por cita
 * (`key`). Si esa hora ya pasó (se agendó de noche), a la hora de inicio si aún es antes de la cita. null: no da tiempo.
 */
export function reminderTime(raw: Date, startsAt: Date, w: SendWindow, tz: string, now = new Date(), key = ''): Date | null {
  if (inSendWindow(w, raw, tz)) return raw.getTime() >= now.getTime() + 60_000 ? raw : null;
  const before = beforeQuiet(w, raw, tz);
  const spread = new Date(before.getTime() - (key ? spreadOf(key) : 0));
  const early = inSendWindow(w, spread, tz) ? spread : before;
  if (early.getTime() >= now.getTime() + 60_000) return early;
  const after = sendableAt(w, raw, tz);
  return after.getTime() < startsAt.getTime() && after.getTime() >= now.getTime() + 60_000 ? after : null;
}

/** Los recordatorios de una cita (`minutes` antes de que empiece), con `reminderTime`; si dos quedan a la misma hora, sale uno. */
export function reminderTimes(startsAt: Date, minutes: number[], w: SendWindow, tz: string, now = new Date(), key = '') {
  const out: { minutes: number; at: Date }[] = [];
  for (const m of minutes) {
    const at = reminderTime(new Date(startsAt.getTime() - m * 60_000), startsAt, w, tz, now, key);
    if (!at || out.some((x) => x.at.getTime() === at.getTime())) continue;
    out.push({ minutes: m, at });
  }
  return out;
}

/**
 * Recordatorios ya programados que caen de noche (programados antes de este horario o antes de que la cuenta lo
 * cambiara): se adelantan como los nuevos, o se cancelan si ya no da tiempo o si otro de la misma cita sale a esa hora.
 */
export async function advanceQuietReminders(accountId?: string, now = new Date()) {
  const jobs = await query<{ id: string; account_id: string; run_at: Date; appointment_id: string; starts_at: string | null }>(
    `SELECT id, account_id, run_at, payload->>'appointment_id' AS appointment_id, payload->>'starts_at' AS starts_at FROM jobs
      WHERE type = 'appointment_reminder' AND status = 'pending' AND ($1::uuid IS NULL OR account_id = $1) ORDER BY run_at`, [accountId ?? null]);
  const settings = new Map<string, AccountSettings>();
  const taken = new Set<string>();
  let moved = 0;
  for (const j of jobs) {
    let st = settings.get(j.account_id);
    if (!st) settings.set(j.account_id, (st = await astore.getSettings(j.account_id)));
    const w = windowOf(st);
    if (inSendWindow(w, j.run_at, st.timezone)) { taken.add(`${j.appointment_id}|${j.run_at.getTime()}`); continue; }
    // Sin la hora de la cita no se sabe si a la hora de inicio aún sirve: que lo decida al correr (quiet-hold).
    if (!j.starts_at) continue;
    const at = reminderTime(j.run_at, new Date(j.starts_at), w, st.timezone, now, j.appointment_id);
    const key = `${j.appointment_id}|${at?.getTime()}`;
    if (!at || taken.has(key)) {
      await query(`UPDATE jobs SET status = 'cancelled', last_error = 'quiet_hours', finished_at = now() WHERE id = $1 AND status = 'pending'`, [j.id]);
    } else {
      await query(`UPDATE jobs SET run_at = $2 WHERE id = $1 AND status = 'pending'`, [j.id, at]);
      taken.add(key);
    }
    moved++;
  }
  return moved;
}
