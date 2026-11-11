/**
 * Cotizaciones del asistente: qué puede cotizar (contexto para la IA), preparar la cotización que la IA propuso (ya
 * validada) y registrar que llegó al cliente. Las aproximadas salen solas; las finales quedan para que el equipo las
 * apruebe.
 */
import { conversationAlert } from '../automation/alert-format.js';
import { attachmentAbsolutePath } from '../attachments.js';
import { signedQuoteUrl } from '../channels/media.js';
import * as astore from '../automation/store.js';
import type { AutomationEvent } from '../automation/types.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import * as pstore from '../store/pipelines.js';
import * as calcstore from '../store/quote-calculators.js';
import * as qstore from '../store/quotes.js';
import type { Chatbot, Contact, Conversation, DataField } from '../types.js';
import type { OutgoingFile } from '../engine/transport.js';
import { ADVISOR_MESSAGE, evaluateCalculator, prepareCalculator, type CalculatorDefinition, type CalculatorResult } from './calculator.js';
import { formatTotals } from './format.js';
import { failedMessage, pendingMessage, quoteMessage, summaryMessage } from './messages.js';
import { localDate, renderQuote } from './render.js';

/** Lo que el asistente sabe para cotizar en esta conversación. */
export interface QuoteCatalog {
  settings: qstore.QuoteSettings;
  items: qstore.PriceItem[];
  /** Datos que el cliente debe dar antes de cotizar. */
  requiredFields: DataField[];
  allowFinal: boolean;
  templateId: string | null;
  requestId: number | null;
  /** Cotización en proceso (por aprobar) en esta solicitud o conversación. */
  open: qstore.Quote | null;
  /** Última cotización que recibió el cliente en esta conversación. */
  lastSent: qstore.Quote | null;
  /** Calculadora activa del agente: la IA junta sus datos y el sistema calcula. `null` = lista simple. */
  calculator: { id: string; version: number; name: string; definition: CalculatorDefinition } | null;
  /** Qué sale al cliente: el desglose en el chat y/o el PDF. */
  sendSummary: boolean;
  sendPdf: boolean;
}

/** Lo que la IA propuso y el validador aceptó: conceptos de la lista, o los datos para la calculadora. */
export interface PlannedQuote {
  lines: { itemId: string; code: string; qty: number }[];
  /** Con calculadora: los datos que dio el cliente (clave → valor). */
  calculate?: { inputs: Record<string, string> };
  notes: string;
  final: boolean;
}

export type PreparedQuote =
  /** `file` falta si el agente no manda PDF. `summary` = mandar el desglose en el chat. */
  | { status: 'ready'; quote: qstore.Quote; file?: OutgoingFile; summary: boolean; legend: string }
  | { status: 'pending'; quote: qstore.Quote; text: string }
  | { status: 'failed'; text: string }
  /** La calculadora dice que esto lo ve un asesor (regla del negocio o precio que falta): se transfiere con este mensaje. */
  | { status: 'handoff'; text: string; reason: string };

interface Hooks {
  alertTeam?(accountId: string, o: { title: string; body: string; link?: string; kind?: string; conversationId?: string }): Promise<void>;
}

const customerLabel = (c: Contact) => c.name || c.push_name || c.phone || 'Un cliente';

/** Lo que llevan los eventos de cotización (reglas automáticas y webhooks). */
export function quoteEvent(q: qstore.Quote) {
  return { id: q.id, folio: q.folio, kind: q.kind, total: formatTotals({ ...q, lines: q.lines ?? [], can_be_final: false }, q.currency).total, valid_until: q.valid_until || undefined };
}

export class Quotes {
  constructor(private hooks: Hooks = {}) {}

  /** `null` si el asistente no cotiza (apagado o sin conceptos activos). */
  async contextFor(conv: Conversation, bot: Chatbot): Promise<QuoteCatalog | null> {
    const cfg = bot.ai.quotes;
    if (!cfg?.enabled) return null;
    const items = await qstore.listPriceItems(conv.account_id, { activeOnly: true });
    if (!items.length) return null;
    const calculator = await this.calculatorFor(conv, cfg.calculator_id);
    const request = await queryOne<{ id: string }>('SELECT id FROM conversation_requests WHERE conversation_id = $1 ORDER BY number DESC LIMIT 1', [conv.id]);
    const requestId = request ? Number(request.id) : null;
    const [settings, open, lastSent] = await Promise.all([
      qstore.getQuoteSettings(conv.account_id),
      requestId ? qstore.openQuoteForRequest(conv.account_id, requestId) : qstore.openQuoteForConversation(conv.account_id, conv.id),
      qstore.lastSentQuote(conv.account_id, conv.id),
    ]);
    return {
      settings, items, open, lastSent, requestId,
      requiredFields: bot.data_fields.filter((f) => cfg.required_fields.includes(f.key)),
      allowFinal: cfg.allow_final,
      templateId: cfg.template_id || null,
      calculator,
      // Sin calculadora la lista simple sigue como siempre: mensaje con el total y PDF.
      sendSummary: calculator ? cfg.send_summary !== false : false,
      sendPdf: calculator ? cfg.send_pdf !== false || cfg.send_summary === false : true,
    };
  }

  /**
   * La calculadora del agente, si existe, está activa, es de la cuenta y su definición sirve. Si no, el agente cotiza con
   * la lista simple y queda un aviso en el registro (el negocio la corrige en el panel).
   */
  private async calculatorFor(conv: Conversation, id: string | undefined): Promise<QuoteCatalog['calculator']> {
    if (!id) return null;
    const c = await calcstore.getCalculator(conv.account_id, id).catch(() => null);
    if (!c || !c.active) {
      await this.log(conv, 'warn', `La calculadora de cotización del agente ${c ? 'está apagada' : 'ya no existe'}: se cotiza con la lista de precios simple`);
      return null;
    }
    try {
      return { id: c.id, version: c.version, name: c.name, definition: prepareCalculator(c.definition).def };
    } catch (e: any) {
      await this.log(conv, 'warn', `La calculadora «${c.name}» tiene un error (${e?.message ?? e}): se cotiza con la lista de precios simple`);
      return null;
    }
  }

  /**
   * Crea la cotización (con los precios vigentes de la lista) y, si es aproximada, genera su PDF. Una operación repetida
   * (reinicio a media respuesta) reutiliza la cotización que ya había creado.
   */
  async prepare(o: { bot: Chatbot; conv: Conversation; contact: Contact; planned: PlannedQuote; catalog: QuoteCatalog; operation?: string }): Promise<PreparedQuote> {
    const { bot, conv, contact, planned, catalog } = o;
    const formality = bot.personality.formality;
    const calc = planned.calculate && catalog.calculator ? catalog.calculator : null;
    const legend = calc?.definition.legend ?? '';
    let quote = o.operation ? await qstore.quoteByOperation(conv.account_id, o.operation) : null;
    if (!quote) {
      let lines: qstore.NewQuote['lines'];
      let final: boolean;
      let notes = planned.notes;
      if (calc) {
        // La calculadora hace las cuentas con los precios vigentes; la IA solo dio los datos.
        const r = evaluateCalculator(calc.definition, planned.calculate!.inputs, catalog.items, { iva_rate: catalog.settings.iva_rate });
        if (!r.ok) return this.calculatorStopped(conv, contact, calc, r);
        lines = r.lines;
        final = r.kind === 'final' && catalog.allowFinal && r.priced.can_be_final;
        notes = [legend, planned.notes].filter(Boolean).join('\n');
      } else {
        const byId = new Map(catalog.items.map((i) => [i.id, i]));
        lines = planned.lines.flatMap((l) => {
          const item = byId.get(l.itemId);
          return item ? [{ price_item_id: item.id, code: item.code, name: item.name, description: item.description, unit: item.unit, qty: l.qty,
            price_mode: item.price_mode, price_min: item.price_min, price_max: item.price_max, iva_mode: item.iva_mode }] : [];
        });
        final = planned.final && lines.every((l) => l.price_mode === 'exact');
      }
      const settings = await astore.getSettings(conv.account_id);
      const card = await pstore.openCardOf(conv.id).catch(() => null);
      const emailField = bot.data_fields.find((f) => f.type === 'email')?.key;
      const data = contact.data ?? {};
      const customer: Record<string, string> = { ...data };
      customer.nombre = contact.name || data.nombre || contact.push_name || '';
      customer.telefono = data.telefono || contact.phone || '';
      customer.correo = data.correo || (emailField ? data[emailField] : '') || '';
      try {
        quote = await qstore.createQuote({
          accountId: conv.account_id, kind: final ? 'final' : 'approximate', status: final ? 'pending_approval' : 'draft', source: 'bot',
          lines, chatbotId: bot.id, conversationId: conv.id, contactId: contact.id, requestId: catalog.requestId,
          pipelineCardId: card ? Number(card.id) : null, templateId: catalog.templateId, notes, customer,
          today: localDate(new Date(), settings.timezone), operation: o.operation,
          calculator: calc ? { id: calc.id, version: calc.version, inputs: planned.calculate!.inputs } : null,
        });
      } catch (e: any) {
        // Otra cotización quedó abierta en esta solicitud al mismo tiempo: no se duplica.
        const open = e?.code === '23505' ? await qstore.openQuoteForConversation(conv.account_id, conv.id) : null;
        if (open) return { status: 'pending', quote: open, text: pendingMessage(formality) };
        throw e;
      }
      await this.log(conv, 'info', `Cotización ${quote.folio} (${quote.kind === 'final' ? 'final, por aprobar' : 'aproximada'}) preparada por el asistente`);
      if (quote.kind === 'final') {
        await this.hooks.alertTeam?.(conv.account_id, {
          title: '🧾 Cotización final por aprobar',
          body: conversationAlert({ contact, reason: 'pidió una cotización final', extra: `Folio ${quote.folio} por ${formatTotals({ ...quote, lines: quote.lines ?? [], can_be_final: true }, quote.currency).total}. Revísala y apruébala desde la conversación.` }),
          link: `#/conversation/${conv.id}`, kind: 'quote', conversationId: conv.id,
        }).catch(() => undefined);
      }
    }
    if (quote.kind === 'final' && ['pending_approval', 'draft'].includes(quote.status)) return { status: 'pending', quote, text: pendingMessage(formality) };
    const summary = catalog.sendSummary && !!calc;
    // Solo desglose en el chat: no hace falta generar el archivo.
    if (summary && !catalog.sendPdf) return { status: 'ready', quote: (await qstore.getQuote(conv.account_id, quote.id))!, summary, legend };
    try {
      const rendered = quote.pdf_path ? { fileName: `Cotizacion-${quote.folio}.pdf`, pdfPath: quote.pdf_path } : await renderQuote(conv.account_id, quote.id);
      return {
        status: 'ready',
        quote: (await qstore.getQuote(conv.account_id, quote.id))!,
        // Con su dirección firmada, Messenger e Instagram también lo reciben como archivo.
        file: { id: quote.id, name: rendered.fileName, mime: 'application/pdf', kind: 'document', absPath: attachmentAbsolutePath(rendered.pdfPath), url: signedQuoteUrl(quote.id) },
        summary,
        legend,
      };
    } catch (e: any) {
      await qstore.transitionQuote(conv.account_id, quote.id, 'failed', { detail: { error: String(e?.message ?? e).slice(0, 300) } });
      await this.log(conv, 'error', `No se pudo generar el PDF de la cotización ${quote.folio}: ${e?.message ?? e}`);
      await this.hooks.alertTeam?.(conv.account_id, {
        title: '⚠️ Cotización sin enviar',
        body: `No se pudo generar el PDF de la cotización ${quote.folio} de ${customerLabel(contact)}. Revísala en Cotizaciones y envíala desde la conversación.`,
        link: `#/conversation/${conv.id}`, kind: 'alert', conversationId: conv.id,
      }).catch(() => undefined);
      return { status: 'failed', text: failedMessage(formality) };
    }
  }

  /**
   * La calculadora no cotizó sola. Una regla del negocio (`stop`) o un precio que falta (`price`) pasan con un asesor; en
   * el segundo caso el equipo recibe qué falta en la lista para completarla. Datos que faltan o no sirven no deberían
   * llegar aquí (el validador ya los pidió): si llegan, se le pregunta al cliente.
   */
  private async calculatorStopped(conv: Conversation, contact: Contact, calc: NonNullable<QuoteCatalog['calculator']>, r: Exclude<CalculatorResult, { ok: true }>): Promise<PreparedQuote> {
    if (r.reason === 'missing' || r.reason === 'invalid') return { status: 'failed', text: r.reason === 'missing' ? `Para cotizarte necesito: ${r.missing.map((m) => m.label).join(', ')}.` : `Revisemos un dato: ${r.message}.` };
    if (r.reason === 'stop') {
      await this.log(conv, 'info', `La calculadora «${calc.name}» pasó la cotización con un asesor: ${r.message}`);
      return { status: 'handoff', text: r.message, reason: `Cotización: ${r.message}` };
    }
    await this.log(conv, 'warn', `La calculadora «${calc.name}» no pudo cotizar: ${r.detail}`);
    await this.hooks.alertTeam?.(conv.account_id, {
      title: '🧾 Cotización sin precio',
      body: conversationAlert({ contact, reason: 'pidió una cotización que la calculadora no pudo hacer', extra: `${r.detail}. Completa la lista de precios (o la calculadora «${calc.name}») y atiende al cliente.` }),
      link: `#/conversation/${conv.id}`, kind: 'quote', conversationId: conv.id,
    }).catch(() => undefined);
    return { status: 'handoff', text: r.message || ADVISOR_MESSAGE, reason: `Cotización: ${r.detail}` };
  }

  /**
   * El cliente dijo en el chat que acepta la cotización que recibió: queda anotado (una vez) y el equipo recibe el aviso
   * para marcarla aceptada con su plan de cobro desde la conversación. `true` solo si el aviso salió (si no, el motor
   * deja pasar su aviso general de «seguimiento prometido»).
   */
  async customerAccepted(conv: Conversation, contact: Contact, a: { quoteId: string; folio: string; words: string }): Promise<boolean> {
    const q = await qstore.markCustomerAccepted(conv.account_id, a.quoteId, a.words);
    if (!q) return false;
    const total = formatTotals({ ...q, lines: q.lines ?? [], can_be_final: false }, q.currency).total;
    await this.log(conv, 'info', `El cliente dijo que acepta la cotización ${q.folio}: «${a.words.slice(0, 120)}»`);
    if (!this.hooks.alertTeam) return false;
    return this.hooks.alertTeam(conv.account_id, {
      title: `✅ ${customerLabel(contact)} acepta la cotización ${q.folio}`,
      body: conversationAlert({ contact, reason: 'dijo que acepta la cotización', extra: `Folio ${q.folio} por ${total}. Escribió: «${a.words.slice(0, 200)}». Confírmala con «El cliente aceptó» en la conversación para crear su cobro.` }),
      link: `#/conversation/${conv.id}`, kind: 'quote', conversationId: conv.id,
    }).then(() => true, () => false);
  }

  /** Enlace firmado al PDF (7 días), para los canales que no envían archivos. */
  link(quote: qstore.Quote) {
    return signedQuoteUrl(quote.id);
  }

  /**
   * El mensaje del sistema con la cotización: el desglose (con calculadora y `send_summary`) o el mensaje corto con el
   * total; en ambos casos con el enlace si el canal no envía archivos.
   */
  message(bot: Chatbot, quote: qstore.Quote, link?: string, o: { summary?: boolean; legend?: string } = {}) {
    if (o.summary) return summaryMessage(quote, bot.personality.formality, { legend: o.legend, link });
    return quoteMessage(quote, bot.personality.formality, link);
  }

  /** Llegó al cliente: queda enviada y, si la oportunidad aún no tiene valor, toma el total de la cotización. */
  async delivered(conv: Conversation, quote: qstore.Quote, opts: { userId?: string | null; via: 'file' | 'link' | 'chat' }): Promise<qstore.Quote | null> {
    const sent = await qstore.transitionQuote(conv.account_id, quote.id, 'sent', { userId: opts.userId ?? null, detail: { via: opts.via } });
    if (!sent) return null;
    const card = await pstore.openCardOf(conv.id).catch(() => null);
    if (card && Number(card.value) === 0 && sent.total_min > 0) await pstore.setCardValue(String(card.id), sent.total_min / 100).catch(() => undefined);
    return sent;
  }

  private log(conv: Conversation, level: 'info' | 'warn' | 'error', message: string) {
    return logEvent({ level, source: 'engine', message, accountId: conv.account_id, chatbotId: conv.chatbot_id, channelId: conv.channel_id, conversationId: conv.id }).catch(() => undefined);
  }
}

type Emit = (e: AutomationEvent) => void;

/** Cotizaciones vencidas, con la fecha de hoy de cada negocio (tarea diaria). Las reglas «cotización vencida» se enteran. */
export async function expireDueQuotes(emit?: Emit): Promise<number> {
  const accounts = await query<{ account_id: string; timezone: string | null }>(
    `SELECT DISTINCT q.account_id, a.settings->>'timezone' AS timezone FROM quotes q JOIN accounts a ON a.id = q.account_id
      WHERE q.status IN ('pending_approval', 'approved', 'sent') AND q.valid_until < current_date + 1`,
  );
  let n = 0;
  const onExpired = emit ? (q: qstore.Quote) => emit({ type: 'quote_expired', conversationId: q.conversation_id!, quote: quoteEvent(q) }) : undefined;
  for (const a of accounts) n += await qstore.expireQuotes(localDate(new Date(), a.timezone || 'America/Mexico_City'), a.account_id, onExpired);
  return n;
}

/**
 * Seguimiento (tarea de cada pocas horas): las cuentas con reglas «cotización por vencer» activas reciben un evento por
 * cada cotización enviada a la que le quedan esos días, una sola vez por cotización y número de días.
 */
export async function remindExpiringQuotes(emit: Emit): Promise<number> {
  const accounts = await query<{ account_id: string; timezone: string | null; days: number[] }>(
    `SELECT r.account_id, a.settings->>'timezone' AS timezone, array_agg(DISTINCT COALESCE((r.trigger->>'days')::int, 2)) AS days
       FROM automations r JOIN accounts a ON a.id = r.account_id
      WHERE r.active AND r.trigger->>'type' = 'quote_expiring'
      GROUP BY r.account_id, a.settings->>'timezone'`,
  );
  let n = 0;
  for (const a of accounts) {
    const due = await qstore.claimExpiringQuotes(a.account_id, localDate(new Date(), a.timezone || 'America/Mexico_City'), a.days);
    for (const q of due) emit({ type: 'quote_expiring', conversationId: q.conversation_id!, quote: quoteEvent(q), daysLeft: q.days_left });
    n += due.length;
  }
  return n;
}
