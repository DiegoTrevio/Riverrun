/**
 * Cotizaciones del asistente: qué puede cotizar (contexto para la IA), preparar la cotización que la IA propuso (ya
 * validada) y registrar que llegó al cliente. Las aproximadas salen solas; las finales quedan para que el equipo las
 * apruebe.
 */
import { conversationAlert } from '../automation/alert-format.js';
import { attachmentAbsolutePath } from '../attachments.js';
import { signedQuoteUrl } from '../channels/media.js';
import * as astore from '../automation/store.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import * as pstore from '../store/pipelines.js';
import * as qstore from '../store/quotes.js';
import type { Chatbot, Contact, Conversation, DataField } from '../types.js';
import type { OutgoingFile } from '../engine/transport.js';
import { formatTotals } from './format.js';
import { failedMessage, pendingMessage, quoteMessage } from './messages.js';
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
}

/** Lo que la IA propuso y el validador aceptó. */
export interface PlannedQuote {
  lines: { itemId: string; code: string; qty: number }[];
  notes: string;
  final: boolean;
}

export type PreparedQuote =
  | { status: 'ready'; quote: qstore.Quote; file: OutgoingFile }
  | { status: 'pending'; quote: qstore.Quote; text: string }
  | { status: 'failed'; text: string };

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
    };
  }

  /**
   * Crea la cotización (con los precios vigentes de la lista) y, si es aproximada, genera su PDF. Una operación repetida
   * (reinicio a media respuesta) reutiliza la cotización que ya había creado.
   */
  async prepare(o: { bot: Chatbot; conv: Conversation; contact: Contact; planned: PlannedQuote; catalog: QuoteCatalog; operation?: string }): Promise<PreparedQuote> {
    const { bot, conv, contact, planned, catalog } = o;
    const formality = bot.personality.formality;
    let quote = o.operation ? await qstore.quoteByOperation(conv.account_id, o.operation) : null;
    if (!quote) {
      const byId = new Map(catalog.items.map((i) => [i.id, i]));
      const lines = planned.lines.flatMap((l) => {
        const item = byId.get(l.itemId);
        return item ? [{ price_item_id: item.id, code: item.code, name: item.name, description: item.description, unit: item.unit, qty: l.qty,
          price_mode: item.price_mode, price_min: item.price_min, price_max: item.price_max, iva_mode: item.iva_mode }] : [];
      });
      const final = planned.final && lines.every((l) => l.price_mode === 'exact');
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
          pipelineCardId: card ? Number(card.id) : null, templateId: catalog.templateId, notes: planned.notes, customer,
          today: localDate(new Date(), settings.timezone), operation: o.operation,
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
    try {
      const rendered = quote.pdf_path ? { fileName: `Cotizacion-${quote.folio}.pdf`, pdfPath: quote.pdf_path } : await renderQuote(conv.account_id, quote.id);
      return {
        status: 'ready',
        quote: (await qstore.getQuote(conv.account_id, quote.id))!,
        // Con su dirección firmada, Messenger e Instagram también lo reciben como archivo.
        file: { id: quote.id, name: rendered.fileName, mime: 'application/pdf', kind: 'document', absPath: attachmentAbsolutePath(rendered.pdfPath), url: signedQuoteUrl(quote.id) },
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

  /** Enlace firmado al PDF (7 días), para los canales que no envían archivos. */
  link(quote: qstore.Quote) {
    return signedQuoteUrl(quote.id);
  }

  /** El mensaje con el total (y el enlace si el canal no envía archivos). */
  message(bot: Chatbot, quote: qstore.Quote, link?: string) {
    return quoteMessage(quote, bot.personality.formality, link);
  }

  /** Llegó al cliente: queda enviada y, si la oportunidad aún no tiene valor, toma el total de la cotización. */
  async delivered(conv: Conversation, quote: qstore.Quote, opts: { userId?: string | null; via: 'file' | 'link' }): Promise<qstore.Quote | null> {
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

/** Cotizaciones vencidas, con la fecha de hoy de cada negocio (tarea diaria). */
export async function expireDueQuotes(): Promise<number> {
  const accounts = await query<{ account_id: string; timezone: string | null }>(
    `SELECT DISTINCT q.account_id, a.settings->>'timezone' AS timezone FROM quotes q JOIN accounts a ON a.id = q.account_id
      WHERE q.status IN ('pending_approval', 'approved', 'sent') AND q.valid_until < current_date + 1`,
  );
  let n = 0;
  for (const a of accounts) n += await qstore.expireQuotes(localDate(new Date(), a.timezone || 'America/Mexico_City'), a.account_id);
  return n;
}
