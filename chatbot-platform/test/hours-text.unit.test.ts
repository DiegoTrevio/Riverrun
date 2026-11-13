/** Leer el horario como lo escribe la gente («Lunes a viernes de 9 a 7») para proponerlo en el asistente. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursFromText } from '../src/automation/hours-text.js';

const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
const week = (r: [string, string][]) => ({ mon: r, tue: r, wed: r, thu: r, fri: r });

test('lunes a viernes y sábado aparte, con «a» y la tarde sin «pm»', () => {
  assert.deepEqual(hoursFromText('Lunes a viernes de 9 a 7. Sábados de 9 a 2. Domingo cerrado.'), {
    ...closed, ...week([['09:00', '19:00']]), sat: [['09:00', '14:00']],
  });
});

test('horas con minutos, guion, «hrs» y am/pm', () => {
  assert.deepEqual(hoursFromText('Lun a Vie: 9:30-18:00 hrs\nSáb 10am a 2pm'), { ...closed, ...week([['09:30', '18:00']]), sat: [['10:00', '14:00']] });
  assert.deepEqual(hoursFromText('De lunes a sábado de 4 a 11 pm'), { ...closed, ...week([['16:00', '23:00']]), sat: [['16:00', '23:00']] });
});

test('días sueltos en lista toman el horario que sigue', () => {
  assert.deepEqual(hoursFromText('Lunes, miércoles y viernes de 10:00 a 15:00'), { ...closed, mon: [['10:00', '15:00']], wed: [['10:00', '15:00']], fri: [['10:00', '15:00']] });
});

test('dos franjas en un día (comida) y fines de semana', () => {
  assert.deepEqual(hoursFromText('Entre semana de 9 a 14 y de 16 a 20; fines de semana de 10 a 18'), {
    ...closed, ...week([['09:00', '14:00'], ['16:00', '20:00']]), sat: [['10:00', '18:00']], sun: [['10:00', '18:00']],
  });
});

test('todos los días, las 24 horas y «a medianoche»', () => {
  const all = (r: [string, string][]) => ({ mon: r, tue: r, wed: r, thu: r, fri: r, sat: r, sun: r });
  assert.deepEqual(hoursFromText('Abrimos todos los días de 1 pm a 10 pm'), all([['13:00', '22:00']]));
  assert.deepEqual(hoursFromText('Atendemos las 24 horas, todos los días'), all([['00:00', '23:59']]));
  assert.deepEqual(hoursFromText('Diario de 18 a 24 h'), all([['18:00', '23:59']]));
});

test('rango de días que da la vuelta (viernes a lunes)', () => {
  assert.deepEqual(hoursFromText('Viernes a lunes de 12 a 20'), { ...closed, fri: [['12:00', '20:00']], sat: [['12:00', '20:00']], sun: [['12:00', '20:00']], mon: [['12:00', '20:00']] });
});

test('si no se entiende, no se adivina: devuelve null', () => {
  for (const t of ['', 'Llámanos para conocer el horario', 'Abrimos temprano', 'Lunes a viernes', 'Lunes 25 a 99', 'De 9 a 6']) {
    assert.equal(hoursFromText(t), null, t);
  }
});

test('horas imposibles o al revés no cuentan', () => {
  assert.equal(hoursFromText('Lunes de 18:75 a 20'), null);
  assert.equal(hoursFromText('Sábado de 14:00 a 09:00 am'), null);
});

test('horario partido: la segunda franja sin am/pm es de la tarde', () => {
  const r: [string, string][] = [['08:00', '12:00'], ['14:00', '18:00']];
  assert.deepEqual(hoursFromText('Lunes a sábado de 8 a 12 y de 2 a 6'), { ...closed, ...week(r), sat: r });
});

test('«de la tarde», «de la noche» y «de la mañana»', () => {
  const all = (r: [string, string][]) => ({ mon: r, tue: r, wed: r, thu: r, fri: r, sat: r, sun: r });
  assert.deepEqual(hoursFromText('Todos los días de 8 de la mañana a 10 de la noche'), all([['08:00', '22:00']]));
  assert.deepEqual(hoursFromText('Lunes a viernes de 9 a 12 de la noche'), { ...closed, ...week([['09:00', '23:59']]) });
  assert.deepEqual(hoursFromText('Sábado de 4 a 9 de la tarde'), { ...closed, sat: [['16:00', '21:00']] });
});

test('fechas, teléfonos y direcciones no se leen como horas', () => {
  assert.deepEqual(hoursFromText('Lunes a viernes de 9 a 6. Vacaciones del 1 al 15 de diciembre'), { ...closed, ...week([['09:00', '18:00']]) });
  assert.deepEqual(hoursFromText('Lunes a viernes de 9 a 6, tel 81 2345 ext 3 a 5'), { ...closed, ...week([['09:00', '18:00']]) });
  assert.equal(hoursFromText('Av. Juárez 12 a 14, mar a vie'), null);
  // Pegado a los días sí es una hora.
  assert.deepEqual(hoursFromText('Mar-Vie 9-18'), { ...closed, tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']] });
});

test('una franja de madrugada sin am/pm es ambigua y no se propone', () => {
  assert.equal(hoursFromText('Lunes de 2 a 6'), null);
  assert.equal(hoursFromText('Viernes de 6 pm a 2 am'), null);
});
