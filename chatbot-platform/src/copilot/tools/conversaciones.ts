/** Herramientas del Copiloto para conversaciones: buscar, leer, asignar, tomar o devolver, cerrar y enviar. */
import { z } from 'zod';
import { path, qs, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { links, when } from '../summarize.js';
import { conversation, Id, nameOf } from './common.js';

const STATUS = { con_agente: 'bot', con_persona: 'human', cerrada: 'closed' } as const;
const STATUS_ES: Record<string, string> = { bot: 'la atiende el agente', human: 'la atiende una persona', closed: 'cerrada' };

const who = (m: any) => (m.direction === 'in' ? 'cliente' : m.sender === 'human' ? 'equipo' : 'agente');

export const buscarConversaciones = defineTool({
  name: 'buscar_conversaciones',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Lista conversaciones recientes, por cliente (nombre o teléfono), estado o a quién están asignadas.',
  schema: z.object({
    texto: z.string().trim().max(120).optional().describe('Nombre o teléfono del cliente'),
    estado: z.enum(['con_agente', 'con_persona', 'cerrada']).optional(),
    asignada: z.enum(['a_mi', 'a_nadie']).optional(),
    limite: z.number().int().min(1).max(30).optional(),
  }),
  label: () => 'Buscando conversaciones…',
  risk: () => 'read',
  async execute(a, ctx) {
    const rows = await ctx.call.get<any[]>(`/api/conversations${qs({ search: a.texto, status: a.estado ? STATUS[a.estado] : undefined, assigned: a.asignada === 'a_mi' ? 'me' : a.asignada === 'a_nadie' ? 'none' : undefined, limit: a.limite ?? 15 })}`);
    return {
      title: `Revisé ${rows.length} conversaciones`,
      // Nombres y últimos mensajes los escriben los clientes.
      untrusted: rows.length > 0,
      contactIds: [...new Set(rows.map((r) => r.contact_id).filter(Boolean))],
      data: {
        conversaciones: rows.map((r) => ({
          id: r.id, contacto_id: r.contact_id, cliente: nameOf(r), telefono: r.phone, estado: STATUS_ES[r.status] ?? r.status,
          asignada_a: r.assigned_name ?? undefined, agente: r.chatbot_name ?? undefined, canal: r.channel_name, ultimo_mensaje: when(r.last_message_at, ctx.timezone),
          datos_del_cliente: r.last_message ? { ultimo_texto: `${r.last_direction === 'in' ? 'cliente' : 'respuesta'}: ${String(r.last_message).slice(0, 160)}` } : undefined,
        })),
      },
    };
  },
});

export const leerConversacion = defineTool({
  name: 'leer_conversacion',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Lee los últimos mensajes de una conversación, su estado, a quién está asignada y su resumen.',
  schema: z.object({ conversacion_id: Id, mensajes: z.number().int().min(1).max(40).optional() }),
  label: () => 'Leyendo la conversación…',
  risk: () => 'read',
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const messages: any[] = (c.messages ?? []).slice(-(a.mensajes ?? 20));
    return {
      title: `Leí la conversación con ${nameOf(c.contact)}`,
      untrusted: true,
      contactIds: c.contact ? [c.contact.id] : [],
      read: [{ kind: 'conversation', id: c.conversation.id }, ...(c.contact ? [{ kind: 'contact', id: c.contact.id }] : [])],
      links: [links.conversation(c.conversation.id)],
      data: {
        conversacion: { id: c.conversation.id, estado: STATUS_ES[c.conversation.status] ?? c.conversation.status, asignada_a: c.assignee?.name || c.assignee?.email || undefined, agente: c.chatbot?.name },
        contacto: c.contact ? { id: c.contact.id, nombre: nameOf(c.contact), telefono: c.contact.phone, etiquetas: c.contact.tags } : undefined,
        datos_del_cliente: {
          resumen: c.conversation.summary || undefined,
          mensajes: messages.map((m) => ({ de: who(m), cuando: when(m.created_at, ctx.timezone), texto: m.content || (m.media_kind ? `[${m.media_kind}]` : m.image_name ? `[foto ${m.image_name}]` : '') })),
        },
      },
    };
  },
});

/** Estado de la conversación que se compara antes de deshacer. */
const CHECK = ['conversation.status', 'conversation.assigned_user_id'];
const state = (c: any) => ({ 'conversation.status': c.conversation.status ?? null, 'conversation.assigned_user_id': c.conversation.assigned_user_id ?? null });

export const gestionarConversacion = defineTool({
  name: 'gestionar_conversacion',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Asigna una conversación (a una persona del equipo por su id, a mí o a nadie), la toma para atenderla una persona, o la devuelve al agente.',
  schema: z.object({
    conversacion_id: Id,
    accion: z.enum(['asignar', 'tomar', 'devolver_al_agente']),
    persona: z.union([Id, z.literal('yo'), z.literal('nadie')]).optional().describe('Para «asignar»: id de la persona, «yo» o «nadie»'),
  }).refine((a) => a.accion !== 'asignar' || a.persona !== undefined, 'Indica a quién asignarla'),
  label: (a) => (a.accion === 'asignar' ? 'Asignando la conversación…' : a.accion === 'tomar' ? 'Tomando la conversación…' : 'Devolviendo la conversación al agente…'),
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'conversation', id: a.conversacion_id }],
  // Tomarla la pasa a una persona: las reglas «pasa a una persona» pueden escribirle al cliente.
  events: (a) => (a.accion === 'tomar' ? [{ type: 'handoff' }] : []),
  async execute(a, ctx) {
    const before = await conversation(ctx, a.conversacion_id);
    const id = before.conversation.id;
    if (a.accion === 'asignar') await ctx.call.send('PUT', path`/api/conversations/${id}/assign`, { user_id: a.persona === 'yo' ? 'me' : a.persona === 'nadie' ? null : a.persona });
    else if (a.accion === 'tomar') await ctx.call.send('POST', path`/api/conversations/${id}/takeover`);
    else await ctx.call.send('POST', path`/api/conversations/${id}/release`);
    const after = await conversation(ctx, id);
    const name = nameOf(after.contact);
    const prev = before.conversation;
    const steps: { method: 'POST' | 'PUT'; url: string; body?: unknown }[] = [];
    if (prev.status !== after.conversation.status) steps.push({ method: 'POST', url: path`/api/conversations/${id}/${prev.status === 'bot' ? 'release' : 'takeover'}` });
    if ((prev.assigned_user_id ?? null) !== (after.conversation.assigned_user_id ?? null)) steps.push({ method: 'PUT', url: path`/api/conversations/${id}/assign`, body: { user_id: prev.assigned_user_id ?? null } });
    const assignee = after.assignee?.name || after.assignee?.email;
    return {
      title: a.accion === 'asignar' ? (assignee ? `Asigné la conversación de ${name} a ${assignee}` : `Dejé sin asignar la conversación de ${name}`)
        : a.accion === 'tomar' ? `Tomé la conversación de ${name} (la atiende una persona)` : `Devolví la conversación de ${name} al agente`,
      contactIds: after.contact ? [after.contact.id] : [],
      links: [links.conversation(id)],
      before: state(before),
      after: state(after),
      undo: steps.length ? { label: 'Deshacer', check: { url: path`/api/conversations/${id}`, pick: CHECK, expect: state(after) }, steps } : null,
      data: { estado: STATUS_ES[after.conversation.status] ?? after.conversation.status, asignada_a: assignee ?? null },
    };
  },
});

async function recipientLines(ctx: Ctx, conversationId: string) {
  const c = await conversation(ctx, conversationId);
  return { c, name: nameOf(c.contact), to: `${nameOf(c.contact)}${c.contact?.phone ? ` (${c.contact.phone})` : ''} por ${c.channel?.name ?? 'su canal'}` };
}

export const cerrarConversacion = defineTool({
  name: 'cerrar_conversacion',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Cierra una conversación (y genera su resumen). Requiere confirmación.',
  schema: z.object({ conversacion_id: Id }),
  label: () => 'Preparando el cierre de la conversación…',
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'conversation', id: a.conversacion_id }],
  async preview(a, ctx) {
    const r = await recipientLines(ctx, a.conversacion_id);
    return { title: `Cerrar la conversación con ${r.name}`, lines: ['Se genera su resumen. Si el cliente vuelve a escribir, se abre de nuevo.'] };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    await ctx.call.send('POST', path`/api/conversations/${a.conversacion_id}/close`);
    return { title: `Cerré la conversación con ${nameOf(c.contact)}`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(a.conversacion_id)], data: { cerrada: true } };
  },
});

export const enviarMensaje = defineTool({
  name: 'enviar_mensaje',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Envía un mensaje de texto al cliente de una conversación. Requiere confirmación: la persona ve el texto exacto antes.',
  schema: z.object({ conversacion_id: Id, texto: z.string().trim().min(1).max(4000) }),
  label: () => 'Preparando el mensaje…',
  risk: () => 'confirm',
  targets: async (a, ctx) => {
    const c = await conversation(ctx, a.conversacion_id);
    return [{ kind: 'conversation', id: a.conversacion_id }, ...(c.contact ? [{ kind: 'contact', id: c.contact.id }] : [])];
  },
  async preview(a, ctx) {
    const r = await recipientLines(ctx, a.conversacion_id);
    return {
      title: `Enviar mensaje a ${r.name}`,
      lines: [`Para: ${r.to}`],
      quote: a.texto,
      ...(r.c.conversation.status === 'bot' ? { warning: 'La conversación pasará a atención humana: el agente deja de responder hasta que la devuelvas.' } : {}),
    };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    await ctx.call.send('POST', path`/api/conversations/${a.conversacion_id}/send`, { text: a.texto });
    return { title: `Envié el mensaje a ${nameOf(c.contact)}`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(a.conversacion_id)], data: { enviado: true } };
  },
});

export const enviarFoto = defineTool({
  name: 'enviar_foto',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Envía al cliente una foto o archivo de la biblioteca del agente (por su id). Requiere confirmación.',
  schema: z.object({ conversacion_id: Id, foto_id: Id }),
  label: () => 'Preparando la foto…',
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'conversation', id: a.conversacion_id }],
  async preview(a, ctx) {
    const r = await recipientLines(ctx, a.conversacion_id);
    const images: any[] = r.c.chatbot?.id ? await ctx.call.get(path`/api/chatbots/${r.c.chatbot.id}/images`) : [];
    const img = images.find((i) => i.id === a.foto_id);
    if (!img) throw new ToolError('no_encontrado', 'Esa foto no está en la biblioteca del agente de esta conversación');
    return { title: `Enviar «${img.name || img.code}» a ${r.name}`, lines: [`Para: ${r.to}`, ...(img.caption ? [`Con el texto: ${img.caption}`] : [])] };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    await ctx.call.send('POST', path`/api/conversations/${a.conversacion_id}/send-image`, { image_id: a.foto_id });
    return { title: `Envié la foto a ${nameOf(c.contact)}`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(a.conversacion_id)], data: { enviado: true } };
  },
});

export const secuenciaDeConversacion = defineTool({
  name: 'secuencia_de_conversacion',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Inscribe una conversación en una secuencia de mensajes o la saca de ella. Requiere confirmación.',
  schema: z.object({ conversacion_id: Id, secuencia_id: Id, accion: z.enum(['inscribir', 'sacar']) }),
  label: (a) => (a.accion === 'inscribir' ? 'Preparando la inscripción…' : 'Preparando la salida de la secuencia…'),
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'conversation', id: a.conversacion_id }],
  async preview(a, ctx) {
    const r = await recipientLines(ctx, a.conversacion_id);
    const seq = ((await ctx.call.get<any[]>('/api/sequences')) ?? []).find((s) => s.id === a.secuencia_id);
    if (!seq) throw new ToolError('no_encontrado', 'Secuencia no encontrada');
    return a.accion === 'inscribir'
      ? { title: `Inscribir a ${r.name} en «${seq.name}»`, lines: [`Recibirá los mensajes de la secuencia según sus tiempos${seq.steps?.length ? ` (${seq.steps.length} pasos)` : ''}.`] }
      : { title: `Sacar a ${r.name} de «${seq.name}»`, lines: ['Deja de recibir los mensajes que faltaban.'] };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    if (a.accion === 'inscribir') await ctx.call.send('POST', path`/api/conversations/${a.conversacion_id}/sequences`, { sequence_id: a.secuencia_id });
    else await ctx.call.send('DELETE', path`/api/conversations/${a.conversacion_id}/sequences/${a.secuencia_id}`);
    return { title: `${a.accion === 'inscribir' ? 'Inscribí' : 'Saqué'} a ${nameOf(c.contact)} ${a.accion === 'inscribir' ? 'en' : 'de'} la secuencia`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(a.conversacion_id)], data: { hecho: true } };
  },
});

export const CONVERSATION_TOOLS = [buscarConversaciones, leerConversacion, gestionarConversacion, cerrarConversacion, enviarMensaje, enviarFoto, secuenciaDeConversacion];
