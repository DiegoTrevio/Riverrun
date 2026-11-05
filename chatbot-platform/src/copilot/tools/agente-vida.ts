/**
 * Herramientas del Copiloto para la vida de un agente (solo administradores): crearlo, duplicarlo, borrarlo, reiniciar
 * sus conversaciones, su historial de versiones, probarlo como si fueras un cliente y sus pruebas automáticas.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx } from '../registry.js';
import { links, when } from '../summarize.js';
import { botOf, Id } from './common.js';
import { versions } from './agente.js';

const Text = (max: number) => z.string().trim().max(max);

// --- Crear -----------------------------------------------------------------------------------------------------------

const ROLE = { resolver_dudas: 'assist', agendar_citas: 'book', tomar_pedidos: 'sell', solo_tomar_datos: 'filter' } as const;
const ROLE_LABEL: Record<keyof typeof ROLE, string> = {
  resolver_dudas: 'Resolver dudas', agendar_citas: 'Agendar citas', tomar_pedidos: 'Tomar pedidos', solo_tomar_datos: 'Solo tomar datos y pasar a una persona',
};
const DATOS = ['nombre', 'telefono', 'correo', 'ciudad', 'interes', 'presupuesto', 'fecha', 'personas'] as const;

const CrearAgente = z.object({
  nombre_negocio: Text(120).min(1),
  tipo_de_negocio: z.enum(['restaurante', 'salud', 'hotel', 'tienda', 'servicios', 'belleza', 'otro']).optional(),
  a_que_se_dedica: Text(2000).optional(),
  ubicacion: Text(300).optional(),
  que_hara: z.enum(['resolver_dudas', 'agendar_citas', 'tomar_pedidos', 'solo_tomar_datos']).optional(),
  datos_a_pedir: z.array(z.enum(DATOS)).max(8).optional(),
  nombre_del_asistente: Text(60).optional(),
  trato: z.enum(['tu', 'usted']).optional(),
  informacion: z.object({
    productos_y_precios: Text(20000).optional(), horario: Text(20000).optional(), ubicacion: Text(20000).optional(),
    preguntas_frecuentes: Text(20000).optional(), otra: Text(20000).optional(),
  }).optional().describe('Lo que sabe el agente (mínimo unas líneas); para importar de una página o archivo, usa importar_informacion después'),
  instrucciones: z.string().trim().min(40).max(12000).optional().describe('Solo si la persona dictó las instrucciones completas'),
});
type CrearArgs = z.infer<typeof CrearAgente>;

const wizardBody = (a: CrearArgs, requestId: string) => ({
  company: { name: a.nombre_negocio, business_type: a.tipo_de_negocio ?? 'otro', description: a.a_que_se_dedica ?? '', location: a.ubicacion ?? '' },
  ...(a.que_hara || a.datos_a_pedir ? { scope: { ...(a.que_hara ? { role: ROLE[a.que_hara] } : {}), ...(a.datos_a_pedir ? { collect: a.datos_a_pedir } : {}) } } : {}),
  ...(a.nombre_del_asistente || a.trato ? { style: { ...(a.nombre_del_asistente ? { assistant_name: a.nombre_del_asistente } : {}), ...(a.trato ? { formality: a.trato } : {}) } } : {}),
  knowledge: {
    sections: {
      catalog: a.informacion?.productos_y_precios ?? '', hours: a.informacion?.horario ?? '', location: a.informacion?.ubicacion ?? '',
      faq: a.informacion?.preguntas_frecuentes ?? '', other: a.informacion?.otra ?? '',
    },
  },
  ...(a.instrucciones ? { prompt_override: a.instrucciones } : {}),
  request_id: requestId,
  start_on_connect: true,
});

export const crearAgente = defineTool({
  name: 'crear_agente',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Crea un agente nuevo (nace apagado y se enciende solo al conectar su WhatsApp). Se confirma. Después: cambiar_preguntas, cambiar_objetivo, importar_informacion, crear_whatsapp.',
  schema: CrearAgente,
  label: (a) => `Preparando el agente para ${a.nombre_negocio}…`,
  risk: () => ({ level: 'confirm', reasons: ['Crea un agente nuevo (cuenta para el límite de tu plan).'] }),
  async preview(a, ctx) {
    // La vista previa del panel (sin IA): el mismo texto de instrucciones que se va a crear.
    const requestId = randomUUID();
    const draft = await ctx.call.send<any>('POST', '/api/chatbots/draft', wizardBody(a, requestId));
    if (!draft?.enough_knowledge) throw new ToolError('datos_invalidos', 'Falta información del negocio (al menos unas líneas: qué vende, precios u horario). Pídesela a la persona o importa una página.');
    return {
      title: `Crear el agente «${draft.name ?? a.nombre_negocio}»`,
      lines: [
        `Qué hará: ${ROLE_LABEL[a.que_hara ?? 'resolver_dudas']}`,
        ...(a.datos_a_pedir?.length ? [`Pide: ${a.datos_a_pedir.join(', ')}`] : []),
        `Trato: ${a.trato === 'usted' ? 'de usted' : 'de tú'}`,
        `Sabe: ${(draft.knowledge ?? []).map((k: any) => k.title).join(', ') || 'lo que escribiste'}`,
        'Nace apagado: empieza a contestar cuando conectes su WhatsApp.',
      ],
      ...(draft.prompt ? { quote: String(draft.prompt) } : {}),
      meta: { request_id: requestId },
    };
  },
  async execute(a, ctx) {
    // El mismo request_id de la vista previa: confirmar dos veces (o reintentar) no crea dos agentes.
    const requestId = String((ctx.proposal?.meta as any)?.request_id ?? randomUUID());
    const bot = await ctx.call.send<any>('POST', '/api/chatbots/wizard', wizardBody(a, requestId));
    return {
      title: `Creé el agente «${bot.name}» (apagado hasta conectar su WhatsApp)`,
      links: [links.bot(bot.id, 'empezar', 'Probar y conectar'), links.bot(bot.id, 'instrucciones', 'Ver agente')],
      data: { agente_id: bot.id, nombre: bot.name, encendido: false, repetido: bot.repeated || undefined, siguiente: 'Puedes ajustar sus preguntas y objetivo, importar información o crear su WhatsApp.' },
    };
  },
});

// --- Duplicar, borrar, reiniciar -------------------------------------------------------------------------------------

export const duplicarAgente = defineTool({
  name: 'duplicar_agente',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Duplica un agente con su configuración, conocimiento, fotos y mensajes guardados (la copia nace apagada). Se confirma.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Preparando la copia del agente…',
  risk: () => ({ level: 'confirm', reasons: ['Crea otro agente (cuenta para el límite de tu plan).'] }),
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    return { title: `Duplicar el agente «${bot.name}»`, lines: ['La copia nace apagada, con su configuración, conocimiento, fotos y mensajes guardados.'] };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const copy = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/duplicate`, {});
    return { title: `Dupliqué «${bot.name}» como «${copy.name}»`, links: [links.bot(copy.id, 'instrucciones', 'Ver la copia')], data: { agente_id: copy.id, nombre: copy.name } };
  },
});

export const borrarAgente = defineTool({
  name: 'borrar_agente',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Borra un agente para siempre (su conocimiento, fotos, versiones y los avisos y automatizaciones que eran solo de él). Las conversaciones se conservan. Se confirma.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Preparando el borrado del agente…',
  risk: () => ({ level: 'confirm', reasons: ['No se puede deshacer.'] }),
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const rules = ((await ctx.call.get<any[]>('/api/automations')) ?? []).filter((r) => r.chatbot_id === bot.id);
    const channels = (bot.channels ?? []).map((c: any) => c.name);
    return {
      title: `Borrar el agente «${bot.name}»`,
      lines: [
        'Se borran su conocimiento, fotos y versiones. Las conversaciones se conservan, sin agente.',
        ...(rules.length ? [`También se borran ${rules.length} aviso(s) o regla(s) que eran solo de este agente.`] : []),
        ...(channels.length ? [`Sus canales quedan sin agente: ${channels.join(', ')}.`] : []),
      ],
      warning: 'No se puede deshacer.',
    };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    await ctx.call.send('DELETE', path`/api/chatbots/${bot.id}`);
    return { title: `Borré el agente «${bot.name}»`, data: { borrado: true } };
  },
});

export const reiniciarConversaciones = defineTool({
  name: 'reiniciar_conversaciones_del_agente',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Reinicia todas las conversaciones de un agente (empiezan de cero: etapa, memoria y preguntas). Se confirma.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Preparando el reinicio de conversaciones…',
  risk: () => ({ level: 'confirm', reasons: ['Todas sus conversaciones empiezan de cero; no se puede deshacer.'] }),
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    return { title: `Reiniciar las conversaciones de «${bot.name}»`, lines: ['Cada conversación vuelve al inicio: etapa, memoria y preguntas. Los mensajes se conservan.'], warning: 'No se puede deshacer.' };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const r = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/restart-conversations`, {});
    return { title: `Reinicié las conversaciones de «${bot.name}»`, links: [links.bot(bot.id)], data: { reiniciadas: r?.restarted ?? true } };
  },
});

// --- Versiones -------------------------------------------------------------------------------------------------------

export const verVersiones = defineTool({
  name: 'ver_versiones',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'El historial de versiones de un agente (quién cambió qué y cuándo), para revisar o regresar a una anterior.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Revisando las versiones del agente…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const v = await versions(ctx, bot.id);
    return {
      title: `Revisé las versiones de ${bot.name}`,
      links: [links.bot(bot.id)],
      data: { versiones: (v.releases ?? []).slice(0, 20).map((r: any) => ({ version_id: r.id, quien: r.author_name, motivo: r.reason, cuando: when(r.created_at, ctx.timezone) })) },
    };
  },
});

export const restaurarVersion = defineTool({
  name: 'restaurar_version',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Regresa un agente a una versión anterior de su configuración (ver_versiones da el version_id). Se aplica en sus canales. Se confirma.',
  schema: z.object({ agente_id: Id, version_id: z.number().int().positive() }),
  label: () => 'Preparando la restauración…',
  risk: () => ({ level: 'confirm', reasons: ['Reemplaza la configuración que usa hoy el agente.'] }),
  async preview(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const r = ((await versions(ctx, bot.id)).releases ?? []).find((x: any) => Number(x.id) === a.version_id);
    if (!r) throw new ToolError('no_encontrado', 'Esa versión no es de este agente.');
    return { title: `Regresar «${bot.name}» a la versión del ${when(r.created_at, ctx.timezone)}`, lines: [`De ${r.author_name || 'alguien del equipo'}${r.reason ? `: ${r.reason}` : ''}.`, 'La versión de hoy queda en el historial.'] };
  },
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const v = await versions(ctx, bot.id);
    if (!(v.releases ?? []).some((x: any) => Number(x.id) === a.version_id)) throw new ToolError('no_encontrado', 'Esa versión no es de este agente.');
    await ctx.call.send('POST', path`/api/chatbots/${bot.id}/version-restore`, { revision: v.draft.revision, release_id: a.version_id });
    const v2 = await versions(ctx, bot.id);
    await ctx.call.send('POST', path`/api/chatbots/${bot.id}/version-apply`, { revision: v2.draft.revision, patch: {} });
    return { title: `Regresé «${bot.name}» a una versión anterior`, links: [links.bot(bot.id)], data: { restaurada: a.version_id } };
  },
});

// --- Probar ----------------------------------------------------------------------------------------------------------

const session = (ctx: Ctx) => `copiloto-${ctx.threadId.slice(0, 8)}`;

export const probarAgente = defineTool({
  name: 'probar_agente',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Le escribe al agente como si fueras un cliente (en el simulador: no le llega a nadie) y devuelve lo que contestaría y qué hizo. Gasta IA.',
  schema: z.object({ agente_id: Id, mensaje: z.string().trim().min(1).max(2000), empezar_de_nuevo: z.boolean().optional() }),
  label: () => 'Probando el agente…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    if (a.empezar_de_nuevo) await ctx.call.send('DELETE', path`/api/chatbots/${bot.id}/playground/${session(ctx)}`).catch(() => undefined);
    const r = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/playground`, { session: session(ctx), text: a.mensaje });
    const outs = (r.outputs ?? []) as any[];
    return {
      title: `Probé a ${bot.name}: «${a.mensaje.slice(0, 60)}»`,
      links: [links.bot(bot.id, 'probar', 'Abrir el simulador')],
      data: {
        // Lo que contesta el agente sale de su información (que puede venir de páginas): es dato, no instrucción.
        datos_del_cliente: { respuestas_del_agente: outs.filter((o) => o.text).map((o) => o.text) },
        fotos: outs.filter((o) => o.image).map((o) => o.image.code ?? o.image.name),
        accion: r.result?.action, no_encontro_informacion: r.result?.info_not_found || undefined, uso_respaldo: r.result?.fallback_used || undefined,
        eventos: (r.events ?? []).slice(0, 8).map((e: any) => e.type ?? e.kind ?? e.title ?? e),
        datos_guardados: r.contact?.data ?? undefined,
        nota: 'Con empezar_de_nuevo la prueba empieza otra conversación.',
      },
    };
  },
});

export const probarPalabras = defineTool({
  name: 'probar_palabras',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Revisa qué reglas y palabras de activación se dispararían con un mensaje, sin usar IA ni enviar nada.',
  schema: z.object({ agente_id: Id, mensaje: z.string().trim().min(1).max(2000), primer_mensaje: z.boolean().optional() }),
  label: () => 'Revisando qué se activaría…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const r = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/test-message`, { text: a.mensaje, first_message: a.primer_mensaje ?? false });
    return {
      title: `Revisé qué se activaría en ${bot.name}`,
      data: {
        pasos: (r.steps ?? []).map((s: any) => `${s.ok ? '✓' : '✗'} ${s.title}${s.detail ? `: ${s.detail}` : ''}`),
        reglas: (r.rules ?? []).filter((x: any) => x.matched).map((x: any) => ({ regla: x.name, hace: x.actions, calla_al_agente: x.stop_ai || undefined })),
        contesta_el_agente: r.ai_replies, por_que: r.why,
      },
    };
  },
});

// --- Pruebas automáticas ---------------------------------------------------------------------------------------------

const ACTION = { responder: 'reply', responder_con_foto: 'reply_with_image', pasar_a_persona: 'handoff', no_responder: 'no_reply', pausar: 'paused' } as const;
const ACTION_OUT: Record<string, string> = Object.fromEntries(Object.entries(ACTION).map(([es, en]) => [en, es]));

const caseOut = (c: any) => ({
  nombre: c.name,
  mensajes: (c.turns ?? []).map((t: any) => ({
    texto: t.text,
    ...(t.expect ? { debe_contener: t.expect.contains?.length ? t.expect.contains : undefined, no_debe_contener: t.expect.not_contains?.length ? t.expect.not_contains : undefined, accion: t.expect.action ? ACTION_OUT[t.expect.action] : undefined } : {}),
  })),
});

export const verPruebas = defineTool({
  name: 'ver_pruebas',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Las pruebas automáticas de un agente (conversaciones de ejemplo con lo que debe contestar) y sus últimas corridas.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Revisando las pruebas del agente…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const [suite, v] = await Promise.all([ctx.call.get<any>(path`/api/chatbots/${bot.id}/tests`), versions(ctx, bot.id)]);
    return {
      title: `Revisé las pruebas de ${bot.name}`,
      links: [links.bot(bot.id, 'probar', 'Ver pruebas')],
      data: { casos: (suite.cases ?? []).map(caseOut), corridas: (v.runs ?? []).slice(0, 5).map((r: any) => ({ prueba_id: r.id, estado: r.status, cuando: when(r.created_at, ctx.timezone) })) },
    };
  },
});

export const editarPruebas = defineTool({
  name: 'editar_pruebas',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Fija las pruebas automáticas de un agente (la lista completa nueva): cada una es una conversación de ejemplo con lo que debe o no debe contestar.',
  schema: z.object({
    agente_id: Id,
    casos: z.array(z.object({
      nombre: z.string().trim().min(1).max(120),
      mensajes: z.array(z.object({
        texto: z.string().trim().min(1).max(4000).describe('Lo que escribe el cliente'),
        debe_contener: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
        no_debe_contener: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
        accion: z.enum(['responder', 'responder_con_foto', 'pasar_a_persona', 'no_responder', 'pausar']).optional(),
      })).min(1).max(6),
    })).max(10),
  }),
  label: () => 'Guardando las pruebas del agente…',
  risk: () => 'reversible',
  targets: (a) => [{ kind: 'bot', id: a.agente_id }],
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const suite = await ctx.call.get<any>(path`/api/chatbots/${bot.id}/tests`);
    const cases = a.casos.map((c) => ({
      name: c.nombre,
      turns: c.mensajes.map((m) => {
        const has = m.debe_contener?.length || m.no_debe_contener?.length || m.accion;
        return { text: m.texto, ...(has ? { expect: { contains: m.debe_contener ?? [], not_contains: m.no_debe_contener ?? [], ...(m.accion ? { action: ACTION[m.accion] } : {}) } } : {}) };
      }),
    }));
    const saved = await ctx.call.send<any>('PUT', path`/api/chatbots/${bot.id}/tests`, { revision: suite.revision, cases });
    return {
      title: `Guardé ${cases.length} prueba(s) de ${bot.name}`,
      links: [links.bot(bot.id, 'probar', 'Ver pruebas')],
      undo: { label: 'Deshacer', custom: { tool: 'editar_pruebas', params: { bot_id: bot.id, cases: suite.cases ?? [], revision: saved?.revision } } },
      data: { casos: cases.length },
    };
  },
  async undo(p: { bot_id: string; cases: unknown[]; revision?: number }, ctx) {
    const suite = await ctx.call.get<any>(path`/api/chatbots/${p.bot_id}/tests`);
    if (p.revision !== undefined && suite.revision !== p.revision) throw new ToolError('conflicto', 'Las pruebas cambiaron después; para no perder esos cambios, no las regresé.');
    await ctx.call.send('PUT', path`/api/chatbots/${p.bot_id}/tests`, { revision: suite.revision, cases: p.cases });
  },
});

export const correrPruebas = defineTool({
  name: 'correr_pruebas',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'Corre las pruebas automáticas del agente sobre su configuración actual (gasta IA, tope de 1 USD). Devuelve el prueba_id para ver el resultado con ver_resultado_pruebas.',
  schema: z.object({ agente_id: Id }),
  label: () => 'Corriendo las pruebas del agente…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const v = await versions(ctx, bot.id);
    const run = await ctx.call.send<any>('POST', path`/api/chatbots/${bot.id}/tests/run`, { revision: v.draft.revision });
    return { title: `Empecé las pruebas de ${bot.name}`, links: [links.bot(bot.id, 'probar', 'Ver pruebas')], data: { prueba_id: run.id, estado: run.status, nota: 'Tarda uno o dos minutos; revisa con ver_resultado_pruebas.' } };
  },
});

export const verResultadoPruebas = defineTool({
  name: 'ver_resultado_pruebas',
  area: 'agente',
  pack: 'agentes',
  roles: ['admin'],
  description: 'El resultado de una corrida de pruebas del agente: cuáles pasaron, cuáles no y por qué.',
  schema: z.object({ agente_id: Id, prueba_id: z.union([z.string().max(64), z.number().int()]) }),
  label: () => 'Revisando el resultado de las pruebas…',
  risk: () => 'read',
  async execute(a, ctx) {
    const bot = await botOf(ctx, a.agente_id);
    const id = String(a.prueba_id);
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw new ToolError('datos_invalidos', 'prueba_id no válido');
    const r = await ctx.call.get<any>(path`/api/chatbots/${bot.id}/tests/runs/${id}`);
    return {
      title: `Revisé las pruebas de ${bot.name}: ${r.status}`,
      links: [links.bot(bot.id, 'probar', 'Ver pruebas')],
      data: {
        estado: r.status, costo_usd: r.cost_usd ?? undefined,
        casos: (r.results ?? []).map((c: any) => ({ nombre: c.name, paso: c.passed, fallas: (c.turns ?? []).flatMap((t: any) => t.failures ?? []).slice(0, 5) })),
      },
    };
  },
});

export const AGENT_LIFE_TOOLS = [crearAgente, duplicarAgente, borrarAgente, reiniciarConversaciones, verVersiones, restaurarVersion, probarAgente, probarPalabras, verPruebas, editarPruebas, correrPruebas, verResultadoPruebas];
