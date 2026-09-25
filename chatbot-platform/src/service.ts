import type { AiProvider } from './ai/provider.js';
import { Engine, type ProcessResult } from './engine/engine.js';
import { ConversationQueue } from './engine/queue.js';
import { EvolutionTransport, PlaygroundTransport, type Transport } from './engine/transport.js';
import { EvolutionClient } from './evolution/client.js';
import { describeIncoming, type IncomingMessage } from './evolution/parse.js';
import { logEvent } from './logs.js';
import { query } from './db.js';
import * as store from './store/index.js';
import type { Chatbot, Contact, Conversation } from './types.js';

export type TransportFactory = (bot: Chatbot, contact: Contact) => Transport;

/** Orquesta: webhook → almacenamiento → cola → motor → envío. */
export class ChatService {
  engine: Engine;
  queue: ConversationQueue;

  constructor(private ai: AiProvider, private transportFactory: TransportFactory = (b, c) => new EvolutionTransport(b, c)) {
    this.engine = new Engine(ai);
    this.queue = new ConversationQueue((id, a) => this.runWhatsapp(id, a.restarts));
  }

  private async runWhatsapp(conversationId: string, restarts: number): Promise<ProcessResult> {
    const conv = await store.getConversation(conversationId);
    if (!conv) return { status: 'nothing' };
    const [bot, contact] = await Promise.all([store.getChatbot(conv.chatbot_id), store.getContact(conv.contact_id)]);
    if (!bot || !contact) return { status: 'nothing' };
    let transport: Transport;
    try {
      transport = this.transportFactory(bot, contact);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'engine', message: e?.message ?? String(e), chatbotId: bot.id, conversationId });
      await store.markAllProcessed(conversationId);
      return { status: 'nothing' };
    }
    return this.engine.process(conversationId, transport, { allowRestart: this.queue.canRestart(restarts) });
  }

  /** Maneja un mensaje ya normalizado que llegó por el webhook de Evolution. */
  async handleIncoming(bot: Chatbot, msg: IncomingMessage): Promise<void> {
    if (bot.evolution_instance && msg.instance && msg.instance !== bot.evolution_instance) {
      await logEvent({
        level: 'warn',
        source: 'webhook',
        message: `Webhook de la instancia "${msg.instance}" no coincide con la del chatbot ("${bot.evolution_instance}"); se ignora`,
        chatbotId: bot.id,
      });
      return;
    }
    const contact = await store.upsertContact(bot.id, msg.jid, msg.phone, msg.fromMe ? '' : msg.pushName);
    const conv = await store.getOrCreateConversation(bot.id, contact.id);

    if (msg.fromMe) return this.handleOwnMessage(bot, conv, msg);

    let content = describeIncoming(msg);
    if (msg.type === 'audio' && bot.ai.transcribe_audio && bot.evolution_instance) {
      try {
        const media = await EvolutionClient.forChatbot(bot).getMediaBase64(bot.evolution_instance, msg.messageId);
        if (media.base64) {
          const text = await this.ai.transcribe(Buffer.from(media.base64, 'base64'), media.mimetype);
          if (text) content = `[Nota de voz del cliente, transcrita]: "${text}"`;
        }
      } catch (e: any) {
        await logEvent({ level: 'warn', source: 'ai', message: `No se pudo transcribir la nota de voz: ${e?.message ?? e}`, chatbotId: bot.id, conversationId: conv.id });
      }
    }

    const triggers = msg.type !== 'reaction';
    const inserted = await store.insertMessage({
      conversation_id: conv.id,
      direction: 'in',
      sender: 'customer',
      type: msg.type,
      content,
      evolution_message_id: msg.messageId,
      processed: !triggers,
      meta: { push_name: msg.pushName },
    });
    if (!inserted) return; // duplicado

    let current = conv;
    if (conv.status === 'human' && bot.rules.auto_resume_minutes > 0) {
      const lastHuman = await store.lastHumanActivity(conv.id);
      const since = Math.max(new Date(conv.status_changed_at).getTime(), lastHuman ? new Date(lastHuman).getTime() : 0);
      if (Date.now() - since > bot.rules.auto_resume_minutes * 60_000) {
        current = (await store.setConversationStatus(conv.id, 'bot', '')) ?? conv;
        await logEvent({ level: 'info', source: 'engine', message: 'El bot retomó la conversación automáticamente', chatbotId: bot.id, conversationId: conv.id });
      }
    }

    if (!triggers) return;
    if (current.status !== 'bot' || !bot.active) {
      await store.markProcessed(conv.id, inserted.id);
      return;
    }
    this.queue.schedule(conv.id, bot.ai.debounce_seconds * 1000);
  }

  /** Mensaje enviado desde el propio WhatsApp del negocio: eco nuestro o respuesta de un humano. */
  private async handleOwnMessage(bot: Chatbot, conv: Conversation, msg: IncomingMessage) {
    const content = describeIncoming(msg).replace(/^\[El cliente /, '[Se ');
    const known =
      (await store.findMessageByEvolutionId(conv.id, msg.messageId)) ??
      (msg.text ? await store.findRecentOutgoingEcho(conv.id, msg.text) : null) ??
      (msg.type === 'image' ? await store.findRecentOutgoingImageEcho(conv.id) : null);
    if (known) {
      if (!known.evolution_message_id) await store.updateMessage(known.id, { evolution_message_id: msg.messageId });
      return;
    }
    await store.insertMessage({
      conversation_id: conv.id,
      direction: 'out',
      sender: 'human',
      type: msg.type,
      content: msg.type === 'text' ? msg.text : content,
      evolution_message_id: msg.messageId,
      meta: { source: 'phone' },
    });
    if (bot.rules.pause_on_human_reply && conv.status === 'bot') {
      await store.setConversationStatus(conv.id, 'human', 'Una persona respondió desde WhatsApp');
      await store.markAllProcessed(conv.id);
      await logEvent({ level: 'info', source: 'engine', message: 'Bot pausado: una persona respondió desde el teléfono', chatbotId: bot.id, conversationId: conv.id });
    }
  }

  /** Simulador del panel: mismo motor, sin WhatsApp. */
  async playground(bot: Chatbot, session: string, text: string) {
    const contact = await store.upsertContact(bot.id, `playground:${session}`, '', 'Prueba', 'playground');
    const conv = await store.getOrCreateConversation(bot.id, contact.id);
    await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', type: 'text', content: text, processed: false });
    const transport = new PlaygroundTransport();
    const result = await this.queue.exclusive(conv.id, () => this.engine.process(conv.id, transport, { ignoreInactive: true }));
    const [freshContact, freshConv] = await Promise.all([store.getContact(contact.id), store.getConversation(conv.id)]);
    return {
      outputs: transport.outputs,
      result: {
        status: result.status,
        action: result.plan?.action,
        thinking: (result.decision as any)?.thinking ?? '',
        info_not_found: result.plan?.infoNotFound ?? false,
        fallback_used: result.fallbackUsed ?? false,
        attempts: result.attempts ?? [],
        error: result.error,
      },
      contact: freshContact,
      conversation: freshConv,
    };
  }

  async resetPlayground(bot: Chatbot, session: string) {
    await query(`DELETE FROM contacts WHERE chatbot_id = $1 AND jid = $2`, [bot.id, `playground:${session}`]);
  }

  /** Mensaje manual desde el panel. */
  async sendManual(conversationId: string, text: string) {
    const conv = await store.getConversation(conversationId);
    if (!conv) throw new Error('Conversación no encontrada');
    const [bot, contact] = await Promise.all([store.getChatbot(conv.chatbot_id), store.getContact(conv.contact_id)]);
    if (!bot || !contact) throw new Error('Datos incompletos');
    const transport = contact.channel === 'playground' ? new PlaygroundTransport() : this.transportFactory(bot, contact);
    const sent = await this.engine.sendOut(bot, conv, transport, { sender: 'human', text, delay: 0, meta: { source: 'panel' } });
    if (!sent) throw new Error('No se pudo enviar el mensaje (revisa los registros)');
    return sent;
  }

  /** Al arrancar: retoma conversaciones con mensajes sin responder de los últimos minutos. */
  async resumePending() {
    const rows = await query<{ conversation_id: string }>(
      `SELECT DISTINCT m.conversation_id FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
       WHERE m.processed = false AND m.direction = 'in' AND ct.channel = 'whatsapp' AND m.created_at > now() - interval '15 minutes'`,
    );
    for (const r of rows) this.queue.schedule(r.conversation_id, 2000);
    // Lo más viejo se marca como procesado para no responder fuera de contexto.
    await query(`UPDATE messages SET processed = true WHERE processed = false AND created_at <= now() - interval '15 minutes'`);
    return rows.length;
  }
}
