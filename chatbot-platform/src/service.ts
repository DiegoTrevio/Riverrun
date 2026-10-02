import type { AiProvider } from './ai/provider.js';
import { Agenda } from './automation/agenda.js';
import { Automator } from './automation/automator.js';
import { Campaigns } from './automation/campaigns.js';
import { Outbound } from './automation/outbound.js';
import { Scheduler } from './automation/scheduler.js';
import { adapterFor } from './channels/index.js';
import { config } from './config.js';
import { describeInbound, type InboundMessage } from './channels/types.js';
import { query } from './db.js';
import { Engine, type ProcessResult } from './engine/engine.js';
import { ConversationQueue } from './engine/queue.js';
import { PlaygroundTransport, type Transport } from './engine/transport.js';
import { logEvent } from './logs.js';
import * as store from './store/index.js';
import type { Channel, Chatbot, Contact, Conversation } from './types.js';

/** Antigüedad máxima de un mensaje entrante para responderlo automáticamente. */
const MAX_MESSAGE_AGE_SECONDS = 30 * 60;

export type TransportFactory = (channel: Channel, contact: Contact) => Transport;

export const defaultTransport: TransportFactory = (channel, contact) => adapterFor(channel.type).transport(channel, contact);

/** Orquesta: webhook → almacenamiento → cola → motor → envío, para cualquier canal. */
export class ChatService {
  engine: Engine;
  queue: ConversationQueue;
  outbound: Outbound;
  automator: Automator;
  agenda: Agenda;
  campaigns: Campaigns;
  scheduler: Scheduler;

  constructor(private ai: AiProvider, private transportFactory: TransportFactory = defaultTransport) {
    this.outbound = new Outbound(this);
    this.automator = new Automator(this);
    this.agenda = new Agenda(this);
    this.campaigns = new Campaigns(this);
    this.engine = new Engine(ai, {
      intents: (accountId, chatbotId) => this.automator.intentsFor(accountId, chatbotId),
      agenda: this.agenda,
      onEvent: (e) => this.automator.emit(e),
      onOutbound: (conv, msg) => this.automator.onOutbound(conv, msg),
    });
    this.queue = new ConversationQueue((id, a) => this.runConversation(id, a.restarts));
    this.scheduler = new Scheduler({
      automation_send: (p) => this.automator.runDelayedSend(p),
      no_reply: (p) => this.automator.runNoReply(p),
      sequence_step: (p) => this.automator.runSequenceStep(p),
      appointment_reminder: (p) => this.agenda.sendReminder(p),
      campaign_start: (p) => this.campaigns.start(p.campaign_id),
      campaign_send: (p) => this.campaigns.sendOne(p),
    });
  }

  /** Aviso interno por WhatsApp (alertas al equipo), usando un WhatsApp activo de la cuenta. */
  async sendInternalWhatsapp(accountId: string, number: string, text: string, preferChatbotId?: string | null) {
    const channels = await store.listChannels(accountId);
    const wa =
      channels.find((c) => c.type === 'whatsapp' && c.active && c.chatbot_id === preferChatbotId && c.config.instance) ??
      channels.find((c) => c.type === 'whatsapp' && c.active && c.config.instance);
    if (!wa) throw new Error('La cuenta no tiene un canal de WhatsApp activo para enviar el aviso');
    const digits = number.replace(/\D/g, '');
    const t = this.transportFactory(wa, { phone: digits, external_id: digits } as Contact);
    await t.sendText(text, 0);
  }

  /** Transporte del canal; los avisos al encargado salen siempre por un WhatsApp de la cuenta. */
  transportFor(channel: Channel, contact: Contact): Transport {
    const t = this.transportFactory(channel, contact);
    if (channel.type === 'whatsapp' || channel.type === 'playground') return t;
    return {
      kind: t.kind,
      sendText: (text, delay) => t.sendText(text, delay),
      sendImage: (img, caption, delay) => t.sendImage(img, caption, delay),
      notify: (number, text) => this.notifyViaWhatsapp(channel, number, text),
    };
  }

  private notifyViaWhatsapp(channel: Channel, number: string, text: string) {
    return this.sendInternalWhatsapp(channel.account_id, number, text, channel.chatbot_id);
  }

  private async runConversation(conversationId: string, restarts: number): Promise<ProcessResult> {
    const conv = await store.getConversation(conversationId);
    if (!conv) return { status: 'nothing' };
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) return { status: 'nothing' };
    let transport: Transport;
    try {
      transport = this.transportFor(channel, contact);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'channel', message: e?.message ?? String(e), accountId: channel.account_id, channelId: channel.id, conversationId });
      await store.markAllProcessed(conversationId);
      return { status: 'nothing' };
    }
    return this.engine.process(conversationId, transport, { allowRestart: this.queue.canRestart(restarts) });
  }

  /** Maneja un mensaje ya normalizado que llegó por cualquier canal. */
  async handleIncoming(channel: Channel, msg: InboundMessage): Promise<{ conversationId: string; messageId: number | null }> {
    const bot = channel.chatbot_id ? await store.getChatbot(channel.chatbot_id) : null;
    const contact = await store.upsertContact(channel, msg.externalId, msg.phone, msg.fromMe ? '' : msg.displayName);
    const conv = await store.getOrCreateConversation(channel, contact.id);
    const logBase = { accountId: channel.account_id, chatbotId: bot?.id ?? null, channelId: channel.id, conversationId: conv.id };

    if (msg.fromMe) {
      await this.handleOwnMessage(bot, conv, msg);
      return { conversationId: conv.id, messageId: null };
    }

    let content = describeInbound(msg);
    const adapter = adapterFor(channel.type);
    if (msg.type === 'audio' && bot?.ai.transcribe_audio && adapter.downloadAudio) {
      try {
        const audio = await adapter.downloadAudio(channel, msg);
        if (audio) {
          const started = Date.now();
          const text = await this.ai.transcribe(audio.buffer, audio.mimeType);
          if (text) content = `[Nota de voz del cliente, transcrita]: "${text}"`;
          // Se registra para el costo por cuenta. Sin duración de la plataforma, se estima (~2 KB por segundo de Opus).
          await store.insertAiRun({
            account_id: channel.account_id,
            chatbot_id: bot.id,
            conversation_id: conv.id,
            kind: 'transcription',
            model: config.openai.transcriptionModel,
            input_tokens: 0,
            cached_tokens: 0,
            output_tokens: 0,
            latency_ms: Date.now() - started,
            audio_seconds: msg.media?.seconds ?? Math.max(1, Math.round(audio.buffer.length / 2000)),
          });
        }
      } catch (e: any) {
        await logEvent({ level: 'warn', source: 'ai', message: `No se pudo transcribir la nota de voz: ${e?.message ?? e}`, ...logBase });
      }
    }

    // Mensajes viejos (reconexión, reenvíos de la plataforma) se guardan pero no se contestan.
    const stale = Date.now() / 1000 - msg.timestamp > MAX_MESSAGE_AGE_SECONDS;
    const triggers = msg.type !== 'reaction' && !stale;
    const inserted = await store.insertMessage({
      conversation_id: conv.id,
      direction: 'in',
      sender: 'customer',
      type: msg.type,
      content,
      external_message_id: msg.messageId,
      processed: !triggers,
      meta: stale ? { name: msg.displayName, stale: true } : { name: msg.displayName },
    });
    if (!inserted) return { conversationId: conv.id, messageId: null }; // duplicado

    let current = conv;
    if (conv.status === 'closed' && triggers) {
      // El cliente vuelve a escribir: se reabre (la memoria se conserva).
      current = (await store.setConversationStatus(conv.id, 'bot', '')) ?? conv;
    } else if (conv.status === 'human' && bot && bot.rules.auto_resume_minutes > 0) {
      const lastHuman = await store.lastHumanActivity(conv.id);
      const since = Math.max(new Date(conv.status_changed_at).getTime(), lastHuman ? new Date(lastHuman).getTime() : 0);
      if (Date.now() - since > bot.rules.auto_resume_minutes * 60_000) {
        current = (await store.setConversationStatus(conv.id, 'bot', '')) ?? conv;
        await logEvent({ level: 'info', source: 'engine', message: 'El bot retomó la conversación automáticamente', ...logBase });
      }
    }

    if (!triggers) return { conversationId: conv.id, messageId: inserted.id };
    // Automatizaciones (bajas, reglas por mensaje, secuencias): corren aunque atienda una persona o el bot esté apagado.
    if (channel.account_active !== false) {
      const stopAi = await this.automator.onInbound(current, contact, inserted, content).catch(async (e) => {
        await logEvent({ level: 'error', source: 'engine', message: `Error en automatizaciones: ${e?.message ?? e}`, ...logBase, details: e });
        return false;
      });
      if (stopAi) await store.markMessageProcessed(inserted.id);
      current = (await store.getConversation(conv.id)) ?? current;
    }
    const canReply = current.status === 'bot' && bot && bot.active && channel.active && channel.account_active !== false;
    if (!canReply) {
      await store.markProcessed(conv.id, inserted.id);
      return { conversationId: conv.id, messageId: inserted.id };
    }
    this.queue.schedule(conv.id, bot!.ai.debounce_seconds * 1000);
    return { conversationId: conv.id, messageId: inserted.id };
  }

  /** Mensaje enviado desde la cuenta del negocio: eco de un envío nuestro o respuesta manual de una persona. */
  private async handleOwnMessage(bot: Chatbot | null, conv: Conversation, msg: InboundMessage) {
    const content = describeInbound(msg).replace(/^\[El cliente /, '[Se ');
    const known =
      (await store.findMessageByExternalId(conv.id, msg.messageId)) ??
      (msg.text ? await store.findRecentOutgoingEcho(conv.id, msg.text) : null) ??
      (msg.type === 'image' ? await store.findRecentOutgoingImageEcho(conv.id) : null);
    if (known) {
      if (!known.external_message_id) await store.updateMessage(known.id, { external_message_id: msg.messageId });
      return;
    }
    await store.insertMessage({
      conversation_id: conv.id,
      direction: 'out',
      sender: 'human',
      type: msg.type,
      content: msg.type === 'text' ? msg.text : content,
      external_message_id: msg.messageId,
      meta: { source: 'platform' },
    });
    if ((bot?.rules.pause_on_human_reply ?? true) && conv.status === 'bot') {
      await store.setConversationStatus(conv.id, 'human', 'Una persona respondió desde la plataforma');
      await store.markAllProcessed(conv.id);
      await logEvent({
        level: 'info',
        source: 'engine',
        message: 'Bot pausado: una persona respondió directamente desde la plataforma',
        accountId: conv.account_id,
        chatbotId: bot?.id ?? null,
        channelId: conv.channel_id,
        conversationId: conv.id,
      });
    }
  }

  /** Simulador del panel: mismo motor, sin plataforma externa. */
  async playground(bot: Chatbot, session: string, text: string) {
    const channel = await store.getOrCreatePlaygroundChannel(bot);
    const contact = await store.upsertContact(channel, `playground:${session}`, '', 'Prueba');
    const conv = await store.getOrCreateConversation(channel, contact.id);
    const inserted = await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', type: 'text', content: text, processed: false });
    // Las reglas automáticas también se prueban en el simulador.
    if (inserted) {
      const stopAi = await this.automator.onInbound(conv, contact, inserted, text).catch(() => false);
      if (stopAi) await store.markMessageProcessed(inserted.id);
    }
    const transport = new PlaygroundTransport();
    const result = await this.queue.exclusive(conv.id, () => this.engine.process(conv.id, transport, { ignoreInactive: true }));
    await this.automator.settle(conv.id);
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

  async playgroundMessages(bot: Chatbot, session: string) {
    return query(
      `SELECT m.*, i.code AS image_code FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
         JOIN channels ch ON ch.id = ct.channel_id
         LEFT JOIN images i ON i.id = m.image_id
       WHERE ch.chatbot_id = $1 AND ch.type = 'playground' AND ct.external_id = $2 ORDER BY m.id`,
      [bot.id, `playground:${session}`],
    );
  }

  async resetPlayground(bot: Chatbot, session: string) {
    await query(
      `DELETE FROM contacts WHERE external_id = $2 AND channel_id IN (SELECT id FROM channels WHERE chatbot_id = $1 AND type = 'playground')`,
      [bot.id, `playground:${session}`],
    );
  }

  /** Mensaje manual desde el panel (por la misma plataforma de la conversación). */
  async sendManual(conversationId: string, text: string) {
    const conv = await store.getConversation(conversationId);
    if (!conv) throw new Error('Conversación no encontrada');
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) throw new Error('Datos incompletos');
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const transport = channel.type === 'playground' ? new PlaygroundTransport() : this.transportFor(channel, contact);
    const sent = await this.engine.sendOut(bot, conv, transport, { sender: 'human', text, delay: 0, meta: { source: 'panel' } });
    if (!sent) throw new Error('No se pudo enviar el mensaje (revisa los registros)');
    return sent;
  }

  /** Al arrancar: retoma conversaciones con mensajes sin responder de los últimos minutos. */
  async resumePending() {
    const rows = await query<{ conversation_id: string }>(
      `SELECT DISTINCT m.conversation_id FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN channels ch ON ch.id = c.channel_id
       WHERE m.processed = false AND m.direction = 'in' AND ch.type <> 'playground' AND m.created_at > now() - interval '15 minutes'`,
    );
    for (const r of rows) this.queue.schedule(r.conversation_id, 2000);
    await query(`UPDATE messages SET processed = true WHERE processed = false AND created_at <= now() - interval '15 minutes'`);
    return rows.length;
  }
}
