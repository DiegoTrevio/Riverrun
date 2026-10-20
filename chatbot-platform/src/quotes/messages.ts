/**
 * Lo que el sistema le escribe al cliente con su cotización. Los montos salen del cálculo (nunca de la IA) y siempre se
 * dice si es APROXIMADA o FINAL, igual que en el archivo.
 */
import type { Quote } from '../store/quotes.js';
import { formatDate, formatTotals } from './format.js';

type Formality = 'tu' | 'usted';

function total(q: Quote): string {
  const t = formatTotals({ ...q, lines: q.lines ?? [], can_be_final: false }, q.currency).total;
  return q.iva_max > 0 ? `${t} con IVA` : t;
}

/** El mensaje que acompaña al PDF (o al enlace, en los canales que no envían archivos). */
export function quoteMessage(q: Quote, f: Formality, link?: string): string {
  const tu = f === 'tu';
  const valid = formatDate(q.valid_until);
  const text = q.kind === 'final'
    ? `${tu ? 'Te comparto tu' : 'Le comparto su'} cotización FINAL (folio ${q.folio}) por ${total(q)}, vigente hasta el ${valid}.`
    : `${tu ? 'Te comparto tu' : 'Le comparto su'} cotización APROXIMADA (folio ${q.folio}): ${q.open_ended || q.total_min !== q.total_max || q.has_tbd ? 'total estimado' : 'total'} ${total(q)}. `
      + `Es aproximada: el precio final puede cambiar al confirmar los detalles. Vigente hasta el ${valid}.`;
  return link ? `${text}\n${tu ? 'Puedes verla' : 'Puede verla'} aquí: ${link}` : text;
}

/** La final la revisa el equipo antes de enviarla. */
export const pendingMessage = (f: Formality) =>
  f === 'tu'
    ? 'Tu cotización final la está revisando el equipo; te la enviamos en cuanto esté aprobada.'
    : 'Su cotización final la está revisando el equipo; se la enviamos en cuanto esté aprobada.';

/** No se pudo generar el archivo: el equipo ya está avisado. */
export const failedMessage = (f: Formality) =>
  f === 'tu'
    ? 'Estamos preparando tu cotización; en cuanto esté lista te la enviamos.'
    : 'Estamos preparando su cotización; en cuanto esté lista se la enviamos.';
