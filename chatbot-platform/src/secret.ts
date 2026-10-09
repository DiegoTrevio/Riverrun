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

/** Cifrado simétrico (AES-256-GCM) para guardar secretos de terceros (p. ej. el token de Google) en la base. */
function encKey() {
  return crypto.createHash('sha256').update(`riverrun-secrets:${appSecret()}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

/** null si está dañado o si cambió SESSION_SECRET (hay que volver a conectar). */
export function decryptSecret(packed: string): string | null {
  try {
    const [v, iv, tag, data] = packed.split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
