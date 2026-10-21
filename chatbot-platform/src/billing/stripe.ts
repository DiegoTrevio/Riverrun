import crypto from 'node:crypto';
import { config } from '../config.js';
import { credentialAllowed } from '../outbound-guard.js';
import { chargeCents } from './tax.js';
import { ProviderError, WebhookError, type BillingProvider, type PaymentInfo, type Plan, type RefundInfo, type SubStatus, type SubscriptionState, type WebhookResult } from './types.js';

const cfg = () => config.billing.stripe;
/** Prefijos de las claves de prueba de Stripe (modo test). Las de producción empiezan por sk_live_ o rk_live_. */
const TEST_KEYS = ['sk_test_', 'rk_test_'];

/** Stripe recibe formularios con claves anidadas: a[b][0]=c. */
export function form(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? out.push(...form(x as Record<string, unknown>, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === 'object') out.push(...form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<any> {
  if (!credentialAllowed(cfg().secretKey, TEST_KEYS)) throw new ProviderError('Stripe: en este entorno (OUTBOUND_MODE=sandbox) solo se usan claves de prueba');
  const res = await fetch(cfg().apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${cfg().secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? form(body).join('&') : undefined,
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    // Sin respuesta (red, DNS o tiempo agotado): se informa como falla del proveedor, igual que un error HTTP.
    throw new ProviderError(e?.name === 'TimeoutError' ? 'Stripe no respondió a tiempo' : 'No se pudo conectar con Stripe');
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Stripe: ${data?.error?.message ?? `HTTP ${res.status}`}`, res.status);
  return data;
}

/** Monedas que Stripe cobra sin centavos: el monto va en unidades enteras. */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
export const unitAmount = (cents: number, currency: string) =>
  ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(cents / 100) : cents;
/** Monto de Stripe (unidad mínima de la moneda) a centavos. */
const fromUnit = (amount: number, currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? amount * 100 : amount);
const unixDate = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(s * 1000) : null);
const idOf = (x: any): string => (typeof x === 'string' ? x : x?.id ?? '');

/** Cobro de una factura pagada (null si no se cobró nada, p. ej. con un cupón del 100 %). */
export function paymentFromInvoice(inv: any): PaymentInfo | null {
  const currency = String(inv.currency ?? '').toUpperCase();
  const amount = Number(inv.amount_paid ?? 0);
  if (!inv.id || !currency || !(amount > 0) || (inv.status && inv.status !== 'paid')) return null;
  const period = inv.lines?.data?.[0]?.period ?? {};
  return {
    paymentId: String(inv.id),
    // Versiones nuevas de la API ya no traen el cargo en la factura: entonces se usa el intento de pago.
    chargeRef: idOf(inv.charge) || idOf(inv.payment_intent) || idOf(inv.payments?.data?.[0]?.payment?.payment_intent),
    subscriptionId: idOf(inv.subscription) || idOf(inv.parent?.subscription_details?.subscription),
    totalCents: fromUnit(amount, currency),
    currency,
    paidAt: unixDate(inv.status_transitions?.paid_at) ?? unixDate(inv.created) ?? new Date(),
    periodStart: unixDate(period.start),
    periodEnd: unixDate(period.end),
  };
}

export function refundFromCharge(ch: any): RefundInfo {
  return {
    paymentId: idOf(ch.invoice),
    chargeRefs: [idOf(ch), idOf(ch.payment_intent)].filter(Boolean),
    refundedCents: fromUnit(Number(ch.amount_refunded ?? 0), String(ch.currency ?? '')),
  };
}

/** Cada plan tiene su producto en Stripe con un ID fijo: se crea la primera vez que alguien lo contrata. */
export const productId = (planKey: string) => `riverrun_${planKey}`;

async function ensureProduct(plan: Plan): Promise<string> {
  const id = productId(plan.key);
  const get = () => call('GET', `/v1/products/${encodeURIComponent(id)}`).catch((e) => {
    if (e instanceof ProviderError && e.status === 404) return null;
    throw e;
  });
  let product = await get();
  if (!product) {
    try {
      product = await call('POST', '/v1/products', { id, name: plan.name, metadata: { plan_key: plan.key } });
    } catch (e) {
      // Otro proceso lo pudo crear al mismo tiempo.
      product = await get();
      if (!product) throw e;
    }
  }
  if (product.name !== plan.name || product.active === false) await call('POST', `/v1/products/${encodeURIComponent(id)}`, { name: plan.name, active: 'true' });
  return id;
}

const STATUS: Record<string, SubStatus> = {
  active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled', incomplete: 'incomplete', paused: 'past_due',
};

/** Normaliza una suscripción de Stripe (compatible con versiones de la API que mueven current_period_end al renglón). */
export function stateFromSubscription(sub: any, plans: Plan[]): SubscriptionState {
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  const priceId = item?.price?.id as string | undefined;
  return {
    provider: 'stripe',
    accountId: sub.metadata?.account_id || null,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? '',
    subscriptionId: sub.id,
    planKey: sub.metadata?.plan_key || plans.find((p) => p.stripe_price_id && p.stripe_price_id === priceId)?.key || '',
    status: STATUS[sub.status] ?? 'incomplete',
    periodEnd: typeof periodEnd === 'number' ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end || !!sub.cancel_at,
  };
}

/** Comprueba `Stripe-Signature` (HMAC-SHA256 sobre "tiempo.cuerpo") con tolerancia de 5 minutos. */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()) {
  if (!header || !secret) throw new WebhookError('Falta la firma de Stripe');
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  if (!Number.isFinite(t) || !sigs.length) throw new WebhookError('Firma de Stripe inválida');
  if (Math.abs(now / 1000 - t) > 300) throw new WebhookError('Firma de Stripe vencida');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const ok = sigs.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
  if (!ok) throw new WebhookError('Firma de Stripe inválida');
}

const SUB_EVENTS = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed']);

export const stripe: BillingProvider = {
  name: 'stripe',
  label: 'Tarjeta (Stripe)',
  // Con una clave de producción en sandbox no se ofrece el pago: no se puede completar.
  enabled: () => !!(cfg().secretKey && cfg().webhookSecret) && credentialAllowed(cfg().secretKey, TEST_KEYS),
  // Con ID de precio (price_…) se usa ese; sin él, el precio mensual se arma con el monto y la moneda del plan.
  supportsPlan: () => true,

  async createCheckout({ accountId, email, plan, successUrl, cancelUrl, customerId }) {
    const meta = { account_id: accountId, plan_key: plan.key };
    const item = plan.stripe_price_id
      ? { price: plan.stripe_price_id, quantity: 1 }
      : { price_data: { currency: plan.currency.toLowerCase(), unit_amount: unitAmount(chargeCents(plan), plan.currency), recurring: { interval: plan.billing_interval === 'year' ? 'year' : 'month' }, product: await ensureProduct(plan) }, quantity: 1 };
    const s = await call('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      line_items: [item],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: accountId,
      ...(customerId ? { customer: customerId } : { customer_email: email }),
      allow_promotion_codes: true,
      locale: 'es',
      metadata: meta,
      subscription_data: { metadata: meta },
    });
    if (!s.url) throw new ProviderError('Stripe no devolvió la página de pago');
    return { url: s.url, ref: String(s.id ?? '') };
  },

  async checkoutState(ref, plans) {
    const s = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(ref)}`);
    const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
    if (s.status !== 'complete' || !subId) return null;
    const state = stateFromSubscription(await call('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`), plans);
    if (!state.accountId) state.accountId = s.client_reference_id || null;
    return state;
  },

  async portal(customerId, returnUrl) {
    const s = await call('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    return { url: s.url };
  },

  async setCancelAtPeriodEnd(sub, cancel) {
    await call('POST', `/v1/subscriptions/${encodeURIComponent(sub.provider_subscription_id)}`, { cancel_at_period_end: cancel ? 'true' : 'false' });
  },

  async handleWebhook({ rawBody, headers, plans }) {
    verifySignature(rawBody, String(headers['stripe-signature'] ?? ''), cfg().webhookSecret);
    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookError('Cuerpo inválido');
    }
    const result: WebhookResult = { eventId: String(event.id), type: String(event.type), state: null };
    const obj = event.data?.object ?? {};
    if (event.type === 'charge.refunded') return { ...result, refund: refundFromCharge(obj) };
    if (!SUB_EVENTS.has(event.type)) return result;
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') result.payment = paymentFromInvoice(obj) ?? undefined;
    const subId: string | undefined =
      event.type.startsWith('customer.subscription.') ? obj.id : obj.subscription ?? obj.parent?.subscription_details?.subscription ?? undefined;
    if (!subId) return result;
    // Siempre se lee la suscripción: refleja el estado real aunque los avisos lleguen repetidos o desordenados.
    const sub = await call('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
    const state = stateFromSubscription(sub, plans);
    if (!state.accountId && event.type === 'checkout.session.completed') state.accountId = obj.client_reference_id || null;
    result.state = state;
    return result;
  },
};
