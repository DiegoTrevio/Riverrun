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
  name: string;
  active: boolean;
  whatsapp_number: string;
  evolution_instance: string | null;
  evolution_url: string | null;
  evolution_api_key: string | null;
  webhook_token: string;
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
  chatbot_id: string;
  jid: string;
  phone: string;
  push_name: string;
  name: string;
  data: Record<string, string>;
  notes: string[];
  channel: string;
}

export type ConversationStatus = 'bot' | 'human' | 'closed';

export interface Conversation {
  id: string;
  chatbot_id: string;
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
  evolution_message_id: string | null;
  processed: boolean;
  status: string;
  meta: Record<string, any>;
  created_at: Date;
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
