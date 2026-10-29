/** Herramientas del Copiloto para contactos: buscar, ver, editar datos, etiquetar, dar de baja y pendientes. */
import { z } from 'zod';
import { path, qs, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { stableJson } from '../store.js';
import { day, links, when } from '../summarize.js';
import { dataVersion, Id, nameOf, profile } from './common.js';

const Tag = z.string().trim().min(1).max(60);
const DueOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD');
const VIEWS = { todos: 'all', pendientes: 'pending', sin_asignar: 'unassigned', con_cita: 'upcoming' } as const;

export const buscarContactos = defineTool({
  name: 'buscar_contactos',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Busca contactos por nombre, teléfono o etiqueta (o los que tienen pendientes, sin asignar o con cita). Devuelve su id, etiquetas y próxima cita.',
  schema: z.object({
    texto: z.string().trim().max(120).optional().describe('Nombre o teléfono, completo o parcial'),
    etiqueta: Tag.optional(),
    vista: z.enum(['todos', 'pendientes', 'sin_asignar', 'con_cita']).optional(),
    limite: z.number().int().min(1).max(50).optional(),
  }),
  label: (a) => (a.texto ? `Buscando «${a.texto}» en contactos…` : 'Buscando contactos…'),
  risk: () => 'read',
  async execute(a, ctx) {
    const r = await ctx.call.get<any>(`/api/contacts${qs({ search: a.texto, tag: a.etiqueta, view: VIEWS[a.vista ?? 'todos'] })}`);
    const all: any[] = r.items ?? [];
    const items = all.slice(0, a.limite ?? 20);
    return {
      title: `Busqué contactos${a.texto ? ` «${a.texto}»` : ''}${a.etiqueta ? ` con la etiqueta ${a.etiqueta}` : ''}: ${items.length}`,
      data: {
        mostrados: items.length,
        hay_mas: !!r.has_more || all.length > items.length,
        contactos: items.map((c) => ({
          id: c.id, nombre: nameOf(c), telefono: c.phone, etiquetas: c.tags, ultima_actividad: when(c.last_activity, ctx.timezone),
          proxima_cita: when(c.next_appointment, ctx.timezone) || undefined, con_pendientes: c.pending || undefined, sin_asignar: c.unassigned || undefined,
        })),
      },
    };
  },
});

export const verContacto = defineTool({
  name: 'ver_contacto',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Ficha de un contacto: datos, etiquetas, conversaciones, pendientes, próximas citas y cotizaciones.',
  schema: z.object({ contacto_id: Id }),
  label: () => 'Abriendo la ficha del contacto…',
  risk: () => 'read',
  async execute(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    const c = p.contact;
    return {
      title: `Revisé la ficha de ${nameOf(c)}`,
      untrusted: true,
      contactIds: [c.id],
      read: [{ kind: 'contact', id: c.id }],
      links: [links.contact(c.id)],
      data: {
        id: c.id, nombre: nameOf(c), telefono: c.phone, etiquetas: p.tags, dado_de_baja: c.opted_out || undefined, acepta_promociones: !!c.consent_at,
        canales: (p.records ?? []).map((r: any) => r.channel_name),
        conversaciones: (p.conversations ?? []).slice(0, 5).map((cv: any) => ({ id: cv.id, estado: cv.status, asignada_a: cv.assigned_name ?? undefined, agente: cv.chatbot_name ?? undefined, ultimo_mensaje: when(cv.last_message_at, ctx.timezone) })),
        pendientes: (p.tasks ?? []).filter((t: any) => t.status === 'abierta').slice(0, 10).map((t: any) => ({ id: t.id, tipo: t.kind, texto: t.body, vence: t.due_on ?? undefined })),
        proximas_citas: (p.appointments ?? []).slice(0, 5).map((ap: any) => ({ id: ap.id, servicio: ap.service_name, inicio: when(ap.starts_at, ctx.timezone), estado: ap.status })),
        cotizaciones: (p.quotes ?? []).slice(0, 5).map((q: any) => ({ id: q.id, folio: q.folio, estado: q.status, total: q.total_max ?? q.total_min, moneda: q.currency })),
        datos_del_cliente: { datos: c.data, notas: c.notes },
      },
    };
  },
});

export const editarContacto = defineTool({
  name: 'editar_contacto',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Cambia el nombre de un contacto, sus datos (por clave; null borra un dato) o le agrega una nota. No toca lo demás.',
  schema: z.object({
    contacto_id: Id,
    nombre: z.string().trim().min(1).max(100).optional(),
    datos: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.string().max(500).nullable()).optional().describe('Clave del dato → valor nuevo (null lo borra)'),
    nota: z.string().trim().min(1).max(300).optional().describe('Nota nueva para la ficha'),
  }).refine((a) => a.nombre !== undefined || a.datos !== undefined || a.nota !== undefined, 'Indica qué cambiar'),
  label: () => 'Actualizando el contacto…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  events: (a) => [
    ...Object.entries(a.datos ?? {}).filter(([, v]) => v).map(([k]) => ({ type: 'data_captured', value: k })),
    ...(a.nombre ? [{ type: 'data_captured', value: 'nombre' }] : []),
  ],
  async execute(a, ctx) {
    const before = await profile(ctx, a.contacto_id);
    const c = before.contact;
    const data = a.datos ? { ...c.data } : undefined;
    if (data) for (const [k, v] of Object.entries(a.datos!)) { if (v === null) delete data[k]; else data[k] = v; }
    const notes = a.nota ? [...(c.notes ?? []), a.nota].slice(-50) : undefined;
    await ctx.call.send('PUT', path`/api/contacts/${c.id}`, { ...(a.nombre ? { name: a.nombre } : {}), ...(data ? { data } : {}), ...(notes ? { notes } : {}), base_data_version: dataVersion(before) });
    const after = await profile(ctx, c.id);
    const what = [a.nombre ? 'nombre' : '', ...Object.keys(a.datos ?? {}), a.nota ? 'una nota' : ''].filter(Boolean).join(', ');
    return {
      title: `Actualicé a ${nameOf(after.contact)} (${what})`,
      contactIds: [c.id],
      links: [links.contact(c.id)],
      before: { name: c.name, data: c.data, notes: c.notes },
      after: { name: after.contact.name, data: after.contact.data, notes: after.contact.notes },
      // Se devuelven nombre, datos y notas de antes; si algo cambió desde entonces, el servidor no lo pisa (versión de datos).
      undo: {
        label: 'Deshacer',
        steps: [{ method: 'PUT', url: path`/api/contacts/${c.id}`, body: { ...(a.nombre ? { name: c.name } : {}), ...(data ? { data: c.data } : {}), ...(notes ? { notes: c.notes } : {}), base_data_version: dataVersion(after) } }],
      },
      data: { contacto: { id: c.id, nombre: nameOf(after.contact), datos: after.contact.data } },
    };
  },
});

type TagChange = { id: string; added: string[]; removed: string[] };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function setTags(ctx: Ctx, id: string, change: (tags: string[]) => string[]) {
  const p = await profile(ctx, id);
  const tags: string[] = p.contact.tags ?? [];
  const next = change(tags);
  if (next.length === tags.length && next.every((t, i) => t === tags[i])) return p.contact;
  return ctx.call.send('PUT', path`/api/contacts/${id}`, { tags: next });
}

export const etiquetar = defineTool({
  name: 'etiquetar',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Agrega o quita etiquetas a uno o varios contactos (hasta 20 a la vez).',
  schema: z.object({
    contacto_ids: z.array(Id).min(1).max(20),
    agregar: z.array(Tag).max(10).default([]),
    quitar: z.array(Tag).max(10).default([]),
  }).refine((a) => a.agregar.length || a.quitar.length, 'Indica qué etiquetas agregar o quitar'),
  label: (a) => `Etiquetando ${a.contacto_ids.length === 1 ? 'al contacto' : `${a.contacto_ids.length} contactos`}…`,
  risk: () => 'reversible',
  targets: (a) => a.contacto_ids.map((id) => ({ kind: 'contact', id })),
  events: (a) => a.agregar.map((t) => ({ type: 'tag_added', value: t })),
  async execute(a, ctx) {
    // Primero se revisa que todos existan y se puedan ver: si uno falla, no se cambia ninguno.
    const profiles = [];
    for (const id of a.contacto_ids) profiles.push(await profile(ctx, id));
    const changes: TagChange[] = [];
    const errors: string[] = [];
    for (const p of profiles) {
      const tags: string[] = p.contact.tags ?? [];
      const added = a.agregar.filter((t) => !tags.some((x) => same(x, t)));
      const removed = tags.filter((x) => a.quitar.some((t) => same(x, t)));
      if (!added.length && !removed.length) continue;
      try {
        await ctx.call.send('PUT', path`/api/contacts/${p.contact.id}`, { tags: [...tags.filter((x) => !removed.includes(x)), ...added] });
        changes.push({ id: p.contact.id, added, removed });
      } catch (e) {
        errors.push(`${nameOf(p.contact)}: ${e instanceof ToolError ? e.message : 'no se pudo'}`);
      }
    }
    const who = profiles.length === 1 ? nameOf(profiles[0].contact) : `${changes.length} contactos`;
    const what = [...a.agregar.map((t) => `+${t}`), ...a.quitar.map((t) => `−${t}`)].join(' ');
    if (!changes.length && errors.length) throw new ToolError('error', errors.join('; '));
    return {
      title: changes.length ? `Etiqueté a ${who}: ${what}` : `Sin cambios: ${who} ya tenía esas etiquetas`,
      contactIds: changes.map((c) => c.id),
      links: profiles.length === 1 ? [links.contact(profiles[0].contact.id)] : [],
      undo: changes.length ? { label: 'Deshacer', custom: { tool: 'etiquetar', params: { changes } } } : null,
      data: { cambiados: changes.length, sin_cambio: profiles.length - changes.length - errors.length, ...(errors.length ? { errores: errors } : {}) },
    };
  },
  async undo(params: { changes: TagChange[] }, ctx) {
    const errors: string[] = [];
    for (const c of params.changes) {
      try {
        await setTags(ctx, c.id, (tags) => [...tags.filter((t) => !c.added.includes(t)), ...c.removed.filter((t) => !tags.some((x) => same(x, t)))]);
      } catch (e) {
        errors.push(e instanceof ToolError ? e.message : 'no se pudo');
      }
    }
    if (errors.length === params.changes.length) throw new ToolError('error', errors[0] ?? 'No se pudo deshacer');
  },
});

export const darDeBaja = defineTool({
  name: 'dar_de_baja',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Da de baja a un contacto: deja de recibir campañas y secuencias. Requiere confirmación.',
  schema: z.object({ contacto_id: Id }),
  label: () => 'Preparando la baja del contacto…',
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  async preview(a, ctx) {
    const p = await profile(ctx, a.contacto_id);
    return { title: `Dar de baja a ${nameOf(p.contact)}`, lines: ['Deja de recibir campañas y secuencias; las que tenga en curso se detienen.', 'Para volver a enviarle promociones hará falta su consentimiento.'] };
  },
  async execute(a, ctx) {
    const c = await ctx.call.send<any>('PUT', path`/api/contacts/${a.contacto_id}`, { opted_out: true });
    return { title: `Di de baja a ${nameOf(c)}`, contactIds: [a.contacto_id], links: [links.contact(a.contacto_id)], data: { dado_de_baja: true } };
  },
});

async function findTask(ctx: Ctx, contactId: string, taskId: string) {
  const list = await ctx.call.get<any[]>(path`/api/contacts/${contactId}/tasks`);
  return (list ?? []).find((t) => t.id === taskId) ?? null;
}
const taskShape = (t: any) => ({ body: t.body, status: t.status, due_on: t.due_on ?? null });

export const crearTarea = defineTool({
  name: 'crear_tarea',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Agrega un pendiente (con fecha límite opcional) o una nota a un contacto.',
  schema: z.object({
    contacto_id: Id,
    tipo: z.enum(['pendiente', 'nota']).default('pendiente'),
    texto: z.string().trim().min(1).max(1000),
    vence: DueOn.optional().describe('Fecha límite AAAA-MM-DD (solo pendientes)'),
  }),
  label: (a) => (a.tipo === 'nota' ? 'Agregando una nota…' : 'Agregando un pendiente…'),
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  async execute(a, ctx) {
    const t = await ctx.call.send<any>('POST', path`/api/contacts/${a.contacto_id}/tasks`, { kind: a.tipo, body: a.texto, ...(a.vence && a.tipo === 'pendiente' ? { due_on: a.vence } : {}) });
    return {
      title: `${a.tipo === 'nota' ? 'Agregué la nota' : 'Agregué el pendiente'} «${a.texto.slice(0, 60)}»${t.due_on ? ` para el ${day(t.due_on, ctx.timezone)}` : ''}`,
      contactIds: [a.contacto_id],
      links: [links.contact(a.contacto_id)],
      after: taskShape(t),
      undo: { label: 'Deshacer', custom: { tool: 'crear_tarea', params: { contact_id: a.contacto_id, task_id: t.id, after: taskShape(t) } } },
      data: { tarea: { id: t.id, tipo: t.kind, texto: t.body, vence: t.due_on ?? undefined } },
    };
  },
  async undo(params: { contact_id: string; task_id: string; after: unknown }, ctx) {
    const t = await findTask(ctx, params.contact_id, params.task_id);
    if (!t) return; // ya no existe: no hay nada que deshacer
    if (stableJson(taskShape(t)) !== stableJson(params.after)) throw new ToolError('conflicto', 'El pendiente cambió después; para no perder esos cambios, no lo borré.');
    await ctx.call.send('DELETE', path`/api/tasks/${params.task_id}`);
  },
});

export const actualizarTarea = defineTool({
  name: 'actualizar_tarea',
  area: 'contactos',
  roles: ['admin', 'agent'],
  description: 'Cambia el texto, la fecha límite o el estado (abierta/hecha) de un pendiente de un contacto.',
  schema: z.object({
    contacto_id: Id,
    tarea_id: Id,
    texto: z.string().trim().min(1).max(1000).optional(),
    estado: z.enum(['abierta', 'hecha']).optional(),
    vence: DueOn.nullable().optional(),
  }).refine((a) => a.texto !== undefined || a.estado !== undefined || a.vence !== undefined, 'Indica qué cambiar'),
  label: () => 'Actualizando el pendiente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'contact', id: a.contacto_id }],
  async execute(a, ctx) {
    const before = await findTask(ctx, a.contacto_id, a.tarea_id);
    if (!before) throw new ToolError('no_encontrado', 'Ese pendiente no es de este contacto');
    const t = await ctx.call.send<any>('PATCH', path`/api/tasks/${a.tarea_id}`, { ...(a.texto !== undefined ? { body: a.texto } : {}), ...(a.estado ? { status: a.estado } : {}), ...(a.vence !== undefined ? { due_on: a.vence } : {}) });
    return {
      title: a.estado === 'hecha' ? `Marqué como hecho «${t.body.slice(0, 60)}»` : `Actualicé el pendiente «${t.body.slice(0, 60)}»`,
      contactIds: [a.contacto_id],
      links: [links.contact(a.contacto_id)],
      before: taskShape(before),
      after: taskShape(t),
      undo: { label: 'Deshacer', custom: { tool: 'actualizar_tarea', params: { contact_id: a.contacto_id, task_id: a.tarea_id, before: taskShape(before), after: taskShape(t) } } },
      data: { tarea: { id: t.id, texto: t.body, estado: t.status, vence: t.due_on ?? undefined } },
    };
  },
  async undo(params: { contact_id: string; task_id: string; before: any; after: unknown }, ctx) {
    const t = await findTask(ctx, params.contact_id, params.task_id);
    if (!t) throw new ToolError('conflicto', 'El pendiente ya no existe.');
    if (stableJson(taskShape(t)) !== stableJson(params.after)) throw new ToolError('conflicto', 'El pendiente cambió después; para no perder esos cambios, no lo regresé.');
    await ctx.call.send('PATCH', path`/api/tasks/${params.task_id}`, { body: params.before.body, status: params.before.status, due_on: params.before.due_on });
  },
});

export const CONTACT_TOOLS = [buscarContactos, verContacto, editarContacto, etiquetar, darDeBaja, crearTarea, actualizarTarea];
