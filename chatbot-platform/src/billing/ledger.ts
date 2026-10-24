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
import { getSubscription, money, queueAction, tell } from './service.js';
import type { DisputeInfo, ProviderName, WebhookResult } from './types.js';

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
    const sub = await queryOne<{ account_id: string; plan_key: string }>(
      `SELECT account_id, plan_key FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`, [name, result.payment.subscriptionId]);
    const account = accountId ?? sub?.account_id ?? null;
    const planKey = result.state?.planKey || sub?.plan_key || '';
    if (!account) await logEvent({ level: 'warn', source: 'system', message: `Cobro ${result.payment.paymentId} (${name}) sin cuenta de la plataforma: no se registra` });
    else {
      const paymentId = await recordPayment({ accountId: account, provider: name, planKey, payment: result.payment });
      if (paymentId) {
        fresh = true;
        await logEvent({ level: 'info', source: 'admin', message: `Pago recibido (${name}): ${result.payment.totalCents / 100} ${result.payment.currency}`, accountId: account });
        // Su factura sale en la siguiente revisión (o entra a la global del mes si no pidió factura). Un fallo aquí no
        // debe devolver el aviso: el pago ya quedó y un reintento del proveedor no lo volvería a ver como nuevo.
        await queuePaymentCfdi(paymentId).catch((e) => logEvent({ level: 'error', source: 'admin', message: `No se pudo preparar la factura del pago ${result.payment!.paymentId}: ${e?.message ?? e}`, accountId: account }));
      }
    }
  }
  if (result.refund) {
    const p = await applyRefund(name, result.refund);
    if (p) await logEvent({ level: 'warn', source: 'admin', message: `Reembolso (${name}): pago ${p.status === 'refunded' ? 'reembolsado completo' : 'reembolsado en parte'}`, accountId: p.account_id ?? undefined });
  }
  return fresh;
}

const fmtDate = (d: Date) => new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

/**
 * Contracargo (el cliente desconoció un cobro con su banco):
 * - abierto: el pago queda en disputa y la cuenta se pausa mientras se resuelve; el superadmin recibe el enlace para responder;
 * - ganado: el pago vuelve a la normalidad y la cuenta se reactiva si su plan sigue al corriente;
 * - perdido: el dinero se devolvió al cliente (cuenta como reembolso, con su nota de crédito si había factura) y la
 *   suscripción se cancela; la cuenta sigue en pausa.
 * Cada estado se aplica una sola vez aunque el aviso se repita.
 */
export async function applyDispute(provider: ProviderName, d: DisputeInfo) {
  const refs = d.chargeRefs.filter(Boolean);
  if (!refs.length) return;
  const p = await queryOne<{ id: string; account_id: string | null; total_cents: number; currency: string; paid_at: Date }>(
    `UPDATE billing_payments SET dispute_status = $3, dispute_ref = $4, updated_at = now()
     WHERE id = (SELECT id FROM billing_payments WHERE provider = $1 AND (provider_charge_ref = ANY($2::text[]) OR provider_payment_id = ANY($2::text[])) ORDER BY paid_at DESC LIMIT 1)
       AND dispute_status <> $3
     RETURNING id, account_id, total_cents, currency, paid_at`,
    [provider, refs, d.status, d.disputeId],
  );
  if (!p) {
    // Un cargo que no es de una suscripción de la plataforma, o un aviso repetido.
    await logEvent({ level: 'info', source: 'system', message: `Contracargo ${d.disputeId} (${provider}, ${d.status}) sin pago nuevo que actualizar` });
    return;
  }
  const accountId = p.account_id;
  const acc = accountId ? await queryOne<{ name: string; status: string; pause_reason: string }>(`SELECT name, status, pause_reason FROM accounts WHERE id = $1`, [accountId]) : null;
  const name = acc?.name ?? '(cuenta borrada)';
  const what = `${money(p.total_cents, p.currency)} del ${fmtDate(p.paid_at)}`;

  if (d.status === 'open') {
    await logEvent({ level: 'error', source: 'admin', message: `Contracargo abierto (${provider}): cobro de ${what}`, accountId: accountId ?? undefined });
    if (accountId && acc && acc.status !== 'paused') {
      await query(`UPDATE accounts SET status = 'paused', paused_at = now(), pause_reason = 'dispute', updated_at = now() WHERE id = $1 AND status <> 'paused'`, [accountId]);
      await tell(accountId, 'Tu asistente está en pausa',
        `Tu banco nos avisó que desconociste el cobro de tu plan (${what}). Mientras se aclara, el asistente de "${name}" está en pausa. Si fue un error, avisa a tu banco que reconoces el cargo; en cuanto se resuelva, se reactiva solo.`);
    }
    await alertSuperadmins(accountId, `Contracargo: ${name}`, `"${name}" desconoció con su banco el cobro de ${what}. Su asistente quedó en pausa. Responde la disputa aquí: ${d.url}`, { urgent: true });
    return;
  }

  if (d.status === 'won') {
    await logEvent({ level: 'info', source: 'admin', message: `Contracargo ganado (${provider}): cobro de ${what}`, accountId: accountId ?? undefined });
    const sub = accountId ? await getSubscription(accountId) : null;
    const reactivate = !!accountId && acc?.status === 'paused' && acc.pause_reason === 'dispute' && sub?.status === 'active';
    if (reactivate) {
      await query(`UPDATE accounts SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_reason = 'dispute'`, [accountId]);
      await tell(accountId!, 'Tu asistente volvió a responder', `Se resolvió la aclaración del cobro de ${what} y el asistente de "${name}" volvió a funcionar.`);
    } else if (accountId && acc?.status === 'paused' && acc.pause_reason === 'dispute') {
      // La disputa ya no detiene la cuenta, pero su plan no está al corriente: sigue en pausa como falta de pago y se
      // reactiva sola al pagar (sin esto quedaría en pausa para siempre).
      await query(`UPDATE accounts SET pause_reason = 'payment', updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_reason = 'dispute'`, [accountId]);
    }
    await alertSuperadmins(accountId, `Contracargo ganado: ${name}`, `Se resolvió a tu favor la disputa por el cobro de ${what} de "${name}".${reactivate ? ' Su asistente se reactivó.' : ''}`);
    return;
  }

  // Perdido: el dinero ya regresó al cliente.
  await logEvent({ level: 'error', source: 'admin', message: `Contracargo perdido (${provider}): cobro de ${what}`, accountId: accountId ?? undefined });
  await applyRefund(provider, { paymentId: '', chargeRefs: refs, refundedCents: p.total_cents });
  const sub = accountId ? await getSubscription(accountId) : null;
  if (accountId && sub?.provider === provider && sub.provider_subscription_id && ['active', 'past_due'].includes(sub.status)) {
    await query(`UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = false, updated_at = now() WHERE account_id = $1`, [accountId]);
    await queueAction({ provider, kind: 'cancel', ref: sub.provider_subscription_id, accountId, reason: 'dispute' });
  }
  if (accountId) {
    await tell(accountId, 'Cancelamos tu suscripción',
      `El banco devolvió el cobro de ${what} que desconociste, así que cancelamos la suscripción de "${name}" y su asistente sigue en pausa. Puedes volver a contratar cuando quieras desde Mi plan.`);
  }
  await alertSuperadmins(accountId, `Contracargo perdido: ${name}`, `Se perdió la disputa por el cobro de ${what} de "${name}". Se registró como reembolso y su suscripción se canceló.`);
}
