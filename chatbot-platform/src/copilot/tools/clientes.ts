/**
 * Herramientas del Copiloto para los contactos más allá de la ficha (fase 2): los campos de «Datos de tus clientes»,
 * importar contactos de un CSV adjunto, las vistas guardadas, borrar un pendiente y los derechos del cliente (descargar
 * todo lo que se guarda de él o borrarlo, que en el panel pide el código).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseCsv } from '../../contacts/csv.js';
import { importColumns } from '../../contacts/import.js';
import { path, ToolError } from '../executor.js';
import { fileForTool } from '../files.js';
import { defineTool, type Ctx } from '../registry.js';
import { stableJson } from '../store.js';
import { links } from '../summarize.js';
import { Id, nameOf, profile, Text } from './common.js';

// --- Campos de «Datos de tus clientes» -------------------------------------------------------------------------------

const TYPES = { texto: 'text', numero: 'number', fecha: 'date', opcion: 'option', correo: 'email', telefono: 'phone' } as const;
const TYPES_ES: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([es, en]) => [en, es]));
const fields = async (ctx: Ctx) => ((await ctx.call.get<any[]>('/api/contact-fields')) ?? []) as any[];
async function fieldOf(ctx: Ctx, id: string) {
  const f = (await fields(ctx)).find((x) => x.id === id);
  if (!f) throw new ToolError('no_encontrado', 'Ese campo no es de la cuenta');
  return f;
}
const fieldShape = (f: any) => ({ label: f.label, type: f.type, options: f.options ?? [] });

export const campoDeContacto = defineTool({
  name: 'campo_de_contacto',
  area: 'contactos',
  roles: ['admin'],
  description: 'Crea un campo de «Datos de tus clientes» (sin campo_id; la clave no cambia después) o cambia la etiqueta, el tipo o las opciones de uno.',
  schema: z.object({
    campo_id: Id.optional(),
    clave: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Minúsculas, números y _').optional().describe('Solo al crear'),
    etiqueta: Text(80).optional(),
    tipo: z.enum(['texto', 'numero', 'fecha', 'opcion', 'correo', 'telefono']).optional(),
    opciones: z.array(Text(100)).max(50).optional().describe('Para el tipo opcion'),
  }).refine((a) => (a.campo_id ? a.etiqueta || a.tipo || a.opciones : a.clave && a.etiqueta), 'Para crear, indica clave y etiqueta; para cambiar, qué cambia'),
  label: (a) => (a.campo_id ? 'Cambiando el campo…' : 'Creando el campo…'),
  risk: () => 'reversible',
  async execute(a, ctx) {
    const body = { ...(a.etiqueta ? { label: a.etiqueta } : {}), ...(a.tipo ? { type: TYPES[a.tipo] } : {}), ...(a.opciones ? { options: a.opciones } : {}) };
    if (!a.campo_id) {
      const f = await ctx.call.send<any>('POST', '/api/contact-fields', { key: a.clave, ...body });
      return {
        title: `Creé el campo «${f.label}» (${f.key})`,
        links: [links.contactFields()],
        after: fieldShape(f),
        undo: { label: 'Deshacer', custom: { tool: 'campo_de_contacto', params: { id: f.id, before: null, after: fieldShape(f) } } },
        data: { campo_id: f.id, clave: f.key, tipo: TYPES_ES[f.type] },
      };
    }
    const before = await fieldOf(ctx, a.campo_id);
    const f = await ctx.call.send<any>('PUT', path`/api/contact-fields/${before.id}`, body);
    return {
      title: `Cambié el campo «${f.label}» (${f.key})`,
      links: [links.contactFields()],
      before: fieldShape(before),
      after: fieldShape(f),
      undo: { label: 'Deshacer', custom: { tool: 'campo_de_contacto', params: { id: f.id, before: fieldShape(before), after: fieldShape(f) } } },
      data: { campo_id: f.id, clave: f.key, tipo: TYPES_ES[f.type], opciones: f.options?.length ? f.options : undefined },
    };
  },
  async undo(p: { id: string; before: Record<string, unknown> | null; after: unknown }, ctx) {
    const f = (await fields(ctx)).find((x) => x.id === p.id);
    if (!f) { if (!p.before) return; throw new ToolError('conflicto', 'El campo ya no existe.'); }
    if (stableJson(fieldShape(f)) !== stableJson(p.after)) throw new ToolError('conflicto', 'El campo cambió después; para no perder esos cambios, no lo regresé.');
    if (p.before) await ctx.call.send('PUT', path`/api/contact-fields/${p.id}`, p.before);
    else await ctx.call.send('DELETE', path`/api/contact-fields/${p.id}`);
  },
});

export const borrarCampoDeContacto = defineTool({
  name: 'borrar_campo_de_contacto',
  area: 'contactos',
  roles: ['admin'],
  description: 'Borra un campo de «Datos de tus clientes» (lo que ya guardaron los contactos se queda en «otros datos»). Se confirma.',
  schema: z.object({ campo_id: Id }),
  label: () => 'Preparando el borrado del campo…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const f = await fieldOf(ctx, a.campo_id);
    return { title: `Borrar el campo «${f.label}» (${f.key})`, lines: ['Lo que ya tienen guardado los contactos se queda (en «otros datos» de la ficha y en la exportación).', 'Las variables {{campo.' + f.key + '}} dejan de llenarse.'] };
  },
  async execute(a, ctx) {
    const f = await fieldOf(ctx, a.campo_id);
    await ctx.call.send('DELETE', path`/api/contact-fields/${f.id}`);
    return { title: `Borré el campo «${f.label}»`, links: [links.contactFields()], data: { borrado: true } };
  },
});

export const ordenarCamposDeContacto = defineTool({
  name: 'ordenar_campos_de_contacto',
  area: 'contactos',
  roles: ['admin'],
  description: 'Cambia el orden de los campos de «Datos de tus clientes» (por su clave; los que no pongas van después, como estaban).',
  schema: z.object({ claves: z.array(z.string().trim().min(1).max(64)).min(1).max(60) }),
  label: () => 'Ordenando los campos…',
  risk: () => 'reversible',
  async execute(a, ctx) {
    const list = await fields(ctx);
    const unknown = a.claves.filter((k) => !list.some((f) => f.key === k));
    if (unknown.length) throw new ToolError('datos_invalidos', `No hay campos con la clave: ${unknown.join(', ')}`, list.map((f) => f.key));
    const before = list.map((f) => f.id);
    const ids = a.claves.map((k) => list.find((f) => f.key === k)!.id);
    const saved = (await ctx.call.send<any[]>('PUT', '/api/contact-fields/order', { ids })) ?? [];
    const after = saved.map((f) => f.id);
    return {
      title: `Ordené los campos: ${saved.slice(0, 6).map((f) => f.label).join(', ')}${saved.length > 6 ? '…' : ''}`,
      links: [links.contactFields()],
      before, after,
      undo: { label: 'Deshacer', custom: { tool: 'ordenar_campos_de_contacto', params: { before, after } } },
      data: { orden: saved.map((f) => f.key) },
    };
  },
  async undo(p: { before: string[]; after: string[] }, ctx) {
    if (stableJson((await fields(ctx)).map((f) => f.id)) !== stableJson(p.after)) throw new ToolError('conflicto', 'Los campos cambiaron después; para no perder esos cambios, no regresé el orden.');
    await ctx.call.send('PUT', '/api/contact-fields/order', { ids: p.before });
  },
});

// --- Importar contactos ----------------------------------------------------------------------------------------------

/** El CSV adjunto como texto (lo que lee la importación del panel). */
async function csvOf(ctx: Ctx, archivoId: string) {
  const f = await fileForTool(ctx, archivoId);
  if (f.mime !== 'text/csv' && f.mime !== 'text/plain') throw new ToolError('datos_invalidos', 'Adjunta un archivo CSV (con la columna «telefono»). Si es Excel, guárdalo como CSV.');
  return { name: f.name, text: f.buffer.toString('utf8').replace(/^﻿/, '') };
}
/** El canal de WhatsApp al que entran: el indicado o, si la cuenta tiene uno solo, ese. */
async function importChannel(ctx: Ctx, id?: string) {
  const wa = ((await ctx.call.get<any[]>('/api/channels')) ?? []).filter((c) => c.type === 'whatsapp');
  const ch = id ? wa.find((c) => c.id === id) : wa.length === 1 ? wa[0] : null;
  if (!ch) throw new ToolError('datos_invalidos', id ? 'Ese canal no es un WhatsApp de la cuenta.' : wa.length ? 'Indica a qué WhatsApp entran (canal_id).' : 'La cuenta no tiene un canal de WhatsApp para importar contactos.', wa.map((c) => `${c.name}: ${c.id}`));
  return ch;
}

export const importarContactos = defineTool({
  name: 'importar_contactos',
  area: 'contactos',
  roles: ['admin'],
  description: 'Importa contactos de un CSV adjunto (archivo_id) a un WhatsApp: alta o actualización por teléfono, con nombre, etiquetas y datos. No dispara reglas. Se confirma.',
  schema: z.object({ archivo_id: Id, canal_id: Id.optional().describe('Sin id: el único WhatsApp de la cuenta') }),
  label: () => 'Revisando el archivo de contactos…',
  risk: () => ({ level: 'confirm', reasons: ['Agrega o actualiza contactos en bloque; no se deshace desde aquí.'] }),
  async preview(a, ctx) {
    const { name, text } = await csvOf(ctx, a.archivo_id);
    const ch = await importChannel(ctx, a.canal_id);
    const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
    if (rows.length < 2) throw new ToolError('datos_invalidos', 'El archivo no trae contactos (solo el encabezado o nada).');
    const cols = importColumns(rows[0], await fields(ctx));
    if (!cols.hasPhone) throw new ToolError('datos_invalidos', 'Falta la columna «telefono».');
    const read = rows[0].filter((_, i) => cols.cols[i]).map((h) => h.trim());
    return {
      title: `Importar ${rows.length - 1} contacto(s) de «${name}» a ${ch.name}`,
      lines: [`Columnas que se leen: ${read.join(', ')}`, ...(cols.ignored.length ? [`Se ignoran: ${cols.ignored.join(', ')}`] : []), 'Si el teléfono ya existe, se actualiza; una celda vacía no borra nada. No manda mensajes ni dispara reglas.'],
      // La importación usa exactamente el archivo que se vio.
      meta: { sha256: createHash('sha256').update(text).digest('hex'), channel_id: ch.id },
    };
  },
  async execute(a, ctx) {
    const { text } = await csvOf(ctx, a.archivo_id);
    const meta = ctx.proposal?.meta as { sha256?: string; channel_id?: string } | undefined;
    if (meta?.sha256 && meta.sha256 !== createHash('sha256').update(text).digest('hex')) throw new ToolError('conflicto', 'El archivo cambió; pídemelo de nuevo.');
    const ch = await importChannel(ctx, meta?.channel_id ?? a.canal_id);
    const r = await ctx.call.send<any>('POST', '/api/contacts/import', { channel_id: ch.id, csv: text });
    return {
      title: `Importé contactos a ${ch.name}: ${r.created} nuevo(s), ${r.updated} actualizado(s)${r.errors?.length ? `, ${r.errors.length} con error` : ''}`,
      links: [links.contacts()],
      // Los errores repiten celdas del archivo (lo escribió alguien más): son datos.
      untrusted: true,
      data: { nuevos: r.created, actualizados: r.updated, con_error: r.errors?.length ?? 0, datos_del_cliente: { errores: (r.errors ?? []).slice(0, 10), columnas_ignoradas: r.ignored_columns } },
    };
  },
});

// --- Vistas guardadas ------------------------------------------------------------------------------------------------

const VIEW = { todos: 'all', pendientes: 'pending', sin_asignar: 'unassigned', con_cita: 'upcoming' } as const;
const VIEW_ES: Record<string, string> = Object.fromEntries(Object.entries(VIEW).map(([es, en]) => [en, es]));
const views = async (ctx: Ctx) => ((await ctx.call.get<any[]>('/api/contact-views')) ?? []) as any[];

export const vistasDeContactos = defineTool({
  name: 'vistas_de_contactos',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Tus vistas guardadas de la lista de contactos: verlas, guardar una (filtro, búsqueda y etiqueta; con el mismo nombre se reemplaza) o borrarla.',
  schema: z.object({
    accion: z.enum(['ver', 'guardar', 'borrar']),
    nombre: Text(80).optional(),
    filtro: z.enum(['todos', 'pendientes', 'sin_asignar', 'con_cita']).optional(),
    buscar: z.string().trim().max(200).optional(),
    etiqueta: z.string().trim().max(60).optional(),
  }).refine((a) => a.accion === 'ver' || a.nombre, 'Indica el nombre de la vista'),
  label: (a) => (a.accion === 'ver' ? 'Revisando tus vistas…' : a.accion === 'guardar' ? 'Guardando la vista…' : 'Borrando la vista…'),
  risk: (a) => (a.accion === 'ver' ? 'read' : 'reversible'),
  targets: () => [],
  async execute(a, ctx) {
    const list = await views(ctx);
    const viewOut = (v: any) => ({ nombre: v.name, filtro: VIEW_ES[v.filters?.view] ?? v.filters?.view, buscar: v.filters?.search || undefined, etiqueta: v.filters?.tag || undefined });
    if (a.accion === 'ver') return { title: `Revisé tus vistas (${list.length})`, links: [links.contacts()], data: { vistas: list.map(viewOut) } };
    const old = list.find((v) => v.name.toLowerCase() === a.nombre!.toLowerCase()) ?? null;
    if (a.accion === 'borrar') {
      if (!old) throw new ToolError('no_encontrado', 'No tienes una vista con ese nombre', list.map((v) => v.name));
      await ctx.call.send('DELETE', path`/api/contact-views/${old.id}`);
      return {
        title: `Borré tu vista «${old.name}»`, links: [links.contacts()],
        undo: { label: 'Deshacer', custom: { tool: 'vistas_de_contactos', params: { name: old.name, before: old.filters, after: null } } },
        data: { borrada: true },
      };
    }
    const filters = { view: VIEW[a.filtro ?? 'todos'], search: a.buscar ?? '', tag: a.etiqueta ?? '' };
    const v = await ctx.call.send<any>('POST', '/api/contact-views', { name: old?.name ?? a.nombre, filters });
    return {
      title: `${old ? 'Cambié' : 'Guardé'} tu vista «${v.name}»`, links: [links.contacts()],
      undo: { label: 'Deshacer', custom: { tool: 'vistas_de_contactos', params: { name: v.name, before: old?.filters ?? null, after: v.filters } } },
      data: viewOut(v),
    };
  },
  async undo(p: { name: string; before: unknown; after: unknown }, ctx) {
    const v = (await views(ctx)).find((x) => x.name === p.name) ?? null;
    if (stableJson(v?.filters ?? null) !== stableJson(p.after)) throw new ToolError('conflicto', 'La vista cambió después; para no perder esos cambios, no la regresé.');
    if (p.before) await ctx.call.send('POST', '/api/contact-views', { name: p.name, filters: p.before });
    else if (v) await ctx.call.send('DELETE', path`/api/contact-views/${v.id}`);
  },
});

// --- Pendientes ------------------------------------------------------------------------------------------------------

export const borrarTarea = defineTool({
  name: 'borrar_tarea',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Borra un pendiente o una nota de un contacto (un agente, solo los que creó). Se confirma.',
  schema: z.object({ contacto_id: Id, tarea_id: Id }),
  label: () => 'Preparando el borrado del pendiente…',
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  async preview(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    const t = ((await ctx.call.get<any[]>(path`/api/contacts/${p.contact.id}/tasks`)) ?? []).find((x) => x.id === a.tarea_id);
    if (!t) throw new ToolError('no_encontrado', 'Ese pendiente no es de este contacto');
    return { title: `Borrar ${t.kind === 'nota' ? 'una nota' : 'un pendiente'} de ${nameOf(p.contact)}`, lines: [t.due_on ? `Vence el ${String(t.due_on).slice(0, 10)}.` : '', 'No se puede deshacer.'].filter(Boolean), quote: t.body };
  },
  async execute(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    const t = ((await ctx.call.get<any[]>(path`/api/contacts/${p.contact.id}/tasks`)) ?? []).find((x) => x.id === a.tarea_id);
    if (!t) throw new ToolError('no_encontrado', 'Ese pendiente no es de este contacto');
    await ctx.call.send('DELETE', path`/api/tasks/${t.id}`);
    return { title: `Borré ${t.kind === 'nota' ? 'la nota' : 'el pendiente'} de ${nameOf(p.contact)}`, contactIds: [p.contact.id], links: [links.contact(p.contact.id)], data: { borrado: true } };
  },
});

// --- Derechos del cliente: descargar o borrar todo lo suyo -----------------------------------------------------------

export const descargarDatosDeContacto = defineTool({
  name: 'descargar_datos_de_contacto',
  area: 'contactos',
  roles: ['admin'],
  description: 'Prepara la descarga (JSON) de todo lo que se guarda de un contacto, para su derecho de acceso. La persona la baja con «Descargar» en la tarjeta. Se confirma.',
  schema: z.object({ contacto_id: Id }),
  label: () => 'Preparando la descarga de los datos…',
  risk: () => ({ level: 'confirm', reasons: ['El archivo lleva todos los datos y mensajes del cliente.'] }),
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  download: (a) => `/api/contacts/${a.contacto_id}/data`,
  async preview(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    return { title: `Descargar los datos de ${nameOf(p.contact)}`, lines: ['Un archivo JSON con sus datos, conversaciones, mensajes, citas, pendientes y cobros.', 'Al confirmar, lo descargas con «Descargar» en esta tarjeta; no pasa por el Copiloto.'] };
  },
  async execute(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    return { title: `Preparé la descarga de los datos de ${nameOf(p.contact)}`, contactIds: [p.contact.id], links: [links.contact(p.contact.id)], data: { listo: true, nota: 'La persona lo descarga con «Descargar» en la tarjeta.' } };
  },
});

export const borrarContacto = defineTool({
  name: 'borrar_contacto',
  area: 'contactos',
  roles: ['admin'],
  description: 'Borra a un contacto y todo su historial (derecho de supresión). No se puede deshacer; se confirma con el código de verificación en la tarjeta.',
  schema: z.object({ contacto_id: Id }),
  label: () => 'Preparando el borrado del contacto…',
  risk: () => ({ level: 'code', reasons: ['Borra todo su historial y no se puede deshacer: se confirma con tu código de verificación.'] }),
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  grants: ['DELETE /api/contacts/:id'],
  async preview(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    const convs = (p.conversations ?? []).filter((c: any) => c.contact_id === p.contact.id).length;
    // El título no lleva el nombre: al borrarlo, lo que quede del Copiloto no debe nombrarlo.
    return {
      title: 'Borrar un contacto y todo su historial',
      lines: [`Contacto: ${nameOf(p.contact)}${p.contact.phone ? ` (${p.contact.phone})` : ''}`, `${convs} conversación(es), con sus mensajes, citas, pendientes y cobros.`],
      warning: 'No se puede deshacer.',
    };
  },
  async execute(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    const r = await ctx.call.send<any>('DELETE', path`/api/contacts/${p.contact.id}`);
    return { title: 'Borré un contacto y todo su historial', links: [links.contacts()], data: { borrado: true, conversaciones: r?.conversations ?? 0, mensajes: r?.messages ?? 0 } };
  },
});

export const CLIENT_TOOLS = [campoDeContacto, borrarCampoDeContacto, ordenarCamposDeContacto, importarContactos, vistasDeContactos, borrarTarea, descargarDatosDeContacto, borrarContacto];
