/**
 * Códigos de la app de autenticación (TOTP, RFC 6238): SHA-1, 6 dígitos y pasos de 30 segundos, como los esperan Google
 * Authenticator, Microsoft Authenticator o 1Password. Se acepta el paso anterior y el siguiente (el reloj del teléfono
 * puede ir unos segundos desfasado); quien llama guarda el paso usado para que el mismo código no sirva dos veces.
 */
import crypto from 'node:crypto';

export const TOTP_PERIOD = 30;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) en mayúsculas y sin relleno: el formato del secreto en las apps. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Acepta minúsculas, espacios y relleno (como lo escribiría una persona). */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Clave base32 inválida');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 bytes aleatorios (160 bits, lo que recomienda el RFC 4226 para SHA-1). */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, '0');
}

/** El paso que coincide con el código (el actual, el anterior o el siguiente), o null. */
export function matchTotp(secret: string, code: string, now = Date.now()): number | null {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) return null;
  const s = currentStep(now);
  for (const step of [s, s - 1, s + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(digits))) return step;
  }
  return null;
}

/** La URI que lee la app al escanear el QR. */
export function otpauthUri(o: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(o.issuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(o.account)}?secret=${o.secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}
