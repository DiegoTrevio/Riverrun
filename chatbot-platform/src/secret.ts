import crypto from 'node:crypto';
import { config } from './config.js';

// Sin SESSION_SECRET se usa uno aleatorio (las sesiones y enlaces firmados caducan al reiniciar), nunca uno fijo.
const fallback = crypto.randomBytes(32).toString('hex');

export function appSecret() {
  return config.sessionSecret || fallback;
}

export function hmac(data: string, key = appSecret()) {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Cifrado simétrico (AES-256-GCM) para guardar secretos de terceros en la base.
 *
 * INF-6: dos formatos. `v1.<iv>.<tag>.<datos>` usa una llave derivada de SESSION_SECRET (el de antes). `v2.<kid>.<iv>.
 * <tag>.<datos>` usa DATA_KEY, con el identificador de la llave (`kid`): al rotarla, la anterior va a DATA_KEYS_OLD y sigue
 * descifrando hasta que `rekey-secrets` vuelve a cifrar todo con la nueva. Con DATA_KEY, cambiar SESSION_SECRET ya no
 * rompe los tokens guardados.
 */
function encKey(secret: string) {
  return crypto.createHash('sha256').update(`riverrun-secrets:${secret}`).digest();
}
function dataKey(secret: string) {
  return crypto.createHash('sha256').update(`riverrun-data-key:${secret}`).digest();
}
/** Identificador corto de una llave de datos (no revela la llave). */
export function keyId(secret: string) {
  return crypto.createHash('sha256').update(`riverrun-kid:${secret}`).digest('hex').slice(0, 8);
}

/** Con qué se cifra: `{ dataKey }` (v2) o `{ session }` (v1). Por omisión, DATA_KEY si existe. */
export type SealWith = { dataKey: string } | { session: string };
const current = (): SealWith => (config.dataKey ? { dataKey: config.dataKey } : { session: appSecret() });

/** Un texto ya cifrado por `encryptSecret` (cualquier versión). */
export const isSealed = (v: unknown): v is string => typeof v === 'string' && /^v[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]*)?$/.test(v);

/** `using` como texto: una llave de sesión (formato v1, el de antes). */
export function encryptSecret(plain: string, usingArg: SealWith | string = current()): string {
  const using: SealWith = typeof usingArg === 'string' ? { session: usingArg } : usingArg;
  const iv = crypto.randomBytes(12);
  const v2 = 'dataKey' in using;
  const c = crypto.createCipheriv('aes-256-gcm', v2 ? dataKey(using.dataKey) : encKey(using.session), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const body = `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  return v2 ? `v2.${keyId(using.dataKey)}.${body}` : `v1.${body}`;
}

function open(key: Buffer, iv: string, tag: string, data: string): string | null {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** null si está dañado o si no se tiene la llave con la que se cifró (hay que volver a conectar). */
export function decryptSecret(packed: string, keysArg: { session?: string; dataKeys?: string[] } | string = {}): string | null {
  const keys = typeof keysArg === 'string' ? { session: keysArg } : keysArg;
  const parts = String(packed ?? '').split('.');
  if (parts[0] === 'v1' && parts.length === 4) return open(encKey(keys.session ?? appSecret()), parts[1], parts[2], parts[3]);
  if (parts[0] === 'v2' && parts.length === 5) {
    const ring = keys.dataKeys ?? [config.dataKey, ...config.dataKeysOld].filter(Boolean);
    const key = ring.find((k) => keyId(k) === parts[1]);
    return key ? open(dataKey(key), parts[2], parts[3], parts[4]) : null;
  }
  return null;
}

/** Ya está cifrado con la llave actual (no hace falta volver a cifrarlo). */
export const sealedWithCurrent = (packed: string) =>
  config.dataKey ? packed.startsWith(`v2.${keyId(config.dataKey)}.`) : packed.startsWith('v1.');
