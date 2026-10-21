import crypto from 'node:crypto';
import { config } from '../config.js';
import { credentialAllowed } from '../outbound-guard.js';
import { chargeCents } from './tax.js';
import { ProviderError, WebhookError, type BillingProvider, type PaymentInfo, type SubStatus, type SubscriptionState, type WebhookResult } from './types.js';

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
  return {
    provider: 'mercadopago',
    accountId: accountId || null,
    customerId: String(p.payer_id ?? ''),
    subscriptionId: String(p.id),
    planKey: planKey ?? '',
    status: STATUS[p.status] ?? 'incomplete',
    periodEnd: next && !Number.isNaN(next.getTime()) ? next : null,
    cancelAtPeriodEnd: false,
  };
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

  async createCheckout({ accountId, email, plan, successUrl }) {
    const p = await call('POST', '/preapproval', {
      reason: plan.name,
      external_reference: reference(accountId, plan.key),
      payer_email: email,
      back_url: successUrl,
      status: 'pending',
      auto_recurring: { frequency: plan.billing_interval === 'year' ? 12 : 1, frequency_type: 'months', transaction_amount: chargeCents(plan) / 100, currency_id: plan.currency },
    });
    if (!p.init_point) throw new ProviderError('Mercado Pago no devolvió la página de pago');
    return { url: p.init_point, ref: String(p.id ?? '') };
  },

  async checkoutState(ref) {
    return stateFromPreapproval(await call('GET', `/preapproval/${encodeURIComponent(ref)}`));
  },

  async setCancelAtPeriodEnd(sub, cancel) {
    // Mercado Pago no tiene "cancelar al final del periodo": se cancela ya y el acceso dura hasta la fecha pagada.
    if (!cancel) throw new ProviderError('Para reanudar, contrata el plan de nuevo.');
    await call('PUT', `/preapproval/${encodeURIComponent(sub.provider_subscription_id)}`, { status: 'cancelled' });
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
    const state = stateFromPreapproval(await call('GET', `/preapproval/${encodeURIComponent(preapprovalId)}`));
    // Un cobro rechazado deja la suscripción "authorized" mientras reintenta: se trata como pago pendiente.
    if (rejectedPayment && state.status === 'active') state.status = 'past_due';
    if (result.payment) result.payment.periodEnd = state.periodEnd;
    result.state = state;
    return result;
  },
};
