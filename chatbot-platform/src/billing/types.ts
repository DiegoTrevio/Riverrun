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
  /** Cada cuánto se cobra. El precio (sin IVA) es por ese periodo. */
  billing_interval: 'month' | 'year';
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
  /** Último pago iniciado (sesión de Stripe o suscripción pendiente de Mercado Pago), para confirmarlo sin esperar el aviso. */
  checkout_provider: ProviderName | '';
  checkout_ref: string;
  checkout_at: Date | null;
  /** El banco detuvo el último cobro hasta que el cliente lo confirme (3DS): página donde lo confirma. */
  payment_action_url: string;
  /** Última vez que se comparó con el proveedor. */
  reconciled_at: Date | null;
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
  /** Cobro confirmado que trae el aviso (factura pagada en Stripe, pago autorizado en Mercado Pago). */
  payment?: PaymentInfo;
  /** Reembolso informado por el proveedor. */
  refund?: RefundInfo;
  /** Contracargo: el cliente desconoció un cobro con su banco. */
  dispute?: DisputeInfo;
  /** El banco detuvo el cobro hasta que el cliente lo confirme (3DS): página donde lo confirma. */
  actionUrl?: string;
}

export interface DisputeInfo {
  disputeId: string;
  /** Cargos con los que se puede encontrar el pago disputado. */
  chargeRefs: string[];
  status: 'open' | 'won' | 'lost';
  amountCents: number;
  /** Dónde se responde la disputa en el proveedor. */
  url: string;
}

export interface PaymentInfo {
  /** Factura de Stripe o pago autorizado de Mercado Pago: identifica el cobro aunque el aviso se repita. */
  paymentId: string;
  /** Cargo con el que el proveedor informará un reembolso. */
  chargeRef: string;
  subscriptionId: string;
  /** Lo que pagó el cliente, IVA incluido. */
  totalCents: number;
  currency: string;
  paidAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export interface RefundInfo {
  /** Factura (Stripe) o pago autorizado (Mercado Pago) reembolsado, si el proveedor lo informa. */
  paymentId: string;
  /** Cargos con los que se puede encontrar el pago. */
  chargeRefs: string[];
  /** Total reembolsado hasta ahora (no el monto de este reembolso). */
  refundedCents: number;
}

export interface CheckoutArgs {
  accountId: string;
  email: string;
  plan: Plan;
  successUrl: string;
  cancelUrl: string;
  /** Cliente que ya tiene el proveedor (reintentos y cambios de plan). */
  customerId?: string;
  /** Primer cobro en esta fecha (sustitución de una suscripción con el periodo ya pagado, o fin de la prueba). Solo Mercado Pago. */
  startAt?: Date;
  /** Quien paga durante su prueba no la pierde: el primer cobro es al terminar. Solo Stripe (Mercado Pago usa `startAt`). */
  trialEnd?: Date;
}

export interface BillingProvider {
  name: ProviderName;
  label: string;
  enabled(): boolean;
  /** Puede cobrar este plan. */
  supportsPlan(plan: Plan): boolean;
  /** Abre el pago. `ref` identifica ese pago en el proveedor (sesión de Stripe, suscripción de Mercado Pago). */
  createCheckout(args: CheckoutArgs): Promise<{ url: string; ref: string }>;
  /** Estado de la suscripción que generó un pago iniciado (null si todavía no se completa). */
  checkoutState(ref: string, plans: Plan[]): Promise<SubscriptionState | null>;
  /** Página del proveedor para cambiar la tarjeta y ver facturas (si la tiene). */
  portal?(customerId: string, returnUrl: string): Promise<{ url: string }>;
  setCancelAtPeriodEnd(sub: Subscription, cancel: boolean): Promise<void>;
  /**
   * Cambia el plan de la suscripción vigente y devuelve su estado ya cambiado. `upgrade`: el nuevo plan cuesta más (Stripe
   * cobra hoy la diferencia proporcional; al bajar, el saldo a favor se descuenta del siguiente cobro). Mercado Pago solo
   * cambia el monto desde el siguiente cobro y no cambia el periodo (mensual o anual): eso va por sustitución.
   */
  changePlan(sub: Subscription, plan: Plan, o: { upgrade: boolean }): Promise<SubscriptionState>;
  /** Estado actual de una suscripción (conciliación: por si un aviso se perdió). */
  subscriptionState(subscriptionId: string, plans: Plan[], now?: Date): Promise<SubscriptionState>;
  /** Cobros confirmados de la suscripción desde `since` (conciliación: los que no llegaron por aviso). */
  recentPayments(subscriptionId: string, since: Date): Promise<PaymentInfo[]>;
  /** Cancela ya (no al final del periodo): duplicadas, sin pago o con contracargo perdido. Ya cancelada cuenta como hecha. */
  cancelNow(subscriptionId: string): Promise<void>;
  /** Reembolsa por completo un cobro. Ya reembolsado cuenta como hecho. */
  refund(chargeRef: string): Promise<void>;
  /** Verifica la firma y devuelve el estado. Lanza `WebhookError` si la firma no es válida. */
  handleWebhook(req: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; query: Record<string, string | undefined>; plans: Plan[] }): Promise<WebhookResult | null>;
}

export class WebhookError extends Error {}
export class ProviderError extends Error {
  /** Código HTTP con el que respondió el proveedor (0 si no respondió) y su código de error, si lo da. */
  constructor(message: string, public status = 0, public code = '') {
    super(message);
  }
}
