/**
 * IVA de los planes. Los precios se capturan sin IVA y se publican "+ IVA"; el cliente paga precio + IVA.
 * Todo en centavos enteros: el desglose de un pago siempre suma exactamente su total.
 */
import { config } from '../config.js';
import type { Plan } from './types.js';

export const taxPercent = () => config.billing.taxPercent;

/** Precio + IVA, redondeado al centavo. */
export const withTax = (cents: number, percent = taxPercent()) => cents + Math.round((cents * percent) / 100);

/** Lo que se le cobra al cliente por el plan. */
export const chargeCents = (plan: Pick<Plan, 'price_cents'>) => withTax(plan.price_cents);

/** Desglosa un total que ya incluye IVA: subtotal + IVA = total. */
export function splitTax(totalCents: number, percent = taxPercent()) {
  const subtotal = Math.round((totalCents * 100) / (100 + percent));
  return { subtotal, tax: totalCents - subtotal };
}
