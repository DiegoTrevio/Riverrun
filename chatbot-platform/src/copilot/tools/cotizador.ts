/**
 * Cotizador escrito desde el Copiloto (solo administradores): armarlo desde los productos, precios y reglas que da la
 * persona (o con el texto que ya tiene el agente) y probarlo con datos. Armar se confirma en la tarjeta, que muestra lo
 * que entendió y cotizaciones de ejemplo calculadas por el sistema; al confirmar se activa exactamente eso, conectado al
 * agente con su historial de versiones (Deshacer devuelve el agente a como estaba; los precios guardados se quedan).
 */
import { z } from 'zod';
import { ToolError, path } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { links } from '../summarize.js';
import { botOf, Id } from './common.js';
import { liveOf, undoConfig, versions } from './agente.js';
import { applyChanges } from './agente-config.js';

/** La calculadora que usa hoy el agente (y su texto), si tiene. */
async function currentCalculator(ctx: Ctx, agenteId: string) {
  const bot = await botOf(ctx, agenteId);
  const live = liveOf(bot, await versions(ctx, bot.id));
  const id = live.ai?.quotes?.calculator_id || '';
  const calc = id ? await ctx.call.get<any>(path`/api/quote-calculators/${id}`).catch(() => null) : null;
  return { bot, live, calc };
}

/** El borrador en renglones para la tarjeta: lo que entendió, lo que pide, cuándo va un asesor y los ejemplos. */
function draftLines(r: any): string[] {
  const def = r.draft.definition;
  const advisor = [...(def.values ?? []).flatMap((v: any) => (v.tiers?.otherwise?.stop ? [v.tiers.otherwise.stop] : [])), ...(def.stops ?? []).map((s: any) => s.message)];
  return [
    ...(r.summary ? [r.summary] : []),
    `Pedirá: ${def.inputs.map((d: any) => `${d.label}${d.type === 'option' ? ` (${d.options.map((o: any) => o.label).join(', ')})` : ''}${d.required === false ? ' — solo si lo menciona' : ''}`).join('; ')}`,
    ...(advisor.length ? [`Lo atiende un asesor: ${advisor.join(' · ')}`] : []),
    `${r.draft.price_items.length} precios`,
    ...r.examples.map((ex: any) => `Ejemplo «${ex.description}»: ${ex.ok ? `total ${ex.totals.total}` : `→ ${ex.message}`}`),
  ].map((l) => l.slice(0, 400));
}

async function build(ctx: Ctx, botId: string, text: string) {
  const r = await ctx.call.send<any>('POST', '/api/quote-calculators/from-text', { text, chatbot_id: botId });
  if (!r.ready) throw new ToolError('datos_invalidos', `Así todavía no se puede activar: ${r.problems.slice(0, 3).join(' · ')}. Aclara eso en el texto y vuelve a pedírmelo.`);
  return r;
}

export const armarCotizador = defineTool({
  name: 'armar_cotizador',
  area: 'agente',
  pack: 'cotizaciones',
  roles: ['admin'],
  description: 'Arma el cotizador de un agente desde productos, precios y reglas en palabras (o su texto actual); se confirma viendo ejemplos. El agente pide esos datos solo: no van en Preguntas.',
  schema: z.object({
    agente_id: Id,
    texto: z.string().trim().max(20000).optional().describe('Productos con sus precios y las reglas para cotizar, en palabras del negocio. Copia lo que dio la persona, completo; no lo resumas ni inventes precios.'),
  }),
  label: () => 'Armando el cotizador…',
  // Cambia precios y lo que reciben los clientes: siempre se confirma viendo los ejemplos.
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const { bot, calc } = await currentCalculator(ctx, a.agente_id);
    const text = a.texto?.trim() || (calc?.template_key === 'texto' ? calc.source_text : '');
    if (!text) throw new ToolError('datos_invalidos', 'Pásame los productos con sus precios y las reglas para cotizar (o empieza con un ejemplo de tu giro en el agente → Cotizaciones).');
    const r = await build(ctx, bot.id, text);
    const caution = [...r.unclear.map((u: string) => `No quedó claro: ${u}`), ...r.warnings.map((w: string) => `Sin precio: ${w}`)];
    return {
      title: `Activar el cotizador de ${bot.name}`,
      lines: draftLines(r),
      ...(caution.length ? { warning: caution.slice(0, 5).join(' · ').slice(0, 600) } : {}),
      meta: { text, draft: r.draft },
    };
  },
  async execute(a, ctx) {
    const { bot } = await currentCalculator(ctx, a.agente_id);
    // Se activa lo que la persona vio en la tarjeta (el mismo borrador), no una traducción nueva.
    const seen = ctx.proposal?.meta as { text?: string; draft?: unknown } | undefined;
    const text = seen?.text ?? a.texto?.trim() ?? '';
    const draft = seen?.draft ?? (text ? (await build(ctx, bot.id, text)).draft : null);
    if (!draft) throw new ToolError('datos_invalidos', 'Pásame los productos con sus precios y las reglas para cotizar.');
    const saved = await ctx.call.send<any>('POST', '/api/quote-calculators/from-text/apply', { text, chatbot_id: bot.id, draft });
    const connected = await applyChanges(ctx, bot.id, 'armar_cotizador', (live) => {
      const q = live.ai?.quotes ?? {};
      return {
        'ai.quotes': {
          enabled: true, template_id: q.template_id ?? '', allow_final: q.allow_final ?? true, required_fields: q.required_fields ?? [],
          calculator_id: saved.calculator.id, send_summary: q.send_summary ?? true, send_pdf: q.send_pdf ?? true,
        },
      };
    }, { 'ai.quotes': 'cotizador' });
    return {
      ...connected,
      title: `Activé el cotizador de ${bot.name} (versión ${saved.calculator.version}): ${saved.created} precios nuevos, ${saved.updated} actualizados${saved.deactivated ? `, ${saved.deactivated} apagados` : ''}`,
      links: [links.bot(bot.id, 'cotizaciones', 'Ver cotizaciones del agente')],
      data: {
        calculadora_id: saved.calculator.id, version: saved.calculator.version, precios_nuevos: saved.created, precios_actualizados: saved.updated, apagados: saved.deactivated, avisos: saved.warnings,
        nota: 'El agente ya pide al cliente los datos del cotizador, uno a la vez: no hace falta agregarlos en Preguntas. Para probarlo usa probar_cotizador.',
      },
    };
  },
  undo: (p, ctx) => undoConfig(ctx, p),
});

export const probarCotizador = defineTool({
  name: 'probar_cotizador',
  area: 'agente',
  pack: 'cotizaciones',
  roles: ['admin'],
  description: 'Calcula una cotización de prueba con el cotizador del agente y los datos dados: conceptos, IVA y total, o por qué no cotiza. No guarda ni envía nada.',
  schema: z.object({
    agente_id: Id,
    datos: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).describe('Clave del dato → valor'),
  }),
  label: () => 'Probando el cotizador…',
  risk: () => 'read',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async execute(a, ctx) {
    const { bot, calc } = await currentCalculator(ctx, a.agente_id);
    if (!calc) throw new ToolError('no_encontrado', `${bot.name} no tiene cotizador. Arma uno con armar_cotizador.`);
    const r = await ctx.call.send<any>('POST', path`/api/quote-calculators/${calc.id}/preview`, { inputs: a.datos });
    const datos = calc.definition.inputs.map((d: any) => ({ clave: d.key, dato: d.label, tipo: d.type, opciones: d.type === 'option' ? d.options.map((o: any) => o.value) : undefined, obligatorio: d.required !== false }));
    if (!r.ok) {
      return { title: `Prueba del cotizador de ${bot.name}: no cotiza`, undo: null, data: { motivo: r.message, detalle: r.detail, faltan: r.missing?.map((m: any) => m.label), datos_que_pide: datos } };
    }
    return {
      title: `Prueba del cotizador de ${bot.name}: total ${r.totals.total}`,
      links: [links.bot(bot.id, 'cotizaciones', 'Ver cotizaciones del agente')],
      undo: null,
      data: {
        conceptos: r.priced.lines.map((l: any) => ({ concepto: l.name, cantidad: l.qty, importe_centavos: l.amount_min })),
        subtotal: r.totals.subtotal, iva: r.totals.iva, total: r.totals.total, datos_que_pide: datos,
      },
    };
  },
});

export const QUOTE_BUILDER_TOOLS = [armarCotizador, probarCotizador];
