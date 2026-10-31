import { mpCardKey } from './trial-claims.js';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { credentialAllowed } from '../outbound-guard.js';
import { chargeCents } from './tax.js';
import { ProviderError, WebhookError, type BillingProvider, type DisputeInfo, type PaymentInfo, type SubStatus, type SubscriptionState, type WebhookResult } from './types.js';

const cfg = () => config.billing.mercadopago;
/** Prefijo de las credenciales de prueba de Mercado Pago. Las de producción empiezan por APP_USR-. */
const TEST_TOKENS = ['TEST-'];

async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any> {
  if (!credentialAllowed(cfg().accessToken, TEST_TOKENS)) throw new ProviderError('Mercado Pago: en este entorno (OUTBOUND_MODE=sandbox) solo se usan credenciales de prueba');
  const res = await fetch(cfg().apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${cfg().accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    // Sin respuesta (red, DNS o tiempo agotado): se informa como falla del proveedor, igual que un error HTTP.
    throw new ProviderError(e?.name === 'TimeoutError' ? 'Mercado Pago no respondió a tiempo' : 'No se pudo conectar con Mercado Pago');
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Mercado Pago: ${data?.message ?? `HTTP ${res.status}`}`, res.status);
  return data;
}

const STATUS: Record<string, SubStatus> = { authorized: 'active', pending: 'incomplete', paused: 'past_due', cancelled: 'canceled' };

/** La referencia externa lleva cuenta y plan: "cuenta:plan". */
export const reference = (accountId: string, planKey: string) => `${accountId}:${planKey}`;

export function stateFromPreapproval(p: any): SubscriptionState {
  const [accountId, planKey] = String(p.external_reference ?? '').split(':');
  const next = p.next_payment_date ? new Date(p.next_payment_date) : null;
  const start = p.auto_recurring?.start_date ? new Date(p.auto_recurring.start_date) : null;
  return {
    provider: 'mercadopago',
    accountId: accountId || null,
    customerId: String(p.payer_id ?? ''),
    subscriptionId: String(p.id),
    planKey: planKey ?? '',
    status: STATUS[p.status] ?? 'incomplete',
    periodEnd: next && !Number.isNaN(next.getTime()) ? next : null,
    cancelAtPeriodEnd: false,
    trialEnd: p.status === 'authorized' && start && start.getTime() > Date.now() ? start : null,
    cardKey: null,
  };
}

/** La suscripción y, si su primer cobro es a futuro (una prueba), la huella de su tarjeta (para una prueba por tarjeta). */
async function readPreapproval(id: string): Promise<{ p: any; state: SubscriptionState }> {
  const p = await call('GET', `/preapproval/${encodeURIComponent(id)}`);
  const state = stateFromPreapproval(p);
  if (state.trialEnd && p.card_id && p.payer_id) {
    const card = await call('GET', `/v1/customers/${encodeURIComponent(String(p.payer_id))}/cards/${encodeURIComponent(String(p.card_id))}`).catch(() => null);
    state.cardKey = card ? mpCardKey(card) : null;
  }
  return { p, state };
}

/** Cobro de un pago autorizado de la suscripción (null si todavía no se cobra o se rechazó). */
export function paymentFromAuthorized(pay: any): PaymentInfo | null {
  const total = Math.round(Number(pay.transaction_amount ?? 0) * 100);
  if (!pay.id || pay.payment?.status !== 'approved' || !(total > 0)) return null;
  const at = new Date(pay.debit_date ?? pay.last_modified ?? pay.date_created ?? Date.now());
  const paidAt = Number.isNaN(at.getTime()) ? new Date() : at;
  return {
    paymentId: String(pay.id),
    chargeRef: String(pay.payment?.id ?? ''),
    subscriptionId: String(pay.preapproval_id ?? ''),
    totalCents: total,
    currency: String(pay.currency_id ?? 'MXN').toUpperCase(),
    paidAt,
    periodStart: paidAt,
    periodEnd: null,
  };
}

/** Contracargo de un pago: status_detail "reimbursed" = se le devolvió el dinero a la plataforma (ganado); "settled" = perdido. */
export function disputeFromPayment(p: any): DisputeInfo | null {
  if (p.status !== 'charged_back') return null;
  const detail = String(p.status_detail ?? '');
  return {
    disputeId: `cb_${p.id}`,
    chargeRefs: [String(p.id ?? '')].filter(Boolean),
    status: detail === 'reimbursed' ? 'won' : detail === 'settled' ? 'lost' : 'open',
    amountCents: Math.round(Number(p.transaction_amount ?? 0) * 100),
    url: 'https://www.mercadopago.com.mx/activities',
  };
}

/** Pagos autorizados de una suscripción, del más reciente al más antiguo. */
async function authorizedPayments(preapprovalId: string): Promise<any[]> {
  const r = await call('GET', `/authorized_payments/search?${new URLSearchParams({ preapproval_id: preapprovalId })}`);
  const list: any[] = r.results ?? r.elements ?? [];
  return list.sort((a, b) => new Date(b.date_created ?? 0).getTime() - new Date(a.date_created ?? 0).getTime());
}

const MP_DAY = 86400_000;

/**
 * Firma de Mercado Pago: x-signature = "ts=...,v1=..."; v1 es HMAC-SHA256 de
 * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" con la clave secreta del webhook.
 */
export function verifySignature(opts: { signature?: string; requestId?: string; dataId?: string; secret: string; now?: number }) {
  const { signature, requestId, dataId, secret } = opts;
  if (!signature || !secret) throw new WebhookError('Falta la firma de Mercado Pago');
  const parts = Object.fromEntries(signature.split(',').map((p) => p.trim().split('=') as [string, string]));
  if (!parts.ts || !parts.v1) throw new WebhookError('Firma de Mercado Pago inválida');
  const id = dataId && /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId ?? '';
  const manifest = `${id ? `id:${id};` : ''}${requestId ? `request-id:${requestId};` : ''}ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  const got = Buffer.from(parts.v1, 'hex');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new WebhookError('Firma de Mercado Pago inválida');
  const ts = Number(parts.ts);
  // El ts puede venir en milisegundos o segundos; se acepta una ventana amplia (1 hora) contra reenvíos antiguos.
  const ms = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs((opts.now ?? Date.now()) - ms) > 3_600_000) throw new WebhookError('Firma de Mercado Pago vencida');
}

export const mercadopago: BillingProvider = {
  name: 'mercadopago',
  label: 'Mercado Pago',
  // Con una credencial de producción en sandbox no se ofrece el pago: no se puede completar.
  enabled: () => !!(cfg().accessToken && cfg().webhookSecret) && credentialAllowed(cfg().accessToken, TEST_TOKENS),
  supportsPlan: () => true,

  async createCheckout({ accountId, email, plan, successUrl, startAt }) {
    const p = await call('POST', '/preapproval', {
      reason: plan.name,
      external_reference: reference(accountId, plan.key),
      payer_email: email,
      back_url: successUrl,
      status: 'pending',
      auto_recurring: {
        frequency: plan.billing_interval === 'year' ? 12 : 1, frequency_type: 'months', transaction_amount: chargeCents(plan) / 100, currency_id: plan.currency,
        // Sustitución: el primer cobro es cuando termina el periodo ya pagado (no se cobra dos veces).
        ...(startAt && startAt.getTime() > Date.now() ? { start_date: startAt.toISOString() } : {}),
      },
    });
    if (!p.init_point) throw new ProviderError('Mercado Pago no devolvió la página de pago');
    return { url: p.init_point, ref: String(p.id ?? '') };
  },

  async checkoutState(ref) {
    return (await readPreapproval(ref)).state;
  },

  async endTrialNow(subscriptionId) {
    await call('PUT', `/preapproval/${encodeURIComponent(subscriptionId)}`, { status: 'cancelled' });
  },

  async setCancelAtPeriodEnd(sub, cancel) {
    // Mercado Pago no tiene "cancelar al final del periodo": se cancela ya y el acceso dura hasta la fecha pagada.
    if (!cancel) throw new ProviderError('Para reanudar, contrata el plan de nuevo.');
    await call('PUT', `/preapproval/${encodeURIComponent(sub.provider_subscription_id)}`, { status: 'cancelled' });
  },

  async changePlan(sub, plan) {
    const path = `/preapproval/${encodeURIComponent(sub.provider_subscription_id)}`;
    // El nuevo monto aplica desde el siguiente cobro; el periodo (mensual o anual) no se puede cambiar aquí.
    await call('PUT', path, {
      reason: plan.name,
      external_reference: reference(sub.account_id, plan.key),
      auto_recurring: { transaction_amount: chargeCents(plan) / 100, currency_id: plan.currency },
    });
    return stateFromPreapproval(await call('GET', path));
  },

  /**
   * Además del estado que informa Mercado Pago, se revisan sus cobros: una suscripción sigue "autorizada" mientras
   * reintenta un cobro rechazado, y una recién autorizada puede no haber cobrado nunca. Ambos casos son pago pendiente.
   * Para no marcar a quien sí paga, "nunca cobró" exige que Mercado Pago lo confirme (charged_quantity = 0) y 3 días.
   */
  async subscriptionState(subscriptionId, _plans, now = new Date()) {
    const { p, state } = await readPreapproval(subscriptionId);
    if (state.status !== 'active') return state;
    const pays = await authorizedPayments(subscriptionId);
    const last = pays[0];
    if (last && ['rejected', 'cancelled'].includes(String(last.status)) && last.payment?.status !== 'approved') state.status = 'past_due';
    const startedAt = new Date(p.auto_recurring?.start_date ?? p.date_created ?? now);
    const neverCharged = Number(p.summarized?.charged_quantity) === 0 && !pays.some((x) => x.payment?.status === 'approved');
    if (neverCharged && startedAt.getTime() < now.getTime() - 3 * MP_DAY) state.status = 'past_due';
    return state;
  },

  async recentPayments(subscriptionId, since) {
    const pays = await authorizedPayments(subscriptionId);
    return pays.map(paymentFromAuthorized).filter((x): x is PaymentInfo => !!x && x.paidAt >= since);
  },

  async cancelNow(subscriptionId) {
    try {
      await call('PUT', `/preapproval/${encodeURIComponent(subscriptionId)}`, { status: 'cancelled' });
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return;
      throw e;
    }
  },

  async refund(chargeRef) {
    const path = `/v1/payments/${encodeURIComponent(chargeRef)}`;
    // Ya reembolsado (un reintento tras perder la respuesta): no se pide otra vez.
    if ((await call('GET', path)).status === 'refunded') return;
    await call('POST', `${path}/refunds`, {});
  },

  async handleWebhook({ rawBody, headers, query }) {
    let body: any = {};
    try {
      body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      throw new WebhookError('Cuerpo inválido');
    }
    const dataId = String(query['data.id'] ?? body?.data?.id ?? '');
    verifySignature({ signature: String(headers['x-signature'] ?? ''), requestId: String(headers['x-request-id'] ?? ''), dataId: query['data.id'] ?? undefined, secret: cfg().webhookSecret });
    const type = String(body.type ?? query.type ?? query.topic ?? '');
    const sig = String(headers['x-signature'] ?? '');
    const result: WebhookResult = { eventId: `${type}:${dataId}:${sig.match(/ts=(\d+)/)?.[1] ?? ''}`, type, state: null };
    if (!dataId) return result;

    // Reembolso: llega como aviso del pago (tema "payment") con lo reembolsado hasta ahora.
    if (type === 'payment') {
      const p = await call('GET', `/v1/payments/${encodeURIComponent(dataId)}`);
      const refunded = Math.round(Number(p.transaction_amount_refunded ?? 0) * 100);
      if (refunded > 0) result.refund = { paymentId: '', chargeRefs: [String(p.id ?? dataId)], refundedCents: refunded };
      result.dispute = disputeFromPayment(p) ?? undefined;
      return result;
    }

    let preapprovalId = '';
    let rejectedPayment = false;
    if (type === 'subscription_preapproval') preapprovalId = dataId;
    else if (type === 'subscription_authorized_payment') {
      const pay = await call('GET', `/authorized_payments/${encodeURIComponent(dataId)}`);
      preapprovalId = String(pay.preapproval_id ?? '');
      rejectedPayment = ['rejected', 'cancelled'].includes(String(pay.status));
      result.payment = paymentFromAuthorized(pay) ?? undefined;
    }
    if (!preapprovalId) return result;
    const { state } = await readPreapproval(preapprovalId);
    // Un cobro rechazado deja la suscripción "authorized" mientras reintenta: se trata como pago pendiente.
    if (rejectedPayment && state.status === 'active') state.status = 'past_due';
    if (result.payment) result.payment.periodEnd = state.periodEnd;
    result.state = state;
    return result;
  },
};
