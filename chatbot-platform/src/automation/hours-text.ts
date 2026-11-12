/**
 * Lee el horario tal como lo escribe la gente («Lunes a viernes de 9 a 7. Sábados de 9 a 2») y lo convierte en el
 * horario semanal de la cuenta. Sirve para proponerlo ya llenado en el asistente de creación: la persona lo ve y lo
 * confirma o lo cambia. Es deliberadamente conservador: si algo no se entiende, devuelve null en lugar de adivinar.
 */
import { DAYS, type Day, type WeeklyHours } from './types.js';

type Range = [string, string];

const DAY_WORDS: [RegExp, Day][] = [
  [/^lun/, 'mon'], [/^mar/, 'tue'], [/^mie/, 'wed'], [/^jue/, 'thu'], [/^vie/, 'fri'], [/^sab/, 'sat'], [/^dom/, 'sun'],
];
const DAY = '(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|lun|mar|mier|mie|jue|vie|sab|dom)\\.?';
const ALL = 'todos los dias|diario|diariamente|toda la semana|los 7 dias|7 dias a la semana';
const WEEKDAYS = 'entre semana|dias habiles|dias laborales';
const WEEKEND = 'fines? de semana';
const DAY_EXPR = new RegExp(`(${ALL})|(${WEEKDAYS})|(${WEEKEND})|\\b(${DAY})\\s*(?:a|al|-|–|hasta(?: el)?)\\s*(${DAY})(?![a-z])|\\b(${DAY})(?![a-z])`, 'g');

const SUFFIX = '(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?|hrs?\\.?|h|de la (?:manana|tarde|noche))?';
// 1: «de», «desde» o «las» antes · 2-4: apertura (hora, minutos, am/pm) · 5-7: cierre.
const TIME_RANGE = new RegExp(`(de(?:sde)?\\s+(?:las\\s+)?|las\\s+)?\\b(\\d{1,2})(?::(\\d{2}))?\\s*${SUFFIX}\\s*(?:a|al|-|–|hasta)\\s*(?:las\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*${SUFFIX}(?![a-z0-9])`, 'g');
const FULL_DAY = /\b24\s*(?:horas|hrs|h)\b/;
const CLOSED = /cerrad|descans|no abrimos|no atendemos/;

const normalize = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const dayOf = (word: string): Day | null => DAY_WORDS.find(([re]) => re.test(word))?.[1] ?? null;
const pad = (n: number) => String(n).padStart(2, '0');

/** Días de un rango, dando la vuelta si hace falta (viernes a lunes). */
function dayRange(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let i = DAYS.indexOf(from); ; i = (i + 1) % 7) {
    out.push(DAYS[i]);
    if (DAYS[i] === to || out.length === 7) return out;
  }
}

function daysOf(m: RegExpMatchArray): Day[] {
  if (m[1]) return [...DAYS];
  if (m[2]) return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (m[3]) return ['sat', 'sun'];
  if (m[4] && m[5]) {
    const a = dayOf(m[4]);
    const b = dayOf(m[5]);
    return a && b ? dayRange(a, b) : [];
  }
  const d = m[6] ? dayOf(m[6]) : null;
  return d ? [d] : [];
}

const isPm = (s?: string) => !!s && (s.startsWith('p') || /tarde|noche/.test(s));
const isAm = (s?: string) => !!s && (s.startsWith('a') || s.includes('manana'));
const EARLY = 7;

/**
 * Una franja «9 a 7», «9:30-18:00 hrs», «4 a 11 pm» u «8 de la mañana a 10 de la noche» en horas de 24, o null si no
 * tiene sentido o es ambigua. `prevEnd` es el cierre de la franja anterior del mismo día («de 8 a 12 y de 2 a 6»).
 */
function toRange(m: RegExpMatchArray, prevEnd: number | null): Range | null {
  let open = Number(m[2]);
  let close = Number(m[5]);
  const [om, cm] = [Number(m[3] ?? 0), Number(m[6] ?? 0)];
  const [os, cs] = [m[4], m[7]];
  if (om > 59 || cm > 59 || open > 24 || close > 24) return null;
  if (isPm(os) && open < 12) open += 12;
  if (isAm(os) && open === 12) open = 0;
  if (cs?.includes('noche') && close === 12) close = 24;
  else if (isPm(cs) && close < 12) close += 12;
  if (isAm(cs) && close === 12) close = 0;
  if (!os && !cs && open < EARLY && prevEnd !== null && open + 12 >= prevEnd) {
    // Segunda franja de un horario partido: «y de 2 a 6» es por la tarde.
    open += 12;
    close += close < 12 ? 12 : 0;
  } else if (!os && isPm(cs) && open < EARLY && open + 12 < close) {
    // «de 4 a 11 pm»: la apertura también es de la tarde.
    open += 12;
  } else if (!os && !cs && open < EARLY) {
    // «de 2 a 6» sin más: ¿madrugada o tarde? No se adivina.
    return null;
  }
  // «de 9 a 7»: sin am/pm, una hora de cierre menor es de la tarde.
  if (!cs && close <= open && close < 12) close += 12;
  if (open >= 24) return null;
  const end = close === 24 && cm === 0 ? '23:59' : close < 24 ? `${pad(close)}:${pad(cm)}` : null;
  const start = `${pad(open)}:${pad(om)}`;
  return end && start < end ? [start, end] : null;
}

/** ¿Es una hora y no una fecha, un teléfono o un número de calle? Lleva «de/las», minutos, am/pm o va pegada a los días. */
const looksLikeTime = (m: RegExpMatchArray, segment: string) =>
  !!(m[1] || m[3] || m[6] || m[4] || m[7]) || /^[\s:,.-]*$/.test(segment.slice(0, m.index));

/** Las franjas de un tramo de texto; «24 horas» es el día completo. */
function rangesIn(segment: string): Range[] {
  const ranges: Range[] = [];
  for (const m of segment.matchAll(TIME_RANGE)) {
    if (!looksLikeTime(m, segment)) continue;
    const prev = ranges.length ? Number(ranges[ranges.length - 1][1].slice(0, 2)) : null;
    const r = toRange(m, prev);
    if (r) ranges.push(r);
  }
  if (!ranges.length && FULL_DAY.test(segment)) return [['00:00', '23:59']];
  return ranges;
}

/**
 * Horario semanal a partir del texto. Cada grupo de días toma las horas que lo siguen; los días en lista («lunes,
 * miércoles y viernes de 10 a 3») comparten las horas que vienen después. Los días que no se mencionan quedan cerrados.
 */
export function hoursFromText(raw: string): WeeklyHours | null {
  const text = normalize(raw || '');
  const matches = [...text.matchAll(DAY_EXPR)];
  if (!matches.length) return null;
  const hours = Object.fromEntries(DAYS.map((d) => [d, [] as Range[]])) as WeeklyHours;
  const lead = rangesIn(text.slice(0, matches[0].index));
  let pending: Day[] = [];
  let found = false;
  matches.forEach((m, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const segment = text.slice(m.index! + m[0].length, end);
    pending = [...pending, ...daysOf(m)];
    const ranges = rangesIn(segment);
    if (ranges.length) {
      for (const d of pending) hours[d] = ranges;
      found = true;
      pending = [];
    } else if (CLOSED.test(segment)) {
      for (const d of pending) hours[d] = [];
      pending = [];
    }
  });
  // «Las 24 horas, todos los días»: las horas iban antes de los días.
  if (pending.length && lead.length) {
    for (const d of pending) hours[d] = lead;
    found = true;
  }
  return found ? hours : null;
}
