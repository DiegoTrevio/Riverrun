/**
 * Herramientas del Copiloto para las plantillas de WhatsApp (API oficial, fase 2): verlas, crearlas (se mandan a revisión
 * de Meta y ya no se editan), traer las de Meta y borrarlas. Enviar una a un cliente es `enviar_plantilla`.
 */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { links } from '../summarize.js';
import { Id, isAdmin } from './common.js';

const STATUS: Record<string, string> = { APPROVED: 'aprobada', PENDING: 'en revisión', REJECTED: 'rechazada', PAUSED: 'en pausa', DISABLED: 'desactivada' };
const CATEGORY = { promocion: 'MARKETING', servicio: 'UTILITY' } as const;

/** Los números de WhatsApp (API oficial) de la cuenta: de ahí cuelgan las plantillas. */
async function waNumbers(ctx: Ctx): Promise<{ id: string; name: string }[]> {
  if (!isAdmin(ctx)) return [];
  const r = await ctx.call.get<any>('/api/social-accounts').catch(() => null);
  return ((r?.accounts ?? []) as any[]).filter((s) => s.platform === 'whatsapp').map((s) => ({ id: s.id, name: s.display_name || s.username || 'WhatsApp' }));
}
async function waNumber(ctx: Ctx, id: string) {
  const n = (await waNumbers(ctx)).find((x) => x.id === id);
  if (!n) throw new ToolError('no_encontrado', 'Ese número de WhatsApp no está conectado en la cuenta.');
  return n;
}
async function templateOf(ctx: Ctx, id: string) {
  const t = ((await ctx.call.get<any[]>('/api/wa-templates')) ?? []).find((x) => x.id === id);
  if (!t) throw new ToolError('no_encontrado', 'Plantilla no encontrada');
  return t;
}

export const verPlantillas = defineTool({
  name: 'ver_plantillas',
  area: 'conversaciones',
  pack: 'plantillas',
  roles: ['admin', 'agent'],
  description: 'Las plantillas de WhatsApp de la cuenta: texto, estado en Meta, si se pueden enviar y cuántas variables llevan; y los números de WhatsApp.',
  schema: z.object({}),
  label: () => 'Revisando las plantillas de WhatsApp…',
  risk: () => 'read',
  async execute(_a, ctx) {
    const [list, numbers] = await Promise.all([ctx.call.get<any[]>('/api/wa-templates'), waNumbers(ctx)]);
    return {
      title: `Revisé las plantillas de WhatsApp (${(list ?? []).length})`,
      links: numbers.length === 1 ? [links.waTemplates(numbers[0].id)] : [],
      data: {
        numeros: numbers.length ? numbers.map((n) => ({ numero_id: n.id, nombre: n.name })) : undefined,
        plantillas: (list ?? []).map((t) => ({
          id: t.id, nombre: t.name, idioma: t.language, categoria: t.category === 'MARKETING' ? 'promocion' : t.category === 'UTILITY' ? 'servicio' : t.category,
          estado: STATUS[t.status] ?? t.status, se_puede_enviar: t.sendable, variables: t.variables || undefined, texto: t.body, motivo_rechazo: t.rejection_reason || undefined, numero_id: t.social_account_id,
        })),
      },
    };
  },
});

const Button = z.object({ texto: z.string().trim().min(1).max(25), url: z.string().trim().url().max(2000).optional().describe('Solo botones de enlace (https)') });

export const crearPlantilla = defineTool({
  name: 'crear_plantilla',
  area: 'conversaciones',
  pack: 'plantillas',
  roles: ['admin'],
  description: 'Crea una plantilla de WhatsApp y la manda a revisión de Meta (después no se edita: solo se borra). Variables {{1}}, {{2}}… con un ejemplo cada una. Se confirma.',
  schema: z.object({
    numero_id: Id,
    nombre: z.string().trim().regex(/^[a-z][a-z0-9_]{0,99}$/, 'Minúsculas, números y _, empezando con letra'),
    categoria: z.enum(['promocion', 'servicio']),
    idioma: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('es_MX'),
    encabezado: z.string().trim().max(60).optional(),
    texto: z.string().trim().min(1).max(1024),
    pie: z.string().trim().max(60).optional(),
    botones: z.array(Button).max(3).optional().describe('Respuesta rápida, o enlace si lleva url'),
    ejemplos: z.array(z.string().trim().min(1).max(200)).max(20).optional().describe('Uno por variable'),
  }),
  label: () => 'Preparando la plantilla…',
  risk: () => ({ level: 'confirm', reasons: ['Se manda a revisión de Meta y ya no se puede editar.'] }),
  async preview(a, ctx) {
    const n = await waNumber(ctx, a.numero_id);
    return {
      title: `Crear la plantilla «${a.nombre}» (${a.categoria === 'promocion' ? 'promoción' : 'servicio'}, ${a.idioma})`,
      lines: [
        `Número: ${n.name}`,
        ...(a.encabezado ? [`Encabezado: ${a.encabezado}`] : []),
        ...(a.pie ? [`Pie: ${a.pie}`] : []),
        ...(a.botones ?? []).map((b) => `Botón: ${b.texto}${b.url ? ` → ${b.url}` : ''}`),
        ...(a.ejemplos?.length ? [`Ejemplos de las variables: ${a.ejemplos.join(' · ')}`] : []),
      ],
      quote: a.texto,
      warning: 'Meta la revisa (puede tardar). Ya enviada, no se edita: para cambiarla hay que borrarla y crear otra.',
    };
  },
  async execute(a, ctx) {
    await waNumber(ctx, a.numero_id);
    const t = await ctx.call.send<any>('POST', '/api/wa-templates', {
      social_account_id: a.numero_id, name: a.nombre, category: CATEGORY[a.categoria], language: a.idioma, header: a.encabezado ?? '', body: a.texto, footer: a.pie ?? '',
      buttons: (a.botones ?? []).map((b) => (b.url ? { type: 'url', text: b.texto, url: b.url } : { type: 'quick_reply', text: b.texto })), examples: a.ejemplos ?? [],
    });
    return {
      title: `Creé la plantilla «${a.nombre}» y la mandé a revisión de Meta`,
      links: [links.waTemplates(a.numero_id)],
      data: { plantilla_id: t?.id, estado: STATUS[t?.status] ?? t?.status ?? 'en revisión' },
    };
  },
});

export const sincronizarPlantillas = defineTool({
  name: 'sincronizar_plantillas',
  area: 'conversaciones',
  pack: 'plantillas',
  roles: ['admin'],
  description: 'Trae de Meta las plantillas de un número de WhatsApp: agrega las nuevas, actualiza su estado (aprobada, rechazada…) y quita las borradas allá.',
  schema: z.object({ numero_id: Id }),
  label: () => 'Trayendo las plantillas de Meta…',
  risk: () => 'reversible',
  async execute(a, ctx) {
    const n = await waNumber(ctx, a.numero_id);
    const r = await ctx.call.send<any>('POST', '/api/wa-templates/sync', { social_account_id: n.id });
    // Es un espejo de lo que hay en Meta: no hay nada que deshacer.
    return { title: `Traje de Meta las plantillas de ${n.name} (${r?.templates ?? 0})`, links: [links.waTemplates(n.id)], undo: null, data: { plantillas: r?.templates ?? 0 } };
  },
});

export const borrarPlantilla = defineTool({
  name: 'borrar_plantilla',
  area: 'conversaciones',
  pack: 'plantillas',
  roles: ['admin'],
  description: 'Borra una plantilla de WhatsApp (también en Meta). Se confirma; no se puede deshacer.',
  schema: z.object({ plantilla_id: Id }),
  label: () => 'Preparando el borrado de la plantilla…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const t = await templateOf(ctx, a.plantilla_id);
    return {
      title: `Borrar la plantilla «${t.name}» (${t.language})`,
      lines: [`Estado: ${STATUS[t.status] ?? t.status}.`, 'Se borra también en Meta: las reglas, recordatorios o campañas que la usen dejan de poder enviarla.'],
      quote: t.body,
      warning: 'No se puede deshacer.',
    };
  },
  async execute(a, ctx) {
    const t = await templateOf(ctx, a.plantilla_id);
    await ctx.call.send('DELETE', path`/api/wa-templates/${t.id}`);
    return { title: `Borré la plantilla «${t.name}»`, links: [links.waTemplates(t.social_account_id)], data: { borrada: true } };
  },
});

export const TEMPLATE_TOOLS = [verPlantillas, crearPlantilla, sincronizarPlantillas, borrarPlantilla];
