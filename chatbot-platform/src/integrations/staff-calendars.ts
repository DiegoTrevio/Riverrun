/**
 * Calendario propio de cada persona del equipo (Google u Outlook). Lo conecta la propia persona: sus eventos ocupados
 * bloquean SUS horarios en la agenda y las citas que se le asignan aparecen en SU calendario. Si una cita se reasigna, se
 * quita del calendario de la persona anterior. Usa los mismos permisos (OAuth) que el calendario de la cuenta.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { getAppointment, getSettings, isVideoCall, scheduleJob } from '../automation/store.js';
import * as google from './google.js';
import * as outlook from './outlook.js';

export type Provider = 'google' | 'outlook';

export interface StaffCalendar {
  user_id: string;
  account_id: string;
  provider: Provider;
  email: string;
  refresh_token: string;
  calendar_id: string;
  block_busy: boolean;
  last_error: string;
  connected_at: Date;
}

/** «state» de OAuth para una persona: se distingue del de la cuenta por el prefijo. */
export const STATE_PREFIX = 'u_';

export const getStaffCalendar = (userId: string) => queryOne<StaffCalendar>('SELECT * FROM staff_calendars WHERE user_id = $1', [userId]);
export const listStaffCalendars = (accountId: string) => query<StaffCalendar>('SELECT * FROM staff_calendars WHERE account_id = $1', [accountId]);

/** Lo que el panel puede ver del calendario de una persona (sin el permiso guardado). */
export const publicView = (c: StaffCalendar | null) =>
  c ? { connected: true, provider: c.provider, email: c.email, block_busy: c.block_busy, last_error: c.last_error, connected_at: c.connected_at } : { connected: false };

const key = (userId: string) => `u:${userId}`;
const googleAuth = (c: StaffCalendar): google.GoogleAuth => ({ key: key(c.user_id), refresh_token: c.refresh_token, calendar_id: c.calendar_id });
const outlookAuth = (c: StaffCalendar): outlook.OutlookAuth => ({
  key: key(c.user_id),
  refresh_token: c.refresh_token,
  saveRefresh: (enc) => query('UPDATE staff_calendars SET refresh_token = $2 WHERE user_id = $1', [c.user_id, enc]),
});

async function markError(userId: string, message: string) {
  await query('UPDATE staff_calendars SET last_error = $2 WHERE user_id = $1', [userId, message.slice(0, 300)]);
}

export function authUrl(provider: Provider, userId: string, nonce: string) {
  return provider === 'google' ? google.authUrl(`${STATE_PREFIX}${userId}`, nonce) : outlook.authUrl(`${STATE_PREFIX}${userId}`, nonce);
}

/** Termina la conexión de la persona: guarda su permiso (reemplaza el calendario que tuviera) y copia sus citas futuras. */
export async function connectStaff(provider: Provider, userId: string, code: string) {
  const user = await queryOne<{ account_id: string | null; name: string }>('SELECT account_id, name FROM users WHERE id = $1', [userId]);
  if (!user?.account_id) throw new Error('La persona no pertenece a una cuenta');
  const previous = await getStaffCalendar(userId);
  let refresh: string;
  let email: string;
  if (provider === 'google') ({ refresh, email } = await google.exchangeCode(code));
  else {
    const r = await outlook.exchangeCode(code);
    ({ refresh, email } = r);
    outlook.rememberToken(key(userId), r.access);
  }
  if (previous?.provider === 'google' && provider !== 'google') await google.revoke(previous.refresh_token);
  if (provider === 'google') google.forgetToken(key(userId));
  await query(
    `INSERT INTO staff_calendars (user_id, account_id, provider, email, refresh_token) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET provider = $3, email = $4, refresh_token = $5, calendar_id = 'primary', last_error = '', connected_at = now()`,
    [userId, user.account_id, provider, email, refresh],
  );
  busyCache.delete(userId);
  // Lo que ya estaba en otro calendario de esta persona se queda ahí; se copian sus citas al calendario nuevo.
  if (previous && previous.provider !== provider) await query('UPDATE appointments SET staff_event_id = NULL, staff_event_provider = NULL, staff_event_user_id = NULL WHERE staff_event_user_id = $1', [userId]);
  await logEvent({ level: 'info', source: 'admin', message: `${user.name || 'Una persona del equipo'} conectó su calendario de ${provider === 'google' ? 'Google' : 'Outlook'}${email ? ` (${email})` : ''}`, accountId: user.account_id });
  const rows = await query<{ id: string }>(
    `SELECT id FROM appointments WHERE assigned_user_id = $1 AND status = 'confirmed' AND starts_at > now() AND source <> 'simulador'`,
    [userId],
  );
  for (const r of rows) await queueStaffSync(user.account_id, r.id);
}

/** Desconecta: los eventos ya creados se quedan en su calendario; Google además retira el permiso. */
export async function disconnectStaff(userId: string) {
  const c = await getStaffCalendar(userId);
  if (!c) return;
  if (c.provider === 'google') await google.revoke(c.refresh_token);
  await query('DELETE FROM staff_calendars WHERE user_id = $1', [userId]);
  await query('UPDATE appointments SET staff_event_id = NULL, staff_event_provider = NULL, staff_event_user_id = NULL WHERE staff_event_user_id = $1', [userId]);
  google.forgetToken(key(userId));
  outlook.forgetToken(key(userId));
  busyCache.delete(userId);
}

export async function setBlockBusy(userId: string, blockBusy: boolean) {
  const r = await query('UPDATE staff_calendars SET block_busy = $2 WHERE user_id = $1 RETURNING 1', [userId, blockBusy]);
  busyCache.delete(userId);
  return r.length > 0;
}

/* ------------------------------ Horarios ocupados ------------------------------ */

const busyCache = new Map<string, { at: number; from: number; to: number; rows: { starts_at: Date; ends_at: Date }[] }>();

/** Horas ocupadas en el calendario de cada persona (60 s en caché). Si un calendario falla, no bloquea nada de esa persona. */
export async function staffBusy(userIds: string[], from: Date, to: Date): Promise<{ user_id: string; starts_at: Date; ends_at: Date }[]> {
  if (!userIds.length) return [];
  const cals = await query<StaffCalendar>('SELECT * FROM staff_calendars WHERE user_id = ANY($1::uuid[]) AND block_busy', [userIds]);
  const lists = await Promise.all(cals.map(async (c) => {
    const hit = busyCache.get(c.user_id);
    let rows = hit && Date.now() - hit.at < 60_000 && hit.from <= from.getTime() && hit.to >= to.getTime() ? hit.rows : null;
    if (!rows) {
      try {
        // Se pide un margen amplio para reutilizar la respuesta entre llamadas cercanas.
        const f = new Date(Math.min(from.getTime(), Date.now()));
        const t = new Date(Math.max(to.getTime(), Date.now() + 15 * 86400_000));
        rows = c.provider === 'google' ? await google.freeBusy(googleAuth(c), f, t) : await outlook.calendarBusyTimes(outlookAuth(c), f, t);
        busyCache.set(c.user_id, { at: Date.now(), from: f.getTime(), to: t.getTime(), rows });
        if (c.last_error) await markError(c.user_id, '');
      } catch (e: any) {
        await markError(c.user_id, e.message).catch(() => undefined);
        rows = [];
      }
    }
    return rows.filter((b) => b.starts_at < to && b.ends_at > from).map((b) => ({ user_id: c.user_id, ...b }));
  }));
  return lists.flat();
}

/* ------------------------------ Citas en el calendario de la persona ------------------------------ */

export const queueStaffSync = (accountId: string, appointmentId: string) =>
  scheduleJob({ account_id: accountId, type: 'staff_cal_sync', payload: { appointment_id: appointmentId }, run_at: new Date(), dedupe_key: `staffcal:${appointmentId}` });

/** Solo encola si la cita tiene (o tuvo) una persona con calendario conectado. */
export async function syncStaffIfLinked(accountId: string, appointmentId: string) {
  const hit = await queryOne(
    `SELECT 1 FROM appointments a WHERE a.id = $1
       AND (a.staff_event_id IS NOT NULL OR EXISTS (SELECT 1 FROM staff_calendars c WHERE c.user_id = a.assigned_user_id))`,
    [appointmentId],
  );
  if (hit) await queueStaffSync(accountId, appointmentId);
}

/**
 * Tarea: deja el calendario de la persona igual a la cita. Si se canceló o se reasignó, se quita del calendario de quien
 * la tenía; si está confirmada, se crea o actualiza en el de la persona asignada. Los errores reintentan.
 */
export async function syncStaffEvent(payload: { appointment_id: string }) {
  if (config.outbound.mode === 'sandbox') return;
  const a = await getAppointment(payload.appointment_id);
  if (!a) return;
  const row = await queryOne<{ staff_event_id: string | null; staff_event_provider: Provider | null; staff_event_user_id: string | null }>(
    'SELECT staff_event_id, staff_event_provider, staff_event_user_id FROM appointments WHERE id = $1',
    [a.id],
  );
  const want = a.status === 'confirmed' && a.source !== 'simulador' ? a.assigned_user_id : null;
  let eventId = row?.staff_event_id ?? null;
  if (eventId && row?.staff_event_user_id && row.staff_event_user_id !== want) {
    const old = await getStaffCalendar(row.staff_event_user_id);
    if (old && old.provider === row.staff_event_provider) {
      try {
        if (old.provider === 'google') await google.deleteEvent(googleAuth(old), eventId);
        else await outlook.deleteEvent(outlookAuth(old), eventId);
      } catch (e: any) {
        await markError(old.user_id, e.message);
        throw e;
      }
    }
    await query('UPDATE appointments SET staff_event_id = NULL, staff_event_provider = NULL, staff_event_user_id = NULL WHERE id = $1', [a.id]);
    eventId = null;
  }
  if (!want) return;
  const cal = await getStaffCalendar(want);
  if (!cal) return;
  if (row?.staff_event_provider && row.staff_event_provider !== cal.provider) eventId = null;
  try {
    // Videollamada: la sala (Meet o Teams) sale del calendario de la persona que la atiende.
    const conference = await isVideoCall(a);
    const ev = cal.provider === 'google'
      ? await google.upsertEvent(googleAuth(cal), eventId, a, (await getSettings(a.account_id)).timezone, { conference })
      : await outlook.upsertEvent(outlookAuth(cal), eventId, a, { conference });
    await query(
      `UPDATE appointments SET staff_event_id = $2, staff_event_provider = $3, staff_event_user_id = $4,
         meeting_url = CASE WHEN $5 <> '' AND (meeting_url = '' OR staff_event_user_id IS DISTINCT FROM $4) THEN $5 ELSE meeting_url END
       WHERE id = $1`, [a.id, ev.id, cal.provider, want, ev.meetingUrl]);
    if (cal.last_error) await markError(cal.user_id, '');
  } catch (e: any) {
    await markError(cal.user_id, e.message);
    throw e;
  }
}
