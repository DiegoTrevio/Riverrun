/**
 * Herramientas del Copiloto para atender una conversación más allá de contestar (fase 2): su resumen, mandar el reporte
 * al equipo (o fuera de él), mandarla a la app conectada, reiniciar lo que el agente sabe, destrabar envíos fallidos y
 * mandar una plantilla de WhatsApp. Todo lo que sale o borra se confirma; el resumen solo se lee.
 */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { links } from '../summarize.js';
import { conversation, Id, isAdmin, nameOf } from './common.js';

const target = (a: { conversacion_id: string }) => [{ kind: 'conversation', id: a.conversacion_id }];
const who = (c: any) => `${nameOf(c.contact)}${c.contact?.phone ? ` (${c.contact.phone})` : ''}`;

export const resumirConversacion = defineTool({
  name: 'resumir_conversacion',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Genera (o actualiza) el resumen de una conversación con IA: de qué trata, acuerdos y siguientes pasos. Gasta IA.',
  schema: z.object({ conversacion_id: Id }),
  label: () => 'Resumiendo la conversación…',
  risk: () => 'read',
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const r = await ctx.call.send<any>('POST', path`/api/conversations/${c.conversation.id}/summary`);
    const analysis = r?.report_analysis ?? {};
    return {
      title: `Resumí la conversación con ${nameOf(c.contact)}`,
      untrusted: true,
      contactIds: c.contact ? [c.contact.id] : [],
      read: [{ kind: 'conversation', id: c.conversation.id }],
      links: [links.conversation(c.conversation.id)],
      // El resumen sale de lo que escribió el cliente: es dato.
      data: { datos_del_cliente: { resumen: r?.report_summary || r?.summary || '', acuerdos: analysis.agreements, siguientes_pasos: analysis.next_steps } },
    };
  },
});

export const enviarReporte = defineTool({
  name: 'enviar_reporte',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Manda el reporte de una conversación (resumen y, si se pide, los últimos mensajes) a personas del equipo o, solo administradores, a correos o WhatsApp de fuera. Se confirma.',
  schema: z.object({
    conversacion_id: Id,
    personas: z.array(Id).max(20).default([]),
    correos: z.array(z.string().trim().toLowerCase().email().max(200)).max(5).default([]),
    telefonos: z.array(z.string().trim().regex(/^\+?[\d\s()-]{8,20}$/)).max(5).default([]),
    nota: z.string().trim().max(500).optional(),
    con_mensajes: z.boolean().default(false).describe('Incluir los últimos mensajes'),
  }).refine((a) => a.personas.length + a.correos.length + a.telefonos.length > 0, 'Indica a quién mandarlo'),
  label: () => 'Preparando el reporte…',
  risk: (a) => (a.correos.length || a.telefonos.length
    ? { level: 'confirm', reasons: ['El reporte lleva datos del cliente y sale de tu equipo.'] }
    : 'confirm'),
  targets: target,
  async preview(a, ctx) {
    if ((a.correos.length || a.telefonos.length) && !isAdmin(ctx)) throw new ToolError('sin_permiso', 'Solo un administrador puede mandar reportes fuera del equipo.');
    const c = await conversation(ctx, a.conversacion_id);
    const team = (await ctx.call.get<any[]>(path`/api/conversations/${c.conversation.id}/report/recipients`)) ?? [];
    const missing = a.personas.filter((id) => !team.some((u) => u.id === id));
    if (missing.length) throw new ToolError('datos_invalidos', 'Alguna persona no es del equipo de esta cuenta o está inactiva.');
    const names = a.personas.map((id) => team.find((u) => u.id === id)!.name);
    return {
      title: `Mandar el reporte de la conversación con ${nameOf(c.contact)}`,
      lines: [
        ...(names.length ? [`Al equipo: ${names.join(', ')}`] : []),
        ...(a.correos.length ? [`Correos de fuera: ${a.correos.join(', ')}`] : []),
        ...(a.telefonos.length ? [`WhatsApp de fuera: ${a.telefonos.join(', ')}`] : []),
        a.con_mensajes ? 'Con los últimos mensajes de la conversación.' : 'Solo el resumen (sin los mensajes).',
      ],
      ...(a.nota ? { quote: a.nota } : {}),
      ...(a.correos.length || a.telefonos.length ? { warning: 'Sale de tu equipo: lleva el nombre, el teléfono y lo que dijo el cliente.' } : {}),
    };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const r = await ctx.call.send<any>('POST', path`/api/conversations/${c.conversation.id}/report/send`, {
      user_ids: a.personas, emails: a.correos, phones: a.telefonos, note: a.nota ?? '', include_transcript: a.con_mensajes,
    });
    const sent = (r?.deliveries ?? []) as { via: string; to: string; ok: boolean }[];
    return {
      title: `Mandé el reporte de la conversación con ${nameOf(c.contact)} (${sent.filter((d) => d.ok).length} de ${sent.length})`,
      contactIds: c.contact ? [c.contact.id] : [],
      links: [links.conversation(c.conversation.id)],
      data: { entregas: sent.map((d) => ({ por: d.via, a: d.to, ok: d.ok })), aviso: r?.warning || undefined },
    };
  },
});

const CONTENT = { resumen: 'summary', completa: 'full', ambos: 'both' } as const;
const CONTENT_ES = { resumen: 'el resumen', completa: 'la conversación completa', ambos: 'el resumen y la conversación completa' } as const;

export const enviarAApp = defineTool({
  name: 'enviar_a_app',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Manda una conversación (resumen, completa o ambos) a la app conectada por webhook (CRM, hoja de cálculo…). Se confirma.',
  schema: z.object({ conversacion_id: Id, contenido: z.enum(['resumen', 'completa', 'ambos']).default('resumen'), app_id: Id.optional().describe('Sin id: las que reciben conversaciones') }),
  label: () => 'Preparando el envío a tu app…',
  risk: () => ({ level: 'confirm', reasons: ['Los datos del cliente salen a otro sistema.'] }),
  targets: target,
  async preview(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const apps = ((await ctx.call.get<any[]>(path`/api/conversations/${c.conversation.id}/app-destinations`)) ?? []).filter((d) => (a.app_id ? d.id === a.app_id : d.receives_conversations));
    if (!apps.length) throw new ToolError('datos_invalidos', a.app_id ? 'Esa app no está conectada o está apagada.' : 'No hay una app conectada que reciba conversaciones (Ajustes → Integraciones).');
    return { title: `Mandar ${CONTENT_ES[a.contenido]} de ${nameOf(c.contact)} a tu app`, lines: [`A: ${apps.map((d) => d.label).join(', ')}`] };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const r = await ctx.call.send<any>('POST', path`/api/conversations/${c.conversation.id}/send-to-app`, { content: CONTENT[a.contenido], endpoint_id: a.app_id ?? '' });
    return { title: `Mandé ${CONTENT_ES[a.contenido]} de ${nameOf(c.contact)} a tu app`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(c.conversation.id)], data: { enviado: r?.sent ?? true } };
  },
});

export const reiniciarMemoria = defineTool({
  name: 'reiniciar_memoria',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Reinicia lo que el agente sabe de una conversación: borra los datos, notas y nombre guardados del contacto y empieza de cero. Se confirma.',
  schema: z.object({ conversacion_id: Id }),
  label: () => 'Preparando el reinicio de la memoria…',
  risk: () => ({ level: 'confirm', reasons: ['No se puede deshacer: se borran los datos guardados del contacto.'] }),
  targets: target,
  async preview(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const data = Object.keys(c.contact?.data ?? {});
    return {
      title: `Reiniciar la memoria de la conversación con ${nameOf(c.contact)}`,
      lines: [data.length ? `Se borran sus datos guardados: ${data.join(', ')}.` : 'No tiene datos guardados.', 'Se borran también sus notas y su nombre, y el agente empieza de cero (los mensajes se quedan).'],
      warning: 'No se puede deshacer.',
    };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    await ctx.call.send('POST', path`/api/conversations/${c.conversation.id}/reset-memory`);
    return { title: `Reinicié la memoria de la conversación con ${nameOf(c.contact)}`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(c.conversation.id)], data: { reiniciada: true } };
  },
});

const REASON: Record<string, string> = { processing_error: 'falló al procesar los mensajes', reviewed_by_admin: 'ya revisado' };

export const recuperarEnvios = defineTool({
  name: 'recuperar_envios',
  area: 'conversaciones',
  roles: ['admin'],
  description: 'Destraba una conversación en la bandeja de fallos: reintentar lo que falló o darlo por atendido (los mensajes pendientes se marcan como vistos). Se confirma.',
  schema: z.object({ conversacion_id: Id, accion: z.enum(['reintentar', 'dar_por_atendido']) }),
  label: () => 'Revisando los envíos de la conversación…',
  risk: () => 'confirm',
  targets: target,
  async preview(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const w = await ctx.call.get<any>(path`/api/conversations/${c.conversation.id}/work`);
    if (w?.work?.state !== 'dead') throw new ToolError('datos_invalidos', 'Esta conversación no está en la bandeja de fallos.');
    const why = REASON[w.work.reason] ?? String(w.work.reason ?? 'sin motivo');
    if (a.accion === 'reintentar' && w.work.reason !== 'processing_error') throw new ToolError('datos_invalidos', 'Repetir este trabajo podría duplicar un envío: revisa la conversación y dalo por atendido.');
    return {
      title: `${a.accion === 'reintentar' ? 'Reintentar' : 'Dar por atendido'} lo que falló en la conversación con ${nameOf(c.contact)}`,
      lines: [`Motivo: ${why} (${w.work.attempts ?? 0} intento(s)).`, a.accion === 'reintentar' ? 'El agente vuelve a procesar los mensajes pendientes.' : 'Los mensajes pendientes quedan como atendidos; el agente no los contesta.'],
      meta: { review_up_to: w.review_up_to ?? null },
    };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const upTo = ctx.proposal?.meta?.review_up_to;
    await ctx.call.send('POST', path`/api/conversations/${c.conversation.id}/work/recover`, {
      action: a.accion === 'reintentar' ? 'retry' : 'acknowledge', ...(typeof upTo === 'number' ? { review_up_to: upTo } : {}),
    });
    return { title: `${a.accion === 'reintentar' ? 'Reintenté' : 'Di por atendido'} lo que falló en la conversación con ${nameOf(c.contact)}`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(c.conversation.id)], data: { hecho: a.accion } };
  },
});

/** Una plantilla de WhatsApp de la cuenta (las que se pueden enviar desde el panel). */
async function templateOf(ctx: Ctx, id: string) {
  const t = ((await ctx.call.get<any[]>('/api/wa-templates')) ?? []).find((x) => x.id === id);
  if (!t) throw new ToolError('no_encontrado', 'Plantilla no encontrada');
  return t;
}
const filled = (body: string, params: string[]) => String(body ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => params[Number(n) - 1] ?? m);

export const enviarPlantilla = defineTool({
  name: 'enviar_plantilla',
  area: 'conversaciones',
  roles: ['admin', 'agent'],
  description: 'Envía al cliente una plantilla aprobada de WhatsApp (lo único que se puede mandar pasadas 24 h de su último mensaje), con el texto de sus variables. Se confirma.',
  schema: z.object({ conversacion_id: Id, plantilla_id: Id, variables: z.array(z.string().max(1000)).max(20).default([]).describe('Texto de {{1}}, {{2}}…') }),
  label: () => 'Preparando la plantilla…',
  risk: () => 'confirm',
  targets: target,
  async preview(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    const t = await templateOf(ctx, a.plantilla_id);
    if (!t.sendable) throw new ToolError('datos_invalidos', t.status !== 'APPROVED' ? 'La plantilla todavía no está aprobada por Meta.' : 'Esa plantilla no se puede enviar desde el panel.');
    if (a.variables.length < Number(t.variables ?? 0)) throw new ToolError('datos_invalidos', `La plantilla tiene ${t.variables} variable(s): escribe el texto de cada una.`);
    return {
      title: `Enviar la plantilla «${t.name}» a ${nameOf(c.contact)}`,
      lines: [`Para: ${who(c)} por ${c.channel?.name ?? 'su canal'}`, `Idioma: ${t.language}`],
      quote: filled(t.body, a.variables),
      ...(c.conversation.status === 'bot' ? { warning: 'La conversación pasará a atención humana: el agente deja de responder hasta que la devuelvas.' } : {}),
    };
  },
  async execute(a, ctx) {
    const c = await conversation(ctx, a.conversacion_id);
    await ctx.call.send('POST', path`/api/conversations/${c.conversation.id}/send-template`, { template_id: a.plantilla_id, params: a.variables });
    return { title: `Envié una plantilla a ${nameOf(c.contact)}`, contactIds: c.contact ? [c.contact.id] : [], links: [links.conversation(c.conversation.id)], data: { enviado: true } };
  },
});

export const ATTENTION_TOOLS = [resumirConversacion, enviarReporte, enviarAApp, reiniciarMemoria, recuperarEnvios, enviarPlantilla];
