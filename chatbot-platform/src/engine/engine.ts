import { config } from '../config.js';
import type { AiProvider } from '../ai/provider.js';
import { recordMessage } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel, Chatbot, Contact, Conversation, ImageAsset, Message } from '../types.js';
import { detectRisk, isAutomatedMessage, promisesFollowUp, repeatedCustomerText, SAFETY_MESSAGES, type RiskHit } from './safety.js';
import { agentActive, agentStatus, offAfterReply } from './activation.js';
import { automaticField, customerLabel, customerProvided } from './customer-data.js';
import { CLAIM_JUDGE_PROMPT, CLAIM_JUDGE_SCHEMA } from './claims.js';
import { buildContext, type BusinessInfo } from './context.js';
import { semanticKnowledge } from './knowledge.js';
import { aiSelectableImages, automaticImages, contextualImages, imagesForContext, imagesAfterReply, imagesBeforeReply, imagesForAssistant, type ScheduledImage } from './images.js';
import { DECISION_JSON_SCHEMA } from './decision.js';
import { maybeSummarize } from './memory.js';
import { briefReport } from './report-format.js';
import { summarizeConversation } from './report.js';
import { normalize } from './text.js';
import type { OutgoingFile, Transport } from './transport.js';
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
  alertTeam?(accountId: string, o: { title: string; body: string; link?: string; kind?: string; conversationId?: string }): Promise<void>;
  /**
   * Programa el envío posterior de una foto que el sistema debía mandar (la plataforma la rechazó o no cupo en la
   * respuesta). `allowEnded`: aunque la conversación ya pasó a una persona o se cerró en este mismo momento.
   */
  deferImage?(conv: Conversation, image: ImageAsset, o: { reason: string; delaySeconds: number; allowEnded: boolean }): Promise<void>;
}

export interface ProcessResult {
  status: 'nothing' | 'busy' | 'inactive' | 'human' | 'paused' | 'handoff' | 'replied' | 'no_reply' | 'restart' | 'error';
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
  /**
   * Juez de afirmaciones (modo estricto): un modelo barato dice qué de la respuesta no respalda la información del negocio.
   * Si el juez falla no se bloquea la respuesta (las demás verificaciones siguen en pie).
   */
  private async judgeClaims(
    accountId: string, chatbotId: string, conversationId: string, sources: string[], reply: string,
    log: (level: 'info' | 'warn' | 'error', source: 'engine' | 'ai' | 'validator' | 'channel', message: string, details?: unknown) => Promise<unknown>,
  ): Promise<string[]> {
    try {
      const info = sources.join('\n---\n').slice(0, 30_000);
      const res = await this.ai.complete({
        model: config.openai.summaryModel,
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: 'system', content: CLAIM_JUDGE_PROMPT },
          { role: 'user', content: `<informacion>\n${info}\n</informacion>\n\n<respuesta>\n${reply}\n</respuesta>` },
        ],
        json_schema: { name: 'claim_check', schema: CLAIM_JUDGE_SCHEMA as unknown as Record<string, unknown> },
      });
      await store.insertAiRun({
        account_id: accountId, chatbot_id: chatbotId, conversation_id: conversationId, kind: 'verify', model: res.model,
        input_tokens: res.usage.input_tokens, cached_tokens: res.usage.cached_tokens, output_tokens: res.usage.output_tokens,
        latency_ms: res.latency_ms, cost_usd: res.cost_usd,
      });
      const parsed = JSON.parse(res.content);
      return Array.isArray(parsed.unsupported) ? parsed.unsupported.map((x: unknown) => String(x).slice(0, 120)).filter(Boolean).slice(0, 5) : [];
    } catch (e: any) {
      await log('warn', 'ai', `No se pudo verificar las afirmaciones con IA: ${e?.message ?? e}`);
      return [];
    }
  }

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

    // 0) Emergencia o riesgo para la vida: una persona atiende de inmediato, con un mensaje fijo y sin IA.
    const risk = detectRisk(customerText);
    if (risk) {
      await this.escalateRisk(bot, conv, contact, channel, transport, risk, customerText);
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'handoff', plan: { ...emptyPlan('handoff'), handoffReason: `riesgo: ${risk.kind}` } };
    }
    // 0b) Contestadores y respuestas de ausencia: no se contestan (contestarlos produce bucles).
    if (pending.every((m) => isAutomatedMessage(m.content))) {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'no_reply' };
    }
    // 0c) El mismo texto del cliente repetido varias veces: suele ser un contestador o un bot atrapado en un bucle.
    // El asistente se pausa y el equipo se entera. Solo cuenta lo de los últimos 30 minutos (los bucles ocurren en
    // segundos) y la pausa dura 4 horas: un cliente real que vuelve a escribir más tarde sí recibe respuesta.
    const since = Date.now() - 30 * 60_000;
    const inbound = (await store.recentMessages(conv.id, 12)).filter((m) => m.direction === 'in' && new Date(m.created_at).getTime() >= since).map((m) => m.content);
    if (repeatedCustomerText(inbound)) {
      await store.setAgentOff(conv.id, 'posible bucle: el cliente repite el mismo mensaje', new Date(Date.now() + 4 * 3600_000));
      await store.markProcessed(conv.id, lastPendingId);
      await log('warn', 'engine', 'Asistente en pausa: el cliente repite el mismo mensaje (posible contestador o bot)');
      await this.notify(conv, channel, '🔁 Asistente en pausa: posible bucle', `${customerLabel(contact)} (${channel.name}): el mismo mensaje llegó varias veces (¿un contestador o un bot?). Si es una persona, reactiva al asistente desde la conversación.`, 'automation');
      return { status: 'paused' };
    }

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
      this.ext.intents ? this.ext.intents(conv.account_id, bot.id).catch((e) => { log('error', 'engine', `No se pudieron cargar las intenciones de las reglas: ${e?.message ?? e}`); return []; }) : Promise.resolve([]),
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
    const firstReply = await store.isFirstLiveInbound(conv.id, pending[0].id);
    const scheduledBefore = imagesBeforeReply(images, { text: customerText, firstReply, sentIds: sentImageIds });
    const aiImages = aiSelectableImages(images);
    const autoImages = automaticImages(images, bot.flow.steps.map((x) => x.title));

    // Para el validador: no repetir la respuesta anterior salvo que el cliente repita su pregunta.
    const pendingIds = new Set(pending.map((m) => m.id));
    const previousCustomer = history.filter((m) => m.direction === 'in' && !pendingIds.has(m.id)).at(-1)?.content ?? '';
    const customerRepeats = normalize(customerText) === normalize(previousCustomer);
    const recentBotTexts = history.filter((m) => m.direction === 'out').slice(-3).map((m) => m.content);

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
        autoImages, contextImages: contextualImages(images), imagesNow: scheduledBefore.map((x) => x.image),
      });
      let completion;
      try {
        completion = await this.ai.complete({
          model,
          fallback_models: bot.ai.fallback_models,
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
        raw, bot, images: aiImages, sentImageIds, customerText, scheduledImages: scheduledBefore.map((x) => x.image), automaticImages: images, currentFlowStep: conv.flow_step ?? 0, goalAlreadyCompleted: !!conv.goal_completed_at,
        groundingSources: ctx.groundingSources,
        claimSources: ctx.claimSources,
        customerSources: ctx.customerSources,
        customerDataSources: history.filter((m) => m.direction === 'in').map((m) => m.content),
        allowedIntents: intents.map((i) => i.intent),
        agenda: agendaVal,
        hasPhone,
        knownData: contact.data ?? {},
        knownName: contact.name || undefined,
        recentBotTexts,
        customerRepeats,
      };
      const v = validateDecision({ ...lastInput, final: attempt === MAX_ATTEMPTS });
      // Modo estricto: un modelo barato revisa que lo afirmado esté respaldado (solo si lo demás ya pasó).
      if (!v.retryable.length && bot.rules.verify_claims === 'estricto' && v.plan.messages.length) {
        const unsupported = await this.judgeClaims(conv.account_id, bot.id, conv.id, ctx.claimSources, v.plan.messages.join('\n'), log);
        if (unsupported.length) {
          v.factIssues = true;
          v.retryable.push(`Afirmaste algo que la información del negocio no respalda o contradice: ${unsupported.join('; ')}. Quítalo o di con naturalidad que lo confirmas con el equipo.`);
        }
      }
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
      const base = { ...plan, booking: null, contextImages: [] };
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
            images: [], contextImages: [],
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
    const stageChanged = !!plan.flowStep && plan.flowStep !== (conv.flow_step ?? 0);
    // Fotos programadas: se suman a las que eligió la IA (sin repetir). En una transferencia no se envían.
    let selectedRules: ScheduledImage[] = [];
    // Fotos que el sistema debía enviar y no salieron en esta respuesta (límite por respuesta o rechazo de la plataforma):
    // no se pierden, se reintentan enseguida.
    const owed: { image: ImageAsset; reason: string; delaySeconds: number }[] = [];
    if (plan.action !== 'handoff') {
      const assistant = imagesForAssistant(images, plan.messages.join(' '), sentImageIds);
      const after = imagesAfterReply(images, {
        stepReached: plan.flowStep && plan.flowStep !== (conv.flow_step ?? 0) ? plan.flowStep : 0,
        goalReached,
        booked,
        sentIds: sentImageIds,
        skip: scheduledBefore.map((x) => x.image.id),
      });
      const contextual = imagesForContext(images, plan.contextImages.map(img => img.code), sentImageIds);
      const automatic = [...scheduledBefore, ...assistant, ...after, ...contextual].filter((x, i, all) => all.findIndex(y => y.image.id === x.image.id) === i);
      const candidates = [...automatic.map(x => x.image), ...plan.images.filter(img => !automatic.some(x => x.image.id === img.id))];
      const selected = candidates.slice(0, bot.rules.max_images_per_reply);
      selectedRules = automatic.filter(x => selected.some(img => img.id === x.image.id));
      if (candidates.length > selected.length) {
        // Las que salen por una regla del negocio (etapa, objetivo, palabra…) se envían después; las que eligió la IA, no.
        const over = candidates.slice(selected.length);
        const later = over.filter((img) => automatic.some((x) => x.image.id === img.id));
        const dropped = over.filter((img) => !later.includes(img));
        if (dropped.length) await log('warn', 'engine', `Fotos omitidas por el límite de ${bot.rules.max_images_per_reply} por respuesta: ${dropped.map(img => img.code).join(', ')}`);
        if (later.length) await log('info', 'engine', `Fotos del negocio que no caben en esta respuesta (límite de ${bot.rules.max_images_per_reply}); se envían enseguida: ${later.map(img => img.code).join(', ')}`);
        for (const img of later) owed.push({ image: img, reason: automatic.find((x) => x.image.id === img.id)!.reason, delaySeconds: 5 });
      }
      if (selected.length) plan = { ...plan, action: 'reply_with_image', images: selected };

    }
    if (plan.action === 'handoff') {
      await this.executeHandoff(bot, conv, contact, transport, plan.messages, plan.handoffReason || 'La IA decidió transferir');
    } else if (plan.action !== 'no_reply') {
      const failed = await this.sendPlan(bot, conv, transport, plan, meta, selectedRules);
      for (const x of failed) owed.push({ image: x.image, reason: x.reason, delaySeconds: 45 });
    }
    // Si el asistente dijo que el equipo dará seguimiento, el equipo se entera: no depende de que alguien lo recuerde.
    if (plan.action !== 'handoff' && plan.messages.some((m) => promisesFollowUp(m))) {
      await this.notify(conv, channel, '🕒 Seguimiento prometido al cliente', `${customerLabel(contact)} (${channel.name}): el asistente dijo "${plan.messages.join(' ').slice(0, 200)}"`, 'follow_up');
    }
    let summarized = false;
    if (plan.flowStep || goalReached) {
      const reached = await store.setFlowState(conv.id, plan.flowStep, goalReached);
      if (reached) {
        await log('info', 'engine', `Objetivo de la conversación cumplido${plan.flowStep ? ` (etapa ${plan.flowStep})` : ''}`);
        // El reporte (resumen, análisis y datos) se arma ANTES de avisar y de emitir eventos: así el aviso, las reglas y
        // los webhooks ya lo llevan completo. Si la IA falla, el aviso sale igual con los datos y los últimos mensajes.
        await this.summarizeFinal(conv);
        summarized = true;
        if (goalHandoff) {
          // Ya se envió la respuesta de la IA (que se despide): solo se pasa a una persona, sin otro mensaje.
          await this.executeHandoff(bot, conv, contact, transport, [], 'Se cumplió el objetivo de la conversación', { silent: true });
        } else if (bot.flow.on_goal_action === 'notify' && channel.type !== 'playground' && this.ext.alertTeam) {
          const who = contact.name || contact.push_name || contact.phone || 'Un cliente';
          const brief = await briefReport(conv.id, 1500, { customer: false }).catch(() => '');
          await this.ext.alertTeam(conv.account_id, { title: '🎯 Objetivo cumplido', body: `${who} (${channel.name}): ${bot.flow.goal}${brief ? `\n\n${brief}` : ''}`, link: `#/conversation/${conv.id}`, conversationId: conv.id, kind: 'goal' });
        }
      }
    }
    // Desactivadores después de responder (objetivo, cita, datos completos).
    let ended = goalHandoff;
    if (plan.action !== 'handoff' && !goalHandoff) {
      const why = offAfterReply(bot.rules.activation, { goalReached, booked, before: { name: nameBefore, data: dataBefore }, after: contact });
      if (why) {
        ended = true;
        await this.deactivate(bot, conv, contact, transport, why);
      }
    }
    // Las fotos que faltaron salen aunque la conversación haya pasado a una persona o se haya cerrado en este mismo momento.
    for (const x of owed) await this.ext.deferImage?.(conv, x.image, { reason: x.reason, delaySeconds: x.delaySeconds, allowEnded: ended }).catch((e) => log('error', 'engine', `No se pudo programar el reenvío de la foto ${x.image.code}: ${e?.message ?? e}`));
    await store.markProcessed(conv.id, lastPendingId);

    // Eventos para las reglas automáticas (se ejecutan después, sin bloquear la respuesta).
    if (this.ext.onEvent) {
      if (plan.intents.length) this.ext.onEvent({ type: 'intent', conversationId: conv.id, intents: plan.intents, text: customerText });
      if (stageChanged) this.ext.onEvent({ type: 'stage_reached', conversationId: conv.id, step: plan.flowStep, text: customerText });
      if (goalReached) this.ext.onEvent({ type: 'goal_completed', conversationId: conv.id, text: customerText });
      for (const [field, value] of Object.entries(contact.data ?? {})) {
        if (value && dataBefore[field] !== value) this.ext.onEvent({ type: 'data_captured', conversationId: conv.id, field, text: customerText });
      }
    }

    if (goalReached && !summarized) await this.summarizeFinal(conv);

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

  /** Envía el plan. Devuelve las fotos de reglas del negocio que la plataforma rechazó (para reintentarlas). */
  async sendPlan(bot: Chatbot, conv: Conversation, transport: Transport, plan: ExecutionPlan, meta: Record<string, unknown>, scheduled: ScheduledImage[] = []): Promise<ScheduledImage[]> {
    const typing = bot.ai.typing_simulation && hasTyping(transport);
    // En correo, varias burbujas serían varios correos: se envían como uno solo.
    const texts = transport.kind === 'email' && plan.messages.length > 1 ? [plan.messages.join('\n\n')] : plan.messages;
    // Si una persona tomó la conversación mientras la IA respondía, lo que falta de la respuesta ya no sale.
    const stillBot = async () => (await store.getConversation(conv.id))?.status === 'bot';
    for (const text of texts) {
      if (!(await stillBot())) return [];
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, typing), meta });
    }
    const failed: ScheduledImage[] = [];
    for (const img of plan.images) {
      if (!(await stillBot())) return failed;
      const rule = scheduled.find(x => x.image.id === img.id);
      const sent = await this.sendOut(bot, conv, transport, { sender: 'bot', text: img.caption, image: img, delay: typing ? 1200 : 0, meta: rule ? {...meta, image_trigger: rule.reason} : meta });
      if (sent && rule) await logEvent({ level: 'info', source: 'engine', message: `Foto enviada por regla: ${img.code} (${rule.reason})`, accountId: conv.account_id, chatbotId: bot.id, channelId: conv.channel_id, conversationId: conv.id });
      if (!sent && rule) failed.push(rule);
    }
    return failed;
  }

  /** Guarda el mensaje ANTES de enviarlo (para reconocer el eco del webhook) y luego lo envía. */
  async sendOut(
    bot: Chatbot | null,
    conv: Conversation,
    transport: Transport,
    o: { sender: 'bot' | 'human' | 'system'; text: string; image?: ImageAsset; file?: OutgoingFile; delay: number; meta?: Record<string, unknown> },
  ): Promise<Message | null> {
    const msg = await store.insertMessage({
      conversation_id: conv.id,
      direction: 'out',
      sender: o.sender,
      type: o.file ? o.file.kind : o.image ? 'image' : 'text',
      content: o.text,
      image_id: o.image?.id ?? null,
      status: 'pending',
      meta: o.file ? { ...o.meta, attachment_id: o.file.id, file_name: o.file.name } : o.meta,
    });
    if (!msg) return null;
    try {
      let extId: string | null;
      if (o.file) {
        if (!transport.sendFile) throw new Error('Este canal todavía no envía archivos (PDF, Word, audio o video): usa texto o una foto');
        extId = await transport.sendFile(o.file, o.text, o.delay);
      } else {
        extId = o.image ? await transport.sendImage(o.image, o.text, o.delay) : await transport.sendText(o.text, o.delay);
      }
      await store.updateMessage(msg.id, { external_message_id: extId, status: 'ok' });
      // Cuenta para el límite mensual del plan (las pruebas del simulador no cuentan).
      if (o.sender === 'bot' && transport.kind !== 'playground') await recordMessage(conv.account_id).catch(() => undefined);
      const sent = { ...msg, status: 'ok', external_message_id: extId };
      if (this.ext.onOutbound) await this.ext.onOutbound(conv, sent).catch(() => undefined);
      return sent;
    } catch (e: any) {
      await store.updateMessage(msg.id, { status: 'failed', meta: { error: String(e?.message ?? e) } });
      await logEvent({
        level: 'error',
        source: transport.kind === 'whatsapp' ? 'evolution' : 'channel',
        message: `No se pudo enviar ${o.file ? `el archivo ${o.file.name}` : o.image ? `la imagen ${o.image.code}` : 'el mensaje'} (${transport.kind}): ${e?.message ?? e}`,
        accountId: conv.account_id,
        chatbotId: bot?.id ?? null,
        channelId: conv.channel_id,
        conversationId: conv.id,
        details: e,
      });
      return null;
    }
  }

  /** Aviso al equipo (panel y WhatsApp de quien lo tenga activado). Nunca interrumpe la conversación si falla. */
  private async notify(conv: Conversation, channel: Channel, title: string, body: string, kind: string) {
    if (channel.type === 'playground' || !this.ext.alertTeam) return;
    await this.ext.alertTeam(conv.account_id, { title, body, link: `#/conversation/${conv.id}`, kind, conversationId: conv.id }).catch((e) =>
      logEvent({ level: 'error', source: 'channel', message: `No se pudo avisar al equipo: ${e?.message ?? e}`, accountId: conv.account_id, conversationId: conv.id }),
    );
  }

  /** Riesgo para la vida o emergencia: mensaje fijo, transferencia inmediata y aviso prioritario al equipo. */
  private async escalateRisk(bot: Chatbot, conv: Conversation, contact: Contact, channel: Channel, transport: Transport, risk: RiskHit, text: string) {
    await this.executeHandoff(bot, conv, contact, transport, [SAFETY_MESSAGES[risk.kind][risk.lang]], risk.kind === 'selfharm' ? 'Riesgo para la vida: el cliente lo mencionó' : 'Posible emergencia: el cliente lo mencionó');
    await this.notify(conv, channel, '🚨 Posible emergencia en una conversación', `${customerLabel(contact)} (${channel.name}): "${text.slice(0, 200)}". Atiéndelo cuanto antes.`, 'safety');
  }

  async executeHandoff(bot: Chatbot, conv: Conversation, contact: Contact, transport: Transport, messages: string[], reason: string, opts: { silent?: boolean; via?: 'bot' | 'regla' } = {}) {
    const before = await store.getConversation(conv.id);
    await store.setConversationStatus(conv.id, 'human', reason);
    // Queda en el contacto quién la pasó y desde dónde. Si una persona ya la atendía, no se pisa.
    if (before?.status !== 'human') await store.markHandoff(contact.id, null, opts.via ?? 'bot');
    const texts = messages.length ? messages : bot.rules.handoff_message && !opts.silent ? [bot.rules.handoff_message] : [];
    for (const text of texts) {
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, bot.ai.typing_simulation && hasTyping(transport)), meta: { action: 'handoff' } });
    }
    await logEvent({ level: 'info', source: 'engine', message: `Conversación transferida a humano: ${reason}`, accountId: conv.account_id, chatbotId: bot.id, channelId: conv.channel_id, conversationId: conv.id });
    await this.summarizeFinal(conv);
    this.ext.onEvent?.({ type: 'handoff', conversationId: conv.id });
    if (bot.rules.handoff_notify_number) {
      const who = contact.name || contact.push_name || contact.phone || contact.external_id;
      const brief = await briefReport(conv.id, 1200, { customer: false }).catch(() => '');
      const text = `🔔 *${bot.name}*: ${who}${contact.phone ? ` (+${contact.phone})` : ''} necesita atención.\nMotivo: ${reason}${brief ? `\n\n${brief}` : ''}`;
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
      await this.executeHandoff(bot, conv, contact, transport, msg ? [msg] : [], `Asistente desactivado: ${reason}`, { silent: !msg, via: 'regla' });
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

/** Palabra o frase completa en el texto (sin distinguir acentos ni mayúsculas). Los emojis cuentan como palabras. */
export function matchKeyword(text: string, keywords: string[]): string | null {
  const clean = (s: string) => normalize(s).replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\u200d\ufe0f ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const t = ` ${clean(text)} `;
  for (const k of keywords) {
    const nk = clean(k);
    if (!nk) continue;
    if (/[\p{L}\p{N}]/u.test(nk) ? t.includes(` ${nk} `) : normalize(text).includes(nk)) return k;
  }
  return null;
}
