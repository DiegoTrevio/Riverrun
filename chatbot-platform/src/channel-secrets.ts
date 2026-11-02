/**
 * INF-7: las credenciales de los canales (llave de Evolution, token del bot de Telegram, tokens y secreto de Meta,
 * contraseñas de IMAP y SMTP, secreto del webhook) se guardan cifradas en `channels.config`. El almacén las cifra al
 * escribir y las descifra al leer: el resto del código las sigue viendo en claro.
 */
import { query } from './db.js';
import { decryptSecret, encryptSecret, isSealed } from './secret.js';

export const SEALED_CHANNEL_FIELDS = ['api_key', 'bot_token', 'page_access_token', 'app_secret', 'imap_password', 'smtp_password', 'webhook_secret', 'secret', 'verify_token'] as const;

/** Para guardar: cada credencial en claro se cifra (las vacías y las ya cifradas quedan igual). */
export function sealChannelConfig<T extends Record<string, unknown> | undefined | null>(config: T): T {
  if (!config || typeof config !== 'object') return config;
  const out: Record<string, unknown> = { ...config };
  for (const k of SEALED_CHANNEL_FIELDS) {
    const v = out[k];
    if (typeof v === 'string' && v && !isSealed(v)) out[k] = encryptSecret(v);
  }
  return out as T;
}

/** Al leer: se descifran. Una que no se puede descifrar (llave perdida) queda vacía: el canal pide reconectar. */
export function openChannelConfig<T extends Record<string, unknown> | undefined | null>(config: T): T {
  if (!config || typeof config !== 'object') return config;
  const out: Record<string, unknown> = { ...config };
  for (const k of SEALED_CHANNEL_FIELDS) {
    const v = out[k];
    if (isSealed(v)) out[k] = decryptSecret(v) ?? '';
  }
  return out as T;
}

/** Al arrancar: cifra lo que quedó en claro de antes. Idempotente. */
export async function sealStoredChannelSecrets(): Promise<number> {
  const rows = await query<{ id: string; config: Record<string, unknown> }>(
    `SELECT id, config FROM channels WHERE ${SEALED_CHANNEL_FIELDS.map((k) => `(coalesce(config->>'${k}', '') <> '' AND config->>'${k}' !~ '^v[12]\\.')`).join(' OR ')}`,
  );
  for (const r of rows) {
    const patch = Object.fromEntries(SEALED_CHANNEL_FIELDS.filter((k) => typeof r.config[k] === 'string' && r.config[k] && !isSealed(r.config[k])).map((k) => [k, encryptSecret(String(r.config[k]))]));
    // Solo esas llaves: lo demás pudo cambiar mientras tanto.
    await query(`UPDATE channels SET config = config || $2::jsonb WHERE id = $1`, [r.id, JSON.stringify(patch)]);
  }
  return rows.length;
}
