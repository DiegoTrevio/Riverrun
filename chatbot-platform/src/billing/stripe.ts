import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { credentialAllowed } from '../outbound-guard.js';
import { chargeCents } from './tax.js';
import { ProviderError, WebhookError, type BillingProvider, type DisputeInfo, type PaymentInfo, type Plan, type RefundInfo, type SubStatus, type SubscriptionState, type WebhookResult } from './types.js';

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

function assertKeyAllowed() {
  if (!credentialAllowed(cfg().secretKey, TEST_KEYS)) throw new ProviderError('Stripe: en este entorno (OUTBOUND_MODE=sandbox) solo se usan claves de prueba');
}

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown> | string): Promise<any> {
  assertKeyAllowed();
  const res = await fetch(cfg().apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${cfg().secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: typeof body === 'string' ? body : body ? form(body).join('&') : undefined,
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    // Sin respuesta (red, DNS o tiempo agotado): se informa como falla del proveedor, igual que un error HTTP.
    throw new ProviderError(e?.name === 'TimeoutError' ? 'Stripe no respondió a tiempo' : 'No se pudo conectar con Stripe');
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Stripe: ${data?.error?.message ?? `HTTP ${res.status}`}`, res.status, String(data?.error?.code ?? ''));
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

/** Contracargo de Stripe: abierto mientras se revisa; ganado o perdido al cerrarse. */
export function disputeFromStripe(d: any): DisputeInfo {
  return {
    disputeId: String(d.id ?? ''),
    chargeRefs: [idOf(d.charge), idOf(d.payment_intent)].filter(Boolean),
    // warning_closed: la consulta previa del banco se cerró sin contracargo.
    status: d.status === 'won' || d.status === 'warning_closed' ? 'won' : d.status === 'lost' ? 'lost' : 'open',
    amountCents: fromUnit(Number(d.amount ?? 0), String(d.currency ?? '')),
    url: d.id ? `https://dashboard.stripe.com/disputes/${d.id}` : 'https://dashboard.stripe.com/disputes',
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

/** Precio del renglón: el ID de precio del plan o, sin él, el monto con IVA y el periodo del plan. */
async function priceOf(plan: Plan) {
  return plan.stripe_price_id
    ? { price: plan.stripe_price_id }
    : { price_data: { currency: plan.currency.toLowerCase(), unit_amount: unitAmount(chargeCents(plan), plan.currency), recurring: { interval: plan.billing_interval === 'year' ? 'year' : 'month' }, product: await ensureProduct(plan) } };
}

const STATUS: Record<string, SubStatus> = {
  active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled', incomplete: 'incomplete', paused: 'past_due',
};

/**
 * El plan sale del precio que de verdad se cobra (PAY-7), no de la metadata: su id de precio configurado o el producto
 * `riverrun_<plan>` que crea Riverrun, con el mismo periodo. Un monto menor al del plan no da ese plan (p. ej. un precio
 * más barato elegido por fuera): queda '' (no cambia el plan) y se anota en `planMismatch`.
 */
export function planFromPrice(price: any, plans: Plan[]): { key: string; mismatch: string } {
  if (!price) return { key: '', mismatch: '' };
  const byId = plans.find((p) => p.stripe_price_id && p.stripe_price_id === price.id);
  if (byId) return { key: byId.key, mismatch: '' };
  const product = typeof price.product === 'string' ? price.product : price.product?.id ?? '';
  const plan = plans.find((p) => productId(p.key) === product);
  if (!plan) return { key: '', mismatch: product ? `el producto ${product} no es de ningún plan` : '' };
  const interval = plan.billing_interval === 'year' ? 'year' : 'month';
  if (price.recurring?.interval && price.recurring.interval !== interval) return { key: '', mismatch: `el periodo (${price.recurring.interval}) no es el del plan ${plan.key}` };
  const expected = unitAmount(chargeCents(plan), plan.currency);
  if (typeof price.unit_amount === 'number' && price.unit_amount < expected) return { key: '', mismatch: `el monto (${price.unit_amount}) es menor que el del plan ${plan.key} (${expected})` };
  return { key: plan.key, mismatch: '' };
}

/** Normaliza una suscripción de Stripe (compatible con versiones de la API que mueven current_period_end al renglón). */
export function stateFromSubscription(sub: any, plans: Plan[]): SubscriptionState {
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  const fromPrice = planFromPrice(item?.price, plans);
  return {
    provider: 'stripe',
    accountId: sub.metadata?.account_id || null,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? '',
    subscriptionId: sub.id,
    planKey: fromPrice.key,
    ...(fromPrice.mismatch ? { planMismatch: fromPrice.mismatch } : {}),
    status: STATUS[sub.status] ?? 'incomplete',
    periodEnd: typeof periodEnd === 'number' ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end || !!sub.cancel_at,
    trialEnd: sub.status === 'trialing' && typeof sub.trial_end === 'number' ? new Date(sub.trial_end * 1000) : null,
    // Se lee con expand[]=default_payment_method: sin expandir es solo el id.
    cardKey: typeof sub.default_payment_method === 'object' ? sub.default_payment_method?.card?.fingerprint ?? null : null,
    collectionPaused: !!sub.pause_collection,
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

const SUB_EVENTS = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.payment_action_required']);
const DISPUTE_EVENTS = new Set(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']);

/**
 * La huella de la tarjeta, aunque la suscripción no la traiga (PAY-17): sin ella no hay prueba gratis. Si la suscripción
 * no tiene su método de pago guardado (pasa con algunas tarjetas con 3D Secure o carteras como Apple Pay, según cómo
 * termina el Checkout), se lee del cliente: su método por omisión o su tarjeta guardada más reciente.
 */
async function withCardKey(state: SubscriptionState): Promise<SubscriptionState> {
  if (state.cardKey || !state.trialEnd || !state.customerId) return state;
  const cus = encodeURIComponent(state.customerId);
  const customer = await call('GET', `/v1/customers/${cus}?expand[]=invoice_settings.default_payment_method`).catch(() => null);
  const fromCustomer = customer?.invoice_settings?.default_payment_method?.card?.fingerprint;
  if (fromCustomer) return { ...state, cardKey: String(fromCustomer) };
  const list = await call('GET', `/v1/payment_methods?customer=${cus}&type=card&limit=1`).catch(() => null);
  const fromList = list?.data?.[0]?.card?.fingerprint;
  return fromList ? { ...state, cardKey: String(fromList) } : state;
}

/**
 * Código de promoción que escribe el cliente (3b.3): solo los que Riverrun marcó en Stripe (`metadata.riverrun = '1'`) y,
 * si su `metadata.riverrun_plans` lista planes (separados por coma), solo para esos. Devuelve el id del código o null.
 */
export async function promotionCodeFor(code: string, planKey: string): Promise<string | null> {
  const r = await call('GET', `/v1/promotion_codes?${new URLSearchParams({ code, active: 'true', limit: '1' })}`);
  const pc = r.data?.[0];
  if (!pc?.id || pc.code?.toLowerCase() !== code.toLowerCase() || pc.metadata?.riverrun !== '1') return null;
  const plans = String(pc.metadata?.riverrun_plans ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (plans.length && !plans.includes(planKey)) return null;
  return String(pc.id);
}

/**
 * Configuración propia del portal de Stripe (3b.3): cambiar la tarjeta, ver facturas y cancelar al final del periodo; sin
 * cambiar de plan (eso pasa por Riverrun, con sus reglas). Se crea una vez y su id se guarda en `system_keys`.
 */
async function portalConfiguration(fresh = false): Promise<string> {
  if (!fresh) {
    const row = await queryOne<{ value: Buffer }>(`SELECT value FROM system_keys WHERE name = 'stripe_portal_configuration'`);
    if (row) return row.value.toString('utf8');
  }
  const c = await call('POST', '/v1/billing_portal/configurations', {
    business_profile: { headline: 'Tu suscripción de Riverrun' },
    features: {
      payment_method_update: { enabled: 'true' },
      invoice_history: { enabled: 'true' },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
      subscription_update: { enabled: 'false' },
      customer_update: { enabled: 'false' },
    },
  });
  if (!c.id) throw new ProviderError('Stripe no devolvió la configuración del portal');
  await query(`INSERT INTO system_keys (name, value) VALUES ('stripe_portal_configuration', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`, [Buffer.from(String(c.id))]);
  return String(c.id);
}

export const stripe: BillingProvider = {
  name: 'stripe',
  label: 'Tarjeta (Stripe)',
  // Con una clave de producción en sandbox no se ofrece el pago: no se puede completar.
  enabled: () => !!(cfg().secretKey && cfg().webhookSecret) && credentialAllowed(cfg().secretKey, TEST_KEYS),
  // Con ID de precio (price_…) se usa ese; sin él, el precio mensual se arma con el monto y la moneda del plan.
  supportsPlan: () => true,

  async createCheckout({ accountId, email, plan, successUrl, cancelUrl, customerId, trialEnd, trialDays, promotionCode }) {
    const meta = { account_id: accountId, plan_key: plan.key };
    const item = { ...(await priceOf(plan)), quantity: 1 };
    const s = await call('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      line_items: [item],
      success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      client_reference_id: accountId,
      ...(customerId ? { customer: customerId } : { customer_email: email }),
      locale: 'es',
      metadata: meta,
      // Contra la prueba de tarjetas: la tarjeta siempre se pide (también con prueba), la página vence en 30 minutos
      // (el mínimo de Stripe) y se pide 3D Secure cuando el banco lo tiene. Los códigos de promoción no se aceptan sueltos.
      payment_method_collection: 'always',
      // Solo tarjeta: Link y otros métodos no traen la huella con la que se cuida una prueba por tarjeta (PAY-17).
      payment_method_types: ['card'],
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      payment_method_options: { card: { request_three_d_secure: 'any' } },
      // Solo el código que Riverrun validó (no se aceptan códigos sueltos en la página de Stripe).
      ...(promotionCode ? { discounts: [{ promotion_code: promotionCode }] } : {}),
      // Con prueba: se guarda la tarjeta hoy y el primer cobro es al terminar la prueba.
      subscription_data: {
        metadata: meta,
        ...(trialDays ? { trial_period_days: trialDays } : trialEnd ? { trial_end: Math.floor(trialEnd.getTime() / 1000) } : {}),
      },
    });
    if (!s.url) throw new ProviderError('Stripe no devolvió la página de pago');
    return { url: s.url, ref: String(s.id ?? '') };
  },

  async checkoutState(ref, plans) {
    const s = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(ref)}`);
    const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
    if (s.status !== 'complete' || !subId) return null;
    const state = await withCardKey(stateFromSubscription(await call('GET', `/v1/subscriptions/${encodeURIComponent(subId)}?expand[]=default_payment_method`), plans));
    if (!state.accountId) state.accountId = s.client_reference_id || null;
    return state;
  },

  async portal(customerId, returnUrl) {
    assertKeyAllowed();
    const open = async (configuration: string) => call('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl, configuration });
    let s;
    try {
      s = await open(await portalConfiguration());
    } catch (e) {
      // La configuración guardada ya no existe en Stripe (otra cuenta de Stripe, o la borraron): se crea otra.
      if (!(e instanceof ProviderError && (e.status === 404 || e.code === 'resource_missing'))) throw e;
      s = await open(await portalConfiguration(true));
    }
    return { url: s.url };
  },

  async endTrialNow(subscriptionId) {
    await call('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { trial_end: 'now' });
  },

  async setCancelAtPeriodEnd(sub, cancel) {
    // Un cambio programado (anual → mensual) ya no aplica a una suscripción que se cancela.
    if (cancel && sub.pending_plan_key) await stripe.cancelScheduledChange!(sub);
    await call('POST', `/v1/subscriptions/${encodeURIComponent(sub.provider_subscription_id)}`, { cancel_at_period_end: cancel ? 'true' : 'false' });
  },

  async schedulePlanChange(sub, plan) {
    const s = await call('GET', `/v1/subscriptions/${encodeURIComponent(sub.provider_subscription_id)}`);
    const price = s.items?.data?.[0]?.price?.id;
    if (!price) throw new ProviderError('Stripe: la suscripción no tiene un concepto que cambiar');
    let scheduleId = typeof s.schedule === 'string' ? s.schedule : s.schedule?.id;
    if (!scheduleId) scheduleId = (await call('POST', '/v1/subscription_schedules', { from_subscription: sub.provider_subscription_id })).id;
    const sched = await call('GET', `/v1/subscription_schedules/${encodeURIComponent(scheduleId)}`);
    const now = sched.current_phase ?? sched.phases?.[0];
    if (!now?.start_date || !now?.end_date) throw new ProviderError('Stripe: el calendario de la suscripción no tiene su periodo');
    // Lo pagado sigue hasta su fin (sin reembolso); el plan nuevo empieza con el siguiente cobro y luego sigue solo.
    await call('POST', `/v1/subscription_schedules/${encodeURIComponent(scheduleId)}`, {
      end_behavior: 'release',
      proration_behavior: 'none',
      phases: [
        { items: [{ price, quantity: 1 }], start_date: now.start_date, end_date: now.end_date },
        { items: [{ ...(await priceOf(plan)), quantity: 1 }], iterations: 1, metadata: { account_id: sub.account_id, plan_key: plan.key } },
      ],
    });
  },

  async cancelScheduledChange(sub) {
    const s = await call('GET', `/v1/subscriptions/${encodeURIComponent(sub.provider_subscription_id)}`);
    const scheduleId = typeof s.schedule === 'string' ? s.schedule : s.schedule?.id;
    if (!scheduleId) return;
    try {
      await call('POST', `/v1/subscription_schedules/${encodeURIComponent(scheduleId)}/release`, {});
    } catch (e) {
      // Ya liberado o terminado: no hay nada más que deshacer.
      if (e instanceof ProviderError && (e.status === 404 || e.status === 400)) return;
      throw e;
    }
  },

  async changePlan(sub, plan, { upgrade }) {
    const path = `/v1/subscriptions/${encodeURIComponent(sub.provider_subscription_id)}`;
    const item = (await call('GET', path)).items?.data?.[0]?.id;
    if (!item) throw new ProviderError('Stripe: la suscripción no tiene un concepto que cambiar');
    const updated = await call('POST', path, {
      items: [{ id: item, ...(await priceOf(plan)) }],
      metadata: { account_id: sub.account_id, plan_key: plan.key },
      // Subir: se cobra hoy la diferencia proporcional y, si el cobro falla, no se cambia nada. Bajar: el saldo a favor
      // queda para el siguiente cobro.
      proration_behavior: upgrade ? 'always_invoice' : 'create_prorations',
      ...(upgrade ? { payment_behavior: 'error_if_incomplete' } : {}),
    });
    return stateFromSubscription(updated, [plan]);
  },

  async subscriptionState(subscriptionId, plans) {
    return withCardKey(stateFromSubscription(await call('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=default_payment_method`), plans));
  },

  async recentPayments(subscriptionId, since) {
    const q = new URLSearchParams({ subscription: subscriptionId, status: 'paid', limit: '24', 'created[gte]': String(Math.floor(since.getTime() / 1000)) });
    const list = await call('GET', `/v1/invoices?${q}`);
    return (list.data ?? []).map(paymentFromInvoice).filter((p: PaymentInfo | null): p is PaymentInfo => !!p);
  },

  async cancelNow(subscriptionId) {
    try {
      await call('DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    } catch (e) {
      // Ya no existe o ya estaba cancelada: no hay nada más que hacer.
      if (e instanceof ProviderError && (e.status === 404 || e.code === 'resource_missing')) return;
      throw e;
    }
  },

  async pauseCollection(subscriptionId) {
    // void: las facturas de mientras se anulan (no quedan como deuda); la suscripción no se cancela.
    await call('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { pause_collection: { behavior: 'void' } });
  },

  async resumeCollection(subscriptionId) {
    await call('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, 'pause_collection=');
  },

  async refund(chargeRef) {
    try {
      await call('POST', '/v1/refunds', chargeRef.startsWith('pi_') ? { payment_intent: chargeRef } : { charge: chargeRef });
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'charge_already_refunded') return;
      throw e;
    }
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
    // Manda el estado de la disputa en Stripe, no el del aviso: uno viejo que llega tarde no reabre una ya resuelta (PAY-4).
    if (DISPUTE_EVENTS.has(event.type)) {
      const fresh = obj.id ? await call('GET', `/v1/disputes/${encodeURIComponent(obj.id)}`) : obj;
      return { ...result, dispute: disputeFromStripe(fresh) };
    }
    if (event.type === 'radar.early_fraud_warning.created') {
      const w = obj.id ? await call('GET', `/v1/radar/early_fraud_warnings/${encodeURIComponent(obj.id)}`) : obj;
      const chargeRefs = [idOf(w.charge), idOf(w.payment_intent)].filter(Boolean);
      return chargeRefs.length ? { ...result, fraudWarning: { id: String(w.id ?? obj.id), chargeRefs } } : result;
    }
    if (!SUB_EVENTS.has(event.type)) return result;
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') result.payment = paymentFromInvoice(obj) ?? undefined;
    if (event.type === 'invoice.payment_action_required' && obj.hosted_invoice_url) result.actionUrl = String(obj.hosted_invoice_url);
    const subId: string | undefined =
      event.type.startsWith('customer.subscription.') ? obj.id : obj.subscription ?? obj.parent?.subscription_details?.subscription ?? undefined;
    if (!subId) return result;
    // Siempre se lee la suscripción: refleja el estado real aunque los avisos lleguen repetidos o desordenados.
    const sub = await call('GET', `/v1/subscriptions/${encodeURIComponent(subId)}?expand[]=default_payment_method`);
    const state = await withCardKey(stateFromSubscription(sub, plans));
    if (!state.accountId && event.type === 'checkout.session.completed') state.accountId = obj.client_reference_id || null;
    result.state = state;
    return result;
  },
};
