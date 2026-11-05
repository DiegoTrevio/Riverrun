/**
 * Herramientas del Copiloto sobre los canales de un agente (solo administradores): verlos con su conexión, asignarlos,
 * encenderlos o apagarlos, crear el chat para la página web y el WhatsApp. Escanear el QR o dar permisos de Facebook lo
 * hace la persona: el Copiloto le da el enlace a esa pantalla.
 */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { links } from '../summarize.js';
import { botOf, Id } from './common.js';

const TYPE: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', messenger: 'Messenger', instagram: 'Instagram', webchat: 'Chat web', email: 'Correo', zernio: 'Redes' };

/** Lo que el modelo ve de un canal: nunca su token de webhook ni su configuración. */
const channelOut = (c: any) => ({
  canal_id: c.id, nombre: c.name, tipo: TYPE[c.type] ?? c.type, activo: c.active, agente_id: c.chatbot_id ?? undefined,
  conexion: c.connection_state ?? undefined,
});

async function channelOf(ctx: Ctx, id: string) {
  const c = await ctx.call.get<any>(path`/api/channels/${id}`);
  if (!c?.id) throw new ToolError('no_encontrado', 'Canal no encontrado');
  return c;
}

export const verCanales = defineTool({
  name: 'ver_canales',
  area: 'agente',
  pack: 'canales',
  roles: ['admin'],
  description: 'Los canales de la cuenta (o de un agente) con su tipo, agente asignado, si están activos y su conexión.',
  schema: z.object({ agente_id: Id.optional() }),
  label: () => 'Revisando los canales…',
  risk: () => 'read',
  async execute(a, ctx) {
    const list = ((await ctx.call.get<any[]>('/api/channels')) ?? []).filter((c) => !a.agente_id || c.chatbot_id === a.agente_id);
    return { title: `Revisé los canales (${list.length})`, data: { canales: list.map(channelOut) } };
  },
});

export const asignarCanal = defineTool({
  name: 'asignar_canal',
  area: 'agente',
  pack: 'canales',
  roles: ['admin'],
  description: 'Cambia qué agente atiende un canal, o lo enciende o apaga. Se confirma: cambia quién contesta en ese canal.',
  schema: z.object({ canal_id: Id, agente_id: Id.optional(), activo: z.boolean().optional() }).refine((a) => a.agente_id !== undefined || a.activo !== undefined, 'Indica qué cambiar'),
  label: () => 'Preparando el cambio del canal…',
  risk: () => ({ level: 'confirm', reasons: ['Cambia quién contesta a los clientes en ese canal.'] }),
  async preview(a, ctx) {
    const c = await channelOf(ctx, a.canal_id);
    const bot = a.agente_id ? await botOf(ctx, a.agente_id) : null;
    return {
      title: `Cambiar el canal «${c.name}»`,
      lines: [...(bot ? [`Lo atiende: ${bot.name}${bot.active ? '' : ' (apagado)'}`] : []), ...(a.activo !== undefined ? [a.activo ? 'Se enciende.' : 'Se apaga: deja de recibir y contestar.'] : [])],
    };
  },
  async execute(a, ctx) {
    const c = await channelOf(ctx, a.canal_id);
    const r = await ctx.call.send<any>('PUT', path`/api/channels/${c.id}`, { ...(a.agente_id ? { chatbot_id: a.agente_id } : {}), ...(a.activo !== undefined ? { active: a.activo } : {}) });
    return {
      title: `Cambié el canal «${c.name}»`,
      ...(r.chatbot_id ? { links: [links.bot(r.chatbot_id, 'conexiones', 'Ver conexiones')] } : {}),
      data: channelOut(r),
    };
  },
});

export const crearChatWeb = defineTool({
  name: 'crear_chat_web',
  area: 'agente',
  pack: 'canales',
  roles: ['admin'],
  description: 'Crea el chat para la página web del negocio, atendido por un agente, y devuelve el código para pegar en la página.',
  schema: z.object({ agente_id: Id, nombre: z.string().trim().min(1).max(80).optional() }),
  label: () => 'Creando el chat para la web…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const c = await ctx.call.send<any>('POST', '/api/channels', { type: 'webchat', chatbot_id: bot.id, name: a.nombre ?? `Chat web de ${bot.name}` });
    return {
      title: `Creé el chat web «${c.name}» para ${bot.name}`,
      links: [links.bot(bot.id, 'conexiones', 'Ver conexiones')],
      undo: { label: 'Deshacer', steps: [{ method: 'DELETE', url: path`/api/channels/${c.id}` }] },
      data: { ...channelOut(c), codigo_para_la_pagina: c.embed_code ?? undefined, nota: 'Pega el código antes de </body> en tu página.' },
    };
  },
});

export const crearWhatsapp = defineTool({
  name: 'crear_whatsapp',
  area: 'agente',
  pack: 'canales',
  roles: ['admin'],
  description: 'Crea (o reusa) el canal de WhatsApp de un agente. Conectarlo (escanear el QR o el código por número) lo hace la persona en la pantalla que se enlaza.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Preparando el WhatsApp del agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const before = ((await ctx.call.get<any[]>('/api/channels')) ?? []).some((c) => c.type === 'whatsapp' && c.chatbot_id === bot.id);
    const c = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/whatsapp`, {});
    return {
      title: before ? `${bot.name} ya tenía WhatsApp («${c.name}»)` : `Creé el WhatsApp de ${bot.name}: falta conectarlo`,
      links: [links.bot(bot.id, 'conexiones', 'Conectar WhatsApp')],
      // Solo el que se acaba de crear se puede quitar; uno que ya existía no se toca.
      undo: before ? null : { label: 'Deshacer', steps: [{ method: 'DELETE', url: path`/api/channels/${c.id}` }] },
      data: { ...channelOut(c), nota: 'Para conectarlo, abre «Conectar WhatsApp» y escanea el QR o usa el código por número.' },
    };
  },
});

export const CHANNEL_TOOLS = [verCanales, asignarCanal, crearChatWeb, crearWhatsapp];
