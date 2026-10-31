/**
 * Lo que traen los avisos de dinero (y la conciliación): cobros, reembolsos y contracargos. Cada uno se registra una
 * sola vez aunque llegue repetido, y lo que implica para la cuenta (factura, pausa, reactivación) pasa solo.
 */
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { emailSuperadmin } from '../platform/digest.js';
import { query, queryOne } from '../db.js';
import { queuePaymentCfdi } from './cfdi.js';
import { applyRefund, recordPayment } from './payments.js';
import { getSubscription, money, promotePendingPlan, providers, queueAction, startsPendingPlan, tell } from './service.js';
import { claimMarks } from './trial-claims.js';
import type { DisputeInfo, ProviderName, Subscription, WebhookResult } from './types.js';

/**
 * Aviso al superadmin; si la cuenta ya no existe, solo por correo (y en la bitácora). Urgente: el correo sale ya; si no,
 * va en el resumen del día.
 */
export async function alertSuperadmins(accountId: string | null, title: string, body: string, o: { urgent?: boolean } = {}) {
  if (accountId) return notifySuperadmins(accountId, title, body, o);
  await logEvent({ level: 'warn', source: 'admin', message: `${title}: ${body}` });
  await emailSuperadmin(title, body, o);
}

/**
 * Anota el cobro o el reembolso que trae un aviso. El cobro se asocia a la cuenta de su suscripción (la suscripción del
 * proveedor siempre trae la cuenta); un cobro sin cuenta no es de esta plataforma (otro producto en la misma cuenta del
 * proveedor) y solo se registra en la bitácora. Devuelve true si el cobro era nuevo.
 */
export async function recordMoney(name: ProviderName, result: Pick<WebhookResult, 'payment' | 'refund' | 'state'>, accountId: string | null): Promise<boolean> {
  let fresh = false;
  if (result.payment) {
    const sub = await queryOne<Pick<Subscription, 'account_id' | 'plan_key' | 'provider_subscription_id' | 'pending_plan_key' | 'pending_plan_since' | 'pending_amount_cents'>>(
      `SELECT account_id, plan_key, provider_subscription_id, pending_plan_key, pending_plan_since, pending_amount_cents FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`,
      [name, result.payment.subscriptionId]);
    const account = accountId ?? sub?.account_id ?? null;
    // La referencia del proveedor ya dice el plan programado; un cobro que todavía no lo empieza es del plan de siempre.
    const early = !!sub?.pending_plan_key && result.state?.planKey === sub.pending_plan_key && !startsPendingPlan(sub, result.payment);
    const planKey = (early ? sub!.plan_key : result.state?.planKey) || sub?.plan_key || '';
    if (!account) await logEvent({ level: 'warn', source: 'system', message: `Cobro ${result.payment.paymentId} (${name}) sin cuenta de la plataforma: no se registra` });
    else {
      const saved = await recordPayment({ accountId: account, provider: name, planKey, payment: result.payment });
      if (saved?.fresh) {
        fresh = true;
        await logEvent({ level: 'info', source: 'admin', message: `Pago recibido (${name}): ${result.payment.totalCents / 100} ${result.payment.currency}`, accountId: account });
      }
      // Su factura sale en la siguiente revisión (o entra a la global del mes si no pidió factura). Se prepara aunque el
      // pago ya estuviera registrado: si el proceso murió justo después de registrarlo, el reintento la deja lista (no se
      // duplica). Si falla, el aviso se reintenta.
      if (saved) await queuePaymentCfdi(saved.id);
      // El cobro del monto de un plan al que se subió (Mercado Pago) es el que lo activa.
      if (saved) await promotePendingPlan(account, name, result.payment);
    }
  }
  if (result.refund) {
    const p = await applyRefund(name, result.refund);
    if (p) await logEvent({ level: 'warn', source: 'admin', message: `Reembolso (${name}): pago ${p.status === 'refunded' ? 'reembolsado completo' : 'reembolsado en parte'}`, accountId: p.account_id ?? undefined });
    // El reembolso de un cobro de suscripción (trae su factura) que llegó antes que el cobro: se pide que el proveedor
    // reintente, para no perderlo. Un cargo sin factura no es de una suscripción de la plataforma.
    else if (result.refund.paymentId) throw new RefundBeforePaymentError(result.refund.paymentId);
  }
  return fresh;
}

/** Un reembolso cuyo cobro todavía no llega: el aviso se reintenta (`500`) hasta que esté registrado. */
export class RefundBeforePaymentError extends Error {
  constructor(paymentId: string) {
    super(`Reembolso del cobro ${paymentId}, que todavía no está registrado: se espera el reintento del proveedor`);
  }
}

const fmtDate = (d: Date) => new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

/** Detiene o reanuda los cobros de la suscripción vigente de la cuenta (disputa abierta o ganada); si el proveedor falla, se reintenta sola. */
async function setCollection(provider: ProviderName, accountId: string, pause: boolean) {
  const sub = await getSubscription(accountId);
  if (!sub || sub.provider !== provider || !sub.provider_subscription_id || !['active', 'past_due'].includes(sub.status)) return;
  if (!pause && !sub.collection_paused) return;
  await query(`UPDATE subscriptions SET collection_paused = $2, updated_at = now() WHERE account_id = $1`, [accountId, pause]);
  const kind = pause ? 'pause_collection' : 'resume_collection';
  try {
    await (pause ? providers[provider].pauseCollection(sub.provider_subscription_id) : providers[provider].resumeCollection(sub.provider_subscription_id));
    // La contraria pendiente (si la había) ya no aplica.
    await query(`UPDATE billing_actions SET status = 'done', last_error = 'reemplazada', updated_at = now() WHERE provider = $1 AND ref = $2 AND kind IN ('pause_collection', 'resume_collection') AND status = 'pending'`, [provider, sub.provider_subscription_id]);
    await logEvent({ level: 'info', source: 'admin', message: `${pause ? 'Cobros detenidos' : 'Cobros reanudados'} por la disputa (${provider} ${sub.provider_subscription_id})`, accountId });
  } catch (e: any) {
    await logEvent({ level: 'warn', source: 'admin', message: `No se pudieron ${pause ? 'detener' : 'reanudar'} los cobros (${provider} ${sub.provider_subscription_id}), se reintenta: ${e?.message ?? e}`, accountId });
    await queueAction({ provider, kind, ref: sub.provider_subscription_id, accountId, reason: 'dispute' });
  }
}

/** La tarjeta de una disputa perdida ya no reactiva la cuenta ni da prueba: sus marcas quedan como disputadas (3a.6). */
async function markCardsDisputed(provider: ProviderName, accountId: string, subscriptionId: string) {
  await query(`UPDATE trial_claims SET disputed = true WHERE kind = 'card' AND account_id = $1`, [accountId]);
  if (!subscriptionId) return;
  const st = await providers[provider].subscriptionState(subscriptionId, []).catch(() => null);
  if (!st?.cardKey) return;
  for (const m of await claimMarks({ cardKey: st.cardKey })) {
    await query(
      `INSERT INTO trial_claims (kind, digest, account_id, provider, disputed) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (kind, digest) DO UPDATE SET disputed = true`,
      [m.kind, m.digest, accountId, provider],
    );
  }
}

/**
 * Contracargo (el cliente desconoció un cobro con su banco). Manda el estado que el proveedor da al releer la disputa
 * (PAY-4): un aviso viejo que llega tarde no reabre una disputa ganada o perdida.
 * - abierta: el pago queda en disputa, la cuenta se pausa y los cobros se detienen mientras se resuelve; el superadmin
 *   recibe el enlace para responder;
 * - ganada: los cobros se reanudan, el pago vuelve a la normalidad y la cuenta se reactiva si su plan sigue al corriente;
 * - perdida: el dinero se devolvió al cliente (cuenta como reembolso, con su nota de crédito si había factura), la
 *   suscripción se cancela y la cuenta queda en pausa hasta que pague con otra tarjeta (la de la disputa queda marcada).
 * `fraud`: alerta temprana de fraude (Stripe Radar): el cobro ya se está reembolsando y se trata como perdida (PAY-5).
 * Cada estado se aplica una sola vez aunque el aviso se repita.
 */
export async function applyDispute(provider: ProviderName, d: DisputeInfo, o: { fraud?: boolean } = {}) {
  const refs = d.chargeRefs.filter(Boolean);
  if (!refs.length) return;
  const p = await queryOne<{ id: string; account_id: string | null; total_cents: number; currency: string; paid_at: Date }>(
    `UPDATE billing_payments SET dispute_status = $3, dispute_ref = $4, dispute_checked_at = now(), updated_at = now()
     WHERE id = (SELECT id FROM billing_payments WHERE provider = $1 AND (provider_charge_ref = ANY($2::text[]) OR provider_payment_id = ANY($2::text[])) ORDER BY paid_at DESC LIMIT 1)
       AND dispute_status <> $3
       AND NOT (dispute_ref = $4 AND dispute_status IN ('won', 'lost'))
     RETURNING id, account_id, total_cents, currency, paid_at`,
    [provider, refs, d.status, d.disputeId],
  );
  if (!p) {
    // Un cargo que no es de una suscripción de la plataforma, un aviso repetido o uno viejo de una disputa ya resuelta.
    await logEvent({ level: 'info', source: 'system', message: `Contracargo ${d.disputeId} (${provider}, ${d.status}) sin pago nuevo que actualizar` });
    return;
  }
  const accountId = p.account_id;
  const acc = accountId ? await queryOne<{ name: string; status: string; pause_reason: string }>(`SELECT name, status, pause_reason FROM accounts WHERE id = $1`, [accountId]) : null;
  const name = acc?.name ?? '(cuenta borrada)';
  const what = `${money(p.total_cents, p.currency)} del ${fmtDate(p.paid_at)}`;

  if (d.status === 'open') {
    await logEvent({ level: 'error', source: 'admin', message: `Contracargo abierto (${provider}): cobro de ${what}`, accountId: accountId ?? undefined });
    if (accountId && acc) {
      // Una pausa por falta de pago (o prueba vencida) pasa a ser por la disputa: un pago ya no la quita hasta resolverse.
      const paused = await queryOne(
        `UPDATE accounts SET status = 'paused', paused_at = CASE WHEN status = 'paused' THEN paused_at ELSE now() END, pause_reason = 'dispute', updated_at = now()
         WHERE id = $1 AND (status <> 'paused' OR pause_reason IN ('', 'payment', 'trial')) RETURNING id`, [accountId]);
      await setCollection(provider, accountId, true);
      if (paused && acc.status !== 'paused') {
        await tell(accountId, 'Tu asistente está en pausa',
          `Tu banco nos avisó que desconociste el cobro de tu plan (${what}). Mientras se aclara, el asistente de "${name}" está en pausa y no te haremos más cobros. Si fue un error, avisa a tu banco que reconoces el cargo; en cuanto se resuelva, se reactiva solo.`);
      }
    }
    await alertSuperadmins(accountId, `Contracargo: ${name}`, `"${name}" desconoció con su banco el cobro de ${what}. Su asistente quedó en pausa y sus cobros se detuvieron. Responde la disputa aquí: ${d.url}`, { urgent: true });
    return;
  }

  if (d.status === 'won') {
    await logEvent({ level: 'info', source: 'admin', message: `Contracargo ganado (${provider}): cobro de ${what}`, accountId: accountId ?? undefined });
    if (accountId) await setCollection(provider, accountId, false);
    const sub = accountId ? await getSubscription(accountId) : null;
    const reactivate = !!accountId && acc?.status === 'paused' && acc.pause_reason === 'dispute' && sub?.status === 'active';
    if (reactivate) {
      await query(`UPDATE accounts SET status = 'active', pause_reason = '', updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_reason = 'dispute'`, [accountId]);
      await tell(accountId!, 'Tu asistente volvió a responder', `Se resolvió la aclaración del cobro de ${what} y el asistente de "${name}" volvió a funcionar.`);
    } else if (accountId && acc?.status === 'paused' && acc.pause_reason === 'dispute') {
      // La disputa ya no detiene la cuenta, pero su plan no está al corriente: sigue en pausa como falta de pago y se
      // reactiva sola al pagar (sin esto quedaría en pausa para siempre).
      await query(`UPDATE accounts SET pause_reason = 'payment', updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_reason = 'dispute'`, [accountId]);
    }
    await alertSuperadmins(accountId, `Contracargo ganado: ${name}`, `Se resolvió a tu favor la disputa por el cobro de ${what} de "${name}".${reactivate ? ' Su asistente se reactivó.' : ''}`);
    return;
  }

  // Perdida (o alerta de fraude): el dinero regresa al cliente.
  await logEvent({ level: 'error', source: 'admin', message: o.fraud ? `Alerta de fraude (${provider}): se reembolsa el cobro de ${what} y se cancela la suscripción` : `Contracargo perdido (${provider}): cobro de ${what}`, accountId: accountId ?? undefined });
  await applyRefund(provider, { paymentId: '', chargeRefs: refs, refundedCents: p.total_cents });
  const sub = accountId ? await getSubscription(accountId) : null;
  if (accountId && sub?.provider === provider && sub.provider_subscription_id && ['active', 'past_due'].includes(sub.status)) {
    // Cancelada aquí y encolada en el proveedor a la vez: no puede quedar una sin la otra.
    await query(
      `WITH canceled AS (UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = false, collection_paused = false, updated_at = now() WHERE account_id = $1 RETURNING account_id)
       INSERT INTO billing_actions (provider, kind, ref, account_id, reason) SELECT $2, 'cancel', $3, account_id, $4 FROM canceled
       ON CONFLICT (provider, kind, ref) DO NOTHING`,
      [accountId, provider, sub.provider_subscription_id, o.fraud ? 'fraud_warning' : 'dispute'],
    );
  }
  if (accountId) {
    await markCardsDisputed(provider, accountId, sub?.provider === provider ? sub.provider_subscription_id : '');
    // En pausa hasta pagar con otra tarjeta (la pausa a mano del superadmin se queda como está).
    await query(
      `UPDATE accounts SET status = 'paused', paused_at = CASE WHEN status = 'paused' THEN paused_at ELSE now() END, pause_reason = 'dispute_lost', updated_at = now()
       WHERE id = $1 AND NOT (status = 'paused' AND pause_reason = 'manual')`, [accountId]);
    await tell(accountId, 'Cancelamos tu suscripción', o.fraud
      ? `Tu banco marcó como posible fraude el cobro de ${what}, así que lo reembolsamos y cancelamos la suscripción de "${name}"; su asistente queda en pausa. Si fuiste tú, vuelve a contratar desde Mi plan con otra tarjeta.`
      : `El banco devolvió el cobro de ${what} que desconociste, así que cancelamos la suscripción de "${name}" y su asistente sigue en pausa. Para volver a usarlo, contrata desde Mi plan con otra tarjeta.`);
  }
  await alertSuperadmins(accountId, o.fraud ? `Alerta de fraude: ${name}` : `Contracargo perdido: ${name}`,
    o.fraud
      ? `Stripe avisó posible fraude en el cobro de ${what} de "${name}". Se reembolsó, se canceló su suscripción y la cuenta queda en pausa hasta que pague con otra tarjeta.`
      : `Se perdió la disputa por el cobro de ${what} de "${name}". Se registró como reembolso, su suscripción se canceló y la cuenta queda en pausa hasta que pague con otra tarjeta.`,
    { urgent: !!o.fraud });
}

/** Alerta temprana de fraude: se reembolsa ese cobro (se reintenta solo si falla) y se trata como disputa perdida (PAY-5). */
export async function applyFraudWarning(provider: ProviderName, w: { id: string; chargeRefs: string[] }) {
  const ref = w.chargeRefs.find((r) => !r.startsWith('pi_')) ?? w.chargeRefs[0];
  const known = await queryOne<{ account_id: string | null }>(
    `SELECT account_id FROM billing_payments WHERE provider = $1 AND (provider_charge_ref = ANY($2::text[]) OR provider_payment_id = ANY($2::text[])) LIMIT 1`, [provider, w.chargeRefs]);
  if (!known) {
    await logEvent({ level: 'warn', source: 'system', message: `Alerta de fraude ${w.id} (${provider}) de un cobro que no es de una suscripción de la plataforma` });
    return;
  }
  await queueAction({ provider, kind: 'refund_charge', ref, accountId: known.account_id, reason: 'fraud_warning' });
  await applyDispute(provider, { disputeId: `efw_${w.id}`, chargeRefs: w.chargeRefs, status: 'lost', amountCents: 0, url: `https://dashboard.stripe.com/radar/early-fraud-warnings/${w.id}` }, { fraud: true });
}
