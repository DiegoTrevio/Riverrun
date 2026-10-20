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
import { IVA_MODES, MAX_PRICE_CENTS, PRICE_MODES } from '../quotes/pricing.js';
import { renderPdf, sampleData } from '../quotes/render.js';
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
export async function quoteRoutes(api: FastifyInstance) {
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
