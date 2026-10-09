/** Avisos internos manuales: del panel o de otros sistemas (API). A todo el equipo, a un rol, a personas o a quien toque por turnos. */
import { z } from 'zod';
import { HttpError } from '../access.js';
import type { ChatService } from '../service.js';
import * as assignment from './assignment.js';
import { teamMembers } from './store.js';

export const NoticeBody = z.object({
  title: z.string().trim().min(1, 'Escribe un título').max(200),
  body: z.string().trim().max(2000).default(''),
  /** Ruta dentro del panel a la que lleva el aviso (p. ej. #/conversation/…). */
  link: z.string().max(300).regex(/^(#\/[\w\-/?=&.%]*)?$/, 'El enlace debe ser una ruta del panel, como #/conversations').default(''),
  user_ids: z.array(z.string().uuid()).max(100).default([]),
  roles: z.array(z.enum(['admin', 'agent'])).min(1).default(['admin', 'agent']),
  /** Avisar a una sola persona, la que siga en el turno (entre las elegidas o las del rol que estén disponibles). */
  round_robin: z.boolean().default(false),
});

export async function sendNotice(service: Pick<ChatService, 'automator'>, accountId: string, b: z.infer<typeof NoticeBody>) {
  let ids: string[];
  if (b.round_robin) {
    const pick = await assignment.nextInTurn(accountId, 'notice', await assignment.eligibleUsers(accountId, { roles: b.roles, userIds: b.user_ids }));
    if (!pick) throw new HttpError(409, 'No hay nadie disponible para recibir el aviso');
    ids = [pick.id];
  } else {
    const team = await teamMembers(accountId, b.roles);
    ids = (b.user_ids.length ? team.filter((u) => b.user_ids.includes(u.id)) : team).map((u) => u.id);
    if (!ids.length) throw new HttpError(400, 'No hay destinatarios en esta cuenta');
  }
  await service.automator.alertTeam(accountId, { title: b.title, body: b.body, link: b.link || undefined, userIds: ids, kind: 'notice' });
  return { recipients: ids };
}
