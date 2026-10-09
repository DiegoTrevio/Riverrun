import crypto from 'node:crypto';
import { config } from '../config.js';
import { ProviderError, WebhookError, type BillingProvider, type Plan, type SubStatus, type SubscriptionState } from './types.js';

const cfg = () => config.billing.mercadopago;

async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any> {
  const res = await fetch(cfg().apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${cfg().accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Mercado Pago: ${data?.message ?? `HTTP ${res.status}`}`);
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
  enabled: () => !!(cfg().accessToken && cfg().webhookSecret),
  supportsPlan: () => true,

  async createCheckout({ accountId, email, plan, successUrl }) {
    const p = await call('POST', '/preapproval', {
      reason: plan.name,
      external_reference: reference(accountId, plan.key),
      payer_email: email,
      back_url: successUrl,
      status: 'pending',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: plan.price_cents / 100, currency_id: plan.currency },
    });
    if (!p.init_point) throw new ProviderError('Mercado Pago no devolvió la página de pago');
    return { url: p.init_point };
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
    const result = { eventId: `${type}:${dataId}:${sig.match(/ts=(\d+)/)?.[1] ?? ''}`, type, state: null as SubscriptionState | null };
    if (!dataId) return result;

    let preapprovalId = '';
    let rejectedPayment = false;
    if (type === 'subscription_preapproval') preapprovalId = dataId;
    else if (type === 'subscription_authorized_payment') {
      const pay = await call('GET', `/authorized_payments/${encodeURIComponent(dataId)}`);
      preapprovalId = String(pay.preapproval_id ?? '');
      rejectedPayment = ['rejected', 'cancelled'].includes(String(pay.status));
    }
    if (!preapprovalId) return result;
    const state = stateFromPreapproval(await call('GET', `/preapproval/${encodeURIComponent(preapprovalId)}`));
    // Un cobro rechazado deja la suscripción "authorized" mientras reintenta: se trata como pago pendiente.
    if (rejectedPayment && state.status === 'active') state.status = 'past_due';
    result.state = state;
    return result;
  },
};
