/**
 * Outlook (Microsoft 365 y Outlook.com, por Microsoft Graph): igual que Google Calendar, las citas de la agenda se copian
 * como eventos al calendario de la cuenta (un solo sentido) y, si así se configura, los eventos «ocupado» de ese
 * calendario bloquean horarios para que el bot no los ofrezca. Las URL base se pueden cambiar por entorno para probar con
 * un servidor falso.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { decryptSecret, encryptSecret, hmac, safeEqual } from '../secret.js';
import { getAppointment, scheduleJob } from '../automation/store.js';
import type { Appointment } from '../automation/types.js';

const LOGIN_URL = () => (process.env.MICROSOFT_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');
const GRAPH_URL = () => (process.env.MICROSOFT_GRAPH_URL || 'https://graph.microsoft.com').replace(/\/$/, '');
/** «common»: cuentas de trabajo (Microsoft 365) y personales (Outlook.com, Hotmail). Una empresa puede fijar su tenant. */
const TENANT = () => process.env.MICROSOFT_TENANT || 'common';
const SCOPE = 'offline_access openid email User.Read Calendars.ReadWrite';

export const outlookConfigured = () => Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
export const redirectUri = () => `${config.publicBaseUrl}/oauth/outlook/callback`;

export interface OutlookLink {
  account_id: string;
  email: string;
  refresh_token: string;
  block_busy: boolean;
  last_error: string;
  connected_at: Date;
}

export const getLink = (accountId: string) => queryOne<OutlookLink>(`SELECT * FROM outlook_calendar WHERE account_id = $1`, [accountId]);

/** "state" lleva la cuenta, un valor aleatorio (también en una cookie del navegador que inició la conexión) y una firma; caduca a los 15 minutos. */
export function makeState(accountId: string, nonce: string, now = Date.now()) {
  const body = `${accountId}.${now + 15 * 60_000}.${nonce}`;
  return `${body}.${hmac(`ostate:${body}`)}`;
}
export function readState(state: string, nonce: string, now = Date.now()): string | null {
  const parts = state.split('.');
  if (parts.length !== 4 || !nonce) return null;
  const body = parts.slice(0, 3).join('.');
  if (!safeEqual(parts[3], hmac(`ostate:${body}`)) || !safeEqual(parts[2], nonce) || Number(parts[1]) < now) return null;
  return parts[0];
}

export function authUrl(accountId: string, nonce: string) {
  const p = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID ?? '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPE,
    prompt: 'select_account',
    state: makeState(accountId, nonce),
  });
  return `${LOGIN_URL()}/${TENANT()}/oauth2/v2.0/authorize?${p}`;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(`${LOGIN_URL()}/${TENANT()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID ?? '', client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? '', scope: SCOPE, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(data.error_description?.split('\r\n')[0] || data.error || `Microsoft respondió ${r.status}`);
  return data as { access_token: string; refresh_token?: string; expires_in: number };
}

/** Canjea el código de autorización: permiso permanente (cifrado), el correo y un acceso ya listo para usar. */
export async function exchangeCode(code: string): Promise<{ refresh: string; email: string; access: { token: string; exp: number } }> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error('Microsoft no entregó permiso permanente; vuelve a conectar y acepta todos los permisos');
  let email = '';
  try {
    const me = await graph(t.access_token, 'GET', '/v1.0/me?$select=mail,userPrincipalName');
    email = me.data?.mail || me.data?.userPrincipalName || '';
  } catch {
    /* sin correo */
  }
  return { refresh: encryptSecret(t.refresh_token), email, access: { token: t.access_token, exp: Date.now() + t.expires_in * 1000 } };
}

/** Termina la conexión: canjea el código, guarda el permiso cifrado y copia las citas futuras que ya existían. */
export async function connect(accountId: string, code: string) {
  const { refresh, email, access } = await exchangeCode(code);
  await query(
    `INSERT INTO outlook_calendar (account_id, email, refresh_token) VALUES ($1,$2,$3)
     ON CONFLICT (account_id) DO UPDATE SET email = $2, refresh_token = $3, last_error = '', connected_at = now()`,
    [accountId, email, refresh],
  );
  tokenCache.set(accountId, access);
  busyCache.delete(accountId);
  await logEvent({ level: 'info', source: 'admin', message: `Outlook conectado${email ? ` (${email})` : ''}`, accountId });
  const rows = await query<{ id: string }>(`SELECT id FROM appointments WHERE account_id = $1 AND status = 'confirmed' AND starts_at > now() AND outlook_event_id IS NULL AND source <> 'simulador'`, [accountId]);
  for (const r of rows) await queueSync(accountId, r.id);
}

/**
 * Desconecta: se borra el permiso guardado y los eventos ya creados se quedan en el calendario. Microsoft no ofrece revocar
 * un solo permiso desde aquí; quien quiera retirarlo del todo lo hace en su cuenta de Microsoft (Aplicaciones y servicios).
 */
export async function disconnect(accountId: string) {
  await query(`DELETE FROM outlook_calendar WHERE account_id = $1`, [accountId]);
  await query(`UPDATE appointments SET outlook_event_id = NULL WHERE account_id = $1`, [accountId]);
  busyCache.delete(accountId);
  tokenCache.delete(accountId);
}

/**
 * Un calendario de Outlook conectado: el de la cuenta o el de una persona del equipo. `key` distingue su caché y
 * `saveRefresh` guarda el permiso nuevo que Microsoft puede entregar al renovar.
 */
export interface OutlookAuth {
  key: string;
  refresh_token: string;
  saveRefresh(encrypted: string): Promise<unknown>;
}

const tokenCache = new Map<string, { token: string; exp: number }>();
async function accessToken(link: OutlookAuth) {
  const hit = tokenCache.get(link.key);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const refresh = decryptSecret(link.refresh_token);
  if (!refresh) throw new Error('No se pudo leer el permiso guardado; vuelve a conectar Outlook');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  // Microsoft puede entregar un permiso nuevo en cada renovación: se guarda para no perderlo cuando el anterior caduque.
  if (t.refresh_token && t.refresh_token !== refresh) await link.saveRefresh(encryptSecret(t.refresh_token));
  tokenCache.set(link.key, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}
export const rememberToken = (key: string, access: { token: string; exp: number }) => tokenCache.set(key, access);
export const forgetToken = (key: string) => tokenCache.delete(key);
const auth = (link: OutlookLink): OutlookAuth => ({
  key: link.account_id,
  refresh_token: link.refresh_token,
  saveRefresh: (enc) => query(`UPDATE outlook_calendar SET refresh_token = $2 WHERE account_id = $1`, [link.account_id, enc]),
});

async function graph(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(path.startsWith('http') ? path : `${GRAPH_URL()}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, ok: r.ok, data };
}
const api = async (link: OutlookAuth, method: string, path: string, body?: unknown, headers?: Record<string, string>) => graph(await accessToken(link), method, path, body, headers);
const graphError = (r: { status: number; data: any }) => r.data?.error?.message || `Microsoft respondió ${r.status}`;

async function markError(accountId: string, message: string) {
  await query(`UPDATE outlook_calendar SET last_error = $2 WHERE account_id = $1`, [accountId, message.slice(0, 300)]);
}

export const queueSync = (accountId: string, appointmentId: string) =>
  scheduleJob({ account_id: accountId, type: 'outlook_sync', payload: { appointment_id: appointmentId }, run_at: new Date(), dedupe_key: `outlook:${appointmentId}` });

/** Solo encola si la cuenta tiene Outlook conectado. */
export async function syncIfLinked(accountId: string, appointmentId: string) {
  if (await getLink(accountId)) await queueSync(accountId, appointmentId);
}

/** Hora para Graph: en UTC y sin zona en el texto (la zona va aparte). */
const graphTime = (d: Date) => ({ dateTime: new Date(d).toISOString().replace(/Z$/, ''), timeZone: 'UTC' });

/** Tarea: deja el evento de Outlook igual a la cita (crea, actualiza o borra). Los errores reintentan por el planificador. */
export async function syncAppointment(payload: { appointment_id: string }) {
  // Sandbox: no se crean citas en un calendario real desde staging.
  if (config.outbound.mode === 'sandbox') return;
  const a = await getAppointment(payload.appointment_id);
  if (!a) return;
  const link = await getLink(a.account_id);
  if (!link) return;
  const eventId = (await queryOne<{ outlook_event_id: string | null }>(`SELECT outlook_event_id FROM appointments WHERE id = $1`, [a.id]))?.outlook_event_id;
  try {
    if (a.status !== 'confirmed') {
      if (eventId) {
        await deleteEvent(auth(link), eventId);
        await query(`UPDATE appointments SET outlook_event_id = NULL WHERE id = $1`, [a.id]);
      }
    } else {
      const id = await upsertEvent(auth(link), eventId ?? null, a);
      await query(`UPDATE appointments SET outlook_event_id = $2 WHERE id = $1`, [a.id, id]);
    }
    if (link.last_error) await markError(a.account_id, '');
  } catch (e: any) {
    await markError(a.account_id, e.message);
    throw e;
  }
}

type EventSource = Pick<Appointment, 'id' | 'service_name' | 'customer_name' | 'customer_phone' | 'notes' | 'starts_at' | 'ends_at'>;

/** Crea o actualiza el evento de la cita. Devuelve su id. */
export async function upsertEvent(link: OutlookAuth, eventId: string | null, a: EventSource): Promise<string> {
  const event = {
    subject: `${a.service_name}${a.customer_name ? ` · ${a.customer_name}` : ''}`,
    body: { contentType: 'text', content: [a.customer_phone && `Teléfono: +${a.customer_phone.replace(/^\+/, '')}`, a.notes, 'Agendada desde Riverrun'].filter(Boolean).join('\n') },
    start: graphTime(a.starts_at),
    end: graphTime(a.ends_at),
    showAs: 'busy',
    // Si Outlook recibe dos veces la misma cita (un reintento), no la duplica.
    transactionId: `riverrun-${a.id}`,
  };
  let r = eventId ? await api(link, 'PATCH', `/v1.0/me/events/${encodeURIComponent(eventId)}`, event) : null;
  if (!r || r.status === 404 || r.status === 410) r = await api(link, 'POST', '/v1.0/me/events', event);
  if (!r.ok) throw new Error(graphError(r));
  return r.data.id ?? eventId;
}

/** Quita el evento (si ya no existía, no es error). */
export async function deleteEvent(link: OutlookAuth, eventId: string) {
  const r = await api(link, 'DELETE', `/v1.0/me/events/${encodeURIComponent(eventId)}`);
  if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(graphError(r));
}

/** Horas ocupadas del calendario entre dos fechas (sin caché). */
export async function calendarBusyTimes(link: OutlookAuth, f: Date, t: Date): Promise<{ starts_at: Date; ends_at: Date }[]> {
  const rows: { starts_at: Date; ends_at: Date }[] = [];
  let next: string | null = `/v1.0/me/calendarView?${new URLSearchParams({ startDateTime: f.toISOString(), endDateTime: t.toISOString(), $select: 'start,end,showAs,isCancelled', $top: '200' })}`;
  // Hasta 10 páginas (2,000 eventos en el periodo): más que suficiente para una agenda.
  for (let page = 0; next && page < 10; page++) {
    const r = await api(link, 'GET', next, undefined, { prefer: 'outlook.timezone="UTC"' });
    if (!r.ok) throw new Error(graphError(r));
    for (const e of (r.data.value ?? []) as { start: { dateTime: string }; end: { dateTime: string }; showAs: string; isCancelled?: boolean }[]) {
      // «Libre» y «trabajando en otro lugar» no ocupan; tentativo, ocupado y fuera de la oficina sí.
      if (e.isCancelled || e.showAs === 'free' || e.showAs === 'workingElsewhere') continue;
      rows.push({ starts_at: new Date(`${e.start.dateTime.replace(/Z$/, '')}Z`), ends_at: new Date(`${e.end.dateTime.replace(/Z$/, '')}Z`) });
    }
    next = r.data['@odata.nextLink'] ?? null;
  }
  return rows;
}

const busyCache = new Map<string, { at: number; from: number; to: number; rows: { starts_at: Date; ends_at: Date }[] }>();

/** Horas ocupadas del calendario de Outlook (guardadas 60 s). Si falla, no bloquea nada (la agenda sigue funcionando). */
export async function outlookBusy(accountId: string, from: Date, to: Date): Promise<{ starts_at: Date; ends_at: Date }[]> {
  const link = await getLink(accountId);
  if (!link || !link.block_busy) return [];
  const hit = busyCache.get(accountId);
  if (hit && Date.now() - hit.at < 60_000 && hit.from <= from.getTime() && hit.to >= to.getTime()) return hit.rows;
  try {
    // Se pide un margen amplio para reutilizar la respuesta entre llamadas cercanas.
    const f = new Date(Math.min(from.getTime(), Date.now()));
    const t = new Date(Math.max(to.getTime(), Date.now() + 15 * 86400_000));
    const rows = await calendarBusyTimes(auth(link), f, t);
    busyCache.set(accountId, { at: Date.now(), from: f.getTime(), to: t.getTime(), rows });
    if (link.last_error) await markError(accountId, '');
    return rows;
  } catch (e: any) {
    await markError(accountId, e.message).catch(() => undefined);
    return [];
  }
}
export const clearBusyCache = (accountId: string) => busyCache.delete(accountId);
