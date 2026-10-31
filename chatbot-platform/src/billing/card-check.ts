/**
 * La verificación de tarjeta del registro: la cuenta nueva espera la tarjeta (en pausa, motivo `card`) y la prueba
 * gratis empieza cuando el proveedor confirma una tarjeta. Sin cobro en línea configurado no se pide tarjeta.
 *
 * Abrir la página de pago es lo que se usa para probar tarjetas robadas: pide el correo del dueño verificado (y la
 * verificación reciente, en la ruta), reutiliza la sesión vigente (30 minutos) y tiene topes en la base: 5 por día por
 * cuenta, 10 por conexión y 300 en toda la plataforma. Si en la última hora se abrieron 20 o más y se completaron menos
 * del 20 % (alguien probando tarjetas robadas), un freno cierra las nuevas una hora y avisa con urgencia al
 * superadministrador, que lo puede quitar desde Cuentas.
 *
 * Una prueba por persona: al confirmarse la tarjeta se revisa que ni ella ni el correo ni la cuenta de Google hayan
 * tenido una (las marcas de `trial-claims`).
 */
import { HttpError } from '../access.js';
import { ipKey } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { accountOwner } from '../identity/ownership.js';
import { countHit, hitsFor, releaseHit } from '../identity/rate-limit.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { notifyPlatform } from '../platform/digest.js';
import { billingEnabled, fmt, providers, queueAction, recordEvent, tell, type Later } from './service.js';
import { claimMarks, insertClaims, lockClaims, recordTrialClaims, trialAvailable } from './trial-claims.js';
import type pg from 'pg';
import type { ProviderName, SubscriptionState } from './types.js';

export const CHECK_TTL_MS = 30 * 60_000;
const HOUR = 3600_000;
const DAY = 86400_000;
const TOO_MANY = 'Intenta más tarde';
/** El freno: clave de `rate_limits` que vive una hora. `BRAKE_CLEARED` marca cuándo lo quitó el superadmin. */
const BRAKE = 'card-check-brake';
const BRAKE_CLEARED = 'card-check-brake-cleared';
const BRAKE_MIN_OPENED = 20;
const BRAKE_MIN_RATE = 0.2;

export async function brakeOn(): Promise<boolean> {
  return (await hitsFor(BRAKE)) > 0;
}

/**
 * ¿Frenar las verificaciones nuevas? Cuenta las de la última hora (desde que el superadmin quitó el freno, si fue
 * después). Al ponerse avisa una sola vez: los que llegan con el freno puesto ya no cuentan nada.
 */
async function braked(): Promise<boolean> {
  if (await brakeOn()) return true;
  const r = await queryOne<{ opened: number; completed: number }>(
    `SELECT count(*)::int AS opened, count(completed_at)::int AS completed FROM card_checks
      WHERE opened_at > GREATEST(now() - interval '1 hour',
        COALESCE((SELECT expires_at - interval '1 hour' FROM rate_limits WHERE key = $1 AND expires_at > now()), '-infinity'::timestamptz))`,
    [BRAKE_CLEARED],
  );
  if (!r || r.opened < BRAKE_MIN_OPENED || r.completed >= r.opened * BRAKE_MIN_RATE) return false;
  if ((await countHit(BRAKE, HOUR)) === 1) {
    const what = `En la última hora se abrieron ${r.opened} verificaciones de tarjeta y solo se completaron ${r.completed}`;
    await logEvent({ level: 'error', source: 'admin', message: `Freno de verificaciones de tarjeta puesto: ${what.toLowerCase()}` });
    await notifyPlatform('Freno a las verificaciones de tarjeta', `${what}: puede ser alguien probando tarjetas robadas. Las nuevas quedan cerradas una hora («Intenta más tarde»). Si es tráfico legítimo, quita el freno desde Cuentas.`, { urgent: true });
  }
  return true;
}

/** Lo que Mi plan muestra de la verificación de tarjeta (el paso en el que va la cuenta y por qué no avanza). */
export async function cardCheckState(accountId: string) {
  const acc = await queryOne<{ status: string; pause_reason: string; signup_plan: string }>(`SELECT status, pause_reason, signup_plan FROM accounts WHERE id = $1`, [accountId]);
  const waiting = acc?.status === 'paused' && acc.pause_reason === 'card';
  const [owner, p] = await Promise.all([accountOwner(accountId), person(accountId)]);
  return {
    required: await cardRequired(),
    waiting,
    trial_available: config.signup.trialDays > 0 && !!p && (await trialAvailable(p)),
    trial_days: config.signup.trialDays,
    email_verified: !!owner?.email_verified_at,
    signup_plan: acc?.signup_plan ?? '',
    // La última tarjeta que dio ya tuvo una prueba (`startTrialFromState`): Mi plan ofrece otra tarjeta o contratar ya.
    card_used: waiting && !!(await queryOne(`SELECT 1 FROM billing_events WHERE account_id = $1 AND type = 'trial_refused'`, [accountId])),
    brake: await brakeOn(),
  };
}

/**
 * «Activar sin tarjeta» (Cuentas): una excepción real, como una demostración o un cliente cuya tarjeta no pasa. La
 * cuenta que esperaba tarjeta queda en prueba de TRIAL_DAYS y la prueba de esa persona cuenta como usada (se guardan
 * sus marcas de correo y Google). Devuelve false si la cuenta no esperaba tarjeta.
 */
export async function trialWithoutCard(accountId: string, actor: { email: string }): Promise<boolean> {
  const acc = await queryOne<{ name: string; trial_ends_at: Date }>(
    `UPDATE accounts SET status = 'trial', pause_reason = '', trial_ends_at = now() + make_interval(days => $2), trial_warned_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'paused' AND pause_reason = 'card' RETURNING name, trial_ends_at`,
    [accountId, config.signup.trialDays],
  );
  if (!acc) return false;
  const p = await person(accountId);
  if (p) await recordTrialClaims({ accountId, email: p.email, googleSub: p.googleSub, provider: '' });
  await logEvent({ level: 'warn', source: 'admin', message: `Prueba sin tarjeta activada por ${actor.email}: termina el ${fmt(acc.trial_ends_at)}`, accountId });
  await tell(accountId, 'Tu prueba gratis empezó', `Activamos la prueba de "${acc.name}" sin tarjeta. Termina el ${fmt(acc.trial_ends_at)}; para seguir después, elige tu plan en Mi plan.`);
  return true;
}

/** El superadmin quita el freno: se abren otra vez y solo cuentan las verificaciones de después. */
export async function clearBrake(actor: { email: string }): Promise<void> {
  await query(`DELETE FROM rate_limits WHERE key IN ($1, $2)`, [BRAKE, BRAKE_CLEARED]);
  await countHit(BRAKE_CLEARED, HOUR);
  await logEvent({ level: 'warn', source: 'admin', message: `Freno de verificaciones de tarjeta quitado por ${actor.email}` });
}

/** ¿La cuenta nueva necesita una tarjeta para empezar su prueba? Sí, si hay cobro en línea (proveedor y planes). */
export async function cardRequired(): Promise<boolean> {
  return billingEnabled();
}

/** El dueño de la cuenta y su cuenta de Google: lo que identifica a la persona para las marcas de prueba. */
async function person(accountId: string) {
  const owner = await accountOwner(accountId);
  if (!owner) return null;
  const googleSub = (await queryOne<{ google_sub: string | null }>(`SELECT google_sub FROM users WHERE id = $1`, [owner.id]))?.google_sub ?? null;
  return { email: owner.email, googleSub };
}

/** Días gratis de la verificación: TRIAL_DAYS si la cuenta espera la tarjeta y su dueño tiene prueba disponible. */
export async function trialDaysFor(accountId: string): Promise<number> {
  const acc = await queryOne<{ status: string; pause_reason: string }>(`SELECT status, pause_reason FROM accounts WHERE id = $1`, [accountId]);
  if (acc?.status !== 'paused' || acc.pause_reason !== 'card' || config.signup.trialDays <= 0) return 0;
  const p = await person(accountId);
  return p && (await trialAvailable(p)) ? config.signup.trialDays : 0;
}

/**
 * El proveedor confirmó la tarjeta de una cuenta que la esperaba, con días gratis: empieza la prueba con el fin que dice
 * el proveedor y deja sus marcas. Si la tarjeta ya tuvo una prueba (o el correo o la cuenta de Google, si otra cuenta
 * de la misma persona empezó la suya mientras tanto), no hay otra: en Stripe la prueba termina al momento y se cobra;
 * en Mercado Pago se cancela esa suscripción y la cuenta sigue esperando tarjeta. Corre en la transacción de
 * `applyState` (`client`, con el candado de la cuenta, así que un aviso repetido no la empieza dos veces) y la marca
 * decide entre cuentas: con el candado de cada marca, revisarlas, empezar la prueba y guardarlas va junto. La llamada al
 * proveedor y los avisos van en `later`.
 */
export async function startTrialFromState(state: SubscriptionState & { accountId: string }, name: string, later: Later, client: pg.PoolClient): Promise<'trial' | 'card_used' | 'none'> {
  const { accountId, provider, subscriptionId } = state;
  const p = await person(accountId);
  const marks = await claimMarks({ email: p?.email, googleSub: p?.googleSub, cardKey: state.cardKey });
  const used = await lockClaims(client, marks);
  const cardUsed = used.has('card');
  // Sin la huella de la tarjeta no se puede cuidar «una prueba por tarjeta»: se trata como una tarjeta ya usada (PAY-17).
  const noCard = !state.cardKey;
  if (used.size || noCard) {
    if (!(await recordEvent(provider, `card_used:${subscriptionId}`, 'trial_refused', accountId))) return 'none';
    await logEvent({ level: 'warn', source: 'admin', message: `Prueba negada (${provider} ${subscriptionId}): ${noCard && !used.size ? 'no se pudo leer la huella de la tarjeta' : `${cardUsed ? 'la tarjeta' : 'el correo o la cuenta de Google'} ya tuvo una prueba`}`, accountId });
    later.push(async () => {
      try {
        await providers[provider].endTrialNow(subscriptionId);
        // La de Mercado Pago quedó cancelada sin cobrar nada: no cuenta como la vigente al agregar otra tarjeta, ni deja un
        // «periodo pagado» que retrase el primer cobro de «Contratar».
        if (provider === 'mercadopago') await query(`UPDATE subscriptions SET status = 'canceled', current_period_end = NULL, updated_at = now() WHERE account_id = $1 AND provider_subscription_id = $2`, [accountId, subscriptionId]);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'admin', message: `No se pudo terminar la prueba negada ${provider} ${subscriptionId}: ${e?.message ?? e}`, accountId });
        // Cancelar en Mercado Pago se reintenta solo; en Stripe, que la prueba termine lo hace el superadmin.
        if (provider === 'mercadopago') await queueAction({ provider, kind: 'cancel', ref: subscriptionId, accountId, reason: '' });
        else await notifySuperadmins(accountId, 'Termina una prueba a mano', `La tarjeta de "${name}" ya tuvo una prueba, pero no se pudo terminar la de la suscripción ${subscriptionId} en Stripe: ${e?.message ?? e}. Termínala desde Stripe para que se cobre.`, { urgent: true });
      }
    });
    const title = cardUsed ? 'Esta tarjeta ya tuvo una prueba gratis' : used.size ? 'Ya usaste tu prueba gratis con este correo' : 'No pudimos leer tu tarjeta';
    later.push(() => tell(accountId, title, provider === 'stripe'
      ? `${title}, así que tu plan de "${name}" empieza hoy con su primer cobro.`
      : `${title}. Cancelamos esa suscripción sin cobrarte. En Mi plan puedes usar otra tarjeta o contratar ya, con el primer cobro hoy.`));
    return 'card_used';
  }
  const started = await client.query(
    `UPDATE accounts SET status = 'trial', trial_ends_at = $2, pause_reason = '', updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_reason = 'card' RETURNING id`,
    [accountId, state.trialEnd],
  );
  if (!started.rowCount) return 'none';
  await insertClaims(client, accountId, provider, marks);
  await logEvent({ level: 'info', source: 'admin', message: `Prueba con tarjeta (${provider}): termina el ${fmt(state.trialEnd!)}`, accountId });
  later.push(() => tell(accountId, 'Tu prueba gratis empezó', `Tu prueba de "${name}" ya está activa. El primer cobro de tu plan será el ${fmt(state.trialEnd!)}; si cancelas antes desde Mi plan, no se cobra nada.`));
  later.push(() => notifySuperadmins(accountId, `Nueva prueba: ${name}`, `"${name}" empezó su prueba con tarjeta (${provider}); el primer cobro es el ${fmt(state.trialEnd!)}.`));
  return 'trial';
}

/**
 * Abre (o reutiliza) la página de pago de la cuenta con las puertas y los topes de arriba; devuelve su dirección.
 * `replacement`: una página de tarjeta de quien ya paga (Mercado Pago: cambiar tarjeta, reanudar, mensual ↔ anual). Cuenta
 * igual para los topes y el freno y queda en `card_checks`, pero no pide el correo verificado (ya es cliente) ni
 * reutiliza otra página (es otra suscripción).
 */
export async function openCardCheck(o: {
  accountId: string;
  ip: string;
  provider: ProviderName;
  planKey: string;
  open: () => Promise<{ url: string; ref: string }>;
  replacement?: boolean;
}): Promise<string> {
  if (!o.replacement) {
    const owner = await accountOwner(o.accountId);
    if (owner && !owner.email_verified_at) throw new HttpError(403, 'Falta verificar tu correo');
    const live = await queryOne<{ url: string }>(
      `SELECT url FROM card_checks WHERE account_id = $1 AND provider = $2 AND plan_key = $3 AND completed_at IS NULL AND url <> ''
          AND opened_at > now() - make_interval(secs => $4) ORDER BY opened_at DESC LIMIT 1`,
      [o.accountId, o.provider, o.planKey, CHECK_TTL_MS / 1000],
    );
    if (live) return live.url;
  }
  if (await braked()) throw new HttpError(429, TOO_MANY);
  const keys: [string, number][] = [[`card-check-acct:${o.accountId}`, 5], [`card-check-ip:${ipKey(o.ip)}`, 10], ['card-check-day', 300]];
  const taken: string[] = [];
  const release = async () => { for (const k of taken) await releaseHit(k); };
  for (const [key, max] of keys) {
    const hits = await countHit(key, DAY);
    taken.push(key);
    if (hits > max) {
      await release();
      throw new HttpError(429, TOO_MANY);
    }
  }
  let opened: { url: string; ref: string };
  try {
    opened = await o.open();
  } catch (e) {
    await release(); // el proveedor no la abrió: no cuenta
    throw e;
  }
  await query(`INSERT INTO card_checks (account_id, provider, plan_key, ref, url, ip_key) VALUES ($1, $2, $3, $4, $5, $6)`, [o.accountId, o.provider, o.planKey, opened.ref, opened.url, ipKey(o.ip)]);
  return opened.url;
}
