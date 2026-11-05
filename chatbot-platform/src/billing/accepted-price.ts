import { queryOne } from '../db.js';
import type { ProviderName } from './types.js';

/** El precio con el que se aceptó la suscripción y el plan que tenía entonces (ver `accepted_price_ref`, PAY-28). */
export interface AcceptedPrice {
  ref: string;
  planKey: string;
}

export async function acceptedPriceOf(provider: ProviderName, subscriptionId: string): Promise<AcceptedPrice | undefined> {
  if (!subscriptionId) return undefined;
  const row = await queryOne<{ accepted_price_ref: string; plan_key: string }>(
    `SELECT accepted_price_ref, plan_key FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2 AND accepted_price_ref <> ''`, [provider, subscriptionId]);
  return row?.plan_key ? { ref: row.accepted_price_ref, planKey: row.plan_key } : undefined;
}
