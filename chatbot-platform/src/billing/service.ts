/**
 * Lógica común de cobro: planes, estado de la suscripción de cada cuenta y su efecto en la cuenta
 * (activa, en gracia o pausada). Los proveedores solo informan el estado; aquí se decide qué hacer.
 */
import { mailBrand } from '../brands.js';
import { notifyUsers } from '../automation/store.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { mercadopago } from './mercadopago.js';
import { stripe } from './stripe.js';
import type { BillingProvider, Plan, ProviderName, Subscription, SubscriptionState } from './types.js';

export const providers: Record<ProviderName, BillingProvider> = { stripe, mercadopago };
export const enabledProviders = () => Object.values(providers).filter((p) => p.enabled());

export const listPlans = (all = false) =>
  query<Plan>(`SELECT * FROM plans ${all ? '' : 'WHERE active'} ORDER BY sort_order, price_cents, key`);
export const getPlan = (key: string) => queryOne<Plan>(`SELECT * FROM plans WHERE key = $1`, [key]);
export const getSubscription = (accountId: string) => queryOne<Subscription>(`SELECT * FROM subscriptions WHERE account_id = $1`, [accountId]);

export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100) + ` ${currency}`;

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' }) : '—');

async function admins(accountId: string) {
  return query<{ id: string; email: string; name: string }>(`SELECT id, email, name FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [accountId]);
}

async function tell(accountId: string, title: string, body: string) {
  const list = await admins(accountId);
  await notifyUsers(accountId, list.map((a) => a.id), { title, body, link: '#/plan', kind: 'billing' });
  const mb = await mailBrand(accountId);
  for (const a of list) await sendMail({ fromName: mb.fromName, to: a.email, subject: title, text: `${body}\n\n${mb.base}/#/plan` });
}

export async function recordEvent(provider: string, eventId: string, type: string, accountId: string | null): Promise<boolean> {
  const r = await queryOne<{ event_id: string }>(
    `INSERT INTO billing_events (provider, event_id, type, account_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,
    [provider, eventId, type, accountId],
  );
  return !!r;
}

/** Inicia (o reinicia) el registro de pago de una cuenta antes de mandarla al proveedor. */
export async function beginCheckout(accountId: string, provider: ProviderName, planKey: string) {
  await query(
    `INSERT INTO subscriptions (account_id, provider, plan_key, status) VALUES ($1,$2,$3,'incomplete')
     ON CONFLICT (account_id) DO UPDATE SET provider = $2, plan_key = $3, updated_at = now()
       WHERE subscriptions.status IN ('incomplete', 'canceled')`,
    [accountId, provider, planKey],
  );
}

/**
 * Aplica el estado informado por el proveedor. Idempotente: repetir el mismo estado no repite avisos.
 * Devuelve la cuenta afectada (o null si no se pudo asociar).
 */
export async function applyState(state: SubscriptionState, now = new Date()): Promise<string | null> {
  let accountId = state.accountId;
  if (!accountId) {
    accountId = (await queryOne<{ account_id: string }>(`SELECT account_id FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`, [state.provider, state.subscriptionId]))?.account_id ?? null;
  }
  if (!accountId) return null;
  const acc = await queryOne<{ id: string; name: string; status: string; plan: string }>(`SELECT id, name, status, plan FROM accounts WHERE id = $1`, [accountId]);
  if (!acc) return null;

  const prev = await getSubscription(accountId);
  // Un aviso de una suscripción vieja (ya reemplazada) no debe pisar a la actual.
  if (prev && prev.provider_subscription_id && prev.provider_subscription_id !== state.subscriptionId && prev.provider === state.provider && ['active', 'past_due'].includes(prev.status) && !['active', 'incomplete'].includes(state.status)) return accountId;
  const planKey = state.planKey || prev?.plan_key || '';

  const pastDueSince = state.status === 'past_due' ? prev?.past_due_since ?? now : null;
  // El periodo ya pagado no se pierde si el proveedor no lo informa.
  const periodEnd = state.periodEnd ?? (prev?.provider_subscription_id === state.subscriptionId ? prev.current_period_end : null);
  await query(
    `INSERT INTO subscriptions (account_id, provider, provider_customer_id, provider_subscription_id, plan_key, status, current_period_end, cancel_at_period_end, past_due_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (account_id) DO UPDATE SET provider = $2, provider_customer_id = $3, provider_subscription_id = $4, plan_key = $5, status = $6,
       current_period_end = $7, cancel_at_period_end = $8, past_due_since = $9,
       access_ended_at = CASE WHEN $6 = 'active' THEN NULL ELSE subscriptions.access_ended_at END, updated_at = now()`,
    [accountId, state.provider, state.customerId, state.subscriptionId, planKey, state.status, periodEnd, state.cancelAtPeriodEnd, pastDueSince],
  );

  const was = prev?.provider_subscription_id === state.subscriptionId ? prev.status : 'incomplete';
  const plan = planKey ? await getPlan(planKey) : null;

  if (state.status === 'active') {
    // Cuenta al corriente: se activa (sale de prueba o de pausa) y se anota el plan contratado.
    await query(`UPDATE accounts SET status = 'active', trial_ends_at = NULL, plan = COALESCE(NULLIF($2, ''), plan), updated_at = now() WHERE id = $1`, [accountId, planKey]);
    if (was !== 'active') {
      await logEvent({ level: 'info', source: 'admin', message: `Pago confirmado (${state.provider}): plan ${planKey || '—'}`, accountId });
      await tell(accountId, was === 'past_due' ? 'Recibimos tu pago, ¡gracias!' : '¡Tu plan está activo!', `Tu cuenta "${acc.name}" quedó al corriente${plan ? ` con el plan ${plan.name}` : ''}. Próxima renovación: ${fmt(periodEnd)}.`);
      if (was !== 'past_due') await notifySuperadmins(accountId, `Nueva suscripción: ${acc.name}`, `"${acc.name}" contrató${plan ? ` ${plan.name} (${money(plan.price_cents, plan.currency)})` : ''} por ${state.provider}.`);
    }
  } else if (state.status === 'past_due' && was !== 'past_due') {
    await logEvent({ level: 'warn', source: 'admin', message: `Cobro fallido (${state.provider}): la cuenta tiene ${config.billing.graceDays} días para ponerse al corriente`, accountId });
    await tell(accountId, 'No pudimos cobrar tu plan', `No se pudo procesar el pago de "${acc.name}". Actualiza tu forma de pago en los próximos ${config.billing.graceDays} días para que tu asistente siga respondiendo.`);
    await notifySuperadmins(accountId, `Cobro fallido: ${acc.name}`, `No se pudo cobrar a "${acc.name}" (${state.provider}).`);
  } else if (state.status === 'canceled' && was !== 'canceled') {
    await logEvent({ level: 'info', source: 'admin', message: `Suscripción cancelada (${state.provider})`, accountId });
    const until = periodEnd && periodEnd > now ? ` Tu asistente sigue activo hasta el ${fmt(periodEnd)}.` : '';
    await tell(accountId, 'Tu suscripción se canceló', `La suscripción de "${acc.name}" se canceló.${until} Puedes volver a contratar cuando quieras.`);
    await notifySuperadmins(accountId, `Suscripción cancelada: ${acc.name}`, `"${acc.name}" canceló su plan.`);
    await enforceAccess(now);
  }
  return accountId;
}

/**
 * Pausa las cuentas que ya no tienen derecho a usar el servicio: cobro fallido pasado el periodo de gracia, o
 * suscripción cancelada cuyo periodo pagado terminó. Se aplica una sola vez por caída (`access_ended_at`);
 * si el superadmin reactiva la cuenta a mano, no se vuelve a pausar.
 */
export async function enforceAccess(now = new Date()): Promise<number> {
  const rows = await query<{ account_id: string; name: string; status: string }>(
    `UPDATE subscriptions s SET access_ended_at = $1, updated_at = now() FROM accounts a
     WHERE a.id = s.account_id AND s.access_ended_at IS NULL AND (
       (s.status = 'past_due' AND s.past_due_since <= $1::timestamptz - make_interval(days => $2))
       OR (s.status = 'canceled' AND (s.current_period_end IS NULL OR s.current_period_end <= $1))
     ) RETURNING s.account_id, a.name, s.status`,
    [now, config.billing.graceDays],
  );
  for (const r of rows) {
    await query(`UPDATE accounts SET status = 'paused', updated_at = now() WHERE id = $1 AND status <> 'paused'`, [r.account_id]);
    await logEvent({ level: 'warn', source: 'admin', message: `Cuenta pausada por falta de pago (${r.status})`, accountId: r.account_id });
    await tell(r.account_id, 'Tu asistente está en pausa', `Tu asistente de "${r.name}" se pausó porque el plan no está al corriente. Tu configuración y tus conversaciones se conservan: reactívalo cuando quieras desde Mi plan.`);
    await notifySuperadmins(r.account_id, `Cuenta pausada por pago: ${r.name}`, `"${r.name}" quedó en pausa (${r.status}).`);
  }
  return rows.length;
}

export const billingEnabled = async () => enabledProviders().length > 0 && (await listPlans()).length > 0;
