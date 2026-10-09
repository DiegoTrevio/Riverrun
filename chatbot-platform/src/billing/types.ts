export type ProviderName = 'stripe' | 'mercadopago';
export type SubStatus = 'incomplete' | 'active' | 'past_due' | 'canceled';

export interface Plan {
  key: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  stripe_price_id: string;
  active: boolean;
  sort_order: number;
  limits: Record<string, number | null>;
}

export interface Subscription {
  account_id: string;
  provider: ProviderName;
  provider_customer_id: string;
  provider_subscription_id: string;
  plan_key: string;
  status: SubStatus;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  past_due_since: Date | null;
  access_ended_at: Date | null;
}

/** Estado de una suscripción tal como lo informa el proveedor, ya normalizado. */
export interface SubscriptionState {
  provider: ProviderName;
  accountId: string | null;
  customerId: string;
  subscriptionId: string;
  planKey: string;
  status: SubStatus;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface WebhookResult {
  eventId: string;
  type: string;
  /** Estado leído del proveedor (siempre se consulta de nuevo: así los avisos repetidos o desordenados no estorban). */
  state: SubscriptionState | null;
}

export interface CheckoutArgs {
  accountId: string;
  email: string;
  plan: Plan;
  successUrl: string;
  cancelUrl: string;
  /** Cliente que ya tiene el proveedor (reintentos y cambios de plan). */
  customerId?: string;
}

export interface BillingProvider {
  name: ProviderName;
  label: string;
  enabled(): boolean;
  /** Puede cobrar este plan (p.ej. Stripe necesita el ID de precio). */
  supportsPlan(plan: Plan): boolean;
  createCheckout(args: CheckoutArgs): Promise<{ url: string }>;
  /** Página del proveedor para cambiar la tarjeta y ver facturas (si la tiene). */
  portal?(customerId: string, returnUrl: string): Promise<{ url: string }>;
  setCancelAtPeriodEnd(sub: Subscription, cancel: boolean): Promise<void>;
  /** Verifica la firma y devuelve el estado. Lanza `WebhookError` si la firma no es válida. */
  handleWebhook(req: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; query: Record<string, string | undefined>; plans: Plan[] }): Promise<WebhookResult | null>;
}

export class WebhookError extends Error {}
export class ProviderError extends Error {}
