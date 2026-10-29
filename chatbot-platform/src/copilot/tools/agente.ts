/**
 * Herramientas del Copiloto para configurar el agente (solo administradores): verlo, cambiar sus instrucciones en
 * palabras, ajustar trato y reglas, encenderlo o apagarlo, su conocimiento y el horario del negocio. Los cambios de
 * configuración pasan por «Guardar = aplicar» (llegan a sus canales y quedan en su historial de versiones).
 */
import { z } from 'zod';
import { hydrateChatbot } from '../../types.js';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { stableJson, type Preview } from '../store.js';
import { links, when } from '../summarize.js';
import { botOf, editList, fromPaths, Id, snapshot } from './common.js';

const Text = (max: number) => z.string().trim().min(1).max(max);
const Items = (len = 300) => z.array(Text(len)).max(10);

const versions = (ctx: Ctx, botId: string) => ctx.call.get<any>(path`/api/chatbots/${botId}/versions`);
/** Lo que el agente usa hoy, con los valores por omisión llenos. */
const liveOf = (bot: any, v: any) => hydrateChatbot({ ...bot, ...v.live });
const pending = (v: any) => stableJson(v.draft?.configuration ?? {}) !== stableJson(v.draft?.base_configuration ?? {});
/** Cambios a medias en la página del agente: el Copiloto no los aplica de paso. */
function noPending(v: any) {
  if (pending(v)) throw new ToolError('conflicto', 'Este agente tiene cambios sin aplicar en su página. Aplícalos o descártalos ahí y vuelve a pedírmelo.');
}
/** Aplica un cambio parcial: llega de inmediato a sus canales y queda en su historial de versiones. */
const apply = (ctx: Ctx, botId: string, v: any, patch: Record<string, unknown>) =>
  ctx.call.send<any>('POST', path`/api/chatbots/${botId}/version-apply`, { revision: v.draft.revision, patch });

/** Deshacer un cambio de configuración: solo si lo que se cambió sigue como lo dejó el Copiloto. */
async function undoConfig(ctx: Ctx, p: { bot_id: string; before: Record<string, unknown>; after: Record<string, unknown> }) {
  const bot = await botOf(ctx, p.bot_id);
  const v = await versions(ctx, bot.id);
  noPending(v);
  if (stableJson(snapshot(liveOf(bot, v), Object.keys(p.after))) !== stableJson(p.after)) {
    throw new ToolError('conflicto', 'Ese ajuste del agente cambió después; para no perder ese cambio, no lo regresé.');
  }
  await apply(ctx, bot.id, v, fromPaths(p.before));
}

/** Renglones del cambio de instrucciones para la tarjeta (un renglón cambiado se ve como quitado y agregado). */
function diffOf(lines: any[] = []): NonNullable<Preview['diff']> {
  return lines.flatMap((l: any) => (l.state === 'changed' ? [{ state: 'removed' as const, text: l.before ?? '' }, { state: 'new' as const, text: l.text }] : [{ state: l.state, text: l.text }]));
}

const EMOJIS = { ninguno: 'none', pocos: 'few', normal: 'normal' } as const;
const EMOJIS_OUT: Record<string, string> = { none: 'ninguno', few: 'pocos', normal: 'normal' };
const UNKNOWN = { decir_que_no_sabe: 'say_unknown', preguntar: 'ask', pasar_a_persona: 'handoff' } as const;
const UNKNOWN_OUT: Record<string, string> = { say_unknown: 'decir_que_no_sabe', ask: 'preguntar', handoff: 'pasar_a_persona' };

export const verAgente = defineTool({
  name: 'ver_agente',
  area: 'agente',
  roles: ['admin'],
  description: 'Sin id: los agentes de la cuenta. Con id: su configuración (trato, reglas, cuándo pasa a una persona), su conocimiento, sus últimas versiones y sus instrucciones por párrafo.',
  schema: z.object({ agente_id: Id.optional() }),
  label: (a) => (a.agente_id ? 'Revisando el agente…' : 'Revisando los agentes…'),
  risk: () => 'read',
  async execute(a, ctx) {
    if (!a.agente_id) {
      const bots = await ctx.call.get<any[]>('/api/chatbots');
      return { title: `Revisé los agentes (${bots.length})`, data: { agentes: bots.map((b) => ({ id: b.id, nombre: b.name, encendido: b.active })) } };
    }
    const bot = await botOf(ctx, a.agente_id);
    const [v, knowledge] = await Promise.all([versions(ctx, bot.id), ctx.call.get<any[]>(path`/api/chatbots/${bot.id}/knowledge`)]);
    const { personality: p, rules: r } = liveOf(bot, v);
    return {
      title: `Revisé el agente ${bot.name}`,
      links: [links.bot(bot.id)],
      read: [{ kind: 'bot', id: bot.id }],
      data: {
        id: bot.id, nombre: bot.name, encendido: bot.active, cambios_sin_aplicar: pending(v) || undefined,
        canales: (bot.channels ?? []).map((c: any) => ({ nombre: c.name, tipo: c.type, activo: c.active })),
        nombre_del_asistente: p.assistant_name, trato: p.formality, largo_de_respuestas: p.response_length, emojis: EMOJIS_OUT[p.emojis], tono: p.tone,
        si_no_sabe: UNKNOWN_OUT[r.unknown_info_behavior], reglas: r.custom_rules, temas_prohibidos: r.forbidden_topics,
        casos_para_pasar_a_persona: r.handoff_rules, palabras_para_pasar_a_persona: r.handoff_keywords, mensaje_al_pasar_a_persona: r.handoff_message,
        conocimiento: (knowledge ?? []).map((k) => ({ id: k.id, titulo: k.title, categoria: k.category, activo: k.active, caracteres: (k.content ?? '').length })),
        versiones: (v.releases ?? []).slice(0, 3).map((x: any) => ({ quien: x.author_name, motivo: x.reason, cuando: when(x.created_at, ctx.timezone) })),
        instrucciones: String(p.prompt || '').split(/\n[ \t]*\n/).map((s) => s.trim()).filter(Boolean),
      },
    };
  },
});

export const cambiarInstrucciones = defineTool({
  name: 'cambiar_instrucciones',
  area: 'agente',
  roles: ['admin'],
  description: 'Cambia las instrucciones del agente (cómo atiende) a partir de lo que se pide en palabras: solo toca los renglones necesarios y se aplica de inmediato, con su antes y después y Deshacer.',
  schema: z.object({
    agente_id: Id,
    cambio: Text(2000).describe('Qué cambiar, en palabras («quita lo de envíos gratis y agrega que los domingos cerramos»)'),
  }),
  label: () => 'Cambiando las instrucciones del agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  // Si hay que confirmarlo, la tarjeta muestra el cambio exacto y al confirmar se aplica ese mismo texto.
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const v = await versions(ctx, bot.id);
    noPending(v);
    const before = liveOf(bot, v).personality.prompt;
    const r = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/prompt-edit`, { instruction: a.cambio, prompt: before });
    if (!r.changed) throw new ToolError('datos_invalidos', r.question || 'No encontré qué cambiar en las instrucciones.');
    return { title: `Cambiar las instrucciones de ${bot.name}: ${String(r.summary || a.cambio).slice(0, 120)}`, lines: [], diff: diffOf(r.lines), meta: { before, prompt: r.prompt, summary: r.summary } };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const v = await versions(ctx, bot.id);
    noPending(v);
    const before = liveOf(bot, v).personality.prompt;
    const seen = ctx.proposal?.meta as { before?: string; prompt?: string; summary?: string } | undefined;
    let r: { prompt: string; summary: string; lines?: any[]; changed: boolean; question?: string };
    if (seen?.prompt !== undefined) {
      if (seen.before !== before) throw new ToolError('conflicto', 'Las instrucciones cambiaron después de la propuesta; pídemelo de nuevo para revisar el cambio.');
      r = { prompt: seen.prompt, summary: seen.summary ?? a.cambio, changed: true };
    } else {
      r = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/prompt-edit`, { instruction: a.cambio, prompt: before });
      if (!r.changed) {
        return { title: `No cambié las instrucciones de ${bot.name}`, links: [links.bot(bot.id, 'instrucciones', 'Ver instrucciones')], undo: null, data: { sin_cambios: true, pregunta: r.question || undefined, nota: r.summary } };
      }
    }
    await apply(ctx, bot.id, v, { personality: { prompt: r.prompt } });
    const diff = r.lines ? diffOf(r.lines) : (ctx.proposal?.diff ?? []);
    return {
      title: `Cambié las instrucciones de ${bot.name}: ${String(r.summary || a.cambio).slice(0, 120)}`,
      links: [links.bot(bot.id, 'instrucciones', 'Ver instrucciones')],
      preview: { title: 'Instrucciones', lines: [], diff },
      before: { prompt: before },
      after: { prompt: r.prompt },
      undo: { label: 'Deshacer', custom: { tool: 'cambiar_instrucciones', params: { bot_id: bot.id, before: { 'personality.prompt': before }, after: { 'personality.prompt': r.prompt } } } },
      data: { resumen: r.summary, renglones_cambiados: diff.filter((l) => l.state !== 'same').length },
    };
  },
  undo: (p, ctx) => undoConfig(ctx, p),
});

const Ajustes = z.object({
  agente_id: Id,
  nombre: Text(120).optional().describe('Nombre del agente en el panel'),
  nombre_del_asistente: z.string().trim().max(60).optional().describe('Con qué nombre se presenta a los clientes ("" = sin nombre)'),
  trato: z.enum(['tu', 'usted']).optional(),
  largo_de_respuestas: z.enum(['muy_corta', 'corta', 'media', 'detallada']).optional(),
  emojis: z.enum(['ninguno', 'pocos', 'normal']).optional(),
  tono: z.array(Text(30)).max(8).optional().describe('Reemplaza el tono (ej. ["cálido", "profesional"])'),
  si_no_sabe: z.enum(['decir_que_no_sabe', 'preguntar', 'pasar_a_persona']).optional(),
  agregar_reglas: Items().optional(), quitar_reglas: Items().optional(),
  agregar_temas_prohibidos: Items(120).optional(), quitar_temas_prohibidos: Items(120).optional(),
  agregar_casos_para_pasar_a_persona: Items().optional(), quitar_casos_para_pasar_a_persona: Items().optional(),
  palabras_para_pasar_a_persona: z.array(Text(60)).max(20).optional().describe('Reemplaza las palabras que pasan la conversación a una persona'),
  mensaje_al_pasar_a_persona: Text(500).optional(),
});
type AjustesArgs = z.infer<typeof Ajustes>;

/** Qué rutas de la configuración toca cada ajuste y su valor nuevo (a partir de lo que hay). */
function settingsChanges(a: AjustesArgs, live: any): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (a.nombre !== undefined) c.name = a.nombre;
  if (a.nombre_del_asistente !== undefined) c['personality.assistant_name'] = a.nombre_del_asistente;
  if (a.trato) c['personality.formality'] = a.trato;
  if (a.largo_de_respuestas) c['personality.response_length'] = a.largo_de_respuestas;
  if (a.emojis) c['personality.emojis'] = EMOJIS[a.emojis];
  if (a.tono) c['personality.tone'] = a.tono;
  if (a.si_no_sabe) c['rules.unknown_info_behavior'] = UNKNOWN[a.si_no_sabe];
  if (a.agregar_reglas || a.quitar_reglas) c['rules.custom_rules'] = editList(live.rules.custom_rules, a.agregar_reglas, a.quitar_reglas);
  if (a.agregar_temas_prohibidos || a.quitar_temas_prohibidos) c['rules.forbidden_topics'] = editList(live.rules.forbidden_topics, a.agregar_temas_prohibidos, a.quitar_temas_prohibidos);
  if (a.agregar_casos_para_pasar_a_persona || a.quitar_casos_para_pasar_a_persona) c['rules.handoff_rules'] = editList(live.rules.handoff_rules, a.agregar_casos_para_pasar_a_persona, a.quitar_casos_para_pasar_a_persona);
  if (a.palabras_para_pasar_a_persona) c['rules.handoff_keywords'] = a.palabras_para_pasar_a_persona;
  if (a.mensaje_al_pasar_a_persona) c['rules.handoff_message'] = a.mensaje_al_pasar_a_persona;
  return c;
}

const SETTING_LABEL: Record<string, string> = {
  name: 'nombre', 'personality.assistant_name': 'nombre con el que se presenta', 'personality.formality': 'trato', 'personality.response_length': 'largo de respuestas',
  'personality.emojis': 'emojis', 'personality.tone': 'tono', 'rules.unknown_info_behavior': 'qué hace si no sabe', 'rules.custom_rules': 'reglas',
  'rules.forbidden_topics': 'temas prohibidos', 'rules.handoff_rules': 'cuándo pasa a una persona', 'rules.handoff_keywords': 'palabras para pasar a una persona',
  'rules.handoff_message': 'mensaje al pasar a una persona',
};

export const ajustarAgente = defineTool({
  name: 'ajustar_agente',
  area: 'agente',
  roles: ['admin'],
  description: 'Ajusta el nombre, el trato (tú/usted), el largo de respuestas, los emojis, el tono, qué hace si no sabe algo, sus reglas, temas prohibidos y cuándo pasa la conversación a una persona. Solo cambia lo que se indica.',
  schema: Ajustes.refine((a) => Object.entries(a).some(([k, v]) => k !== 'agente_id' && v !== undefined), 'Indica qué ajustar'),
  label: () => 'Ajustando el agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const changes = settingsChanges(a, liveOf(bot, await versions(ctx, bot.id)));
    const show = (v: unknown) => (Array.isArray(v) ? v.join(' · ') || '(nada)' : String(v));
    return { title: `Ajustar a ${bot.name}`, lines: Object.entries(changes).map(([p, v]) => `${SETTING_LABEL[p] ?? p}: ${show(v)}`) };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const v = await versions(ctx, bot.id);
    noPending(v);
    const live = liveOf(bot, v);
    const changes = settingsChanges(a, live);
    const current = snapshot(live, Object.keys(changes));
    const touched = Object.keys(changes).filter((p) => stableJson(current[p]) !== stableJson(changes[p]));
    if (!touched.length) return { title: `Sin cambios: ${bot.name} ya estaba así`, links: [links.bot(bot.id)], undo: null, data: { sin_cambios: true } };
    const before = snapshot(live, touched);
    await apply(ctx, bot.id, v, fromPaths(Object.fromEntries(touched.map((p) => [p, changes[p]]))));
    const fresh = await botOf(ctx, bot.id);
    const after = snapshot(liveOf(fresh, await versions(ctx, bot.id)), touched);
    return {
      title: `Ajusté a ${fresh.name}: ${touched.map((p) => SETTING_LABEL[p] ?? p).join(', ')}`,
      links: [links.bot(bot.id)],
      before,
      after,
      undo: { label: 'Deshacer', custom: { tool: 'ajustar_agente', params: { bot_id: bot.id, before, after } } },
      data: { cambios: Object.fromEntries(touched.map((p) => [SETTING_LABEL[p] ?? p, after[p]])) },
    };
  },
  undo: (p, ctx) => undoConfig(ctx, p),
});

export const encenderApagarAgente = defineTool({
  name: 'encender_o_apagar_agente',
  area: 'agente',
  roles: ['admin'],
  description: 'Apaga un agente (deja de contestar a los clientes en todos sus canales) o lo enciende (requiere confirmación).',
  schema: z.object({ agente_id: Id, encender: z.boolean() }),
  label: (a) => (a.encender ? 'Preparando el encendido del agente…' : 'Apagando el agente…'),
  risk: (a) => (a.encender ? 'confirm' : 'reversible'),
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const channels = (bot.channels ?? []).filter((c: any) => c.active).map((c: any) => c.name);
    if (!a.encender) return { title: `Apagar el agente ${bot.name}`, lines: ['Deja de contestar a los clientes en todos sus canales.'] };
    return {
      title: `Encender el agente ${bot.name}`,
      lines: [channels.length ? `Empieza a contestar a los clientes en: ${channels.join(', ')}.` : 'Aún no tiene canales activos: contestará cuando conectes uno.'],
    };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    if (bot.active === a.encender) return { title: `${bot.name} ya estaba ${a.encender ? 'encendido' : 'apagado'}`, links: [links.bot(bot.id)], undo: null, data: { sin_cambios: true } };
    await ctx.call.send('PUT', path`/api/chatbots/${bot.id}`, { active: a.encender });
    return {
      title: `${a.encender ? 'Encendí' : 'Apagué'} el agente ${bot.name}`,
      links: [links.bot(bot.id)],
      undo: { label: a.encender ? 'Apagarlo' : 'Volver a encenderlo', custom: { tool: 'encender_o_apagar_agente', params: { bot_id: bot.id, active: a.encender } } },
      data: { encendido: a.encender },
    };
  },
  async undo(p: { bot_id: string; active: boolean }, ctx) {
    const bot = await botOf(ctx, p.bot_id);
    if (bot.active !== p.active) throw new ToolError('conflicto', `El agente ya está ${bot.active ? 'encendido' : 'apagado'}.`);
    await ctx.call.send('PUT', path`/api/chatbots/${bot.id}`, { active: !p.active });
  },
});

/** Un elemento del conocimiento de un agente de la cuenta. */
async function knowledgeItem(ctx: Ctx, botId: string, id: string) {
  const bot = await botOf(ctx, botId);
  const item = ((await ctx.call.get<any[]>(path`/api/chatbots/${bot.id}/knowledge`)) ?? []).find((k) => k.id === id);
  return { bot, item: item ?? null };
}
const knowledgeShape = (k: any) => ({ title: k.title, content: k.content, category: k.category, active: k.active });

export const agregarConocimiento = defineTool({
  name: 'agregar_conocimiento',
  area: 'agente',
  roles: ['admin'],
  description: 'Agrega información que el agente usa para contestar (precios, horarios, políticas, preguntas frecuentes).',
  schema: z.object({ agente_id: Id, titulo: Text(200), contenido: Text(20000), categoria: Text(60).optional() }),
  label: (a) => `Agregando «${a.titulo.slice(0, 40)}» al conocimiento…`,
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    return { title: `Agregar «${a.titulo}» al conocimiento de ${bot.name}`, lines: ['El agente lo usa al contestar a los clientes.'], quote: a.contenido.slice(0, 1500) };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const k = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/knowledge`, { title: a.titulo, content: a.contenido, ...(a.categoria ? { category: a.categoria } : {}) });
    return {
      title: `Agregué «${k.title}» al conocimiento de ${bot.name}`,
      links: [links.bot(bot.id, 'conocimiento', 'Ver conocimiento')],
      after: knowledgeShape(k),
      undo: { label: 'Deshacer', custom: { tool: 'agregar_conocimiento', params: { bot_id: bot.id, id: k.id, after: knowledgeShape(k) } } },
      data: { conocimiento_id: k.id },
    };
  },
  async undo(p: { bot_id: string; id: string; after: unknown }, ctx) {
    const { item } = await knowledgeItem(ctx, p.bot_id, p.id);
    if (!item) return;
    if (stableJson(knowledgeShape(item)) !== stableJson(p.after)) throw new ToolError('conflicto', 'Esa información cambió después; para no perder esos cambios, no la borré.');
    await ctx.call.send('DELETE', path`/api/knowledge/${p.id}`);
  },
});

export const editarConocimiento = defineTool({
  name: 'editar_conocimiento',
  area: 'agente',
  roles: ['admin'],
  description: 'Cambia el título, el contenido o la categoría de un elemento del conocimiento del agente, o lo desactiva/activa.',
  schema: z.object({ agente_id: Id, conocimiento_id: Id, titulo: Text(200).optional(), contenido: Text(20000).optional(), categoria: Text(60).optional(), activo: z.boolean().optional() })
    .refine((a) => a.titulo !== undefined || a.contenido !== undefined || a.categoria !== undefined || a.activo !== undefined, 'Indica qué cambiar'),
  label: () => 'Editando el conocimiento del agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const { bot, item } = await knowledgeItem(ctx, a.agente_id, a.conocimiento_id);
    if (!item) throw new ToolError('no_encontrado', 'Esa información no es de este agente');
    return {
      title: `Editar «${item.title}» en el conocimiento de ${bot.name}`,
      lines: [...(a.titulo ? [`Título nuevo: «${a.titulo}»`] : []), ...(a.categoria ? [`Categoría: ${a.categoria}`] : []), ...(a.activo !== undefined ? [a.activo ? 'Se activa.' : 'Se desactiva.'] : [])],
      ...(a.contenido ? { quote: a.contenido.slice(0, 1500) } : {}),
    };
  },
  async execute(a, ctx) {
    const { bot, item } = await knowledgeItem(ctx, a.agente_id, a.conocimiento_id);
    if (!item) throw new ToolError('no_encontrado', 'Esa información no es de este agente');
    const k = await ctx.call.send<any>('PUT', path`/api/knowledge/${item.id}`, {
      ...(a.titulo !== undefined ? { title: a.titulo } : {}), ...(a.contenido !== undefined ? { content: a.contenido } : {}),
      ...(a.categoria !== undefined ? { category: a.categoria } : {}), ...(a.activo !== undefined ? { active: a.activo } : {}),
    });
    return {
      title: `Edité «${k.title}» en el conocimiento de ${bot.name}`,
      links: [links.bot(bot.id, 'conocimiento', 'Ver conocimiento')],
      before: knowledgeShape(item),
      after: knowledgeShape(k),
      undo: { label: 'Deshacer', custom: { tool: 'editar_conocimiento', params: { bot_id: bot.id, id: item.id, before: knowledgeShape(item), after: knowledgeShape(k) } } },
      data: { conocimiento_id: k.id, activo: k.active },
    };
  },
  async undo(p: { bot_id: string; id: string; before: any; after: unknown }, ctx) {
    const { item } = await knowledgeItem(ctx, p.bot_id, p.id);
    if (!item) throw new ToolError('conflicto', 'Esa información ya no existe.');
    if (stableJson(knowledgeShape(item)) !== stableJson(p.after)) throw new ToolError('conflicto', 'Esa información cambió después; para no perder esos cambios, no la regresé.');
    await ctx.call.send('PUT', path`/api/knowledge/${p.id}`, p.before);
  },
});

export const borrarConocimiento = defineTool({
  name: 'borrar_conocimiento',
  area: 'agente',
  roles: ['admin'],
  description: 'Borra un elemento del conocimiento del agente (requiere confirmación; se puede deshacer volviéndolo a crear).',
  schema: z.object({ agente_id: Id, conocimiento_id: Id }),
  label: () => 'Preparando el borrado de información del agente…',
  risk: () => 'confirm',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const { bot, item } = await knowledgeItem(ctx, a.agente_id, a.conocimiento_id);
    if (!item) throw new ToolError('no_encontrado', 'Esa información no es de este agente');
    return { title: `Borrar «${item.title}» del conocimiento de ${bot.name}`, lines: ['El agente deja de usar esta información al contestar.'], quote: String(item.content).slice(0, 400) };
  },
  async execute(a, ctx) {
    const { bot, item } = await knowledgeItem(ctx, a.agente_id, a.conocimiento_id);
    if (!item) throw new ToolError('no_encontrado', 'Esa información ya no existe');
    await ctx.call.send('DELETE', path`/api/knowledge/${item.id}`);
    return {
      title: `Borré «${item.title}» del conocimiento de ${bot.name}`,
      links: [links.bot(bot.id, 'conocimiento', 'Ver conocimiento')],
      before: knowledgeShape(item),
      // Se vuelve a crear con todo lo que tenía (siempre incluido, orden y fuente).
      undo: { label: 'Volver a agregarlo', custom: { tool: 'borrar_conocimiento', params: { bot_id: bot.id, item: { ...knowledgeShape(item), always_include: !!item.always_include, sort_order: item.sort_order ?? 0, source_url: item.source_url ?? null } } } },
      data: { borrado: true },
    };
  },
  async undo(p: { bot_id: string; item: any }, ctx) {
    const bot = await botOf(ctx, p.bot_id);
    await ctx.call.send('POST', path`/api/chatbots/${bot.id}/knowledge`, p.item);
  },
});

const DAYS = { lunes: 'mon', martes: 'tue', miercoles: 'wed', jueves: 'thu', viernes: 'fri', sabado: 'sat', domingo: 'sun' } as const;
type DayName = keyof typeof DAYS;
const DAY_OUT: Record<string, string> = Object.fromEntries(Object.entries(DAYS).map(([es, en]) => [en, es]));
const Range = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'Usa HH:MM-HH:MM (ej. 09:00-18:00)');
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa AAAA-MM-DD');
const Week = z.object(Object.fromEntries(Object.keys(DAYS).map((d) => [d, z.array(Range).max(4).optional()])) as Record<DayName, z.ZodOptional<z.ZodArray<typeof Range>>>);

export const cambiarHorario = defineTool({
  name: 'cambiar_horario',
  area: 'cuenta',
  roles: ['admin'],
  description: 'Cambia el horario de atención del negocio por día (franjas HH:MM-HH:MM; lista vacía = cerrado ese día) y los días cerrados (feriados). Se usa para avisos, envíos y citas.',
  schema: z.object({
    horario: Week.optional().describe('Solo los días que cambian'),
    agregar_dias_cerrados: z.array(Day).max(30).optional(),
    quitar_dias_cerrados: z.array(Day).max(30).optional(),
  }).refine((a) => (a.horario && Object.values(a.horario).some(Boolean)) || a.agregar_dias_cerrados?.length || a.quitar_dias_cerrados?.length, 'Indica qué cambiar'),
  label: () => 'Cambiando el horario del negocio…',
  risk: () => 'reversible',
  async execute(a, ctx) {
    const s = await ctx.call.get<any>('/api/settings');
    const hours = { ...s.business_hours };
    const days = (Object.keys(a.horario ?? {}) as DayName[]).filter((d) => a.horario?.[d]);
    for (const d of days) hours[DAYS[d]] = a.horario![d]!.map((r) => r.split('-'));
    const drop = new Set(a.quitar_dias_cerrados ?? []);
    const holidays = [...new Set([...(s.holidays ?? []).filter((d: string) => !drop.has(d)), ...(a.agregar_dias_cerrados ?? [])])].sort();
    const saved = await ctx.call.send<any>('PUT', '/api/settings', { business_hours: hours, holidays });
    const before = { business_hours: s.business_hours, holidays: s.holidays ?? [] };
    const after = { business_hours: saved.business_hours, holidays: saved.holidays };
    return {
      title: `Cambié el horario${days.length ? ` (${days.join(', ')})` : ''}${a.agregar_dias_cerrados?.length || a.quitar_dias_cerrados?.length ? ' y los días cerrados' : ''}`,
      links: [links.settings()],
      before,
      after,
      undo: { label: 'Deshacer', check: { url: '/api/settings', pick: ['business_hours', 'holidays'], expect: after }, steps: [{ method: 'PUT', url: '/api/settings', body: before }] },
      data: {
        horario: Object.fromEntries(Object.entries(saved.business_hours as Record<string, string[][]>).map(([d, r]) => [DAY_OUT[d] ?? d, r.length ? r.map((x) => x.join('-')) : 'cerrado'])),
        dias_cerrados: saved.holidays,
      },
    };
  },
});

export const AGENT_TOOLS = [verAgente, cambiarInstrucciones, ajustarAgente, encenderApagarAgente, agregarConocimiento, editarConocimiento, borrarConocimiento, cambiarHorario];
