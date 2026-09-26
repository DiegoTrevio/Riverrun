import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { logEvent } from '../logs.js';

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
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

/* ------------------------------ Subida de imágenes ------------------------------ */

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // límite de WhatsApp para imágenes

export interface UploadFile {
  buffer: Buffer;
  mime: string;
  ext: string;
}

export async function readUpload(req: any): Promise<{ fields: Record<string, unknown>; file?: UploadFile }> {
  const fields: Record<string, unknown> = {};
  let file: UploadFile | undefined;
  for await (const part of req.parts({ limits: { fileSize: MAX_IMAGE_BYTES } })) {
    if (part.type === 'file') {
      const buffer: Buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(400, 'La imagen supera 5 MB');
      const mime = sniffImage(buffer);
      if (!mime || !ALLOWED_MIME.includes(mime)) throw new HttpError(400, 'Formato no válido: usa JPG, PNG o WEBP');
      file = { buffer, mime, ext: mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg' };
    } else {
      const v = part.value;
      fields[part.fieldname] = v === 'true' ? true : v === 'false' ? false : v;
    }
  }
  return { fields, file };
}

/** Detecta el tipo real por la firma del archivo (no confiar en la extensión). */
function sniffImage(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export async function saveFile(chatbotId: string, file: UploadFile) {
  const dir = path.join(config.uploadsDir, chatbotId);
  await fsp.mkdir(dir, { recursive: true });
  const rel = path.join(chatbotId, `${crypto.randomUUID()}${file.ext}`);
  await fsp.writeFile(path.join(config.uploadsDir, rel), file.buffer);
  return rel;
}
