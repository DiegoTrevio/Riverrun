/**
 * Variables que necesitan consultar la base: los «Datos de tus clientes» con su formato, la persona asignada, el saldo
 * pendiente y la próxima cita. Solo se consulta lo que el texto menciona, así un mensaje sin estas variables no cuesta nada.
 */
import { query, queryOne } from '../db.js';
import { displayFieldValue, listContactFields } from '../contacts/fields.js';
import { formatMoney } from '../quotes/format.js';
import * as store from '../store/index.js';
import type { AutomationEvent } from './types.js';
import { spanishDate, spanishTime, zonedToUtc } from './time.js';

export interface VarsContext {
  accountId: string;
  contactId: string | null;
  data?: Record<string, string> | null;
  /** Para {{asesor}}: la persona asignada a la conversación. */
  assignedUserId?: string | null;
  timezone: string;
  now?: Date;
}

const mentions = (texts: string[], name: string) => texts.some((t) => new RegExp(`\\{\\{\\s*${name}\\b`, 'i').test(t));

export async function lookupVars(texts: (string | null | undefined)[], c: VarsContext): Promise<Record<string, string>> {
  const t = texts.filter((x): x is string => !!x && x.includes('{{'));
  if (!t.length) return {};
  const vars: Record<string, string> = {};
  if (mentions(t, 'campo\\.')) {
    for (const f of await listContactFields(c.accountId)) {
      const v = c.data?.[f.key];
      if (v) vars[`campo.${f.key}`] = displayFieldValue(f, v);
    }
  }
  if (mentions(t, 'asesor') && c.assignedUserId) {
    const u = await store.getUser(c.assignedUserId);
    vars.asesor = (u?.name || '').trim() || u?.email || '';
  }
  if (c.contactId && (mentions(t, 'saldo') || mentions(t, 'pagos_pendientes'))) {
    const rows = await query<{ currency: string; total: string; n: number }>(
      `SELECT currency, sum(amount_cents)::text AS total, count(*)::int AS n FROM receivables
        WHERE account_id = $1 AND contact_id = $2 AND status = 'pending' AND approved_at IS NOT NULL GROUP BY currency ORDER BY sum(amount_cents) DESC`,
      [c.accountId, c.contactId],
    );
    vars.saldo = rows.length ? rows.map((r) => formatMoney(Number(r.total), r.currency)).join(' + ') : formatMoney(0);
    vars.pagos_pendientes = String(rows.reduce((s, r) => s + r.n, 0));
  }
  if (c.contactId && mentions(t, 'proxima_cita\\.')) {
    const a = await queryOne<{ starts_at: Date; service_name: string }>(
      `SELECT starts_at, service_name FROM appointments
        WHERE account_id = $1 AND contact_id = $2 AND status = 'confirmed' AND starts_at > $3 ORDER BY starts_at LIMIT 1`,
      [c.accountId, c.contactId, c.now ?? new Date()],
    );
    vars['proxima_cita.fecha'] = a ? spanishDate(new Date(a.starts_at), c.timezone) : '';
    vars['proxima_cita.hora'] = a ? spanishTime(new Date(a.starts_at), c.timezone) : '';
    vars['proxima_cita.servicio'] = a?.service_name ?? '';
  }
  return vars;
}

/** Las variables que trae el evento de una regla: el cobro ({{pago.*}}) y la cotización ({{cotizacion.*}}). */
export function eventVars(e: Pick<AutomationEvent, 'payment' | 'quote'>, timezone: string): Record<string, string> {
  const q = e.quote;
  return {
    ...(q ? {
      'cotizacion.folio': q.folio,
      'cotizacion.total': q.total,
      'cotizacion.vigencia': q.valid_until ? spanishDate(zonedToUtc(q.valid_until, '12:00', timezone), timezone) : '',
    } : {}),
    ...e.payment,
  };
}
