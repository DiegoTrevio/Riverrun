/**
 * Herramientas del Copiloto para el resto de cotizaciones (fase 2, solo administradores): los ajustes (moneda, IVA,
 * vigencia, leyendas, datos del negocio), borrar un concepto de la lista de precios y los formatos en Word (subir uno
 * adjunto o archivarlo). Ver, corregir y decidir cotizaciones sigue en `operacion.ts`.
 */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import { fileForTool } from '../files.js';
import { defineTool, type Ctx } from '../registry.js';
import { links } from '../summarize.js';
import { Id, money, snapshot } from './common.js';

// --- Ajustes ---------------------------------------------------------------------------------------------------------

const settingsOut = (s: any) => ({
  moneda: s.currency, iva: `${Math.round(Number(s.iva_rate) * 10000) / 100} %`, precios_incluyen_iva: s.prices_include_iva, vigencia_dias: s.validity_days,
  prefijo_folio: s.folio_prefix || undefined, leyenda_aproximada: s.legend_approx || undefined, leyenda_final: s.legend_final || undefined,
  negocio: { nombre: s.business_name || undefined, telefono: s.business_phone || undefined, correo: s.business_email || undefined, direccion: s.business_address || undefined },
});

export const ajustesDeCotizacion = defineTool({
  name: 'ajustes_de_cotizacion',
  area: 'cotizaciones',
  roles: ['admin'],
  description: 'Sin cambios, muestra los ajustes de las cotizaciones; con cambios, los guarda: moneda, IVA, si los precios lo incluyen, vigencia, folio, leyendas y datos del negocio.',
  schema: z.object({
    moneda: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    iva: z.number().min(0).max(99).optional().describe('Porcentaje, como 16'),
    precios_incluyen_iva: z.boolean().optional(),
    vigencia_dias: z.number().int().min(1).max(365).optional(),
    prefijo_folio: z.string().trim().regex(/^[A-Za-z0-9_-]{0,12}$/).optional(),
    leyenda_aproximada: z.string().max(500).optional(),
    leyenda_final: z.string().max(500).optional(),
    negocio: z.object({ nombre: z.string().trim().max(300), telefono: z.string().trim().max(300), correo: z.string().trim().max(300), direccion: z.string().trim().max(300) }).partial().optional().describe('Van en cada cotización'),
  }),
  label: () => 'Revisando los ajustes de cotización…',
  risk: (a) => (Object.values(a).some((v) => v !== undefined) ? 'reversible' : 'read'),
  async execute(a, ctx) {
    const before = await ctx.call.get<any>('/api/quote-settings');
    const body: Record<string, unknown> = {
      ...(a.moneda ? { currency: a.moneda.toUpperCase() } : {}), ...(a.iva !== undefined ? { iva_rate: Math.round(a.iva * 100) / 10000 } : {}),
      ...(a.precios_incluyen_iva !== undefined ? { prices_include_iva: a.precios_incluyen_iva } : {}), ...(a.vigencia_dias ? { validity_days: a.vigencia_dias } : {}),
      ...(a.prefijo_folio !== undefined ? { folio_prefix: a.prefijo_folio } : {}), ...(a.leyenda_aproximada !== undefined ? { legend_approx: a.leyenda_aproximada } : {}),
      ...(a.leyenda_final !== undefined ? { legend_final: a.leyenda_final } : {}),
      ...(a.negocio?.nombre !== undefined ? { business_name: a.negocio.nombre } : {}), ...(a.negocio?.telefono !== undefined ? { business_phone: a.negocio.telefono } : {}),
      ...(a.negocio?.correo !== undefined ? { business_email: a.negocio.correo } : {}), ...(a.negocio?.direccion !== undefined ? { business_address: a.negocio.direccion } : {}),
    };
    const keys = Object.keys(body);
    if (!keys.length) return { title: 'Revisé los ajustes de cotización', links: [links.quotesTab('ajustes', 'Ver ajustes')], data: settingsOut(before) };
    const saved = await ctx.call.send<any>('PUT', '/api/quote-settings', body);
    return {
      title: `Cambié los ajustes de cotización (${keys.length} dato(s))`,
      links: [links.quotesTab('ajustes', 'Ver ajustes')],
      before: snapshot(before, keys),
      after: snapshot(saved, keys),
      undo: { label: 'Deshacer', check: { url: '/api/quote-settings', pick: keys, expect: snapshot(saved, keys) }, steps: [{ method: 'PUT', url: '/api/quote-settings', body: snapshot(before, keys) }] },
      data: settingsOut(saved),
    };
  },
});

// --- Lista de precios ------------------------------------------------------------------------------------------------

export const borrarPrecio = defineTool({
  name: 'borrar_precio',
  area: 'cotizaciones',
  roles: ['admin'],
  description: 'Borra un concepto de la lista de precios (las cotizaciones ya hechas no cambian). Se confirma; para dejar de ofrecerlo sin borrarlo, desactívalo.',
  schema: z.object({ concepto_id: Id }),
  label: () => 'Preparando el borrado del concepto…',
  risk: () => 'confirm',
  async preview(a, ctx) {
    const i = ((await ctx.call.get<any[]>('/api/price-items')) ?? []).find((x) => x.id === a.concepto_id);
    if (!i) throw new ToolError('no_encontrado', 'Ese concepto no está en la lista de precios');
    return { title: `Borrar «${i.name}» de la lista de precios`, lines: [`Código ${i.code}, ${i.price_mode === 'tbd' ? 'precio por confirmar' : money(i.price_min)} por ${i.unit}.`, 'Las cotizaciones ya hechas no cambian. No se puede deshacer.'] };
  },
  async execute(a, ctx) {
    const i = ((await ctx.call.get<any[]>('/api/price-items')) ?? []).find((x) => x.id === a.concepto_id);
    if (!i) throw new ToolError('no_encontrado', 'Ese concepto no está en la lista de precios');
    await ctx.call.send('DELETE', path`/api/price-items/${i.id}`);
    return { title: `Borré «${i.name}» de la lista de precios`, links: [links.prices()], data: { borrado: true } };
  },
});

// --- Formatos en Word ------------------------------------------------------------------------------------------------

async function templateOf(ctx: Ctx, id: string) {
  const t = ((await ctx.call.get<any[]>('/api/quote-templates')) ?? []).find((x) => x.id === id);
  if (!t) throw new ToolError('no_encontrado', 'Formato no encontrado');
  return t;
}
async function docxOf(ctx: Ctx, archivoId: string) {
  const f = await fileForTool(ctx, archivoId);
  if (!/\.docx$/i.test(f.name)) throw new ToolError('datos_invalidos', 'El formato debe ser un documento de Word (.docx).');
  return f;
}

export const formatosDeCotizacion = defineTool({
  name: 'formatos_de_cotizacion',
  area: 'cotizaciones',
  roles: ['admin'],
  description: 'Formatos en Word de las cotizaciones: verlos, subir uno adjunto (archivo_id .docx; se revisa que tenga las marcas) o archivar uno. Subir y archivar se confirman.',
  schema: z.object({
    accion: z.enum(['ver', 'subir', 'archivar']),
    archivo_id: Id.optional(),
    nombre: z.string().trim().max(80).optional().describe('Al subir; con el nombre de uno que ya existe, es su versión nueva'),
    formato_id: Id.optional(),
  }).refine((a) => (a.accion === 'subir' ? a.archivo_id : a.accion === 'archivar' ? a.formato_id : true), 'Falta archivo_id (subir) o formato_id (archivar)'),
  label: (a) => (a.accion === 'ver' ? 'Revisando los formatos…' : a.accion === 'subir' ? 'Revisando el formato…' : 'Preparando el formato…'),
  risk: (a) => (a.accion === 'ver' ? 'read' : 'confirm'),
  async preview(a, ctx) {
    if (a.accion === 'subir') {
      const f = await docxOf(ctx, a.archivo_id!);
      return {
        title: `Subir el formato de cotización «${a.nombre || f.name.replace(/\.docx$/i, '')}»`,
        lines: [`Archivo: ${f.name} (${Math.max(1, Math.round(f.buffer.length / 1024))} KB).`, 'Al subirlo se revisa que tenga las marcas necesarias; si le falta alguna, no se guarda.', 'Las cotizaciones nuevas lo pueden usar desde ese momento.'],
      };
    }
    const t = await templateOf(ctx, a.formato_id!);
    return { title: `Archivar el formato «${t.name}» (versión ${t.version})`, lines: ['Las cotizaciones hechas con él lo siguen usando.', 'Un agente que lo tenga elegido usa el formato más reciente.'] };
  },
  async execute(a, ctx) {
    if (a.accion === 'ver') {
      const list = (await ctx.call.get<any[]>('/api/quote-templates')) ?? [];
      return { title: `Revisé los formatos (${list.length})`, links: [links.quotesTab('formatos', 'Ver formatos')], data: { formatos: list.map((t) => ({ id: t.id, nombre: t.name, version: t.version, activo: t.status === 'active', marcas: (t.placeholders ?? []).length })) } };
    }
    if (a.accion === 'subir') {
      const f = await docxOf(ctx, a.archivo_id!);
      const r = await ctx.call.upload<any>('/api/quote-templates', f, a.nombre ? { name: a.nombre } : {});
      return {
        title: `Subí el formato «${r.template?.name}» (versión ${r.template?.version})`,
        links: [links.quotesTab('formatos', 'Ver formatos')],
        data: {
          formato_id: r.template?.id, version: r.template?.version,
          marcas_desconocidas: r.report?.unknown?.length ? r.report.unknown : undefined, faltan: r.report?.missingRequired?.length ? r.report.missingRequired : undefined,
        },
      };
    }
    const t = await templateOf(ctx, a.formato_id!);
    await ctx.call.send('DELETE', path`/api/quote-templates/${t.id}`);
    return { title: `Archivé el formato «${t.name}»`, links: [links.quotesTab('formatos', 'Ver formatos')], data: { archivado: true } };
  },
});

export const QUOTE_TOOLS = [ajustesDeCotizacion, borrarPrecio, formatosDeCotizacion];
