/**
 * Cómo se escriben los montos, cantidades y fechas de una cotización. Lo usan el archivo y el mensaje del chat, para que
 * el cliente lea exactamente lo mismo en ambos.
 */
import type { PricedLine, PricedQuote } from './pricing.js';

const money = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: number, currency = 'MXN'): string {
  let f = money.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat('es-MX', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      f = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    money.set(currency, f);
  }
  return f.format(cents / 100);
}

const qtyFormat = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 });
export const formatQty = (qty: number) => qtyFormat.format(qty);

/** Precio unitario tal como lo fijó el negocio: «$1,200.00», «desde $1,200.00», «$1,000.00 a $1,500.00», «Por confirmar». */
export function formatUnitPrice(l: Pick<PricedLine, 'price_mode' | 'price_min' | 'price_max'>, currency = 'MXN'): string {
  switch (l.price_mode) {
    case 'tbd': return 'Por confirmar';
    case 'exact': return formatMoney(l.price_min!, currency);
    case 'from': return `desde ${formatMoney(l.price_min!, currency)}`;
    case 'range': return `${formatMoney(l.price_min!, currency)} a ${formatMoney(l.price_max!, currency)}`;
  }
}

/** Importe de un renglón (cantidad × precio, antes de IVA). */
export function formatLineAmount(l: Pick<PricedLine, 'price_mode' | 'amount_min' | 'amount_max'>, currency = 'MXN'): string {
  if (l.price_mode === 'tbd' || l.amount_min === null) return 'Por confirmar';
  if (l.price_mode === 'from') return `desde ${formatMoney(l.amount_min, currency)}`;
  if (l.amount_max !== null && l.amount_max !== l.amount_min) return `${formatMoney(l.amount_min, currency)} a ${formatMoney(l.amount_max, currency)}`;
  return formatMoney(l.amount_min, currency);
}

type Range = Pick<PricedQuote, 'open_ended' | 'has_tbd'> & { min: number; max: number; anyPriced: boolean };

function formatRange(r: Range, currency: string): string {
  if (!r.anyPriced) return 'Por confirmar';
  let s = r.open_ended ? `desde ${formatMoney(r.min, currency)}`
    : r.min === r.max ? formatMoney(r.min, currency)
    : `${formatMoney(r.min, currency)} a ${formatMoney(r.max, currency)}`;
  if (r.has_tbd) s += ' + conceptos por confirmar';
  return s;
}

const anyPriced = (q: Pick<PricedQuote, 'lines'>) => q.lines.some((l) => l.price_mode !== 'tbd');

export function formatTotals(q: PricedQuote, currency = 'MXN'): { subtotal: string; iva: string; total: string } {
  const base = { open_ended: q.open_ended, has_tbd: q.has_tbd, anyPriced: anyPriced(q) };
  return {
    subtotal: formatRange({ ...base, min: q.subtotal_min, max: q.subtotal_max }, currency),
    iva: formatRange({ ...base, min: q.iva_min, max: q.iva_max }, currency),
    total: formatRange({ ...base, min: q.total_min, max: q.total_max }, currency),
  };
}

/** Fecha `YYYY-MM-DD` en palabras: «4 de noviembre de 2026». */
export function formatDate(isoDate: string | Date): string {
  const d = typeof isoDate === 'string' ? new Date(`${isoDate.slice(0, 10)}T12:00:00Z`) : isoDate;
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}
