/**
 * INF-6: vuelve a cifrar con una llave de datos (DATA_KEY) todo lo cifrado en la base: el 2FA (activo y pendiente), los
 * permisos de Google Calendar y Outlook (de la cuenta y de cada persona), las llaves de la plataforma y las credenciales
 * de los canales. Lee con las llaves que tiene el proceso (SESSION_SECRET para lo de antes, DATA_KEY y DATA_KEYS_OLD).
 *
 * Cifra con la DATA_KEY del proceso. `./riverrun rotate-secret` lo corre antes de cambiar SESSION_SECRET (así nada depende
 * de él); `./riverrun rotate-data-key` primero arranca el backend con la llave nueva (y la anterior en DATA_KEYS_OLD, que
 * sigue descifrando) y después lo corre: en ningún momento el backend deja de poder leer lo guardado.
 *
 * Todo en una transacción. Si un 2FA no se puede leer, no cambia nada (esa persona quedaría fuera). Un permiso de
 * calendario o una credencial que ya no se puede leer (se perdió su llave) se deja como está y se cuenta: hay que
 * volver a conectarlo de todos modos.
 */
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { SEALED_CHANNEL_FIELDS } from '../channel-secrets.js';
import { decryptSecret, encryptSecret, isSealed } from '../secret.js';

export interface RekeyResult { rekeyed: number; unreadable: number }

const SIMPLE: { table: string; key: string; column: string }[] = [
  { table: 'google_calendar', key: 'account_id', column: 'refresh_token' },
  { table: 'outlook_calendar', key: 'account_id', column: 'refresh_token' },
  { table: 'staff_calendars', key: 'user_id', column: 'refresh_token' },
  { table: 'platform_secrets', key: 'key', column: 'value' },
];

export async function rekeySecrets(target: string): Promise<RekeyResult> {
  if (target.length < 32) throw new Error('La llave de datos debe tener al menos 32 caracteres: no se cambió nada');
  const using = { dataKey: target };
  return withTransaction(async (db: pg.PoolClient) => {
    let rekeyed = 0, unreadable = 0;

    // 2FA: todo o nada.
    const users = (await db.query<{ id: string; totp_secret: string | null; totp_pending: string | null }>(
      `SELECT id, totp_secret, totp_pending FROM users WHERE totp_secret IS NOT NULL OR totp_pending IS NOT NULL FOR UPDATE`)).rows;
    const mfa = (packed: string | null) => {
      if (packed === null) return null;
      const plain = decryptSecret(packed);
      return plain === null ? undefined : encryptSecret(plain, using);
    };
    const next = users.map((r) => ({ id: r.id, secret: mfa(r.totp_secret), pending: mfa(r.totp_pending) }));
    const broken = next.filter((r) => r.secret === undefined || r.pending === undefined).length;
    if (broken) throw new Error(`No se pudo re-cifrar el 2FA de ${broken} ${broken === 1 ? 'persona' : 'personas'}: no se cambió nada`);
    for (const r of next) await db.query(`UPDATE users SET totp_secret = $2, totp_pending = $3 WHERE id = $1`, [r.id, r.secret, r.pending]);
    rekeyed += next.length;

    for (const s of SIMPLE) {
      const exists = (await db.query(`SELECT to_regclass($1) AS t`, [s.table])).rows[0].t;
      if (!exists) continue;
      const rows = (await db.query(`SELECT ${s.key} AS k, ${s.column} AS v FROM ${s.table} WHERE coalesce(${s.column}, '') <> '' FOR UPDATE`)).rows as { k: string; v: string }[];
      for (const r of rows) {
        const plain = decryptSecret(r.v);
        if (plain === null) { unreadable++; continue; }
        await db.query(`UPDATE ${s.table} SET ${s.column} = $2 WHERE ${s.key} = $1`, [r.k, encryptSecret(plain, using)]);
        rekeyed++;
      }
    }

    // Credenciales de canales (también las que quedaron en claro de antes).
    const channels = (await db.query<{ id: string; config: Record<string, unknown> }>(`SELECT id, config FROM channels FOR UPDATE`)).rows;
    for (const ch of channels) {
      const patch: Record<string, string> = {};
      for (const k of SEALED_CHANNEL_FIELDS) {
        const v = ch.config?.[k];
        if (typeof v !== 'string' || !v) continue;
        const plain = isSealed(v) ? decryptSecret(v) : v;
        if (plain === null) { unreadable++; continue; }
        patch[k] = encryptSecret(plain, using);
      }
      if (Object.keys(patch).length) {
        await db.query(`UPDATE channels SET config = config || $2::jsonb WHERE id = $1`, [ch.id, JSON.stringify(patch)]);
        rekeyed += Object.keys(patch).length;
      }
    }
    return { rekeyed, unreadable };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!config.dataKey) throw new Error('Falta DATA_KEY en el entorno del backend: no se cambió nada');
    const r = await rekeySecrets(config.dataKey);
    console.log(`Secretos re-cifrados: ${r.rekeyed}${r.unreadable ? `; ${r.unreadable} ya no se podían leer (hay que volver a conectarlos)` : ''}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'No se pudieron re-cifrar los secretos');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
