/**
 * Cómo se escriben los montos, cantidades y fechas de una cotización. Lo usan el archivo y el mensaje del chat, para que
 * el cliente lea exactamente lo mismo en ambos.
 */
import { localeOf, type Lang } from '../locale.js';
import { unitBeforeIva, type PricedLine, type PricedQuote } from './pricing.js';

const money = new Map<string, Intl.NumberFormat>();

/** Palabras de los montos en cada idioma del negocio (src/locale.ts). */
const WORDS = {
  es: { from: 'desde', to: 'a', tbd: 'Por confirmar', moreTbd: ' + conceptos por confirmar' },
  en: { from: 'from', to: 'to', tbd: 'To be confirmed', moreTbd: ' + items to be confirmed' },
} as const;

export function formatMoney(cents: number, currency = 'MXN', lang: Lang = 'es'): string {
  const { locale } = localeOf(lang);
  let f = money.get(`${locale}|${currency}`);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    money.set(`${locale}|${currency}`, f);
  }
  return f.format(cents / 100);
}

const qtyFormat = { es: new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 }), en: new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }) };
export const formatQty = (qty: number, lang: Lang = 'es') => qtyFormat[lang].format(qty);

/**
 * Precio unitario del renglón: «$1,200.00», «desde $1,200.00», «$1,000.00 a $1,500.00», «Por confirmar». Va antes de IVA
 * como el importe (para «IVA incluido», el precio de lista sin su IVA), así cantidad × precio = importe. Sin `ivaRate`
 * (la lista de precios) se muestra el precio tal como lo fijó el negocio.
 */
export function formatUnitPrice(l: Pick<PricedLine, 'price_mode' | 'price_min' | 'price_max'> & { iva_mode?: PricedLine['iva_mode'] }, currency = 'MXN', ivaRate?: number, lang: Lang = 'es'): string {
  const unit = (c: number) => formatMoney(ivaRate === undefined || !l.iva_mode ? c : unitBeforeIva(c, l.iva_mode, ivaRate), currency, lang);
  const w = WORDS[lang];
  switch (l.price_mode) {
    case 'tbd': return w.tbd;
    case 'exact': return unit(l.price_min!);
    case 'from': return `${w.from} ${unit(l.price_min!)}`;
    case 'range': return `${unit(l.price_min!)} ${w.to} ${unit(l.price_max!)}`;
  }
}

/** Importe de un renglón (cantidad × precio, antes de IVA). */
export function formatLineAmount(l: Pick<PricedLine, 'price_mode' | 'amount_min' | 'amount_max'>, currency = 'MXN', lang: Lang = 'es'): string {
  const w = WORDS[lang];
  const m = (c: number) => formatMoney(c, currency, lang);
  if (l.price_mode === 'tbd' || l.amount_min === null) return w.tbd;
  if (l.price_mode === 'from') return `${w.from} ${m(l.amount_min)}`;
  if (l.amount_max !== null && l.amount_max !== l.amount_min) return `${m(l.amount_min)} ${w.to} ${m(l.amount_max)}`;
  return m(l.amount_min);
}

type Range = Pick<PricedQuote, 'open_ended' | 'has_tbd'> & { min: number; max: number; anyPriced: boolean };

function formatRange(r: Range, currency: string, lang: Lang): string {
  const w = WORDS[lang];
  const m = (c: number) => formatMoney(c, currency, lang);
  if (!r.anyPriced) return w.tbd;
  let s = r.open_ended ? `${w.from} ${m(r.min)}`
    : r.min === r.max ? m(r.min)
    : `${m(r.min)} ${w.to} ${m(r.max)}`;
  if (r.has_tbd) s += w.moreTbd;
  return s;
}

const anyPriced = (q: Pick<PricedQuote, 'lines'>) => q.lines.some((l) => l.price_mode !== 'tbd');

export function formatTotals(q: PricedQuote, currency = 'MXN', lang: Lang = 'es'): { subtotal: string; iva: string; total: string } {
  const base = { open_ended: q.open_ended, has_tbd: q.has_tbd, anyPriced: anyPriced(q) };
  return {
    subtotal: formatRange({ ...base, min: q.subtotal_min, max: q.subtotal_max }, currency, lang),
    iva: formatRange({ ...base, min: q.iva_min, max: q.iva_max }, currency, lang),
    total: formatRange({ ...base, min: q.total_min, max: q.total_max }, currency, lang),
  };
}

/** Fecha `YYYY-MM-DD` en palabras: «4 de noviembre de 2026» («November 4, 2026» en inglés). */
export function formatDate(isoDate: string | Date, lang: Lang = 'es'): string {
  const d = typeof isoDate === 'string' ? new Date(`${isoDate.slice(0, 10)}T12:00:00Z`) : isoDate;
  return new Intl.DateTimeFormat(localeOf(lang).locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}
