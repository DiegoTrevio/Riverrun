import crypto from 'node:crypto';
import { config } from '../config.js';
import { ProviderError, WebhookError, type BillingProvider, type Plan, type SubStatus, type SubscriptionState } from './types.js';

const cfg = () => config.billing.stripe;

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
  const res = await fetch(cfg().apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${cfg().secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? form(body).join('&') : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Stripe: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  return data;
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
  enabled: () => !!(cfg().secretKey && cfg().webhookSecret),
  supportsPlan: (plan) => !!plan.stripe_price_id,

  async createCheckout({ accountId, email, plan, successUrl, cancelUrl, customerId }) {
    const meta = { account_id: accountId, plan_key: plan.key };
    const s = await call('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
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
    return { url: s.url };
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
    const result = { eventId: String(event.id), type: String(event.type), state: null as SubscriptionState | null };
    if (!SUB_EVENTS.has(event.type)) return result;
    const obj = event.data?.object ?? {};
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
