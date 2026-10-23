/**
 * Registro de cobros: cada pago que confirma el proveedor, con su IVA desglosado, y sus reembolsos. Los avisos pueden
 * llegar repetidos o desordenados: un pago se guarda una sola vez y el reembolso solo crece.
 */
import { query, queryOne } from '../db.js';
import { splitTax, taxPercent } from './tax.js';
import type { PaymentInfo, ProviderName, RefundInfo } from './types.js';

export interface Payment {
  id: string;
  account_id: string | null;
  provider: ProviderName;
  provider_payment_id: string;
  plan_key: string;
  currency: string;
  total_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  tax_percent: string;
  refunded_cents: number;
  status: 'paid' | 'partially_refunded' | 'refunded';
  paid_at: Date;
  period_start: Date | null;
  period_end: Date | null;
}

/** Guarda el cobro. Devuelve su id si es nuevo (null si ese aviso ya se había registrado). */
export async function recordPayment(o: { accountId: string; provider: ProviderName; planKey: string; payment: PaymentInfo }): Promise<string | null> {
  const p = o.payment;
  const percent = taxPercent();
  const { subtotal, tax } = splitTax(p.totalCents, percent);
  const row = await queryOne<{ id: string; inserted: boolean }>(
    `INSERT INTO billing_payments (account_id, provider, provider_payment_id, provider_charge_ref, subscription_id, plan_key, currency,
       total_cents, subtotal_cents, tax_cents, tax_percent, paid_at, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (provider, provider_payment_id) DO UPDATE SET
       -- Un aviso posterior puede traer el cargo o el periodo que faltaban; lo demás no cambia.
       provider_charge_ref = CASE WHEN billing_payments.provider_charge_ref = '' THEN EXCLUDED.provider_charge_ref ELSE billing_payments.provider_charge_ref END,
       period_end = COALESCE(billing_payments.period_end, EXCLUDED.period_end), updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [o.accountId, o.provider, p.paymentId, p.chargeRef, p.subscriptionId, o.planKey, p.currency, p.totalCents, subtotal, tax, percent, p.paidAt, p.periodStart, p.periodEnd],
  );
  return row?.inserted ? row.id : null;
}

/** Anota un reembolso. Devuelve el pago afectado (null si no se encontró, p. ej. un cargo que no es de una suscripción). */
export async function applyRefund(provider: ProviderName, r: RefundInfo): Promise<{ id: string; account_id: string | null; status: string } | null> {
  if (!(r.refundedCents > 0) || (!r.paymentId && !r.chargeRefs.length)) return null;
  return queryOne(
    `UPDATE billing_payments SET refunded_cents = GREATEST(refunded_cents, LEAST($4::int, total_cents)),
       status = CASE WHEN GREATEST(refunded_cents, LEAST($4::int, total_cents)) >= total_cents THEN 'refunded' ELSE 'partially_refunded' END,
       updated_at = now()
     WHERE id = (SELECT id FROM billing_payments WHERE provider = $1 AND ((provider_payment_id = $2 AND $2 <> '') OR provider_charge_ref = ANY($3::text[])) ORDER BY paid_at DESC LIMIT 1)
     RETURNING id, account_id, status`,
    [provider, r.paymentId, r.chargeRefs.filter(Boolean), r.refundedCents],
  );
}

export const listPayments = (accountId: string, limit = 24) =>
  query<Payment>(
    `SELECT id, account_id, provider, provider_payment_id, plan_key, currency, total_cents, subtotal_cents, tax_cents, tax_percent, refunded_cents, status, paid_at, period_start, period_end
     FROM billing_payments WHERE account_id = $1 ORDER BY paid_at DESC LIMIT $2`,
    [accountId, limit],
  );
