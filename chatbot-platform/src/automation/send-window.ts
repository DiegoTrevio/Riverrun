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

/** Cuándo puede salir algo programado para `at`: en horario del negocio (si se pide) y dentro del horario de envío. */
export function sendTime(at: Date, s: AccountSettings, o: { businessOnly?: boolean; liveUntil?: Date | null } = {}): Date {
  return nextSendTime(at, { window: windowOf(s), tz: s.timezone, hours: o.businessOnly ? s.business_hours : null, holidays: s.holidays, liveUntil: o.liveUntil });
}

/**
 * La misma hora, dentro del horario de envío y sin cambiar de día: de madrugada pasa a la hora de inicio y de noche al
 * último minuto antes de que cierre. Para lo que va atado a una fecha (el recordatorio de «hoy vence»).
 */
export function sameDayTime(at: Date, s: AccountSettings): Date {
  const w = windowOf(s);
  if (inSendWindow(w, at, s.timezone)) return at;
  return localParts(at, s.timezone).minutes < toMinutes(w.start) ? sendableAt(w, at, s.timezone) : beforeQuiet(w, at, s.timezone);
}

/** Hasta cuándo se considera que el cliente está conversando, según su último mensaje. */
export const liveUntilOf = (last: { created_at: Date | string } | null | undefined) => (last ? new Date(new Date(last.created_at).getTime() + LIVE_CHAT_MS) : null);
