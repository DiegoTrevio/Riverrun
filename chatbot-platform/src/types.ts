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
  /** Verificar que precios, números, URLs, correos y teléfonos existan en el contexto. */
  verify_facts: z.boolean().default(true),
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
});
export type Rules = z.infer<typeof RulesSchema>;

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
});
export type Flow = z.infer<typeof FlowSchema>;

export const AiSettingsSchema = z.object({
  model: z.string().default(''),
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
  created_at: Date;
  updated_at: Date;
}

export interface Chatbot extends Omit<ChatbotRow, 'personality' | 'rules' | 'data_fields' | 'flow' | 'ai'> {
  personality: Personality;
  rules: Rules;
  data_fields: DataField[];
  flow: Flow;
  ai: AiSettings;
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
  };
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
}

export interface ImageAsset {
  id: string;
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
  last_message_at: Date;
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

export interface Account {
  id: string;
  name: string;
  active: boolean;
  created_at: Date;
}

export interface User {
  id: string;
  account_id: string | null;
  role: Role;
  name: string;
  email: string;
  active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

/* ---------------------------------- Canales ---------------------------------- */

export const CHANNEL_TYPES = ['whatsapp', 'telegram', 'messenger', 'instagram', 'webchat'] as const;
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
}

const secret = z.string().max(1000);

/** Configuración de cada plataforma. Los campos secretos nunca se devuelven completos al panel. */
export const ChannelConfigSchemas = {
  whatsapp: z.object({
    instance: z.string().regex(/^[A-Za-z0-9_-]*$/, 'Instancia: solo letras, números, guion y guion bajo').max(60).default(''),
    number: z.string().max(30).default(''),
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
  playground: z.object({}),
} as const;

export const SECRET_FIELDS = ['api_key', 'bot_token', 'page_access_token', 'app_secret'];
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
