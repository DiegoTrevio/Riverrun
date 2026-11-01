export type ProviderName = 'stripe' | 'mercadopago';
export type SubStatus = 'incomplete' | 'active' | 'past_due' | 'canceled';

export interface Plan {
  key: string;
  /** false = privado: no se publica y solo lo contrata la cuenta que lo tiene asignado. */
  public?: boolean;
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
  /** Plan al que se subió sin cobrar la diferencia (Mercado Pago): empieza con el primer cobro de su monto (vacío = ninguno). */
  pending_plan_key: string;
  pending_plan_since: Date | null;
  /** Monto pactado con el proveedor para ese plan (con IVA). */
  pending_amount_cents: number;
  /** Riverrun detuvo sus cobros por una disputa abierta (no es un pago pendiente). */
  collection_paused: boolean;
}

/** Estado de una suscripción tal como lo informa el proveedor, ya normalizado. */
export interface SubscriptionState {
  /** Stripe: por qué el precio cobrado no dio un plan (se avisa al superadministrador, PAY-7). */
  planMismatch?: string;
  /** Los cobros están detenidos (Stripe `pause_collection`, Mercado Pago `paused`). */
  collectionPaused?: boolean;
  provider: ProviderName;
  accountId: string | null;
  customerId: string;
  subscriptionId: string;
  planKey: string;
  status: SubStatus;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Prueba gratis con tarjeta: el primer cobro es en esta fecha (Stripe `trialing`; Mercado Pago, primer cobro a futuro). */
  trialEnd?: Date | null;
  /** Huella de la tarjeta (Stripe `card.fingerprint`; Mercado Pago, la armada con `mpCardKey`), para una prueba por tarjeta. */
  cardKey?: string | null;
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
  /** Alerta temprana de fraude (Stripe Radar): se reembolsa ese cobro y se trata como disputa perdida (PAY-5). */
  fraudWarning?: { id: string; chargeRefs: string[] };
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
  /** Verificación de tarjeta con prueba gratis: días antes del primer cobro. Solo Stripe (Mercado Pago usa `startAt`). */
  trialDays?: number;
  /** Código de promoción de Stripe ya validado (`promotionCodeFor`). Mercado Pago no tiene códigos. */
  promotionCode?: string;
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
  /** Una tarjeta que ya tuvo prueba: Stripe termina la prueba y cobra ya; Mercado Pago cancela esa suscripción. */
  endTrialNow(subscriptionId: string): Promise<void>;
  /**
   * Cambia el plan de la suscripción vigente y devuelve su estado ya cambiado. `upgrade`: el nuevo plan cuesta más (Stripe
   * cobra hoy la diferencia proporcional; al bajar, el saldo a favor se descuenta del siguiente cobro). Mercado Pago solo
   * cambia el monto desde el siguiente cobro y no cambia el periodo (mensual o anual): eso va por sustitución.
   */
  changePlan(sub: Subscription, plan: Plan, o: { upgrade: boolean }): Promise<SubscriptionState>;
  /**
   * Programa el cambio al plan para el final del periodo pagado, sin reembolso (anual → mensual, PAY-11). Solo Stripe
   * (con un calendario de la suscripción); `cancelScheduledChange` lo deshace.
   */
  schedulePlanChange?(sub: Subscription, plan: Plan): Promise<void>;
  cancelScheduledChange?(sub: Subscription): Promise<void>;
  /** Estado actual de una suscripción (conciliación: por si un aviso se perdió). */
  subscriptionState(subscriptionId: string, plans: Plan[], now?: Date): Promise<SubscriptionState>;
  /** Cobros confirmados de la suscripción desde `since` (conciliación: los que no llegaron por aviso). */
  recentPayments(subscriptionId: string, since: Date): Promise<PaymentInfo[]>;
  /** Cancela ya (no al final del periodo): duplicadas, sin pago o con contracargo perdido. Ya cancelada cuenta como hecha. */
  cancelNow(subscriptionId: string): Promise<void>;
  /** Reembolsa por completo un cobro. Ya reembolsado cuenta como hecho. */
  refund(chargeRef: string): Promise<void>;
  /** Detiene los cobros de la suscripción sin cancelarla (disputa abierta; PAY-4). Ya detenidos cuenta como hecho. */
  pauseCollection(subscriptionId: string): Promise<void>;
  /** Reanuda los cobros detenidos por una disputa (ganada). */
  resumeCollection(subscriptionId: string): Promise<void>;
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
