/** Agentes tipo para las pruebas del prompt (fotografía y estructura). Cada caso devuelve la entrada de buildContext. */
const { hydrateChatbot } = await import('../src/types.js');

export const NOW = new Date('2026-10-12T17:30:00Z');

/* ------------------------------ Agentes tipo ------------------------------ */

const field = (f: Record<string, unknown>) => ({ description: '', options: [], required: false, ask_when: '', question: '', branches: [], ...f });

const HOTEL = {
  id: 'bot-hotel', account_id: 'acc', name: 'Hotel Palmas', active: true, created_at: NOW, updated_at: NOW,
  personality: {
    assistant_name: 'Sofi', formality: 'tu', emojis: 'few', tone: ['cálido', 'profesional'], response_length: 'corta',
    prompt: 'Eres Sofi, la asistente del Hotel Palmas en Mazatlán. Ayuda a reservar habitaciones y resuelve dudas sobre el hotel. Sé cálida y breve. Si preguntan por eventos, envía el mensaje eventos. Cuando pregunten por la alberca, envía la foto alberca.',
    style_examples: ['¡Claro! La doble tiene vista al mar 🌊', 'Con gusto te ayudo con tu reserva.'],
  },
  rules: {
    allowed_topics: 'reservas, servicios del hotel y eventos',
    forbidden_topics: ['política', 'religión'],
    custom_rules: ['No ofrezcas descuentos.', 'Si preguntan por mascotas, di que se aceptan perros pequeños con cargo extra.'],
    handoff_rules: ['Si piden factura', 'Si quieren reservar más de 5 habitaciones'],
    max_images_per_reply: 2, image_rules: 'Envía fotos cuando ayuden a decidir.', avoid_repeating_images: true,
  },
  flow: {
    goal: 'Tomar la solicitud de reserva con nombre y fecha de llegada', greeting: '¡Hola! Soy Sofi del Hotel Palmas.',
    steps: [{ title: 'Saludo', description: 'Saluda y pregunta el motivo' }, { title: 'Fechas y huéspedes', description: '' }, { title: 'Cierre', description: 'Confirma la solicitud' }],
    on_goal_completed: 'Agradece y di que el equipo confirmará la disponibilidad.', on_goal_action: 'notify',
  },
  ai: { timezone: 'America/Mazatlan' },
  saved_messages: [
    { code: 'eventos', title: 'Eventos', text: 'Organizamos bodas y eventos para hasta 200 personas.', when: 'Si preguntan por eventos', image_id: '', flow_step: 0, active: true },
    { code: 'precios', title: 'Precios', text: 'Doble: $1,650 MXN por noche. Suite: $2,900 MXN por noche. Desayuno incluido.', when: 'Si preguntan precios', image_id: 'img-doble', flow_step: 2, active: true },
  ],
  data_fields: [
    field({ key: 'motivo', label: 'Motivo', type: 'option', options: ['Reservar', 'Informes'], required: true, question: '¿Vienes a reservar o quieres informes?', branches: [{ option: 'Informes', goto: 'end' }] }),
    field({ key: 'nombre', label: 'Nombre', type: 'name', required: true, question: '¿Cuál es tu nombre?' }),
    field({ key: 'fecha_llegada', label: 'Fecha de llegada', type: 'text', required: true, question: '¿Qué día llegas?' }),
    field({ key: 'huespedes', label: 'Huéspedes', type: 'number', required: false, question: '¿Cuántas personas se hospedan?' }),
    field({ key: 'correo', label: 'Correo', type: 'email', description: 'para enviar la confirmación', ask_when: 'al final' }),
  ],
};

const img = (id: string, code: string, name: string, send_when: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id, chatbot_id: 'bot-hotel', code, name, description: `Foto de ${name.toLowerCase()}`, caption: '', usage_rule: '', active: true, send_when, ...extra });
const IMAGES = [
  img('img-alberca', 'alberca', 'Alberca', { mode: 'ai' }, { usage_rule: 'Cuando pregunten por la alberca' }),
  img('img-doble', 'doble', 'Habitación doble', { mode: 'ai' }),
  img('img-bienvenida', 'bienvenida', 'Bienvenida', { mode: 'rules', first_message: true }),
  img('img-mapa', 'mapa', 'Mapa', { mode: 'both', flow_steps: [3], context: 'Cuando el cliente pregunte cómo llegar' }),
  img('img-comparacion', 'comparacion', 'Comparación de habitaciones', { mode: 'rules', context: 'Cuando el cliente necesite comparar habitaciones' }),
] as any[];
const KNOWLEDGE = [
  { id: 'k1', chatbot_id: 'bot-hotel', title: 'Tarifas', category: 'precios', content: 'Habitación doble: $1,650 MXN por noche. Suite: $2,900 MXN por noche. Desayuno incluido.', active: true },
  { id: 'k2', chatbot_id: 'bot-hotel', title: 'Servicios', category: 'general', content: 'Alberca de 8:00 a 20:00. Estacionamiento gratuito. Wifi en todo el hotel.', active: true },
] as any[];

const contact = (patch: Record<string, unknown> = {}) => ({ id: 'contact', account_id: 'acc', channel_id: 'ch', external_id: 'x', phone: '5216691234567', name: '', push_name: 'Ana', data: {}, notes: [], ...patch });
const conversation = (patch: Record<string, unknown> = {}) => ({ id: 'conv', summary: '', summary_until_id: 0, flow_step: 0, goal_completed_at: null, data: {}, ...patch });
const msg = (id: number, direction: 'in' | 'out', content: string, extra: Record<string, unknown> = {}) =>
  ({ id, conversation_id: 'conv', direction, sender: direction === 'in' ? 'customer' : 'bot', type: 'text', content, image_id: null, status: 'ok', meta: {}, created_at: NOW, ...extra });
const hotel = () => hydrateChatbot(HOTEL as any);
const imagesById = new Map(IMAGES.map((i) => [i.id, i]));
const automatic = [
  { image: IMAGES[2], when: 'en la bienvenida' },
  { image: IMAGES[3], when: 'al llegar a la etapa 3 (Cierre)' },
];
const aiImages = IMAGES.filter((i) => i.send_when.mode !== 'rules');
const contextImages = IMAGES.filter((i) => i.send_when.context);
const openHours = { timezone: 'America/Mazatlan', hours: { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [], thu: [], fri: [['09:00', '14:00'], ['16:00', '20:00']], sat: [], sun: [] }, holidays: ['2099-12-25'] };

export const CASES: Record<string, () => any> = {
  // Solo instrucciones: sin información, fotos, preguntas ni objetivo.
  minimo: () => ({
    bot: hydrateChatbot({ id: 'bot-min', account_id: 'acc', name: 'Taquería Don Pepe', active: true, created_at: NOW, updated_at: NOW,
      personality: { prompt: 'Atiende pedidos de tacos para llevar.' }, rules: {}, flow: {}, ai: { timezone: 'America/Mexico_City' }, saved_messages: [], data_fields: [] } as any),
    knowledge: [], images: [], contact: contact({ push_name: '' }), conversation: conversation(), channelType: 'webchat',
    history: [msg(1, 'in', 'Hola, ¿están abiertos?')], pending: [msg(1, 'in', 'Hola, ¿están abiertos?')], sentImageIds: [], imagesById: new Map(), now: NOW,
  }),
  // Todo configurado, primer mensaje del cliente: sale la foto de bienvenida.
  'hotel-primer-contacto': () => ({
    bot: hotel(), knowledge: KNOWLEDGE, images: aiImages, contact: contact(), conversation: conversation(), channelType: 'whatsapp',
    history: [msg(1, 'in', 'Hola, ¿tienen habitaciones para el puente?')], pending: [msg(1, 'in', 'Hola, ¿tienen habitaciones para el puente?')],
    sentImageIds: [], imagesById, now: NOW, autoImages: automatic, contextImages, imagesNow: [IMAGES[2]],
    intents: [{ intent: 'cotizar_evento', description: 'quiere cotizar un evento' }, { intent: 'queja', description: '' }],
    business: { ...openHours, openNow: true }, questionAsked: {}, questionAskedEver: {},
  }),
  // A media conversación: pregunta en curso, resumen, notas, persona del equipo, agenda, negocio cerrado y un reintento.
  'hotel-en-curso': () => ({
    bot: hotel(), knowledge: KNOWLEDGE, images: aiImages,
    contact: contact({ name: 'Ana López', data: { motivo: 'Reservar', nombre: 'Ana López', mascota: 'perro pequeño' }, notes: ['Prefiere planta baja'] }),
    conversation: conversation({ summary: '- Ana quiere reservar una doble para el puente.\n- Preguntó por la alberca.', flow_step: 2 }), channelType: 'whatsapp',
    history: [
      msg(10, 'in', 'Soy Ana López'),
      msg(11, 'out', 'Mucho gusto, Ana. ¿Qué día llegas?', { meta: { question: 'fecha_llegada' } }),
      msg(12, 'out', '', { type: 'image', image_id: 'img-bienvenida' }),
      msg(13, 'out', 'Hola Ana, soy Laura del hotel.', { sender: 'human' }),
      msg(14, 'in', 'Llego el viernes'),
      msg(15, 'in', '¿Y tienen cita para ver el salón?'),
    ],
    pending: [msg(14, 'in', 'Llego el viernes'), msg(15, 'in', '¿Y tienen cita para ver el salón?')],
    sentImageIds: ['img-bienvenida'], imagesById, now: NOW, autoImages: automatic, contextImages, imagesNow: [],
    business: { ...openHours, openNow: false, nextOpen: 'martes 13 de octubre a las 09:00' },
    agenda: { timezone: 'America/Mazatlan', needsPhoneFor: [],
      services: [{ id: 'svc-salon', name: 'Visita al salón', kind: 'appointment', duration: 30, description: 'Recorrido por el salón de eventos', location: 'Recepción' }],
      slots: { 'svc-salon': [{ key: '2026-10-13T10:00', label: 'martes 13 de octubre, 10:00' }, { key: '2026-10-13T12:00', label: 'martes 13 de octubre, 12:00' }] },
      appointments: [{ id: 'apt-1', service_name: 'Llamada de seguimiento', kind: 'call', label: 'jueves 15 de octubre, 11:00' }] },
    questionAsked: { motivo: 1, nombre: 1, fecha_llegada: 1 }, questionAskedEver: { motivo: 1, nombre: 1, fecha_llegada: 1 },
    correction: 'Te faltó la siguiente pregunta de la lista. Termina con esta pregunta, tal cual: «¿Qué día llegas?».',
  }),
  // El cliente vuelve por tercera vez: la IA ve las solicitudes anteriores y vuelve a hacer las preguntas que se repiten.
  'cliente-que-vuelve': () => ({
    bot: hotel(), knowledge: KNOWLEDGE, images: aiImages,
    contact: contact({ name: 'Ana López', data: { nombre: 'Ana López', correo: 'ana@correo.mx' } }),
    conversation: conversation({ flow_step: 0, flow_started_at: NOW }), channelType: 'whatsapp',
    history: [msg(40, 'in', 'Hola, quiero reservar otra vez para diciembre')], pending: [msg(40, 'in', 'Hola, quiero reservar otra vez para diciembre')],
    sentImageIds: [], imagesById, now: NOW, autoImages: automatic, contextImages, imagesNow: [],
    business: { ...openHours, openNow: true }, questionAsked: {}, questionAskedEver: { motivo: 2, nombre: 1, fecha_llegada: 2 },
    requests: [
      { number: 1, reason: 'inicio', started_at: new Date('2026-06-02T16:00:00Z'), ended_at: new Date('2026-06-03T16:00:00Z'), goal_completed_at: new Date('2026-06-02T17:00:00Z'), data: { motivo: 'Reservar', fecha_llegada: '20 de junio', huespedes: '2' } },
      { number: 2, reason: 'tiempo', started_at: new Date('2026-08-15T16:00:00Z'), ended_at: new Date('2026-10-12T17:29:00Z'), goal_completed_at: null, data: { motivo: 'Informes' } },
      { number: 3, reason: 'tiempo', started_at: NOW, ended_at: null, goal_completed_at: null, data: {} },
    ],
  }),
  // Camino «Informes» (terminan las preguntas), objetivo ya cumplido, por correo y de usted, sin emojis.
  'objetivo-cumplido-correo': () => {
    const bot = hydrateChatbot({ ...HOTEL, personality: { ...HOTEL.personality, formality: 'usted', emojis: 'none', style_examples: [] },
      rules: { ...HOTEL.rules, unknown_info_behavior: 'handoff' }, flow: { ...HOTEL.flow, steps: [], on_goal_action: 'handoff' }, saved_messages: [] } as any);
    return {
      bot, knowledge: KNOWLEDGE, images: [], contact: contact({ name: 'Luis', phone: '', push_name: '', data: { motivo: 'Informes', correo: 'luis@correo.mx' } }),
      conversation: conversation({ goal_completed_at: NOW }), channelType: 'email',
      history: [msg(20, 'in', 'Solo informes'), msg(21, 'out', 'Con gusto. ¿Algo más en que le ayude?'), msg(22, 'in', 'Gracias, es todo')],
      pending: [msg(22, 'in', 'Gracias, es todo')], sentImageIds: [], imagesById: new Map(), now: NOW,
      business: { ...openHours, openNow: true }, questionAsked: { motivo: 1 }, questionAskedEver: { motivo: 1 },
    };
  },
};
