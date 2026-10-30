/**
 * Vuelve a cifrar los secretos de la verificación en dos pasos (los activos y los pendientes) con un SESSION_SECRET
 * nuevo. `./riverrun rotate-secret` lo corre antes de cambiar .env, con el secreto nuevo por la entrada (así no queda en
 * la lista de procesos). Todo o nada: si alguno no se puede leer con el secreto actual, no cambia ninguno.
 */
import { pathToFileURL } from 'node:url';
import { pool, withTransaction } from '../db.js';
import { decryptSecret, encryptSecret } from '../secret.js';

/** Re-cifra con `newSecret` y devuelve a cuántas personas. */
export async function rekeyMfaSecrets(newSecret: string): Promise<number> {
  return withTransaction(async (db) => {
    const { rows } = await db.query<{ id: string; totp_secret: string | null; totp_pending: string | null }>(
      `SELECT id, totp_secret, totp_pending FROM users WHERE totp_secret IS NOT NULL OR totp_pending IS NOT NULL FOR UPDATE`,
    );
    // null: no tiene; undefined: no se pudo leer con el secreto actual.
    const rekey = (packed: string | null) => {
      if (packed === null) return null;
      const plain = decryptSecret(packed);
      return plain === null ? undefined : encryptSecret(plain, newSecret);
    };
    const next = rows.map((r) => ({ id: r.id, secret: rekey(r.totp_secret), pending: rekey(r.totp_pending) }));
    const broken = next.filter((r) => r.secret === undefined || r.pending === undefined).length;
    if (broken) throw new Error(`No se pudo re-cifrar el 2FA de ${broken} ${broken === 1 ? 'persona' : 'personas'}: no se cambió nada`);
    for (const r of next) await db.query(`UPDATE users SET totp_secret = $2, totp_pending = $3 WHERE id = $1`, [r.id, r.secret, r.pending]);
    return next.length;
  });
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const secret = (await readStdin()).trim();
    if (!secret) throw new Error('Falta el secreto nuevo en la entrada: no se cambió nada');
    console.log(`Secretos de verificación re-cifrados: ${await rekeyMfaSecrets(secret)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'No se pudieron re-cifrar los secretos de verificación');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
