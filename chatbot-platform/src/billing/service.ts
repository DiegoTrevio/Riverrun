/**
 * Lógica común de cobro: planes, estado de la suscripción de cada cuenta y su efecto en la cuenta
 * (activa, en gracia o pausada). Los proveedores solo informan el estado; aquí se decide qué hacer.
 */
import { HttpError } from '../access.js';
import { mailBrand } from '../brands.js';
import { notifyUsers } from '../automation/store.js';
import { config } from '../config.js';
import { query, withTransaction, queryOne } from '../db.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { LIMIT_LABELS, usageOf } from './limits.js';
import { mercadopago } from './mercadopago.js';
import { stripe } from './stripe.js';
import { chargeCents } from './tax.js';
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

/**
 * Anota el pago que se acaba de abrir: su referencia en el proveedor (para confirmarlo sin esperar el aviso) y, si la
 * cuenta no tiene un plan vigente, el plan y el proveedor elegidos.
 */
export async function beginCheckout(accountId: string, provider: ProviderName, planKey: string, ref = '') {
  await query(
    `INSERT INTO subscriptions (account_id, provider, plan_key, status, checkout_provider, checkout_ref, checkout_at) VALUES ($1,$2,$3,'incomplete',$2,$4,now())
     ON CONFLICT (account_id) DO UPDATE SET checkout_provider = $2, checkout_ref = $4, checkout_at = now(), updated_at = now(),
       provider = CASE WHEN subscriptions.status IN ('incomplete', 'canceled') THEN $2 ELSE subscriptions.provider END,
       plan_key = CASE WHEN subscriptions.status IN ('incomplete', 'canceled') THEN $3 ELSE subscriptions.plan_key END`,
    [accountId, provider, planKey, ref],
  );
}

/** Plan y proveedor con los que se puede pagar ahora. Sin proveedor elegido, el primero disponible para ese plan. */
export async function payable(planKey: string, providerName?: ProviderName): Promise<{ plan: Plan; provider: ProviderName }> {
  const plan = await getPlan(planKey);
  if (!plan || !plan.active) throw new HttpError(404, 'Ese plan no está disponible');
  const options = enabledProviders().filter((p) => p.supportsPlan(plan));
  const provider = providerName ? options.find((p) => p.name === providerName) : options[0];
  if (!provider) throw new HttpError(400, providerName ? `Este plan no se puede pagar con ${providers[providerName].label}` : 'El pago en línea no está disponible por ahora');
  return { plan, provider: provider.name };
}

/**
 * Abre la página de pago del proveedor y anota el pago como pendiente. `base` es la dirección del panel (la principal o
 * el dominio de la marca) a la que vuelve el cliente al pagar o cancelar. Puede lanzar `ProviderError`.
 */
export async function startCheckout(o: { accountId: string; email: string; plan: Plan; provider: ProviderName; base: string; startAt?: Date }): Promise<string> {
  const sub = await getSubscription(o.accountId);
  const { url, ref } = await providers[o.provider].createCheckout({
    accountId: o.accountId, email: o.email, plan: o.plan,
    successUrl: `${o.base}/pago/${o.provider}`, cancelUrl: `${o.base}/pago/${o.provider}?estado=cancelado`,
    customerId: sub?.provider === o.provider ? sub.provider_customer_id || undefined : undefined,
    startAt: o.startAt,
  });
  await beginCheckout(o.accountId, o.provider, o.plan.key, ref);
  await logEvent({ level: 'info', source: 'admin', message: `Pago iniciado: plan ${o.plan.key} con ${o.provider}`, accountId: o.accountId });
  return url;
}

/** Lo que cuesta un plan al mes (los anuales, su doceava parte): para saber si un cambio sube o baja. */
const monthly = (p: Plan) => (p.billing_interval === 'year' ? p.price_cents / 12 : p.price_cents);

/** Suscripción vigente de la cuenta (la que se puede cambiar), o error claro si no hay. */
async function liveSubscription(accountId: string) {
  const sub = await getSubscription(accountId);
  if (!sub?.provider_subscription_id || !['active', 'past_due'].includes(sub.status)) throw new HttpError(400, 'No tienes un plan activo');
  return sub;
}

/**
 * Sustitución (Mercado Pago): una suscripción nueva cuyo primer cobro es al terminar el periodo ya pagado. Al autorizarse
 * reemplaza a la vigente, que se cancela sola (ver `applyStateLocked`). Sirve para cambiar la tarjeta, reanudar tras
 * cancelar y cambiar entre mensual y anual. Devuelve la página de pago.
 */
export async function startReplacement(o: { accountId: string; email: string; plan: Plan; base: string }): Promise<string> {
  const sub = await getSubscription(o.accountId);
  const paidUntil = sub?.status === 'past_due' ? null : sub?.current_period_end ?? null;
  return startCheckout({ ...o, provider: 'mercadopago', startAt: paidUntil && paidUntil > new Date() ? paidUntil : undefined });
}

/**
 * Cambia el plan vigente. Stripe: ya, con prorrateo. Mercado Pago: el nuevo monto desde el siguiente cobro; si cambia el
 * periodo (mensual ↔ anual), por sustitución, y entonces devuelve la página de pago (`url`).
 */
export async function changePlan(o: { accountId: string; email: string; planKey: string; base: string }): Promise<{ url?: string }> {
  const sub = await liveSubscription(o.accountId);
  if (sub.cancel_at_period_end) throw new HttpError(400, 'Tu plan está por cancelarse: primero elige «Mantener mi plan».');
  if (sub.plan_key === o.planKey) throw new HttpError(400, 'Ya tienes ese plan');
  const plan = await getPlan(o.planKey);
  if (!plan?.active) throw new HttpError(404, 'Ese plan no está disponible');
  const from = await getPlan(sub.plan_key);
  const upgrade = !from || monthly(plan) > monthly(from);
  if (!upgrade) await assertFitsPlan(o.accountId, plan);
  if (sub.provider === 'mercadopago' && from && from.billing_interval !== plan.billing_interval) {
    return { url: await startReplacement({ accountId: o.accountId, email: o.email, plan, base: o.base }) };
  }
  const state = await providers[sub.provider].changePlan(sub, plan, { upgrade });
  // El estado se aplica ya (el aviso del proveedor llegará después y no repite nada).
  await applyState({ ...state, accountId: o.accountId, planKey: plan.key });
  const acc = await queryOne<{ name: string }>(`SELECT name FROM accounts WHERE id = $1`, [o.accountId]);
  const effect = sub.provider === 'mercadopago'
    ? `El nuevo precio (${money(chargeCents(plan), plan.currency)} con IVA) aplica desde tu siguiente cobro, el ${fmt(sub.current_period_end)}.`
    : upgrade ? 'Se cobró la diferencia proporcional por lo que queda de tu periodo.' : 'La parte que ya pagaste del plan anterior se descuenta de tu siguiente cobro.';
  await logEvent({ level: 'info', source: 'admin', message: `Cambio de plan (${sub.provider}): ${sub.plan_key || '—'} → ${plan.key}`, accountId: o.accountId });
  await tell(o.accountId, `Cambiaste al plan ${plan.name}`, `Tu cuenta "${acc?.name ?? ''}" ahora tiene el plan ${plan.name}. ${effect}`);
  return {};
}

/** Bajar de plan: la cuenta tiene que caber en los límites del nuevo (salvo los que el superadmin le dio aparte). */
async function assertFitsPlan(accountId: string, plan: Plan) {
  const [acc, used] = await Promise.all([queryOne<{ limits_override: Record<string, unknown> | null }>(`SELECT limits_override FROM accounts WHERE id = $1`, [accountId]), usageOf(accountId)]);
  const over = (['channels', 'users', 'chatbots', 'social_accounts'] as const).filter((k) => {
    const max = plan.limits?.[k];
    return typeof max === 'number' && max > 0 && acc?.limits_override?.[k] == null && used[k] > max;
  });
  if (over.length) {
    const list = over.map((k) => `${used[k]} ${LIMIT_LABELS[k].plural} (el plan ${plan.name} permite ${plan.limits[k]})`).join(', ');
    throw new HttpError(409, `Para cambiar al plan ${plan.name} primero ajusta tu cuenta: tienes ${list}.`);
  }
}

/**
 * Confirma el último pago iniciado preguntándole al proveedor: al volver de la página de pago y en la revisión periódica.
 * Así la cuenta se activa aunque el aviso del proveedor (webhook) tarde o no llegue. Solo aplica pagos ya confirmados;
 * cobros fallidos y cancelaciones los siguen informando los avisos. Devuelve true si el pago quedó confirmado (ahora o
 * antes, por el aviso).
 */
export async function confirmCheckout(accountId: string): Promise<boolean> {
  const sub = await getSubscription(accountId);
  if (!sub?.checkout_ref || !sub.checkout_provider) return false;
  const provider = providers[sub.checkout_provider];
  if (!provider.enabled()) return false;
  const state = await provider.checkoutState(sub.checkout_ref, await listPlans(true));
  if (!state || state.status !== 'active' || state.accountId !== accountId) return false;
  // Si el aviso ya aplicó esta suscripción, no se vuelve a aplicar: Mercado Pago la sigue mostrando "autorizada" mientras
  // reintenta un cobro rechazado, y aplicarla de nuevo desharía ese aviso (la cuenta volvería a activa).
  const applied = sub.provider === state.provider && sub.provider_subscription_id === state.subscriptionId && sub.status !== 'incomplete';
  if (!applied) await applyState(state);
  await query(`UPDATE subscriptions SET checkout_ref = '' WHERE account_id = $1 AND checkout_ref = $2`, [accountId, sub.checkout_ref]);
  return true;
}

/** Revisión periódica: confirma los pagos iniciados en los últimos 2 días que todavía no se reflejan en la cuenta. */
export async function syncPendingCheckouts(now = new Date()): Promise<number> {
  const rows = await query<{ account_id: string }>(
    `SELECT account_id FROM subscriptions WHERE checkout_ref <> '' AND checkout_at > $1::timestamptz - interval '2 days'`,
    [now],
  );
  let applied = 0;
  for (const r of rows) {
    try {
      if (await confirmCheckout(r.account_id)) applied++;
    } catch (e: any) {
      await logEvent({ level: 'warn', source: 'system', message: `No se pudo consultar un pago pendiente: ${e?.message ?? e}`, accountId: r.account_id });
    }
  }
  return applied;
}

/**
 * Aplica el estado informado por el proveedor. Idempotente: repetir el mismo estado no repite avisos.
 * Devuelve la cuenta afectada (o null si no se pudo asociar).
 */
export async function applyState(state: SubscriptionState, now = new Date()): Promise<string | null> {
  // Los avisos de un mismo cambio llegan casi juntos (p. ej. checkout y suscripción creada): se procesan uno a la vez
  // para que los correos y avisos no se dupliquen.
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('billing-apply'))`);
    return applyStateLocked(state, now);
  });
}

async function applyStateLocked(state: SubscriptionState, now: Date): Promise<string | null> {
  let accountId = state.accountId;
  if (!accountId) {
    accountId = (await queryOne<{ account_id: string }>(`SELECT account_id FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`, [state.provider, state.subscriptionId]))?.account_id ?? null;
  }
  if (!accountId) return null;
  const acc = await queryOne<{ id: string; name: string; status: string; plan: string }>(`SELECT id, name, status, plan FROM accounts WHERE id = $1`, [accountId]);
  if (!acc) return null;

  const prev = await getSubscription(accountId);
  // Sustitución pedida desde el panel (cambiar tarjeta, reanudar, mensual ↔ anual): la nueva es el pago iniciado.
  const replacing = !!prev?.checkout_ref && prev.checkout_provider === state.provider && prev.checkout_ref === state.subscriptionId
    && !!prev.provider_subscription_id && prev.provider_subscription_id !== state.subscriptionId && state.status === 'active';
  // Un aviso de una suscripción vieja (ya reemplazada) no debe pisar a la actual.
  if (prev && prev.provider_subscription_id && prev.provider_subscription_id !== state.subscriptionId && prev.provider === state.provider && ['active', 'past_due'].includes(prev.status) && !['active', 'incomplete'].includes(state.status)) return accountId;
  // Una segunda suscripción pagada mientras la vigente sigue cobrando (p. ej. dos pestañas de pago): se conserva la vigente
  // y se avisa al superadmin, una sola vez, para que cancele y reembolse la otra. Sin esto se cobraría dos veces sin que nadie lo note.
  if (!replacing && state.status === 'active' && prev?.provider_subscription_id && ['active', 'past_due'].includes(prev.status) && !prev.cancel_at_period_end
    && (prev.provider !== state.provider || prev.provider_subscription_id !== state.subscriptionId)) {
    // Si la otra ya se cancela al final de su periodo (un plan reemplazado), no seguirá cobrando: solo se ignora.
    if (!state.cancelAtPeriodEnd && await recordEvent(state.provider, `duplicate:${state.subscriptionId}`, 'duplicate_subscription', accountId)) {
      await logEvent({ level: 'error', source: 'admin', message: `Suscripción duplicada (${state.provider} ${state.subscriptionId}): la cuenta ya paga ${prev.provider} ${prev.provider_subscription_id}`, accountId });
      await notifySuperadmins(accountId, `Cobro duplicado: ${acc.name}`,
        `"${acc.name}" tiene dos suscripciones cobrando: ${prev.provider} ${prev.provider_subscription_id} (la vigente) y ${state.provider} ${state.subscriptionId}. Cancela y reembolsa la segunda desde ${providers[state.provider].label}.`);
    }
    return accountId;
  }
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

  // Una sustitución no es una contratación nueva: sigue del estado en que estaba (al corriente o con pago pendiente).
  const was = prev?.provider_subscription_id === state.subscriptionId || (replacing && ['active', 'past_due'].includes(prev!.status)) ? prev!.status : 'incomplete';
  const plan = planKey ? await getPlan(planKey) : null;

  if (replacing && prev) {
    // La anterior deja de cobrar. Si ya estaba cancelada (reanudar tras cancelar), no hay nada que hacer.
    if (['active', 'past_due'].includes(prev.status) && !prev.cancel_at_period_end) {
      try {
        await providers[prev.provider].setCancelAtPeriodEnd(prev, true);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'admin', message: `No se pudo cancelar la suscripción sustituida ${prev.provider_subscription_id}: ${e?.message ?? e}`, accountId });
        await notifySuperadmins(accountId, `Cancelar suscripción sustituida: ${acc.name}`,
          `"${acc.name}" cambió su forma de pago, pero no se pudo cancelar la suscripción anterior (${prev.provider} ${prev.provider_subscription_id}). Cancélala a mano en ${providers[prev.provider].label} para que no cobre dos veces.`);
      }
    }
    await logEvent({ level: 'info', source: 'admin', message: `Suscripción sustituida (${state.provider}): ${prev.provider_subscription_id} → ${state.subscriptionId}`, accountId });
    if (was === 'active') await tell(accountId, 'Actualizamos tu plan', `Tu cuenta "${acc.name}" sigue al corriente${plan ? ` con el plan ${plan.name}` : ''} y con tu nueva forma de pago. Próximo cobro: ${fmt(periodEnd)}.`);
  }

  if (state.status === 'active') {
    // Cuenta al corriente: se activa (sale de prueba o de pausa) y se anota el plan contratado.
    // Solo al pasar a "al corriente" se reactiva la cuenta: una renovación mensual no deshace una pausa manual del superadmin.
    await query(
      `UPDATE accounts SET status = CASE WHEN $3::boolean THEN 'active' ELSE status END, trial_ends_at = CASE WHEN $3::boolean THEN NULL ELSE trial_ends_at END,
         plan = COALESCE(NULLIF($2, ''), plan), updated_at = now() WHERE id = $1`,
      [accountId, planKey, was !== 'active'],
    );
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
