import { config } from '../config.js';
import type { AiProvider } from '../ai/provider.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Chatbot, Contact, Conversation, ImageAsset, Message } from '../types.js';
import { buildContext } from './context.js';
import { DECISION_JSON_SCHEMA } from './decision.js';
import { maybeSummarize } from './memory.js';
import { normalize } from './text.js';
import type { Transport } from './transport.js';
import { emptyPlan, validateDecision, type ExecutionPlan, type ValidationInput } from './validator.js';

export interface ProcessResult {
  status: 'nothing' | 'inactive' | 'human' | 'handoff' | 'replied' | 'no_reply' | 'restart' | 'error';
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

export function typingDelay(text: string, enabled: boolean) {
  if (!enabled) return 0;
  return Math.max(1000, Math.min(7000, 700 + text.length * 35));
}

export class Engine {
  constructor(private ai: AiProvider) {}

  /** Procesa los mensajes pendientes de una conversación y ejecuta la acción validada. */
  async process(conversationId: string, transport: Transport, opts: ProcessOptions = {}): Promise<ProcessResult> {
    const conv = await store.getConversation(conversationId);
    if (!conv) return { status: 'nothing' };
    const bot = await store.getChatbot(conv.chatbot_id);
    const contact = await store.getContact(conv.contact_id);
    if (!bot || !contact) return { status: 'nothing' };

    const pending = await store.pendingInbound(conv.id);
    if (!pending.length) return { status: 'nothing' };
    const lastPendingId = pending[pending.length - 1].id;

    if (!bot.active && !opts.ignoreInactive) {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'inactive' };
    }
    if (conv.status !== 'bot') {
      await store.markProcessed(conv.id, lastPendingId);
      return { status: 'human' };
    }

    const customerText = pending.map((m) => m.content).join('\n');
    const log = (level: 'info' | 'warn' | 'error', source: 'engine' | 'ai' | 'validator' | 'evolution', message: string, details?: unknown) =>
      logEvent({ level, source, message, details, chatbotId: bot.id, conversationId: conv.id });

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
    const imagesById = new Map<string, ImageAsset>(allImages.map((i) => [i.id, i]));
    const model = bot.ai.model || config.openai.defaultModel;

    // 3) La IA propone; el backend valida (con un reintento guiado).
    let correction: string | undefined;
    let plan: ExecutionPlan | null = null;
    let lastRaw: unknown;
    let retryable: string[] = [];
    let factIssues = false;
    let lastInput: ValidationInput | undefined;
    const attempts: ProcessResult['attempts'] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctx = buildContext({ bot, knowledge, images, contact, conversation: conv, history, pending, sentImageIds, imagesById, correction });
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
      lastInput = { raw, bot, images, sentImageIds, customerText, groundingSources: ctx.groundingSources, customerSources: ctx.customerSources };
      const v = validateDecision({ ...lastInput, final: attempt === MAX_ATTEMPTS });
      attempts.push({ retryable: v.retryable, fixes: v.fixes });
      await store.insertAiRun({
        chatbot_id: bot.id,
        conversation_id: conv.id,
        kind: 'decision',
        model: completion.model,
        input_tokens: completion.usage.input_tokens,
        cached_tokens: completion.usage.cached_tokens,
        output_tokens: completion.usage.output_tokens,
        latency_ms: completion.latency_ms,
        attempt,
        decision: raw,
        validation: { retryable: v.retryable, fixes: v.fixes, action: v.plan.action },
      });
      if (v.fixes.length) await log('info', 'validator', `Correcciones aplicadas: ${v.fixes.join(' | ')}`);
      plan = v.plan;
      retryable = v.retryable;
      factIssues = v.factIssues;
      if (!retryable.length) break;
      await log('warn', 'validator', `Propuesta rechazada (intento ${attempt}): ${retryable.join(' | ')}`, { decision: raw });
      correction = retryable.join(' ');
    }

    let fallbackUsed = false;
    if (!plan || (retryable.length && !factIssues)) {
      // Respuesta inválida (JSON roto o vacía) incluso tras reintentar: no se envía nada inventado.
      await log('error', 'ai', 'La IA no generó una respuesta válida; se reintentará más tarde', { issues: retryable, decision: lastRaw });
      return { status: 'error', error: retryable.join(' | ') || 'Respuesta inválida', attempts };
    }
    if (retryable.length) {
      // Datos no verificables tras el reintento: respuesta segura según la regla configurada.
      fallbackUsed = true;
      const base = plan;
      if (bot.rules.unknown_info_behavior === 'handoff') {
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

    // 5) Ejecutar.
    await this.applyMemory(contact, plan);
    const meta = { action: plan.action, info_not_found: plan.infoNotFound, fallback: fallbackUsed };
    if (plan.action === 'handoff') {
      await this.executeHandoff(bot, conv, contact, transport, plan.messages, plan.handoffReason || 'La IA decidió transferir');
    } else if (plan.action !== 'no_reply') {
      await this.sendPlan(bot, conv, transport, plan, meta);
    }
    await store.markProcessed(conv.id, lastPendingId);

    // 6) Memoria de largo plazo (resumen) en segundo plano.
    maybeSummarize(this.ai, bot, conv.id).catch((e) => log('error', 'ai', `Error al resumir: ${e?.message ?? e}`, e));

    return {
      status: plan.action === 'handoff' ? 'handoff' : plan.action === 'no_reply' ? 'no_reply' : 'replied',
      plan,
      decision: lastRaw,
      attempts,
      fallbackUsed,
    };
  }

  async sendPlan(bot: Chatbot, conv: Conversation, transport: Transport, plan: ExecutionPlan, meta: Record<string, unknown>) {
    const typing = bot.ai.typing_simulation && transport.kind === 'whatsapp';
    for (const text of plan.messages) {
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, typing), meta });
    }
    for (const img of plan.images) {
      await this.sendOut(bot, conv, transport, { sender: 'bot', text: img.caption, image: img, delay: typing ? 1200 : 0, meta });
    }
  }

  /** Guarda el mensaje ANTES de enviarlo (para reconocer el eco del webhook) y luego lo envía. */
  async sendOut(
    bot: Chatbot,
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
      await store.updateMessage(msg.id, { evolution_message_id: extId, status: 'ok' });
      return { ...msg, status: 'ok', evolution_message_id: extId };
    } catch (e: any) {
      await store.updateMessage(msg.id, { status: 'failed', meta: { error: String(e?.message ?? e) } });
      await logEvent({
        level: 'error',
        source: 'evolution',
        message: `No se pudo enviar ${o.image ? `la imagen ${o.image.code}` : 'el mensaje'}: ${e?.message ?? e}`,
        chatbotId: bot.id,
        conversationId: conv.id,
        details: e,
      });
      return null;
    }
  }

  async executeHandoff(bot: Chatbot, conv: Conversation, contact: Contact, transport: Transport, messages: string[], reason: string) {
    await store.setConversationStatus(conv.id, 'human', reason);
    const texts = messages.length ? messages : bot.rules.handoff_message ? [bot.rules.handoff_message] : [];
    for (const text of texts) {
      await this.sendOut(bot, conv, transport, { sender: 'bot', text, delay: typingDelay(text, bot.ai.typing_simulation && transport.kind === 'whatsapp'), meta: { action: 'handoff' } });
    }
    await logEvent({ level: 'info', source: 'engine', message: `Conversación transferida a humano: ${reason}`, chatbotId: bot.id, conversationId: conv.id });
    if (bot.rules.handoff_notify_number) {
      const who = contact.name || contact.push_name || contact.phone || contact.jid;
      const text = `🔔 *${bot.name}*: ${who}${contact.phone ? ` (+${contact.phone})` : ''} necesita atención.\nMotivo: ${reason}`;
      try {
        await transport.notify(bot.rules.handoff_notify_number, text);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'evolution', message: `No se pudo avisar al encargado: ${e?.message ?? e}`, chatbotId: bot.id, conversationId: conv.id });
      }
    }
  }

  async applyMemory(contact: Contact, plan: ExecutionPlan) {
    const hasData = Object.keys(plan.saveData).length > 0;
    if (!hasData && !plan.contactName && !plan.remember.length) return;
    const data = { ...(contact.data ?? {}), ...plan.saveData };
    const notes = [...(contact.notes ?? [])];
    for (const r of plan.remember) {
      const n = normalize(r);
      if (!notes.some((x) => normalize(x) === n)) notes.push(r);
    }
    while (notes.length > 30) notes.shift();
    const updated = await store.updateContact(contact.id, { data, notes, name: plan.contactName ?? undefined });
    if (updated) Object.assign(contact, updated);
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
