import { config } from '../config.js';
import { hmac, safeEqual } from '../secret.js';

/**
 * URL pública y firmada de una imagen del catálogo. La necesitan las plataformas que
 * descargan la imagen por su cuenta (Messenger, Instagram) y el chat web.
 */
export function signedImageUrl(imageId: string, base = config.publicBaseUrl) {
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  return `${base}/media/${imageId}?e=${exp}&s=${hmac(`${imageId}:${exp}`)}`;
}

export function verifyImageSignature(imageId: string, exp: string, sig: string) {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, hmac(`${imageId}:${exp}`));
}
