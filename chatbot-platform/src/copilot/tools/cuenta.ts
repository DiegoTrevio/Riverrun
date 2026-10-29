/** Herramientas del Copiloto sobre la cuenta en general: lo básico y las etiquetas en uso. */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { accountSnapshot } from '../prompt.js';

export const contextoCuenta = defineTool({
  name: 'contexto_cuenta',
  area: 'cuenta',
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

export const ACCOUNT_TOOLS = [contextoCuenta, contarEtiquetas];
