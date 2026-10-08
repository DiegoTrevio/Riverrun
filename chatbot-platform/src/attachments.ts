import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { INBOUND_MEDIA_MAX_BYTES } from './channels/media.js';
import { config } from './config.js';

/** Archivos que se envían por automatizaciones y secuencias. Mismo tope que los medios que llegan del cliente. */
export const ATTACHMENT_MAX_BYTES = INBOUND_MEDIA_MAX_BYTES;

export type AttachmentKind = 'image' | 'document' | 'audio' | 'video';
export interface AttachmentType {
  mime: string;
  kind: AttachmentKind;
  ext: string;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // Word, Excel y PowerPoint antiguos
const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // Office moderno (.docx, .xlsx, .pptx): también es un ZIP
const EBML_SIG = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // WebM

/** Office antiguo y moderno: la firma es común, así que la extensión elige el tipo (solo esas extensiones se aceptan). */
const OLD_OFFICE: Record<string, string> = {
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};
const OOXML: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Texto plano (CSV, TXT): UTF-8 sin bytes nulos, y sin HTML ni XML disfrazado de texto. */
function isPlainText(b: Buffer): boolean {
  const head = b.subarray(0, 8192);
  if (head.includes(0)) return false;
  const text = head.toString('utf8');
  if (text.includes('�')) return false;
  return !/^\s*</.test(text);
}

/**
 * Tipo real del archivo por su firma, no por la extensión ni por lo que declare quien lo sube.
 * Rechaza HTML/SVG, scripts, ejecutables y archivos comprimidos: no se mandan a un cliente.
 */
export function identifyAttachment(b: Buffer, fileName: string): AttachmentType | null {
  const ext = path.extname(fileName).toLowerCase();
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', kind: 'image', ext: '.jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return { mime: 'image/png', kind: 'image', ext: '.png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image', ext: '.webp' };
  if (ascii(0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'document', ext: '.pdf' };
  if (b.length >= 8 && b.subarray(0, 8).equals(OLE_SIG) && OLD_OFFICE[ext]) return { mime: OLD_OFFICE[ext], kind: 'document', ext };
  if (b.length >= 4 && b.subarray(0, 4).equals(ZIP_SIG) && OOXML[ext]) return { mime: OOXML[ext], kind: 'document', ext };
  if (ascii(0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio', ext: '.ogg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio', ext: '.wav' };
  if (ascii(0, 3) === 'ID3' || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', kind: 'audio', ext: '.mp3' };
  if (ascii(4, 8) === 'ftyp') {
    if (ext === '.m4a') return { mime: 'audio/mp4', kind: 'audio', ext: '.m4a' };
    if (ext === '.mov') return { mime: 'video/quicktime', kind: 'video', ext: '.mov' };
    return { mime: 'video/mp4', kind: 'video', ext: '.mp4' };
  }
  if (b.length >= 4 && b.subarray(0, 4).equals(EBML_SIG)) return { mime: 'video/webm', kind: 'video', ext: '.webm' };
  if ((ext === '.csv' || ext === '.txt') && isPlainText(b)) return { mime: ext === '.csv' ? 'text/csv' : 'text/plain', kind: 'document', ext };
  return null;
}

/** Ruta absoluta de un archivo guardado, dentro de la carpeta de subidas (nunca fuera). */
export function attachmentAbsolutePath(rel: string): string {
  const root = path.resolve(config.uploadsDir);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error('Ruta de archivo no válida');
  return abs;
}

/** Guarda los bytes con un nombre aleatorio dentro de la carpeta de la cuenta. Devuelve la ruta relativa. */
export async function saveAttachment(accountId: string, id: string, buffer: Buffer, type: AttachmentType): Promise<string> {
  const rel = path.posix.join(accountId, 'attachments', `${id}${type.ext}`);
  const abs = attachmentAbsolutePath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer, { flag: 'wx' });
  return rel;
}

export async function removeAttachmentFile(rel: string): Promise<void> {
  await fs.rm(attachmentAbsolutePath(rel), { force: true }).catch(() => undefined);
}

export const newAttachmentId = () => crypto.randomUUID();
