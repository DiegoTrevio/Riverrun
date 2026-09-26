import type { z } from 'zod';
import type { Transport } from '../engine/transport.js';
import type { Channel, ChannelType, Contact } from '../types.js';

/** Mensaje entrante normalizado, igual para todas las plataformas. */
export interface InboundMessage {
  messageId: string;
  /** Identificador del cliente en la plataforma. */
  externalId: string;
  phone: string;
  displayName: string;
  /** Enviado desde la cuenta del negocio (eco propio o respuesta manual de una persona). */
  fromMe: boolean;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contact' | 'reaction' | 'other';
  text: string;
  /** Segundos Unix. */
  timestamp: number;
  /** Referencia para descargar audio (transcripción). */
  media?: { id?: string; url?: string; mimeType?: string };
}

export interface WebhookRequest {
  channel: Channel;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: any;
  rawBody?: Buffer;
}

export interface ParseResult {
  messages: InboundMessage[];
  /** Eventos informativos para los registros (p.ej. cambios de conexión). */
  notices?: { level: 'info' | 'warn'; message: string }[];
}

export interface SetupResult {
  ok: boolean;
  message: string;
  /** Cambios de configuración a guardar (p.ej. nombre del bot de Telegram). */
  config?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface ChannelAdapter {
  type: ChannelType;
  label: string;
  /** Autenticidad de la petición (firma o secreto). Si devuelve false, se rechaza con 401. */
  verifyRequest?(req: WebhookRequest): boolean;
  /** Verificación por GET (Meta). Devuelve el texto a responder o null si no es válida. */
  handleVerification?(req: WebhookRequest): string | null;
  parse(req: WebhookRequest): ParseResult;
  transport(channel: Channel, contact: Contact): Transport;
  downloadAudio?(channel: Channel, msg: InboundMessage): Promise<{ buffer: Buffer; mimeType: string } | null>;
  /** Conecta/valida el canal con la plataforma (registrar webhook, validar token...). */
  setup?(channel: Channel, webhookUrl: string): Promise<SetupResult>;
  status?(channel: Channel): Promise<{ state: string; details?: Record<string, unknown> }>;
  /** Valores que se generan al crear el canal (p.ej. tokens de verificación). */
  initialConfig?(): Record<string, unknown>;
  configSchema: z.ZodType<Record<string, any>>;
}

export function describeInbound(m: Pick<InboundMessage, 'type' | 'text'>): string {
  switch (m.type) {
    case 'text':
      return m.text;
    case 'image':
      return m.text ? `[El cliente envió una imagen con el texto: "${m.text}"]` : '[El cliente envió una imagen]';
    case 'audio':
      return '[El cliente envió una nota de voz]';
    case 'video':
      return m.text ? `[El cliente envió un video: "${m.text}"]` : '[El cliente envió un video]';
    case 'document':
      return `[El cliente envió un documento${m.text ? `: ${m.text}` : ''}]`;
    case 'sticker':
      return '[El cliente envió un sticker]';
    case 'location':
      return `[El cliente compartió una ubicación${m.text ? `: ${m.text}` : ''}]`;
    case 'contact':
      return `[El cliente compartió un contacto${m.text ? `: ${m.text}` : ''}]`;
    case 'reaction':
      return m.text ? `[El cliente reaccionó con ${m.text}]` : '[El cliente quitó una reacción]';
    default:
      return '[El cliente envió un mensaje no compatible]';
  }
}
