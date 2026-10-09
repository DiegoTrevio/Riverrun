import { z } from 'zod';

/**
 * Toda la configuración de un chatbot vive en PostgreSQL como JSON.
 * Estos esquemas definen su forma y los valores por defecto, de modo que
 * una configuración parcial (o vieja) siempre se completa de forma segura.
 */

export const PersonalitySchema = z.object({
  /** Nombre con el que se presenta el asistente (opcional). */
  assistant_name: z.string().default(''),
  /** Prompt principal: quién es, a quién atiende, cómo vende/atiende. */
  prompt: z.string().default(''),
  /** Etiquetas de tono: natural, profesional, casual, mexicano, formal, cálido, etc. */
  tone: z.array(z.string()).default(['natural', 'cercano']),
  language: z.string().default('español de México'),
  response_length: z.enum(['muy_corta', 'corta', 'media', 'detallada']).default('corta'),
  emojis: z.enum(['none', 'few', 'normal']).default('few'),
  /** Tratar al cliente de "tú" o de "usted". */
  formality: z.enum(['tu', 'usted']).default('tu'),
  /** Ejemplos de cómo escribe el negocio, para imitar el estilo. */
  style_examples: z.array(z.string()).default([]),
});
export type Personality = z.infer<typeof PersonalitySchema>;

export const RulesSchema = z.object({
  /** Qué hacer si el dato no está en la información del negocio. */
  unknown_info_behavior: z.enum(['say_unknown', 'ask', 'handoff']).default('say_unknown'),
  /** Mensaje de respaldo si el validador bloquea una respuesta no verificable. */
  fallback_message: z.string().default('Ese dato no lo tengo confirmado, déjame revisarlo con el equipo y te aviso.'),
  /** Temas de los que sí puede hablar (texto libre). */
  allowed_topics: z.string().default(''),
  forbidden_topics: z.array(z.string()).default([]),
  /** Reglas libres: "Nunca ofrezcas descuentos", "Siempre pide la fecha antes de cotizar", ... */
  custom_rules: z.array(z.string()).default([]),
  /** Criterio general de cuándo enviar imágenes. */
  image_rules: z.string().default(''),
  max_images_per_reply: z.number().int().min(0).max(5).default(2),
  avoid_repeating_images: z.boolean().default(true),
  /** Situaciones en las que la IA debe pasar la conversación a una persona. */
  handoff_rules: z.array(z.string()).default([
    'El cliente pide explícitamente hablar con una persona',
    'El cliente está molesto o tiene una queja',
    'El cliente quiere confirmar un pago, reservación o compra',
  ]),
  /** Palabras que disparan la transferencia sin consultar a la IA. */
  handoff_keywords: z.array(z.string()).default(['asesor', 'humano', 'persona real', 'hablar con alguien']),
  handoff_message: z.string().default('Claro, te comunico con alguien del equipo. En un momento te atienden.'),
  /** Número (solo dígitos, con lada) que recibe un aviso cuando hay transferencia. */
  handoff_notify_number: z.string().default(''),
  /** Si un humano responde desde el teléfono, el bot se pausa en esa conversación. */
  pause_on_human_reply: z.boolean().default(true),
  /** Minutos tras los cuales el bot retoma una conversación transferida (0 = nunca). */
  auto_resume_minutes: z.number().int().min(0).default(0),
  /** Permitir que la IA agende y cancele citas/llamadas con los servicios de la agenda. */
  booking_enabled: z.boolean().default(true),
  /** Verificar que precios, números, URLs, correos y teléfonos existan en el contexto. */
  verify_facts: z.boolean().default(true),
  /**
   * Afirmaciones sin números ("sí tenemos alberca"): deben aparecer en la información del negocio.
   * 'reglas' = comprobación rápida y gratuita; 'estricto' = además un modelo barato juzga la respuesta; 'apagado' = no se revisa.
   */
  verify_claims: z.enum(['apagado', 'reglas', 'estricto']).default('reglas'),
  /** Frases prohibidas (suenan a robot). Si aparecen, se regenera la respuesta. */
  banned_phrases: z.array(z.string()).default([
    'como modelo de lenguaje',
    'como inteligencia artificial',
    'como una ia',
    'soy un asistente virtual',
    'en qué más puedo asistirte',
    'no dudes en contactarnos',
    'estimado cliente',
  ]),
  /** Activadores y desactivadores del asistente (los aplica el sistema, no la IA). */
  activation: z
    .object({
      /** always: responde siempre · keywords: solo después de que el cliente escriba una palabra de activación. */
      mode: z.enum(['always', 'keywords']).default('always'),
      /** Encienden al asistente (modo palabras) y lo reactivan si está en pausa (ambos modos). */
      on_keywords: z.array(z.string()).default([]),
      /** El cliente escribe una de estas: el asistente se apaga en esa conversación. */
      off_keywords: z.array(z.string()).default([]),
      /** Cuando el cliente ya dio TODOS estos datos, se apaga después de responder. */
      off_when_fields: z.array(z.string()).default([]),
      off_on_goal: z.boolean().default(false),
      off_on_booking: z.boolean().default(false),
      /** pause: deja de responder sin avisar · handoff: pasa a una persona · close: cierra la conversación. */
      off_action: z.enum(['pause', 'handoff', 'close']).default('pause'),
      /** Mensaje opcional que se envía al apagarse. */
      off_message: z.string().max(1000).default(''),
      /** Horas tras las que se reactiva solo (0 = solo con palabra de activación o a mano). */
      resume_after_hours: z.number().min(0).max(720).default(0),
    })
    .default({ mode: 'always', on_keywords: [], off_keywords: [], off_when_fields: [], off_on_goal: false, off_on_booking: false, off_action: 'pause', off_message: '', resume_after_hours: 0 }),
});
export type Rules = z.infer<typeof RulesSchema>;
export type Activation = Rules['activation'];

export const DataFieldSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/, 'solo minúsculas, números y guion bajo'),
  label: z.string(),
  type: z.enum(['text', 'name', 'email', 'phone', 'date', 'number', 'option']).default('text'),
  description: z.string().default(''),
  options: z.array(z.string()).default([]),
  required: z.boolean().default(false),
  /** Cuándo pedir el dato, p.ej. "cuando el cliente quiera cotizar". */
  ask_when: z.string().default(''),
});
export type DataField = z.infer<typeof DataFieldSchema>;
export const DataFieldsSchema = z.array(DataFieldSchema).default([]);

export const FlowSchema = z.object({
  /** Objetivo de la conversación, p.ej. "agendar una visita". */
  goal: z.string().default(''),
  /** Etapas sugeridas (no es un guion rígido). */
  steps: z.array(z.object({ title: z.string(), description: z.string().default('') })).default([]),
  /** Qué hacer cuando se cumple el objetivo. */
  on_goal_completed: z.string().default(''),
  /** Saludo sugerido para el primer mensaje (la IA lo adapta). */
  greeting: z.string().default(''),
  /** Qué hace el sistema (no la IA) la primera vez que se cumple el objetivo. */
  on_goal_action: z.enum(['none', 'handoff', 'notify']).default('none'),
});
export type Flow = z.infer<typeof FlowSchema>;

export const AiSettingsSchema = z.object({
  model: z.string().default(''),
  /** Modelos de respaldo de este asistente (vacío = los globales de OPENROUTER_FALLBACK_MODELS). */
  fallback_models: z.array(z.string().trim().min(1).max(120)).max(2).default([]),
  temperature: z.number().min(0).max(2).nullable().default(0.4),
  reasoning_effort: z.enum(['', 'minimal', 'low', 'medium', 'high']).default(''),
  /** Mensajes recientes que se envían tal cual a la IA. */
  recent_messages: z.number().int().min(2).max(60).default(14),
  /** Cuántos mensajes fuera de la ventana reciente disparan un nuevo resumen. */
  summary_batch: z.number().int().min(4).max(100).default(16),
  /** Espera tras el último mensaje del cliente antes de responder (agrupa mensajes seguidos). */
  debounce_seconds: z.number().min(0).max(60).default(5),
  /** Mostrar "escribiendo..." proporcional al largo de la respuesta. */
  typing_simulation: z.boolean().default(true),
  transcribe_audio: z.boolean().default(false),
  max_bubbles: z.number().int().min(1).max(5).default(3),
  max_chars_per_bubble: z.number().int().min(80).max(2000).default(450),
  /** Presupuesto de caracteres de conocimiento por llamada (controla costo). */
  knowledge_char_budget: z.number().int().min(1000).max(200000).default(24000),
  timezone: z.string().default('America/Mexico_City'),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/**
 * Mensaje guardado: texto (y foto opcional) que se envía tal cual, sin que la IA lo reescriba.
 * La IA lo elige por su código; si tiene foto, el texto va como pie de la foto en un solo mensaje.
 */
export const SavedMessageSchema = z
  .object({
    code: z.string().trim().toLowerCase().min(1, 'El código es obligatorio').max(40).regex(/^[a-z0-9_-]+$/, 'Código: solo letras, números, guion y guion bajo'),
    title: z.string().trim().max(120).default(''),
    text: z.string().trim().max(1000).default(''),
    /** Foto del catálogo de este asistente ('' = sin foto). */
    image_id: z.string().trim().max(60).default(''),
    /** Cuándo debe usarlo la IA. */
    when: z.string().trim().max(300).default(''),
    /** Etapa del recorrido en la que queda la conversación al enviarlo (0 = no cambia). */
    flow_step: z.number().int().min(0).max(50).default(0),
    active: z.boolean().default(true),
  })
  .refine((m) => m.text || m.image_id, { message: 'El mensaje guardado necesita texto o foto' });
export type SavedMessage = z.infer<typeof SavedMessageSchema>;
export const SavedMessagesSchema = z
  .array(SavedMessageSchema)
  .max(40)
  .refine((list) => new Set(list.map((m) => m.code)).size === list.length, { message: 'Hay mensajes guardados con el mismo código' });

export interface ChatbotRow {
  id: string;
  account_id: string;
  name: string;
  active: boolean;
  personality: unknown;
  rules: unknown;
  data_fields: unknown;
  flow: unknown;
  ai: unknown;
  saved_messages: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface Chatbot extends Omit<ChatbotRow, 'personality' | 'rules' | 'data_fields' | 'flow' | 'ai' | 'saved_messages'> {
  personality: Personality;
  rules: Rules;
  data_fields: DataField[];
  flow: Flow;
  ai: AiSettings;
  saved_messages: SavedMessage[];
}

/** Normaliza una fila de la BD a una configuración completa y válida. */
export function hydrateChatbot(row: ChatbotRow): Chatbot {
  return {
    ...row,
    personality: PersonalitySchema.parse(row.personality ?? {}),
    rules: RulesSchema.parse(row.rules ?? {}),
    data_fields: safeFields(row.data_fields),
    flow: FlowSchema.parse(row.flow ?? {}),
    ai: AiSettingsSchema.parse(row.ai ?? {}),
    saved_messages: safeSavedMessages(row.saved_messages),
  };
}

/** Un mensaje guardado inválido no rompe al asistente: se descarta solo ese. */
function safeSavedMessages(v: unknown): SavedMessage[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((m) => {
    const r = SavedMessageSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

function safeFields(v: unknown): DataField[] {
  const r = DataFieldsSchema.safeParse(v ?? []);
  return r.success ? r.data : [];
}

export interface KnowledgeItem {
  id: string;
  chatbot_id: string;
  category: string;
  title: string;
  content: string;
  always_include: boolean;
  active: boolean;
  sort_order: number;
  /** Página web de la que se importó (para volver a sincronizar). */
  source_url?: string | null;
}

/** Reglas de envío: momentos concretos y condiciones de contexto interpretadas por la IA. */
export const ImageSendWhenSchema = z.object({
  /** ai: la IA decide (según "Cuándo enviarla") · rules: solo en los momentos marcados · both: ambos. */
  mode: z.enum(['ai', 'rules', 'both']).default('ai'),
  /** Condición semántica evaluada con la conversación, sin exigir palabras exactas. */
  context: z.string().trim().max(500).default(''),
  /** El cliente escribe alguna de estas palabras o frases. */
  keywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  /** El asistente dice o pregunta alguna de estas frases en su respuesta validada. */
  assistant_keywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  /** Con la primera respuesta a un cliente nuevo (bienvenida). */
  first_message: z.boolean().default(false),
  /** Al llegar a estas etapas del recorrido (1..n). */
  flow_steps: z.array(z.number().int().min(1).max(30)).max(30).default([]),
  on_goal: z.boolean().default(false),
  on_booking: z.boolean().default(false),
  /** Una sola vez por conversación (las palabras clave sí la vuelven a enviar si el cliente la pide de nuevo). */
  once: z.boolean().default(true),
});
export type ImageSendWhen = z.infer<typeof ImageSendWhenSchema>;

/** Configuración "cuándo se envía" completa y válida (las fotos viejas quedan en "la IA decide"). */
export function imageSendWhen(img: Pick<ImageAsset, 'send_when'>): ImageSendWhen {
  const r = ImageSendWhenSchema.safeParse(img.send_when ?? {});
  return r.success ? r.data : ImageSendWhenSchema.parse({});
}

export interface ImageAsset {
  id: string;
  /** Huella SHA-256 del archivo (vacía en fotos subidas antes de la verificación). */
  sha256?: string;
  chatbot_id: string;
  code: string;
  name: string;
  description: string;
  usage_rule: string;
  caption: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  active: boolean;
  send_when?: unknown;
}

export interface Contact {
  id: string;
  account_id: string;
  channel_id: string;
  /** Identificador del cliente en la plataforma (JID de WhatsApp, chat de Telegram, PSID de Meta, sesión web...). */
  external_id: string;
  phone: string;
  push_name: string;
  name: string;
  data: Record<string, string>;
  notes: string[];
  tags: string[];
  opted_out: boolean;
  /** Cuándo aceptó recibir promociones (null = no ha aceptado). */
  consent_at?: Date | null;
  consent_source?: string;
  /** Última vez que una persona tomó la conversación del contacto: cuándo, desde dónde y quién (migración 031). */
  handoff_at?: Date | null;
  handoff_by?: string | null;
  handoff_via?: '' | 'telefono' | 'panel' | 'regla' | 'bot';
}

/** Pendiente (se marca como hecho) o nota (solo informa), de un contacto. Puede vincularse a la conversación donde se quedó. */
export interface ContactTask {
  id: string;
  account_id: string;
  contact_id: string;
  conversation_id: string | null;
  kind: 'pendiente' | 'nota';
  body: string;
  status: 'abierta' | 'hecha';
  /** Fecha límite (AAAA-MM-DD); solo para pendientes. */
  due_on: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_via: 'panel' | 'regla';
  done_at: Date | null;
  done_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type ConversationStatus = 'bot' | 'human' | 'closed';

export interface Conversation {
  id: string;
  account_id: string;
  channel_id: string;
  /** Chatbot que atiende (el asignado al canal); null si el canal no tiene chatbot. */
  chatbot_id: string | null;
  contact_id: string;
  status: ConversationStatus;
  status_changed_at: Date;
  handoff_reason: string;
  summary: string;
  summary_until_id: number;
  data: Record<string, string>;
  data_version: number;
  report_summary: string;
  /** Intención, ánimo, interés, acuerdos y pendientes de la conversación (compacto). */
  report_analysis?: Record<string, unknown>;
  report_until_id: number;
  report_at: Date | null;
  report_data_version: number;
  last_message_at: Date;
  /** Persona del equipo a cargo (round robin o manual). */
  assigned_user_id?: string | null;
  assigned_at?: Date | null;
  /** Etapa del recorrido en la que va (1..n; 0 = sin etapa). */
  flow_step?: number;
  /** Cuándo se cumplió el objetivo de la conversación (null = aún no). */
  goal_completed_at?: Date | null;
  /** Inicio del recorrido actual (al reabrir o borrar la memoria); las fotos "una sola vez" se cuentan desde aquí. */
  flow_started_at?: Date | null;
  /** Asistente en pausa en esta conversación (null = no), por qué y hasta cuándo (null = hasta reactivarlo). */
  agent_off_at?: Date | null;
  agent_off_reason?: string;
  agent_off_until?: Date | null;
  /** Cuándo lo encendió una palabra de activación (modo "solo con palabras"). */
  agent_on_at?: Date | null;
}

export interface Message {
  id: number;
  conversation_id: string;
  direction: 'in' | 'out';
  sender: 'customer' | 'bot' | 'human' | 'system';
  type: string;
  content: string;
  image_id: string | null;
  external_message_id: string | null;
  processed: boolean;
  status: string;
  meta: Record<string, any>;
  created_at: Date;
}

/* ------------------------------ Cuentas y usuarios ------------------------------ */

export type Role = 'superadmin' | 'admin' | 'agent';

export type AccountStatus = 'trial' | 'active' | 'paused';

export interface Account {
  brand_id?: string | null;
  id: string;
  name: string;
  active: boolean;
  status: AccountStatus;
  plan: string;
  trial_ends_at: Date | null;
  trial_warned_at: Date | null;
  business_type: string;
  owner_user_id: string | null;
  onboarding: Record<string, boolean>;
  signup_source: string;
  ai_alert_month: string;
  limits_override?: Record<string, number>;
  created_at: Date;
}

export interface User {
  id: string;
  account_id: string | null;
  role: Role;
  name: string;
  email: string;
  phone: string;
  notify_whatsapp: boolean;
  /** Disponible para recibir conversaciones por turnos. */
  available: boolean;
  active: boolean;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

/* ---------------------------------- Canales ---------------------------------- */

export const CHANNEL_TYPES = ['whatsapp', 'telegram', 'messenger', 'instagram', 'webchat', 'email', 'zernio'] as const;
export type PublicChannelType = (typeof CHANNEL_TYPES)[number];
export type ChannelType = PublicChannelType | 'playground';

export interface Channel {
  id: string;
  account_id: string;
  chatbot_id: string | null;
  type: ChannelType;
  name: string;
  active: boolean;
  config: Record<string, any>;
  webhook_token: string;
  created_at: Date;
  updated_at: Date;
  /** Viene de un JOIN con accounts. */
  account_active?: boolean;
  /** Último estado de conexión conocido (WhatsApp: open | connecting | close). */
  connection_state?: string;
  connection_state_at?: Date | null;
  /** Último QR / código de vinculación de WhatsApp (solo para la sesión de conexión; nunca al panel). */
  qr_code?: string | null;
  qr_at?: Date | null;
  pairing_code?: string | null;
  pairing_number?: string | null;
  pairing_at?: Date | null;
}

const secret = z.string().max(1000);

/** Configuración de cada plataforma. Los campos secretos nunca se devuelven completos al panel. */
export const ChannelConfigSchemas = {
  whatsapp: z.object({
    instance: z.string().regex(/^[A-Za-z0-9_-]*$/, 'Instancia: solo letras, números, guion y guion bajo').max(60).default(''),
    number: z.string().max(30).default(''),
    /** Nombre del perfil de WhatsApp vinculado (lo guarda el sistema al conectar). */
    profile_name: z.string().max(120).default(''),
    url: z.string().max(300).default(''),
    api_key: secret.default(''),
  }),
  telegram: z.object({
    bot_token: secret.default(''),
    bot_username: z.string().max(100).default(''),
    secret: z.string().max(200).default(''),
  }),
  messenger: z.object({
    page_id: z.string().max(60).default(''),
    page_access_token: secret.default(''),
    app_secret: secret.default(''),
    verify_token: z.string().max(200).default(''),
    graph_version: z.string().max(10).default('v21.0'),
  }),
  instagram: z.object({
    account_id: z.string().max(60).default(''),
    page_access_token: secret.default(''),
    app_secret: secret.default(''),
    verify_token: z.string().max(200).default(''),
    graph_version: z.string().max(10).default('v21.0'),
  }),
  webchat: z.object({
    title: z.string().max(80).default('¿En qué te ayudamos?'),
    subtitle: z.string().max(120).default('Normalmente respondemos en segundos'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #RRGGBB').default('#128c7e'),
    welcome_message: z.string().max(500).default('¡Hola! 👋 ¿En qué te puedo ayudar?'),
    launcher_text: z.string().max(40).default('Chatea con nosotros'),
    /** Dominios que pueden insertar el chat (vacío = cualquiera). */
    allowed_origins: z.array(z.string().max(200)).default([]),
  }),
  /** Zernio: API unificada de mensajes. Las credenciales se usan solo en el servidor. */
  zernio: z.object({
    /** Red que se conecta (p.ej. bluesky, reddit, twitter), tal como la nombra Zernio. */
    platform: z.string().trim().toLowerCase().max(40).default(''),
    /** Perfil de Zernio donde queda la cuenta conectada. */
    profile_id: z.string().trim().max(100).default(''),
    /** Cuenta conectada en Zernio (la llena el flujo de conexión). */
    account_id: z.string().max(100).default(''),
    username: z.string().max(120).default(''),
    api_key: secret.default(''),
    /** Secreto con el que se firman los webhooks de Zernio. Se genera al crear el canal. */
    webhook_secret: secret.default(''),
    /** Nonce de un solo uso del flujo de conexión; evita callbacks falsos. */
    connect_state: z.string().max(200).default(''),
  }),
  email: z.object({
    /** gmail | outlook | otro: solo rellena servidores por defecto en el panel. */
    provider: z.enum(['gmail', 'outlook', 'otro']).default('otro'),
    imap_host: z.string().max(200).default(''),
    imap_port: z.number().int().min(1).max(65535).default(993),
    imap_user: z.string().max(200).default(''),
    imap_password: secret.default(''),
    smtp_host: z.string().max(200).default(''),
    smtp_port: z.number().int().min(1).max(65535).default(587),
    /** Vacíos = los mismos que IMAP. */
    smtp_user: z.string().max(200).default(''),
    smtp_password: secret.default(''),
    from_address: z.string().max(200).default(''),
    from_name: z.string().max(100).default(''),
    /** Lo guarda el sistema: último correo ya leído. */
    last_uid: z.number().int().min(0).default(0),
    uid_validity: z.number().int().min(0).default(0),
    last_error: z.string().max(300).default(''),
  }),
  playground: z.object({}),
} as const;

export const SECRET_FIELDS = ['api_key', 'bot_token', 'page_access_token', 'app_secret', 'imap_password', 'smtp_password', 'webhook_secret', 'connect_state'];
export const MASK = '••••••';

export function channelConfig(type: ChannelType, config: unknown): Record<string, any> {
  const schema = ChannelConfigSchemas[type] as z.ZodType<Record<string, any>>;
  const r = schema.safeParse(config ?? {});
  return r.success ? r.data : schema.parse({});
}

export const KNOWLEDGE_CATEGORIES = [
  'general',
  'servicios',
  'productos',
  'precios',
  'horarios',
  'ubicaciones',
  'condiciones',
  'preguntas_frecuentes',
  'promociones',
  'otro',
] as const;
