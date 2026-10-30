/**
 * La verificación de tarjeta del registro: la cuenta nueva espera la tarjeta (en pausa, motivo `card`) y la prueba
 * gratis empieza cuando el proveedor confirma una tarjeta. Sin cobro en línea configurado no se pide tarjeta.
 *
 * Abrir la página de pago es lo que se usa para probar tarjetas robadas: pide el correo del dueño verificado (y la
 * verificación reciente, en la ruta), reutiliza la sesión vigente (30 minutos) y tiene topes en la base: 5 por día por
 * cuenta, 10 por conexión y 300 en toda la plataforma.
 */
import { HttpError } from '../access.js';
import { ipKey } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { accountOwner } from '../identity/ownership.js';
import { countHit, releaseHit } from '../identity/rate-limit.js';
import { billingEnabled } from './service.js';
import { trialAvailable } from './trial-claims.js';
import type { ProviderName } from './types.js';

export const CHECK_TTL_MS = 30 * 60_000;
const DAY = 86400_000;
const TOO_MANY = 'Intenta más tarde';

/** ¿La cuenta nueva necesita una tarjeta para empezar su prueba? Sí, si hay cobro en línea (proveedor y planes). */
export async function cardRequired(): Promise<boolean> {
  return billingEnabled();
}

/** Días gratis de la verificación: TRIAL_DAYS si la cuenta espera la tarjeta y su dueño tiene prueba disponible. */
export async function trialDaysFor(accountId: string): Promise<number> {
  const acc = await queryOne<{ status: string; pause_reason: string }>(`SELECT status, pause_reason FROM accounts WHERE id = $1`, [accountId]);
  if (acc?.status !== 'paused' || acc.pause_reason !== 'card' || config.signup.trialDays <= 0) return 0;
  const owner = await accountOwner(accountId);
  if (!owner) return 0;
  const sub = (await queryOne<{ google_sub: string | null }>(`SELECT google_sub FROM users WHERE id = $1`, [owner.id]))?.google_sub;
  return (await trialAvailable({ email: owner.email, googleSub: sub })) ? config.signup.trialDays : 0;
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
