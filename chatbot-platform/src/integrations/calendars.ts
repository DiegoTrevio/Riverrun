/**
 * Calendarios conectados de la cuenta (Google Calendar y Outlook), en un solo lugar para la agenda: las citas se copian a
 * todos los que estén conectados y los horarios ocupados de cualquiera de ellos no se ofrecen.
 */
import * as google from './google.js';
import * as outlook from './outlook.js';

/** Copia la cita (alta, cambio o cancelación) a cada calendario conectado. */
export async function syncCalendars(accountId: string, appointmentId: string) {
  await Promise.all([google.syncIfLinked(accountId, appointmentId), outlook.syncIfLinked(accountId, appointmentId)]);
}

/** Horarios ocupados en los calendarios conectados. Si uno falla, no bloquea nada de ese calendario (la agenda sigue). */
export async function calendarBusy(accountId: string, from: Date, to: Date) {
  const [g, o] = await Promise.all([google.googleBusy(accountId, from, to), outlook.outlookBusy(accountId, from, to)]);
  return [...g, ...o];
}
