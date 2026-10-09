import { PlaygroundTransport } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import * as astore from './store.js';
import { renderTemplate } from './templates.js';
import type { Appointment } from './types.js';

export interface OutboundOptions {
  text?: string;
  imageId?: string;
  /** automation | sequence | campaign | reminder | booking | no_reply | opt_out */
  source: string;
  /** Mensajes de servicio (recordatorios de cita, confirmaciones): se envían aunque el cliente se haya dado de baja de promociones. */
  transactional?: boolean;
  /** Enviar aunque una persona esté atendiendo la conversación. */
  allowWhenHuman?: boolean;
  appointment?: Appointment | null;
  location?: string;
  meta?: Record<string, unknown>;
  /** Etapa del recorrido en la que queda la conversación al enviarse (0 = no cambia). Así el asistente sigue el flujo desde ahí. */
  flowStep?: number;
}

export type OutboundResult = { sent: true } | { sent: false; reason: string };

const META_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Envío proactivo (no es respuesta a un mensaje): automatizaciones, secuencias, campañas y recordatorios.
 * Aplica las políticas antes de enviar: bajas, canal activo, conversación con humano y la ventana de 24 h (Meta y Zernio).
 */
export class Outbound {
  constructor(private chat: ChatService) {}

  async send(conversationId: string, o: OutboundOptions): Promise<OutboundResult> {
    const conv = await store.getConversation(conversationId);
    if (!conv) return { sent: false, reason: 'conversación inexistente' };
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) return { sent: false, reason: 'conversación incompleta' };
    if (!channel.active || channel.account_active === false) return { sent: false, reason: 'canal o cuenta inactivos' };
    if (contact.opted_out && !o.transactional) return { sent: false, reason: 'el cliente se dio de baja' };
    if (conv.status === 'human' && !o.allowWhenHuman) return { sent: false, reason: 'una persona está atendiendo la conversación' };
    if (channel.type === 'messenger' || channel.type === 'instagram' || channel.type === 'zernio') {
      // Meta solo permite escribir dentro de las 24 h posteriores al último mensaje del cliente. Zernio no documenta
      // las reglas de cada red, así que se aplica la misma política por prudencia.
      const last = await astore.lastInbound(conv.id);
      if (!last || Date.now() - new Date(last.created_at).getTime() > META_WINDOW_MS) {
        const reason = channel.type === 'zernio' ? 'fuera de la ventana de 24 h (el cliente no ha escrito recientemente)' : 'fuera de la ventana de 24 h de Meta (el cliente no ha escrito recientemente)';
        return { sent: false, reason };
      }
    }

    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const settings = await astore.getSettings(conv.account_id);
    const account = await store.getAccount(conv.account_id);
    const text = o.text
      ? renderTemplate(o.text, {
          contact,
          conversation: conv,
          businessName: bot?.name ?? account?.name ?? '',
          channelName: channel.name,
          appointment: o.appointment,
          location: o.location,
          timezone: settings.timezone,
        })
      : '';
    let image = null;
    if (o.imageId) {
      image = await store.getImage(o.imageId);
      const owner = image ? await store.getChatbot(image.chatbot_id) : null;
      if (!image || !image.active || owner?.account_id !== conv.account_id) image = null;
    }
    if (!text && !image) return { sent: false, reason: 'mensaje vacío' };

    const transport = channel.type === 'playground' ? new PlaygroundTransport() : this.chat.transportFor(channel, contact);
    const meta = { source: o.source, ...o.meta };
    // Nunca en paralelo con una respuesta del bot en la misma conversación.
    const ok = await this.chat.queue.exclusive(conv.id, async () => {
      if (image) {
        // Texto y foto juntos: un solo mensaje con el texto como pie (sin texto, el pie de la foto).
        const m = await this.chat.engine.sendOut(bot, conv, transport, { sender: 'bot', text: text || image.caption, image, delay: 0, meta });
        if (m) return true;
        // Si la plataforma rechaza la foto, el cliente igual recibe el texto.
        if (!text) return false;
        return !!(await this.chat.engine.sendOut(bot, conv, transport, { sender: 'bot', text, delay: 0, meta: { ...meta, image_failed: true } }));
      }
      return !!(await this.chat.engine.sendOut(bot, conv, transport, { sender: 'bot', text, delay: 0, meta }));
    });
    if (!ok) return { sent: false, reason: 'la plataforma rechazó el envío (ver registros)' };
    // El asistente continúa el recorrido desde la etapa indicada cuando el cliente responda.
    const steps = bot?.flow.steps.length ?? 0;
    if (o.flowStep && o.flowStep <= steps) await store.setFlowState(conv.id, o.flowStep, false);
    await logEvent({ level: 'info', source: 'engine', message: `Mensaje programado enviado (${o.source})`, accountId: conv.account_id, channelId: conv.channel_id, conversationId: conv.id });
    return { sent: true };
  }
}
