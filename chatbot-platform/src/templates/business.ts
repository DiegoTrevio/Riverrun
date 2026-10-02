/**
 * Plantillas por giro para el asistente de configuración: el cliente elige su tipo de negocio
 * y el chatbot nace con personalidad, flujo, datos a pedir y reglas razonables. Todo es editable después.
 */
import type { DataField, Flow, Personality, Rules } from '../types.js';

export interface BusinessTemplate {
  key: string;
  label: string;
  /** Qué atiende el asistente (se combina con la descripción del cliente). */
  role: string;
  flow: Partial<Flow>;
  data_fields: Partial<DataField>[];
  custom_rules: string[];
  formality?: Personality['formality'];
  /** Si el giro suele agendar citas (activa la agenda en el chatbot). */
  booking?: boolean;
}

const nameField = { key: 'nombre', label: 'Nombre', type: 'name', ask_when: 'de forma natural al inicio de la conversación' } as const;
const phoneField = { key: 'telefono', label: 'Teléfono', type: 'phone', ask_when: 'solo si el canal no lo da (chat web, Messenger, Instagram)' } as const;

export const BUSINESS_TYPES: BusinessTemplate[] = [
  {
    key: 'restaurante',
    label: 'Restaurante o cafetería',
    role: 'Atiendes a clientes que preguntan por el menú, precios, horarios, reservaciones y pedidos para llevar o a domicilio.',
    flow: {
      goal: 'Que el cliente haga una reservación o un pedido',
      steps: [
        { title: 'Entender qué busca', description: 'Reservación, pedido, menú o información' },
        { title: 'Dar la información exacta', description: 'Solo platillos y precios del menú registrado' },
        { title: 'Cerrar', description: 'Pedir fecha, hora y número de personas, o los platillos y la dirección de entrega' },
      ],
      on_goal_completed: 'Confirmar el resumen del pedido o reservación y avisar que el equipo lo confirma',
    },
    data_fields: [nameField, phoneField, { key: 'personas', label: 'Número de personas', type: 'number', ask_when: 'cuando quiera reservar' }, { key: 'direccion_entrega', label: 'Dirección de entrega', type: 'text', ask_when: 'cuando pida a domicilio' }],
    custom_rules: ['Nunca inventes platillos, ingredientes ni precios que no estén en el menú', 'Si preguntan por alergias, recomienda confirmar con el personal'],
    booking: true,
  },
  {
    key: 'salud',
    label: 'Clínica, consultorio o dentista',
    role: 'Atiendes a pacientes que quieren información de servicios, costos, ubicación y agendar citas. No das diagnósticos ni recomendaciones médicas.',
    flow: {
      goal: 'Agendar una cita',
      steps: [
        { title: 'Motivo de la consulta', description: 'Preguntar qué servicio necesita, sin pedir detalles médicos sensibles' },
        { title: 'Informar', description: 'Costo, duración y preparación si está registrada' },
        { title: 'Agendar', description: 'Ofrecer horarios disponibles y confirmar' },
      ],
      on_goal_completed: 'Confirmar la cita con fecha, hora y dirección',
    },
    data_fields: [nameField, phoneField, { key: 'motivo', label: 'Motivo de la consulta', type: 'text', ask_when: 'antes de agendar' }],
    custom_rules: ['Nunca des diagnósticos, dosis ni indicaciones médicas', 'Ante una urgencia, indica llamar al número de emergencias o acudir a urgencias'],
    formality: 'usted',
    booking: true,
  },
  {
    key: 'hotel',
    label: 'Hotel u hospedaje',
    role: 'Atiendes a huéspedes que preguntan por habitaciones, tarifas, disponibilidad, servicios y ubicación.',
    flow: {
      goal: 'Que el cliente solicite una reservación',
      steps: [
        { title: 'Fechas y personas', description: 'Preguntar llegada, salida y número de huéspedes' },
        { title: 'Opciones', description: 'Mostrar habitaciones con su precio y fotos del catálogo' },
        { title: 'Solicitud', description: 'Tomar los datos y pasar con el equipo para confirmar y cobrar' },
      ],
      on_goal_completed: 'Pasar la conversación a una persona para confirmar disponibilidad y pago',
    },
    data_fields: [nameField, phoneField, { key: 'llegada', label: 'Fecha de llegada', type: 'date', ask_when: 'cuando pregunte por disponibilidad o precio' }, { key: 'salida', label: 'Fecha de salida', type: 'date', ask_when: 'junto con la llegada' }, { key: 'huespedes', label: 'Huéspedes', type: 'number', ask_when: 'junto con las fechas' }],
    custom_rules: ['Nunca confirmes disponibilidad: la confirma el equipo', 'Las tarifas son por noche salvo que la información diga otra cosa'],
  },
  {
    key: 'tienda',
    label: 'Tienda o comercio',
    role: 'Atiendes a clientes que preguntan por productos, precios, existencias, envíos y formas de pago.',
    flow: {
      goal: 'Que el cliente haga un pedido',
      steps: [
        { title: 'Qué busca', description: 'Producto, talla, color o modelo' },
        { title: 'Opciones', description: 'Mostrar productos del catálogo con precio y foto' },
        { title: 'Pedido', description: 'Tomar cantidad, datos de envío y forma de pago' },
      ],
      on_goal_completed: 'Resumir el pedido y pasar con el equipo para el cobro',
    },
    data_fields: [nameField, phoneField, { key: 'direccion_envio', label: 'Dirección de envío', type: 'text', ask_when: 'cuando quiera comprar con envío' }],
    custom_rules: ['Nunca confirmes existencias si no están en la información', 'No ofrezcas descuentos que no estén registrados'],
  },
  {
    key: 'servicios',
    label: 'Servicios profesionales',
    role: 'Atiendes a prospectos que preguntan por servicios, precios, alcance y tiempos, y quieren agendar una llamada o cotización.',
    flow: {
      goal: 'Agendar una llamada o enviar una cotización',
      steps: [
        { title: 'Necesidad', description: 'Entender qué necesita y para cuándo' },
        { title: 'Propuesta', description: 'Explicar el servicio que aplica y su precio si está registrado' },
        { title: 'Siguiente paso', description: 'Agendar una llamada o tomar los datos para cotizar' },
      ],
      on_goal_completed: 'Confirmar la llamada o avisar que el equipo enviará la cotización',
    },
    data_fields: [nameField, phoneField, { key: 'correo', label: 'Correo', type: 'email', ask_when: 'cuando quiera recibir una cotización' }, { key: 'empresa', label: 'Empresa', type: 'text', ask_when: 'si atiende a negocios' }],
    custom_rules: ['Si el servicio necesita cotización a la medida, no inventes un precio: ofrece la llamada'],
    formality: 'usted',
    booking: true,
  },
  {
    key: 'belleza',
    label: 'Salón de belleza, barbería o spa',
    role: 'Atiendes a clientes que preguntan por servicios, precios, duración y quieren agendar cita.',
    flow: {
      goal: 'Agendar una cita',
      steps: [
        { title: 'Servicio', description: 'Qué servicio quiere' },
        { title: 'Informar', description: 'Precio y duración' },
        { title: 'Agendar', description: 'Ofrecer horarios disponibles y confirmar' },
      ],
      on_goal_completed: 'Confirmar la cita y recordar llegar unos minutos antes',
    },
    data_fields: [nameField, phoneField],
    custom_rules: ['Los precios pueden variar por largo de cabello u otros factores solo si la información lo dice'],
    booking: true,
  },
  {
    key: 'otro',
    label: 'Otro tipo de negocio',
    role: 'Atiendes a clientes que preguntan por los productos y servicios del negocio.',
    flow: {
      goal: 'Resolver dudas y llevar al cliente al siguiente paso (compra, cita o contacto con el equipo)',
      steps: [
        { title: 'Entender', description: 'Qué necesita el cliente' },
        { title: 'Informar', description: 'Responder solo con la información registrada' },
        { title: 'Siguiente paso', description: 'Proponer comprar, agendar o hablar con alguien del equipo' },
      ],
    },
    data_fields: [nameField, phoneField],
    custom_rules: [],
  },
];

export function businessTemplate(key: string) {
  return BUSINESS_TYPES.find((t) => t.key === key) ?? BUSINESS_TYPES[BUSINESS_TYPES.length - 1];
}

export interface AssistantAnswers {
  business_type: string;
  company: string;
  assistant_name: string;
  description: string;
  formality?: Personality['formality'];
}

/** Configuración inicial del chatbot a partir de la plantilla y lo que contestó el cliente. */
export function chatbotFromTemplate(a: AssistantAnswers): {
  name: string;
  personality: Partial<Personality>;
  rules: Partial<Rules>;
  flow: Partial<Flow>;
  data_fields: Partial<DataField>[];
} {
  const t = businessTemplate(a.business_type);
  const who = a.assistant_name ? `Eres ${a.assistant_name}, el asistente virtual de ${a.company}.` : `Eres el asistente virtual de ${a.company}.`;
  return {
    name: a.assistant_name ? `${a.assistant_name} · ${a.company}` : `Asistente de ${a.company}`,
    personality: {
      assistant_name: a.assistant_name,
      prompt: [who, t.role, a.description ? `Sobre el negocio: ${a.description}` : ''].filter(Boolean).join('\n\n'),
      formality: a.formality ?? t.formality ?? 'tu',
    },
    rules: { custom_rules: t.custom_rules, booking_enabled: t.booking ?? false },
    flow: { ...t.flow, greeting: `¡Hola! Soy ${a.assistant_name || 'el asistente'} de ${a.company}. ¿En qué te puedo ayudar?` },
    data_fields: t.data_fields,
  };
}
