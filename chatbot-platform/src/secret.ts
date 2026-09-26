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
