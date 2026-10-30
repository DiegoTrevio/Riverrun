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
import { sendMailDurable } from '../mail-retry.js';
import { keptNote } from '../accounts/retention.js';
import { LIMIT_LABELS, usageOf } from './limits.js';
import { mercadopago } from './mercadopago.js';
import { stripe } from './stripe.js';
import { startTrialFromState } from './card-check.js';
import { chargeCents } from './tax.js';
import type { BillingProvider, PaymentInfo, Plan, ProviderName, Subscription, SubscriptionState } from './types.js';

export const providers: Record<ProviderName, BillingProvider> = { stripe, mercadopago };
export const enabledProviders = () => Object.values(providers).filter((p) => p.enabled());

export const listPlans = (all = false) =>
  query<Plan>(`SELECT * FROM plans ${all ? '' : 'WHERE active'} ORDER BY sort_order, price_cents, key`);
export const getPlan = (key: string) => queryOne<Plan>(`SELECT * FROM plans WHERE key = $1`, [key]);
export const getSubscription = (accountId: string) => queryOne<Subscription>(`SELECT * FROM subscriptions WHERE account_id = $1`, [accountId]);

export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100) + ` ${currency}`;

export const fmt = (d: Date | null) => (d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' }) : '—');

async function admins(accountId: string) {
  return query<{ id: string; email: string; name: string }>(`SELECT id, email, name FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [accountId]);
}

/** Avisa a los administradores de la cuenta: notificación en el panel y correo, con el enlace a Mi plan. */
export async function tell(accountId: string, title: string, body: string) {
  const list = await admins(accountId);
  await notifyUsers(accountId, list.map((a) => a.id), { title, body, link: '#/plan', kind: 'billing' });
  const mb = await mailBrand(accountId);
  // Si el servidor de correo falla, el correo se reintenta solo (el aviso del panel ya quedó y no se repite).
  for (const a of list) await sendMailDurable({ fromName: mb.fromName, to: a.email, subject: title, text: `${body}\n\n${mb.base}/#/plan` }, accountId);
}

/** Marca interna de una sola vez (p. ej. «ya se avisó de este duplicado»). Devuelve true la primera vez. */
export async function recordEvent(provider: string, eventId: string, type: string, accountId: string | null): Promise<boolean> {
  const r = await queryOne<{ event_id: string }>(
    `INSERT INTO billing_events (provider, event_id, type, account_id, processed_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING RETURNING event_id`,
    [provider, eventId, type, accountId],
  );
  return !!r;
}

/** Minutos que se respeta la reserva de un aviso: pasado eso, se da por muerto el proceso que lo tomó. */
export const EVENT_CLAIM_MINUTES = 10;

/**
 * Reserva un aviso del proveedor para procesarlo. `claimed`: hay que procesarlo (es nuevo, o quedó a medias porque el
 * proceso que lo tomó murió); `done`: ya se procesó; `busy`: otro proceso lo está procesando ahora mismo.
 */
export async function claimEvent(provider: string, eventId: string, type: string): Promise<{ status: 'claimed'; token: string; receivedAt: Date } | { status: 'done' } | { status: 'busy' }> {
  const r = await queryOne<{ claim_token: string; received_at: Date }>(
    `INSERT INTO billing_events (provider, event_id, type, claimed_at, claim_token, processed_at) VALUES ($1,$2,$3,now(),gen_random_uuid(),NULL)
     ON CONFLICT (provider, event_id) DO UPDATE SET claimed_at = now(), claim_token = gen_random_uuid()
       WHERE billing_events.processed_at IS NULL AND (billing_events.claimed_at IS NULL OR billing_events.claimed_at < now() - make_interval(mins => $4))
     RETURNING claim_token, received_at`,
    [provider, eventId, type, EVENT_CLAIM_MINUTES],
  );
  if (r) return { status: 'claimed', token: r.claim_token, receivedAt: r.received_at };
  const row = await queryOne<{ processed_at: Date | null }>(`SELECT processed_at FROM billing_events WHERE provider = $1 AND event_id = $2`, [provider, eventId]);
  return row?.processed_at ? { status: 'done' } : { status: 'busy' };
}

/** El aviso quedó procesado: un reintento del proveedor ya no lo repite. Solo quien tiene la reserva lo cierra. */
export async function finishEvent(provider: string, eventId: string, token: string, accountId: string | null) {
  await query(
    `UPDATE billing_events SET processed_at = now(), claimed_at = NULL, claim_token = NULL, account_id = COALESCE($4, account_id)
     WHERE provider = $1 AND event_id = $2 AND claim_token = $3`,
    [provider, eventId, token, accountId],
  );
}

/** El aviso falló: se libera para que el reintento del proveedor lo procese desde el principio (si nadie más lo retomó). */
export async function releaseEvent(provider: string, eventId: string, token: string) {
  await query(
    `UPDATE billing_events SET claimed_at = NULL, claim_token = NULL WHERE provider = $1 AND event_id = $2 AND claim_token = $3 AND processed_at IS NULL`,
    [provider, eventId, token],
  );
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
export async function startCheckout(o: CheckoutStart): Promise<string> {
  return (await createCheckoutSession(o)).url;
}

type CheckoutStart = { accountId: string; email: string; plan: Plan; provider: ProviderName; base: string; startAt?: Date; trialDays?: number };

/**
 * La página de pago y su referencia. `trialDays`: verificación de tarjeta con prueba gratis (el primer cobro, en esos
 * días); sin eso, quien paga durante una prueba de las de antes la conserva hasta su fin.
 */
export async function createCheckoutSession(o: CheckoutStart): Promise<{ url: string; ref: string }> {
  const sub = await getSubscription(o.accountId);
  const trialEnd = o.startAt || o.trialDays ? undefined : await trialLeft(o.accountId);
  const firstCharge = o.trialDays ? new Date(Date.now() + o.trialDays * 86400_000) : trialEnd;
  const { url, ref } = await providers[o.provider].createCheckout({
    accountId: o.accountId, email: o.email, plan: o.plan,
    successUrl: `${o.base}/pago/${o.provider}`, cancelUrl: `${o.base}/pago/${o.provider}?estado=cancelado`,
    customerId: sub?.provider === o.provider ? sub.provider_customer_id || undefined : undefined,
    // Quien contrata durante su prueba no la pierde: la tarjeta queda registrada hoy y el primer cobro es al terminar.
    startAt: o.startAt ?? (o.provider === 'mercadopago' ? firstCharge : undefined),
    trialEnd: o.provider === 'stripe' ? trialEnd : undefined,
    trialDays: o.provider === 'stripe' ? o.trialDays : undefined,
  });
  await beginCheckout(o.accountId, o.provider, o.plan.key, ref);
  await logEvent({ level: 'info', source: 'admin', message: `Pago iniciado: plan ${o.plan.key} con ${o.provider}${o.trialDays ? ` (${o.trialDays} días de prueba)` : ''}`, accountId: o.accountId });
  return { url, ref };
}

/**
 * Fin de la prueba que le queda a la cuenta, si todavía le quedan más de 2 días (Stripe no acepta un periodo de prueba
 * más corto). Sin prueba o casi vencida, el cobro es inmediato.
 */
async function trialLeft(accountId: string, now = Date.now()): Promise<Date | undefined> {
  const acc = await queryOne<{ status: string; trial_ends_at: Date | null }>(`SELECT status, trial_ends_at FROM accounts WHERE id = $1`, [accountId]);
  if (acc?.status !== 'trial' || !acc.trial_ends_at) return undefined;
  return new Date(acc.trial_ends_at).getTime() > now + 2 * 86400_000 ? new Date(acc.trial_ends_at) : undefined;
}

/**
 * Anota algo que hay que hacer en el proveedor y que se reintenta hasta lograrlo (`processBillingActions`): cancelar una
 * suscripción o reembolsar sus cobros. Repetirlo no duplica nada.
 */
export async function queueAction(o: { provider: ProviderName; kind: 'cancel' | 'refund_subscription'; ref: string; accountId: string | null; reason: '' | 'duplicate' | 'replaced' | 'unpaid' | 'deleted' | 'dispute' }) {
  if (!o.ref) return;
  await query(
    `INSERT INTO billing_actions (provider, kind, ref, account_id, reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider, kind, ref) DO NOTHING`,
    [o.provider, o.kind, o.ref, o.accountId, o.reason],
  );
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
export async function changePlan(o: { accountId: string; email: string; planKey: string; base: string }): Promise<{ url?: string; starts_at?: Date | null; scheduled?: boolean }> {
  const sub = await liveSubscription(o.accountId);
  // Mercado Pago informa «autorizada» aunque el último cobro se haya rechazado: cambiar el monto con un cobro fallido
  // daría la cuenta por pagada. Primero se cambia la tarjeta (que cobra lo pendiente). En Stripe, subir cobra la diferencia
  // al momento y, si el cobro falla, no cambia nada.
  if (sub.status === 'past_due' && sub.provider === 'mercadopago') throw new HttpError(400, 'Tienes un pago pendiente: actualiza tu tarjeta con «Cambiar tarjeta» antes de cambiar de plan.');
  if (sub.cancel_at_period_end) throw new HttpError(400, 'Tu plan está por cancelarse: primero elige «Mantener mi plan».');
  const pending = sub.provider === 'mercadopago' ? sub.pending_plan_key : '';
  if (pending && pending === o.planKey) throw new HttpError(400, 'Ese cambio ya está programado para tu siguiente cobro.');
  if (sub.plan_key === o.planKey && !pending) throw new HttpError(400, 'Ya tienes ese plan');
  const plan = await getPlan(o.planKey);
  if (!plan?.active) throw new HttpError(404, 'Ese plan no está disponible');
  const from = await getPlan(sub.plan_key);
  const upgrade = !from || monthly(plan) > monthly(from);
  if (!upgrade) await assertFitsPlan(o.accountId, plan);
  if (sub.provider === 'mercadopago' && from && from.billing_interval !== plan.billing_interval) {
    return { url: await startReplacement({ accountId: o.accountId, email: o.email, plan, base: o.base }) };
  }
  // Mercado Pago cobra el monto nuevo hasta la siguiente renovación (no cobra la diferencia): al subir, el plan nuevo y
  // sus límites esperan ese cobro (`promotePendingPlan`). Si no, se usaría el plan caro todo el periodo pagando el barato.
  // Se anota antes de cambiar el monto: si el proceso cae entre los dos pasos, el aviso del proveedor no lo adelanta.
  const deferred = sub.provider === 'mercadopago' && upgrade;
  const setPending = (key: string, since: Date | null, cents: number) =>
    query(`UPDATE subscriptions SET pending_plan_key = $2, pending_plan_since = $3, pending_amount_cents = $4, updated_at = now() WHERE account_id = $1`, [o.accountId, key, since, cents]);
  if (deferred) await setPending(plan.key, new Date(), chargeCents(plan));
  let state: SubscriptionState;
  try {
    state = await providers[sub.provider].changePlan(sub, plan, { upgrade });
  } catch (e) {
    if (deferred) await setPending(sub.pending_plan_key ?? '', sub.pending_plan_since ?? null, sub.pending_amount_cents ?? 0);
    throw e;
  }
  if (!deferred && pending) await setPending('', null, 0);
  // El estado se aplica ya (el aviso del proveedor llegará después y no repite nada).
  await applyState({ ...state, accountId: o.accountId, planKey: deferred ? sub.plan_key : plan.key });
  const acc = await queryOne<{ name: string }>(`SELECT name FROM accounts WHERE id = $1`, [o.accountId]);
  if (deferred) {
    await logEvent({ level: 'info', source: 'admin', message: `Cambio de plan programado (mercadopago): ${sub.plan_key || '—'} → ${plan.key}, con el siguiente cobro`, accountId: o.accountId });
    await tell(o.accountId, `Tu plan cambia a ${plan.name}`, `El plan ${plan.name} de tu cuenta "${acc?.name ?? ''}" empieza con tu siguiente cobro, el ${fmt(sub.current_period_end)} (${money(chargeCents(plan), plan.currency)} con IVA). Hasta entonces sigues con ${from ? `el plan ${from.name}` : 'tu plan actual'}.`);
    return { scheduled: true, starts_at: sub.current_period_end };
  }
  if (pending && plan.key === sub.plan_key) {
    await logEvent({ level: 'info', source: 'admin', message: `Cambio de plan programado cancelado (mercadopago): sigue ${plan.key}`, accountId: o.accountId });
    await tell(o.accountId, `Sigues con el plan ${plan.name}`, `Cancelamos el cambio que tenías programado: tu cuenta "${acc?.name ?? ''}" sigue con el plan ${plan.name} (${money(chargeCents(plan), plan.currency)} con IVA).`);
    return {};
  }
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
  const accountId = state.accountId
    ?? (await queryOne<{ account_id: string }>(`SELECT account_id FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`, [state.provider, state.subscriptionId]))?.account_id
    ?? null;
  if (!accountId) return null;
  // Los avisos de un mismo cambio llegan casi juntos (p. ej. checkout y suscripción creada): los de una cuenta se procesan
  // uno a la vez para que los correos y avisos no se dupliquen. Las demás cuentas no esperan.
  const later: Later = [];
  const result = await withTransaction(async (client) => {
    // Puede esperar al proveedor de cobro dentro de la transacción: que no la cierre el tiempo límite de inactividad.
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('billing-apply:' || $1))`, [accountId]);
    return applyStateLocked({ ...state, accountId }, now, later);
  });
  // Correos y avisos, ya sin el candado: un correo lento no detiene los cobros. Un aviso que falla no deshace el estado.
  for (const run of later) {
    await run().catch((e) => logEvent({ level: 'warn', source: 'admin', message: `Aviso de cobro sin enviar: ${e?.message ?? e}`, accountId }));
  }
  return result;
}

/** Avisos que salen al terminar de aplicar un estado (fuera del candado). */
export type Later = (() => Promise<unknown>)[];

async function applyStateLocked(state: SubscriptionState & { accountId: string }, now: Date, later: Later): Promise<string | null> {
  const accountId = state.accountId;
  const acc = await queryOne<{ id: string; name: string; status: string; plan: string; pause_reason: string }>(`SELECT id, name, status, plan, pause_reason FROM accounts WHERE id = $1`, [accountId]);
  if (!acc) return null;

  const prev = await getSubscription(accountId);
  // Sustitución pedida desde el panel (cambiar tarjeta, reanudar, mensual ↔ anual): la nueva es el pago iniciado.
  const replacing = !!prev?.checkout_ref && prev.checkout_provider === state.provider && prev.checkout_ref === state.subscriptionId
    && !!prev.provider_subscription_id && prev.provider_subscription_id !== state.subscriptionId && state.status === 'active';
  // Un aviso de una suscripción vieja (ya reemplazada) no debe pisar a la actual.
  if (prev && prev.provider_subscription_id && prev.provider_subscription_id !== state.subscriptionId && prev.provider === state.provider && ['active', 'past_due'].includes(prev.status) && !['active', 'incomplete'].includes(state.status)) return accountId;
  // Una segunda suscripción pagada mientras la vigente sigue cobrando (p. ej. dos pestañas de pago): se conserva la vigente
  // y la otra se cancela y se reembolsa sola, una sola vez (`processBillingActions`). Sin esto se cobraría dos veces.
  if (!replacing && state.status === 'active' && prev?.provider_subscription_id && ['active', 'past_due'].includes(prev.status) && !prev.cancel_at_period_end
    && (prev.provider !== state.provider || prev.provider_subscription_id !== state.subscriptionId)) {
    // Si la otra ya se cancela al final de su periodo (un plan reemplazado), no seguirá cobrando: solo se ignora.
    if (!state.cancelAtPeriodEnd && await recordEvent(state.provider, `duplicate:${state.subscriptionId}`, 'duplicate_subscription', accountId)) {
      await logEvent({ level: 'error', source: 'admin', message: `Suscripción duplicada (${state.provider} ${state.subscriptionId}): la cuenta ya paga ${prev.provider} ${prev.provider_subscription_id}. Se cancela y se reembolsa.`, accountId });
      await queueAction({ provider: state.provider, kind: 'cancel', ref: state.subscriptionId, accountId, reason: 'duplicate' });
      await queueAction({ provider: state.provider, kind: 'refund_subscription', ref: state.subscriptionId, accountId, reason: 'duplicate' });
    }
    return accountId;
  }
  // Un plan al que se subió en Mercado Pago empieza con el cobro de su monto (`promotePendingPlan`), no con este aviso,
  // que ya trae la referencia del plan nuevo.
  const held = !!prev?.pending_plan_key && prev.provider === state.provider && prev.provider_subscription_id === state.subscriptionId
    && state.planKey === prev.pending_plan_key;
  let planKey = (held ? prev!.plan_key : state.planKey) || prev?.plan_key || '';
  // Una sustitución a un plan más caro (mensual ↔ anual, o contratar otro tras cancelar) cobra por primera vez al terminar
  // lo ya pagado: hasta ese cobro sigue el plan de antes, igual que al subir en el mismo periodo.
  let scheduled: Plan | null = null;
  if (replacing && prev?.plan_key && planKey !== prev.plan_key && prev.current_period_end && new Date(prev.current_period_end) > now) {
    const [from, to] = await Promise.all([getPlan(prev.plan_key), getPlan(planKey)]);
    if (from && to && monthly(to) > monthly(from)) {
      scheduled = to;
      planKey = from.key;
    }
  }

  const pastDueSince = state.status === 'past_due' ? prev?.past_due_since ?? now : null;
  // El periodo ya pagado no se pierde si el proveedor no lo informa.
  const periodEnd = state.periodEnd ?? (prev?.provider_subscription_id === state.subscriptionId ? prev.current_period_end : null);
  await query(
    `INSERT INTO subscriptions (account_id, provider, provider_customer_id, provider_subscription_id, plan_key, status, current_period_end, cancel_at_period_end, past_due_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (account_id) DO UPDATE SET provider = $2, provider_customer_id = $3, provider_subscription_id = $4, plan_key = $5, status = $6,
       current_period_end = $7, cancel_at_period_end = $8, past_due_since = $9,
       dunning_step = CASE WHEN $6 = 'past_due' THEN subscriptions.dunning_step ELSE 0 END,
       payment_action_url = CASE WHEN $6 = 'past_due' THEN subscriptions.payment_action_url ELSE '' END,
       access_ended_at = CASE WHEN $6 = 'active' THEN NULL ELSE subscriptions.access_ended_at END,
       -- Una sustitución a un plan más caro lo programa en la nueva; cualquier otra deja atrás lo programado en la anterior.
       pending_plan_key = CASE WHEN $10 <> '' THEN $10 WHEN subscriptions.provider_subscription_id = $4 THEN subscriptions.pending_plan_key ELSE '' END,
       pending_plan_since = CASE WHEN $10 <> '' THEN $11::timestamptz WHEN subscriptions.provider_subscription_id = $4 THEN subscriptions.pending_plan_since END,
       pending_amount_cents = CASE WHEN $10 <> '' THEN $12::int WHEN subscriptions.provider_subscription_id = $4 THEN subscriptions.pending_amount_cents ELSE 0 END,
       updated_at = now()`,
    [accountId, state.provider, state.customerId, state.subscriptionId, planKey, state.status, periodEnd, state.cancelAtPeriodEnd, pastDueSince,
      scheduled?.key ?? '', scheduled ? now : null, scheduled ? chargeCents(scheduled) : 0],
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
        // Se reintenta sola hasta lograrlo; solo si se agotan los intentos se avisa al superadmin.
        await logEvent({ level: 'warn', source: 'admin', message: `No se pudo cancelar la suscripción sustituida ${prev.provider_subscription_id}, se reintenta: ${e?.message ?? e}`, accountId });
        await queueAction({ provider: prev.provider, kind: 'cancel', ref: prev.provider_subscription_id, accountId, reason: 'replaced' });
      }
    }
    await logEvent({ level: 'info', source: 'admin', message: `Suscripción sustituida (${state.provider}): ${prev.provider_subscription_id} → ${state.subscriptionId}`, accountId });
    if (scheduled) later.push(() => tell(accountId, `Tu plan cambia a ${scheduled.name}`, `El plan ${scheduled.name} de tu cuenta "${acc.name}" empieza con su primer cobro, el ${fmt(periodEnd)} (${money(chargeCents(scheduled), scheduled.currency)} con IVA). Hasta entonces sigues con ${plan ? `el plan ${plan.name}` : 'tu plan actual'}.`));
    else if (was === 'active') later.push(() => tell(accountId, 'Actualizamos tu plan', `Tu cuenta "${acc.name}" sigue al corriente${plan ? ` con el plan ${plan.name}` : ''} y con tu nueva forma de pago. Próximo cobro: ${fmt(periodEnd)}.`));
  }

  // Prueba con tarjeta: el proveedor confirmó la tarjeta y el primer cobro es al terminar la prueba (`trialEnd`).
  const trialFuture = !!state.trialEnd && state.trialEnd > now;
  const waitingCard = acc.status === 'paused' && acc.pause_reason === 'card';
  // La tarjeta ya se confirmó: la verificación abierta quedó completa (el freno cuenta las que no se completan).
  if (state.status === 'active') await query(`UPDATE card_checks SET completed_at = now() WHERE account_id = $1 AND completed_at IS NULL`, [accountId]);

  if (state.status === 'active' && trialFuture && waitingCard) {
    await startTrialFromState({ ...state, accountId }, acc.name, later);
  } else if (state.status === 'active') {
    // Cuenta al corriente: se activa (sale de prueba o de pausa) y se anota el plan contratado.
    // Solo al pasar a "al corriente" se reactiva la cuenta: una renovación mensual no deshace una pausa manual del superadmin.
    // Un contracargo abierto mantiene la pausa: solo se levanta al resolverse (ver `applyDispute`).
    // La suscripción de una prueba con tarjeta ya estaba «al corriente»: la cuenta se activa con el primer cobro (sin
    // días gratis por delante), y también la que esperaba tarjeta y se cobró ya (tarjeta que ya tuvo prueba).
    const activate = was !== 'active' || (!trialFuture && (acc.status === 'trial' || waitingCard));
    await query(
      `UPDATE accounts SET status = CASE WHEN $3::boolean AND NOT (status = 'paused' AND pause_reason = 'dispute') THEN 'active' ELSE status END,
         trial_ends_at = CASE WHEN $3::boolean THEN NULL ELSE trial_ends_at END,
         plan = COALESCE(NULLIF($2, ''), plan), updated_at = now() WHERE id = $1`,
      [accountId, planKey, activate],
    );
    if (activate) {
      await logEvent({ level: 'info', source: 'admin', message: `Pago confirmado (${state.provider}): plan ${planKey || '—'}`, accountId });
      later.push(() => tell(accountId, was === 'past_due' ? 'Recibimos tu pago, ¡gracias!' : '¡Tu plan está activo!', `Tu cuenta "${acc.name}" quedó al corriente${plan ? ` con el plan ${plan.name}` : ''}. Próxima renovación: ${fmt(periodEnd)}.`));
      if (was !== 'past_due') later.push(() => notifySuperadmins(accountId, `Nueva suscripción: ${acc.name}`, `"${acc.name}" contrató${plan ? ` ${plan.name} (${money(plan.price_cents, plan.currency)})` : ''} por ${state.provider}.`));
    }
  } else if (state.status === 'past_due' && was !== 'past_due') {
    await logEvent({ level: 'warn', source: 'admin', message: `Cobro fallido (${state.provider}): la cuenta tiene ${config.billing.graceDays} días para ponerse al corriente`, accountId });
    if (prev?.payment_action_url) later.push(() => tell(accountId, 'Confirma tu pago con tu banco', confirmText(acc.name, prev.payment_action_url)));
    else later.push(() => tell(accountId, 'No pudimos cobrar tu plan', `No se pudo procesar el pago de "${acc.name}". Actualiza tu forma de pago en los próximos ${config.billing.graceDays} días para que tu asistente siga respondiendo.`));
    later.push(() => notifySuperadmins(accountId, `Cobro fallido: ${acc.name}`, `No se pudo cobrar a "${acc.name}" (${state.provider}).`));
  } else if (state.status === 'canceled' && was !== 'canceled') {
    await logEvent({ level: 'info', source: 'admin', message: `Suscripción cancelada (${state.provider})`, accountId });
    const until = periodEnd && periodEnd > now ? ` Tu asistente sigue activo hasta el ${fmt(periodEnd)}.` : '';
    // La de una cuenta que espera tarjeta la cancelamos nosotros (tarjeta que ya tuvo prueba): el dueño ya tiene su aviso.
    if (!waitingCard) {
      later.push(() => tell(accountId, 'Tu suscripción se canceló', `La suscripción de "${acc.name}" se canceló.${until} Puedes volver a contratar cuando quieras.`));
      later.push(() => notifySuperadmins(accountId, `Suscripción cancelada: ${acc.name}`, `"${acc.name}" canceló su plan.`));
    }
    later.push(() => enforceAccess(now));
  }
  return accountId;
}

/**
 * ¿Este cobro empieza el plan programado? Tiene que ser de esa suscripción, posterior al cambio y por el monto pactado:
 * un cobro de antes, o con el monto anterior, todavía es del plan de siempre.
 */
export function startsPendingPlan(sub: Pick<Subscription, 'pending_plan_key' | 'pending_plan_since' | 'pending_amount_cents' | 'provider_subscription_id'> | null | undefined, payment: PaymentInfo): boolean {
  return !!sub?.pending_plan_key && !!sub.pending_plan_since && sub.provider_subscription_id === payment.subscriptionId
    && new Date(payment.paidAt) >= new Date(sub.pending_plan_since) && payment.totalCents >= sub.pending_amount_cents;
}

/**
 * El plan al que se subió en Mercado Pago empieza con el primer cobro de su monto (ver `changePlan`): entonces se aplica,
 * con sus límites. Corre con el candado de la cuenta, igual que `applyState`, para que un aviso a la vez no lo pise.
 */
export async function promotePendingPlan(accountId: string, provider: ProviderName, payment: PaymentInfo): Promise<void> {
  const later: Later = [];
  await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('billing-apply:' || $1))`, [accountId]);
    const sub = await getSubscription(accountId);
    if (!sub || sub.provider !== provider || !startsPendingPlan(sub, payment)) return;
    const plan = await getPlan(sub.pending_plan_key);
    if (!plan) return;
    await query(`UPDATE subscriptions SET plan_key = $2, pending_plan_key = '', pending_plan_since = NULL, updated_at = now() WHERE account_id = $1`, [accountId, plan.key]);
    await query(`UPDATE accounts SET plan = $2, updated_at = now() WHERE id = $1`, [accountId, plan.key]);
    await logEvent({ level: 'info', source: 'admin', message: `Cambio de plan aplicado con el cobro (${provider}): ${sub.plan_key || '—'} → ${plan.key}`, accountId });
    later.push(() => tell(accountId, `Ya tienes el plan ${plan.name}`, `Recibimos el cobro de tu plan ${plan.name} (${money(payment.totalCents, payment.currency)}): desde hoy tu cuenta tiene todo lo que incluye.`));
  });
  for (const run of later) {
    await run().catch((e) => logEvent({ level: 'warn', source: 'admin', message: `Aviso de cobro sin enviar: ${e?.message ?? e}`, accountId }));
  }
}

/**
 * Pausa las cuentas que ya no tienen derecho a usar el servicio: cobro fallido pasado el periodo de gracia, o
 * suscripción cancelada cuyo periodo pagado terminó. Se aplica una sola vez por caída (`access_ended_at`);
 * si el superadmin reactiva la cuenta a mano, no se vuelve a pausar.
 */
export async function enforceAccess(now = new Date()): Promise<number> {
  // Marcar la caída y pausar la cuenta en la misma sentencia: si el proceso muere a la mitad, no queda una caída anotada
  // con la cuenta todavía activa (la consulta ya no la volvería a tomar).
  const rows = await query<{ account_id: string; name: string; status: string }>(
    `WITH ended AS (
       UPDATE subscriptions s SET access_ended_at = $1, updated_at = now() FROM accounts a
       WHERE a.id = s.account_id AND s.access_ended_at IS NULL AND (
         (s.status = 'past_due' AND s.past_due_since <= $1::timestamptz - make_interval(days => $2))
         OR (s.status = 'canceled' AND (s.current_period_end IS NULL OR s.current_period_end <= $1))
       ) RETURNING s.account_id, a.name, s.status
     ), paused AS (
       UPDATE accounts SET status = 'paused', paused_at = $1, pause_reason = 'payment', updated_at = now()
       WHERE id IN (SELECT account_id FROM ended) AND status <> 'paused' RETURNING id
     )
     SELECT account_id, name, status FROM ended`,
    [now, config.billing.graceDays],
  );
  for (const r of rows) {
    await logEvent({ level: 'warn', source: 'admin', message: `Cuenta pausada por falta de pago (${r.status})`, accountId: r.account_id });
    await tell(r.account_id, 'Tu asistente está en pausa', `Tu asistente de "${r.name}" se pausó porque el plan no está al corriente. ${keptNote()} Reactívalo cuando quieras desde Mi plan.`);
    await notifySuperadmins(r.account_id, `Cuenta pausada por pago: ${r.name}`, `"${r.name}" quedó en pausa (${r.status}).`);
  }
  return rows.length;
}

/**
 * Recordatorios de un cobro fallido (el primer aviso sale al fallar): a los 3 días y un día antes de que termine la
 * gracia. Cada uno una sola vez por caída (`dunning_step` vuelve a 0 al pagar). Con una gracia corta, el de los 3 días se
 * salta. Devuelve cuántos se enviaron.
 */
export async function checkDunning(now = new Date()): Promise<number> {
  const grace = config.billing.graceDays;
  const last = grace - 1;
  // El último primero: si ya toca, el anterior ya no sale.
  const steps = [
    ...(last >= 1 ? [{ step: 2, after: last }] : []),
    ...(3 < last ? [{ step: 1, after: 3 }] : []),
  ];
  let sent = 0;
  for (const { step, after } of steps) {
    const rows = await query<{ account_id: string; name: string; provider: ProviderName; past_due_since: Date; payment_action_url: string }>(
      `UPDATE subscriptions s SET dunning_step = $3, updated_at = now() FROM accounts a
       WHERE a.id = s.account_id AND s.status = 'past_due' AND s.access_ended_at IS NULL AND s.dunning_step < $3
         AND s.past_due_since <= $1::timestamptz - make_interval(days => $2)
       RETURNING s.account_id, a.name, s.provider, s.past_due_since, s.payment_action_url`,
      [now, after, step],
    );
    for (const r of rows) {
      const deadline = new Date(new Date(r.past_due_since).getTime() + grace * 86400_000);
      // Si el banco detuvo el cobro para que lo confirmen (3DS), basta confirmarlo; la tarjeta está bien.
      if (r.payment_action_url) {
        await tell(r.account_id, step === 1 ? 'Tu pago sigue pendiente' : 'Mañana se pausa tu asistente', `${confirmText(r.name, r.payment_action_url)} Hazlo antes del ${fmt(deadline)} para que tu asistente siga respondiendo.`);
        await logEvent({ level: 'warn', source: 'admin', message: `Recordatorio de cobro por confirmar (${step === 1 ? '3 días' : 'último aviso'})`, accountId: r.account_id });
        sent++;
        continue;
      }
      const how = r.provider === 'stripe' ? 'en «Administrar pago»' : 'con «Cambiar tarjeta»';
      if (step === 1) {
        await tell(r.account_id, 'Tu pago sigue pendiente', `Todavía no pudimos cobrar el plan de "${r.name}". Actualiza tu forma de pago ${how} en Mi plan antes del ${fmt(deadline)} para que tu asistente siga respondiendo.`);
      } else {
        await tell(r.account_id, 'Mañana se pausa tu asistente', `Si no se actualiza el pago, tu asistente de "${r.name}" dejará de responder el ${fmt(deadline)}. Actualiza tu forma de pago ${how} en Mi plan; en cuanto se cobre, todo sigue igual.`);
      }
      await logEvent({ level: 'warn', source: 'admin', message: `Recordatorio de cobro fallido (${step === 1 ? '3 días' : 'último aviso'})`, accountId: r.account_id });
      sent++;
    }
  }
  return sent;
}

/** Pago pendiente de la cuenta, para la franja del panel (null si está al corriente). */
export async function paymentDue(accountId: string) {
  const sub = await getSubscription(accountId);
  if (sub?.status !== 'past_due' || !sub.past_due_since || sub.access_ended_at) return null;
  return {
    provider: sub.provider,
    grace_ends_at: new Date(new Date(sub.past_due_since).getTime() + config.billing.graceDays * 86400_000),
    // El banco pide confirmar el cobro (3DS): la franja lleva a esa página en lugar de pedir otra tarjeta.
    action_url: sub.payment_action_url || null,
  };
}

/** Texto del aviso cuando el banco detuvo el cobro hasta que el cliente lo confirme (3DS). */
function confirmText(name: string, url: string) {
  return `Tu banco pide que confirmes el cobro del plan de "${name}" (es una medida de seguridad; tu tarjeta está bien). Confírmalo aquí: ${url}`;
}

/**
 * El banco detuvo un cobro hasta que el cliente lo confirme (3DS). Se guarda la página para confirmarlo y, si la
 * suscripción ya tenía el pago pendiente (no habrá otro aviso de "cobro fallido"), se le avisa al cliente.
 * Se llama antes de aplicar el estado: así el aviso de cobro fallido ya dice cómo resolverlo.
 */
export async function notePaymentAction(provider: ProviderName, subscriptionId: string, url: string) {
  const prev = await queryOne<{ account_id: string; status: string; payment_action_url: string; name: string }>(
    `SELECT s.account_id, s.status, s.payment_action_url, a.name FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.provider = $1 AND s.provider_subscription_id = $2`,
    [provider, subscriptionId],
  );
  if (!prev || !url) return;
  await query(`UPDATE subscriptions SET payment_action_url = $2, updated_at = now() WHERE account_id = $1`, [prev.account_id, url]);
  await logEvent({ level: 'warn', source: 'admin', message: `El banco pide confirmar el cobro (${provider})`, accountId: prev.account_id });
  if (prev.status === 'past_due' && prev.payment_action_url !== url) await tell(prev.account_id, 'Confirma tu pago con tu banco', confirmText(prev.name, url));
}

/**
 * Una cuenta que lleva `BILLING_CANCEL_AFTER_PAUSE_DAYS` días en pausa por falta de pago deja de tener suscripción: se
 * cancela en el proveedor (deja de reintentar el cobro) y su cuenta entra al plazo normal de retención. Pagar antes la
 * reactiva como siempre; después, puede volver a contratar desde Mi plan.
 */
export async function cancelLongUnpaid(now = new Date()): Promise<number> {
  const days = config.billing.cancelAfterPauseDays;
  if (!(days > 0)) return 0;
  // La cancelación en el proveedor se encola en la misma sentencia: si el proceso muere a la mitad, no queda una
  // suscripción «cancelada» aquí que el proveedor siga cobrando.
  const rows = await query<{ account_id: string; name: string; provider: ProviderName; provider_subscription_id: string }>(
    `WITH canceled AS (
       UPDATE subscriptions s SET status = 'canceled', cancel_at_period_end = false, updated_at = now() FROM accounts a
       WHERE a.id = s.account_id AND s.status = 'past_due' AND s.access_ended_at IS NOT NULL AND a.status = 'paused'
         AND s.access_ended_at <= $1::timestamptz - make_interval(days => $2)
       RETURNING s.account_id, a.name, s.provider, s.provider_subscription_id
     ), queued AS (
       INSERT INTO billing_actions (provider, kind, ref, account_id, reason)
       SELECT provider, 'cancel', provider_subscription_id, account_id, 'unpaid' FROM canceled WHERE provider_subscription_id <> ''
       ON CONFLICT (provider, kind, ref) DO NOTHING
     )
     SELECT account_id, name, provider, provider_subscription_id FROM canceled`,
    [now, days],
  );
  for (const r of rows) {
    await logEvent({ level: 'warn', source: 'admin', message: `Suscripción cancelada tras ${days} días en pausa sin pago`, accountId: r.account_id });
    await tell(r.account_id, 'Cancelamos tu suscripción',
      `Tu cuenta "${r.name}" lleva ${days} días en pausa sin que se pudiera cobrar, así que cancelamos la suscripción para no seguir intentando cobrarte. ${keptNote()} Puedes volver a contratar cuando quieras desde Mi plan.`);
    await notifySuperadmins(r.account_id, `Suscripción cancelada por falta de pago: ${r.name}`, `"${r.name}" llevaba ${days} días en pausa sin pago; su suscripción (${r.provider}) se canceló.`);
  }
  return rows.length;
}

export const billingEnabled = async () => enabledProviders().length > 0 && (await listPlans()).length > 0;
