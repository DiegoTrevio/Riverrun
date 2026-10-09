import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { completeFile, sha256Hex, sniffMime } from '../files.js';
import { truncateChars } from '../engine/text.js';
import { logEvent } from '../logs.js';
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

/** Tamaño máximo de una foto o documento del cliente (WhatsApp limita las fotos a 16 MB). Lo que pesa más no se descarga. */
export const INBOUND_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/** Archivo de un cliente ya guardado en disco, con lo necesario para comprobarlo después. */
export interface StoredMedia {
  kind: 'image' | 'document';
  /** Ruta relativa a UPLOADS_DIR (siempre empieza con "inbound/"). */
  file_path: string;
  /** Tipo según los bytes, no según lo que declaró la plataforma. */
  mime: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  /** false si el archivo parece cortado (una foto o PDF sin su final). */
  complete: boolean;
}

const EXT_BY_MIME: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

/** Nombre para descargar: sin rutas ni caracteres de control, con un máximo de 120 caracteres. */
export function safeFileName(name: string): string {
  const clean = name.replace(/[\\/\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return truncateChars(clean, 120) || 'archivo';
}

/**
 * Guarda el archivo tal como llegó (bytes originales, sin recodificar) en una ruta nueva y devuelve su huella.
 * Nunca sobrescribe: cada archivo tiene un nombre aleatorio.
 */
export async function saveInboundMedia(accountId: string, kind: StoredMedia['kind'], buffer: Buffer, declaredName: string): Promise<StoredMedia> {
  const mime = sniffMime(buffer);
  const declaredExt = path.extname(declaredName).toLowerCase();
  const ext = EXT_BY_MIME[mime] ?? (/^\.[a-z0-9]{1,8}$/.test(declaredExt) ? declaredExt : '.bin');
  const rel = path.posix.join('inbound', accountId, `${crypto.randomUUID()}${ext}`);
  const abs = path.join(config.uploadsDir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, buffer, { flag: 'wx' });
  return {
    kind,
    file_path: rel,
    mime,
    file_name: safeFileName(declaredName),
    size_bytes: buffer.length,
    sha256: sha256Hex(buffer),
    complete: completeFile(buffer, mime),
  };
}

/** Ruta absoluta de un archivo recibido, solo si está dentro de su carpeta. */
export function inboundAbsolutePath(filePath: string): string | null {
  if (!filePath.startsWith('inbound/') || filePath.includes('..')) return null;
  return path.join(config.uploadsDir, filePath);
}

/** Borra archivos recibidos (retención, borrado del contacto). Un fallo se registra; no detiene la limpieza del resto. */
export async function removeInboundFiles(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    const abs = inboundAbsolutePath(filePath);
    if (!abs) continue;
    try {
      await fsp.rm(abs, { force: true });
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'system', message: `No se pudo borrar un archivo recibido (${path.basename(filePath)}): ${e?.message ?? e}` });
    }
  }
}

/** Borra todas las fotos y documentos de una cuenta eliminada (la base de datos ya no los referencia). */
export async function removeInboundAccountFiles(accountId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return;
  try {
    await fsp.rm(path.join(config.uploadsDir, 'inbound', accountId), { recursive: true, force: true });
  } catch (e: any) {
    await logEvent({ level: 'error', source: 'system', message: `No se pudieron borrar los archivos recibidos de una cuenta eliminada: ${e?.message ?? e}` });
  }
}
