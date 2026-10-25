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

/** Cada cuánto se repiten los recordatorios al equipo y cuándo se escala una conversación asignada sin respuesta. */
export const AlertTimingSchema = z.object({
  /** Repetir «un cliente espera a una persona» cada N minutos (durante 24 h). 0 = recordar una sola vez. */
  human_repeat_minutes: z.number().int().min(0).max(1440).default(120),
  /** Repetir «un cliente sigue esperando respuesta» (el asistente no pudo contestar) cada N minutos (durante 24 h). */
  // Menos de 10 cuenta como 10 (ver reviveFailed): un campo vacío en el panel (0) no rechaza todos los ajustes.
  ai_error_repeat_minutes: z.number().int().min(0).max(1440).default(30),
  /** Escalar: si una conversación asignada lleva N minutos sin respuesta de una persona, se avisa una vez más. 0 = no escalar. */
  escalate_minutes: z.number().int().min(0).max(1440).default(0),
  /** A quién se escala (vacío = a los administradores). */
  escalate_user_ids: z.array(z.string().uuid()).max(50).default([]),
});

/** Avisos cuando un WhatsApp se desconecta: cuándo, cada cuánto y a quién (lo define cada negocio). */
export const ConnectionAlertsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Minutos de espera antes de avisar (da tiempo a la reconexión automática). 0 = de inmediato. */
  after_minutes: z.number().int().min(0).max(1440).default(5),
  /** Repetir el aviso cada N horas mientras siga desconectado (máximo 7 días). 0 = avisar una sola vez. */
  repeat_hours: z.number().int().min(0).max(168).default(6),
  /** Administradores de la cuenta: panel y correo. */
  notify_admins: z.boolean().default(true),
  /** Correos adicionales (por ejemplo, el dueño o soporte). */
  emails: z.array(z.string().trim().toLowerCase().email('Correo inválido en los avisos de desconexión')).max(10).default([]),
  /** WhatsApp adicionales (se envía desde otro WhatsApp conectado de la cuenta). */
  phones: z.array(z.string().trim().regex(/^\+?[\d\s()-]{8,20}$/, 'Número inválido en los avisos de desconexión')).max(5).default([]),
  /** Avisar también cuando vuelve a conectarse (si antes se avisó de la desconexión). */
  notify_reconnected: z.boolean().default(true),
});
export type ConnectionAlerts = z.infer<typeof ConnectionAlertsSchema>;

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
  connection_alerts: ConnectionAlertsSchema.default(() => ConnectionAlertsSchema.parse({})),
  alert_timing: AlertTimingSchema.default(() => AlertTimingSchema.parse({})),
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
/** Archivo subido en "Archivos" (vacío = ninguno). */
const AttachmentRef = z.union([z.string().uuid(), z.literal('')]).default('');
/**
 * Plantilla de WhatsApp aprobada (API oficial por Zernio) para escribir fuera de las 24 h: cuál y el texto de cada
 * variable ({{1}}, {{2}}…), que acepta los datos del contacto ({{nombre}}, {{telefono}}…).
 */
export const WaTemplateRefSchema = z.object({ template_id: z.string().uuid(), params: z.array(z.string().max(1000)).max(20).default([]) }).nullable().default(null);
export type WaTemplateRef = NonNullable<z.infer<typeof WaTemplateRefSchema>>;

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
  /** Cotizaciones: enviada al cliente (aproximada o final), por aprobar y rechazada por el equipo. */
  z.object({ type: z.literal('quote_sent'), kind: z.enum(['', 'approximate', 'final']).default('') }),
  z.object({ type: z.literal('quote_pending_approval') }),
  z.object({ type: z.literal('quote_rejected') }),
  /** El equipo marcó que el cliente aceptó la cotización. */
  z.object({ type: z.literal('quote_accepted') }),
  /** Cobros: hoy vence (al enviarse el recordatorio del día), venció sin pagarse (al día siguiente) y el equipo lo marcó pagado. */
  z.object({ type: z.literal('payment_due') }),
  z.object({ type: z.literal('payment_overdue') }),
  z.object({ type: z.literal('payment_paid') }),
  /** El recorrido llega a una etapa (0 = cualquiera). */
  z.object({ type: z.literal('stage_reached'), step: z.number().int().min(0).max(30).default(0) }),
  z.object({ type: z.literal('agent_off') }),
  /** Una solicitud entra a una columna de un pipeline (vacíos = cualquier pipeline o cualquier columna). */
  z.object({ type: z.literal('pipeline_stage'), pipeline_id: z.union([z.string().uuid(), z.literal('')]).default(''), stage_id: z.string().max(40).default('') }),
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
  z.object({ type: z.literal('send_message'), text: z.string().max(4000).default(''), image_id: z.string().default(''), attachment_id: AttachmentRef, wa_template: WaTemplateRefSchema, delay_minutes: z.number().int().min(0).max(60 * 24 * 30).default(0) }),
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
  z.object({ type: z.literal('create_task'), kind: z.enum(['pendiente', 'nota']).default('pendiente'), body: z.string().trim().min(1, 'Escribe el texto del pendiente o la nota').max(1000), due_days: z.number().int().min(0).max(365).default(0) }),
  z.object({ type: z.literal('start_sequence'), sequence_id: z.string().uuid() }),
  z.object({ type: z.literal('stop_sequences') }),
  z.object({ type: z.literal('webhook'), url: z.string().url().max(500) }),
  /** Envía la conversación a la app del cliente (sus webhooks de Integraciones): el resumen, completa o ambos. */
  z.object({
    type: z.literal('send_conversation'),
    content: z.enum(['summary', 'full', 'both']).default('summary'),
    /** Webhook de destino ('' = todas las apps conectadas que reciben conversaciones). */
    endpoint_id: z.union([z.string().uuid(), z.literal('')]).default(''),
  }),
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
  /** Se ejecuta una sola vez por conversación (por recorrido: vuelve a contar si se reinicia o se reabre). */
  once_per_conversation: z.boolean().default(false),
  priority: z.number().int().default(0),
}).refine((r) => !(r.trigger.type === 'intent' && r.stop_ai), {
  // La IA ya respondió cuando se detecta la intención: una regla así no puede impedir esa respuesta.
  message: 'Una regla por intención no puede detener al asistente: se detecta después de su respuesta.',
  path: ['stop_ai'],
});
export type AutomationBody = z.infer<typeof AutomationBodySchema>;

export interface Automation extends AutomationBody {
  id: string;
  account_id: string;
  run_count: number;
  last_run_at: Date | null;
}

/* ------------------------------ Secuencias ------------------------------ */

/** Etiqueta comparable de un botón: sin acentos, mayúsculas, emojis ni signos. */
export const normalizeLabel = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Botón de un mensaje de flujo. Uno de respuesta lleva su acción (seguir, terminar, otro flujo, etiqueta o pasar con una
 * persona) y, si se quiere, un texto con el que se contesta al tocarlo; uno de enlace abre una dirección https.
 */
export const FlowButtonSchema = z.object({
  label: z.string().trim().min(1, 'Escribe el texto del botón').max(20, 'El texto de un botón tiene máximo 20 caracteres')
    .refine((s) => normalizeLabel(s) !== '', 'El texto del botón necesita letras o números')
    .refine((s) => !/^\d+$/.test(normalizeLabel(s)), 'El texto de un botón no puede ser solo un número (se confunde con elegir por número)'),
  kind: z.enum(['reply', 'url']).default('reply'),
  url: z.string().trim().max(1000).default(''),
  action: z.enum(['next', 'end', 'start_sequence', 'tag', 'handoff']).default('next'),
  sequence_id: z.string().uuid().nullable().default(null),
  tag: z.string().trim().max(60).default(''),
  reply: z.string().max(1000).default(''),
}).superRefine((b, ctx) => {
  if (b.kind === 'url') {
    let ok = false;
    try { ok = new URL(b.url).protocol === 'https:'; } catch { /* inválida */ }
    if (!ok) ctx.addIssue({ code: 'custom', path: ['url'], message: 'El enlace del botón debe empezar con https://' });
    return;
  }
  if (b.action === 'start_sequence' && !b.sequence_id) ctx.addIssue({ code: 'custom', path: ['sequence_id'], message: 'Elige el flujo que empieza al tocar el botón' });
  if (b.action === 'tag' && !b.tag) ctx.addIssue({ code: 'custom', path: ['tag'], message: 'Escribe la etiqueta que se agrega al tocar el botón' });
});
export type FlowButton = z.infer<typeof FlowButtonSchema>;

export const SequenceStepSchema = z.object({
  /** Espera desde el paso anterior (o desde la inscripción). */
  delay_value: z.number().int().min(0).max(10000).default(0),
  delay_unit: z.enum(['minutes', 'hours', 'days']).default('hours'),
  /** Si se indica, se envía a esa hora (del día en que toque o el siguiente). */
  at_time: z.union([HHMM, z.literal('')]).default(''),
  text: z.string().max(4000).default(''),
  image_id: z.string().default(''),
  attachment_id: AttachmentRef,
  /** WhatsApp oficial: plantilla para cuando el cliente no escribió en las últimas 24 h. */
  wa_template: WaTemplateRefSchema,
  /** Solo se envía si se cumplen (si no, se salta el paso). */
  conditions: z.array(ConditionSchema).max(10).default([]),
  /** Botones del mensaje: hasta 3 de respuesta (cada uno con su acción) y 2 de enlace. */
  buttons: z.array(FlowButtonSchema).max(5).default([]).superRefine((list, ctx) => {
    if (list.filter((b) => b.kind === 'reply').length > 3) ctx.addIssue({ code: 'custom', message: 'Máximo 3 botones de respuesta por mensaje' });
    if (list.filter((b) => b.kind === 'url').length > 2) ctx.addIssue({ code: 'custom', message: 'Máximo 2 botones de enlace por mensaje' });
    const labels = list.map((b) => normalizeLabel(b.label));
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', message: 'Dos botones no pueden decir lo mismo' });
  }),
  /** El paso siguiente espera a que el cliente elija; si llega su hora sin elección, se aplica `if_no_choice`. */
  wait_for_choice: z.boolean().default(false),
  if_no_choice: z.enum(['end', 'continue']).default('end'),
}).refine((st) => !st.buttons.length || !!st.text.trim(), { message: 'Escribe el mensaje que acompaña a los botones', path: ['text'] });
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
  /** Reparto entre las personas asignadas: por turnos o por porcentajes (`user_weights`). */
  assignment_mode: z.enum(['round_robin', 'weighted']).default('round_robin'),
  /** Porcentaje de citas de cada persona (por id). Sin valor = partes iguales; 0 = solo si nadie más puede. */
  user_weights: z.record(z.string().uuid(), z.number().min(0).max(100)).default({}),
  /** Llamadas: telefónica (la persona le marca al cliente) o videollamada (con enlace de Meet, Teams o el suyo). */
  call_mode: z.enum(['phone', 'video']).default('phone'),
  /** Primero con quien ya atiende al cliente en la conversación (si está libre); si no, según el reparto. */
  prefer_owner: z.boolean().default(false),
  /** El cliente puede pedir una persona por su nombre (el agente le ofrece sus horarios). */
  customer_choice: z.boolean().default(false),
  notify_team: z.boolean().default(true),
  /** Anticipo para confirmar la cita: un monto fijo (0 = sin anticipo). Se cobra con los recordatorios de pago. */
  deposit_cents: z.number().int().min(0).max(100_000_000_000).default(0),
  deposit_currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('MXN'),
  /** Horas antes de la cita en que vence el anticipo (0 = el día que se agenda). */
  deposit_due_hours: z.number().int().min(0).max(720).default(0),
  /** Si a esa hora no se pagó, la cita se cancela sola y se avisa al cliente y al equipo. */
  deposit_cancel_unpaid: z.boolean().default(false),
  /** WhatsApp oficial fuera de la ventana de 24 h: el recordatorio sale con esta plantilla aprobada. */
  reminder_wa_template: WaTemplateRefSchema,
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
  /** Videollamada: enlace para entrar (de Meet, Teams o el enlace fijo de la persona). */
  meeting_url?: string;
  /** Reservas desde la página pública: correo del cliente para confirmarle. */
  customer_email?: string;
  /** Nombre de la persona asignada (en las consultas que lo traen). */
  assigned_user_name?: string | null;
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
  /** Etapa del recorrido a la que se llegó (stage_reached). */
  step?: number;
  tag?: string;
  appointment?: Appointment;
  /** Evita bucles: acciones que disparan otros eventos. */
  depth?: number;
  /** Cambio de columna en un pipeline (pipeline_stage). */
  pipeline?: { id: string; name: string; stage_id: string; stage_name: string; stage_kind: string; from_stage_id: string | null; from_stage_name: string | null; reason: string; value: number; currency: string };
  /** Transferencia hecha por una persona del equipo que tomó la conversación (ella ya la atiende: no se reparte). */
  byUserId?: string;
  /** Desde dónde se pasó a una persona: 'telefono' = alguien ya contestó desde el teléfono (no se avisa de una espera). */
  via?: 'bot' | 'regla' | 'panel' | 'telefono' | '';
  /** Número del encargado del agente que ya recibió su propio aviso de esta transferencia (no se le manda otro). */
  managerNotified?: string;
  /** Cotización enviada, por aprobar o rechazada. */
  quote?: { id: string; folio: string; kind: 'approximate' | 'final'; total: string; /** AAAA-MM-DD */ valid_until?: string };
  /** Cobro del evento (payment_*): sus variables {{pago.concepto}}, {{pago.monto}}… */
  payment?: Record<string, string>;
}
