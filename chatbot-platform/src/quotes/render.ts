/**
 * Genera el archivo de una cotización: llena el formato del negocio con los datos que dio el cliente y los montos que
 * calculó el sistema, lo convierte a PDF y guarda ambos archivos dentro de la carpeta de la cuenta.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { attachmentAbsolutePath } from '../attachments.js';
import * as astore from '../automation/store.js';
import * as store from '../store/index.js';
import * as qstore from '../store/quotes.js';
import { formatDate, formatLineAmount, formatQty, formatTotals, formatUnitPrice } from './format.js';
import { docxToPdf } from './pdf.js';
import type { PricedQuote } from './pricing.js';
import { exampleTemplate, fillTemplate, type TemplateData } from './template.js';

export const KIND_TITLE = { approximate: 'COTIZACIÓN APROXIMADA', final: 'COTIZACIÓN FINAL' } as const;
const MAX_VALUE = 2000;

const clip = (v: unknown) => String(v ?? '').slice(0, MAX_VALUE);

/** Fecha (YYYY-MM-DD) de un instante en la zona del negocio. */
export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Los datos del formato, todos en texto: lo que ve el cliente en el archivo. */
export function templateData(q: qstore.Quote, s: qstore.QuoteSettings, opts: { accountName: string; timeZone: string }): TemplateData {
  const lines = q.lines ?? [];
  const priced: PricedQuote = { ...q, lines, can_be_final: false };
  const totals = formatTotals(priced, q.currency);
  const customer = Object.fromEntries(Object.entries(q.customer_snapshot ?? {}).map(([k, v]) => [k, clip(v)]));
  const business = {
    nombre: clip(s.business_name || opts.accountName), telefono: clip(s.business_phone),
    correo: clip(s.business_email), direccion: clip(s.business_address),
  };
  return {
    folio: q.folio,
    fecha: formatDate(localDate(new Date(q.created_at), opts.timeZone)),
    vigencia: formatDate(q.valid_until),
    moneda: q.currency,
    notas: clip(q.notes),
    tipo: KIND_TITLE[q.kind],
    leyenda: clip(q.kind === 'final' ? s.legend_final : s.legend_approx),
    subtotal: totals.subtotal,
    iva: totals.iva,
    total: totals.total,
    tasa_iva: `${Math.round(q.iva_rate * 10000) / 100} %`,
    nombre: customer.nombre ?? '',
    telefono: customer.telefono ?? '',
    correo: customer.correo ?? '',
    es_aproximada: q.kind === 'approximate',
    es_final: q.kind === 'final',
    cliente: customer,
    negocio: business,
    conceptos: lines.map((l) => ({
      concepto: clip(l.name), clave: clip(l.code), descripcion: clip(l.description), cantidad: formatQty(l.qty), unidad: clip(l.unit),
      precio_unitario: formatUnitPrice(l, q.currency), importe: formatLineAmount(l, q.currency),
    })),
  };
}

/** Formato con que se cotiza; si la cuenta no subió ninguno, el del sistema. */
export async function templateBuffer(accountId: string, templateId: string | null): Promise<{ buffer: Buffer; template: qstore.QuoteTemplate | null }> {
  const template = await qstore.resolveTemplate(accountId, templateId);
  if (!template) return { buffer: exampleTemplate(), template: null };
  return { buffer: await fs.readFile(attachmentAbsolutePath(template.file_path)), template };
}

/** Llena y convierte un formato con datos dados (sin guardar nada). Lo usa la vista previa. */
export async function renderPdf(buffer: Buffer, data: TemplateData): Promise<{ docx: Buffer; pdf: Buffer }> {
  const docx = fillTemplate(buffer, data);
  return { docx, pdf: await docxToPdf(docx) };
}

export interface RenderedQuote {
  pdf: Buffer;
  fileName: string;
  pdfPath: string;
}

/** Genera (o regenera tras una edición) el Word y el PDF de una cotización y los guarda. */
export async function renderQuote(accountId: string, quoteId: string): Promise<RenderedQuote> {
  const q = await qstore.getQuote(accountId, quoteId);
  if (!q) throw new Error('Cotización no encontrada');
  const [s, account, settings] = await Promise.all([qstore.getQuoteSettings(accountId), store.getAccount(accountId), astore.getSettings(accountId)]);
  const { buffer } = await templateBuffer(accountId, q.template_id);
  const { docx, pdf } = await renderPdf(buffer, templateData(q, s, { accountName: account?.name ?? '', timeZone: settings.timezone }));
  const stamp = `${q.id}-${Date.now()}`;
  const docxPath = path.posix.join(accountId, 'quotes', `${stamp}.docx`);
  const pdfPath = path.posix.join(accountId, 'quotes', `${stamp}.pdf`);
  await fs.mkdir(path.dirname(attachmentAbsolutePath(pdfPath)), { recursive: true });
  await fs.writeFile(attachmentAbsolutePath(docxPath), docx);
  await fs.writeFile(attachmentAbsolutePath(pdfPath), pdf);
  await qstore.setQuoteFiles(accountId, q.id, { docx_path: docxPath, pdf_path: pdfPath, pdf_sha256: crypto.createHash('sha256').update(pdf).digest('hex') });
  return { pdf, fileName: `Cotizacion-${q.folio}.pdf`, pdfPath };
}

/** Datos de ejemplo para la vista previa de un formato recién subido. */
export function sampleData(s: qstore.QuoteSettings, accountName: string): TemplateData {
  const q = {
    folio: `${s.folio_prefix}0000`, kind: 'approximate', currency: s.currency, iva_rate: s.iva_rate, notes: 'Notas de ejemplo para el cliente.',
    created_at: new Date(), valid_until: localDate(new Date(Date.now() + s.validity_days * 86_400_000), 'UTC'),
    customer_snapshot: { nombre: 'Ana López', telefono: '55 1234 5678', correo: 'ana@ejemplo.mx' },
    subtotal_min: 250000, subtotal_max: 300000, iva_min: 40000, iva_max: 48000, total_min: 290000, total_max: 348000, open_ended: false, has_tbd: true,
    lines: [
      { name: 'Renta de salón', code: 'SALON', description: '5 horas', unit: 'evento', qty: 1, price_mode: 'exact', price_min: 150000, price_max: null, iva_mode: 'plus', amount_min: 150000, amount_max: 150000 },
      { name: 'Decoración', code: 'DECO', description: '', unit: 'servicio', qty: 1, price_mode: 'range', price_min: 100000, price_max: 150000, iva_mode: 'plus', amount_min: 100000, amount_max: 150000 },
      { name: 'Pastel', code: 'PASTEL', description: '', unit: 'pieza', qty: 1, price_mode: 'tbd', price_min: null, price_max: null, iva_mode: 'plus', amount_min: null, amount_max: null },
    ],
  } as unknown as qstore.Quote;
  return templateData(q, s, { accountName, timeZone: 'UTC' });
}
