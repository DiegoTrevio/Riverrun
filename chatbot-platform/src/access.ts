import type { FastifyReply, FastifyRequest } from 'fastify';
import * as store from './store/index.js';
import type { Role, User } from './types.js';

/**
 * Reglas de acceso:
 *  - superadmin: todas las cuentas.
 *  - admin: todo lo de su cuenta (chatbots, canales, usuarios, conversaciones, registros).
 *  - agent: solo conversaciones y contactos de su cuenta.
 * Lo que no es de tu cuenta responde 404 (no se revela que existe).
 */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public issues?: string[]) {
    super(message);
  }
}

export const notFound = (what = 'No encontrado') => new HttpError(404, what);

export function canAccessAccount(user: User, accountId: string | null | undefined) {
  if (user.role === 'superadmin') return true;
  return !!accountId && user.account_id === accountId;
}

export function assertAccount<T extends { account_id: string | null }>(user: User, resource: T | null | undefined, what = 'No encontrado'): T {
  if (!resource || !canAccessAccount(user, resource.account_id)) throw notFound(what);
  return resource;
}

/** Cuenta a la que se limita un listado: la del usuario, o la elegida por el superadmin (null = todas). */
export function scopeAccount(user: User, requested?: string | null): string | null {
  if (user.role === 'superadmin') return requested || null;
  return user.account_id;
}

/** Cuenta en la que se crea algo nuevo. */
export async function targetAccount(user: User, requested?: string | null): Promise<string> {
  const id = user.role === 'superadmin' ? requested : user.account_id;
  if (!id) throw new HttpError(400, 'Elige la cuenta');
  const acc = await store.getAccount(id);
  if (!acc) throw notFound('Cuenta no encontrada');
  return acc.id;
}

const RANK: Record<Role, number> = { agent: 1, admin: 2, superadmin: 3 };

export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (RANK[req.user.role] < RANK[min]) return reply.code(403).send({ error: 'No tienes permiso para esta acción' });
  };
}

export async function botFor(user: User, id: string) {
  return assertAccount(user, await store.getChatbot(id), 'Chatbot no encontrado');
}

export async function channelFor(user: User, id: string) {
  const ch = await store.getChannel(id);
  if (ch?.type === 'playground') throw notFound('Canal no encontrado');
  return assertAccount(user, ch, 'Canal no encontrado');
}

export async function conversationFor(user: User, id: string) {
  return assertAccount(user, await store.getConversation(id), 'Conversación no encontrada');
}
