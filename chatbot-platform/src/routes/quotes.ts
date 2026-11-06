import crypto from 'node:crypto';
import { assertUploadAllowed } from '../billing/limits.js';
import { sendsAnyFile } from '../engine/transport.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertAccount, HttpError, notFound, requireRole, scopeAccount, targetAccount } from '../access.js';
import { attachmentAbsolutePath } from '../attachments.js';
import { countHit } from '../identity/rate-limit.js';
import { safeFileName } from '../channels/media.js';
import { pool } from '../db.js';
import { logEvent } from '../logs.js';
import { AcceptBody, acceptedTotal, planCharges } from '../quotes/accept.js';
import { quoteEvent } from '../quotes/agent.js';
import { receivableBySource } from '../receivables/index.js';
import { receivableOut } from './receivables.js';
import { quoteMessage } from '../quotes/messages.js';
import { evaluateCalculator } from '../quotes/calculator.js';
import { formatTotals } from '../quotes/format.js';
import { parsePriceCsv, priceItemsCsv } from '../quotes/price-csv.js';
import { IVA_MODES, MAX_LINES, MAX_PRICE_CENTS, MAX_QTY, PRICE_MODES } from '../quotes/pricing.js';
import { renderPdf, renderQuote, sampleData } from '../quotes/render.js';
import type { ChatService } from '../service.js';
import { exampleTemplate, inspectTemplate, KNOWN_TAGS, LINE_TAGS, REQUIRED_TAGS, TEMPLATE_MAX_BYTES } from '../quotes/template.js';
import * as store from '../store/index.js';
import * as qstore from '../store/quotes.js';
import * as calcstore from '../store/quote-calculators.js';
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
  // Para la calculadora: familia y atributos con los que se encuentra este precio (vacíos si se usa solo).
  family: z.string().trim().max(60).default(''),
  attributes: z.record(z.string().max(40), z.union([z.string(), z.number()]).transform(String)).default({}),
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
const QUOTE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'failed'] as const;

/** Errores de validación de la lista de precios y los ajustes: se muestran tal cual al negocio. */
async function friendly<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e instanceof HttpError || e?.code) throw e;
    throw new HttpError(400, e?.message || 'Datos inválidos');
  }
}

/** Cotizaciones de la cuenta: ajustes, lista de precios y el historial de cotizaciones enviadas o por aprobar. */
const TEMPLATE_UPLOADS_PER_HOUR = 10;
const TEMPLATE_WINDOW_MS = 60 * 60_000;

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

  /**
   * Subir la lista de precios en CSV (de Excel): crea y actualiza por clave, todo o nada. Con `dry_run` solo revisa y dice
   * cuántos se crearían y cuántos se actualizarían, para confirmarlo antes.
   */
  api.post('/api/price-items/import', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const body = parse(z.object({ csv: z.string().min(1).max(2_000_000), dry_run: z.boolean().default(false) }), req.body);
    const settings = await qstore.getQuoteSettings(accountId);
    const { items, errors } = parsePriceCsv(body.csv, { iva_mode: settings.prices_include_iva ? 'included' : 'plus' });
    if (errors.length) return { ok: false, errors };
    const existing = new Set((await qstore.listPriceItems(accountId)).map((i) => i.code.toLowerCase()));
    const plan = { create: items.filter((i) => !existing.has(i.code.toLowerCase())).length, update: items.filter((i) => existing.has(i.code.toLowerCase())).length };
    if (body.dry_run) return { ok: true, dry_run: true, ...plan };
    const done = await friendly(() => qstore.importPriceItems(accountId, items));
    await logEvent({ level: 'info', source: 'admin', message: `${req.user.email} subió la lista de precios (${done.created} nuevos, ${done.updated} actualizados)`, accountId });
    return { ok: true, created: done.created, updated: done.updated };
  });

  api.get('/api/price-items/export.csv', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    return sendFile(reply, Buffer.from(priceItemsCsv(await qstore.listPriceItems(accountId))), 'lista-de-precios.csv', 'text/csv; charset=utf-8');
  });

  /* ------------------------------ Calculadoras de cotización ------------------------------ */

  const calculatorFor = async (user: any, id: string) => assertAccount(user, await calcstore.findCalculator(id), 'Calculadora no encontrada');
  const CalculatorBody = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(''),
    template_key: z.string().trim().max(60).default(''),
    definition: z.record(z.string(), z.unknown()),
    active: z.boolean().default(true),
  });
  const PreviewBody = z.object({ inputs: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).default({}) });

  /** Prueba una definición con datos de ejemplo, como lo haría el asistente: conceptos, total, o por qué no cotiza. */
  async function preview(accountId: string, definition: unknown, inputs: Record<string, unknown>) {
    const [settings, items] = await Promise.all([qstore.getQuoteSettings(accountId), qstore.listPriceItems(accountId)]);
    const r = evaluateCalculator(definition, inputs, items, { iva_rate: settings.iva_rate });
    if (!r.ok) return r;
    return { ...r, totals: formatTotals(r.priced, settings.currency), currency: settings.currency };
  }

  api.get('/api/quote-calculators', admins, async (req: any) => {
    const accountId = scopeAccount(req.user, req.query.account_id);
    return accountId ? calcstore.listCalculators(accountId) : [];
  });

  api.get('/api/quote-calculators/:id', admins, async (req: any) => calculatorFor(req.user, req.params.id));

  api.post('/api/quote-calculators', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const body = parse(CalculatorBody, req.body);
    const saved = await friendly(() => calcstore.createCalculator(accountId, body));
    await logEvent({ level: 'info', source: 'admin', message: `${req.user.email} creó la calculadora de cotización «${saved.name}»`, accountId });
    return saved;
  });

  api.put('/api/quote-calculators/:id', admins, async (req: any) => {
    const calc = await calculatorFor(req.user, req.params.id);
    const body = parse(CalculatorBody, { ...calc, ...(req.body ?? {}) });
    const saved = await friendly(() => calcstore.updateCalculator(calc.account_id, calc.id, body));
    if (!saved) throw notFound('Calculadora no encontrada');
    return saved;
  });

  api.delete('/api/quote-calculators/:id', admins, async (req: any) => {
    const calc = await calculatorFor(req.user, req.params.id);
    await calcstore.deleteCalculator(calc.account_id, calc.id);
    await logEvent({ level: 'info', source: 'admin', message: `${req.user.email} borró la calculadora de cotización «${calc.name}»`, accountId: calc.account_id });
    return { ok: true };
  });

  // Probar una calculadora guardada, o un borrador sin guardar (`definition` en el cuerpo).
  api.post('/api/quote-calculators/:id/preview', admins, async (req: any) => {
    const calc = await calculatorFor(req.user, req.params.id);
    return preview(calc.account_id, calc.definition, parse(PreviewBody, req.body).inputs);
  });
  api.post('/api/quote-calculators/preview', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const body = parse(PreviewBody.extend({ definition: z.record(z.string(), z.unknown()) }), req.body);
    return preview(accountId, body.definition, body.inputs);
  });

  /** Exportar e importar (JSON): para respaldar o llevar la calculadora a otra cuenta o instalación. */
  api.get('/api/quote-calculators/:id/export', admins, async (req: any, reply) => {
    const calc = await calculatorFor(req.user, req.params.id);
    return sendFile(reply, Buffer.from(JSON.stringify(calcstore.portable(calc), null, 2)), `calculadora-${calc.name}.json`, 'application/json');
  });
  api.post('/api/quote-calculators/import', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const body = parse(z.object({
      format: z.literal('riverrun.quote-calculator', { error: 'El archivo no es una calculadora de cotización exportada' }),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).default(''),
      template_key: z.string().trim().max(60).default(''),
      definition: z.record(z.string(), z.unknown()),
    }), req.body);
    const saved = await friendly(() => calcstore.createCalculator(accountId, { ...body, active: false }));
    await logEvent({ level: 'info', source: 'admin', message: `${req.user.email} importó la calculadora de cotización «${saved.name}»`, accountId });
    return saved;
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
    const canFile = sendsAnyFile(service.transportFor(channel, contact));
    const link = canFile ? undefined : service.quotes.link(fresh);
    const sent = await service.outbound.send(conv.id, {
      text: quoteMessage(fresh, bot?.personality.formality ?? 'tu', link),
      file: canFile ? { id: fresh.id, name: rendered.fileName, mime: 'application/pdf', kind: 'document', absPath: attachmentAbsolutePath(rendered.pdfPath), url: service.quotes.link(fresh) } : undefined,
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

  /**
   * El cliente aceptó la cotización (lo marca el equipo): ya no vence y, si se pide, se crean sus cobros con sus
   * recordatorios de pago: el total, un anticipo y el resto, o varias parcialidades.
   */
  api.post('/api/quotes/:id/accept', admins, async (req: any) => {
    // Una aceptación a la vez por cotización: dos al mismo tiempo con planes distintos dejaban los cobros de las dos. La
    // segunda no espera: responde 409 al momento (el candado vive en su propia conexión y se suelta al terminar).
    const lock = await pool.connect();
    try {
      const got = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [`quote-accept:${req.params.id}`])).rows[0].ok;
      if (!got) throw new HttpError(409, 'Esta cotización se está aceptando en otra sesión');
      try {
        return await acceptQuote(req);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`quote-accept:${req.params.id}`]).catch(() => undefined);
      }
    } finally {
      lock.release();
    }
  });

  const acceptQuote = async (req: any) => {
    const quote = await quoteFor(req.user, req.params.id);
    if (quote.status !== 'sent') throw new HttpError(409, quote.status === 'accepted' ? 'Esta cotización ya está aceptada' : 'Solo se puede aceptar una cotización enviada al cliente');
    const body = parse(AcceptBody, req.body ?? {});
    // Todo se valida antes de cambiar el estado: si el plan no cuadra, la cotización sigue enviada.
    let charges: ReturnType<typeof planCharges> = [];
    let total = 0;
    try {
      if (body.plan) {
        total = acceptedTotal(quote, body.amount_cents);
        charges = planCharges(quote.folio, total, body.plan);
      }
    } catch (e: any) { throw new HttpError(400, e?.message ?? 'Plan de pago inválido'); }
    // Primero los cobros (cada uno con su folio de origen: si algo falla a la mitad, repetir no duplica) y después el
    // estado: así una falla no deja la cotización aceptada sin sus cobros y sin forma de reintentar.
    const created = [];
    for (const [i, c] of charges.entries()) {
      const { receivable } = await service.receivables.create({
        accountId: quote.account_id, contactId: quote.contact_id, conversationId: quote.conversation_id, concept: c.concept, amountCents: c.amount_cents,
        currency: quote.currency, dueDate: c.due_date, reference: quote.folio, source: 'quote', sourceId: `${quote.id}:${i + 1}`, installment: c.installment,
        createdBy: req.user.id, actor: req.user.email,
      });
      created.push(receivableOut(receivable));
    }
    const done = await qstore.transitionQuote(quote.account_id, quote.id, 'accepted', { userId: req.user.id, detail: { amount_cents: total || undefined, plan: body.plan?.type ?? null, charges: charges.length } });
    if (!done) {
      // Otra persona la aceptó al mismo tiempo (sus cobros son estos mismos) o venció justo ahora: en ese caso no se cobran.
      if ((await qstore.findQuote(quote.id))?.status !== 'accepted') {
        for (const [i] of charges.entries()) {
          const r = await receivableBySource(quote.account_id, 'quote', `${quote.id}:${i + 1}`);
          if (r?.status === 'pending') await service.receivables.settle(r, 'canceled', { userId: req.user.id, note: 'La cotización ya no estaba enviada' });
        }
      }
      throw new HttpError(409, 'Esta cotización ya se aceptó o ya no está enviada');
    }
    if (quote.conversation_id) service.automator.emit({ type: 'quote_accepted', conversationId: quote.conversation_id, quote: quoteEvent(done) });
    await logEvent({ level: 'info', source: 'admin', message: `Cotización ${quote.folio} aceptada por el cliente (marcó ${req.user.email})${created.length ? `; ${created.length} cobro(s) creado(s)` : ''}`, accountId: quote.account_id, conversationId: quote.conversation_id });
    return { quote: done, receivables: created };
  };

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
    const { pdf } = await renderPdf(exampleTemplate(), sampleData(await qstore.getQuoteSettings(accountId), account?.name ?? ''), accountId)
      .catch((e) => { throw new HttpError(502, `No se pudo generar el PDF: ${e.message}`); });
    return sendFile(reply, pdf, 'Vista previa.pdf', 'application/pdf', true);
  });

  api.post('/api/quote-templates', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    // Revisar un formato descomprime y compila el archivo: con tope por cuenta, en la base (vale para todos los procesos).
    if ((await countHit(`quote-template:${accountId}`, TEMPLATE_WINDOW_MS)) > TEMPLATE_UPLOADS_PER_HOUR) {
      throw new HttpError(429, 'Subiste demasiados formatos en la última hora. Intenta más tarde.');
    }
    let upload: { buffer: Buffer; name: string } | undefined;
    let name = '';
    for await (const part of req.parts({ limits: { fileSize: TEMPLATE_MAX_BYTES, files: 1 } })) {
      if (part.type === 'field') { if (part.fieldname === 'name') name = String(part.value ?? ''); continue; }
      const buffer: Buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(400, 'El archivo supera 5 MB');
      upload = { buffer, name: part.filename || 'formato.docx' };
    }
    if (!upload) throw new HttpError(400, 'Elige el archivo de Word (.docx)');
    await assertUploadAllowed(accountId, upload.buffer.length); // en pausa, ritmo y almacenamiento (IN-19)
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
    const { pdf } = await renderPdf(await fsp.readFile(abs), sampleData(await qstore.getQuoteSettings(t.account_id), account?.name ?? ''), t.account_id)
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
