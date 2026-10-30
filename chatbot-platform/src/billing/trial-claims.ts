/**
 * Una prueba gratis por persona. Cada prueba deja marcas del correo normalizado, de la cuenta de Google y de la
 * tarjeta; una marca vigente (2 años) quita la prueba a quien vuelva con ese correo, esa cuenta o esa tarjeta. Se guarda
 * un HMAC-SHA256 con una llave que vive en la base (`system_keys`), nunca el valor en claro.
 */
import crypto from 'node:crypto';
import type pg from 'pg';
import { query, queryOne } from '../db.js';

export type ClaimKind = 'email' | 'google' | 'card';

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/** Minúsculas y sin `+etiqueta`; en Gmail también sin puntos y con el dominio gmail.com. Solo para las marcas. */
export function canonicalEmail(email: string): string {
  const v = email.trim().toLowerCase();
  const at = v.indexOf('@');
  if (at < 0) return v;
  const local = v.slice(0, at).split('+')[0];
  const domain = v.slice(at + 1);
  return GMAIL.has(domain) ? `${local.replaceAll('.', '')}@gmail.com` : `${local}@${domain}`;
}

/** Mercado Pago no da una huella de la tarjeta: se arma con los 6 primeros, los 4 últimos, el vencimiento y el titular. */
export function mpCardKey(card: {
  first_six_digits?: string;
  last_four_digits?: string;
  expiration_month?: number;
  expiration_year?: number;
  cardholder?: { identification?: { number?: string } };
}): string | null {
  if (!card.first_six_digits || !card.last_four_digits) return null;
  return `${card.first_six_digits}:${card.last_four_digits}:${card.expiration_month ?? ''}/${card.expiration_year ?? ''}:${card.cardholder?.identification?.number ?? ''}`;
}

let key: Buffer | null = null;
async function claimKey(): Promise<Buffer> {
  if (key) return key;
  // La crea la migración; si faltara (una base restaurada a medias), se crea aquí una sola vez.
  await query(`INSERT INTO system_keys (name, value) VALUES ('trial_claims', $1) ON CONFLICT (name) DO NOTHING`, [crypto.randomBytes(32)]);
  key = (await queryOne<{ value: Buffer }>(`SELECT value FROM system_keys WHERE name = 'trial_claims'`))!.value;
  return key;
}

async function digest(kind: ClaimKind, value: string): Promise<Buffer> {
  return crypto.createHmac('sha256', await claimKey()).update(`${kind}:${value}`).digest();
}

/** ¿Este correo (normalizado) y esta cuenta de Google pueden empezar una prueba? */
export async function trialAvailable(o: { email: string; googleSub?: string | null }): Promise<boolean> {
  const email = await digest('email', canonicalEmail(o.email));
  const google = o.googleSub ? await digest('google', o.googleSub) : null;
  const used = await queryOne(
    `SELECT 1 FROM trial_claims WHERE expires_at > now() AND ((kind = 'email' AND digest = $1) OR (kind = 'google' AND digest = $2)) LIMIT 1`,
    [email, google],
  );
  return !used;
}

/** ¿Esta tarjeta ya tuvo una prueba (o perdió una disputa)? */
export async function cardClaim(cardKey: string): Promise<{ claimed: boolean; disputed: boolean }> {
  const row = await queryOne<{ disputed: boolean }>(`SELECT disputed FROM trial_claims WHERE kind = 'card' AND digest = $1 AND expires_at > now()`, [await digest('card', cardKey)]);
  return { claimed: !!row, disputed: !!row?.disputed };
}

/** Las marcas de una prueba que empieza. Repetirlas no hace nada (la primera se queda). */
export async function recordTrialClaims(
  o: { accountId: string; email: string; googleSub?: string | null; cardKey?: string | null; provider: 'stripe' | 'mercadopago' },
  client?: pg.PoolClient,
): Promise<void> {
  const marks: [ClaimKind, string][] = [['email', canonicalEmail(o.email)]];
  if (o.googleSub) marks.push(['google', o.googleSub]);
  if (o.cardKey) marks.push(['card', o.cardKey]);
  for (const [kind, value] of marks) {
    const sql = `INSERT INTO trial_claims (kind, digest, account_id, provider) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, digest) DO NOTHING`;
    const params = [kind, await digest(kind, value), o.accountId, o.provider];
    if (client) await client.query(sql, params);
    else await query(sql, params);
  }
}
