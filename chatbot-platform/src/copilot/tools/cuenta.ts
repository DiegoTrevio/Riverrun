/** Herramientas del Copiloto sobre la cuenta en general: lo básico, las etiquetas en uso y cargar herramientas de otra área. */
import { z } from 'zod';
import { defineTool, PACK_IDS, type Pack } from '../registry.js';
import { accountSnapshot } from '../prompt.js';

const AREAS = PACK_IDS.filter((p) => p !== 'base') as [Pack, ...Pack[]];

/** Carga paquetes de herramientas en este pedido: las de esas áreas quedan disponibles desde el siguiente paso. */
export const usarHerramientas = defineTool({
  name: 'usar_herramientas',
  area: 'cuenta',
  pack: 'base',
  meta: true,
  roles: ['admin', 'agent'],
  description: 'Carga las herramientas de otras áreas (ver «Herramientas por área» en tus instrucciones) para usarlas en los siguientes pasos.',
  schema: z.object({ areas: z.array(z.enum(AREAS)).min(1).max(4) }),
  label: () => 'Preparando herramientas…',
  risk: () => 'read',
  async execute(a, ctx) {
    const names = ctx.loadPacks?.(a.areas) ?? [];
    return {
      title: `Cargué herramientas de ${a.areas.join(', ')}`,
      data: names.length ? { cargadas: a.areas, herramientas: names } : { cargadas: [], nota: 'Tu usuario no tiene herramientas en esas áreas.' },
    };
  },
});

export const contextoCuenta = defineTool({
  name: 'contexto_cuenta',
  area: 'cuenta',
  pack: 'base',
  roles: ['admin', 'agent'],
  description: 'Lo básico de la cuenta, al día: agentes, embudos con sus etapas, servicios de la agenda, datos de clientes, secuencias y equipo (con sus ids).',
  schema: z.object({}),
  label: () => 'Revisando la cuenta…',
  risk: () => 'read',
  async execute(_a, ctx) {
    return { title: 'Revisé lo básico de la cuenta', data: { resumen: (await accountSnapshot(ctx.call)) || 'Sin datos visibles para tu usuario.' } };
  },
});

export const contarEtiquetas = defineTool({
  name: 'contar_etiquetas',
  area: 'contactos',
  pack: 'base',
  roles: ['admin', 'agent'],
  description: 'Etiquetas en uso en los contactos y cuántos contactos tiene cada una.',
  schema: z.object({}),
  label: () => 'Contando etiquetas…',
  risk: () => 'read',
  async execute(_a, ctx) {
    const rows = await ctx.call.get<{ tag: string; contacts: number }[]>('/api/copilot/data/tags');
    return { title: `Revisé las etiquetas (${rows.length})`, data: { etiquetas: rows.map((r) => ({ etiqueta: r.tag, contactos: r.contacts })) } };
  },
});

export const ACCOUNT_TOOLS = [contextoCuenta, contarEtiquetas, usarHerramientas];
