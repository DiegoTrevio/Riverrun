import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { assertAccount, HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { ATTACHMENT_MAX_BYTES, attachmentAbsolutePath, identifyAttachment, newAttachmentId, removeAttachmentFile, saveAttachment } from '../attachments.js';
import * as astore from '../automation/store.js';
import { safeFileName } from '../channels/media.js';
import { logEvent } from '../logs.js';

/** Archivos (PDF, Word, audio, video…) que las automatizaciones y secuencias envían a los clientes. */
export async function attachmentRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  api.get('/api/attachments', async (req: any) => astore.listAttachments(scopeAccount(req.user, req.query.account_id)));

  api.post('/api/attachments', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    let upload: { buffer: Buffer; name: string } | undefined;
    for await (const part of req.parts({ limits: { fileSize: ATTACHMENT_MAX_BYTES } })) {
      if (part.type !== 'file') continue;
      const buffer: Buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(400, 'El archivo supera 16 MB');
      upload = { buffer, name: part.filename || 'archivo' };
    }
    if (!upload) throw new HttpError(400, 'Elige un archivo');
    const type = identifyAttachment(upload.buffer, upload.name);
    if (!type) {
      throw new HttpError(400, 'Tipo de archivo no permitido. Se aceptan PDF, Word, Excel, PowerPoint, CSV, TXT, audio (MP3, OGG, WAV, M4A), video (MP4, MOV, WebM) y fotos JPG, PNG o WEBP.');
    }
    const id = newAttachmentId();
    const rel = await saveAttachment(accountId, id, upload.buffer, type);
    const row = await astore.insertAttachment({ id, account_id: accountId, name: safeFileName(upload.name), mime: type.mime, kind: type.kind, size_bytes: upload.buffer.length, file_path: rel });
    await logEvent({ level: 'info', source: 'admin', message: `Archivo subido para automatizaciones: ${row?.name} (${type.kind}, ${Math.round(upload.buffer.length / 1024)} KB)`, accountId });
    return row;
  });

  /** Descarga o vista previa del archivo. Siempre como descarga y sin adivinar el tipo (nosniff). */
  api.get('/api/attachments/:id/file', async (req: any, reply) => {
    const a = assertAccount(req.user, await astore.getAttachment(req.params.id), 'Archivo no encontrado');
    const abs = attachmentAbsolutePath(a.file_path);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'El archivo ya no está guardado');
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(a.name))}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300');
    return reply.send(fs.createReadStream(abs));
  });

  api.delete('/api/attachments/:id', admins, async (req: any) => {
    const a = assertAccount(req.user, await astore.getAttachment(req.params.id), 'Archivo no encontrado');
    await astore.deleteAttachment(a.id);
    await removeAttachmentFile(a.file_path);
    return { ok: true };
  });
}
