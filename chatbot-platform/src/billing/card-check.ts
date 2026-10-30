/**
 * La verificación de tarjeta del registro: la cuenta nueva espera la tarjeta (en pausa, motivo `card`) y la prueba
 * gratis empieza cuando el proveedor confirma una tarjeta. Sin cobro en línea configurado no se pide tarjeta.
 *
 * Abrir la página de pago es lo que se usa para probar tarjetas robadas: pide el correo del dueño verificado (y la
 * verificación reciente, en la ruta), reutiliza la sesión vigente (30 minutos) y tiene topes en la base: 5 por día por
 * cuenta, 10 por conexión y 300 en toda la plataforma.
 *
 * Una prueba por persona: al confirmarse la tarjeta se revisa que ni ella ni el correo ni la cuenta de Google hayan
 * tenido una (las marcas de `trial-claims`).
 */
import { HttpError } from '../access.js';
import { ipKey } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { accountOwner } from '../identity/ownership.js';
import { countHit, releaseHit } from '../identity/rate-limit.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { billingEnabled, fmt, providers, queueAction, recordEvent, tell, type Later } from './service.js';
import { cardClaim, recordTrialClaims, trialAvailable } from './trial-claims.js';
import type { ProviderName, SubscriptionState } from './types.js';

export const CHECK_TTL_MS = 30 * 60_000;
const DAY = 86400_000;
const TOO_MANY = 'Intenta más tarde';

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
 * en Mercado Pago se cancela esa suscripción y la cuenta sigue esperando tarjeta. Corre con el candado de la cuenta
 * (`applyStateLocked`), así que un aviso repetido no la empieza dos veces; la llamada al proveedor y los avisos van en
 * `later`.
 */
export async function startTrialFromState(state: SubscriptionState & { accountId: string }, name: string, later: Later): Promise<'trial' | 'card_used' | 'none'> {
  const { accountId, provider, subscriptionId } = state;
  const p = await person(accountId);
  const cardUsed = !!state.cardKey && (await cardClaim(state.cardKey)).claimed;
  if (cardUsed || (p && !(await trialAvailable(p)))) {
    if (!(await recordEvent(provider, `card_used:${subscriptionId}`, 'trial_refused', accountId))) return 'none';
    await logEvent({ level: 'warn', source: 'admin', message: `Prueba negada (${provider} ${subscriptionId}): ${cardUsed ? 'la tarjeta' : 'el correo o la cuenta de Google'} ya tuvo una prueba`, accountId });
    later.push(async () => {
      try {
        await providers[provider].endTrialNow(subscriptionId);
        // La de Mercado Pago quedó cancelada: así no cuenta como la vigente al agregar otra tarjeta.
        if (provider === 'mercadopago') await query(`UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE account_id = $1 AND provider_subscription_id = $2`, [accountId, subscriptionId]);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'admin', message: `No se pudo terminar la prueba negada ${provider} ${subscriptionId}: ${e?.message ?? e}`, accountId });
        // Cancelar en Mercado Pago se reintenta solo; en Stripe, que la prueba termine lo hace el superadmin.
        if (provider === 'mercadopago') await queueAction({ provider, kind: 'cancel', ref: subscriptionId, accountId, reason: '' });
        else await notifySuperadmins(accountId, 'Termina una prueba a mano', `La tarjeta de "${name}" ya tuvo una prueba, pero no se pudo terminar la de la suscripción ${subscriptionId} en Stripe: ${e?.message ?? e}. Termínala desde Stripe para que se cobre.`, { urgent: true });
      }
    });
    const title = cardUsed ? 'Esta tarjeta ya tuvo una prueba gratis' : 'Ya usaste tu prueba gratis con este correo';
    later.push(() => tell(accountId, title, provider === 'stripe'
      ? `${title}, así que tu plan de "${name}" empieza hoy con su primer cobro.`
      : `${title}. Cancelamos esa suscripción sin cobrarte. En Mi plan puedes usar otra tarjeta o contratar ya, con el primer cobro hoy.`));
    return 'card_used';
  }
  const started = await queryOne(
    `UPDATE accounts SET status = 'trial', trial_ends_at = $2, pause_reason = '', updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_reason = 'card' RETURNING id`,
    [accountId, state.trialEnd],
  );
  if (!started) return 'none';
  if (p) await recordTrialClaims({ accountId, email: p.email, googleSub: p.googleSub, cardKey: state.cardKey, provider });
  if (!state.cardKey) await logEvent({ level: 'warn', source: 'admin', message: `Prueba sin huella de tarjeta (${provider} ${subscriptionId}): la tarjeta no queda marcada`, accountId });
  await logEvent({ level: 'info', source: 'admin', message: `Prueba con tarjeta (${provider}): termina el ${fmt(state.trialEnd!)}`, accountId });
  later.push(() => tell(accountId, 'Tu prueba gratis empezó', `Tu prueba de "${name}" ya está activa. El primer cobro de tu plan será el ${fmt(state.trialEnd!)}; si cancelas antes desde Mi plan, no se cobra nada.`));
  later.push(() => notifySuperadmins(accountId, `Nueva prueba: ${name}`, `"${name}" empezó su prueba con tarjeta (${provider}); el primer cobro es el ${fmt(state.trialEnd!)}.`));
  return 'trial';
}

/** Abre (o reutiliza) la página de pago de la cuenta con las puertas y los topes de arriba; devuelve su dirección. */
export async function openCardCheck(o: {
  accountId: string;
  ip: string;
  provider: ProviderName;
  planKey: string;
  open: () => Promise<{ url: string; ref: string }>;
}): Promise<string> {
  const owner = await accountOwner(o.accountId);
  if (owner && !owner.email_verified_at) throw new HttpError(403, 'Falta verificar tu correo');
  const live = await queryOne<{ url: string }>(
    `SELECT url FROM card_checks WHERE account_id = $1 AND provider = $2 AND plan_key = $3 AND completed_at IS NULL AND url <> ''
        AND opened_at > now() - make_interval(secs => $4) ORDER BY opened_at DESC LIMIT 1`,
    [o.accountId, o.provider, o.planKey, CHECK_TTL_MS / 1000],
  );
  if (live) return live.url;
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
