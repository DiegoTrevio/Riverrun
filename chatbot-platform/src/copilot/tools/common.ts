/** Piezas que comparten las herramientas del Copiloto. */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import type { Ctx } from '../registry.js';

export const Id = z.string().uuid();

export const nameOf = (c: { name?: string | null; push_name?: string | null; phone?: string | null } | null | undefined) =>
  c?.name || c?.push_name || c?.phone || 'Sin nombre';

/** Ficha completa de un contacto (con los permisos de quien pregunta). */
export async function profile(ctx: Ctx, contactId: string) {
  const p = await ctx.call.get<any>(path`/api/contacts/${contactId}/profile`);
  if (!p?.contact) throw new ToolError('no_encontrado', 'Contacto no encontrado');
  return p;
}

/**
 * Versión de los datos del contacto: la que el panel manda para no pisar lo que la IA guardó después. Solo cuentan sus
 * propias conversaciones (la ficha junta también las de otros registros con el mismo teléfono).
 */
export const dataVersion = (p: any): number =>
  Math.max(0, ...((p.conversations ?? []) as any[]).filter((c) => c.contact_id === p.contact.id).map((c) => Number(c.data_version ?? 0)));

/** Conversación con su contacto (con los permisos de quien pregunta). */
export async function conversation(ctx: Ctx, conversationId: string) {
  const c = await ctx.call.get<any>(path`/api/conversations/${conversationId}`);
  if (!c?.conversation) throw new ToolError('no_encontrado', 'Conversación no encontrada');
  return c;
}

export const isAdmin = (ctx: Ctx) => ctx.user.role === 'admin' || ctx.user.role === 'superadmin';
