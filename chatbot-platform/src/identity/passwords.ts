/**
 * Reglas para una contraseña nueva: de 12 a 128 caracteres, sin palabras del correo ni del negocio, fuera de las 100 000
 * más comunes (lista local, siempre disponible) y no filtrada según Have I Been Pwned. A HIBP solo sale el inicio del
 * hash (k-anonimato: 5 caracteres del SHA-1) y con relleno, así no se sabe ni cuál se consultó; si no responde a tiempo,
 * decide la lista local. Las contraseñas que ya existen no se revisan al entrar.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { logEvent } from '../logs.js';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const NewPassword = z.string().min(PASSWORD_MIN, 'mínimo 12 caracteres').max(PASSWORD_MAX, 'máximo 128 caracteres');

const here = path.dirname(fileURLToPath(import.meta.url));
let common: Set<string> | null = null;

/** Sirve igual desde src/ (desarrollo) que desde dist/ (la imagen copia assets/ junto a dist/). */
export function isCommonPassword(pw: string): boolean {
  common ??= new Set(zlib.gunzipSync(fs.readFileSync(path.resolve(here, '../../assets/common-passwords.txt.gz'))).toString('utf8').split('\n').filter(Boolean));
  return common.has(pw.toLowerCase());
}

/** Veces que aparece en filtraciones, o null si está apagado (`off`), si no responde en 1,5 s o si falla. */
export async function pwnedCount(pw: string, url = config.pwnedPasswordsUrl): Promise<number | null> {
  if (!url || url === 'off') return null;
  const hash = crypto.createHash('sha1').update(pw).digest('hex').toUpperCase();
  try {
    const res = await fetch(`${url}${hash.slice(0, 5)}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'riverrun-password-check' }, signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const line = (await res.text()).split('\n').find((l) => l.startsWith(`${hash.slice(5)}:`));
    return line ? Number(line.split(':')[1]) || 0 : 0;
  } catch (e: any) {
    await logEvent({ level: 'warn', source: 'system', message: `HIBP no respondió: decide la lista local (${e?.name === 'TimeoutError' ? 'tiempo agotado' : e?.message ?? e})` });
    return null;
  }
}

const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Palabras de 4 letras o más (de la parte local del correo y del nombre del negocio), sin acentos. */
const contextWords = (ctx: { email?: string; businessName?: string }) =>
  [ctx.email?.split('@')[0] ?? '', ctx.businessName ?? ''].flatMap((s) => plain(s).split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 4);

/** Qué tiene de malo una contraseña nueva, o null si se puede usar. */
export async function passwordIssue(pw: string, ctx: { email?: string; businessName?: string }, url = config.pwnedPasswordsUrl): Promise<string | null> {
  if (pw.length < PASSWORD_MIN) return 'La contraseña debe tener al menos 12 caracteres';
  if (pw.length > PASSWORD_MAX) return 'La contraseña puede tener hasta 128 caracteres';
  const p = plain(pw);
  if (contextWords(ctx).some((w) => p.includes(w))) return 'La contraseña no puede incluir tu correo ni el nombre de tu negocio';
  if (isCommonPassword(pw)) return 'Esta contraseña es de las más usadas: elige otra (una frase de 3 o 4 palabras funciona bien)';
  if (((await pwnedCount(pw, url)) ?? 0) > 0) return 'Esta contraseña apareció en filtraciones de datos: elige otra';
  return null;
}

export async function assertPasswordAllowed(pw: string, ctx: { email?: string; businessName?: string }): Promise<void> {
  const issue = await passwordIssue(pw, ctx);
  if (issue) throw new HttpError(400, issue);
}
