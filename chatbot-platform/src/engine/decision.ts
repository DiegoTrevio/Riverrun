import { z } from 'zod';

/** Acciones que la IA puede PROPONER. El backend decide si se ejecutan. */
export const ACTIONS = ['reply', 'reply_with_image', 'ask', 'no_reply', 'handoff'] as const;
export type Action = (typeof ACTIONS)[number];

export const DecisionSchema = z.object({
  thinking: z.string().default(''),
  action: z.enum(ACTIONS),
  messages: z.array(z.string()).default([]),
  image_ids: z.array(z.string()).default([]),
  save_data: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
  remember: z.array(z.string()).default([]),
  handoff_reason: z.string().default(''),
  info_not_found: z.boolean().default(false),
  intents: z.array(z.string()).default([]),
  booking: z
    .object({
      action: z.enum(['none', 'book', 'cancel']).default('none'),
      service_id: z.string().default(''),
      slot: z.string().default(''),
      appointment_id: z.string().default(''),
    })
    .default({ action: 'none', service_id: '', slot: '', appointment_id: '' }),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** JSON Schema estricto para "structured outputs" de OpenAI. */
export const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thinking', 'action', 'messages', 'image_ids', 'save_data', 'remember', 'handoff_reason', 'info_not_found', 'intents', 'booking'],
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
    save_data: {
      type: 'array',
      description: 'Datos del cliente que dio explícitamente en sus mensajes y que corresponden a los campos a recopilar.',
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
      description: 'Intenciones de la lista "Intenciones a detectar" que expresa el cliente en sus mensajes nuevos. Vacío si ninguna.',
      items: { type: 'string' },
    },
    booking: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'service_id', 'slot', 'appointment_id'],
      description: 'Agenda: "book" solo cuando el cliente ya eligió explícitamente un horario de la lista; "cancel" si pide cancelar una cita suya; si no, "none".',
      properties: {
        action: { type: 'string', enum: ['none', 'book', 'cancel'] },
        service_id: { type: 'string', description: 'ID exacto del servicio (book).' },
        slot: { type: 'string', description: 'Horario exacto de la lista, formato AAAA-MM-DDTHH:MM (book).' },
        appointment_id: { type: 'string', description: 'ID de la cita a cancelar (cancel).' },
      },
    },
  },
} as const;
