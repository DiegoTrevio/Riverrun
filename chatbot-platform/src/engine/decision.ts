import { z } from 'zod';

/** Acciones que la IA puede PROPONER. El backend decide si se ejecutan. */
export const ACTIONS = ['reply', 'reply_with_image', 'ask', 'no_reply', 'handoff'] as const;
export type Action = (typeof ACTIONS)[number];

export const DecisionSchema = z.object({
  thinking: z.string().default(''),
  action: z.enum(ACTIONS),
  messages: z.array(z.string()).default([]),
  image_ids: z.array(z.string()).default([]),
  context_image_ids: z.array(z.string()).max(30).default([]),
  saved_message_codes: z.array(z.string()).max(10).default([]),
  save_data: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
  remember: z.array(z.string()).default([]),
  handoff_reason: z.string().default(''),
  info_not_found: z.boolean().default(false),
  intents: z.array(z.string()).default([]),
  flow_step: z.number().int().default(0),
  goal_completed: z.boolean().default(false),
  new_request: z.boolean().default(false),
  booking: z
    .object({
      action: z.enum(['none', 'book', 'cancel']).default('none'),
      service_id: z.string().default(''),
      slot: z.string().default(''),
      appointment_id: z.string().default(''),
      person: z.string().default(''),
    })
    .default({ action: 'none', service_id: '', slot: '', appointment_id: '', person: '' }),
  quote: z
    .object({
      action: z.enum(['none', 'prepare']).default('none'),
      items: z.array(z.object({ item_code: z.string().default(''), qty: z.number().default(1), qty_quote: z.string().default('') })).max(100).default([]),
      notes: z.string().default(''),
      wants_final: z.boolean().default(false),
    })
    .default({ action: 'none', items: [], notes: '', wants_final: false }),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** JSON Schema estricto para "structured outputs" de OpenAI. */
export const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thinking', 'action', 'messages', 'image_ids', 'context_image_ids', 'saved_message_codes', 'save_data', 'remember', 'handoff_reason', 'info_not_found', 'intents', 'flow_step', 'goal_completed', 'new_request', 'booking', 'quote'],
  properties: {
    thinking: {
      type: 'string',
      description: 'Análisis interno breve (máx. 3 frases, no se envía al cliente): qué quiere el cliente, qué dato del negocio aplica, qué falta.',
    },
    action: { type: 'string', enum: [...ACTIONS] },
    messages: {
      type: 'array',
      description: 'Mensajes de WhatsApp a enviar, en orden. Normalmente 1; máximo los permitidos. Vacío solo si action es no_reply.',
      items: { type: 'string' },
    },
    image_ids: {
      type: 'array',
      description: 'IDs EXACTOS de imágenes del catálogo a enviar. Vacío si no aplica.',
      items: { type: 'string' },
    },
    context_image_ids: {
      type: 'array',
      description: 'IDs exactos de fotos cuya condición de contexto se cumple en este intercambio. Evalúa intención, historial y respuesta propuesta, sin exigir palabras exactas. Vacío cuando ninguna aplica.',
      items: { type: 'string' },
    },
    saved_message_codes: {
      type: 'array',
      description: 'Códigos EXACTOS de mensajes guardados que se envían tal cual (texto y foto juntos). No copies su texto en messages. Vacío si no aplica.',
      items: { type: 'string' },
    },
    save_data: {
      type: 'array',
      description: 'Respuestas útiles dadas explícitamente por el cliente. Usa claves de los datos conocidos o crea una clave descriptiva en español, sin acentos y con guion bajo. No requiere campos predefinidos.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'value'],
        properties: { field: { type: 'string' }, value: { type: 'string' } },
      },
    },
    remember: {
      type: 'array',
      description: 'Hechos nuevos y útiles sobre el cliente para recordar (intereses, preferencias, situación). Frases cortas. Vacío si no hay nada nuevo.',
      items: { type: 'string' },
    },
    handoff_reason: { type: 'string', description: 'Motivo de la transferencia si action es handoff; si no, cadena vacía.' },
    info_not_found: { type: 'boolean', description: 'true si el cliente pidió un dato que NO está en la información del negocio.' },
    intents: {
      type: 'array',
      description: 'Identificadores de la lista "Intenciones a detectar" que expresa el cliente en sus mensajes nuevos, y de las columnas del "Pipeline" cuya situación se cumple con este intercambio. Vacío si ninguna.',
      items: { type: 'string' },
    },
    flow_step: {
      type: 'integer',
      description: 'Número de la etapa del recorrido en la que queda la conversación después de esta respuesta (0 si no hay recorrido).',
    },
    goal_completed: {
      type: 'boolean',
      description: 'true solo si con esta respuesta se cumple el objetivo de la conversación (y ya se tienen los datos importantes).',
    },
    new_request: {
      type: 'boolean',
      description: 'true solo si el cliente empieza otra vez una solicitud que ya terminó en esta conversación (vuelve a reservar, el problema regresó, pide de nuevo el mismo servicio). Repetir o seguir la solicitud actual no es una nueva.',
    },
    booking: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'service_id', 'slot', 'appointment_id', 'person'],
      description: 'Agenda: "book" solo cuando el cliente ya eligió explícitamente un horario de la lista; "cancel" si pide cancelar una cita suya; si no, "none".',
      properties: {
        action: { type: 'string', enum: ['none', 'book', 'cancel'] },
        service_id: { type: 'string', description: 'ID exacto del servicio (book).' },
        slot: { type: 'string', description: 'Horario exacto de la lista, formato AAAA-MM-DDTHH:MM (book).' },
        appointment_id: { type: 'string', description: 'ID de la cita a cancelar (cancel).' },
        person: { type: 'string', description: 'Nombre exacto de la persona que pidió el cliente, de la lista del servicio (book); vacío si no pidió a nadie.' },
      },
    },
    quote: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'items', 'notes', 'wants_final'],
      description: 'Cotización en PDF: "prepare" solo si hay sección Cotizaciones, el cliente pidió cotización o presupuesto y ya sabes qué conceptos y cantidades quiere; si no, "none". El sistema calcula los montos y envía el archivo.',
      properties: {
        action: { type: 'string', enum: ['none', 'prepare'] },
        items: {
          type: 'array',
          description: 'Conceptos de la lista de precios (clave exacta) y cantidad que pidió el cliente.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['item_code', 'qty', 'qty_quote'],
            properties: {
              item_code: { type: 'string', description: 'Clave exacta del concepto.' },
              qty: { type: 'number', description: 'Cantidad (1 si es un solo servicio).' },
              qty_quote: { type: 'string', description: 'Palabras exactas del cliente donde dice la cantidad (p. ej. "150 invitados"); vacío si la cantidad es 1.' },
            },
          },
        },
        notes: { type: 'string', description: 'Notas para la cotización con detalles que dio el cliente (fecha, lugar…); sin precios.' },
        wants_final: { type: 'boolean', description: 'true solo si el cliente pide una cotización final o formal.' },
      },
    },
  },
} as const;
