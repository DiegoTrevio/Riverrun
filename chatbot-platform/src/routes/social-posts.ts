import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { ATTACHMENT_MAX_BYTES } from '../attachments.js';
import { ZernioBusyError } from '../channels/zernio-budget.js';
import { ZernioError, zernioEnabled } from '../channels/zernio.js';
import { queryOne } from '../db.js';
import {
  cancelPublication, createPublication, deletePublication, getPublication, ListFilterSchema, listPublications, retryPublication, updatePublication, uploadMedia,
} from '../social/posts.js';
import type { User } from '../types.js';
import { parse } from './util.js';

/** Publicaciones en las redes (Zernio): solo el administrador del negocio publica a su nombre. */

const idParam = (req: any) => parse(z.object({ id: z.string().uuid() }), req.params).id;

/** Negocio de la publicación: el del usuario o, para el administrador de la plataforma, el de la fila. */
async function accountFor(user: User, id: string): Promise<string> {
  if (user.role !== 'superadmin') {
    if (!user.account_id) throw new HttpError(403, 'Tu usuario no tiene un perfil asignado');
    return user.account_id;
  }
  const row = await queryOne<{ account_id: string }>(`SELECT account_id FROM social_publications WHERE id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Publicación no encontrada');
  return row.account_id;
}

const on = () => {
  if (!zernioEnabled()) throw new HttpError(400, 'Las redes sociales no están activadas en esta instalación.');
};

export async function socialPostRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  api.get('/api/social-publications', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query?.account_id);
    return listPublications(accountId, parse(ListFilterSchema, { month: req.query?.month }));
  });

  api.get('/api/social-publications/:id', admins, async (req: any) => {
    const id = idParam(req);
    return getPublication(await accountFor(req.user, id), id);
  });

  api.post('/api/social-publications', admins, async (req: any) => {
    on();
    const { account_id, ...body } = req.body ?? {};
    return createPublication(await targetAccount(req.user, account_id ?? req.query?.account_id), req.user.id, body);
  });

  api.put('/api/social-publications/:id', admins, async (req: any) => {
    on();
    const id = idParam(req);
    const { account_id: _ignored, ...body } = req.body ?? {};
    return updatePublication(await accountFor(req.user, id), req.user.id, id, body);
  });

  api.post('/api/social-publications/:id/cancel', admins, async (req: any) => {
    const id = idParam(req);
    return cancelPublication(await accountFor(req.user, id), id);
  });

  api.post('/api/social-publications/:id/retry', admins, async (req: any) => {
    on();
    const id = idParam(req);
    return retryPublication(await accountFor(req.user, id), id);
  });

  api.delete('/api/social-publications/:id', admins, async (req: any) => {
    const id = idParam(req);
    return deletePublication(await accountFor(req.user, id), id);
  });

  /** Foto o video para una publicación: se revisa su tipo real y se sube a Zernio. */
  api.post('/api/social-media', admins, async (req: any) => {
    on();
    const accountId = await targetAccount(req.user, req.query?.account_id);
    if (!req.isMultipart?.()) throw new HttpError(400, 'Sube un archivo');
    // Cada archivo ocupa lugar en el límite compartido de Zernio: un tope por negocio.
    if (rateLimited(`social-media:${accountId}`, 60, 60 * 60_000)) throw new HttpError(429, 'Subiste muchos archivos en la última hora; espera un poco.');
    let file: { buffer: Buffer; name: string } | null = null;
    for await (const part of req.parts({ limits: { fileSize: ATTACHMENT_MAX_BYTES } })) {
      if (part.type !== 'file') continue;
      const buffer: Buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(400, `El archivo supera ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB`);
      file = { buffer, name: String(part.filename ?? 'archivo') };
    }
    if (!file) throw new HttpError(400, 'Sube un archivo');
    try {
      return await uploadMedia(accountId, file.buffer, file.name);
    } catch (e) {
      if (e instanceof ZernioBusyError) throw new HttpError(503, 'Zernio está ocupado en este momento; inténtalo de nuevo en un minuto.');
      if (e instanceof ZernioError || /subir el archivo/.test(String((e as Error)?.message))) throw new HttpError(502, 'No se pudo subir el archivo a la red; inténtalo de nuevo.');
      throw e;
    }
  });
}
