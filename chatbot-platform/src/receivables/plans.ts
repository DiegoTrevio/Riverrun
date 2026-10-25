/**
 * Pagos recurrentes: una mensualidad, una cuota semanal o quincenal. Unos días antes de cada vencimiento se crea su cobro
 * (con sus recordatorios de pago, como cualquier otro). Cada periodo tiene su folio de origen, así que aunque la tarea
 * corra dos veces el cobro no se duplica. Pausar o borrar el plan no toca los cobros ya creados.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import * as astore from '../automation/store.js';
import { addDays } from '../automation/time.js';
import { todayIn, type Receivables } from './index.js';

export interface ReceivablePlan {
  id: string;
  account_id: string;
  contact_id: string;
  conversation_id: string | null;
  concept: string;
  amount_cents: number;
  currency: string;
  payment_link: string;
  reference: string;
  reminders: number[] | null;
  frequency: 'weekly' | 'biweekly' | 'monthly';
  day: number;
  starts_on: string;
  ends_on: string | null;
  max_payments: number | null;
  payments_created: number;
  last_due: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const cols = (p = '') => `${p}id, ${p}account_id, ${p}contact_id, ${p}conversation_id, ${p}concept, ${p}amount_cents::float8 AS amount_cents, ${p}currency,
  ${p}payment_link, ${p}reference, ${p}reminders, ${p}frequency, ${p}day, to_char(${p}starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(${p}ends_on, 'YYYY-MM-DD') AS ends_on, ${p}max_payments, ${p}payments_created, to_char(${p}last_due, 'YYYY-MM-DD') AS last_due,
  ${p}active, ${p}created_by, ${p}created_at, ${p}updated_at`;
export const PLAN_COLS = cols();
export const planCols = cols;

export const getPlan = (id: string) => queryOne<ReceivablePlan>(`SELECT ${PLAN_COLS} FROM receivable_plans WHERE id = $1`, [id]);

/* ------------------------------ Fechas ------------------------------ */

const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** El día `day` del mes (1-12) de ese año, o el último si el mes es más corto (31 → 30 de noviembre, 28 de febrero). */
const monthDay = (y: number, m: number, day: number) => `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, '0')}`;

/** El primer vencimiento del plan en o después de `from`. */
export function dueOnOrAfter(p: Pick<ReceivablePlan, 'frequency' | 'day' | 'starts_on'>, from: string): string {
  const start = from < p.starts_on ? p.starts_on : from;
  if (p.frequency === 'monthly') {
    let [y, m] = start.split('-').map(Number);
    let d = monthDay(y, m, p.day);
    if (d < start) { m++; if (m > 12) { m = 1; y++; } d = monthDay(y, m, p.day); }
    return d;
  }
  // Semanal o quincenal: el primero cae en el día de la semana elegido a partir del inicio; los quincenales siguen cada
  // 14 días desde ese primero (no desde «hoy»), para que no se recorran al pausar o al editar.
  const first = addDays(p.starts_on, (p.day - weekday(p.starts_on) + 7) % 7);
  if (start <= first) return first;
  const step = p.frequency === 'weekly' ? 7 : 14;
  const elapsed = Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400_000);
  return addDays(first, Math.ceil(elapsed / step) * step);
}

/** El vencimiento que sigue a uno ya creado. */
export const dueAfter = (p: Pick<ReceivablePlan, 'frequency' | 'day' | 'starts_on'>, last: string) => dueOnOrAfter(p, addDays(last, 1));

/** El próximo cobro que creará el plan (para mostrarlo), o null si ya terminó. */
/** El siguiente vencimiento por crear: después del último ya creado, pero nunca uno que ya pasó. */
const upcoming = (p: ReceivablePlan, today: string) => dueOnOrAfter(p, p.last_due && addDays(p.last_due, 1) > today ? addDays(p.last_due, 1) : today);

export function nextDue(p: ReceivablePlan, today: string): string | null {
  if (!p.active) return null;
  if (p.max_payments !== null && p.payments_created >= p.max_payments) return null;
  const due = upcoming(p, today);
  return p.ends_on && due > p.ends_on ? null : due;
}

/* ------------------------------ Tarea ------------------------------ */

/**
 * Crea los cobros de los planes activos cuyo vencimiento cae en los próximos días (RECEIVABLE_RECURRING_LEAD_DAYS, en la
 * zona de cada negocio). Al llegar a su fecha de fin o a su número de pagos, el plan se desactiva solo.
 */
export async function runPlans(receivables: Receivables, now = new Date(), planId?: string): Promise<number> {
  if (!config.receivables.enabled) return 0;
  const plans = await query<ReceivablePlan>(
    `SELECT ${cols('p.')} FROM receivable_plans p JOIN accounts a ON a.id = p.account_id
      WHERE p.active AND a.status <> 'paused' AND ($1::uuid IS NULL OR p.id = $1) ORDER BY p.created_at LIMIT 2000`, [planId ?? null]);
  let created = 0;
  const tzOf = new Map<string, string>();
  for (const p of plans) {
    try {
      if (!tzOf.has(p.account_id)) tzOf.set(p.account_id, (await astore.getSettings(p.account_id)).timezone);
      const today = todayIn(tzOf.get(p.account_id)!, now);
      const horizon = addDays(today, config.receivables.recurringLeadDays);
      let made = p.payments_created;
      let last = p.last_due;
      // Los periodos que ya pasaron no se cobran (al empezar, al reanudar un plan pausado o tras una caída): el siguiente
      // es el de hoy en adelante.
      let due = upcoming(p, today);
      const done = () => Boolean((p.ends_on && due > p.ends_on) || (p.max_payments !== null && made >= p.max_payments));
      // Se pudo pausar o borrar mientras corría la tarea.
      if (!done() && due <= horizon && !(await queryOne(`SELECT 1 FROM receivable_plans WHERE id = $1 AND active`, [p.id]))) continue;
      for (let guard = 0; guard < 60 && !done() && due <= horizon; guard++) {
        const r = await receivables.create({
          accountId: p.account_id, contactId: p.contact_id, conversationId: p.conversation_id, concept: p.concept, amountCents: Number(p.amount_cents),
          currency: p.currency, dueDate: due, paymentLink: p.payment_link, reference: p.reference, reminders: p.reminders,
          source: 'recurring', sourceId: `${p.id}:${due}`, createdBy: p.created_by, actor: 'un pago recurrente',
        });
        if (!r.existed) created++;
        made++;
        last = due;
        due = dueAfter(p, due);
      }
      const finished = done();
      if (last === p.last_due && !finished) continue;
      // Lo creado se cuenta desde los cobros (si dos procesos corrieron a la vez, ninguno cuenta doble).
      await query(
        `UPDATE receivable_plans SET last_due = GREATEST(last_due, $2::date),
                payments_created = (SELECT count(*) FROM receivables WHERE account_id = $3 AND source = 'recurring' AND source_id LIKE $4),
                active = active AND NOT $5, updated_at = now()
          WHERE id = $1`,
        [p.id, last, p.account_id, `${p.id}:%`, finished],
      );
      if (finished) await logEvent({ level: 'info', source: 'engine', message: `Pago recurrente terminado: ${p.concept} (${made} cobro(s))`, accountId: p.account_id });
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'engine', message: `No se pudo crear el cobro del pago recurrente «${p.concept}»: ${e?.message ?? e}`, accountId: p.account_id });
    }
  }
  return created;
}
