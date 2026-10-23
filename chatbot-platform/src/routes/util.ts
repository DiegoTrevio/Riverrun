import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { completeImage, sniffMime } from '../files.js';
import { ATTACHMENT_MAX_BYTES, identifyAttachment } from '../attachments.js';
import type { LibraryKind } from '../types.js';
import { deepClean } from '../engine/text.js';
import { logEvent } from '../logs.js';
import { safeFileName } from '../channels/media.js';

export { completeImage };

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(deepClean(body ?? {}));
  if (!r.success) throw new HttpError(400, 'Datos inválidos', r.error.issues.map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`));
  return r.data;
}

/** Errores de la API en un formato único: { error, issues? }. */
export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler(async (err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, issues: err.issues });
    if (err?.code === '23505') return reply.code(409).send({ error: uniqueMessage(err) });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    await logEvent({ level: 'error', source: 'system', message: `Error en ${req.method} ${req.url.split('?')[0]}: ${err?.message ?? err}`, details: err });
    return reply.code(500).send({ error: 'Error interno (revisa los registros)' });
  });
}

function uniqueMessage(e: any) {
  const c = String(e.constraint ?? '');
  if (c.includes('instance')) return 'Esa instancia de Evolution ya la usa otro canal';
  if (c.includes('images')) return 'Ya existe una imagen con ese ID en este chatbot';
  if (c.includes('users_email')) return 'Ya existe un usuario con ese correo';
  return 'Valor duplicado';
}

/* ------------------------------ Subida de fotos y archivos ------------------------------ */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // límite de WhatsApp para imágenes
const mb = (n: number) => `${n / 1024 / 1024} MB`;

export interface UploadFile {
  buffer: Buffer;
  mime: string;
  ext: string;
  /** Huella SHA-256 de los bytes tal como se subieron. */
  sha256: string;
  /** Foto, video, documento o audio, según los bytes (no la extensión). */
  kind: LibraryKind;
  /** Nombre original (sin ruta), para que el cliente reciba el documento con un nombre reconocible. */
  fileName: string;
}

/**
 * Lee el formulario de la biblioteca del agente: fotos (JPG, PNG, WEBP; 5 MB), videos (MP4, MOV, WEBM), documentos
 * (PDF, Word, Excel, PowerPoint, CSV, TXT) y audio, hasta 16 MB. El tipo sale de los bytes; HTML, SVG, ejecutables y
 * comprimidos se rechazan.
 */
export async function readUpload(req: any): Promise<{ fields: Record<string, unknown>; file?: UploadFile }> {
  const fields: Record<string, unknown> = {};
  let file: UploadFile | undefined;
  for await (const part of req.parts({ limits: { fileSize: ATTACHMENT_MAX_BYTES } })) {
    if (part.type === 'file') {
      const buffer: Buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(400, `El archivo supera ${mb(ATTACHMENT_MAX_BYTES)}`);
      const fileName = path.basename(String(part.filename ?? '')).slice(0, 120);
      const type = identifyAttachment(buffer, fileName);
      if (!type) throw new HttpError(400, 'Formato no válido: usa una foto (JPG, PNG, WEBP), un video (MP4, MOV, WEBM), un documento (PDF, Word, Excel, PowerPoint, CSV, TXT) o un audio (MP3, OGG, M4A, WAV)');
      if (type.kind === 'image') {
        if (buffer.length > MAX_IMAGE_BYTES) throw new HttpError(400, `La foto supera ${mb(MAX_IMAGE_BYTES)}`);
        const mime = sniffMime(buffer);
        if (!completeImage(buffer, mime)) throw new HttpError(400, 'La imagen llegó incompleta o dañada: vuelve a exportarla y súbela de nuevo');
      }
      file = { buffer, mime: type.mime, ext: type.ext, kind: type.kind, fileName, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
    } else {
      const v = part.value;
      fields[part.fieldname] = v === 'true' ? true : v === 'false' ? false : v;
    }
  }
  return { fields, file };
}

export async function saveFile(chatbotId: string, file: UploadFile) {
  const dir = path.join(config.uploadsDir, chatbotId);
  await fsp.mkdir(dir, { recursive: true });
  const rel = path.join(chatbotId, `${crypto.randomUUID()}${file.ext}`);
  await fsp.writeFile(path.join(config.uploadsDir, rel), file.buffer);
  return rel;
}

/** Content-Disposition con el nombre en UTF-8 (acentos, emoji, otros alfabetos) y una versión ASCII de respaldo. */
export function dispositionHeader(name: string, inline = false) {
  const safe = safeFileName(name);
  const ascii = safe.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'archivo';
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Envía un archivo con soporte de rangos (Range: bytes=…): Safari en iPhone solo reproduce videos así, y un video largo
 * se puede adelantar sin descargarlo completo.
 */
export function sendRanged(req: FastifyRequest, reply: FastifyReply, abs: string) {
  const size = fs.statSync(abs).size;
  reply.header('accept-ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (!m || (!m[1] && !m[2])) return reply.header('content-length', size).send(fs.createReadStream(abs));
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = Math.min(m[1] && m[2] ? Number(m[2]) : size - 1, size - 1);
  if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
  return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(fs.createReadStream(abs, { start, end }));
}
