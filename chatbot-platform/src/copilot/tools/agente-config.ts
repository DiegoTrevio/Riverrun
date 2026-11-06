/**
 * Herramientas del Copiloto para configurar a fondo un agente (solo administradores): preguntas en orden, objetivo y
 * etapas, cuándo responde, ajustes avanzados, mensajes guardados, cotizaciones y modelo. Todas pasan por «Guardar =
 * aplicar» (`version-apply`): llegan a sus canales y quedan en su historial de versiones, con antes, después y Deshacer.
 */
import { z } from 'zod';
import { ToolError } from '../executor.js';
import { defineTool, type Ctx, type ExecResult } from '../registry.js';
import { stableJson } from '../store.js';
import { links } from '../summarize.js';
import { botOf, fromPaths, Id, snapshot } from './common.js';
import { apply, liveOf, noPending, undoConfig, versions } from './agente.js';

const Text = (max: number) => z.string().trim().min(1).max(max);
const List = (max: number, len = 200) => z.array(Text(len)).max(max);

/**
 * Aplica cambios por ruta («rules.activation», «data_fields») sobre lo que el agente usa hoy: solo lo que de verdad
 * cambia, con la foto de antes y la de después para deshacer. `extra` va en el mismo parche (p. ej. `flow_step_map`).
 */
export async function applyChanges(ctx: Ctx, agenteId: string, tool: string, compute: (live: any) => Record<string, unknown>, label: Record<string, string>, extra?: (live: any) => Record<string, unknown>): Promise<ExecResult> {
  const bot = await botOf(ctx, agenteId);
  const v = await versions(ctx, bot.id);
  noPending(v);
  const live = liveOf(bot, v);
  const changes = compute(live);
  const current = snapshot(live, Object.keys(changes));
  const touched = Object.keys(changes).filter((p) => stableJson(current[p]) !== stableJson(changes[p]));
  if (!touched.length) return { title: `Sin cambios: ${bot.name} ya estaba así`, links: [links.bot(bot.id)], undo: null, data: { sin_cambios: true } };
  const before = snapshot(live, touched);
  await apply(ctx, bot.id, v, { ...fromPaths(Object.fromEntries(touched.map((p) => [p, changes[p]]))), ...(extra?.(live) ?? {}) });
  const fresh = await botOf(ctx, bot.id);
  const after = snapshot(liveOf(fresh, await versions(ctx, bot.id)), touched);
  return {
    title: `Cambié en ${fresh.name}: ${touched.map((p) => label[p] ?? p).join(', ')}`,
    links: [links.bot(bot.id)],
    before, after,
    undo: { label: 'Deshacer', custom: { tool, params: { bot_id: bot.id, before, after } } },
    data: { agente_id: bot.id, cambios: touched.map((p) => label[p] ?? p) },
  };
}

// --- Preguntas en orden ----------------------------------------------------------------------------------------------

const TYPES = { texto: 'text', nombre: 'name', correo: 'email', telefono: 'phone', fecha: 'date', numero: 'number', opcion: 'option' } as const;

const Pregunta = z.object({
  clave: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Clave: minúsculas, números y _').describe('Clave del dato (ej. nombre, servicio, fecha_visita)'),
  etiqueta: Text(80).optional(),
  pregunta: z.string().trim().max(500).optional().describe('Pregunta exacta; las que tienen pregunta se hacen una a una en este orden'),
  tipo: z.enum(Object.keys(TYPES) as [keyof typeof TYPES, ...(keyof typeof TYPES)[]]).optional(),
  opciones: List(20, 80).optional().describe('Para tipo opcion'),
  obligatoria: z.boolean().optional(),
  cuando: z.string().trim().max(200).optional().describe('Si no tiene pregunta: cuándo pedirlo'),
});

export const cambiarPreguntas = defineTool({
  name: 'cambiar_preguntas',
  area: 'agente',
  roles: ['admin'],
  description: 'Fija los datos que pide el agente («Preguntas en orden»): la lista completa nueva, en orden. Las que no estén se quitan; las que ya existían conservan lo demás.',
  schema: z.object({ agente_id: Id, preguntas: z.array(Pregunta).max(30) }),
  label: () => 'Cambiando las preguntas del agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    return { title: `Cambiar las preguntas de ${bot.name}`, lines: a.preguntas.map((p, i) => `${i + 1}. ${p.pregunta || p.etiqueta || p.clave}${p.obligatoria ? ' (obligatoria)' : ''}`) };
  },
  execute: (a, ctx) => applyChanges(ctx, a.agente_id, 'cambiar_preguntas', (live) => {
    const old = new Map<string, any>((live.data_fields ?? []).map((f: any) => [f.key, f]));
    if (new Set(a.preguntas.map((p) => p.clave)).size !== a.preguntas.length) throw new ToolError('datos_invalidos', 'Hay dos preguntas con la misma clave.');
    return {
      data_fields: a.preguntas.map((p) => {
        const prev = old.get(p.clave) ?? {};
        const options = p.opciones ?? prev.options ?? [];
        return {
          ...prev, key: p.clave, label: p.etiqueta ?? prev.label ?? p.clave, type: p.tipo ? TYPES[p.tipo] : prev.type ?? 'text',
          description: prev.description ?? '', options, required: p.obligatoria ?? prev.required ?? false,
          ask_when: p.cuando ?? prev.ask_when ?? '', question: p.pregunta ?? prev.question ?? '',
          // Los caminos por respuesta se conservan solo para las opciones que siguen existiendo.
          branches: (prev.branches ?? []).filter((b: any) => options.includes(b.option)),
        };
      }),
    };
  }, { data_fields: 'preguntas en orden' }),
  undo: (p, ctx) => undoConfig(ctx, p),
});

// --- Objetivo y etapas -----------------------------------------------------------------------------------------------

const AL_CUMPLIR = { nada: 'none', pasar_a_persona: 'handoff', avisar_al_equipo: 'notify' } as const;

export const cambiarObjetivo = defineTool({
  name: 'cambiar_objetivo',
  area: 'agente',
  roles: ['admin'],
  description: 'Cambia el objetivo de la conversación, sus etapas (guía, no guion), el saludo y qué pasa al cumplirlo (pasar a una persona o avisar al equipo).',
  schema: z.object({
    agente_id: Id,
    objetivo: z.string().trim().max(500).optional(),
    etapas: z.array(z.object({ titulo: Text(120), descripcion: z.string().trim().max(500).optional() })).max(12).optional().describe('La lista completa nueva, en orden'),
    saludo: z.string().trim().max(300).optional(),
    al_cumplir: z.enum(['nada', 'pasar_a_persona', 'avisar_al_equipo']).optional(),
    que_hacer_al_cumplir: z.string().trim().max(300).optional().describe('Qué dice o hace el agente al cumplirlo'),
  }).refine((a) => [a.objetivo, a.etapas, a.saludo, a.al_cumplir, a.que_hacer_al_cumplir].some((x) => x !== undefined), 'Indica qué cambiar'),
  label: () => 'Cambiando el objetivo del agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  execute: (a, ctx) => applyChanges(ctx, a.agente_id, 'cambiar_objetivo', () => ({
    ...(a.objetivo !== undefined ? { 'flow.goal': a.objetivo } : {}),
    ...(a.etapas ? { 'flow.steps': a.etapas.map((e) => ({ title: e.titulo, description: e.descripcion ?? '' })) } : {}),
    ...(a.saludo !== undefined ? { 'flow.greeting': a.saludo } : {}),
    ...(a.al_cumplir ? { 'flow.on_goal_action': AL_CUMPLIR[a.al_cumplir] } : {}),
    ...(a.que_hacer_al_cumplir !== undefined ? { 'flow.on_goal_completed': a.que_hacer_al_cumplir } : {}),
  }), { 'flow.goal': 'objetivo', 'flow.steps': 'etapas', 'flow.greeting': 'saludo', 'flow.on_goal_action': 'qué pasa al cumplirlo', 'flow.on_goal_completed': 'qué hace al cumplirlo' },
  // Etapas reordenadas o quitadas: el mapa (etapa vieja → nueva, 0 = quitada) mantiene en su lugar las fotos, los
  // mensajes guardados y las conversaciones en curso que apuntaban a una etapa.
  (live) => {
    if (!a.etapas) return {};
    const titles = a.etapas.map((e) => e.titulo.trim().toLowerCase());
    return { flow_step_map: (live.flow?.steps ?? []).map((s: any) => titles.indexOf(String(s.title).trim().toLowerCase()) + 1) };
  }),
  undo: (p, ctx) => undoConfig(ctx, p),
});

// --- Cuándo responde -------------------------------------------------------------------------------------------------

const AL_PARAR = { pausar: 'pause', pasar_a_persona: 'handoff', cerrar: 'close' } as const;
const Activacion = z.object({
  agente_id: Id,
  modo: z.enum(['siempre', 'con_palabras']).optional().describe('siempre, o solo después de que el cliente escriba una palabra para empezar'),
  palabras_para_empezar: List(20, 60).optional(),
  palabras_para_parar: List(20, 60).optional(),
  al_parar: z.enum(['pausar', 'pasar_a_persona', 'cerrar']).optional(),
  mensaje_al_parar: z.string().trim().max(1000).optional(),
  reanudar_en_horas: z.number().min(0).max(720).optional().describe('0 = solo con palabra o a mano'),
  parar_al_cumplir_objetivo: z.boolean().optional(),
  parar_al_agendar: z.boolean().optional(),
  parar_al_terminar_preguntas: z.boolean().optional(),
  parar_cuando_de_estos_datos: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).max(20).optional().describe('Claves de datos: al tenerlos todos, deja de responder'),
});
type ActivacionArgs = z.infer<typeof Activacion>;

function activationOf(a: ActivacionArgs, live: any) {
  return {
    ...live.rules.activation,
    ...(a.modo ? { mode: a.modo === 'siempre' ? 'always' : 'keywords' } : {}),
    ...(a.palabras_para_empezar ? { on_keywords: a.palabras_para_empezar } : {}),
    ...(a.palabras_para_parar ? { off_keywords: a.palabras_para_parar } : {}),
    ...(a.al_parar ? { off_action: AL_PARAR[a.al_parar] } : {}),
    ...(a.mensaje_al_parar !== undefined ? { off_message: a.mensaje_al_parar } : {}),
    ...(a.reanudar_en_horas !== undefined ? { resume_after_hours: a.reanudar_en_horas } : {}),
    ...(a.parar_al_cumplir_objetivo !== undefined ? { off_on_goal: a.parar_al_cumplir_objetivo } : {}),
    ...(a.parar_al_agendar !== undefined ? { off_on_booking: a.parar_al_agendar } : {}),
    ...(a.parar_al_terminar_preguntas !== undefined ? { off_on_questions: a.parar_al_terminar_preguntas } : {}),
    ...(a.parar_cuando_de_estos_datos ? { off_when_fields: a.parar_cuando_de_estos_datos } : {}),
  };
}

export const cambiarActivacion = defineTool({
  name: 'cambiar_activacion',
  area: 'agente',
  roles: ['admin'],
  description: 'Cambia cuándo responde el agente: siempre o solo con palabras para empezar, palabras para parar, qué hace al parar y cuándo se reanuda. Se confirma: cambia a quién contesta.',
  schema: Activacion.refine((a) => Object.entries(a).some(([k, v]) => k !== 'agente_id' && v !== undefined), 'Indica qué cambiar'),
  label: () => 'Preparando el cambio de cuándo responde…',
  risk: () => ({ level: 'confirm', reasons: ['Cambia a quién le contesta el agente.'] }),
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const next = activationOf(a, liveOf(bot, await versions(ctx, bot.id)));
    return {
      title: `Cambiar cuándo responde ${bot.name}`,
      lines: [
        next.mode === 'always' ? 'Responde siempre.' : `Solo responde después de: ${(next.on_keywords ?? []).join(', ') || '(sin palabras)'}.`,
        ...(next.off_keywords?.length ? [`Deja de responder si escriben: ${next.off_keywords.join(', ')}.`] : []),
        `Al parar: ${({ pause: 'se pausa', handoff: 'pasa a una persona', close: 'cierra la conversación' } as Record<string, string>)[next.off_action] ?? next.off_action}.`,
        ...(next.resume_after_hours ? [`Se reanuda solo a las ${next.resume_after_hours} horas.`] : []),
      ],
      ...(next.off_message ? { quote: next.off_message } : {}),
    };
  },
  execute: (a, ctx) => applyChanges(ctx, a.agente_id, 'cambiar_activacion', (live) => ({ 'rules.activation': activationOf(a, live) }), { 'rules.activation': 'cuándo responde' }),
  undo: (p, ctx) => undoConfig(ctx, p),
});

// --- Ajustes avanzados -----------------------------------------------------------------------------------------------

const AVANZADOS: Record<string, [string, string]> = {
  idioma: ['personality.language', 'idioma'], ejemplos_de_estilo: ['personality.style_examples', 'ejemplos de estilo'],
  temas_permitidos: ['rules.allowed_topics', 'temas permitidos'], frases_prohibidas: ['rules.banned_phrases', 'frases prohibidas'],
  mensaje_si_no_sabe: ['rules.fallback_message', 'mensaje cuando no sabe'], mensaje_si_hay_demora: ['rules.unavailable_message', 'mensaje cuando hay demora'],
  revisar_datos: ['rules.verify_facts', 'revisar precios y datos'], revisar_afirmaciones: ['rules.verify_claims', 'revisar afirmaciones'],
  agenda_citas: ['rules.booking_enabled', 'agenda citas'], fotos_por_respuesta: ['rules.max_images_per_reply', 'fotos por respuesta'],
  no_repetir_fotos: ['rules.avoid_repeating_images', 'no repetir fotos'], reglas_de_fotos: ['rules.image_rules', 'cuándo manda fotos'],
  pausar_si_responde_una_persona: ['rules.pause_on_human_reply', 'pausa si responde una persona'], reanudar_tras_minutos: ['rules.auto_resume_minutes', 'se reanuda tras minutos'],
};

export const ajustesAvanzados = defineTool({
  name: 'ajustes_avanzados_del_agente',
  area: 'agente',
  roles: ['admin'],
  description: 'Ajustes finos del agente: idioma, ejemplos de estilo, temas permitidos, frases prohibidas, mensajes fijos, revisar datos, agendar citas, fotos por respuesta y pausa cuando contesta una persona.',
  schema: z.object({
    agente_id: Id,
    idioma: Text(40).optional(),
    ejemplos_de_estilo: List(5, 300).optional(),
    temas_permitidos: z.string().trim().max(1000).optional(),
    frases_prohibidas: List(30, 120).optional(),
    mensaje_si_no_sabe: Text(1000).optional().describe('Se manda tal cual cuando no sabe algo'),
    mensaje_si_hay_demora: Text(1000).optional(),
    revisar_datos: z.boolean().optional().describe('Revisa precios, teléfonos y enlaces contra la información'),
    revisar_afirmaciones: z.enum(['apagado', 'reglas', 'estricto']).optional(),
    agenda_citas: z.boolean().optional(),
    fotos_por_respuesta: z.number().int().min(0).max(5).optional(),
    no_repetir_fotos: z.boolean().optional(),
    reglas_de_fotos: z.string().trim().max(1000).optional(),
    pausar_si_responde_una_persona: z.boolean().optional(),
    reanudar_tras_minutos: z.number().int().min(0).max(10080).optional().describe('0 = no se reanuda solo'),
  }).refine((a) => Object.keys(AVANZADOS).some((k) => (a as any)[k] !== undefined), 'Indica qué ajustar'),
  label: () => 'Ajustando el agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  execute: (a, ctx) => applyChanges(ctx, a.agente_id, 'ajustes_avanzados_del_agente',
    () => Object.fromEntries(Object.entries(AVANZADOS).filter(([k]) => (a as any)[k] !== undefined).map(([k, [p]]) => [p, (a as any)[k]])),
    Object.fromEntries(Object.values(AVANZADOS))),
  undo: (p, ctx) => undoConfig(ctx, p),
});

// --- Mensajes guardados ----------------------------------------------------------------------------------------------

export const mensajesGuardados = defineTool({
  name: 'mensajes_guardados',
  area: 'agente',
  roles: ['admin'],
  description: 'Fija los mensajes guardados del agente (textos que manda tal cual, elegidos por su código): la lista completa nueva. Los que ya existían conservan su foto y etapa.',
  schema: z.object({
    agente_id: Id,
    mensajes: z.array(z.object({
      codigo: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,40}$/),
      titulo: z.string().trim().max(120).optional(),
      texto: Text(1000),
      cuando: z.string().trim().max(300).optional().describe('Cuándo lo usa'),
      activo: z.boolean().optional(),
    })).max(40),
  }),
  label: () => 'Cambiando los mensajes guardados…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  execute: (a, ctx) => applyChanges(ctx, a.agente_id, 'mensajes_guardados', (live) => {
    const old = new Map<string, any>((live.saved_messages ?? []).map((m: any) => [m.code, m]));
    return {
      saved_messages: a.mensajes.map((m) => {
        const prev = old.get(m.codigo) ?? {};
        return { ...prev, code: m.codigo, title: m.titulo ?? prev.title ?? '', text: m.texto, when: m.cuando ?? prev.when ?? '', image_id: prev.image_id ?? '', flow_step: prev.flow_step ?? 0, active: m.activo ?? prev.active ?? true };
      }),
    };
  }, { saved_messages: 'mensajes guardados' }),
  undo: (p, ctx) => undoConfig(ctx, p),
});

// --- Cotizaciones del agente -----------------------------------------------------------------------------------------

export const cotizacionesDelAgente = defineTool({
  name: 'cotizaciones_del_agente',
  area: 'agente',
  roles: ['admin'],
  description: 'Enciende o apaga las cotizaciones del agente; formato del PDF, finales, datos previos y si manda desglose y/o PDF. Conserva su cotizador (precios y reglas: armar_cotizador).',
  schema: z.object({
    agente_id: Id,
    activar: z.boolean().optional(),
    formato_id: z.string().max(40).optional().describe('Id del formato de cotización ("" = el más reciente)'),
    permitir_final: z.boolean().optional(),
    datos_antes_de_cotizar: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).max(20).optional().describe('Claves de las preguntas del agente'),
    enviar_desglose: z.boolean().optional().describe('Con calculadora: mandar el desglose (conceptos, IVA y total) en el chat'),
    enviar_pdf: z.boolean().optional().describe('Mandar el PDF con el formato del negocio'),
  }).refine((a) => [a.activar, a.formato_id, a.permitir_final, a.datos_antes_de_cotizar, a.enviar_desglose, a.enviar_pdf].some((x) => x !== undefined), 'Indica qué cambiar')
    .refine((a) => !(a.enviar_desglose === false && a.enviar_pdf === false), 'Deja al menos una forma de enviar la cotización: el desglose o el PDF'),
  label: () => 'Cambiando las cotizaciones del agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async execute(a, ctx) {
    if (a.formato_id) {
      const templates = (await ctx.call.get<any[]>('/api/quote-templates')) ?? [];
      if (!templates.some((t) => t.id === a.formato_id)) throw new ToolError('no_encontrado', 'Ese formato de cotización no existe en la cuenta.');
    }
    return applyChanges(ctx, a.agente_id, 'cotizaciones_del_agente', (live) => {
      if (a.datos_antes_de_cotizar) {
        const keys = new Set((live.data_fields ?? []).map((f: any) => f.key));
        const missing = a.datos_antes_de_cotizar.filter((k) => !keys.has(k));
        if (missing.length) throw new ToolError('datos_invalidos', `El agente no pide estos datos: ${missing.join(', ')}. Agrégalos primero con cambiar_preguntas.`);
      }
      // El objeto completo: el servidor lo reemplaza entero (lo que no se mande volvería a su valor por omisión).
      const q = live.ai?.quotes ?? {};
      return {
        'ai.quotes': {
          enabled: a.activar ?? q.enabled ?? false, template_id: a.formato_id ?? q.template_id ?? '',
          allow_final: a.permitir_final ?? q.allow_final ?? true, required_fields: a.datos_antes_de_cotizar ?? q.required_fields ?? [],
          // La calculadora y cómo se envía se conservan (si no, el agente volvería a la lista simple sin que nadie lo pida).
          calculator_id: q.calculator_id ?? '', send_summary: a.enviar_desglose ?? q.send_summary ?? true, send_pdf: a.enviar_pdf ?? q.send_pdf ?? true,
        },
      };
    }, { 'ai.quotes': 'cotizaciones' });
  },
  undo: (p, ctx) => undoConfig(ctx, p),
});

// --- Modelo de IA del agente -----------------------------------------------------------------------------------------

/** Solo modelos con precio en la plataforma: uno sin precio falla al contestar (y con límites de gasto no se puede reservar). */
async function checkModels(ctx: Ctx, models: (string | undefined)[]) {
  const wanted = models.filter((m): m is string => !!m);
  if (!wanted.length) return;
  const known = new Set(((await ctx.call.get<{ models: string[] }>('/api/ai-models'))?.models ?? []).map((m) => m.toLowerCase()));
  const unknown = wanted.filter((m) => !known.has(m.toLowerCase()));
  if (unknown.length) throw new ToolError('datos_invalidos', `Estos modelos no tienen precio en la plataforma: ${unknown.join(', ')}. Pide al superadmin que los agregue o elige otro.`);
}

export const modeloDelAgente = defineTool({
  name: 'modelo_del_agente',
  area: 'agente',
  roles: ['admin'],
  description: 'Cambia el modelo de IA con que contesta el agente (de los que tienen precio en la plataforma), sus respaldos y la temperatura. Se confirma: cambia el costo y la calidad.',
  schema: z.object({
    agente_id: Id,
    modelo: z.string().trim().max(120).optional().describe('"" = el de la plataforma'),
    respaldos: z.array(Text(120)).max(2).optional(),
    temperatura: z.number().min(0).max(1.5).optional(),
  }).refine((a) => a.modelo !== undefined || a.respaldos !== undefined || a.temperatura !== undefined, 'Indica qué cambiar'),
  label: () => 'Preparando el cambio de modelo…',
  risk: () => ({ level: 'confirm', reasons: ['Cambia el costo y la calidad de las respuestas del agente.'] }),
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    await checkModels(ctx, [a.modelo, ...(a.respaldos ?? [])]);
    return {
      title: `Cambiar el modelo de ${bot.name}`,
      lines: [
        ...(a.modelo !== undefined ? [`Modelo: ${a.modelo || 'el de la plataforma'}`] : []),
        ...(a.respaldos ? [`Respaldos: ${a.respaldos.join(', ') || 'ninguno'}`] : []),
        ...(a.temperatura !== undefined ? [`Temperatura: ${a.temperatura}`] : []),
      ],
    };
  },
  async execute(a, ctx) {
    await checkModels(ctx, [a.modelo, ...(a.respaldos ?? [])]);
    return applyChanges(ctx, a.agente_id, 'modelo_del_agente', () => ({
      ...(a.modelo !== undefined ? { 'ai.model': a.modelo } : {}),
      ...(a.respaldos ? { 'ai.fallback_models': a.respaldos } : {}),
      ...(a.temperatura !== undefined ? { 'ai.temperature': a.temperatura } : {}),
    }), { 'ai.model': 'modelo', 'ai.fallback_models': 'respaldos', 'ai.temperature': 'temperatura' });
  },
  undo: (p, ctx) => undoConfig(ctx, p),
});

export const AGENT_CONFIG_TOOLS = [cambiarPreguntas, cambiarObjetivo, cambiarActivacion, ajustesAvanzados, mensajesGuardados, cotizacionesDelAgente, modeloDelAgente];
