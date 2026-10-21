import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertAccount, HttpError, notFound, requireRole, scopeAccount, targetAccount } from '../access.js';
import { attachmentAbsolutePath } from '../attachments.js';
import { safeFileName } from '../channels/media.js';
import { logEvent } from '../logs.js';
import { quoteEvent } from '../quotes/agent.js';
import { quoteMessage } from '../quotes/messages.js';
import { IVA_MODES, MAX_LINES, MAX_PRICE_CENTS, MAX_QTY, PRICE_MODES } from '../quotes/pricing.js';
import { renderPdf, renderQuote, sampleData } from '../quotes/render.js';
import type { ChatService } from '../service.js';
import { exampleTemplate, inspectTemplate, KNOWN_TAGS, LINE_TAGS, REQUIRED_TAGS, TEMPLATE_MAX_BYTES } from '../quotes/template.js';
import * as store from '../store/index.js';
import * as qstore from '../store/quotes.js';
import { parse } from './util.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Archivos siempre como descarga (o PDF en línea) y sin que el navegador adivine el tipo. */
function sendFile(reply: FastifyReply, body: Buffer | fs.ReadStream, name: string, type: string, inline = false) {
  return reply
    .header('content-type', type)
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeFileName(name))}`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .send(body);
}

/** Montos en centavos enteros (el panel convierte de pesos). */
const Cents = z.number().int().min(0).max(MAX_PRICE_CENTS).nullable();

const PriceItemBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).default(''),
  unit: z.string().trim().min(1).max(40).default('servicio'),
  price_mode: z.enum(PRICE_MODES as [string, ...string[]]),
  price_min: Cents.default(null),
  price_max: Cents.default(null),
  iva_mode: z.enum(IVA_MODES as [string, ...string[]]).default('plus'),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(100000).default(0),
});

const SettingsBody = z.object({
  currency: z.string().trim().toUpperCase().length(3).optional(),
  iva_rate: z.number().min(0).max(0.99).optional(),
  prices_include_iva: z.boolean().optional(),
  validity_days: z.number().int().min(1).max(365).optional(),
  legend_approx: z.string().max(500).optional(),
  legend_final: z.string().max(500).optional(),
  folio_prefix: z.string().trim().max(12).optional(),
  business_name: z.string().trim().max(300).optional(),
  business_phone: z.string().trim().max(300).optional(),
  business_email: z.string().trim().max(300).optional(),
  business_address: z.string().trim().max(300).optional(),
});

const LineBody = z.object({
  price_item_id: z.string().uuid().nullable().default(null),
  code: z.string().trim().max(40).default(''),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).default(''),
  unit: z.string().trim().min(1).max(40).default('servicio'),
  qty: z.number().positive().max(MAX_QTY),
  price_mode: z.enum(PRICE_MODES as [string, ...string[]]),
  price_min: Cents.default(null),
  price_max: Cents.default(null),
  iva_mode: z.enum(IVA_MODES as [string, ...string[]]).default('plus'),
});
const QuotePatch = z.object({
  lines: z.array(LineBody).min(1).max(MAX_LINES),
  notes: z.string().max(2000).optional(),
  kind: z.enum(['approximate', 'final']).optional(),
});
const RejectBody = z.object({
  reason: z.string().trim().max(500).default(''),
  /** Mensaje opcional al cliente. */
  message: z.string().trim().max(1000).default(''),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUOTE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'rejected', 'expired', 'failed'] as const;

/** Errores de validación de la lista de precios y los ajustes: se muestran tal cual al negocio. */
async function friendly<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e instanceof HttpError || e?.code) throw e;
    throw new HttpError(400, e?.message || 'Datos inválidos');
  }
}

/** Cotizaciones de la cuenta: ajustes, lista de precios y el historial de cotizaciones enviadas o por aprobar. */
export async function quoteRoutes(api: FastifyInstance, service: ChatService) {
  const admins = { preHandler: requireRole('admin') };
  const itemFor = async (user: any, id: string) => assertAccount(user, await qstore.findPriceItem(id), 'Concepto no encontrado');
  const quoteFor = async (user: any, id: string) => assertAccount(user, await qstore.findQuote(id), 'Cotización no encontrada');

  api.get('/api/quote-settings', admins, async (req: any) => qstore.getQuoteSettings(await targetAccount(req.user, req.query.account_id)));

  api.put('/api/quote-settings', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const body = parse(SettingsBody, req.body);
    return friendly(() => qstore.updateQuoteSettings(accountId, body));
  });

  // Quien atiende conversaciones también consulta precios.
  api.get('/api/price-items', async (req: any) => {
    const accountId = scopeAccount(req.user, req.query.account_id);
    if (!accountId) return [];
    return qstore.listPriceItems(accountId, { activeOnly: req.query.active === '1' });
  });

  api.post('/api/price-items', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const body = parse(PriceItemBody, req.body) as qstore.PriceItemInput;
    return friendly(() => qstore.createPriceItem(accountId, body));
  });

  api.put('/api/price-items/:id', admins, async (req: any) => {
    const item = await itemFor(req.user, req.params.id);
    const body = parse(PriceItemBody, { ...item, ...(req.body ?? {}) }) as qstore.PriceItemInput;
    const saved = await friendly(() => qstore.updatePriceItem(item.account_id, item.id, body));
    if (!saved) throw notFound('Concepto no encontrado');
    return saved;
  });

  api.delete('/api/price-items/:id', admins, async (req: any) => {
    const item = await itemFor(req.user, req.params.id);
    await qstore.deletePriceItem(item.account_id, item.id);
    return { ok: true };
  });

  api.get('/api/quotes', admins, async (req: any) => {
    const accountId = scopeAccount(req.user, req.query.account_id);
    if (!accountId) return [];
    const q = req.query;
    return qstore.listQuotes(accountId, {
      status: QUOTE_STATUSES.includes(q.status) ? q.status : undefined,
      kind: q.kind === 'approximate' || q.kind === 'final' ? q.kind : undefined,
      chatbotId: UUID.test(q.chatbot_id ?? '') ? q.chatbot_id : undefined,
      contactId: UUID.test(q.contact_id ?? '') ? q.contact_id : undefined,
      search: typeof q.search === 'string' ? q.search.slice(0, 100) : undefined,
      limit: Number(q.limit) || undefined,
    });
  });

  api.get('/api/quotes/:id', admins, async (req: any) => {
    const quote = await quoteFor(req.user, req.params.id);
    return { ...quote, events: await qstore.listQuoteEvents(quote.account_id, quote.id) };
  });

  /** El equipo corrige los conceptos, cantidades o precios antes de aprobar (se recalcula todo). */
  api.patch('/api/quotes/:id', admins, async (req: any) => {
    const quote = await quoteFor(req.user, req.params.id);
    const body = parse(QuotePatch, req.body);
    const saved = await friendly(() => qstore.replaceQuoteLines(quote.account_id, quote.id, body.lines as qstore.NewQuote['lines'], { notes: body.notes, kind: body.kind, userId: req.user.id }));
    if (!saved) throw new HttpError(409, 'Esta cotización ya no se puede editar (ya se envió, se rechazó o venció)');
    return saved;
  });

  /**
   * Aprobar y enviar (una final por aprobar, o reintentar una que no se pudo enviar). Solo una persona gana si dos
   * aprueban a la vez; si el envío falla, queda «Con error» para reintentar.
   */
  api.post('/api/quotes/:id/approve', admins, async (req: any) => {
    const quote = await quoteFor(req.user, req.params.id);
    if (!quote.conversation_id) throw new HttpError(400, 'Esta cotización no tiene conversación a la cual enviarla');
    if (!['pending_approval', 'failed', 'draft'].includes(quote.status)) throw new HttpError(409, 'Esta cotización ya se envió o ya no está pendiente');
    if (quote.kind === 'final' && !(quote.lines ?? []).every((l) => l.price_mode === 'exact')) throw new HttpError(400, 'Una cotización final necesita precio exacto en todos los conceptos');
    const locked = await qstore.transitionQuote(quote.account_id, quote.id, 'approved', { userId: req.user.id });
    if (!locked) throw new HttpError(409, 'Otra persona ya la está aprobando: actualiza la página');
    const fail = async (reason: string, status = 502): Promise<never> => {
      await qstore.transitionQuote(quote.account_id, quote.id, 'failed', { userId: req.user.id, detail: { error: reason.slice(0, 300) } });
      throw new HttpError(status, reason);
    };
    const conv = await store.getConversation(quote.conversation_id);
    const [channel, contact] = conv ? await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]) : [null, null];
    if (!conv || !channel || !contact) return fail('La conversación ya no existe', 409);
    const rendered = await renderQuote(quote.account_id, quote.id).catch((e) => fail(`No se pudo generar el PDF: ${e?.message ?? e}`));
    const fresh = (await qstore.getQuote(quote.account_id, quote.id))!;
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const canFile = !!service.transportFor(channel, contact).sendFile;
    const link = canFile ? undefined : service.quotes.link(fresh);
    const sent = await service.outbound.send(conv.id, {
      text: quoteMessage(fresh, bot?.personality.formality ?? 'tu', link),
      file: canFile ? { id: fresh.id, name: rendered.fileName, mime: 'application/pdf', kind: 'document', absPath: attachmentAbsolutePath(rendered.pdfPath) } : undefined,
      source: 'quote', transactional: true, allowWhenHuman: true, meta: { quote_message: true, quote_id: fresh.id, quote_kind: fresh.kind },
    });
    if (!sent.sent) return fail(`No se pudo enviar: ${sent.reason}`, 409);
    const done = await service.quotes.delivered(conv, fresh, { userId: req.user.id, via: canFile ? 'file' : 'link' });
    if (done) service.automator.emit({ type: 'quote_sent', conversationId: conv.id, quote: quoteEvent(done) });
    await logEvent({ level: 'info', source: 'admin', message: `Cotización ${fresh.folio} (${fresh.kind === 'final' ? 'final' : 'aproximada'}) aprobada y enviada`, accountId: quote.account_id, conversationId: conv.id });
    return done ?? fresh;
  });

  api.post('/api/quotes/:id/reject', admins, async (req: any) => {
    const quote = await quoteFor(req.user, req.params.id);
    const body = parse(RejectBody, req.body);
    const done = await qstore.transitionQuote(quote.account_id, quote.id, 'rejected', { userId: req.user.id, set: { rejected_reason: body.reason }, detail: { reason: body.reason } });
    if (!done) throw new HttpError(409, 'Esta cotización ya no está pendiente');
    let notified: { sent: boolean; reason?: string } | null = null;
    if (body.message && quote.conversation_id) {
      notified = await service.outbound.send(quote.conversation_id, { text: body.message, source: 'quote', transactional: true, allowWhenHuman: true, meta: { quote_message: true, quote_id: quote.id } });
    }
    if (quote.conversation_id) service.automator.emit({ type: 'quote_rejected', conversationId: quote.conversation_id, quote: quoteEvent(done) });
    return { ...done, notified };
  });

  /** El PDF (o el Word) generado de una cotización. */
  api.get('/api/quotes/:id/file', admins, async (req: any, reply) => {
    const quote = await quoteFor(req.user, req.params.id);
    const word = req.query.fmt === 'docx';
    const rel = word ? quote.docx_path : quote.pdf_path;
    if (!rel) throw new HttpError(404, 'Esta cotización todavía no tiene archivo');
    const abs = attachmentAbsolutePath(rel);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'El archivo ya no está guardado');
    return sendFile(reply, fs.createReadStream(abs), `Cotizacion-${quote.folio}.${word ? 'docx' : 'pdf'}`, word ? DOCX : 'application/pdf', !word);
  });

  /* ------------------------------ Formatos en Word ------------------------------ */

  const templateFor = async (user: any, id: string) => assertAccount(user, await qstore.findTemplate(id), 'Formato no encontrado');

  api.get('/api/quote-templates', admins, async (req: any) => {
    const accountId = scopeAccount(req.user, req.query.account_id);
    return accountId ? qstore.listTemplates(accountId) : [];
  });

  /** Marcas que se pueden usar en el formato (para mostrarlas en el panel). */
  api.get('/api/quote-templates/tags', admins, async () => ({ tags: KNOWN_TAGS, lineTags: LINE_TAGS, required: REQUIRED_TAGS }));

  /** Formato del sistema: para descargarlo y adaptarlo, o verlo en PDF con datos de ejemplo. */
  api.get('/api/quote-templates/example', admins, async (req: any, reply) => {
    if (req.query.fmt !== 'pdf') return sendFile(reply, exampleTemplate(), 'Formato de cotizacion.docx', DOCX);
    const accountId = await targetAccount(req.user, req.query.account_id);
    const account = await store.getAccount(accountId);
    const { pdf } = await renderPdf(exampleTemplate(), sampleData(await qstore.getQuoteSettings(accountId), account?.name ?? ''))
      .catch((e) => { throw new HttpError(502, `No se pudo generar el PDF: ${e.message}`); });
    return sendFile(reply, pdf, 'Vista previa.pdf', 'application/pdf', true);
  });

  api.post('/api/quote-templates', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    let upload: { buffer: Buffer; name: string } | undefined;
    let name = '';
    for await (const part of req.parts({ limits: { fileSize: TEMPLATE_MAX_BYTES, files: 1 } })) {
      if (part.type === 'field') { if (part.fieldname === 'name') name = String(part.value ?? ''); continue; }
      const buffer: Buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(400, 'El archivo supera 5 MB');
      upload = { buffer, name: part.filename || 'formato.docx' };
    }
    if (!upload) throw new HttpError(400, 'Elige el archivo de Word (.docx)');
    if (!/\.docx$/i.test(upload.name)) throw new HttpError(400, 'El formato debe ser un documento de Word (.docx). Si tiene macros (.docm), guárdalo como .docx');
    const report = inspectTemplate(upload.buffer);
    if (report.errors.length) throw new HttpError(400, 'El formato no se puede usar', report.errors);
    const id = crypto.randomUUID();
    const rel = path.posix.join(accountId, 'quote-templates', `${id}.docx`);
    const abs = attachmentAbsolutePath(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, upload.buffer, { flag: 'wx' });
    const clean = safeFileName(name.trim() || upload.name.replace(/\.docx$/i, '')).slice(0, 80);
    const template = await qstore.insertTemplate({
      id, accountId, name: clean, filePath: rel, size: upload.buffer.length, placeholders: report.found, createdBy: req.user.id,
      sha256: crypto.createHash('sha256').update(upload.buffer).digest('hex'),
    });
    await logEvent({ level: 'info', source: 'admin', message: `Formato de cotización subido: ${clean} (versión ${template.version})`, accountId });
    return { template, report };
  });

  api.get('/api/quote-templates/:id/file', admins, async (req: any, reply) => {
    const t = await templateFor(req.user, req.params.id);
    const abs = attachmentAbsolutePath(t.file_path);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'El archivo ya no está guardado');
    return sendFile(reply, fs.createReadStream(abs), `${t.name}.docx`, DOCX);
  });

  /** Vista previa en PDF del formato con datos de ejemplo. */
  api.get('/api/quote-templates/:id/preview', admins, async (req: any, reply) => {
    const t = await templateFor(req.user, req.params.id);
    const abs = attachmentAbsolutePath(t.file_path);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'El archivo ya no está guardado');
    const account = await store.getAccount(t.account_id);
    const { pdf } = await renderPdf(await fsp.readFile(abs), sampleData(await qstore.getQuoteSettings(t.account_id), account?.name ?? ''))
      .catch((e) => { throw new HttpError(502, `No se pudo generar el PDF: ${e.message}`); });
    return sendFile(reply, pdf, `${t.name} (vista previa).pdf`, 'application/pdf', true);
  });

  /** Se archiva (no se borra): las cotizaciones hechas con él lo siguen necesitando. */
  api.delete('/api/quote-templates/:id', admins, async (req: any) => {
    const t = await templateFor(req.user, req.params.id);
    await qstore.archiveTemplate(t.account_id, t.id);
    return { ok: true };
  });
}
