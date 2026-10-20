/**
 * Google Calendar: las citas de la agenda se copian como eventos al calendario del cliente (un solo sentido) y,
 * si así se configura, los eventos "ocupado" de ese calendario bloquean horarios para que el bot no los ofrezca.
 * Las URL base se pueden cambiar por entorno para probar con un servidor falso.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { decryptSecret, encryptSecret, hmac, safeEqual } from '../secret.js';
import { getAppointment, getSettings, isVideoCall, scheduleJob } from '../automation/store.js';
import type { Appointment } from '../automation/types.js';

const OAUTH_URL = () => (process.env.GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com').replace(/\/$/, '');
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const API_URL = () => (process.env.GOOGLE_API_URL || 'https://www.googleapis.com').replace(/\/$/, '');
const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy openid email';

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const redirectUri = () => `${config.publicBaseUrl}/oauth/google/callback`;

export interface GoogleLink {
  account_id: string;
  google_email: string;
  refresh_token: string;
  calendar_id: string;
  block_busy: boolean;
  last_error: string;
  connected_at: Date;
}

export const getLink = (accountId: string) => queryOne<GoogleLink>(`SELECT * FROM google_calendar WHERE account_id = $1`, [accountId]);

/** "state" lleva la cuenta, un valor aleatorio (que también va en una cookie del navegador que inició la conexión) y una firma; caduca a los 15 minutos. */
export function makeState(accountId: string, nonce: string, now = Date.now()) {
  const body = `${accountId}.${now + 15 * 60_000}.${nonce}`;
  return `${body}.${hmac(`gstate:${body}`)}`;
}
export function readState(state: string, nonce: string, now = Date.now()): string | null {
  const parts = state.split('.');
  if (parts.length !== 4 || !nonce) return null;
  const body = parts.slice(0, 3).join('.');
  if (!safeEqual(parts[3], hmac(`gstate:${body}`)) || !safeEqual(parts[2], nonce) || Number(parts[1]) < now) return null;
  return parts[0];
}

export function authUrl(accountId: string, nonce: string) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: makeState(accountId, nonce),
  });
  return `${AUTH_URL()}?${p}`;
}

export async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(`${OAUTH_URL()}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(data.error_description || data.error || `Google respondió ${r.status}`);
  return data as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
}

/** Canjea el código de autorización: permiso permanente (cifrado) y el correo de la cuenta de Google. */
export async function exchangeCode(code: string): Promise<{ refresh: string; email: string }> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error('Google no entregó permiso permanente; vuelve a conectar y acepta todos los permisos');
  let email = '';
  try {
    email = JSON.parse(Buffer.from((t.id_token ?? '').split('.')[1] ?? '', 'base64url').toString()).email ?? '';
  } catch {
    /* sin correo */
  }
  return { refresh: encryptSecret(t.refresh_token), email };
}

/** Retira el permiso en Google (si falla, se ignora: el permiso guardado se borra de todas formas). */
export async function revoke(encryptedRefresh: string) {
  const token = decryptSecret(encryptedRefresh);
  if (token) await fetch(`${OAUTH_URL()}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}

/** Termina la conexión: canjea el código y guarda el token cifrado. */
export async function connect(accountId: string, code: string) {
  const { refresh, email } = await exchangeCode(code);
  await query(
    `INSERT INTO google_calendar (account_id, google_email, refresh_token) VALUES ($1,$2,$3)
     ON CONFLICT (account_id) DO UPDATE SET google_email = $2, refresh_token = $3, last_error = '', connected_at = now()`,
    [accountId, email, refresh],
  );
  await logEvent({ level: 'info', source: 'admin', message: `Google Calendar conectado${email ? ` (${email})` : ''}`, accountId });
  tokenCache.delete(accountId); // otro Google = otro token; no reutilizar el anterior
  busyCache.delete(accountId);
  // Copia las citas futuras que ya existían.
  const rows = await query<{ id: string }>(`SELECT id FROM appointments WHERE account_id = $1 AND status = 'confirmed' AND starts_at > now() AND google_event_id IS NULL AND source <> 'simulador'`, [accountId]);
  for (const r of rows) await queueSync(accountId, r.id);
}

export async function disconnect(accountId: string) {
  const link = await getLink(accountId);
  if (!link) return;
  await revoke(link.refresh_token);
  await query(`DELETE FROM google_calendar WHERE account_id = $1`, [accountId]);
  await query(`UPDATE appointments SET google_event_id = NULL WHERE account_id = $1`, [accountId]);
  busyCache.delete(accountId);
  tokenCache.delete(accountId);
}

/** Un calendario de Google conectado: el de la cuenta o el de una persona del equipo (`key` distingue su caché). */
export interface GoogleAuth {
  key: string;
  refresh_token: string;
  calendar_id: string;
}

const tokenCache = new Map<string, { token: string; exp: number }>();
async function accessToken(link: GoogleAuth) {
  const hit = tokenCache.get(link.key);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const refresh = decryptSecret(link.refresh_token);
  if (!refresh) throw new Error('No se pudo leer el permiso guardado; vuelve a conectar Google Calendar');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  tokenCache.set(link.key, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}
export const forgetToken = (key: string) => tokenCache.delete(key);
const auth = (link: GoogleLink): GoogleAuth => ({ key: link.account_id, refresh_token: link.refresh_token, calendar_id: link.calendar_id });

async function api(link: GoogleAuth, method: string, path: string, body?: unknown) {
  const r = await fetch(`${API_URL()}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken(link)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, ok: r.ok, data };
}

async function markError(accountId: string, message: string) {
  await query(`UPDATE google_calendar SET last_error = $2 WHERE account_id = $1`, [accountId, message.slice(0, 300)]);
}

export const queueSync = (accountId: string, appointmentId: string) =>
  scheduleJob({ account_id: accountId, type: 'gcal_sync', payload: { appointment_id: appointmentId }, run_at: new Date(), dedupe_key: `gcal:${appointmentId}` });

/** Solo encola si la cuenta tiene Google conectado. */
export async function syncIfLinked(accountId: string, appointmentId: string) {
  if (await getLink(accountId)) await queueSync(accountId, appointmentId);
}

/** Tarea: deja el evento de Google igual a la cita (crea, actualiza o borra). Los errores reintentan por el planificador. */
export async function syncAppointment(payload: { appointment_id: string }) {
  // Sandbox: no se crean citas en un Google Calendar real desde staging.
  if (config.outbound.mode === 'sandbox') return;
  const a = await getAppointment(payload.appointment_id);
  if (!a) return;
  const link = await getLink(a.account_id);
  if (!link) return;
  const eventId = (await queryOne<{ google_event_id: string | null }>(`SELECT google_event_id FROM appointments WHERE id = $1`, [a.id]))?.google_event_id;
  try {
    if (a.status !== 'confirmed') {
      if (eventId) {
        await deleteEvent(auth(link), eventId);
        await query(`UPDATE appointments SET google_event_id = NULL WHERE id = $1`, [a.id]);
      }
    } else {
      // La sala de la videollamada sale del calendario de la persona; si la cita no tiene persona, del del negocio.
      const conference = !a.assigned_user_id && (await isVideoCall(a));
      const ev = await upsertEvent(auth(link), eventId ?? null, a, (await getSettings(a.account_id)).timezone, { conference });
      await query(`UPDATE appointments SET google_event_id = $2, meeting_url = CASE WHEN meeting_url = '' THEN $3 ELSE meeting_url END WHERE id = $1`, [a.id, ev.id, ev.meetingUrl]);
    }
    if (link.last_error) await markError(a.account_id, '');
  } catch (e: any) {
    await markError(a.account_id, e.message);
    throw e;
  }
}

export type EventSource = Pick<Appointment, 'id' | 'service_name' | 'customer_name' | 'customer_phone' | 'notes' | 'starts_at' | 'ends_at' | 'customer_email'>;

/**
 * Crea o actualiza el evento de la cita en el calendario. Con `conference`, Google crea el enlace de Google Meet de la
 * videollamada. Devuelve el id del evento y ese enlace (si hay).
 */
export async function upsertEvent(link: GoogleAuth, eventId: string | null, a: EventSource, tz: string, opts: { conference?: boolean } = {}): Promise<{ id: string; meetingUrl: string }> {
  const cal = `/calendar/v3/calendars/${encodeURIComponent(link.calendar_id)}/events`;
  const event = {
    summary: `${a.service_name}${a.customer_name ? ` · ${a.customer_name}` : ''}`,
    description: [a.customer_phone && `Teléfono: +${a.customer_phone.replace(/^\+/, '')}`, a.customer_email && `Correo: ${a.customer_email}`, a.notes, 'Agendada desde Riverrun'].filter(Boolean).join('\n'),
    start: { dateTime: new Date(a.starts_at).toISOString(), timeZone: tz },
    end: { dateTime: new Date(a.ends_at).toISOString(), timeZone: tz },
    extendedProperties: { private: { riverrun_appointment: a.id } },
    // Mismo requestId en cada actualización: Google no crea otra sala.
    ...(opts.conference ? { conferenceData: { createRequest: { requestId: `riverrun-${a.id}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };
  const q = opts.conference ? '?conferenceDataVersion=1' : '';
  let r = eventId ? await api(link, 'PUT', `${cal}/${encodeURIComponent(eventId)}${q}`, event) : null;
  if (!r || r.status === 404 || r.status === 410) r = await api(link, 'POST', `${cal}${q}`, event);
  if (!r.ok) throw new Error(r.data?.error?.message || `Google respondió ${r.status}`);
  const video = (r.data?.conferenceData?.entryPoints ?? []).find((e: any) => e?.entryPointType === 'video')?.uri;
  return { id: r.data.id, meetingUrl: String(r.data?.hangoutLink ?? video ?? '') };
}

/** Quita el evento (si ya no existía, no es error). */
export async function deleteEvent(link: GoogleAuth, eventId: string) {
  const r = await api(link, 'DELETE', `/calendar/v3/calendars/${encodeURIComponent(link.calendar_id)}/events/${encodeURIComponent(eventId)}`);
  if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(r.data?.error?.message || `Google respondió ${r.status}`);
}

/** Horas ocupadas del calendario entre dos fechas (sin caché). */
export async function freeBusy(link: GoogleAuth, from: Date, to: Date): Promise<{ starts_at: Date; ends_at: Date }[]> {
  const r = await api(link, 'POST', '/calendar/v3/freeBusy', { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: link.calendar_id }] });
  if (!r.ok) throw new Error(r.data?.error?.message || `Google respondió ${r.status}`);
  return ((r.data.calendars?.[link.calendar_id]?.busy ?? []) as { start: string; end: string }[]).map((b) => ({ starts_at: new Date(b.start), ends_at: new Date(b.end) }));
}

const busyCache = new Map<string, { at: number; from: number; to: number; rows: { starts_at: Date; ends_at: Date }[] }>();

/** Horas ocupadas del calendario de Google (guardadas 60 s). Si falla, no bloquea nada (la agenda sigue funcionando). */
export async function googleBusy(accountId: string, from: Date, to: Date): Promise<{ starts_at: Date; ends_at: Date }[]> {
  const link = await getLink(accountId);
  if (!link || !link.block_busy) return [];
  const hit = busyCache.get(accountId);
  if (hit && Date.now() - hit.at < 60_000 && hit.from <= from.getTime() && hit.to >= to.getTime()) return hit.rows;
  try {
    // Se pide un margen amplio para reutilizar la respuesta entre llamadas cercanas.
    const f = new Date(Math.min(from.getTime(), Date.now()));
    const t = new Date(Math.max(to.getTime(), Date.now() + 15 * 86400_000));
    const rows = await freeBusy(auth(link), f, t);
    busyCache.set(accountId, { at: Date.now(), from: f.getTime(), to: t.getTime(), rows });
    if (link.last_error) await markError(accountId, '');
    return rows;
  } catch (e: any) {
    await markError(accountId, e.message).catch(() => undefined);
    return [];
  }
}
export const clearBusyCache = (accountId: string) => busyCache.delete(accountId);
