import { accountAi, AiBudgetBlocked } from '../ai/budget.js';
import { knowledgeHash } from './knowledge.js';
import { query, queryOne,withTransaction } from '../db.js';
import { OutboundBlockedError } from '../outbound-guard.js';
import { assertOwnership, controlVersion, currentOperation, DeliveryUncertain, OwnershipLost,interruptedOperation, nextDelivery, operationScope, setControlVersion } from './coordination.js';
import { config } from '../config.js';
import type { AiProvider } from '../ai/provider.js';
import { recordMessage } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel, Chatbot, Contact, Conversation, ImageAsset, Message, SavedMessage } from '../types.js';
import { detectRisk, isAutomatedMessage, promisesFollowUp, repeatedCustomerText, SAFETY_MESSAGES, type RiskHit } from './safety.js';
import { asksQuestion, contactNameKey } from './questions.js';
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
import { CAPTION_MAX, type OutgoingButton, type OutgoingFile, type OutgoingTemplate, type Transport } from './transport.js';
import { emptyPlan, validateDecision, type AgendaValidation, type ExecutionPlan, type QuoteValidation, type ValidationInput } from './validator.js';
import { quoteEvent, type QuoteCatalog, type Quotes } from '../quotes/agent.js';
import type { Quote } from '../store/quotes.js';
import type { AgendaContext, BookResult } from '../automation/agenda.js';
import type { AutomationEvent } from '../automation/types.js';
import type { PipelineContext } from '../automation/pipelines.js';
import type { ChannelType } from '../types.js';

/** Conexiones opcionales del motor con la automatización y la agenda. */
export interface EngineExtensions {
  intents?(accountId: string, chatbotId: string): Promise<{ intent: string; description: string }[]>;
  /** Pipeline del agente: columnas que la IA detecta por contexto y en cuál va la solicitud. */
  pipeline?(conv: Conversation): Promise<PipelineContext | null>;
  agenda?: {
    contextFor(accountId: string, contact: Contact, channelType: ChannelType): Promise<AgendaContext | null>;
    book(o: { accountId: string; serviceId: string; slotKey: string; conversation: Conversation; contact: Contact; source: 'bot'; assignedUserId?: string | null }): Promise<BookResult>;
    cancel(appointmentId: string, reason: string, by: 'bot'): Promise<unknown>;
  };
  /** Cotizaciones en PDF con la lista de precios de la cuenta. */
  quotes?: Pick<Quotes, 'contextFor' | 'prepare' | 'message' | 'link' | 'delivered'>;
  onEvent?(e: AutomationEvent): void;
  settleEvents?(conversationId:string):Promise<void>;
  onOutbound?(conv: Conversation, msg: Message): Promise<void>;
  /** Horario y zona horaria de la cuenta. */
  business?(accountId: string): Promise<BusinessInfo | null>;
  /** Avisa al equipo (panel y WhatsApp de quien lo tenga activado). */
  alertTeam?(accountId: string, o: { title: string; body: string; link?: string; kind?: string; conversationId?: string }): Promise<void>;
  /**
   * Programa el envío posterior de una foto que el sistema debía mandar (la plataforma la rechazó o no cupo en la
   * respuesta). `allowEnded`: aunque la conversación ya pasó a una persona o se cerró en este mismo momento.
   */
  /** `allowRepeat`: el cliente la pidió de nuevo (o la IA la reenvía a petición suya), aunque ya se hubiera enviado. */
  deferImage?(conv: Conversation, image: ImageAsset, o: { reason: string; delaySeconds: number; allowEnded: boolean; allowRepeat?: boolean }): Promise<void>;
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
  /** Ya se abrió una solicitud nueva en este turno (no se abre otra). */
  newRequestStarted?: boolean;
}

const MAX_ATTEMPTS = 2;

/** La cotización de esta respuesta: el mensaje del sistema (con el total) y el PDF, o el aviso de que la revisa el equipo. */
interface QuoteDelivery {
  text: string;
  file?: OutgoingFile;
  quote?: Quote;
  link?: string;
  /** Se envió el archivo (o el enlace, en los canales que no envían archivos). */
  delivered?: 'file' | 'link';
  /** Cotización final que quedó por aprobar. */
  pending?: Quote;
}
/**
 * Seguro contra repetir: la IA puede abrir una solicitud nueva si la actual ya cumplió su objetivo o empezó hace al menos
 * este tiempo. Antes, repetir la pregunta es seguir la misma solicitud (se le recuerda lo que ya se le dijo).
 */
export const NEW_REQUEST_COOLDOWN_MINUTES = 30;

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

export interface SavedItem {
  message: SavedMessage;
  image: ImageAsset | null;
  /** Tenía foto, pero ya no existe, está inactiva o es de otro asistente. */
  missingImage: boolean;
}

/** Mensajes guardados de la propuesta (en su orden), con su foto si sigue activa y es de este asistente. */
export function savedItems(bot: Chatbot, codes: string[], imagesById: Map<string, ImageAsset>): SavedItem[] {
  return codes.flatMap((code) => {
    const message = bot.saved_messages.find((m) => m.active && m.code === code);
    if (!message) return [];
    const img = message.image_id ? imagesById.get(message.image_id) : undefined;
    const image = img && img.active && img.chatbot_id === bot.id ? img : null;
    return [{ message, image, missingImage: !!message.image_id && !image }];
  });
}

/** Plataformas donde tiene sentido simular "escribiendo…". */
function hasTyping(t: Transport) {
  return t.typingSimulation !== false && (t.kind === 'whatsapp' || t.kind === 'telegram' || t.kind === 'messenger' || t.kind === 'instagram');
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

  /** Same decisions, validators and outbound planning; no automation delivery or external agenda writes. */
  evaluationEngine(ai: AiProvider, agenda: EngineExtensions['agenda'], onEvent: NonNullable<EngineExtensions['onEvent']>) {
    return new Engine(ai, { intents: this.ext.intents, business: this.ext.business, agenda, onEvent });
  }

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
      const res = await accountAi(this.ai, accountId, chatbotId, 'decision').complete({
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
    const pending = await store.pendingInbound(conversationId);
    // Also inspect earlier pending turns: a new webhook cannot bypass an interrupted delivery.
    for (const message of pending) {
      if (await interruptedOperation(`turn:${conversationId}:${message.id}`)) throw new DeliveryUncertain();
    }
    const operation = `turn:${conversationId}:${pending.at(-1)?.id ?? 'none'}`;
    return operationScope(operation, async () => {
      const row = await queryOne('SELECT control_version FROM conversations WHERE id=$1',[conversationId]);
      if(row) setControlVersion(Number(row.control_version));
      try { return await this.processTurn(conversationId,transport,opts); }
      catch(e) { if(await interruptedOperation(operation)) throw new DeliveryUncertain(); throw e; }
    });
  }

  private async processTurn(conversationId: string, transport: Transport, opts: ProcessOptions = {}): Promise<ProcessResult> {
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
    const [knowledge, allImages, sentImageIds, history, questionJourney, requests] = await Promise.all([
      store.listKnowledge(bot.id, true),
      store.listImages(bot.id, false),
      store.sentImageIds(conv.id),
      // Todo lo que aún no está en el resumen (así no hay huecos de memoria). El resumidor
      // mantiene esto acotado a ~recent_messages + summary_batch mensajes.
      store.unsummarizedMessages(conv.id, conv.summary_until_id, bot.ai.recent_messages + bot.ai.summary_batch + pending.length + 4),
      // Preguntas de la lista: cuáles ya se hicieron en este recorrido y si ya se terminaron.
      store.questionJourney(conv.id),
      // Solicitudes anteriores del cliente en esta conversación (la IA sabe que vuelve por lo mismo).
      store.listRequests(conv.id),
    ]);
    // "Máximo de fotos por respuesta" en 0: el asistente no envía fotos (ni las que elige la IA ni las automáticas).
    const images = bot.rules.max_images_per_reply > 0 ? allImages.filter((i) => i.active) : [];
    const semantic = await semanticKnowledge(bot, knowledge, [...history.slice(-4).filter((m) => m.direction === 'in').map((m) => m.content), customerText].join('\n'), this.ai);
    // Automatización y agenda (si están conectadas).
    const [intents, agendaCtx, business, pipeline, quoteCatalog] = await Promise.all([
      this.ext.intents ? this.ext.intents(conv.account_id, bot.id).catch((e) => { log('error', 'engine', `No se pudieron cargar las intenciones de las reglas: ${e?.message ?? e}`); return []; }) : Promise.resolve([]),
      this.ext.agenda && bot.rules.booking_enabled ? this.ext.agenda.contextFor(conv.account_id, contact, channel.type).catch(() => null) : Promise.resolve(null),
      this.ext.business ? this.ext.business(conv.account_id).catch(() => null) : Promise.resolve(null),
      this.ext.pipeline ? this.ext.pipeline(conv).catch((e) => { log('error', 'engine', `No se pudo cargar el pipeline: ${e?.message ?? e}`); return null; }) : Promise.resolve(null),
      this.ext.quotes ? this.ext.quotes.contextFor(conv, bot).catch((e) => { log('error', 'engine', `No se pudo cargar la lista de precios: ${e?.message ?? e}`); return null; }) : Promise.resolve(null as QuoteCatalog | null),
    ]);
    const quoteVal: QuoteValidation | null = quoteCatalog ? {
      items: Object.fromEntries(quoteCatalog.items.map((i) => [i.code.toUpperCase(), { id: i.id, name: i.name, exact: i.price_mode === 'exact' }])),
      requiredFields: quoteCatalog.requiredFields.map((f) => ({ key: f.key, label: f.label })),
      open: !!quoteCatalog.open,
      allowFinal: quoteCatalog.allowFinal,
    } : null;
    const agendaVal: AgendaValidation | null = agendaCtx
      ? {
          slots: Object.fromEntries(Object.entries(agendaCtx.slots).map(([k, v]) => [k, v.map((x) => x.key)])), appointmentIds: agendaCtx.appointments.map((a) => a.id), needsPhoneFor: agendaCtx.needsPhoneFor,
          people: Object.fromEntries(Object.entries(agendaCtx.people ?? {}).map(([k, v]) => [k, v.map((p) => ({ userId: p.userId, name: p.name, slots: p.slots.map((x) => x.key) }))])),
        }
      : null;
    const hasPhone = !!contact.phone || !!contact.data?.telefono || bot.data_fields.some((f) => f.type === 'phone' && !!contact.data?.[f.key]);
    const imagesById = new Map<string, ImageAsset>(allImages.map((i) => [i.id, i]));
    const model = bot.ai.model || config.openai.defaultModel;
    // Fotos con momento fijo (las garantiza el sistema): por palabra del cliente o de bienvenida, se saben antes de la IA.
    // Bienvenida: el primer mensaje del cliente, o el primero que el asistente contesta (p. ej. tras una palabra de activación).
    const firstReply = (await store.isFirstLiveInbound(conv.id, pending[0].id)) || (!history.some((m) => m.direction === 'out') && !conv.summary);
    // Una foto que ya salió para estos mensajes (p. ej. la envió el respaldo cuando la IA no respondía) no se repite.
    const scheduledBefore = await this.notDeliveredSince(conv.id, pending[0].created_at, imagesBeforeReply(images, { text: customerText, firstReply, sentIds: sentImageIds }));
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
        bot, knowledge: semantic ?? knowledge, knowledgeSelected: semantic !== null, images: aiImages, contact, conversation: conv, channelType: channel.type, history, pending, sentImageIds, imagesById, correction, intents, agenda: agendaCtx, business, pipeline,
        autoImages, contextImages: contextualImages(images), imagesNow: scheduledBefore.map((x) => x.image),
        questionAsked: questionJourney.asked,
        questionAskedEver: questionJourney.askedEver,
        requests,
        quotes: quoteCatalog,
      });
      let completion;
      try {
        completion = await accountAi(this.ai, conv.account_id, bot.id, 'decision').complete({
          model,
          fallback_models: bot.ai.fallback_models,
          messages: ctx.messages,
          temperature: bot.ai.temperature,
          reasoning_effort: bot.ai.reasoning_effort,
          json_schema: { name: 'chatbot_decision', schema: DECISION_JSON_SCHEMA as unknown as Record<string, unknown> },
        });
      } catch (e: any) {
        if(e instanceof AiBudgetBlocked){
          await this.executeHandoff(bot,conv,contact,transport,[bot.rules.handoff_message||'Una persona del equipo te ayudará a continuar.'],e.message);
          await store.markProcessed(conv.id,lastPendingId);
          return {status:'handoff',plan:emptyPlan('handoff'),fallbackUsed:true,attempts};
        }
        await log('error', 'ai', 'ai_provider_failed', {reason:'provider_unavailable'});
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
        // Solo lo que dijo en esta solicitud: una respuesta de una solicitud anterior (la fecha de la reserva pasada) no
        // contesta la pregunta de nuevo.
        customerDataSources: history.filter((m) => m.direction === 'in' && (!conv.flow_started_at || new Date(m.created_at) >= new Date(conv.flow_started_at))).map((m) => m.content),
        allowedIntents: [...intents.map((i) => i.intent), ...(pipeline?.stages.map((st) => st.intent) ?? [])],
        agenda: agendaVal,
        hasPhone,
        knownData: contact.data ?? {},
        knownName: contact.name || undefined,
        recentBotTexts,
        customerRepeats,
        questionJourney,
        contactPhone: contact.phone || undefined,
        activeImageIds: allImages.filter((i) => i.active).map((i) => i.id),
        quotes: quoteVal,
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
      // La propuesta no pasó la validación: no confirma el objetivo ni avanza la etapa (ni envía sus fotos). Tampoco mueve
      // la tarjeta del pipeline: su columna puede depender de la respuesta rechazada («ya se le dio un precio»). Ni guarda
      // sus notas: podrían repetir el dato inventado que se rechazó.
      const stageIntents = new Set(pipeline?.stages.map((st) => normalize(st.intent)) ?? []);
      const base = { ...plan, booking: null, quote: null, contextImages: [], savedCodes: [], questionLast: false, goalCompleted: false, flowStep: 0, remember: [], intents: plan.intents.filter((i) => !stageIntents.has(normalize(i))) };
      if (bookingIssue && !factIssues) {
        // La IA insistió en un horario que no existe: se ofrecen horarios reales.
        plan = { ...base, action: 'reply', messages: [slotFallback(agendaCtx)], images: [] };
      } else if (bot.rules.unknown_info_behavior === 'handoff') {
        plan = { ...base, action: 'handoff', messages: [], images: [], handoffReason: 'El bot no pudo dar una respuesta verificada' };
      } else {
        // La respuesta de respaldo no deja atrás la pregunta pendiente de la lista.
        plan = { ...base, action: 'reply', messages: [bot.rules.fallback_message, ...(base.question ? [base.question.text] : [])], images: [] };
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
      const queued=await queryOne(`SELECT EXISTS(SELECT 1 FROM inbound_receipts WHERE channel_id=$1 AND external_id=$2 AND NOT from_me
        AND state IN ('pending','running') AND message_id<>ALL($3::text[]) AND payload->>'type'<>'reaction'
        AND COALESCE(payload->>'captureOnly','false')<>'true' AND (payload->>'timestamp')::double precision>extract(epoch FROM now())-1800) AS pending`,[channel.id,contact.external_id,pending.map(m=>m.external_message_id??'')]);
      if (queued?.pending || nowPending.some((m) => m.id > lastPendingId)) return { status: 'restart', attempts };
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

    await assertOwnership();
    const liveBot = await store.getChatbot(bot.id);
    const liveChannel = await store.getChannel(channel.id);
    const control=await queryOne('SELECT control_version FROM conversations WHERE id=$1',[conv.id]);
    if(controlVersion()!==undefined&&Number(control?.control_version)!==controlVersion()) return {status:'restart'};
    if (!opts.ignoreInactive && (!liveBot?.active || !liveChannel?.active || liveChannel.account_active === false)) {
      await store.markProcessed(conv.id,lastPendingId);return {status:'inactive'};
    }
    const currentKnowledge=await store.listKnowledge(bot.id,true);
    const signature=(items:typeof knowledge)=>items.map(k=>k.id+':'+knowledgeHash(k)+':'+k.always_include).sort().join('|');
    const settings=(b:Chatbot)=>JSON.stringify([b.personality,b.rules,b.ai,b.flow,b.data_fields,b.saved_messages]);
    if(signature(currentKnowledge)!==signature(knowledge) || (liveBot&&settings(liveBot)!==settings(bot))) return {status:opts.allowRestart?'restart':'error'};
    // 4b) El cliente pide otra vez lo que ya se le resolvió: se abre una solicitud nueva y se vuelve a responder con ella
    // (preguntas, objetivo, etapas, fotos y avisos cuentan de nuevo). Con el seguro: solo si la actual ya cumplió su
    // objetivo o empezó hace un rato; si no, repetir la pregunta es seguir la misma solicitud.
    if (plan.newRequest && !opts.newRequestStarted && plan.action !== 'handoff') {
      // Sin recorrido registrado, la solicitud empezó con la conversación.
      const startedAt = new Date(conv.flow_started_at ?? (conv as typeof conv & { created_at: Date }).created_at).getTime();
      if (conv.goal_completed_at || Date.now() - startedAt >= NEW_REQUEST_COOLDOWN_MINUTES * 60_000) {
        const n = await store.beginRequest(conv.id, { reason: 'contenido', since: pending[0].created_at });
        await log('info', 'engine', `Solicitud nueva (${n}.ª): el cliente pide otra vez lo que ya se le había resuelto`);
        return this.process(conversationId, transport, { ...opts, newRequestStarted: true });
      }
      await log('info', 'engine', `La IA marcó una solicitud nueva, pero la actual empezó hace menos de ${NEW_REQUEST_COOLDOWN_MINUTES} min y no ha cumplido su objetivo: se sigue la misma`);
    }

    // 5) Ejecutar.
    const dataBefore = { ...(contact.data ?? {}) };
    const nameBefore = contact.name;
    let booked = false;
    await this.applyMemory(contact, plan, conv.id, lastPendingId, [...history, ...pending], bot);
    // Agenda: se ejecuta antes de enviar; si el horario se ocupó justo ahora, se avisa en vez de confirmar.
    if (plan.booking && this.ext.agenda) {
      await assertOwnership();
      // A restart after a booking begins requires review rather than booking again.
      if(currentOperation()) await query(`INSERT INTO delivery_attempts(operation_key,part,conversation_id,state) VALUES($1,-1,$2,'sending') ON CONFLICT DO NOTHING`,[currentOperation(),conv.id]);
      if (plan.booking.action === 'book') {
        const r = await this.ext.agenda.book({ accountId: conv.account_id, serviceId: plan.booking.serviceId, slotKey: plan.booking.slot, conversation: conv, contact, source: 'bot', assignedUserId: plan.booking.userId });
        if (!r.ok) {
          plan = {
            ...plan,
            action: 'reply',
            images: [], contextImages: [], savedCodes: [], questionLast: false,
            // Sin cita no se cumple el objetivo ni se avanza de etapa (ni salen sus fotos).
            goalCompleted: false, flowStep: 0,
            messages: [r.alternatives.length ? `Uy, ese horario se acaba de ocupar. Te puedo ofrecer ${joinOptions(r.alternatives)}. ¿Cuál te acomoda?` : 'Uy, ese horario se acaba de ocupar. ¿Te puedo ofrecer otro día?'],
          };
          await log('warn', 'engine', `No se pudo agendar: ${r.reason}`);
        } else {
          booked = true;
          // Llamadas: con quién y, si es videollamada, el enlace (la IA no lo conoce al escribir).
          const ap = r.appointment;
          const extra = ap.meeting_url
            ? `📹 Este es el enlace para la videollamada${ap.assigned_user_name ? ` con ${ap.assigned_user_name}` : ''}: ${ap.meeting_url}`
            : ap.kind === 'call' && ap.assigned_user_name ? `📞 Te llamará ${ap.assigned_user_name} a esa hora.` : '';
          if (extra) plan = { ...plan, messages: [...plan.messages, extra] };
        }
      } else {
        await this.ext.agenda.cancel(plan.booking.appointmentId, 'Cancelada por el cliente en el chat', 'bot');
      }
    }
    const meta = { action: plan.action, info_not_found: plan.infoNotFound, fallback: fallbackUsed };
    if(plan.booking && currentOperation()) await query(`UPDATE delivery_attempts SET state='sent',updated_at=now() WHERE operation_key=$1 AND part=-1`,[currentOperation()]);
    // Cotización: se crea antes de enviar (una operación repetida tras un reinicio reutiliza la misma). Las aproximadas
    // salen con su PDF en esta respuesta; las finales quedan para que el equipo las apruebe.
    let quoteOut: QuoteDelivery | null = null;
    if (plan.quote && this.ext.quotes && quoteCatalog && plan.action !== 'handoff' && plan.action !== 'no_reply') {
      await assertOwnership();
      if (currentOperation()) await query(`INSERT INTO delivery_attempts(operation_key,part,conversation_id,state) VALUES($1,-2,$2,'sending') ON CONFLICT DO NOTHING`, [currentOperation(), conv.id]);
      const prepared = await this.ext.quotes.prepare({ bot, conv, contact, planned: plan.quote, catalog: quoteCatalog, operation: currentOperation() ?? undefined })
        .catch(async (e) => { await log('error', 'engine', `No se pudo preparar la cotización: ${e?.message ?? e}`); return null; });
      if (prepared?.status === 'ready') {
        // Los canales que no envían archivos reciben un enlace firmado al PDF.
        const link = transport.sendFile ? undefined : this.ext.quotes.link(prepared.quote);
        quoteOut = { text: this.ext.quotes.message(bot, prepared.quote, link), file: transport.sendFile ? prepared.file : undefined, quote: prepared.quote, link };
      } else if (prepared) quoteOut = { text: prepared.text, pending: prepared.status === 'pending' ? prepared.quote : undefined };
      if (currentOperation()) await query(`UPDATE delivery_attempts SET state='sent',updated_at=now() WHERE operation_key=$1 AND part=-2`, [currentOperation()]);
    }
    // Recorrido: el objetivo solo cuenta una vez por conversación (hasta que se cierre y se reabra).
    const goalReached = plan.goalCompleted && !conv.goal_completed_at;
    const goalHandoff = goalReached && bot.flow.on_goal_action === 'handoff' && plan.action !== 'handoff';
    // Mensajes guardados: texto y foto juntos, tal cual los escribió el negocio. Sus fotos cuentan para el máximo por respuesta.
    // En una transferencia o sin respuesta no se envían (ni cambian la etapa).
    const saved = plan.action === 'handoff' || plan.action === 'no_reply' ? [] : savedItems(bot, plan.savedCodes, imagesById);
    for (const x of saved) if (x.missingImage) await log('warn', 'engine', `La foto del mensaje guardado "${x.message.code}" no existe o está inactiva: se envía solo el texto`);
    let photoSlots = bot.rules.max_images_per_reply;
    const savedPhotoSeen = new Set<string>();
    for (const x of saved) {
      // La misma foto en dos mensajes guardados sale una sola vez (el segundo va solo con su texto).
      if (x.image && savedPhotoSeen.has(x.image.id)) x.image = null;
      else if (x.image && photoSlots > 0) {
        photoSlots--;
        savedPhotoSeen.add(x.image.id);
      }
      else if (x.image) {
        await log('warn', 'engine', `Foto del mensaje guardado "${x.message.code}" omitida por el límite de ${bot.rules.max_images_per_reply} por respuesta`);
        x.image = null;
      }
    }
    const sendable = saved.filter((x) => x.image || x.message.text);
    // Etapa del recorrido: la que marque la IA; si no marcó, la del último mensaje guardado que tenga una.
    const savedStep = sendable.map((x) => x.message.flow_step).filter((n) => n > 0 && n <= bot.flow.steps.length).pop() ?? 0;
    if (!plan.flowStep && savedStep) plan = { ...plan, flowStep: savedStep };
    const stageChanged = !!plan.flowStep && plan.flowStep !== (conv.flow_step ?? 0);
    // Fotos programadas: se suman a las que eligió la IA (sin repetir). En una transferencia no se envían.
    let selectedRules: ScheduledImage[] = [];
    // Fotos que el sistema debía enviar y no salieron en esta respuesta (límite por respuesta o rechazo de la plataforma):
    // no se pierden, se reintentan enseguida.
    const owed: { image: ImageAsset; reason: string; delaySeconds: number; repeat?: boolean }[] = [];
    // Fotos automáticas que van dentro de un mensaje guardado: si la plataforma las rechaza, también se reintentan.
    let savedRules: ScheduledImage[] = [];
    if (plan.action !== 'handoff') {
      // Lo que realmente recibe el cliente: también los mensajes guardados y la pregunta que va al final.
      const outgoingText = [...plan.messages, ...sendable.map((x) => x.message.text), ...(plan.questionLast && plan.question ? [plan.question.text] : [])].join(' ');
      const assistant = imagesForAssistant(images, outgoingText, sentImageIds);
      const after = imagesAfterReply(images, {
        stepReached: plan.flowStep && plan.flowStep !== (conv.flow_step ?? 0) ? plan.flowStep : 0,
        goalReached,
        booked,
        sentIds: sentImageIds,
        skip: scheduledBefore.map((x) => x.image.id),
      });
      const contextual = imagesForContext(images, plan.contextImages.map(img => img.code), sentImageIds);
      // Una foto que ya va en un mensaje guardado no sale otra vez en la misma respuesta.
      const inSaved = new Set(sendable.flatMap((x) => (x.image ? [x.image.id] : [])));
      const all = [...scheduledBefore, ...assistant, ...after, ...contextual].filter((x, i, list) => list.findIndex(y => y.image.id === x.image.id) === i);
      savedRules = all.filter((x) => inSaved.has(x.image.id));
      const automatic = all.filter((x) => !inSaved.has(x.image.id));
      // Primero las que eligió la IA (las anunció en su texto); las automáticas que no quepan salen unos segundos después.
      const ai = plan.images.filter((img) => !inSaved.has(img.id));
      const candidates = [...ai, ...automatic.map(x => x.image).filter((img) => !ai.some((a) => a.id === img.id))];
      const selected = candidates.slice(0, photoSlots);
      selectedRules = automatic.filter(x => selected.some(img => img.id === x.image.id));
      if (candidates.length > selected.length) {
        // Las que salen por una regla del negocio (etapa, objetivo, palabra…) se envían después; las que eligió la IA, no.
        const over = candidates.slice(selected.length);
        const later = over.filter((img) => automatic.some((x) => x.image.id === img.id));
        const dropped = over.filter((img) => !later.includes(img));
        if (dropped.length) await log('warn', 'engine', `Fotos omitidas por el límite de ${bot.rules.max_images_per_reply} por respuesta: ${dropped.map(img => img.code).join(', ')}`);
        if (later.length) await log('info', 'engine', `Fotos del negocio que no caben en esta respuesta (límite de ${bot.rules.max_images_per_reply}); se envían enseguida: ${later.map(img => img.code).join(', ')}`);
        for (const img of later) owed.push({ image: img, reason: automatic.find((x) => x.image.id === img.id)!.reason, delaySeconds: 5, repeat: sentImageIds.includes(img.id) });
      }
      if (selected.length) plan = { ...plan, action: 'reply_with_image', images: selected };
      // Sin lugar para fotos (p. ej. ya lo ocupó un mensaje guardado): no sale ninguna de las que propuso la IA.
      else if (plan.images.length) plan = { ...plan, action: plan.action === 'reply_with_image' ? 'reply' : plan.action, images: [] };

    }
    if (plan.action === 'handoff') {
      await this.executeHandoff(bot, conv, contact, transport, plan.messages, plan.handoffReason || 'La IA decidió transferir');
    } else if (plan.action !== 'no_reply') {
      const failed = await this.sendPlan(bot, conv, transport, plan, meta, [...selectedRules, ...savedRules], sendable, quoteOut);
      for (const x of failed) owed.push({ image: x.image, reason: x.reason, delaySeconds: 45, repeat: sentImageIds.includes(x.image.id) });
    }
    if (quoteOut?.quote && quoteOut.delivered && this.ext.quotes) {
      const sentQuote = await this.ext.quotes.delivered(conv, quoteOut.quote, { via: quoteOut.delivered }).catch((e) => { log('error', 'engine', `No se pudo registrar el envío de la cotización: ${e?.message ?? e}`); return null; });
      if (sentQuote) this.ext.onEvent?.({ type: 'quote_sent', conversationId: conv.id, quote: quoteEvent(sentQuote), text: customerText });
    }
    if (quoteOut?.pending) this.ext.onEvent?.({ type: 'quote_pending_approval', conversationId: conv.id, quote: quoteEvent(quoteOut.pending), text: customerText });
    // Una persona tomó la conversación mientras se enviaba la respuesta: el asistente ya no se despide, no la cierra, no la
    // pausa ni la transfiere, y las fotos pendientes no salen después del mensaje de esa persona.
    const tookOver = plan.action !== 'handoff' && (await store.getConversation(conv.id))?.status !== 'bot';
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
        if (goalHandoff && !tookOver) {
          // Ya se envió la respuesta de la IA (que se despide): solo se pasa a una persona, sin otro mensaje.
          await this.executeHandoff(bot, conv, contact, transport, [], 'Se cumplió el objetivo de la conversación', { silent: true });
        } else if (bot.flow.on_goal_action === 'notify' && channel.type !== 'playground' && this.ext.alertTeam) {
          const who = contact.name || contact.push_name || contact.phone || 'Un cliente';
          const brief = await briefReport(conv.id, 1500, { customer: false }).catch(() => '');
          await this.ext.alertTeam(conv.account_id, { title: '🎯 Objetivo cumplido', body: `${who} (${channel.name}): ${bot.flow.goal}${brief ? `\n\n${brief}` : ''}`, link: `#/conversation/${conv.id}`, conversationId: conv.id, kind: 'goal' });
        }
      }
    }
    // Fin de la lista de preguntas: se registra una sola vez por recorrido (aunque este turno sea una transferencia o
    // no envíe nada), así no se vuelve a disparar cuando el asistente retome la conversación.
    const questionsDone = plan.questionsCompleted && (await store.markQuestionsDone(conv.id));
    if (questionsDone) await log('info', 'engine', 'El cliente terminó las preguntas de la lista');
    // Desactivadores después de responder (objetivo, cita, preguntas, datos completos).
    let ended = goalHandoff && !tookOver;
    if (plan.action !== 'handoff' && !goalHandoff && !tookOver) {
      const why = offAfterReply(bot.rules.activation, { goalReached, booked, questionsCompleted: questionsDone, nameKey: contactNameKey(bot.data_fields), before: { name: nameBefore, data: dataBefore }, after: contact });
      if (why) {
        ended = true;
        await this.deactivate(bot, conv, contact, transport, why);
      }
    }
    // Las fotos que faltaron salen aunque la conversación haya pasado a una persona o se haya cerrado en este mismo momento.
    for (const x of owed) await this.ext.deferImage?.(conv, x.image, { reason: x.reason, delaySeconds: x.delaySeconds, allowEnded: ended, allowRepeat: x.repeat }).catch((e) => log('error', 'engine', `No se pudo programar el reenvío de la foto ${x.image.code}: ${e?.message ?? e}`));
    // Eventos para las reglas automáticas (se ejecutan después, sin bloquear la respuesta).
    if (this.ext.onEvent) {
      if (plan.intents.length) this.ext.onEvent({ type: 'intent', conversationId: conv.id, intents: plan.intents, text: customerText });
      if (stageChanged) this.ext.onEvent({ type: 'stage_reached', conversationId: conv.id, step: plan.flowStep, text: customerText });
      if (goalReached) this.ext.onEvent({ type: 'goal_completed', conversationId: conv.id, text: customerText });
      for (const [field, value] of Object.entries(contact.data ?? {})) {
        if (value && dataBefore[field] !== value) this.ext.onEvent({ type: 'data_captured', conversationId: conv.id, field, text: customerText });
      }
    }

    // Keep the ownership session alive until dependent events settle. A crash before this commit retains inbound work.
    await this.ext.settleEvents?.(conv.id);
    await store.markProcessed(conv.id,lastPendingId);

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

  /** Quita las fotos que ya llegaron al cliente desde ese momento. */
  private async notDeliveredSince(conversationId: string, since: Date, list: ScheduledImage[]) {
    const out: ScheduledImage[] = [];
    for (const x of list) if (!(await store.imageSentSince(conversationId, x.image.id, since))) out.push(x);
    return out;
  }

  /**
   * La IA no pudo responder (tras reintentar): las fotos que el negocio programó para estos mensajes y no dependen de la
   * IA (palabras del cliente y bienvenida) salen igual. Se programan como pendientes: así pasan por las mismas
   * comprobaciones (una persona respondió, asistente en pausa, foto inactiva, ya enviada) y se reintentan si fallan.
   */
  async sendRuleImagesWithoutAi(conversationId: string): Promise<number> {
    const conv = await store.getConversation(conversationId);
    if (!conv?.chatbot_id || conv.status !== 'bot' || !this.ext.deferImage) return 0;
    const bot = await store.getChatbot(conv.chatbot_id);
    if (!bot || !agentActive(bot, conv) || bot.rules.max_images_per_reply <= 0) return 0;
    const pending = await store.pendingInbound(conv.id);
    if (!pending.length) return 0;
    const [images, sentIds, history] = await Promise.all([
      store.listImages(bot.id, true),
      store.sentImageIds(conv.id),
      store.unsummarizedMessages(conv.id, conv.summary_until_id, bot.ai.recent_messages + bot.ai.summary_batch + pending.length + 4),
    ]);
    const firstReply = (await store.isFirstLiveInbound(conv.id, pending[0].id)) || (!history.some((m) => m.direction === 'out') && !conv.summary);
    const owed = await this.notDeliveredSince(conv.id, pending[0].created_at, imagesBeforeReply(images, { text: pending.map((m) => m.content).join('\n'), firstReply, sentIds }));
    for (const x of owed) await this.ext.deferImage(conv, x.image, { reason: `${x.reason} (la IA no respondió)`, delaySeconds: 0, allowEnded: false, allowRepeat: sentIds.includes(x.image.id) });
    return owed.length;
  }

  /**
   * El asistente no pudo responder: el cliente recibe el mensaje de cortesía una sola vez por grupo de mensajes sin
   * responder (la operación es idempotente) y no se repite mientras el último mensaje enviado siga siendo ese aviso.
   */
  async sendUnavailableNotice(conversationId: string, transport: Transport): Promise<boolean> {
    const conv = await store.getConversation(conversationId);
    if (!conv?.chatbot_id || conv.status !== 'bot') return false;
    const bot = await store.getChatbot(conv.chatbot_id);
    const text = bot?.rules.unavailable_message?.trim();
    if (!bot || !text || !bot.active || !agentActive(bot, conv)) return false;
    const pending = await store.pendingInbound(conv.id);
    if (!pending.length) return false;
    // «Una pequeña demora» no tiene sentido para un mensaje de hace horas (p. ej. tras un apagón largo): ahí solo se avisa al equipo.
    if (Date.now() - new Date(pending.at(-1)!.created_at).getTime() > 6 * 3600_000) return false;
    const last = await queryOne(`SELECT meta FROM messages WHERE conversation_id=$1 AND direction='out' ORDER BY id DESC LIMIT 1`, [conv.id]);
    if (last?.meta?.source === 'unavailable') return false;
    const sent = await operationScope(`unavailable:${conv.id}:${pending.at(-1)!.id}`, () =>
      this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: 0, meta: { source: 'unavailable' } }));
    return !!sent;
  }

  /** Envía el plan. Devuelve las fotos que la plataforma rechazó (de reglas del negocio o elegidas por la IA) para reintentarlas. */
  async sendPlan(bot: Chatbot, conv: Conversation, transport: Transport, plan: ExecutionPlan, meta: Record<string, unknown>, scheduled: ScheduledImage[] = [], saved: SavedItem[] = [], quote: QuoteDelivery | null = null): Promise<ScheduledImage[]> {
    const typing = bot.ai.typing_simulation && hasTyping(transport);
    // En correo, varias burbujas serían varios correos: se envían como uno solo.
    const texts = transport.kind === 'email' && plan.messages.length > 1 ? [plan.messages.join('\n\n')] : plan.messages;
    // Si una persona tomó la conversación mientras la IA respondía, lo que falta de la respuesta ya no sale.
    const stillBot = async () => (await store.getConversation(conv.id))?.status === 'bot';
    // El mensaje que hace la pregunta pendiente de la lista queda marcado (así se sabe cuántas veces se hizo).
    let questionTagged = false;
    const tag = (text: string, m: Record<string, unknown>) => {
      if (!plan.question || questionTagged || !asksQuestion(text, { question: plan.question.text })) return m;
      questionTagged = true;
      return { ...m, question: plan.question.key };
    };
    for (const text of texts) {
      if (!(await stillBot())) return [];
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, typing), meta: tag(text, meta) });
    }
    // La cotización va justo después de lo que escribió la IA: el mensaje con el total y, enseguida, el PDF.
    if (quote) {
      if (!(await stillBot())) return [];
      const quoteMeta = { ...meta, quote_message: true, ...(quote.quote ? { quote_id: quote.quote.id, quote_kind: quote.quote.kind } : {}) };
      const told = await this.sendOut(bot, conv, transport, { sender: 'bot', text: quote.text, delay: typingDelay(quote.text, typing), meta: quoteMeta });
      if (told && quote.quote && quote.link) quote.delivered = 'link';
      if (told && quote.file && (await stillBot())) {
        const sentFile = await this.sendOut(bot, conv, transport, { sender: 'bot', text: '', file: quote.file, delay: typing ? 1200 : 0, meta: quoteMeta });
        if (sentFile) quote.delivered = 'file';
        else if (this.ext.quotes && quote.quote) {
          // La plataforma rechazó el archivo: el cliente recibe el enlace al PDF.
          const link = this.ext.quotes.link(quote.quote);
          const again = await this.sendOut(bot, conv, transport, { sender: 'bot', text: `${bot.personality.formality === 'usted' ? 'Puede' : 'Puedes'} ver la cotización aquí: ${link}`, delay: 0, meta: quoteMeta });
          if (again) quote.delivered = 'link';
        }
      }
    }
    const failed: ScheduledImage[] = [];
    for (const { message: m, image } of saved) {
      if (!(await stillBot())) return failed;
      const savedMeta = tag(m.text, { ...meta, saved_message: m.code });
      // La foto de un mensaje guardado que además pide una regla del negocio se reintenta si la plataforma la rechaza.
      const rule = image ? scheduled.find((x) => x.image.id === image.id) : undefined;
      if (image && m.text.length <= CAPTION_MAX) {
        // Un solo mensaje: la foto con el texto como pie.
        const sent = await this.sendOut(bot, conv, transport, { sender: 'bot', text: m.text, image, delay: typing ? 1200 : 0, meta: savedMeta });
        // Si la plataforma rechaza la foto, el cliente igual recibe el texto.
        if (!sent && m.text) await this.sendOut(bot, conv, transport, { sender: 'bot', text: m.text, delay: 0, meta: { ...savedMeta, image_failed: true } });
        if (!sent && rule) failed.push(rule);
      } else {
        // Sin foto, o un texto que no cabe como pie: el texto y después la foto.
        if (m.text) await this.sendOut(bot, conv, transport, { sender: 'bot', text: m.text, delay: typingDelay(m.text, typing), meta: savedMeta });
        const sent = image ? await this.sendOut(bot, conv, transport, { sender: 'bot', text: '', image, delay: typing ? 1200 : 0, meta: { ...meta, saved_message: m.code } }) : null;
        if (image && !sent && rule) failed.push(rule);
      }
    }
    for (const img of plan.images) {
      if (!(await stillBot())) return failed;
      const rule = scheduled.find(x => x.image.id === img.id);
      const sent = await this.sendOut(bot, conv, transport, { sender: 'bot', text: img.caption, image: img, delay: typing ? 1200 : 0, meta: rule ? {...meta, image_trigger: rule.reason} : meta });
      if (sent && rule) await logEvent({ level: 'info', source: 'engine', message: `Foto enviada por regla: ${img.code} (${rule.reason})`, accountId: conv.account_id, chatbotId: bot.id, channelId: conv.channel_id, conversationId: conv.id });
      // Una foto rechazada no se pierde: la de una regla y la que eligió la IA (y ya anunció en su texto) se reintentan.
      if (!sent) failed.push(rule ?? { image: img, reason: 'la IA la eligió para esta respuesta' });
    }
    // La pregunta pendiente va al final cuando la respuesta lleva mensajes guardados.
    if (plan.questionLast && plan.question && (await stillBot())) {
      const text = plan.question.text;
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, typing), meta: tag(text, meta) });
    }
    return failed;
  }

  /** Guarda el mensaje ANTES de enviarlo (para reconocer el eco del webhook) y luego lo envía. */
  async sendOut(
    bot: Chatbot | null,
    conv: Conversation,
    transport: Transport,
    o: { sender: 'bot' | 'human' | 'system'; text: string; image?: ImageAsset; file?: OutgoingFile; template?: OutgoingTemplate; buttons?: OutgoingButton[]; delay: number; meta?: Record<string, unknown> },
  ): Promise<Message | null> {
    const delivery=nextDelivery();
    // Delay locally; check ownership/human control immediately before the transport, with no typing sleep inside it.
    if(o.delay>0) {
      await transport.startTyping?.().catch(()=>undefined);
      await new Promise(r=>setTimeout(r,Math.min(o.delay,7000)));
    }
    await assertOwnership();
    if(o.image) {
      const image=await store.getImage(o.image.id);
      const owner=image?await store.getChatbot(image.chatbot_id):null;
      if(!image?.active || owner?.account_id!==conv.account_id) return null;
    }
    if(o.sender==='bot') {
      const fresh=await store.getConversation(conv.id);
      const latestBot=bot ? await store.getChatbot(bot.id) : null;
      const channel=await store.getChannel(conv.channel_id);
      const version=await queryOne('SELECT control_version FROM conversations WHERE id=$1',[conv.id]);
      const ownHandoff=o.meta?.action==='handoff' && controlVersion()===Number(version?.control_version);
      const explicitHuman=o.meta?.allow_when_human===true;
      const explicitClosed=fresh?.status==='closed' && o.meta?.allow_when_closed===true;
      const assistantReply=!o.meta?.source || o.meta.source==='flow';
      if(controlVersion()!==undefined && controlVersion()!==Number(version?.control_version)) return null;
      if(!fresh || (fresh.status!=='bot' && !ownHandoff && !explicitHuman && !explicitClosed) ||
        (transport.kind!=='playground' && (!channel?.active || channel.account_active===false || (assistantReply && bot&&!latestBot?.active))) ||
        (assistantReply && latestBot && fresh.status==='bot' && !agentActive(latestBot,fresh))) return null;
    }
    const old=await queryOne(`SELECT d.*,m.* FROM delivery_attempts d LEFT JOIN messages m ON m.id=d.message_id WHERE operation_key=$1 AND part=$2`,[delivery.operation,delivery.part]);
    if(old) {
      if(old.state==='sent') return old as Message;
      if(['sending','uncertain'].includes(old.state)) throw new DeliveryUncertain();
      if(old.state==='rejected'||old.state==='cancelled') return null;
    }
    const msg=await withTransaction(async client=>{
      const message=await store.insertMessage({
        conversation_id:conv.id,direction:'out',sender:o.sender,type:o.file?o.file.kind:o.image?'image':'text',content:o.text,
        image_id:o.image?.id??null,status:'pending',meta:o.file?{...o.meta,attachment_id:o.file.id,file_name:o.file.name}:o.buttons?.length?{...o.meta,buttons:o.buttons}:o.meta,
      },client);
      if(!message) return null;
      const reserved=await client.query(`INSERT INTO delivery_attempts(operation_key,part,conversation_id,message_id,state) VALUES($1,$2,$3,$4,'sending') ON CONFLICT DO NOTHING RETURNING part`,[delivery.operation,delivery.part,conv.id,message.id]);
      if(!reserved.rowCount) throw new DeliveryUncertain();
      return message;
    });
    if(!msg) return null;
    const expectedControl=controlVersion();
    transport.setDispatchGuard?.(async()=>{
      await assertOwnership();
      if(o.sender==='bot') {
        const current=await queryOne('SELECT control_version FROM conversations WHERE id=$1',[conv.id]);
        if(expectedControl!==undefined&&Number(current?.control_version)!==expectedControl) throw new OwnershipLost();
      }
    });
    try {
      await assertOwnership();
      if(o.sender==='bot' && controlVersion()!==undefined) {
        const control=await queryOne('SELECT control_version FROM conversations WHERE id=$1',[conv.id]);
        if(Number(control?.control_version)!==controlVersion()) {
          await query(`UPDATE delivery_attempts SET state='cancelled',updated_at=now() WHERE operation_key=$1 AND part=$2`,[delivery.operation,delivery.part]);
          await store.updateMessage(msg.id,{status:'cancelled'});
          return null;
        }
      }
      const extId=o.template ? (transport.sendTemplate ? await transport.sendTemplate(o.template) : (()=>{throw new Error('unsupported_template');})())
        : o.file ? (transport.sendFile ? await transport.sendFile(o.file,o.text,0) : (()=>{throw new Error('unsupported_file');})())
        : o.image ? await transport.sendImage(o.image,o.text,0)
        : o.buttons?.length ? (transport.sendButtons ? await transport.sendButtons(o.text,o.buttons,0) : (()=>{throw new Error('unsupported_buttons');})())
        : await transport.sendText(o.text,0);
      // Persist the receipt before usage/events. A DB failure here is an uncertain delivery.
      await store.updateMessage(msg.id,{external_message_id:extId,status:'ok'});
      await query(`UPDATE delivery_attempts SET state='sent',updated_at=now() WHERE operation_key=$1 AND part=$2`,[delivery.operation,delivery.part]);
      if(o.sender==='bot' && transport.kind!=='playground') await recordMessage(conv.account_id).catch(()=>undefined);
      const sent={...msg,status:'ok',external_message_id:extId};
      if(this.ext.onOutbound) await this.ext.onOutbound(conv,sent).catch(()=>undefined);
      return sent;
    } catch(e:any) {
      // Only explicit client rejections are safe to treat as not delivered. Timeouts/5xx/network failures are ambiguous.
      const rejected=/\bHTTP\s+4\d\d\b|→\s*4\d\d\b/.test(String(e?.message)) || e?.message==='unsupported_file' || e?.message==='unsupported_template' || e?.message==='unsupported_buttons' || e instanceof OutboundBlockedError;
      const state=rejected?'rejected':'uncertain';
      await query(`UPDATE delivery_attempts SET state=$3,updated_at=now() WHERE operation_key=$1 AND part=$2`,[delivery.operation,delivery.part,state]).catch(()=>undefined);
      await store.updateMessage(msg.id,{status:rejected?'failed':'uncertain',meta:{error_code:state}}).catch(()=>undefined);
      await logEvent({level:'error',source:'channel',message:'delivery_failure',accountId:conv.account_id,chatbotId:bot?.id??null,channelId:conv.channel_id,conversationId:conv.id,details:{state,kind:transport.kind}}).catch(()=>undefined);
      if(!rejected) throw new DeliveryUncertain();
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
    await assertOwnership();
    if(before?.status==='human') return;
    const control=await queryOne(`UPDATE conversations SET status='human',handoff_reason=$2,status_changed_at=now() WHERE id=$1 AND status='bot' AND ($3::bigint IS NULL OR control_version=$3) RETURNING control_version`,[conv.id,reason,controlVersion()??null]);
    if(!control) return;
    setControlVersion(Number(control.control_version));
    // Queda en el contacto quién la pasó y desde dónde. Si una persona ya la atendía, no se pisa.
    await store.markHandoff(contact.id, null, opts.via ?? 'bot');
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
        // Nunca cierra una conversación que ya atiende una persona.
        if ((await store.getConversation(conv.id))?.status !== 'bot') return;
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
