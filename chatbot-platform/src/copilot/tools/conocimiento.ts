/**
 * Herramientas del Copiloto sobre lo que sabe un agente (solo administradores): importar información de una página,
 * Google Sheets, texto o un archivo adjunto; el estado del índice; y su biblioteca de fotos y archivos.
 */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { fileForTool } from '../files.js';
import { stableJson } from '../store.js';
import { links } from '../summarize.js';
import { botOf, Id } from './common.js';

const SECTION_NAMES: Record<string, string> = { catalog: 'Productos y precios', hours: 'Horario', location: 'Ubicación', faq: 'Preguntas frecuentes', other: 'Otra información' };

/** La propuesta de importación (IA): de una página o un texto (JSON) o de un archivo adjunto (multipart). */
async function proposal(ctx: Ctx, botId: string, a: { url?: string; texto?: string; archivo_id?: string; nota?: string }) {
  if (a.archivo_id) {
    const f = await fileForTool(ctx, a.archivo_id);
    return ctx.call.upload<any>(path`/api/chatbots/${botId}/knowledge/import`, f, a.nota ? { hint: a.nota } : {});
  }
  return ctx.call.send<any>('POST', path`/api/chatbots/${botId}/knowledge/import`, { ...(a.url ? { url: a.url } : { text: a.texto }), ...(a.nota ? { hint: a.nota } : {}) });
}

export const importarInformacion = defineTool({
  name: 'importar_informacion',
  area: 'agente',
  pack: 'conocimiento',
  roles: ['admin'],
  description: 'Lee información del negocio (una página web, un Google Sheets compartido, un texto o un archivo adjunto: PDF, foto del menú, CSV) y la ordena en secciones para el agente. Se confirma viendo lo encontrado. Gasta IA.',
  schema: z.object({
    agente_id: Id,
    url: z.string().trim().url().max(2000).optional(),
    texto: z.string().trim().min(20).max(40000).optional(),
    archivo_id: Id.optional(),
    nota: z.string().trim().max(300).optional().describe('Qué buscar o cómo ordenarlo'),
  }).refine((a) => [a.url, a.texto, a.archivo_id].filter(Boolean).length === 1, 'Indica una sola fuente: url, texto o archivo_id'),
  label: () => 'Leyendo la información…',
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const p = await proposal(ctx, bot.id, a);
    const found = Object.entries(p.sections ?? {}).filter(([, v]) => String(v ?? '').trim());
    if (!found.length) throw new ToolError('datos_invalidos', 'No encontré información útil en esa fuente.');
    return {
      title: `Agregar al conocimiento de ${bot.name} lo que encontré${p.source_url ? ` en ${p.source_url}` : ''}`,
      lines: [...found.map(([k, v]) => `${SECTION_NAMES[k] ?? k}: ${String(v).length} caracteres`), ...(p.truncated ? ['La fuente era larga: se leyó solo el principio.'] : [])],
      // Lo que se va a guardar, completo, para revisarlo antes de confirmar.
      quote: found.map(([k, v]) => `## ${SECTION_NAMES[k] ?? k}\n${String(v)}`).join('\n\n'),
      meta: { sections: p.sections, source_url: p.source_url ?? null },
    };
  },
  async execute(a, ctx) {
    // Se guarda exactamente lo que se vio al confirmar (sin volver a leer la fuente ni gastar otra vez).
    const meta = ctx.proposal?.meta as { sections?: Record<string, string>; source_url?: string | null } | undefined;
    if (!meta?.sections) throw new ToolError('conflicto', 'La propuesta ya no está; pídemelo de nuevo.');
    const bot = await botOf(ctx, a.agente_id);
    const r = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/knowledge/import-reviewed`, { sections: meta.sections, source_url: meta.source_url ?? null });
    return {
      title: `Agregué al conocimiento de ${bot.name}: ${(r.saved ?? []).join(', ')}`,
      links: [links.bot(bot.id, 'conocimiento', 'Ver conocimiento')],
      data: { guardado: r.saved ?? [] },
    };
  },
});

export const estadoDelIndice = defineTool({
  name: 'estado_del_indice',
  area: 'agente',
  pack: 'conocimiento',
  roles: ['admin'],
  description: 'Cuánto del conocimiento del agente ya está listo para la búsqueda (índice semántico) y cuánto falta.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Revisando el índice del conocimiento…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const r = await ctx.call.get<any>(path`/api/chatbots/${bot.id}/knowledge/index`);
    return {
      title: `Revisé el índice de ${bot.name}`,
      data: { activo: r.enabled, disponible: r.available, completo: r.complete, listos: r.indexed_items, pendientes: r.pending_items, inactivos: r.inactive_items },
    };
  },
});

// --- Fotos y archivos del agente -------------------------------------------------------------------------------------

const imageShape = (i: any) => ({ code: i.code, name: i.name, description: i.description ?? '', usage_rule: i.usage_rule ?? '', caption: i.caption ?? '', active: i.active !== false });

async function imageOf(ctx: Ctx, botId: string, id: string) {
  const bot = await botOf(ctx, botId);
  const image = ((await ctx.call.get<any[]>(path`/api/chatbots/${bot.id}/images`)) ?? []).find((i) => i.id === id);
  if (!image) throw new ToolError('no_encontrado', 'Esa foto o archivo no es de este agente.');
  return { bot, image };
}

export const verFotos = defineTool({
  name: 'ver_fotos',
  area: 'agente',
  pack: 'conocimiento',
  roles: ['admin'],
  description: 'Las fotos y archivos que el agente puede mandar a los clientes, con su código y cuándo los usa.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Revisando las fotos del agente…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const list = (await ctx.call.get<any[]>(path`/api/chatbots/${bot.id}/images`)) ?? [];
    return {
      title: `Revisé las fotos de ${bot.name} (${list.length})`,
      links: [links.bot(bot.id, 'imagenes', 'Ver fotos')],
      data: { fotos: list.map((i) => ({ foto_id: i.id, codigo: i.code, nombre: i.name, tipo: i.kind, activa: i.active !== false, cuando_usarla: i.usage_rule || undefined })) },
    };
  },
});

const Meta = {
  descripcion: z.string().trim().max(1000).optional().describe('Qué se ve (para que el agente la elija bien)'),
  cuando_usarla: z.string().trim().max(1000).optional(),
  pie: z.string().trim().max(1000).optional().describe('Texto que va con la foto'),
};
const metaBody = (a: { nombre?: string; descripcion?: string; cuando_usarla?: string; pie?: string }) => ({
  ...(a.nombre !== undefined ? { name: a.nombre } : {}), ...(a.descripcion !== undefined ? { description: a.descripcion } : {}),
  ...(a.cuando_usarla !== undefined ? { usage_rule: a.cuando_usarla } : {}), ...(a.pie !== undefined ? { caption: a.pie } : {}),
});

export const subirFoto = defineTool({
  name: 'subir_foto',
  area: 'agente',
  pack: 'conocimiento',
  roles: ['admin'],
  description: 'Agrega a la biblioteca del agente una foto o archivo que la persona adjuntó (archivo_id), con su código y cuándo mandarla.',
  schema: z.object({ agente_id: Id, archivo_id: Id, codigo: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,60}$/), nombre: z.string().trim().min(1).max(120), ...Meta }),
  label: () => 'Subiendo la foto al agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const f = await fileForTool(ctx, a.archivo_id);
    const img = await ctx.call.upload<any>(path`/api/chatbots/${bot.id}/images`, f, { code: a.codigo, ...(metaBody(a) as Record<string, string>) });
    return {
      title: `Agregué «${img.name}» a las fotos de ${bot.name}`,
      links: [links.bot(bot.id, 'imagenes', 'Ver fotos')],
      after: imageShape(img),
      undo: { label: 'Deshacer', custom: { tool: 'subir_foto', params: { bot_id: bot.id, id: img.id, after: imageShape(img) } } },
      data: { foto_id: img.id, codigo: img.code },
    };
  },
  async undo(p: { bot_id: string; id: string; after: unknown }, ctx) {
    const img = ((await ctx.call.get<any[]>(path`/api/chatbots/${p.bot_id}/images`)) ?? []).find((i) => i.id === p.id);
    if (!img) return;
    if (stableJson(imageShape(img)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La foto cambió después; para no perder esos cambios, no la borré.');
    await ctx.call.send('DELETE', path`/api/images/${p.id}`);
  },
});

export const editarFoto = defineTool({
  name: 'editar_foto',
  area: 'agente',
  pack: 'conocimiento',
  roles: ['admin'],
  description: 'Cambia el nombre, la descripción, cuándo usarla, el pie o si está activa una foto o archivo del agente.',
  schema: z.object({ agente_id: Id, foto_id: Id, nombre: z.string().trim().min(1).max(120).optional(), ...Meta, activa: z.boolean().optional() })
    .refine((a) => [a.nombre, a.descripcion, a.cuando_usarla, a.pie, a.activa].some((x) => x !== undefined), 'Indica qué cambiar'),
  label: () => 'Editando la foto…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async execute(a, ctx) {
    const { bot, image } = await imageOf(ctx, a.agente_id, a.foto_id);
    const r = await ctx.call.send<any>('PUT', path`/api/images/${image.id}`, { ...metaBody(a), ...(a.activa !== undefined ? { active: a.activa } : {}) });
    const after = imageShape(r.image ?? r);
    return {
      title: `Edité «${after.name}» en las fotos de ${bot.name}`,
      links: [links.bot(bot.id, 'imagenes', 'Ver fotos')],
      before: imageShape(image), after,
      undo: { label: 'Deshacer', custom: { tool: 'editar_foto', params: { bot_id: bot.id, id: image.id, before: imageShape(image), after } } },
      data: { foto_id: image.id, aviso: r.warning || undefined },
    };
  },
  async undo(p: { bot_id: string; id: string; before: any; after: unknown }, ctx) {
    const { image } = await imageOf(ctx, p.bot_id, p.id);
    if (stableJson(imageShape(image)) !== stableJson(p.after)) throw new ToolError('conflicto', 'La foto cambió después; para no perder esos cambios, no la regresé.');
    const { code: _code, ...rest } = p.before;
    await ctx.call.send('PUT', path`/api/images/${p.id}`, rest);
  },
});

export const borrarFoto = defineTool({
  name: 'borrar_foto',
  area: 'agente',
  pack: 'conocimiento',
  roles: ['admin'],
  description: 'Borra una foto o archivo de la biblioteca del agente (también se quita de las reglas y secuencias que la usan). Se confirma.',
  schema: z.object({ agente_id: Id, foto_id: Id }),
  label: () => 'Preparando el borrado de la foto…',
  risk: () => ({ level: 'confirm', reasons: ['No se puede deshacer: el archivo se borra.'] }),
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const { bot, image } = await imageOf(ctx, a.agente_id, a.foto_id);
    return { title: `Borrar «${image.name}» de las fotos de ${bot.name}`, lines: [`Código: ${image.code}`, 'Se quita también de las reglas y secuencias que la usan.'], warning: 'No se puede deshacer.' };
  },
  async execute(a, ctx) {
    const { bot, image } = await imageOf(ctx, a.agente_id, a.foto_id);
    const r = await ctx.call.send<any>('DELETE', path`/api/images/${image.id}`);
    return { title: `Borré «${image.name}» de las fotos de ${bot.name}`, links: [links.bot(bot.id, 'imagenes', 'Ver fotos')], data: { borrada: true, aviso: r?.warning || undefined } };
  },
});

export const KNOWLEDGE_TOOLS = [importarInformacion, estadoDelIndice, verFotos, subirFoto, editarFoto, borrarFoto];
