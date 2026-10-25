/**
 * Cobro sin intervención: lo que corre solo en la revisión periódica para que nadie tenga que vigilar los pagos.
 * - Acciones pendientes en el proveedor (cancelar, reembolsar), reintentadas hasta lograrlo.
 * - Conciliación diaria: cada suscripción vigente se compara con el proveedor; si un aviso se perdió, el estado y los
 *   cobros que faltan se aplican igual que si hubiera llegado (con sus correos, su factura y su pausa o reactivación).
 */
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { alertSuperadmins, recordMoney } from './ledger.js';
import { applyState, listPlans, providers, recordEvent, tell } from './service.js';
import { ProviderError, type ProviderName, type Subscription } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Espera entre intentos de una acción (el último se repite). */
const BACKOFF = [5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR, DAY];
export const MAX_ACTION_ATTEMPTS = 8;
/** Marcas internas que se guardan en billing_events para no repetir avisos: no son avisos del proveedor. */
export const INTERNAL_EVENT_TYPES = ['duplicate_subscription', 'reconcile_missing', 'webhook_silence', 'reconcile_fixed'];
/** Días sin ningún aviso de un proveedor que tiene suscripciones: más que un ciclo mensual (en uno normal llega al menos la renovación). */
export const SILENCE_DAYS = 35;
const weekOf = (d: Date) => Math.floor(d.getTime() / (7 * DAY));

interface Action {
  id: string;
  provider: ProviderName;
  kind: 'cancel' | 'refund_subscription';
  ref: string;
  account_id: string | null;
  reason: string;
  attempts: number;
}

const WHAT: Record<string, string> = {
  duplicate: 'una suscripción duplicada',
  replaced: 'la suscripción anterior a un cambio de forma de pago',
  unpaid: 'una suscripción sin pago',
  deleted: 'la suscripción de una cuenta borrada',
  dispute: 'una suscripción con un contracargo perdido',
};

/** Hace las acciones pendientes cuyo turno llegó. Devuelve cuántas se completaron. */
export async function processBillingActions(now = new Date()): Promise<number> {
  // Se reservan unos minutos: si el proceso muere a la mitad, otra revisión las retoma.
  const rows = await query<Action>(
    `UPDATE billing_actions SET attempts = attempts + 1, next_attempt_at = $1::timestamptz + interval '10 minutes', updated_at = now()
     WHERE id IN (SELECT id FROM billing_actions WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING id, provider, kind, ref, account_id, reason, attempts`,
    [now],
  );
  let done = 0;
  for (const a of rows) {
    const p = providers[a.provider];
    if (!p.enabled()) {
      // Sin credenciales no se puede: se espera sin gastar el intento.
      await query(`UPDATE billing_actions SET attempts = attempts - 1, next_attempt_at = $2::timestamptz + interval '1 hour' WHERE id = $1`, [a.id, now]);
      continue;
    }
    try {
      let refunded = 0;
      if (a.kind === 'cancel') await p.cancelNow(a.ref);
      else {
        // Todos sus cobros (una duplicada no lleva mucho tiempo cobrando).
        for (const pay of await p.recentPayments(a.ref, new Date(now.getTime() - 400 * DAY))) {
          if (!pay.chargeRef) continue;
          await p.refund(pay.chargeRef);
          refunded += pay.totalCents;
        }
      }
      await query(`UPDATE billing_actions SET status = 'done', last_error = '', updated_at = now() WHERE id = $1`, [a.id]);
      done++;
      await logEvent({ level: 'info', source: 'admin', message: `${a.kind === 'cancel' ? 'Cancelada' : 'Reembolsada'} ${WHAT[a.reason] ?? 'una suscripción'} (${a.provider} ${a.ref})`, accountId: a.account_id ?? undefined });
      if (a.kind === 'refund_subscription' && a.reason === 'duplicate' && a.account_id) {
        if (refunded > 0) await tell(a.account_id, 'Te devolvimos un cobro doble', 'Detectamos que tu plan se cobró dos veces y reembolsamos el cobro de más. Puede tardar unos días en reflejarse en tu tarjeta. Tu plan sigue igual.');
        await alertSuperadmins(a.account_id, 'Cobro duplicado resuelto', `Se canceló la suscripción duplicada ${a.provider} ${a.ref}${refunded > 0 ? ' y se reembolsó su cobro' : ''}. No hay nada que hacer.`);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 500);
      if (a.attempts >= MAX_ACTION_ATTEMPTS) {
        await query(`UPDATE billing_actions SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [a.id, msg]);
        await logEvent({ level: 'error', source: 'admin', message: `No se pudo ${a.kind === 'cancel' ? 'cancelar' : 'reembolsar'} ${WHAT[a.reason] ?? 'una suscripción'} tras ${a.attempts} intentos: ${msg}`, accountId: a.account_id ?? undefined });
        await alertSuperadmins(a.account_id, a.kind === 'cancel' ? 'Cancela una suscripción a mano' : 'Reembolsa un cobro a mano',
          `No se pudo ${a.kind === 'cancel' ? 'cancelar' : 'reembolsar los cobros de'} ${WHAT[a.reason] ?? 'una suscripción'} (${a.provider} ${a.ref}) tras ${a.attempts} intentos: ${msg}. Hazlo desde ${p.label} para que no se cobre de más.`, { urgent: true });
      } else {
        const wait = BACKOFF[Math.min(a.attempts - 1, BACKOFF.length - 1)];
        await query(`UPDATE billing_actions SET last_error = $2, next_attempt_at = $3, updated_at = now() WHERE id = $1`, [a.id, msg, new Date(now.getTime() + wait)]);
      }
    }
  }
  return done;
}

/** Suscripciones que vale la pena comparar: las que cobran o las canceladas con acceso todavía vigente. */
const RECONCILABLE = `provider_subscription_id <> '' AND (status IN ('active', 'past_due') OR (status = 'canceled' AND current_period_end > $1::timestamptz - interval '2 days'))`;

/**
 * Conciliación: cada suscripción se compara con el proveedor una vez al día (unas pocas por vuelta, para repartirlas).
 * Lo que el proveedor dice manda: el estado se aplica con `applyState` (idempotente: si nada cambió, no pasa nada) y los
 * cobros que no se habían registrado se registran (con su factura).
 */
export async function reconcileSubscriptions(now = new Date()): Promise<{ checked: number; fixed: number; failed: number }> {
  const subs = await query<Subscription>(
    `UPDATE subscriptions SET reconciled_at = $1 WHERE account_id IN (
       SELECT account_id FROM subscriptions WHERE ${RECONCILABLE} AND (reconciled_at IS NULL OR reconciled_at <= $1::timestamptz - interval '20 hours')
       ORDER BY reconciled_at NULLS FIRST LIMIT 50 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [now],
  );
  const result = { checked: 0, fixed: 0, failed: 0 };
  if (!subs.length) return result;
  const plans = await listPlans(true);
  /** Por proveedor: correcciones que solo pasan si un aviso no llegó (cobros que faltaban, o un cambio de Stripe). */
  const missed: Partial<Record<ProviderName, number>> = {};
  for (const sub of subs) {
    const p = providers[sub.provider];
    if (!p.enabled()) continue;
    result.checked++;
    try {
      const state = await p.subscriptionState(sub.provider_subscription_id, plans, now);
      if (!state.accountId) state.accountId = sub.account_id;
      const payments = await p.recentPayments(sub.provider_subscription_id, new Date(now.getTime() - 45 * DAY));
      await applyState(state, now);
      let newPayments = 0;
      for (const payment of payments) {
        if (await recordMoney(sub.provider, { payment, state }, sub.account_id)) newPayments++;
      }
      const after = await queryOne<{ status: string }>(`SELECT status FROM subscriptions WHERE account_id = $1`, [sub.account_id]);
      const moved = after?.status !== sub.status;
      if (moved || newPayments) {
        result.fixed++;
        const parts = [moved ? `estado ${sub.status} → ${after?.status}` : '', newPayments ? `${newPayments} cobro(s) que no habían llegado` : ''].filter(Boolean);
        await logEvent({ level: 'warn', source: 'admin', message: `Conciliación con ${p.label}: ${parts.join('; ')}`, accountId: sub.account_id });
        // En Mercado Pago un cobro rechazado puede no traer aviso de cambio de estado: eso no indica un webhook roto.
        if (newPayments || (moved && sub.provider === 'stripe')) missed[sub.provider] = (missed[sub.provider] ?? 0) + 1;
      }
    } catch (e: any) {
      result.failed++;
      if (e instanceof ProviderError && e.status === 404) {
        // La suscripción ya no existe en el proveedor: no se corrige sola, hay que revisarla (se avisa una vez).
        if (await recordEvent(sub.provider, `reconcile-missing:${sub.provider_subscription_id}`, 'reconcile_missing', sub.account_id)) {
          await alertSuperadmins(sub.account_id, 'Suscripción que no existe en el proveedor', `La suscripción ${sub.provider} ${sub.provider_subscription_id} ya no existe en ${p.label}, pero aquí sigue como "${sub.status}". Revisa en ${p.label} si se borró y corrígela a mano.`, { urgent: true });
        }
      } else {
        // Red o proveedor caído: se reintenta en la siguiente hora, no hasta mañana.
        await query(`UPDATE subscriptions SET reconciled_at = $2::timestamptz - interval '19 hours' WHERE account_id = $1`, [sub.account_id, now]);
      }
      await logEvent({ level: 'warn', source: 'system', message: `Conciliación con ${p.label}: ${e?.message ?? e}`, accountId: sub.account_id });
    }
  }
  // Ya quedó corregido, pero si se repite el webhook está mal configurado: se avisa una vez por semana y proveedor.
  for (const [name, n] of Object.entries(missed) as [ProviderName, number][]) {
    if (!(await recordEvent(name, `reconcile-fixed:${weekOf(now)}`, 'reconcile_fixed', null))) continue;
    await alertSuperadmins(null, `${providers[name].label}: avisos que no llegaron`,
      `La revisión diaria tuvo que corregir ${n} suscripción(es) de ${providers[name].label} cuyo aviso no llegó (cobros o cambios). Ya quedaron bien, pero revisa que el webhook esté configurado con todos los eventos (en Planes y cobro están la dirección y la lista).`);
  }
  return result;
}

/**
 * Avisos que no llegan: si un proveedor tiene suscripciones de más de un ciclo y en `SILENCE_DAYS` días no mandó ningún
 * aviso (ni siquiera una renovación), lo más probable es que el webhook no esté configurado. La conciliación cubre los
 * cobros, pero conviene corregirlo. Una vez por semana.
 */
export async function checkWebhookSilence(now = new Date()): Promise<string[]> {
  const silent: string[] = [];
  for (const name of Object.keys(providers) as ProviderName[]) {
    const p = providers[name];
    if (!p.enabled()) continue;
    const r = await queryOne<{ live: number; last: Date | null }>(
      `SELECT (SELECT count(*)::int FROM subscriptions WHERE provider = $1 AND status IN ('active', 'past_due') AND provider_subscription_id <> '' AND created_at < $2::timestamptz - make_interval(days => $4)) AS live,
              (SELECT max(received_at) FROM billing_events WHERE provider = $1 AND type <> ALL($3::text[])) AS last`,
      [name, now, INTERNAL_EVENT_TYPES, SILENCE_DAYS],
    );
    if (!r?.live || (r.last && new Date(r.last).getTime() > now.getTime() - SILENCE_DAYS * DAY)) continue;
    if (!(await recordEvent(name, `webhook-silence:${weekOf(now)}`, 'webhook_silence', null))) continue;
    silent.push(name);
    await alertSuperadmins(null, `${p.label} no está mandando avisos`,
      `Hay ${r.live} suscripciones con ${p.label} y en ${SILENCE_DAYS} días no llegó ningún aviso de pago${r.last ? ` (el último fue el ${new Date(r.last).toISOString().slice(0, 10)})` : ''}. La revisión diaria corrige los cobros, pero revisa que el webhook esté configurado en ${p.label} (en Planes y cobro están la dirección y los eventos).`, { urgent: true });
  }
  return silent;
}
