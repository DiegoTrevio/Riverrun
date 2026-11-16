/**
 * IVA de los planes. Los precios se capturan sin IVA y se publican "+ IVA"; el cliente paga precio + IVA.
 * Todo en centavos enteros: el desglose de un pago siempre suma exactamente su total.
 */
import { config } from '../config.js';
import type { Plan } from './types.js';

/**
 * IVA de una moneda: el de BILLING_TAX_PERCENT para las de BILLING_TAX_CURRENCIES (MXN por omisión) y 0 para las demás
 * (un plan en USD para Estados Unidos no lleva IVA mexicano). Sin moneda, el IVA configurado.
 */
export const taxPercent = (currency?: string) =>
  currency === undefined || config.billing.taxCurrencies.includes(currency.toUpperCase()) ? config.billing.taxPercent : 0;

/** Precio + IVA, redondeado al centavo. */
export const withTax = (cents: number, percent = taxPercent()) => cents + Math.round((cents * percent) / 100);

/** Lo que se le cobra al cliente por el plan. */
export const chargeCents = (plan: Pick<Plan, 'price_cents' | 'currency'>) => withTax(plan.price_cents, taxPercent(plan.currency));

/** Desglosa un total que ya incluye IVA: subtotal + IVA = total. */
export function splitTax(totalCents: number, percent = taxPercent()) {
  const subtotal = Math.round((totalCents * 100) / (100 + percent));
  return { subtotal, tax: totalCents - subtotal };
}
