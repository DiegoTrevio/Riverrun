import { config } from '../config.js';
import { beforeQuiet, inSendWindow, localParts, nextSendTime, sendableAt, toMinutes } from './time.js';
import type { AccountSettings, SendWindow } from './types.js';

/*
 * Horario para mensajes programados: lo que sale solo (flujos, campañas, reglas con espera, seguimientos y
 * recordatorios) no se manda de noche. Aquí se decide la hora al programarlo; al enviarlo lo vuelve a revisar
 * quiet-hold.ts (reintentos, atrasos después de una caída o un cambio de horario).
 */

/** El cliente escribió hace menos de esto: está conversando y lo programado sale aunque sea de noche. */
export const LIVE_CHAT_MS = 30 * 60_000;

const OFF: SendWindow = { enabled: false, start: '00:00', end: '23:59' };

/** El horario para mensajes programados de la cuenta (apagado si el servidor no lo aplica, como en las pruebas). */
export const windowOf = (s: AccountSettings): SendWindow => (config.sendWindow.enforced && s.sending.window.enabled ? s.sending.window : OFF);

/** Hasta cuánto se reparte lo que el horario movió, para que no salga todo en el mismo minuto por el mismo número. */
export const SPREAD_MS = 30 * 60_000;
/** Un desfase estable (el mismo para la misma llave), en minutos enteros, de 0 a `ms`. */
export function spreadOf(key: string, ms = SPREAD_MS) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % Math.max(1, Math.floor(ms / 60_000))) * 60_000;
}

/**
 * Cuándo puede salir algo programado para `at`: en horario del negocio (si se pide) y dentro del horario de envío. Si
 * el horario lo movió y hay `spreadKey`, se reparte en la media hora siguiente. `deadline`: la ventana de 24 h de Meta.
 */
export function sendTime(at: Date, s: AccountSettings, o: { businessOnly?: boolean; liveUntil?: Date | null; deadline?: Date | null; spreadKey?: string } = {}): Date {
  const w = windowOf(s);
  const t = nextSendTime(at, { window: w, tz: s.timezone, hours: o.businessOnly ? s.business_hours : null, holidays: s.holidays, liveUntil: o.liveUntil, deadline: o.deadline });
  if (!o.spreadKey || !w.enabled || t.getTime() <= at.getTime()) return t;
  const later = new Date(t.getTime() + spreadOf(o.spreadKey));
  return inSendWindow(w, later, s.timezone) && (!o.deadline || later.getTime() <= o.deadline.getTime()) ? later : t;
}

/** Ventana de 24 h de Meta (Messenger, Instagram, WhatsApp oficial): después de esto ya no se le puede escribir. */
export const windowDeadline = (needs24h: boolean, last: { created_at: Date | string } | null | undefined) =>
  needs24h && last ? new Date(new Date(last.created_at).getTime() + 24 * 3600_000) : null;

/**
 * La misma hora, dentro del horario de envío y sin cambiar de día: de madrugada pasa a la hora de inicio y de noche al
 * último minuto antes de que cierre. Para lo que va atado a una fecha (el recordatorio de «hoy vence»).
 */
export function sameDayTime(at: Date, s: AccountSettings, spreadKey = ''): Date {
  const w = windowOf(s);
  if (inSendWindow(w, at, s.timezone)) return at;
  const spread = spreadKey ? spreadOf(spreadKey) : 0;
  const edge = localParts(at, s.timezone).minutes < toMinutes(w.start) ? sendableAt(w, at, s.timezone) : beforeQuiet(w, at, s.timezone);
  const moved = new Date(edge.getTime() + (edge.getTime() > at.getTime() ? spread : -spread));
  return inSendWindow(w, moved, s.timezone) ? moved : edge;
}

/** Hasta cuándo se considera que el cliente está conversando, según su último mensaje. */
export const liveUntilOf = (last: { created_at: Date | string } | null | undefined) => (last ? new Date(new Date(last.created_at).getTime() + LIVE_CHAT_MS) : null);
