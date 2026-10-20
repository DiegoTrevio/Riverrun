import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, HttpError, notFound, requireRole, scopeAccount, targetAccount } from '../access.js';
import { IVA_MODES, MAX_PRICE_CENTS, PRICE_MODES } from '../quotes/pricing.js';
import * as qstore from '../store/quotes.js';
import { parse } from './util.js';

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
}
