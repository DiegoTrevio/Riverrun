import { DAYS, type Day, type WeeklyHours } from './types.js';

/** Fecha/hora "de pared" en una zona horaria. */
export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  day: Day;
  minutes: number; // minutos desde medianoche
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, Day> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

export function localParts(date: Date, tz: string): LocalParts {
  const p = Object.fromEntries(fmt(tz).formatToParts(date).map((x) => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hh}:${p.minute}`,
    day: WEEKDAY[p.weekday],
    minutes: Number(hh) * 60 + Number(p.minute),
  };
}

/** Diferencia (minutos) entre la hora local de `tz` y UTC en un instante. */
function offsetMinutes(date: Date, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour === '24' ? 0 : p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Convierte una fecha y hora locales de `tz` al instante UTC correspondiente (maneja horario de verano). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMinutes(new Date(guess), tz);
  let result = guess - off1 * 60000;
  const off2 = offsetMinutes(new Date(result), tz);
  if (off2 !== off1) result = guess - off2 * 60000;
  return new Date(result);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dayOf(date: string): Day {
  const [y, m, d] = date.split('-').map(Number);
  return DAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMinutes = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** ¿El negocio está abierto en ese instante? */
export function isOpen(hours: WeeklyHours, holidays: string[], at: Date, tz: string): boolean {
  const lp = localParts(at, tz);
  if (holidays.includes(lp.date)) return false;
  return (hours[lp.day] ?? []).some(([s, e]) => lp.minutes >= toMinutes(s) && lp.minutes < toMinutes(e));
}

/** Siguiente instante en que el negocio está abierto (el mismo si ya lo está). */
export function nextOpen(hours: WeeklyHours, holidays: string[], at: Date, tz: string): Date {
  if (isOpen(hours, holidays, at, tz)) return at;
  const lp = localParts(at, tz);
  for (let i = 0; i < 21; i++) {
    const date = addDays(lp.date, i);
    if (holidays.includes(date)) continue;
    const windows = [...(hours[dayOf(date)] ?? [])].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
    for (const [s] of windows) {
      if (i === 0 && toMinutes(s) <= lp.minutes) continue;
      return zonedToUtc(date, s, tz);
    }
  }
  return at; // sin horario definido: no se retrasa
}

/** Primera ocurrencia de la hora `hhmm` (local) en o después de `after`. */
export function nextTimeOfDay(after: Date, hhmm: string, tz: string): Date {
  const lp = localParts(after, tz);
  const today = zonedToUtc(lp.date, hhmm, tz);
  return today.getTime() >= after.getTime() ? today : zonedToUtc(addDays(lp.date, 1), hhmm, tz);
}

const DIAS = { mon: 'lunes', tue: 'martes', wed: 'miércoles', thu: 'jueves', fri: 'viernes', sat: 'sábado', sun: 'domingo' } as const;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "lunes 29 de septiembre" */
export function spanishDate(at: Date, tz: string) {
  const lp = localParts(at, tz);
  const [, m, d] = lp.date.split('-').map(Number);
  return `${DIAS[lp.day]} ${d} de ${MESES[m - 1]}`;
}

/** "10:00" */
export function spanishTime(at: Date, tz: string) {
  return localParts(at, tz).time;
}

/** Clave de horario que ve la IA: "2026-09-29T10:00" (hora local). */
export function slotKey(at: Date, tz: string) {
  const lp = localParts(at, tz);
  return `${lp.date}T${lp.time}`;
}
