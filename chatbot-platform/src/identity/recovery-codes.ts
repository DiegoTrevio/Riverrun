/**
 * Códigos de recuperación: 10 de 12 caracteres (base32 de Crockford, unos 60 bits cada uno) para entrar si se pierde el
 * teléfono. Se guarda solo su SHA-256 y cada uno sirve una vez. Se aceptan como los escriba una persona: en mayúsculas,
 * con espacios o guiones, y con O por 0 o I/L por 1.
 */
import crypto from 'node:crypto';
import type pg from 'pg';
import { query, queryOne } from '../db.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LENGTH = 12;

export function newRecoveryCodes(n = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < n) {
    const raw = Array.from({ length: LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`);
  }
  return [...codes];
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
}

const hashOf = (code: string) => crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

/** Borra los anteriores y genera 10 nuevos; devuelve los códigos (la única vez que se ven). */
export async function replaceRecoveryCodes(userId: string, client?: pg.PoolClient): Promise<string[]> {
  const run = (text: string, params: unknown[]) => (client ? client.query(text, params) : query(text, params));
  const codes = newRecoveryCodes();
  await run(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  await run(`INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])`, [userId, codes.map(hashOf)]);
  return codes;
}

/** Usa un código (una sola vez, aunque lleguen dos peticiones a la vez). Devuelve cuántos quedan, o null si no sirvió. */
export async function useRecoveryCode(userId: string, input: string): Promise<number | null> {
  if (normalizeRecoveryCode(input).length !== LENGTH) return null;
  const used = await queryOne(
    `UPDATE user_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
    [userId, hashOf(input)],
  );
  return used ? remainingRecoveryCodes(userId) : null;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  return (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]))!.n;
}

export const isRecoveryCodeShape = (input: string) => normalizeRecoveryCode(input).length === LENGTH;
