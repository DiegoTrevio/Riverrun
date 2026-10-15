import { query } from './db.js';
import { logEvent } from './logs.js';
import { decryptSecret, encryptSecret } from './secret.js';

/**
 * Llaves de la plataforma que el superadministrador guarda desde el panel (por ejemplo la de Zernio): cifradas en la
 * base y en memoria en cada proceso (http y worker), que se refresca cada minuto. Una variable de entorno con el mismo
 * propósito siempre tiene prioridad: quien administra el servidor manda.
 */
const cache = new Map<string, string>();
let timer: NodeJS.Timeout | null = null;
/** Cambia con cada guardado o borrado: una recarga que empezó antes no pisa el cambio. */
let version = 0;
const warned = new Set<string>();

export async function loadPlatformSecrets(): Promise<void> {
  const started = version;
  const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM platform_secrets`).catch(() => null);
  if (!rows || started !== version) return; // Base no disponible, sin migrar o con un cambio en curso: se conserva lo que había.
  cache.clear();
  for (const r of rows) {
    const plain = decryptSecret(r.value);
    if (plain) cache.set(r.key, plain);
    else if (!warned.has(r.key)) {
      warned.add(r.key);
      // Cambió la clave del servidor (SESSION_SECRET): hay que volver a guardar la llave en el panel.
      void logEvent({ level: 'error', source: 'system', message: `No se pudo descifrar la llave "${r.key}" guardada en el panel: vuelve a guardarla en Sistema` }).catch(() => undefined);
    }
  }
}

export const platformSecret = (key: string) => cache.get(key) ?? '';

export async function savePlatformSecret(key: string, plain: string, userId: string | null): Promise<void> {
  await query(`INSERT INTO platform_secrets (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`, [key, encryptSecret(plain), userId]);
  version++;
  warned.delete(key);
  cache.set(key, plain);
}

export async function removePlatformSecret(key: string): Promise<void> {
  await query(`DELETE FROM platform_secrets WHERE key = $1`, [key]);
  version++;
  cache.delete(key);
}

export async function platformSecretInfo(key: string): Promise<{ updated_at: string | null }> {
  const rows = await query<{ updated_at: string }>(`SELECT updated_at FROM platform_secrets WHERE key = $1`, [key]).catch(() => []);
  return { updated_at: rows[0]?.updated_at ?? null };
}

/** Los cambios hechos desde otro proceso llegan en menos de un minuto. */
export function startPlatformSecretsRefresh(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => void loadPlatformSecrets(), intervalMs);
  timer.unref();
}

export function stopPlatformSecretsRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}
