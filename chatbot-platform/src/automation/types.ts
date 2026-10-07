import { z } from 'zod';

/* ------------------------------ Horarios ------------------------------ */

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM');
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

/** Horario semanal: por día, lista de franjas [inicio, fin]. Día sin franjas = cerrado. */
/** Franja de atención: la hora de cierre debe ser posterior a la de apertura (en el mismo día). */
const Range = z.tuple([HHMM, HHMM]).refine(([a, b]) => a < b, 'La hora de cierre debe ser después de la de apertura (ej. 09:00-18:00)');
export const WeeklyHoursSchema = z.object(
  Object.fromEntries(DAYS.map((d) => [d, z.array(Range).default([])])) as Record<Day, z.ZodDefault<z.ZodArray<typeof Range>>>,
);

/** Zona horaria IANA que el sistema reconoce (p.ej. America/Mexico_City). */
export const TimezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('es-MX', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Zona horaria no válida (ej. America/Mexico_City)');
export type WeeklyHours = z.infer<typeof WeeklyHoursSchema>;

export const DEFAULT_HOURS: WeeklyHours = {
  mon: [['09:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '18:00']],
  sat: [['09:00', '14:00']],
  sun: [],
};

/* ------------------------------ Configuración de la cuenta ------------------------------ */

export const OptOutSchema = z.object({
  enabled: z.boolean().default(true),
  keywords: z.array(z.string()).default(['baja', 'stop', 'alto', 'no quiero mensajes', 'cancelar suscripcion']),
  confirm_message: z.string().default('Listo, ya no te enviaremos mensajes promocionales. Si quieres volver a recibirlos, escribe ALTA.'),
  resume_keywords: z.array(z.string()).default(['alta', 'start']),
  resume_message: z.string().default('¡Listo! Volverás a recibir nuestras novedades.'),
  /** Pie que se agrega a campañas y secuencias para que siempre sepan cómo darse de baja. */
  footer_enabled: z.boolean().default(true),
  footer_text: z.string().max(200).default('Responde {{palabra_baja}} para dejar de recibir estos mensajes.'),
});

export const ConsentSchema = z.object({
  require_for_campaigns: z.boolean().default(true),
  /** Frases (el mensaje completo) con las que el cliente acepta recibir promociones. */
  opt_in_keywords: z.array(z.string()).default(['acepto', 'si acepto', 'alta', 'quiero recibir promociones']),
  opt_in_message: z.string().max(500).default('¡Gracias! Te enviaremos novedades y promociones. Responde BAJA cuando quieras dejar de recibirlas.'),
});

export const SendingSchema = z.object({ daily_cap_per_number: z.number().int().min(0).max(100000).default(0) });

export const RetentionSchema = z.object({
  /** Borrar mensajes con más de N días (0 = no borrar). */
  messages_days: z.number().int().min(0).max(3650).default(0),
  /** Borrar contactos (y sus conversaciones) sin actividad en N días y sin citas futuras (0 = no borrar). */
  inactive_contacts_days: z.number().int().min(0).max(3650).default(0),
});

/** Reparto de conversaciones al equipo por turnos (round robin). */
export const AssignmentSchema = z.object({
  enabled: z.boolean().default(false),
  /** Asignar automáticamente cuando una conversación pasa a una persona. */
  on_handoff: z.boolean().default(true),
  roles: z.array(z.enum(['admin', 'agent'])).default(['agent', 'admin']),
  /** Si se eligen personas, el turno es solo entre ellas (vacío = todas las de los roles). */
  user_ids: z.array(z.string().uuid()).default([]),
  /** Además del asignado, avisar a todo el equipo. */
  notify_all: z.boolean().default(false),
});

export const AccountSettingsSchema = z.object({
  timezone: TimezoneSchema.default('America/Mexico_City'),
  business_hours: WeeklyHoursSchema.default(DEFAULT_HOURS),
  /** Días cerrados (YYYY-MM-DD). */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  opt_out: OptOutSchema.default(() => OptOutSchema.parse({})),
  /** Consentimiento: para enviar promociones (campañas y secuencias) el cliente debe haber aceptado. */
  consent: ConsentSchema.default(() => ConsentSchema.parse({})),
  /** Envíos proactivos: tope diario de mensajes de campaña por número de WhatsApp (0 = sin tope; ayuda a no arriesgar el número). */
  sending: SendingSchema.default(() => SendingSchema.parse({})),
  /** Cuánto tiempo se conservan los datos (0 = para siempre). */
  retention: RetentionSchema.default(() => RetentionSchema.parse({})),
  assignment: AssignmentSchema.default(() => AssignmentSchema.parse({})),
  /** Notificar en el panel a todo el equipo cuando una conversación pasa a humano. */
  notify_team_on_handoff: z.boolean().default(true),
  /** Secreto para suscribirse al calendario (.ics) y firmar webhooks salientes. */
  calendar_token: z.string().default(''),
  webhook_secret: z.string().default(''),
});
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export function accountSettings(raw: unknown): AccountSettings {
  const r = AccountSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : AccountSettingsSchema.parse({});
}

/* ------------------------------ Reglas automáticas ------------------------------ */

const Slug = z.string().trim().min(1).max(60);

export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_received'),
    // any: cualquier mensaje · keywords: contiene alguna palabra/frase completa · exact: el mensaje es exactamente
    // una de ellas · contains: contiene el texto en cualquier parte. (Sin expresiones regulares: evita bloqueos del servidor.)
    match: z.enum(['any', 'keywords', 'exact', 'contains']).default('keywords'),
    keywords: z.array(z.string()).default([]),
    first_message_only: z.boolean().default(false),
  }),
  z.object({ type: z.literal('new_contact') }),
  z.object({ type: z.literal('intent'), intent: Slug, description: z.string().max(300).default('') }),
  z.object({ type: z.literal('data_captured'), field: z.string().default('') }),
  z.object({ type: z.literal('tag_added'), tag: Slug }),
  z.object({ type: z.literal('handoff') }),
  z.object({ type: z.literal('no_reply'), minutes: z.number().int().min(1).max(60 * 24 * 30) }),
  z.object({ type: z.literal('appointment_booked'), service_id: z.string().default('') }),
  z.object({ type: z.literal('appointment_cancelled'), service_id: z.string().default('') }),
  z.object({ type: z.literal('opt_out') }),
  z.object({ type: z.literal('goal_completed') }),
  z.object({ type: z.literal('agent_off') }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerType = Trigger['type'];

export const ConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('channel'), channel_types: z.array(z.string()).default([]) }),
  z.object({ type: z.literal('business_hours'), inside: z.boolean().default(true) }),
  z.object({ type: z.literal('has_tag'), tag: Slug, negate: z.boolean().default(false) }),
  z.object({ type: z.literal('field'), field: Slug, op: z.enum(['present', 'absent', 'equals', 'contains']).default('present'), value: z.string().default('') }),
  z.object({ type: z.literal('status'), status: z.enum(['bot', 'human', 'closed']) }),
  /** on: el asistente atiende · off: en pausa o esperando su palabra de activación. */
  z.object({ type: z.literal('agent'), state: z.enum(['on', 'off']).default('on') }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send_message'), text: z.string().max(4000).default(''), image_id: z.string().default(''), delay_minutes: z.number().int().min(0).max(60 * 24 * 30).default(0) }),
  z.object({ type: z.literal('add_tag'), tag: Slug }),
  z.object({ type: z.literal('remove_tag'), tag: Slug }),
  z.object({ type: z.literal('set_field'), field: z.string().regex(/^[a-z0-9_]+$/), value: z.string().max(500) }),
  z.object({
    type: z.literal('alert_team'),
    message: z.string().max(2000).default('{{cliente}} necesita atención: "{{mensaje}}"'),
    roles: z.array(z.enum(['admin', 'agent'])).default(['admin', 'agent']),
    user_ids: z.array(z.string()).default([]),
    phones: z.array(z.string()).default([]),
    /** Avisar a una sola persona, por turnos, en lugar de a todas. */
    round_robin: z.boolean().default(false),
  }),
  /** Envía el reporte de la conversación (resumen, análisis y datos) al equipo, por panel, correo y WhatsApp. */
  z.object({
    type: z.literal('send_report'),
    note: z.string().max(500).default(''),
    roles: z.array(z.enum(['admin', 'agent'])).default(['admin']),
    user_ids: z.array(z.string()).default([]),
    emails: z.array(z.string().trim().toLowerCase().email()).max(5).default([]),
    phones: z.array(z.string()).max(5).default([]),
    include_transcript: z.boolean().default(false),
  }),
  /** Asigna la conversación a alguien del equipo por turnos y le avisa a esa persona. */
  z.object({
    type: z.literal('assign'),
    message: z.string().max(2000).default('Te asignaron a {{cliente}}: "{{mensaje}}"'),
    roles: z.array(z.enum(['admin', 'agent'])).default(['agent', 'admin']),
    user_ids: z.array(z.string()).default([]),
    /** Además, pasar la conversación a una persona (el asistente deja de responder). */
    take_over: z.boolean().default(false),
  }),
  z.object({ type: z.literal('handoff'), reason: z.string().max(300).default('Regla automática') }),
  z.object({ type: z.literal('resume_bot') }),
  /** Pausa al asistente en la conversación (0 h = hasta reactivarlo con palabra, regla o a mano). */
  z.object({ type: z.literal('pause_bot'), hours: z.number().min(0).max(720).default(0), reason: z.string().max(300).default('') }),
  z.object({ type: z.literal('close_conversation') }),
  z.object({ type: z.literal('start_sequence'), sequence_id: z.string().uuid() }),
  z.object({ type: z.literal('stop_sequences') }),
  z.object({ type: z.literal('webhook'), url: z.string().url().max(500) }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const AutomationBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
  chatbot_id: z.string().uuid().nullable().default(null),
  trigger: TriggerSchema,
  conditions: z.array(ConditionSchema).max(20).default([]),
  actions: z.array(ActionSchema).min(1, 'Agrega al menos una acción').max(20),
  stop_ai: z.boolean().default(false),
  priority: z.number().int().default(0),
});
export type AutomationBody = z.infer<typeof AutomationBodySchema>;

export interface Automation extends AutomationBody {
  id: string;
  account_id: string;
  run_count: number;
  last_run_at: Date | null;
}

/* ------------------------------ Secuencias ------------------------------ */

export const SequenceStepSchema = z.object({
  /** Espera desde el paso anterior (o desde la inscripción). */
  delay_value: z.number().int().min(0).max(10000).default(0),
  delay_unit: z.enum(['minutes', 'hours', 'days']).default('hours'),
  /** Si se indica, se envía a esa hora (del día en que toque o el siguiente). */
  at_time: z.union([HHMM, z.literal('')]).default(''),
  text: z.string().max(4000).default(''),
  image_id: z.string().default(''),
  /** Solo se envía si se cumplen (si no, se salta el paso). */
  conditions: z.array(ConditionSchema).max(10).default([]),
});
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

export const SequenceBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
  steps: z.array(SequenceStepSchema).min(1, 'Agrega al menos un paso').max(30),
  stop_on_reply: z.boolean().default(true),
  business_hours_only: z.boolean().default(true),
});
export type SequenceBody = z.infer<typeof SequenceBodySchema>;
export interface Sequence extends SequenceBody {
  id: string;
  account_id: string;
}

/* ------------------------------ Agenda ------------------------------ */

export const ServiceBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['appointment', 'call']).default('appointment'),
  description: z.string().max(1000).default(''),
  duration_minutes: z.number().int().min(5).max(24 * 60).default(30),
  buffer_minutes: z.number().int().min(0).max(240).default(0),
  capacity: z.number().int().min(1).max(100).default(1),
  min_notice_minutes: z.number().int().min(0).max(60 * 24 * 30).default(60),
  max_days_ahead: z.number().int().min(1).max(365).default(30),
  location: z.string().max(500).default(''),
  hours: WeeklyHoursSchema.nullable().default(null),
  reminders: z.array(z.number().int().min(5).max(60 * 24 * 14)).max(5).default([1440, 60]),
  reminder_message: z.string().max(1000).default(''),
  assigned_user_ids: z.array(z.string().uuid()).default([]),
  notify_team: z.boolean().default(true),
  active: z.boolean().default(true),
});
export type ServiceBody = z.infer<typeof ServiceBodySchema>;
export interface Service extends ServiceBody {
  id: string;
  account_id: string;
}

export interface Appointment {
  id: string;
  account_id: string;
  service_id: string | null;
  service_name: string;
  kind: string;
  contact_id: string | null;
  conversation_id: string | null;
  assigned_user_id: string | null;
  customer_name: string;
  customer_phone: string;
  starts_at: Date;
  ends_at: Date;
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  source: string;
  notes: string;
  cancel_reason: string;
}

export const DEFAULT_REMINDER = 'Hola {{nombre}}, te recordamos tu {{cita.tipo}} de {{cita.servicio}} el {{cita.fecha}} a las {{cita.hora}}. Si necesitas cambiarla, responde a este mensaje.';

/* ------------------------------ Eventos ------------------------------ */

export interface AutomationEvent {
  type: TriggerType;
  conversationId: string;
  /** Texto del mensaje del cliente (message_received). */
  text?: string;
  isFirstMessage?: boolean;
  intents?: string[];
  field?: string;
  tag?: string;
  appointment?: Appointment;
  /** Evita bucles: acciones que disparan otros eventos. */
  depth?: number;
  /** Transferencia hecha por una persona del equipo que tomó la conversación (ella ya la atiende: no se reparte). */
  byUserId?: string;
}
