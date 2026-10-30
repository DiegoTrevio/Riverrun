/**
 * Límites de intentos guardados en la base: los comparten todos los procesos y sobreviven a un reinicio (en memoria, un
 * reinicio los borraba y dos peticiones simultáneas podían pasar las dos). Cada clave lleva un contador que vuelve a 1
 * cuando vence su ventana; un solo INSERT … ON CONFLICT lo hace atómico.
 */
import { query, queryOne } from '../db.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Topes de acceso. Claves: `login-ip:<ipKey>`, `login-acct:<correo>`, `mfa-challenge:<reto>`, `mfa-user:<id>`. */
export const LIMITS = {
  loginIp: { max: 8, windowMs: 15 * MIN },
  loginAccount: { max: 10, windowMs: HOUR },
  codePerChallenge: 5,
  codePerUser: { max: 10, windowMs: HOUR },
  mfaLockMs: HOUR,
} as const;

/** Suma un intento y devuelve cuántos lleva la clave en su ventana. */
export async function countHit(key: string, windowMs: number): Promise<number> {
  const row = await queryOne<{ hits: number }>(
    `INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, 1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN rate_limits.expires_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
       expires_at = CASE WHEN rate_limits.expires_at <= now() THEN now() + make_interval(secs => $2) ELSE rate_limits.expires_at END
     RETURNING hits`,
    [key, windowMs / 1000],
  );
  return row!.hits;
}

/** Intentos de la clave en su ventana vigente (0 si no hay o ya venció). */
export async function hitsFor(key: string): Promise<number> {
  const row = await queryOne<{ hits: number }>(`SELECT hits FROM rate_limits WHERE key = $1 AND expires_at > now()`, [key]);
  return row?.hits ?? 0;
}

/** Devuelve un intento que se contó de más (entró, o se rechazó sin revisar nada). */
export async function releaseHit(key: string): Promise<void> {
  await query(`UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1`, [key]);
}

export async function clearHits(...keys: string[]): Promise<void> {
  if (keys.length) await query(`DELETE FROM rate_limits WHERE key = ANY($1::text[])`, [keys]);
}

/** Borra los contadores vencidos (tarea periódica). */
export async function pruneHits(): Promise<void> {
  await query(`DELETE FROM rate_limits WHERE expires_at <= now()`);
}
