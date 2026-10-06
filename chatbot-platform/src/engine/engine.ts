import { config } from '../config.js';
import type { AiProvider } from '../ai/provider.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Chatbot, Contact, Conversation, ImageAsset, Message } from '../types.js';
import { agentActive, agentStatus, offAfterReply } from './activation.js';
import { automaticField, customerProvided } from './customer-data.js';
import { buildContext, type BusinessInfo } from './context.js';
import { semanticKnowledge } from './knowledge.js';
import { aiSelectableImages, automaticImages, imagesAfterReply, imagesBeforeReply, type ScheduledImage } from './images.js';
import { DECISION_JSON_SCHEMA } from './decision.js';
import { maybeSummarize } from './memory.js';
import { summarizeConversation } from './report.js';
import { normalize } from './text.js';
import type { Transport } from './transport.js';
import { emptyPlan, validateDecision, type AgendaValidation, type ExecutionPlan, type ValidationInput } from './validator.js';
import type { AgendaContext, BookResult } from '../automation/agenda.js';
import type { AutomationEvent } from '../automation/types.js';
import type { ChannelType } from '../types.js';

/** Conexiones opcionales del motor con la automatización y la agenda. */
export interface EngineExtensions {
  intents?(accountId: string, chatbotId: string): Promise<{ intent: string; description: string }[]>;
  agenda?: {
    contextFor(accountId: string, contact: Contact, channelType: ChannelType): Promise<AgendaContext | null>;
    book(o: { accountId: string; serviceId: string; slotKey: string; conversation: Conversation; contact: Contact; source: 'bot' }): Promise<BookResult>;
    cancel(appointmentId: string, reason: string, by: 'bot'): Promise<unknown>;
  };
  onEvent?(e: AutomationEvent): void;
  onOutbound?(conv: Conversation, msg: Message): Promise<void>;
  /** Horario y zona horaria de la cuenta. */
  business?(accountId: string): Promise<BusinessInfo | null>;
  /** Avisa al equipo (panel y WhatsApp de quien lo tenga activado). */
  alertTeam?(accountId: string, o: { title: string; body: string; link?: string; kind?: string }): Promise<void>;
}

export interface ProcessResult {
  status: 'nothing' | 'inactive' | 'human' | 'paused' | 'handoff' | 'replied' | 'no_reply' | 'restart' | 'error';
  plan?: ExecutionPlan;
  decision?: unknown;
  attempts?: { retryable: string[]; fixes: string[] }[];
  fallbackUsed?: boolean;
  error?: string;
}

export interface ProcessOptions {
  /** Si llegan mensajes nuevos mientras la IA piensa, descartar y volver a procesar. */
  allowRestart?: boolean;
  /** Ignora el switch Activo/Inactivo (simulador). */
  ignoreInactive?: boolean;
}

const MAX_ATTEMPTS = 2;

function joinOptions(list: string[]) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} o ${list[list.length - 1]}` : list[0];
}

/** Respuesta segura cuando la IA propone un horario inexistente: horarios reales de la agenda. */
function slotFallback(agenda: AgendaContext | null): string {
  const svc = agenda?.services.find((s) => (agenda.slots[s.id] ?? []).length);
  if (!agenda || !svc) return 'Por ahora no tengo horarios disponibles; déjame revisarlo con el equipo y te aviso.';
  const opts = agenda.slots[svc.id].slice(0, 3).map((x) => x.label);
  return `Ese horario no lo tengo disponible. Para ${svc.name} te puedo ofrecer ${joinOptions(opts)}. ¿Cuál te acomoda?`;
}

/** Plataformas donde tiene sentido simular "escribiendo…". */
function hasTyping(t: Transport) {
  return t.kind === 'whatsapp' || t.kind === 'telegram' || t.kind === 'messenger' || t.kind === 'instagram';
}

export function typingDelay(text: string, enabled: boolean) {
  if (!enabled) return 0;
  return Math.max(1000, Math.min(7000, 700 + text.length * 35));
}

export class Engine {
  private background = new Set<Promise<unknown>>();

  async settleBackground() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  constructor(private ai: AiProvider, private ext: EngineExtensions = {}) {}

  /** Procesa los mensajes pendientes de una conversación y ejecuta la acción validada. */
  async process(conversationId: string, transport: Transport, opts: ProcessOptions = {}): Promise<ProcessResult> {
    const conv = await store.getConversation(conversationId);
    if (!conv) return { status: 'nothing' };
    const [contact, channel] = await Promise.all([store.getContact(conv.contact_id), store.getChannel(conv.channel_id)]);
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    if (!contact || !channel) return { status: 'nothing' };

    const pending = await store.pendingInbound(conv.id);
    if (!pending.length) return { status: 'nothing' };
    const lastPendingId = pending[pending.length - 1].id;

    // Sin chatbot asignado, canal o cuenta desactivados: se guarda pero no se responde.
    if (!bot || ((!bot.active || !channel.active || channel.account_active === false) && !opts.ignoreInactive)) {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'inactive' };
    }
    if (conv.status !== 'bot') {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'human' };
    }
    // Asistente en pausa en esta conversación, o esperando su palabra de activación.
    if (!agentActive(bot, conv)) {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'paused' };
    }

    const customerText = pending.map((m) => m.content).join('\n');
    const log = (level: 'info' | 'warn' | 'error', source: 'engine' | 'ai' | 'validator' | 'channel', message: string, details?: unknown) =>
      logEvent({ level, source, message, details, accountId: conv.account_id, chatbotId: bot.id, channelId: conv.channel_id, conversationId: conv.id });

    // 1) Transferencia inmediata por palabra clave (sin gastar IA).
    const kw = matchKeyword(customerText, bot.rules.handoff_keywords);
    if (kw) {
      await this.executeHandoff(bot, conv, contact, transport, [], `El cliente escribió "${kw}"`);
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'handoff', plan: { ...emptyPlan('handoff'), handoffReason: `palabra clave: ${kw}` } };
    }

    // 2) Contexto controlado.
    const [knowledge, allImages, sentImageIds, history] = await Promise.all([
      store.listKnowledge(bot.id, true),
      store.listImages(bot.id, false),
      store.sentImageIds(conv.id),
      // Todo lo que aún no está en el resumen (así no hay huecos de memoria). El resumidor
      // mantiene esto acotado a ~recent_messages + summary_batch mensajes.
      store.unsummarizedMessages(conv.id, conv.summary_until_id, bot.ai.recent_messages + bot.ai.summary_batch + pending.length + 4),
    ]);
    const images = allImages.filter((i) => i.active);
    const semantic = await semanticKnowledge(bot, knowledge, [...history.slice(-4).filter((m) => m.direction === 'in').map((m) => m.content), customerText].join('\n'), this.ai);
    // Automatización y agenda (si están conectadas).
    const [intents, agendaCtx, business] = await Promise.all([
      this.ext.intents ? this.ext.intents(conv.account_id, bot.id).catch(() => []) : Promise.resolve([]),
      this.ext.agenda && bot.rules.booking_enabled ? this.ext.agenda.contextFor(conv.account_id, contact, channel.type).catch(() => null) : Promise.resolve(null),
      this.ext.business ? this.ext.business(conv.account_id).catch(() => null) : Promise.resolve(null),
    ]);
    const agendaVal: AgendaValidation | null = agendaCtx
      ? { slots: Object.fromEntries(Object.entries(agendaCtx.slots).map(([k, v]) => [k, v.map((x) => x.key)])), appointmentIds: agendaCtx.appointments.map((a) => a.id), needsPhoneFor: agendaCtx.needsPhoneFor }
      : null;
    const hasPhone = !!contact.phone || !!contact.data?.telefono || bot.data_fields.some((f) => f.type === 'phone' && !!contact.data?.[f.key]);
    const imagesById = new Map<string, ImageAsset>(allImages.map((i) => [i.id, i]));
    const model = bot.ai.model || config.openai.defaultModel;
    // Fotos con momento fijo (las garantiza el sistema): por palabra del cliente o de bienvenida, se saben antes de la IA.
    const firstReply = (await store.countInbound(conv.id)) <= pending.length;
    const scheduledBefore = imagesBeforeReply(images, { text: customerText, firstReply, sentIds: sentImageIds });
    const aiImages = aiSelectableImages(images);
    const autoImages = automaticImages(images, bot.flow.steps.map((x) => x.title));

    // 3) La IA propone; el backend valida (con un reintento guiado).
    let correction: string | undefined;
    let plan: ExecutionPlan | null = null;
    let lastRaw: unknown;
    let retryable: string[] = [];
    let factIssues = false;
    let bookingIssue = false;
    let lastInput: ValidationInput | undefined;
    const attempts: ProcessResult['attempts'] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctx = buildContext({
        bot, knowledge: semantic ?? knowledge, knowledgeSelected: semantic !== null, images: aiImages, contact, conversation: conv, channelType: channel.type, history, pending, sentImageIds, imagesById, correction, intents, agenda: agendaCtx, business,
        autoImages, imagesNow: scheduledBefore.map((x) => x.image),
      });
      let completion;
      try {
        completion = await this.ai.complete({
          model,
          messages: ctx.messages,
          temperature: bot.ai.temperature,
          reasoning_effort: bot.ai.reasoning_effort,
          json_schema: { name: 'chatbot_decision', schema: DECISION_JSON_SCHEMA as unknown as Record<string, unknown> },
        });
      } catch (e: any) {
        await log('error', 'ai', `Fallo al llamar a la IA: ${e?.message ?? e}`, e);
        // Si ya hubo una propuesta (rechazada), se corrige/asegura en vez de quedarse callado.
        if (plan && lastInput) {
          const v = validateDecision({ ...lastInput, final: true });
          plan = v.plan;
          retryable = v.retryable;
          factIssues = v.factIssues;
          bookingIssue = v.bookingIssue;
          break;
        }
        return { status: 'error', error: String(e?.message ?? e), attempts };
      }
      let raw: unknown = completion.content;
      try {
        raw = JSON.parse(completion.content);
      } catch {
        /* el validador lo reporta */
      }
      lastRaw = raw;
      lastInput = {
        raw, bot, images: aiImages, sentImageIds, customerText, scheduledImages: scheduledBefore.map((x) => x.image),
        groundingSources: ctx.groundingSources,
        customerSources: ctx.customerSources,
        customerDataSources: history.filter((m) => m.direction === 'in').map((m) => m.content),
        allowedIntents: intents.map((i) => i.intent),
        agenda: agendaVal,
        hasPhone,
        knownData: contact.data ?? {},
        knownName: contact.name || undefined,
      };
      const v = validateDecision({ ...lastInput, final: attempt === MAX_ATTEMPTS });
      attempts.push({ retryable: v.retryable, fixes: v.fixes });
      await store.insertAiRun({
        account_id: conv.account_id,
        chatbot_id: bot.id,
        conversation_id: conv.id,
        kind: 'decision',
        model: completion.model,
        input_tokens: completion.usage.input_tokens,
        cached_tokens: completion.usage.cached_tokens,
        output_tokens: completion.usage.output_tokens,
        latency_ms: completion.latency_ms,
        cost_usd: completion.cost_usd,
        attempt,
        decision: raw,
        validation: { retryable: v.retryable, fixes: v.fixes, action: v.plan.action },
      });
      if (v.fixes.length) await log('info', 'validator', `Correcciones aplicadas: ${v.fixes.join(' | ')}`);
      plan = v.plan;
      retryable = v.retryable;
      factIssues = v.factIssues;
      bookingIssue = v.bookingIssue;
      if (!retryable.length) break;
      await log('warn', 'validator', `Propuesta rechazada (intento ${attempt}): ${retryable.join(' | ')}`, { decision: raw });
      correction = retryable.join(' ');
    }

    let fallbackUsed = false;
    if (!plan || (retryable.length && !factIssues && !bookingIssue)) {
      // Respuesta inválida (JSON roto o vacía) incluso tras reintentar: no se envía nada inventado.
      await log('error', 'ai', 'La IA no generó una respuesta válida; se reintentará más tarde', { issues: retryable, decision: lastRaw });
      return { status: 'error', error: retryable.join(' | ') || 'Respuesta inválida', attempts };
    }
    if (retryable.length) {
      // Datos no verificables tras el reintento: respuesta segura según la regla configurada.
      fallbackUsed = true;
      const base = { ...plan, booking: null };
      if (bookingIssue && !factIssues) {
        // La IA insistió en un horario que no existe: se ofrecen horarios reales.
        plan = { ...base, action: 'reply', messages: [slotFallback(agendaCtx)], images: [] };
      } else if (bot.rules.unknown_info_behavior === 'handoff') {
        plan = { ...base, action: 'handoff', messages: [], images: [], handoffReason: 'El bot no pudo dar una respuesta verificada' };
      } else {
        plan = { ...base, action: 'reply', messages: [bot.rules.fallback_message], images: [] };
      }
      await log('warn', 'validator', 'Se usó la respuesta de respaldo tras fallar la validación', { issues: retryable, decision: lastRaw });
    }

    // El backend hace cumplir la regla "si el dato no está, transferir".
    if (plan.infoNotFound && bot.rules.unknown_info_behavior === 'handoff' && plan.action !== 'handoff' && plan.action !== 'no_reply') {
      plan = { ...plan, action: 'handoff', messages: [], images: [], handoffReason: plan.handoffReason || 'El cliente pidió información que no está cargada' };
    }

    // 4) ¿Llegaron mensajes nuevos mientras la IA pensaba? Mejor responder a todo junto.
    if (opts.allowRestart) {
      const nowPending = await store.pendingInbound(conv.id);
      if (nowPending.some((m) => m.id > lastPendingId)) return { status: 'restart', attempts };
    }
    // ¿Un humano tomó la conversación mientras tanto?
    const fresh = await store.getConversation(conv.id);
    if (!fresh || fresh.status !== 'bot') {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'human', plan, attempts };
    }
    if (!agentActive(bot, fresh)) {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'paused', plan, attempts };
    }

    // 5) Ejecutar.
    const dataBefore = { ...(contact.data ?? {}) };
    const nameBefore = contact.name;
    let booked = false;
    await this.applyMemory(contact, plan, conv.id, lastPendingId, [...history, ...pending], bot);
    // Agenda: se ejecuta antes de enviar; si el horario se ocupó justo ahora, se avisa en vez de confirmar.
    if (plan.booking && this.ext.agenda) {
      if (plan.booking.action === 'book') {
        const r = await this.ext.agenda.book({ accountId: conv.account_id, serviceId: plan.booking.serviceId, slotKey: plan.booking.slot, conversation: conv, contact, source: 'bot' });
        if (!r.ok) {
          plan = {
            ...plan,
            action: 'reply',
            images: [],
            messages: [r.alternatives.length ? `Uy, ese horario se acaba de ocupar. Te puedo ofrecer ${joinOptions(r.alternatives)}. ¿Cuál te acomoda?` : 'Uy, ese horario se acaba de ocupar. ¿Te puedo ofrecer otro día?'],
          };
          await log('warn', 'engine', `No se pudo agendar: ${r.reason}`);
        } else booked = true;
      } else {
        await this.ext.agenda.cancel(plan.booking.appointmentId, 'Cancelada por el cliente en el chat', 'bot');
      }
    }
    const meta = { action: plan.action, info_not_found: plan.infoNotFound, fallback: fallbackUsed };
    // Recorrido: el objetivo solo cuenta una vez por conversación (hasta que se cierre y se reabra).
    const goalReached = plan.goalCompleted && !conv.goal_completed_at;
    const goalHandoff = goalReached && bot.flow.on_goal_action === 'handoff' && plan.action !== 'handoff';
    // Fotos programadas: se suman a las que eligió la IA (sin repetir). En una transferencia no se envían.
    if (plan.action !== 'handoff') {
      const after = imagesAfterReply(images, {
        stepReached: plan.flowStep && plan.flowStep !== (conv.flow_step ?? 0) ? plan.flowStep : 0,
        goalReached,
        booked,
        sentIds: sentImageIds,
        skip: scheduledBefore.map((x) => x.image.id),
      });
      const extra: ScheduledImage[] = [...scheduledBefore, ...after].filter((x, i, all) => !plan!.images.some((p) => p.id === x.image.id) && all.findIndex((y) => y.image.id === x.image.id) === i);
      if (extra.length) {
        plan = { ...plan, action: 'reply_with_image', images: [...plan.images, ...extra.map((x) => x.image)].slice(0, 5) };
        await log('info', 'engine', `Foto enviada por regla: ${extra.map((x) => `${x.image.code} (${x.reason})`).join(', ')}`);
      }
    }
    if (plan.action === 'handoff') {
      await this.executeHandoff(bot, conv, contact, transport, plan.messages, plan.handoffReason || 'La IA decidió transferir');
    } else if (plan.action !== 'no_reply') {
      await this.sendPlan(bot, conv, transport, plan, meta);
    }
    if (plan.flowStep || goalReached) {
      const reached = await store.setFlowState(conv.id, plan.flowStep, goalReached);
      if (reached) {
        await log('info', 'engine', `Objetivo de la conversación cumplido${plan.flowStep ? ` (etapa ${plan.flowStep})` : ''}`);
        if (goalHandoff) {
          // Ya se envió la respuesta de la IA (que se despide): solo se pasa a una persona, sin otro mensaje.
          await this.executeHandoff(bot, conv, contact, transport, [], 'Se cumplió el objetivo de la conversación', { silent: true });
        } else if (bot.flow.on_goal_action === 'notify' && channel.type !== 'playground' && this.ext.alertTeam) {
          const who = contact.name || contact.push_name || contact.phone || 'Un cliente';
          await this.ext.alertTeam(conv.account_id, { title: '🎯 Objetivo cumplido', body: `${who} (${channel.name}): ${bot.flow.goal}`, link: `#/conversation/${conv.id}`, kind: 'goal' });
        }
      }
    }
    // Desactivadores después de responder (objetivo, cita, datos completos).
    if (plan.action !== 'handoff' && !goalHandoff) {
      const why = offAfterReply(bot.rules.activation, { goalReached, booked, before: { name: nameBefore, data: dataBefore }, after: contact });
      if (why) await this.deactivate(bot, conv, contact, transport, why);
    }
    await store.markProcessed(conv.id, lastPendingId);

    // Eventos para las reglas automáticas (se ejecutan después, sin bloquear la respuesta).
    if (this.ext.onEvent) {
      if (plan.intents.length) this.ext.onEvent({ type: 'intent', conversationId: conv.id, intents: plan.intents, text: customerText });
      if (goalReached) this.ext.onEvent({ type: 'goal_completed', conversationId: conv.id, text: customerText });
      for (const [field, value] of Object.entries(contact.data ?? {})) {
        if (value && dataBefore[field] !== value) this.ext.onEvent({ type: 'data_captured', conversationId: conv.id, field, text: customerText });
      }
    }

    if (goalReached) await this.summarizeFinal(conv);

    // 6) Memoria de largo plazo (resumen) en segundo plano.
    const memory = maybeSummarize(this.ai, bot, conv.id, conv.account_id).catch((e) => log('error', 'ai', `Error al resumir: ${e?.message ?? e}`, e));
    this.background.add(memory);
    void memory.then(() => this.background.delete(memory), () => this.background.delete(memory));

    return {
      status: plan.action === 'handoff' ? 'handoff' : plan.action === 'no_reply' ? 'no_reply' : 'replied',
      plan,
      decision: lastRaw,
      attempts,
      fallbackUsed,
    };
  }

  async sendPlan(bot: Chatbot, conv: Conversation, transport: Transport, plan: ExecutionPlan, meta: Record<string, unknown>) {
    const typing = bot.ai.typing_simulation && hasTyping(transport);
    for (const text of plan.messages) {
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, typing), meta });
    }
    for (const img of plan.images) {
      await this.sendOut(bot, conv, transport, { sender: 'bot', text: img.caption, image: img, delay: typing ? 1200 : 0, meta });
    }
  }

  /** Guarda el mensaje ANTES de enviarlo (para reconocer el eco del webhook) y luego lo envía. */
  async sendOut(
    bot: Chatbot | null,
    conv: Conversation,
    transport: Transport,
    o: { sender: 'bot' | 'human' | 'system'; text: string; image?: ImageAsset; delay: number; meta?: Record<string, unknown> },
  ): Promise<Message | null> {
    const msg = await store.insertMessage({
      conversation_id: conv.id,
      direction: 'out',
      sender: o.sender,
      type: o.image ? 'image' : 'text',
      content: o.text,
      image_id: o.image?.id ?? null,
      status: 'pending',
      meta: o.meta,
    });
    if (!msg) return null;
    try {
      const extId = o.image ? await transport.sendImage(o.image, o.text, o.delay) : await transport.sendText(o.text, o.delay);
      await store.updateMessage(msg.id, { external_message_id: extId, status: 'ok' });
      const sent = { ...msg, status: 'ok', external_message_id: extId };
      if (this.ext.onOutbound) await this.ext.onOutbound(conv, sent).catch(() => undefined);
      return sent;
    } catch (e: any) {
      await store.updateMessage(msg.id, { status: 'failed', meta: { error: String(e?.message ?? e) } });
      await logEvent({
        level: 'error',
        source: transport.kind === 'whatsapp' ? 'evolution' : 'channel',
        message: `No se pudo enviar ${o.image ? `la imagen ${o.image.code}` : 'el mensaje'} (${transport.kind}): ${e?.message ?? e}`,
        accountId: conv.account_id,
        chatbotId: bot?.id ?? null,
        channelId: conv.channel_id,
        conversationId: conv.id,
        details: e,
      });
      return null;
    }
  }

  async executeHandoff(bot: Chatbot, conv: Conversation, contact: Contact, transport: Transport, messages: string[], reason: string, opts: { silent?: boolean } = {}) {
    await store.setConversationStatus(conv.id, 'human', reason);
    const texts = messages.length ? messages : bot.rules.handoff_message && !opts.silent ? [bot.rules.handoff_message] : [];
    for (const text of texts) {
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, bot.ai.typing_simulation && hasTyping(transport)), meta: { action: 'handoff' } });
    }
    await logEvent({ level: 'info', source: 'engine', message: `Conversación transferida a humano: ${reason}`, accountId: conv.account_id, chatbotId: bot.id, channelId: conv.channel_id, conversationId: conv.id });
    await this.summarizeFinal(conv);
    this.ext.onEvent?.({ type: 'handoff', conversationId: conv.id });
    if (bot.rules.handoff_notify_number) {
      const who = contact.name || contact.push_name || contact.phone || contact.external_id;
      const text = `🔔 *${bot.name}*: ${who}${contact.phone ? ` (+${contact.phone})` : ''} necesita atención.\nMotivo: ${reason}`;
      try {
        await transport.notify(bot.rules.handoff_notify_number, text);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'channel', message: `No se pudo avisar al encargado: ${e?.message ?? e}`, accountId: conv.account_id, chatbotId: bot.id, conversationId: conv.id });
      }
    }
  }

  /** Apaga al asistente en la conversación según lo configurado: pausa, pasa a una persona o cierra. */
  async deactivate(bot: Chatbot, conv: Conversation, contact: Contact, transport: Transport, reason: string) {
    const a = bot.rules.activation;
    const msg = a.off_message.trim();
    const log = (message: string) => logEvent({ level: 'info', source: 'engine', message, accountId: conv.account_id, chatbotId: bot.id, channelId: conv.channel_id, conversationId: conv.id });
    if (a.off_action === 'handoff') {
      await this.executeHandoff(bot, conv, contact, transport, msg ? [msg] : [], `Asistente desactivado: ${reason}`, { silent: !msg });
    } else {
      if (msg) await this.sendOut(bot, conv, transport, { sender: 'bot', text: msg, delay: typingDelay(msg, bot.ai.typing_simulation && hasTyping(transport)), meta: { action: 'agent_off' } });
      if (a.off_action === 'close') {
        await store.setConversationStatus(conv.id, 'closed', `Asistente desactivado: ${reason}`);
        await this.summarizeFinal(conv);
        await log(`Conversación cerrada: ${reason}`);
      } else {
        const until = a.resume_after_hours > 0 ? new Date(Date.now() + a.resume_after_hours * 3600_000) : null;
        await store.setAgentOff(conv.id, reason, until);
        await log(`Asistente en pausa: ${reason}${until ? ` (se reactiva en ${a.resume_after_hours} h)` : ''}`);
      }
    }
    this.ext.onEvent?.({ type: 'agent_off', conversationId: conv.id, text: reason });
  }

  /** Estado del asistente en una conversación (para el panel y el simulador). */
  agentState(bot: Chatbot, conv: Conversation) {
    return agentStatus(bot, conv);
  }

  private async summarizeFinal(conv: Conversation) {
    try { await summarizeConversation(this.ai, conv.id); }
    catch (error) {
      await logEvent({ level: 'error', source: 'ai', message: 'No se pudo generar el resumen final; se puede solicitar nuevamente desde la conversación', accountId: conv.account_id, chatbotId: conv.chatbot_id, conversationId: conv.id, details: { error: error instanceof Error ? error.message : String(error) } });
    }
  }

  async applyMemory(contact: Contact, plan: ExecutionPlan, conversationId: string, sourceMessageId: number, messages: Message[], bot: Chatbot) {
    if (!Object.keys(plan.saveData).length && !plan.contactName && !plan.remember.length) return;
    const sources: Record<string, number> = {};
    for (const [key, value] of Object.entries(plan.saveData)) {
      const field = bot.data_fields.find((f) => f.key === key) ?? automaticField(key);
      if (!field) continue;
      const source = [...messages].sort((a, b) => b.id - a.id).find((m) => m.direction === 'in' && customerProvided(field, value, [m.content]));
      if (source) sources[key] = source.id;
    }
    const updated = await store.saveConversationMemory(conversationId, contact.id, { data: plan.saveData, name: plan.contactName ?? undefined, remember: plan.remember }, sourceMessageId, sources);
    Object.assign(contact, updated);
  }
}

export function matchKeyword(text: string, keywords: string[]): string | null {
  const t = ` ${normalize(text).replace(/[^a-z0-9ñ ]/g, ' ')} `;
  for (const k of keywords) {
    const nk = normalize(k).replace(/[^a-z0-9ñ ]/g, ' ').trim();
    if (nk && t.includes(` ${nk} `)) return k;
  }
  return null;
}
