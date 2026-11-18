/**
 * Lo que el sistema le escribe al cliente con su cotización. Los montos salen del cálculo (nunca de la IA) y siempre se
 * dice si es APROXIMADA o FINAL, igual que en el archivo. Sale en el idioma del agente (src/locale.ts): de tú, de usted o
 * en inglés.
 */
import { langOfVoice, type Voice } from '../locale.js';
import type { Quote } from '../store/quotes.js';
import { formatDate, formatLineAmount, formatQty, formatTotals, formatUnitPrice } from './format.js';

function total(q: Quote, v: Voice): string {
  const t = formatTotals({ ...q, lines: q.lines ?? [], can_be_final: false }, q.currency, langOfVoice(v)).total;
  if (!(q.iva_max > 0)) return t;
  return v === 'en' ? `${t} including tax` : `${t} con IVA`;
}

const estimated = (q: Quote) => q.open_ended || q.total_min !== q.total_max || q.has_tbd;

/** El mensaje que acompaña al PDF (o al enlace, en los canales que no envían archivos). */
export function quoteMessage(q: Quote, v: Voice, link?: string): string {
  if (v === 'en') {
    const valid = formatDate(q.valid_until, 'en');
    const text = q.kind === 'final'
      ? `Here is your FINAL quote (no. ${q.folio}) for ${total(q, v)}, valid until ${valid}.`
      : `Here is your ESTIMATED quote (no. ${q.folio}): ${estimated(q) ? 'estimated total' : 'total'} ${total(q, v)}. `
        + `It's an estimate: the final price may change once the details are confirmed. Valid until ${valid}.`;
    return link ? `${text}\nYou can see it here: ${link}` : text;
  }
  const tu = v === 'tu';
  const valid = formatDate(q.valid_until);
  const text = q.kind === 'final'
    ? `${tu ? 'Te comparto tu' : 'Le comparto su'} cotización FINAL (folio ${q.folio}) por ${total(q, v)}, vigente hasta el ${valid}.`
    : `${tu ? 'Te comparto tu' : 'Le comparto su'} cotización APROXIMADA (folio ${q.folio}): ${estimated(q) ? 'total estimado' : 'total'} ${total(q, v)}. `
      + `Es aproximada: el precio final puede cambiar al confirmar los detalles. Vigente hasta el ${valid}.`;
  return link ? `${text}\n${tu ? 'Puedes verla' : 'Puede verla'} aquí: ${link}` : text;
}

/**
 * El desglose en el chat (sin PDF o además del PDF): cada concepto con cantidad × precio = importe, subtotal, IVA y total,
 * si es aproximada o final, la vigencia y la leyenda del negocio. Todo sale del cálculo guardado.
 */
export function summaryMessage(q: Quote, v: Voice, o: { legend?: string; link?: string } = {}): string {
  const en = v === 'en';
  const lang = langOfVoice(v);
  const tu = v === 'tu';
  const cur = q.currency;
  const lines = q.lines ?? [];
  const t = formatTotals({ ...q, lines, can_be_final: false }, cur, lang);
  const kind = en ? (q.kind === 'final' ? 'FINAL' : 'ESTIMATED') : (q.kind === 'final' ? 'FINAL' : 'APROXIMADA');
  const head = en ? `This is your ${kind} quote (no. ${q.folio}):` : `${tu ? 'Esta es tu' : 'Esta es su'} cotización ${kind} (folio ${q.folio}):`;
  const rows = lines.map((l) => `• ${formatQty(l.qty, lang)} × ${l.name}${l.unit && l.unit !== 'pieza' ? ` (${l.unit})` : ''} — ${formatUnitPrice(l, cur, q.iva_rate, lang)} = ${formatLineAmount(l, cur, lang)}`);
  const totals = q.iva_max > 0 || q.iva_min > 0
    ? [`Subtotal: ${t.subtotal}`, `${en ? 'Tax' : 'IVA'}: ${t.iva}`, `Total: ${t.total}`]
    : [`Total: ${t.total}`];
  const valid = formatDate(q.valid_until, lang);
  const tail = en
    ? [
      q.kind === 'final' ? `Valid until ${valid}.` : `It's an estimate: the final price may change once the details are confirmed. Valid until ${valid}.`,
      ...(o.legend ? [o.legend] : []),
      ...(o.link ? [`You can see it as a PDF here: ${o.link}`] : []),
    ]
    : [
      q.kind === 'final' ? `Vigente hasta el ${valid}.` : `Es aproximada: el precio final puede cambiar al confirmar los detalles. Vigente hasta el ${valid}.`,
      ...(o.legend ? [o.legend] : []),
      ...(o.link ? [`${tu ? 'Puedes verla' : 'Puede verla'} en PDF aquí: ${o.link}`] : []),
    ];
  return [head, ...rows, '', ...totals, '', ...tail].join('\n');
}

/** La final la revisa el equipo antes de enviarla. */
export const pendingMessage = (v: Voice) =>
  v === 'en' ? "Our team is reviewing your final quote; we'll send it as soon as it's approved."
    : v === 'tu'
      ? 'Tu cotización final la está revisando el equipo; te la enviamos en cuanto esté aprobada.'
      : 'Su cotización final la está revisando el equipo; se la enviamos en cuanto esté aprobada.';

/** No se pudo generar el archivo: el equipo ya está avisado. */
export const failedMessage = (v: Voice) =>
  v === 'en' ? "We're preparing your quote; we'll send it as soon as it's ready."
    : v === 'tu'
      ? 'Estamos preparando tu cotización; en cuanto esté lista te la enviamos.'
      : 'Estamos preparando su cotización; en cuanto esté lista se la enviamos.';
