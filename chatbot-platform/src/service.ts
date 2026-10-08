import { syncAppointment } from './integrations/google.js';
import crypto from 'node:crypto';
import type { AiProvider } from './ai/provider.js';
import { Agenda } from './automation/agenda.js';
import { Automator } from './automation/automator.js';
import { Campaigns } from './automation/campaigns.js';
import { Outbound } from './automation/outbound.js';
import { Scheduler } from './automation/scheduler.js';
import * as astore from './automation/store.js';
import { isOpen, nextOpen, spanishDate, spanishTime } from './automation/time.js';
import { detectRisk, maskSensitive } from './engine/safety.js';
import { customerLabel } from './engine/customer-data.js';
import { cleanText, deepClean } from './engine/text.js';
import { adapterFor } from './channels/index.js';
import { INBOUND_MEDIA_MAX_BYTES, removeInboundFiles, saveInboundMedia, type StoredMedia } from './channels/media.js';
import { config } from './config.js';
import { gate } from './engine/activation.js';
import { describeInbound, type InboundMessage } from './channels/types.js';
import { query } from './db.js';
import { summarizeConversation } from './engine/report.js';
import { Engine, type ProcessResult } from './engine/engine.js';
import { deliver } from './integrations/webhooks.js';
import { messageQuota, noticeMessagesReached } from './billing/limits.js';
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
const LEASE_SECONDS = 300;

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
      business: async (accountId) => {
        const st = await astore.getSettings(accountId);
        const now = new Date();
        const openNow = isOpen(st.business_hours, st.holidays, now, st.timezone);
        // Cuándo vuelve a abrir: el asistente lo dice al cliente en vez de prometer una respuesta inmediata.
        const hasHours = Object.values(st.business_hours).some((w) => w.length > 0);
        const next = !openNow && hasHours ? nextOpen(st.business_hours, st.holidays, now, st.timezone) : null;
        return {
          timezone: st.timezone,
          hours: st.business_hours,
          holidays: st.holidays,
          openNow,
          nextOpen: next ? `${spanishDate(next, st.timezone)} a las ${spanishTime(next, st.timezone)}` : undefined,
        };
      },
      alertTeam: (accountId, o) => this.automator.alertTeam(accountId, o),
      deferImage: async (conv, image, o) => {
        await astore.scheduleJob({
          account_id: conv.account_id,
          type: 'flow_image',
          payload: { conversation_id: conv.id, image_id: image.id, reason: o.reason, journey: conv.flow_started_at ? new Date(conv.flow_started_at).toISOString() : null, at: new Date().toISOString(), allow_ended: o.allowEnded },
          run_at: new Date(Date.now() + o.delaySeconds * 1000),
          dedupe_key: `flow_image:${conv.id}:${image.id}`,
        });
      },
    });
    this.queue = new ConversationQueue((id, a) => this.runConversation(id, a.restarts), 2, 60_000, (id) => void this.aiUnavailable(id));
    this.scheduler = new Scheduler({
      automation_send: (p) => this.automator.runDelayedSend(p),
      flow_image: (p) => this.automator.runDeferredImage(p),
      webhook_delivery: (p, job) => deliver(p, job.attempts),
      gcal_sync: (p) => syncAppointment(p),
      no_reply: (p) => this.automator.runNoReply(p),
      sequence_step: (p) => this.automator.runSequenceStep(p),
      appointment_reminder: (p) => this.agenda.sendReminder(p),
      campaign_start: (p) => this.campaigns.start(p.campaign_id),
      campaign_send: (p) => this.campaigns.sendOne(p),
    });
  }

  summarize(conversationId: string) {
    return summarizeConversation(this.ai, conversationId);
  }

  async closeConversation(conversationId: string, reason: string) {
    const closed = await store.setConversationStatus(conversationId, 'closed', reason);
    if (!closed) throw new Error('Conversación no encontrada');
    try { return await this.summarize(conversationId); }
    catch (error) {
      await logEvent({ level: 'error', source: 'ai', message: 'Conversación cerrada; el resumen no pudo generarse y se puede volver a solicitar', accountId: closed.account_id, chatbotId: closed.chatbot_id, conversationId, details: { error: error instanceof Error ? error.message : String(error) } });
      return (await store.getConversation(conversationId))!;
    }
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

  /** Identifica a este proceso en los arrendamientos de conversaciones. */
  readonly instanceId = crypto.randomUUID();
  private sweeper?: NodeJS.Timeout;

  /**
   * Una conversación la atiende un solo proceso a la vez (arrendamiento en PostgreSQL), así que se pueden
   * correr varios procesos sin respuestas dobles, y si uno muere a la mitad otro retoma el trabajo.
   */
  private async runConversation(conversationId: string, restarts: number): Promise<ProcessResult> {
    if (!(await store.claimConversation(conversationId, this.instanceId, LEASE_SECONDS))) return { status: 'busy' };
    const renew = setInterval(() => void store.renewConversationLease(conversationId, this.instanceId, LEASE_SECONDS).catch(() => undefined), (LEASE_SECONDS / 3) * 1000);
    try {
      return await this.runClaimed(conversationId, restarts);
    } finally {
      clearInterval(renew);
      await store.releaseConversation(conversationId, this.instanceId).catch(() => undefined);
    }
  }

  /** Busca mensajes sin responder que nadie atiende (temporizador perdido o proceso caído) y los programa. */
  async sweepPending(): Promise<number> {
    const ids = (await store.recoverableConversations()).filter((id) => !this.queue.has(id));
    for (const id of ids) this.queue.schedule(id, 0);
    return ids.length;
  }

  startSweeper(intervalMs = 30_000) {
    this.sweeper = setInterval(() => {
      this.sweepPending()
        .then(async (n) => { if (n) await logEvent({ level: 'warn', source: 'engine', message: `Se retomaron ${n} conversaciones con mensajes sin responder` }); })
        .catch(() => undefined);
    }, intervalMs);
    this.sweeper.unref();
  }

  private async runClaimed(conversationId: string, restarts: number): Promise<ProcessResult> {
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
    // Cupo mensual del plan: al agotarse el asistente deja de responder solo (y se avisa al equipo una vez al mes).
    if (channel.type !== 'playground' && (await messageQuota(channel.account_id)).reached) {
      await store.markAllProcessed(conversationId);
      await noticeMessagesReached(channel.account_id).catch(() => undefined);
      await logEvent({ level: 'warn', source: 'engine', message: 'Límite mensual de mensajes del plan alcanzado: el asistente no respondió', accountId: channel.account_id, channelId: channel.id, conversationId });
      return { status: 'nothing' };
    }
    return this.engine.process(conversationId, transport, { allowRestart: this.queue.canRestart(restarts) });
  }

  /** La IA falló dos veces seguidas en una conversación: se avisa al equipo para que no quede sin respuesta. */
  private async aiUnavailable(conversationId: string) {
    try {
      const conv = await store.getConversation(conversationId);
      if (!conv || conv.status !== 'bot') return;
      const [contact, channel] = await Promise.all([store.getContact(conv.contact_id), store.getChannel(conv.channel_id)]);
      if (!channel || channel.type === 'playground') return;
      const who = contact?.name || contact?.push_name || (contact?.phone ? `+${contact.phone}` : 'Un cliente');
      await logEvent({ level: 'error', source: 'ai', message: 'La IA no pudo responder tras reintentar; se avisó al equipo', accountId: conv.account_id, channelId: conv.channel_id, conversationId });
      await this.automator.alertTeam(conv.account_id, {
        title: '⚠️ Un cliente espera respuesta',
        body: `${who} (${channel.name}) escribió y el asistente no pudo responder (servicio de IA no disponible). Contéstale desde el panel.`,
        link: `#/conversation/${conversationId}`,
        conversationId,
        kind: 'ai_error',
      });
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'system', message: `No se pudo avisar de la falla de IA: ${e?.message ?? e}`, conversationId });
    }
  }

  /** Maneja un mensaje ya normalizado que llegó por cualquier canal. */
  async handleIncoming(channel: Channel, msg: InboundMessage): Promise<{ conversationId: string; messageId: number | null }> {
    // Lo que llega de la plataforma se limpia una vez aquí (NUL y surrogates sueltos no caben en PostgreSQL).
    msg = deepClean(msg);
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
          const result = await this.ai.transcribe(audio.buffer, audio.mimeType);
          const text = typeof result === 'string' ? result : result.content;
          if (text) content = `[Nota de voz del cliente, transcrita]: "${text}"`;
          // Se registra para el costo por cuenta. Sin duración de la plataforma, se estima (~2 KB por segundo de Opus).
          await store.insertAiRun({
            account_id: channel.account_id,
            chatbot_id: bot.id,
            conversation_id: conv.id,
            kind: 'transcription',
            model: typeof result === 'string' ? config.openai.transcriptionModel : result.model,
            input_tokens: typeof result === 'string' ? 0 : result.usage.input_tokens,
            cached_tokens: typeof result === 'string' ? 0 : result.usage.cached_tokens,
            output_tokens: typeof result === 'string' ? 0 : result.usage.output_tokens,
            cost_usd: typeof result === 'string' ? undefined : result.cost_usd,
            latency_ms: Date.now() - started,
            audio_seconds: msg.media?.seconds ?? Math.max(1, Math.round(audio.buffer.length / 2000)),
          });
        }
      } catch (e: any) {
        await logEvent({ level: 'warn', source: 'ai', message: `No se pudo transcribir la nota de voz: ${e?.message ?? e}`, ...logBase });
      }
    }

    // Datos sensibles: el número de una tarjeta se guarda solo con sus últimos 4 dígitos.
    content = maskSensitive(content);
    // Mensajes viejos (reconexión, reenvíos de la plataforma) se guardan pero no se contestan.
    const stale = Date.now() / 1000 - msg.timestamp > MAX_MESSAGE_AGE_SECONDS;
    const triggers = msg.type !== 'reaction' && !stale && !msg.captureOnly;
    // Foto o documento del cliente: se guarda tal como llegó. Si no se puede, el mensaje se guarda igual y el motivo queda visible en el panel.
    let media: StoredMedia | undefined;
    let mediaError = '';
    if (msg.type === 'image' || msg.type === 'document') {
      try {
        const captured = await this.captureInboundMedia(channel, msg, msg.type);
        media = captured.media;
        mediaError = captured.error ?? '';
      } catch (e: any) {
        mediaError = `${msg.type === 'image' ? 'La foto' : 'El documento'} no se guardó: ${e?.message ?? e}`;
        await logEvent({ level: 'warn', source: 'engine', message: `No se pudo guardar un archivo del cliente: ${e?.message ?? e}`, ...logBase });
      }
    }
    const meta: Record<string, unknown> = stale ? { name: msg.displayName, stale: true } : msg.captureOnly ? { name: msg.displayName, held: 'limite_de_correos' } : { name: msg.displayName };
    if (mediaError) meta.media_error = mediaError;
    const inserted = await store.insertMessage({
      conversation_id: conv.id,
      direction: 'in',
      sender: 'customer',
      type: msg.type,
      content,
      external_message_id: msg.messageId,
      processed: !triggers,
      meta,
      media,
    }).catch(async (e) => {
      if (media) await removeInboundFiles([media.file_path]);
      throw e;
    });
    if (!inserted) {
      // Duplicado: el archivo que se acaba de descargar no se conserva.
      if (media) await removeInboundFiles([media.file_path]);
      return { conversationId: conv.id, messageId: null };
    }

    let current = conv;
    if (conv.status === 'closed' && triggers) {
      // El cliente vuelve a escribir: se reabre (la memoria se conserva; el recorrido empieza de nuevo).
      await store.resetFlowState(conv.id);
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
    let canReply = current.status === 'bot' && !!bot && bot.active && channel.active && channel.account_active !== false;
    // Activadores y desactivadores del asistente (palabras que lo encienden o lo apagan en esta conversación).
    if (canReply) canReply = await this.applyGate(bot!, channel, current, contact, content);
    if (!canReply) {
      // El asistente no va a responder (pausa, palabra de activación o una persona atiende): si hay una emergencia,
      // el equipo se entera igual. Con el asistente activo, el motor se encarga de responder y avisar.
      if (triggers && channel.type !== 'playground' && detectRisk(content)) {
        await this.automator.alertTeam(channel.account_id, {
          title: '🚨 Posible emergencia en una conversación',
          body: `${customerLabel(contact)} (${channel.name}): "${content.slice(0, 200)}". Atiéndelo cuanto antes.`,
          link: `#/conversation/${conv.id}`,
          conversationId: conv.id,
          kind: 'safety',
        }).catch(() => undefined);
      }
      await store.markProcessed(conv.id, inserted.id);
      return { conversationId: conv.id, messageId: inserted.id };
    }
    this.queue.schedule(conv.id, bot!.ai.debounce_seconds * 1000);
    return { conversationId: conv.id, messageId: inserted.id };
  }

  /** Descarga la foto o el documento del cliente y lo guarda con sus bytes originales. Si el canal no puede o el archivo es muy grande, devuelve el motivo. */
  private async captureInboundMedia(channel: Channel, msg: InboundMessage, kind: 'image' | 'document'): Promise<{ media?: StoredMedia; error?: string }> {
    const label = kind === 'image' ? 'La foto' : 'El documento';
    const limit = `${INBOUND_MEDIA_MAX_BYTES / 1024 / 1024} MB`;
    const adapter = adapterFor(channel.type);
    if (!adapter.downloadMedia) return { error: `${label} no se guardó: este canal todavía no permite descargar archivos` };
    // Se revisa el tamaño que declara la plataforma antes de descargar: un documento de cientos de MB no se trae a memoria.
    if ((msg.media?.size ?? 0) > INBOUND_MEDIA_MAX_BYTES) return { error: `${label} no se guardó: pesa más de ${limit}` };
    const file = await adapter.downloadMedia(channel, msg);
    if (!file) return { error: `${label} no se guardó: la plataforma no entregó el archivo` };
    if (file.buffer.length > INBOUND_MEDIA_MAX_BYTES) return { error: `${label} no se guardó: pesa más de ${limit}` };
    const media = await saveInboundMedia(channel.account_id, kind, file.buffer, file.fileName ?? msg.media?.filename ?? '');
    return { media };
  }

  /** Aplica los activadores/desactivadores a un mensaje del cliente. Devuelve si la IA debe responder. */
  private async applyGate(bot: Chatbot, channel: Channel, conv: Conversation, contact: Contact, text: string, transport?: Transport): Promise<boolean> {
    const g = gate(bot.rules.activation, conv, text);
    if (g.change === 'on') {
      await store.setAgentOn(conv.id);
      await logEvent({ level: 'info', source: 'engine', message: `Asistente activado: ${g.reason}`, accountId: conv.account_id, chatbotId: bot.id, channelId: channel.id, conversationId: conv.id });
    } else if (g.change === 'off') {
      let t = transport;
      try {
        t ??= this.transportFor(channel, contact);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'channel', message: e?.message ?? String(e), accountId: conv.account_id, channelId: channel.id, conversationId: conv.id });
        await store.setAgentOff(conv.id, g.reason, null);
        return false;
      }
      await this.engine.deactivate(bot, conv, contact, t, g.reason);
    }
    return g.reply;
  }

  /** Manual ownership changes share the same handoff event as bot transfers. */
  async takeover(conversationId: string, reason: string, byUserId?: string) {
    const changed = await store.takeConversation(conversationId, reason);
    await store.markAllProcessed(conversationId);
    if (changed) this.automator.emit({ type: 'handoff', conversationId, byUserId });
    return changed ?? await store.getConversation(conversationId);
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
      await this.takeover(conv.id, 'Una persona respondió desde la plataforma');
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
    text = cleanText(text);
    const channel = await store.getOrCreatePlaygroundChannel(bot);
    const contact = await store.upsertContact(channel, `playground:${session}`, '', 'Prueba');
    let conv = await store.getOrCreateConversation(channel, contact.id);
    const mark = await query<{ id: string }>(`SELECT coalesce(max(id), 0) AS id FROM event_logs WHERE conversation_id = $1`, [conv.id]);
    if (conv.status === 'closed') {
      // Como en un canal real: si el cliente vuelve a escribir, la conversación se reabre.
      await store.resetFlowState(conv.id);
      conv = (await store.setConversationStatus(conv.id, 'bot', '')) ?? conv;
    }
    const inserted = await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', type: 'text', content: maskSensitive(text), processed: false });
    // Las reglas automáticas también se prueban en el simulador.
    if (inserted) {
      const stopAi = await this.automator.onInbound(conv, contact, inserted, text).catch(() => false);
      if (stopAi) await store.markMessageProcessed(inserted.id);
    }
    const transport = new PlaygroundTransport();
    // Igual que en un canal real: el mensaje puede encender o apagar al asistente antes de la IA.
    const current = (await store.getConversation(conv.id)) ?? conv;
    let replies = true;
    if (inserted && current.status === 'bot') replies = await this.applyGate(bot, channel, current, contact, text, transport);
    const result: ProcessResult = replies
      ? await this.queue.exclusive(conv.id, () => this.engine.process(conv.id, transport, { ignoreInactive: true }))
      : (await store.markAllProcessed(conv.id), { status: 'paused' });
    await this.automator.settle(conv.id);
    const [freshContact, freshConv] = await Promise.all([store.getContact(contact.id), store.getConversation(conv.id)]);
    // Qué se activó en este turno (reglas, activación/pausa del asistente, objetivo, transferencias).
    const events = await query<{ level: string; message: string; created_at: Date }>(
      `SELECT level, message, created_at FROM event_logs WHERE conversation_id = $1 AND id > $2 ORDER BY id`,
      [conv.id, mark[0].id],
    );
    return {
      events,
      agent: freshConv ? this.engine.agentState(bot, freshConv) : null,
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
  async sendManual(conversationId: string, text: string, byUserId?: string) {
    const conv = await store.getConversation(conversationId);
    if (!conv) throw new Error('Conversación no encontrada');
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) throw new Error('Datos incompletos');
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const transport = channel.type === 'playground' ? new PlaygroundTransport() : this.transportFor(channel, contact);
    // Quién lo envió queda en el mensaje (las estadísticas por persona lo cuentan así).
    const sent = await this.engine.sendOut(bot, conv, transport, { sender: 'human', text, delay: 0, meta: { source: 'panel', ...(byUserId ? { user_id: byUserId } : {}) } });
    if (!sent) throw new Error('No se pudo enviar el mensaje (revisa los registros)');
    return sent;
  }

  /** Foto del catálogo enviada a mano desde el panel (por la misma plataforma de la conversación). */
  async sendManualImage(conversationId: string, imageId: string, beforeSend?: () => Promise<void>, byUserId?: string) {
    const conv = await store.getConversation(conversationId);
    if (!conv) throw new Error('Conversación no encontrada');
    const image = await store.getImage(imageId);
    const owner = image ? await store.getChatbot(image.chatbot_id) : null;
    if (!image || owner?.account_id !== conv.account_id) throw new Error('Foto no encontrada');
    if (!image.active) throw new Error('La foto está desactivada; actívala en Fotos para poder enviarla');
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) throw new Error('Datos incompletos');
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const transport = channel.type === 'playground' ? new PlaygroundTransport() : this.transportFor(channel, contact);
    await beforeSend?.();
    const sent = await this.engine.sendOut(bot, conv, transport, { sender: 'human', text: image.caption, image, delay: 0, meta: { source: 'panel', ...(byUserId ? { user_id: byUserId } : {}) } });
    if (!sent) throw new Error('No se pudo enviar la foto (revisa los registros)');
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
    // Los mensajes de hace más de 15 minutos no se contestan (sería fuera de tiempo), pero el equipo sí debe enterarse.
    const stale = await query<{ account_id: string; n: number }>(
      `SELECT ch.account_id, count(*)::int AS n FROM messages m
         JOIN conversations c ON c.id = m.conversation_id JOIN channels ch ON ch.id = c.channel_id
       WHERE m.processed = false AND m.direction = 'in' AND ch.type <> 'playground' AND m.created_at <= now() - interval '15 minutes'
       GROUP BY ch.account_id`,
    );
    for (const s of stale) {
      await logEvent({ level: 'warn', source: 'engine', message: `Reinicio: ${s.n} mensajes llevan más de 15 minutos sin respuesta y no se contestarán automáticamente`, accountId: s.account_id, details: { count: s.n } });
      await this.automator.alertTeam(s.account_id, { title: '⚠️ Mensajes sin respuesta tras un reinicio', body: `${s.n} mensajes de clientes llegaron hace más de 15 minutos y el asistente no los contestará. Revísalos en Conversaciones.`, kind: 'alert' }).catch(() => undefined);
    }
    await query(`UPDATE messages SET processed = true WHERE processed = false AND created_at <= now() - interval '15 minutes'`);
    return rows.length;
  }
}
