/**
 * Herramientas del Copiloto para los avisos del panel (fase 2): los tuyos (verlos y marcarlos leídos) y avisar al equipo
 * (solo administradores, se confirma porque le llega a otras personas).
 */
import { z } from 'zod';
import { qs, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { links, safeLink, when } from '../summarize.js';
import { Id, Text } from './common.js';

const mine = async (ctx: Ctx, limit = 30) => ((await ctx.call.get<any>(`/api/notifications${qs({ limit })}`))?.items ?? []) as any[];

export const verAvisos = defineTool({
  name: 'ver_avisos',
  area: 'conversaciones',
  pack: 'avisos',
  roles: ['admin', 'agent'],
  description: 'Tus avisos del panel (clientes esperando, citas, cobros, desconexiones…), los más nuevos primero, con si ya los leíste.',
  schema: z.object({ solo_sin_leer: z.boolean().optional(), limite: z.number().int().min(1).max(50).optional() }),
  label: () => 'Revisando tus avisos…',
  risk: () => 'read',
  async execute(a, ctx) {
    const items = (await mine(ctx, a.solo_sin_leer ? 200 : a.limite ?? 20)).filter((n) => !a.solo_sin_leer || !n.read_at).slice(0, a.limite ?? 20);
    return {
      title: `Revisé tus avisos (${items.length})`,
      links: [links.notifications()],
      // Los avisos repiten nombres y mensajes de clientes.
      untrusted: items.length > 0,
      data: {
        sin_leer: items.filter((n) => !n.read_at).length,
        avisos: items.map((n) => ({ id: Number(n.id), cuando: when(n.created_at, ctx.timezone), leido: !!n.read_at, tipo: n.kind, enlace: n.link || undefined, datos_del_cliente: { titulo: n.title, texto: n.body || undefined } })),
      },
    };
  },
});

export const marcarAvisosLeidos = defineTool({
  name: 'marcar_avisos_leidos',
  area: 'conversaciones',
  pack: 'avisos',
  roles: ['admin', 'agent'],
  description: 'Marca como leídos tus avisos del panel: los indicados por id o, sin ids, todos los que no has leído.',
  schema: z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }),
  label: () => 'Marcando tus avisos como leídos…',
  risk: () => 'reversible',
  // Solo son tus avisos: no tocan registros de clientes.
  targets: () => [],
  async execute(a, ctx) {
    const unread = (await mine(ctx, 200)).filter((n) => !n.read_at).map((n) => Number(n.id));
    const ids = a.ids?.length ? a.ids.filter((id) => unread.includes(id)) : unread;
    if (ids.length) await ctx.call.send('POST', '/api/notifications/read', { ids });
    return { title: ids.length ? `Marqué ${ids.length} aviso(s) como leídos` : 'No había avisos sin leer', links: [links.notifications()], undo: null, data: { marcados: ids.length } };
  },
});

const ROLES = { administradores: 'admin', agentes: 'agent' } as const;

export const avisarAlEquipo = defineTool({
  name: 'avisar_al_equipo',
  area: 'conversaciones',
  pack: 'avisos',
  roles: ['admin'],
  description: 'Manda un aviso interno al equipo (a personas, a un rol o a quien siga en el turno), con un enlace opcional a una página del panel. Se confirma.',
  schema: z.object({
    titulo: Text(200),
    texto: z.string().trim().max(2000).optional(),
    enlace: z.string().trim().max(200).optional().describe('Ruta del panel, como #/conversation/<id>'),
    personas: z.array(Id).max(100).optional(),
    roles: z.array(z.enum(['administradores', 'agentes'])).min(1).optional().describe('Por omisión, todos'),
    por_turnos: z.boolean().optional().describe('Solo a quien siga en el turno'),
  }),
  label: () => 'Preparando el aviso al equipo…',
  risk: () => ({ level: 'confirm', reasons: ['Le llega al equipo (en el panel y, según sus avisos, por WhatsApp o correo).'] }),
  async preview(a, ctx) {
    if (a.enlace && !safeLink(a.enlace)) throw new ToolError('datos_invalidos', 'El enlace debe ser una página del panel (como #/conversations).');
    const team = ((await ctx.call.get<any[]>('/api/users')) ?? []).filter((u) => u.active !== false && u.role !== 'superadmin');
    const roles = (a.roles ?? ['administradores', 'agentes']).map((r) => ROLES[r]);
    const people = a.personas?.length ? team.filter((u) => a.personas!.includes(u.id)) : team.filter((u) => roles.includes(u.role));
    if (a.personas?.length && people.length !== new Set(a.personas).size) throw new ToolError('datos_invalidos', 'Alguna persona no es del equipo de esta cuenta.');
    const names = people.map((u) => u.name || u.email);
    return {
      title: `Avisar al equipo: ${a.titulo}`,
      lines: [a.por_turnos ? `A una sola persona, la que siga en el turno entre: ${names.join(', ')}` : `A: ${names.join(', ') || 'nadie'}`, ...(a.enlace ? [`Enlace: ${a.enlace}`] : [])],
      ...(a.texto ? { quote: a.texto } : {}),
    };
  },
  async execute(a, ctx) {
    const r = await ctx.call.send<any>('POST', '/api/notifications/send', {
      title: a.titulo, body: a.texto ?? '', link: a.enlace ?? '', user_ids: a.personas ?? [], roles: (a.roles ?? ['administradores', 'agentes']).map((x) => ROLES[x]), round_robin: !!a.por_turnos,
    });
    return { title: `Avisé al equipo: ${a.titulo} (${r?.sent_to ?? 0} persona(s))`, data: { enviado_a: r?.sent_to ?? 0 } };
  },
});

export const NOTICE_TOOLS = [verAvisos, marcarAvisosLeidos, avisarAlEquipo];
