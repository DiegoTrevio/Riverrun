import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { ZernioBusyError } from '../channels/zernio-budget.js';
import { zernioEnabled } from '../channels/zernio.js';
import { query, queryOne } from '../db.js';
import type { ChatService } from '../service.js';
import {
  deleteComment, ignore, InboxFilterSchema, listInbox, privateReply, replyComment, replyReview, saveCommentSettings, setHidden, setLiked, settingsOf, syncEngagement,
  type Kind,
} from '../social/engagement.js';
import { suggestReply } from '../social/replies.js';
import type { User } from '../types.js';
import { parse } from './util.js';

/**
 * Comentarios y reseñas de las redes (Zernio): la bandeja del negocio y sus acciones. Quien atiende (también el agente)
 * contesta, oculta y responde en privado; borrar y los ajustes de respuesta automática son del administrador.
 */

const idParam = (req: any) => parse(z.object({ id: z.string().uuid() }), req.params).id;

/** Negocio del comentario o la reseña: el del usuario o, para el administrador de la plataforma, el de la fila. */
async function accountFor(user: User, kind: Kind, id: string): Promise<string> {
  if (user.role !== 'superadmin') {
    if (!user.account_id) throw new HttpError(403, 'Tu usuario no tiene un perfil asignado');
    return user.account_id;
  }
  const row = await queryOne<{ account_id: string }>(`SELECT account_id FROM ${kind === 'comment' ? 'social_comments' : 'social_reviews'} WHERE id = $1`, [id]);
  if (!row) throw new HttpError(404, kind === 'comment' ? 'Comentario no encontrado' : 'Reseña no encontrada');
  return row.account_id;
}

/** Zernio ocupado llega como un aviso claro. */
async function busy<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ZernioBusyError) throw new HttpError(503, 'Zernio está ocupado en este momento; inténtalo de nuevo en un minuto.');
    throw e;
  }
}

const ReplyBody = z.object({ text: z.string(), source: z.enum(['human', 'suggested']).default('human') });

export async function socialInboxRoutes(api: FastifyInstance, service: ChatService) {
  const agents = { preHandler: requireRole('agent') };
  const admins = { preHandler: requireRole('admin') };
  const ai = service.aiProvider;
  /** Sugerir gasta IA: un tope por persona. */
  const suggestLimit = (user: User) => {
    if (rateLimited(`social-suggest:${user.id}`, 30, 60_000)) throw new HttpError(429, 'Pediste muchas sugerencias seguidas; espera un minuto.');
  };

  api.get('/api/social-inbox', agents, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query?.account_id);
    return listInbox(accountId, parse(InboxFilterSchema, req.query ?? {}));
  });

  /** Trae ya lo nuevo de las redes del negocio (además de lo que llega solo). */
  api.post('/api/social-inbox/sync', admins, async (req: any) => {
    if (!zernioEnabled()) throw new HttpError(400, 'Las redes sociales no están activadas en esta instalación.');
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query?.account_id);
    if (rateLimited(`social-sync:${accountId}`, 3, 10 * 60_000)) throw new HttpError(429, 'Ya se revisó hace poco; espera unos minutos.');
    const accounts = await query<{ id: string }>(`SELECT id FROM social_accounts WHERE account_id = $1 AND status = 'active'`, [accountId]);
    for (const a of accounts) await busy(() => syncEngagement(a.id)).catch(() => undefined);
    return { ok: true };
  });

  /* ------------------------------ Comentarios ------------------------------ */

  api.post('/api/social-comments/:id/suggest', agents, async (req: any) => {
    suggestLimit(req.user);
    const id = idParam(req);
    return suggestReply(ai, await accountFor(req.user, 'comment', id), 'comment', id);
  });

  api.post('/api/social-comments/:id/reply', agents, async (req: any) => {
    const id = idParam(req);
    const b = parse(ReplyBody, req.body ?? {});
    return busy(async () => replyComment(await accountFor(req.user, 'comment', id), id, b.text, b.source, req.user.id));
  });

  api.post('/api/social-comments/:id/private-reply', agents, async (req: any) => {
    const id = idParam(req);
    const b = parse(z.object({ text: z.string() }), req.body ?? {});
    return busy(async () => privateReply(await accountFor(req.user, 'comment', id), id, b.text));
  });

  /** Acción sobre un comentario del negocio (se valida el id y el dueño antes de llamar a la red). */
  const onComment = (fn: (accountId: string, id: string) => Promise<unknown>) => async (req: any) => {
    const id = idParam(req);
    return busy(async () => fn(await accountFor(req.user, 'comment', id), id));
  };
  api.post('/api/social-comments/:id/hide', agents, onComment((a, id) => setHidden(a, id, true)));
  api.post('/api/social-comments/:id/unhide', agents, onComment((a, id) => setHidden(a, id, false)));
  api.post('/api/social-comments/:id/like', agents, onComment((a, id) => setLiked(a, id, true)));
  api.post('/api/social-comments/:id/unlike', agents, onComment((a, id) => setLiked(a, id, false)));
  api.post('/api/social-comments/:id/ignore', agents, onComment((a, id) => ignore(a, 'comment', id, true)));
  api.post('/api/social-comments/:id/unignore', agents, onComment((a, id) => ignore(a, 'comment', id, false)));

  api.delete('/api/social-comments/:id', admins, async (req: any) => {
    const id = idParam(req);
    return busy(async () => deleteComment(await accountFor(req.user, 'comment', id), id));
  });

  /* ------------------------------ Reseñas ------------------------------ */

  api.post('/api/social-reviews/:id/suggest', agents, async (req: any) => {
    suggestLimit(req.user);
    const id = idParam(req);
    return suggestReply(ai, await accountFor(req.user, 'review', id), 'review', id);
  });

  api.post('/api/social-reviews/:id/reply', agents, async (req: any) => {
    const id = idParam(req);
    const b = parse(ReplyBody, req.body ?? {});
    return busy(async () => replyReview(await accountFor(req.user, 'review', id), id, b.text, b.source, req.user.id));
  });

  api.post('/api/social-reviews/:id/ignore', agents, async (req: any) => {
    const id = idParam(req);
    return ignore(await accountFor(req.user, 'review', id), 'review', id, true);
  });

  api.post('/api/social-reviews/:id/unignore', agents, async (req: any) => {
    const id = idParam(req);
    return ignore(await accountFor(req.user, 'review', id), 'review', id, false);
  });

  /* ------------------------------ Ajustes por cuenta conectada ------------------------------ */

  api.get('/api/social-accounts/:id/comment-settings', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query?.account_id);
    const row = await queryOne<{ comment_settings: Record<string, unknown> }>(`SELECT comment_settings FROM social_accounts WHERE id = $1 AND account_id = $2`, [idParam(req), accountId]);
    if (!row) throw new HttpError(404, 'Cuenta no encontrada');
    return settingsOf(row);
  });

  api.put('/api/social-accounts/:id/comment-settings', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query?.account_id);
    const { account_id: _ignored, ...body } = req.body ?? {};
    return saveCommentSettings(accountId, idParam(req), body);
  });
}
