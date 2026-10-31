/**
 * Revisión de un ZIP (Word, Excel…) antes de abrirlo con PizZip: cuántas partes tiene y cuánto pesan **descomprimidas
 * de verdad**. PizZip lee el índice completo al abrir y descomprime cada parte entera antes de comparar con el tamaño que
 * el propio archivo declara, así que un .docx de 200 KB que dice pesar 400 B se infla a 200 MB (o a gigas) sin freno.
 * Aquí el índice se lee a mano, se corta al pasar el número de partes, y cada parte se descomprime con un tope.
 */
import zlib from 'node:zlib';

export interface ZipLimits {
  maxEntries: number;
  /** Sin estos dos solo se cuentan las partes (no se descomprime nada). */
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export const ZIP_DAMAGED = 'El archivo está dañado o no es un Word (.docx)';
export const ZIP_TOO_MANY = 'El archivo tiene demasiadas partes internas';
export const ZIP_TOO_BIG = 'El archivo descomprimido es demasiado grande';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Devuelve el problema (con el texto para la persona) o `null` si el archivo cabe en los límites. */
export function checkZip(buffer: Buffer, o: ZipLimits): string | null {
  // El fin del índice está en los últimos 22 bytes más un comentario de hasta 64 KB.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return ZIP_DAMAGED;
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 (más de 65 535 partes o de 4 GB): un Word no lo necesita.
  if (count === 0xffff || cdOffset === 0xffffffff) return ZIP_TOO_MANY;
  if (count > o.maxEntries) return ZIP_TOO_MANY;
  const measure = o.maxEntryBytes !== undefined && o.maxTotalBytes !== undefined;
  let pos = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL) return ZIP_DAMAGED;
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    pos += 46 + nameLen + extraLen + commentLen;
    if (!measure) continue;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) return ZIP_DAMAGED;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) return ZIP_DAMAGED;
    const raw = buffer.subarray(start, start + compressed);
    // Lo más que puede crecer esta parte: su tope, o lo que queda del total.
    const room = Math.min(o.maxEntryBytes!, o.maxTotalBytes! - total);
    let size: number;
    if (method === 0) size = raw.length;
    else if (method === 8) {
      try {
        size = zlib.inflateRawSync(raw, { maxOutputLength: room + 1 }).length;
      } catch (e: any) {
        // Pasó el tope (se deja de descomprimir ahí) o los datos están rotos.
        return e?.code === 'ERR_BUFFER_TOO_LARGE' ? ZIP_TOO_BIG : ZIP_DAMAGED;
      }
    } else return ZIP_DAMAGED;
    if (size > room) return ZIP_TOO_BIG;
    total += size;
  }
  return null;
}
