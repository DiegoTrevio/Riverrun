/**
 * Cotizaciones: ajustes de la cuenta, lista de precios y las cotizaciones con sus renglones e historial. Todo se consulta
 * con la cuenta, para que un negocio nunca vea ni toque lo de otro.
 */
import { query, queryOne, withTransaction } from '../db.js';
import { lineProblem, priceQuote, type IvaMode, type LineInput, type PriceMode, type PricedQuote } from '../quotes/pricing.js';

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const pooled: Queryable = { query: (t, p) => query(t, p).then((rows) => ({ rows })) };

export type QuoteKind = 'approximate' | 'final';
export type QuoteStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'rejected' | 'expired' | 'failed';
export type QuoteSource = 'bot' | 'panel';

export interface QuoteSettings {
  account_id: string;
  currency: string;
  iva_rate: number;
  /** Valor inicial del IVA de los conceptos nuevos: si el precio que se escribe ya incluye IVA. */
  prices_include_iva: boolean;
  validity_days: number;
  legend_approx: string;
  legend_final: string;
  folio_prefix: string;
  next_folio: number;
}

export interface PriceItem {
  id: string;
  account_id: string;
  code: string;
  name: string;
  description: string;
  unit: string;
  price_mode: PriceMode;
  price_min: number | null;
  price_max: number | null;
  iva_mode: IvaMode;
  active: boolean;
  sort: number;
}

export interface QuoteLine extends LineInput {
  id: number;
  position: number;
  price_item_id: string | null;
  amount_min: number | null;
  amount_max: number | null;
  edited_by_team: boolean;
}

export interface Quote {
  id: string;
  account_id: string;
  chatbot_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  request_id: number | null;
  pipeline_card_id: number | null;
  template_id: string | null;
  folio: string;
  kind: QuoteKind;
  status: QuoteStatus;
  source: QuoteSource;
  currency: string;
  iva_rate: number;
  subtotal_min: number;
  subtotal_max: number;
  iva_min: number;
  iva_max: number;
  total_min: number;
  total_max: number;
  open_ended: boolean;
  has_tbd: boolean;
  notes: string;
  valid_until: string;
  customer_snapshot: Record<string, string>;
  business_snapshot: Record<string, string>;
  docx_path: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  rejected_reason: string;
  created_at: Date;
  updated_at: Date;
  lines?: QuoteLine[];
}

/** Cotizaciones que todavía están en proceso: solo puede haber una por solicitud. */
export const OPEN_STATUSES: readonly QuoteStatus[] = ['draft', 'pending_approval', 'approved'];

/** Cambios de estado permitidos. */
const TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ['pending_approval', 'approved', 'sent', 'failed'],
  pending_approval: ['approved', 'sent', 'rejected', 'expired', 'failed'],
  approved: ['sent', 'failed', 'expired'],
  failed: ['draft', 'pending_approval', 'approved', 'sent', 'rejected'],
  sent: ['expired'],
  rejected: [],
  expired: [],
};

export const canTransition = (from: QuoteStatus, to: QuoteStatus) => TRANSITIONS[from].includes(to);

/* ------------------------------ Conversión de filas ------------------------------ */

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function settingsRow(r: any): QuoteSettings {
  return { ...r, iva_rate: Number(r.iva_rate) };
}

function itemRow(r: any): PriceItem {
  return { ...r, price_min: num(r.price_min), price_max: num(r.price_max) };
}

const MONEY_COLUMNS = ['subtotal_min', 'subtotal_max', 'iva_min', 'iva_max', 'total_min', 'total_max'] as const;

function quoteRow(r: any): Quote {
  const q = { ...r, iva_rate: Number(r.iva_rate), request_id: num(r.request_id), pipeline_card_id: num(r.pipeline_card_id) };
  for (const k of MONEY_COLUMNS) q[k] = Number(r[k]);
  if (r.valid_until instanceof Date) q.valid_until = r.valid_until.toISOString().slice(0, 10);
  return q;
}

function lineRow(r: any): QuoteLine {
  return {
    ...r,
    qty: Number(r.qty),
    price_min: num(r.price_min),
    price_max: num(r.price_max),
    amount_min: num(r.amount_min),
    amount_max: num(r.amount_max),
  };
}

/* ------------------------------ Ajustes ------------------------------ */

export async function getQuoteSettings(accountId: string, db: Queryable = pooled): Promise<QuoteSettings> {
  await db.query('INSERT INTO quote_settings (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING', [accountId]);
  return settingsRow((await db.query('SELECT * FROM quote_settings WHERE account_id = $1', [accountId])).rows[0]);
}

export type SettingsPatch = Partial<Omit<QuoteSettings, 'account_id' | 'next_folio'>>;

export function settingsProblem(p: SettingsPatch): string | null {
  if (p.currency !== undefined && !/^[A-Z]{3}$/.test(p.currency)) return 'La moneda debe ser un código de 3 letras (p. ej. MXN)';
  if (p.iva_rate !== undefined && !(Number.isFinite(p.iva_rate) && p.iva_rate >= 0 && p.iva_rate < 1)) return 'El IVA debe estar entre 0 % y 99 %';
  if (p.validity_days !== undefined && !(Number.isInteger(p.validity_days) && p.validity_days >= 1 && p.validity_days <= 365)) return 'La vigencia debe ser de 1 a 365 días';
  if (p.folio_prefix !== undefined && !/^[A-Za-z0-9_-]{0,12}$/.test(p.folio_prefix)) return 'El prefijo del folio admite hasta 12 letras, números o guiones';
  for (const k of ['legend_approx', 'legend_final'] as const) {
    if (p[k] !== undefined && (typeof p[k] !== 'string' || p[k]!.length > 500)) return 'Cada leyenda admite hasta 500 caracteres';
  }
  return null;
}

export async function updateQuoteSettings(accountId: string, patch: SettingsPatch): Promise<QuoteSettings> {
  const problem = settingsProblem(patch);
  if (problem) throw new Error(problem);
  await getQuoteSettings(accountId);
  const fields = (['currency', 'iva_rate', 'prices_include_iva', 'validity_days', 'legend_approx', 'legend_final', 'folio_prefix'] as const)
    .filter((k) => patch[k] !== undefined);
  if (fields.length) {
    await query(
      `UPDATE quote_settings SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE account_id = $1`,
      [accountId, ...fields.map((k) => patch[k])],
    );
  }
  return getQuoteSettings(accountId);
}

/* ------------------------------ Lista de precios ------------------------------ */

export async function listPriceItems(accountId: string, opts: { activeOnly?: boolean } = {}): Promise<PriceItem[]> {
  const rows = await query(
    `SELECT * FROM price_items WHERE account_id = $1 ${opts.activeOnly ? 'AND active' : ''} ORDER BY sort, name`,
    [accountId],
  );
  return rows.map(itemRow);
}

export async function getPriceItem(accountId: string, id: string): Promise<PriceItem | null> {
  const r = await queryOne('SELECT * FROM price_items WHERE account_id = $1 AND id = $2', [accountId, id]);
  return r ? itemRow(r) : null;
}

export type PriceItemInput = Omit<PriceItem, 'id' | 'account_id'>;

export function priceItemProblem(i: PriceItemInput): string | null {
  if (typeof i.code !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(i.code)) return 'La clave admite letras, números o guiones (hasta 40)';
  if (typeof i.name !== 'string' || !i.name.trim() || i.name.length > 200) return 'Escribe el nombre del concepto (hasta 200 caracteres)';
  if (typeof i.description !== 'string' || i.description.length > 1000) return 'La descripción admite hasta 1000 caracteres';
  if (typeof i.unit !== 'string' || !i.unit.trim() || i.unit.length > 40) return 'Escribe la unidad (p. ej. servicio, pieza, hora)';
  return lineProblem({ ...i, qty: 1 });
}

const ITEM_FIELDS = ['code', 'name', 'description', 'unit', 'price_mode', 'price_min', 'price_max', 'iva_mode', 'active', 'sort'] as const;
const itemValues = (i: PriceItemInput) => ITEM_FIELDS.map((k) => (k === 'name' || k === 'unit' ? String(i[k]).trim() : i[k]));

function friendlyUnique(e: any): never {
  if (e?.code === '23505') throw new Error('Ya hay un concepto con esa clave');
  throw e;
}

export async function createPriceItem(accountId: string, input: PriceItemInput): Promise<PriceItem> {
  const problem = priceItemProblem(input);
  if (problem) throw new Error(problem);
  const r = await queryOne(
    `INSERT INTO price_items (account_id, ${ITEM_FIELDS.join(', ')}) VALUES ($1, ${ITEM_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [accountId, ...itemValues(input)],
  ).catch(friendlyUnique);
  return itemRow(r);
}

export async function updatePriceItem(accountId: string, id: string, input: PriceItemInput): Promise<PriceItem | null> {
  const problem = priceItemProblem(input);
  if (problem) throw new Error(problem);
  const r = await queryOne(
    `UPDATE price_items SET ${ITEM_FIELDS.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
      WHERE account_id = $1 AND id = $2 RETURNING *`,
    [accountId, id, ...itemValues(input)],
  ).catch(friendlyUnique);
  return r ? itemRow(r) : null;
}

/** Borrar un concepto no altera las cotizaciones hechas: sus renglones guardan nombre y precio. */
export async function deletePriceItem(accountId: string, id: string): Promise<boolean> {
  return (await query('DELETE FROM price_items WHERE account_id = $1 AND id = $2 RETURNING id', [accountId, id])).length > 0;
}

/* ------------------------------ Cotizaciones ------------------------------ */

export interface NewQuote {
  accountId: string;
  kind: QuoteKind;
  status: QuoteStatus;
  source: QuoteSource;
  lines: (LineInput & { price_item_id?: string | null })[];
  chatbotId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  requestId?: number | null;
  pipelineCardId?: number | null;
  templateId?: string | null;
  notes?: string;
  customer?: Record<string, string>;
  business?: Record<string, string>;
  userId?: string | null;
  /** Fecha de hoy (`YYYY-MM-DD`) en la zona del negocio; de ella sale la vigencia. */
  today: string;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function insertLines(db: Queryable, quoteId: string, priced: PricedQuote, src: NewQuote['lines'], edited = false) {
  for (const [i, l] of priced.lines.entries()) {
    await db.query(
      `INSERT INTO quote_lines (quote_id, position, price_item_id, code, name, description, unit, qty, price_mode, price_min,
         price_max, iva_mode, amount_min, amount_max, edited_by_team)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [quoteId, i + 1, src[i].price_item_id ?? null, l.code ?? '', l.name, l.description ?? '', l.unit ?? 'servicio', l.qty,
        l.price_mode, l.price_min, l.price_max, l.iva_mode, l.amount_min, l.amount_max, edited],
    );
  }
}

const linesOf = async (db: Queryable, quoteId: string) =>
  (await db.query('SELECT * FROM quote_lines WHERE quote_id = $1 ORDER BY position', [quoteId])).rows.map(lineRow);

/**
 * Crea una cotización con su folio (reservado en la misma transacción, sin huecos por fallas), sus renglones y el primer
 * evento del historial. Una final necesita que todos los precios sean exactos.
 */
export async function createQuote(input: NewQuote): Promise<Quote> {
  return withTransaction(async (client) => {
    const settings = await getQuoteSettings(input.accountId, client);
    const priced = priceQuote(input.lines, settings);
    if (input.kind === 'final' && !priced.can_be_final) throw new Error('Una cotización final necesita precio exacto en todos los conceptos');
    const folioRow = (await client.query(
      'UPDATE quote_settings SET next_folio = next_folio + 1 WHERE account_id = $1 RETURNING folio_prefix, next_folio - 1 AS n',
      [input.accountId],
    )).rows[0];
    const folio = `${folioRow.folio_prefix}${String(folioRow.n).padStart(4, '0')}`;
    const q = (await client.query(
      `INSERT INTO quotes (account_id, chatbot_id, conversation_id, contact_id, request_id, pipeline_card_id, template_id, folio,
         kind, status, source, currency, iva_rate, subtotal_min, subtotal_max, iva_min, iva_max, total_min, total_max, open_ended,
         has_tbd, notes, valid_until, customer_snapshot, business_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING *`,
      [input.accountId, input.chatbotId ?? null, input.conversationId ?? null, input.contactId ?? null, input.requestId ?? null,
        input.pipelineCardId ?? null, input.templateId ?? null, folio, input.kind, input.status, input.source, settings.currency,
        settings.iva_rate, priced.subtotal_min, priced.subtotal_max, priced.iva_min, priced.iva_max, priced.total_min,
        priced.total_max, priced.open_ended, priced.has_tbd, (input.notes ?? '').slice(0, 2000),
        addDays(input.today, settings.validity_days), input.customer ?? {}, input.business ?? {}],
    )).rows[0];
    await insertLines(client, q.id, priced, input.lines);
    await addQuoteEvent(q.id, 'created', { kind: input.kind, status: input.status, source: input.source }, input.userId ?? null, client);
    return { ...quoteRow(q), lines: await linesOf(client, q.id) };
  });
}

export async function getQuote(accountId: string, id: string): Promise<Quote | null> {
  const r = await queryOne('SELECT * FROM quotes WHERE account_id = $1 AND id = $2', [accountId, id]);
  return r ? { ...quoteRow(r), lines: await linesOf(pooled, id) } : null;
}

export interface QuoteFilters {
  status?: QuoteStatus;
  kind?: QuoteKind;
  chatbotId?: string;
  conversationId?: string;
  contactId?: string;
  /** Folio o nombre del cliente. */
  search?: string;
  limit?: number;
}

export async function listQuotes(accountId: string, f: QuoteFilters = {}): Promise<Quote[]> {
  const where = ['account_id = $1'];
  const params: unknown[] = [accountId];
  const add = (column: string, v: unknown) => { params.push(v); where.push(`${column} = $${params.length}`); };
  if (f.status) add('status', f.status);
  if (f.kind) add('kind', f.kind);
  if (f.chatbotId) add('chatbot_id', f.chatbotId);
  if (f.conversationId) add('conversation_id', f.conversationId);
  if (f.contactId) add('contact_id', f.contactId);
  if (f.search?.trim()) {
    params.push(`%${f.search.trim().replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(folio ILIKE $${params.length} OR customer_snapshot->>'nombre' ILIKE $${params.length})`);
  }
  params.push(Math.min(Math.max(f.limit ?? 100, 1), 500));
  const rows = await query(`SELECT * FROM quotes WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows.map(quoteRow);
}

/** Cotización abierta de una solicitud (en preparación, por aprobar o aprobada sin enviar). */
export async function openQuoteForRequest(accountId: string, requestId: number): Promise<Quote | null> {
  const r = await queryOne(
    `SELECT * FROM quotes WHERE account_id = $1 AND request_id = $2 AND status = ANY($3) ORDER BY created_at DESC LIMIT 1`,
    [accountId, requestId, OPEN_STATUSES],
  );
  return r ? quoteRow(r) : null;
}

export async function addQuoteEvent(quoteId: string, type: string, detail: Record<string, unknown> = {}, userId: string | null = null, db: Queryable = pooled) {
  await db.query('INSERT INTO quote_events (quote_id, type, user_id, detail) VALUES ($1, $2, $3, $4)', [quoteId, type, userId, detail]);
}

export async function listQuoteEvents(accountId: string, quoteId: string) {
  return query(
    `SELECT e.id, e.type, e.detail, e.created_at, u.name AS user_name FROM quote_events e
       JOIN quotes q ON q.id = e.quote_id LEFT JOIN users u ON u.id = e.user_id
      WHERE q.account_id = $1 AND e.quote_id = $2 ORDER BY e.created_at, e.id`,
    [accountId, quoteId],
  );
}

/**
 * Cambia el estado solo si el actual lo permite (dos personas aprobando a la vez: gana una). Devuelve la cotización
 * actualizada o `null` si no se pudo.
 */
export async function transitionQuote(
  accountId: string, id: string, to: QuoteStatus,
  opts: { userId?: string | null; detail?: Record<string, unknown>; set?: Partial<Pick<Quote, 'rejected_reason' | 'docx_path' | 'pdf_path' | 'pdf_sha256'>> } = {},
): Promise<Quote | null> {
  return withTransaction(async (client) => {
    const cur = (await client.query('SELECT status FROM quotes WHERE account_id = $1 AND id = $2 FOR UPDATE', [accountId, id])).rows[0];
    if (!cur || !canTransition(cur.status, to)) return null;
    const extra: string[] = [];
    const params: unknown[] = [accountId, id, to];
    for (const [k, v] of Object.entries(opts.set ?? {})) { params.push(v); extra.push(`${k} = $${params.length}`); }
    if (to === 'approved' || (to === 'sent' && cur.status === 'pending_approval')) {
      params.push(opts.userId ?? null);
      extra.push(`approved_by = $${params.length}, approved_at = now()`);
    }
    if (to === 'sent') extra.push('sent_at = now()');
    const r = (await client.query(
      `UPDATE quotes SET status = $3, updated_at = now()${extra.length ? `, ${extra.join(', ')}` : ''} WHERE account_id = $1 AND id = $2 RETURNING *`,
      params,
    )).rows[0];
    await addQuoteEvent(id, to, { from: cur.status, ...opts.detail }, opts.userId ?? null, client);
    return quoteRow(r);
  });
}

/** El equipo corrige los renglones antes de aprobar: se recalculan los totales con el IVA con que se cotizó. */
export async function replaceQuoteLines(
  accountId: string, id: string, lines: NewQuote['lines'], opts: { notes?: string; userId?: string | null; kind?: QuoteKind } = {},
): Promise<Quote | null> {
  return withTransaction(async (client) => {
    const cur = (await client.query('SELECT * FROM quotes WHERE account_id = $1 AND id = $2 FOR UPDATE', [accountId, id])).rows[0];
    if (!cur || !['draft', 'pending_approval', 'failed'].includes(cur.status)) return null;
    const priced = priceQuote(lines, { iva_rate: Number(cur.iva_rate) });
    const kind = opts.kind ?? cur.kind;
    if (kind === 'final' && !priced.can_be_final) throw new Error('Una cotización final necesita precio exacto en todos los conceptos');
    await client.query('DELETE FROM quote_lines WHERE quote_id = $1', [id]);
    await insertLines(client, id, priced, lines, true);
    const r = (await client.query(
      `UPDATE quotes SET kind = $3, subtotal_min = $4, subtotal_max = $5, iva_min = $6, iva_max = $7, total_min = $8, total_max = $9,
         open_ended = $10, has_tbd = $11, notes = COALESCE($12, notes), docx_path = NULL, pdf_path = NULL, pdf_sha256 = NULL,
         updated_at = now()
       WHERE account_id = $1 AND id = $2 RETURNING *`,
      [accountId, id, kind, priced.subtotal_min, priced.subtotal_max, priced.iva_min, priced.iva_max, priced.total_min,
        priced.total_max, priced.open_ended, priced.has_tbd, opts.notes === undefined ? null : opts.notes.slice(0, 2000)],
    )).rows[0];
    await addQuoteEvent(id, 'edited', { lines: lines.length, kind }, opts.userId ?? null, client);
    return { ...quoteRow(r), lines: await linesOf(client, id) };
  });
}

/** Las cotizaciones enviadas o por aprobar cuya vigencia ya pasó se marcan vencidas. Devuelve cuántas. */
export async function expireQuotes(today: string): Promise<number> {
  const rows = await query(
    `UPDATE quotes SET status = 'expired', updated_at = now()
      WHERE valid_until < $1 AND status IN ('pending_approval', 'approved', 'sent') RETURNING id`,
    [today],
  );
  for (const r of rows) await addQuoteEvent(r.id, 'expired');
  return rows.length;
}
