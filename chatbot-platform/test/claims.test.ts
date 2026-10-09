/** Verificación de afirmaciones sin números contra el conocimiento (sin base de datos). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedClaims } from '../src/engine/claims.js';

const K = ['Hotel Palmas. Habitaciones dobles $1,200 por noche. Alberca climatizada abierta de 8 a 20. Desayuno incluido. Estacionamiento gratis. Aceptamos tarjeta y transferencia. Wi-Fi en todo el hotel. Check-in a las 15:00. Se permiten mascotas pequeñas.'];

const flagged: [string, string[]][] = [
  ['¡Hola! Sí, tenemos alberca y gimnasio.', ['gimnasio']],
  ['Ofrecemos servicio de spa y masajes.', ['masajes']],
  ['Aceptamos Bitcoin como forma de pago.', ['bitcoin']],
  ['Tenemos servicio de lavandería las 24 horas.', ['lavanderia']],
  ['Incluye desayuno buffet y cena.', ['cena']],
  ['Ofrecemos transporte al aeropuerto sin costo.', ['transporte aeropuerto']],
  ['Hay wifi en todo el hotel, y también hay jacuzzi.', ['jacuzzi']],
  ['Contamos con restaurante propio.', []], // "restaurante"≈cocina/comedor: sin respaldo en este texto → se verifica abajo
];

test('marca lo que el negocio afirma tener y no está en la información', () => {
  for (const [reply, want] of flagged.slice(0, -1)) assert.deepEqual(unsupportedClaims(reply, K), want, reply);
  assert.deepEqual(unsupportedClaims(flagged.at(-1)![0], K), ['restaurante propio']);
});

test('no marca lo respaldado, sus sinónimos ni lo que no es una afirmación', () => {
  const ok = [
    'Sí tenemos piscina para los huéspedes.',
    'Contamos con estacionamiento gratuito.',
    'El desayuno está incluido en la tarifa.',
    'No tenemos gimnasio, pero sí alberca.',
    '¿Tienen alberca?',
    'Aceptamos tarjetas de crédito y débito.',
    'Hay habitaciones dobles disponibles.',
    'Contamos con tu información y con gusto te ayudamos.',
    'Te confirmo con el equipo si hay disponibilidad.',
    'Tenemos mascotas permitidas.',
    'Si tuviéramos gimnasio te lo diría.',
    'Con gusto, te comparto los precios de las habitaciones.',
    'Hay internet en todo el hotel.',
    'Hola Ana, ¿en qué te puedo ayudar?',
  ];
  for (const reply of ok) assert.deepEqual(unsupportedClaims(reply, K), [], reply);
});

test('lo que dijo el cliente no sirve de respaldo (la fuente son solo los datos del negocio)', () => {
  // "¿tienen gimnasio?" está en la conversación, pero no en K: afirmarlo sigue siendo una invención.
  assert.deepEqual(unsupportedClaims('Sí, tenemos gimnasio.', K), ['gimnasio']);
  assert.deepEqual(unsupportedClaims('Sí, tenemos gimnasio.', [...K, 'Hay gimnasio equipado en el segundo piso.']), []);
});

test('varias afirmaciones en una respuesta, con listas y conjunciones', () => {
  assert.deepEqual(unsupportedClaims('Incluye desayuno, alberca, sauna y jacuzzi.', K), ['sauna', 'jacuzzi']);
  assert.deepEqual(unsupportedClaims('Ofrecemos desayuno y estacionamiento.', K), []);
});
