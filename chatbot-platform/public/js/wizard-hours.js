import { field, fill, h, text } from './core.js';

/* ------------------------------ Crear un agente: el horario, en un clic ------------------------------ */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo' };
const SAT_CLOSE = '14:00';

/** Días que abre cada opción. «Lunes a sábado»: el sábado cierra a las 14:00 (o antes, si así cierra entre semana). */
export const HOUR_PRESETS = [
  ['weekdays_sat', 'Lunes a sábado', 'El sábado, hasta las 2 de la tarde.'],
  ['weekdays', 'Lunes a viernes', 'Sábado y domingo cerrado.'],
  ['daily', 'Todos los días', null],
  ['always', 'Las 24 horas, todos los días', null],
];

/** Lo que se propone por tipo de negocio (se cambia con un clic). */
const BY_TYPE = {
  restaurante: ['daily', '12:00', '22:00'],
  hotel: ['always', '00:00', '23:59'],
  tienda: ['weekdays_sat', '10:00', '20:00'],
};

/** El horario empieza ya elegido: el que se leyó de su información o el típico de su tipo de negocio. */
export function suggestHours(w) {
  if (w.hours.mode === 'detected' && !w.hours.detected) w.hours.mode = '';
  if (w.hours.mode) return;
  if (w.hours.detected) { w.hours.mode = 'detected'; return; }
  const [mode, open, close] = BY_TYPE[w.company.business_type] || ['weekdays_sat', '09:00', '18:00'];
  Object.assign(w.hours, { mode, open, close });
}

/** Lo que se leyó de una fuente nueva: se propone, salvo que la persona ya haya elegido otra cosa. */
export function learnedHours(w, detected) {
  if (!detected) return;
  w.hours.detected = detected;
  if (!w.hours.picked) w.hours.mode = 'detected';
}

/** El horario semanal que se guarda en la cuenta (null = lo ajusta después). */
export function weeklyHours(hours) {
  const { mode, open, close } = hours;
  if (mode === 'detected') return hours.detected;
  if (mode === 'later' || !mode) return null;
  const all = (r) => Object.fromEntries(DAYS.map((d) => [d, r]));
  if (mode === 'always') return all([['00:00', '23:59']]);
  const day = [[open, close]];
  if (mode === 'daily') return all(day);
  const week = { ...all([]), mon: day, tue: day, wed: day, thu: day, fri: day };
  if (mode === 'weekdays') return week;
  const satClose = close < SAT_CLOSE ? close : SAT_CLOSE;
  return { ...week, sat: open < satClose ? [[open, satClose]] : [] };
}

/** Problema con las horas elegidas, en palabras del negocio (o null si están bien). */
export function hoursProblem(hours) {
  if (!['weekdays_sat', 'weekdays', 'daily'].includes(hours.mode)) return null;
  if (!/^\d{2}:\d{2}$/.test(hours.open || '') || !/^\d{2}:\d{2}$/.test(hours.close || '')) return 'Escribe a qué hora abres y a qué hora cierras.';
  return hours.open < hours.close ? null : 'La hora de cierre debe ser después de la de apertura.';
}

/** «Lunes a viernes 09:00 a 19:00 · Sábado 09:00 a 14:00 · Domingo cerrado»: días seguidos con el mismo horario, juntos. */
export function hoursSummary(weekly) {
  const label = (d) => (weekly[d] || []).map(([a, b]) => `${a} a ${b}`).join(' y ') || 'cerrado';
  const groups = [];
  for (const d of DAYS) {
    const last = groups[groups.length - 1];
    if (last && last.label === label(d)) last.to = d; else groups.push({ from: d, to: d, label: label(d) });
  }
  return groups.map((g) => `${DAY_NAMES[g.from]}${g.to !== g.from ? ` a ${DAY_NAMES[g.to].toLowerCase()}` : ''} ${g.label}`).join(' · ');
}

const option = (w, mode, title, help, draw) => h('label', { class: 'check plan-option' },
  h('input', { type: 'radio', name: 'agent-hours', checked: w.hours.mode === mode, onchange: () => { w.hours.mode = mode; w.hours.picked = true; draw(); } }),
  h('span', {}, h('strong', {}, title), help ? h('div', { class: 'small muted' }, help) : null));

/** Tarjeta «¿Cuándo atiendes?»: ya viene elegida; abrir y cerrar se ajustan sin salir del asistente. */
export function hoursCard(w) {
  suggestHours(w);
  const times = h('div');
  const card = h('fieldset', { class: 'field card' });
  const draw = () => fill(times, ['weekdays_sat', 'weekdays', 'daily'].includes(w.hours.mode)
    ? h('div', { class: 'grid' },
      field('Abre', text(w.hours, 'open', { type: 'time', step: 900 })),
      field('Cierra', text(w.hours, 'close', { type: 'time', step: 900 })))
    : null);
  fill(card,
    h('legend', {}, h('strong', {}, '¿Cuándo atiende tu negocio?')),
    h('p', { class: 'small muted', style: 'margin:0 0 8px' }, 'Tu agente lo dice cuando le preguntan y lo usa para saber cuándo hay alguien de tu equipo. Lo cambias cuando quieras en Horario y ajustes.'),
    w.hours.detected ? option(w, 'detected', 'Como lo leímos de tu información', hoursSummary(w.hours.detected), draw) : null,
    HOUR_PRESETS.map(([mode, title, help]) => option(w, mode, title, help, draw)),
    times,
    option(w, 'later', 'Lo ajusto después', 'Mientras tanto tu agente usa un horario de ejemplo: lunes a viernes de 9 a 6 y sábado de 9 a 2.', draw));
  draw();
  return card;
}
