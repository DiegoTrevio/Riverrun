/**
 * Crea un chatbot de ejemplo (hotel) para probar desde el simulador del panel.
 * Uso: npm run seed:demo
 */
import { migrate, pool } from '../db.js';
import * as store from '../store/index.js';

await migrate();
const bot = await store.createChatbot({
  name: 'Hotel Las Palmas (demo)',
  active: false,
  evolution_instance: null,
  personality: {
    assistant_name: 'Sofía',
    prompt:
      'Trabajas en la recepción del Hotel Las Palmas en Cancún. Ayudas a los huéspedes a resolver dudas y a que reserven. ' +
      'Eres cálida y resolutiva. Cuando alguien muestra interés, guías la conversación hacia conocer sus fechas y número de personas.',
    tone: ['natural', 'cercano', 'mexicano'],
    response_length: 'corta',
    emojis: 'few',
  },
  rules: {
    unknown_info_behavior: 'say_unknown',
    allowed_topics: 'hotel, habitaciones, precios, servicios, ubicación, reservaciones, actividades cercanas mencionadas en la información',
    forbidden_topics: ['política', 'religión'],
    custom_rules: [
      'Nunca confirmes una reservación: solo una persona del equipo puede confirmarla.',
      'No ofrezcas descuentos que no estén en la información.',
      'Antes de hablar de disponibilidad, pregunta fechas y número de personas.',
    ],
    image_rules: 'Envía la foto de una habitación cuando el cliente pregunte por ella o muestre interés en verla.',
    handoff_rules: [
      'El cliente quiere confirmar o pagar una reservación',
      'El cliente tiene una queja o está molesto',
      'El cliente pide hablar con una persona',
    ],
  },
  data_fields: [
    { key: 'nombre', label: 'Nombre', type: 'name', required: true, ask_when: 'de forma natural al inicio o cuando quiera cotizar' },
    { key: 'fechas', label: 'Fechas de estancia', type: 'date', required: true, ask_when: 'cuando pregunte por precios o disponibilidad' },
    { key: 'personas', label: 'Número de personas', type: 'number', ask_when: 'junto con las fechas' },
    { key: 'habitacion', label: 'Tipo de habitación', type: 'option', options: ['Estándar', 'Doble', 'Suite'] },
    { key: 'correo', label: 'Correo', type: 'email', ask_when: 'cuando quiera reservar, para enviarle la confirmación' },
  ],
  flow: {
    goal: 'Que el cliente deje fechas, número de personas, tipo de habitación y correo para que el equipo confirme la reservación.',
    greeting: '¡Hola! Gracias por escribir al Hotel Las Palmas 🌴',
    steps: [
      { title: 'Resolver dudas', description: 'Responde lo que pregunte con la información del hotel.' },
      { title: 'Entender el viaje', description: 'Fechas y número de personas.' },
      { title: 'Recomendar habitación', description: 'Según personas y presupuesto; ofrece foto si aplica.' },
      { title: 'Cerrar', description: 'Pide nombre y correo y transfiere para confirmar.' },
    ],
    on_goal_completed: 'Agradece, resume los datos y transfiere a una persona para confirmar la reservación.',
  },
  ai: { debounce_seconds: 4 },
});

const knowledge = [
  ['general', 'Sobre el hotel', 'Hotel Las Palmas es un hotel boutique frente al mar en la Zona Hotelera de Cancún. 48 habitaciones. Alberca, restaurante y acceso directo a la playa.', true],
  ['ubicaciones', 'Dirección', 'Blvd. Kukulcán km 9.5, Zona Hotelera, Cancún, Quintana Roo. A 20 minutos del aeropuerto.', true],
  ['precios', 'Tarifas por noche (2025)', 'Habitación Estándar (hasta 2 personas): $1,450 MXN por noche.\nHabitación Doble (hasta 4 personas): $1,850 MXN por noche.\nSuite con jacuzzi y vista al mar (hasta 2 personas): $3,200 MXN por noche.\nLas tarifas incluyen impuestos. Persona extra: $350 MXN por noche.', false],
  ['horarios', 'Horarios', 'Check-in: 15:00. Check-out: 12:00. Restaurante: 7:00 a 22:00. Recepción 24 horas.', false],
  ['condiciones', 'Políticas', 'Se requiere anticipo del 30% para reservar. Cancelación sin costo hasta 72 horas antes de la llegada. Se aceptan mascotas pequeñas con cargo de $300 MXN por estancia. No se permite fumar en habitaciones.', false],
  ['servicios', 'Servicios incluidos', 'Wifi gratis, estacionamiento gratis, toallas de playa, café de cortesía por la mañana. El desayuno NO está incluido; el desayuno buffet cuesta $280 MXN por persona.', false],
  ['preguntas_frecuentes', '¿Tienen transporte al aeropuerto?', 'Sí, con costo: $650 MXN por trayecto para hasta 4 personas. Se reserva con 24 horas de anticipación.', false],
] as const;
for (const [i, [category, title, content, always]] of knowledge.entries()) {
  await store.upsertKnowledge(bot.id, { category, title, content, always_include: always, sort_order: i });
}
console.log(`Chatbot demo creado: ${bot.name} (${bot.id})`);
console.log('Sube 3 imágenes desde el panel (p.ej. habitacion_estandar, habitacion_doble, suite) y pruébalo en la pestaña "Probar".');
await pool.end();
