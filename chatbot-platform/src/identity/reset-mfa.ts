/**
 * Borra la verificación en dos pasos de alguien (la app, la pendiente, los códigos de recuperación, los dispositivos
 * recordados y el bloqueo por códigos equivocados): la configura otra vez la próxima vez que entra. Sus sesiones las
 * cierra quien llama. Sin importar auth.ts: lo usan «Restablecer 2FA» en Equipo y `./riverrun admin-password`.
 */
import { query } from '../db.js';
import { clearHits } from './rate-limit.js';

export async function resetMfa(userId: string): Promise<void> {
  await query(
    `UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = 0, mfa_locked_until = NULL, updated_at = now() WHERE id = $1`,
    [userId],
  );
  await query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  await query(`UPDATE user_devices SET trust_hash = NULL, trusted_until = NULL WHERE user_id = $1 AND trust_hash IS NOT NULL`, [userId]);
  await clearHits(`mfa-user:${userId}`);
}
