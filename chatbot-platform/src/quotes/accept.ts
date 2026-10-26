/**
 * Cotización aceptada por el cliente (lo marca el equipo) → sus cobros: el total, un anticipo y el resto, o varias
 * parcialidades. Cada cobro tiene su folio de origen (`<cotización>:<n>`), así que no se duplica.
 */
import { z } from 'zod';
import { dateStr } from '../dates.js';
import { addDays } from '../automation/time.js';
import type { Quote } from '../store/quotes.js';

const DateStr = dateStr();

export const AcceptBody = z.object({
  /** El monto final acordado: obligatorio si la cotización es un rango o tiene conceptos por definir. */
  amount_cents: z.number().int().min(1).max(100_000_000_000).optional(),
  /** Cómo se cobra; sin plan, solo se marca como aceptada. */
  plan: z.discriminatedUnion('type', [
    z.object({ type: z.literal('full'), due_date: DateStr }),
    z.object({ type: z.literal('deposit'), percent: z.number().int().min(1).max(99), due_date: DateStr, rest_due_date: DateStr }),
    z.object({ type: z.literal('installments'), count: z.number().int().min(2).max(36), first_due: DateStr, every: z.enum(['month', 'fortnight', 'week']) }),
  ]).nullable().default(null),
});
export type AcceptPlan = NonNullable<z.infer<typeof AcceptBody>['plan']>;

export interface PlannedCharge { amount_cents: number; due_date: string; concept: string; installment: string }

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** El mismo día `n` meses después (el 31 de enero + 1 mes = el 28 o 29 de febrero). */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number);
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, daysInMonth(ny, nm))).padStart(2, '0')}`;
}

/** El monto a cobrar: el total exacto de la cotización, o el que acordaron si es un rango. Error si falta o no cuadra. */
export function acceptedTotal(q: Pick<Quote, 'total_min' | 'total_max' | 'open_ended' | 'has_tbd'>, amount?: number): number {
  const exact = q.total_min === q.total_max && !q.open_ended && !q.has_tbd;
  if (exact && amount === undefined) return q.total_max;
  if (amount === undefined) throw new Error('Esta cotización es un rango: escribe el monto final que acordaron con el cliente');
  if (amount < q.total_min) throw new Error('El monto final no puede ser menor que el mínimo de la cotización');
  if (!q.open_ended && !q.has_tbd && amount > q.total_max) throw new Error('El monto final no puede ser mayor que el máximo de la cotización');
  return amount;
}

/** Los cobros del plan: los centavos que no se reparten parejo van en el último, así la suma es exactamente el total. */
export function planCharges(folio: string, total: number, plan: AcceptPlan): PlannedCharge[] {
  const base = `Cotización ${folio}`;
  if (plan.type === 'full') return [{ amount_cents: total, due_date: plan.due_date, concept: base, installment: '' }];
  if (plan.type === 'deposit') {
    if (plan.rest_due_date < plan.due_date) throw new Error('El resto no puede vencer antes que el anticipo');
    const deposit = Math.round((total * plan.percent) / 100);
    if (deposit < 1 || deposit >= total) throw new Error('El anticipo debe ser menor que el total');
    return [
      { amount_cents: deposit, due_date: plan.due_date, concept: `${base}: anticipo (${plan.percent} %)`, installment: '1 de 2' },
      { amount_cents: total - deposit, due_date: plan.rest_due_date, concept: `${base}: resto`, installment: '2 de 2' },
    ];
  }
  const each = Math.floor(total / plan.count);
  if (each < 1) throw new Error('Son demasiados pagos para ese monto');
  return Array.from({ length: plan.count }, (_, i) => ({
    amount_cents: i === plan.count - 1 ? total - each * (plan.count - 1) : each,
    due_date: plan.every === 'month' ? addMonths(plan.first_due, i) : addDays(plan.first_due, i * (plan.every === 'week' ? 7 : 15)),
    concept: `${base}: pago ${i + 1} de ${plan.count}`,
    installment: `${i + 1} de ${plan.count}`,
  }));
}
