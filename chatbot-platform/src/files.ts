import crypto from 'node:crypto';

/** Detecta el tipo real por la firma del archivo (no confiar en la extensión ni en lo que declare quien lo envía). */
export function sniffMime(b: Buffer): string {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.length > 5 && b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * Una foto con cabecera válida pero cortada (subida interrumpida) no es una foto completa.
 * PNG termina en el bloque IEND, JPEG tiene el marcador de fin FFD9 y WEBP declara su tamaño en la cabecera.
 */
export function completeImage(b: Buffer, mime: string): boolean {
  if (mime === 'image/png') return b.length > 20 && b.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
  if (mime === 'image/jpeg') return b.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2;
  if (mime === 'image/webp') return b.length >= 12 && b.readUInt32LE(4) === b.length - 8;
  return false;
}

/** Un PDF completo termina con su marca %%EOF (suele estar en los últimos bytes). Otros formatos no se pueden comprobar. */
export function completeFile(b: Buffer, mime: string): boolean {
  if (mime.startsWith('image/')) return completeImage(b, mime);
  if (mime === 'application/pdf') return b.subarray(Math.max(0, b.length - 1024)).includes('%%EOF');
  return true;
}

export function sha256Hex(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}
