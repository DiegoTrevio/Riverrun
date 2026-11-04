/**
 * Herramientas del Copiloto para los ajustes del negocio y sus datos (fase 2, solo administradores): avisos al equipo,
 * reparto de conversaciones, consentimiento, bajas, envíos y cuánto se guardan los datos (la retención pide el código,
 * como en el panel), y exportar a CSV (el archivo lo baja el panel con «Descargar»; nunca pasa por el Copiloto).
 */
import { z } from 'zod';
import { path, ToolError } from '../executor.js';
import { defineTool, type Ctx, type RiskInfo } from '../registry.js';
import { stableJson } from '../store.js';
import { links } from '../summarize.js';
import { DateStr, Id, snapshot } from './common.js';

// --- Ajustes del negocio ---------------------------------------------------------------------------------------------

const Phrases = z.array(z.string().trim().min(1).max(100)).max(20);
const Settings = z.object({
  zona_horaria: z.string().trim().max(60).optional().describe('IANA, como America/Mexico_City'),
  avisos: z.object({
    equipo_al_pasar_a_persona: z.boolean(), repetir_espera_min: z.number().int().min(0).max(1440), repetir_error_ia_min: z.number().int().min(0).max(1440),
    escalar_min: z.number().int().min(0).max(1440).describe('0 = no escalar'), escalar_a: z.array(Id).max(50).describe('Administradores (vacío = todos)'),
  }).partial().optional(),
  desconexion: z.object({
    activo: z.boolean(), despues_min: z.number().int().min(0).max(1440), repetir_horas: z.number().int().min(0).max(168), a_administradores: z.boolean(),
    correos: z.array(z.string().trim().toLowerCase().email()).max(10), telefonos: z.array(z.string().trim().regex(/^\+?[\d\s()-]{8,20}$/)).max(5), al_reconectar: z.boolean(),
  }).partial().optional().describe('Avisos cuando un WhatsApp se desconecta'),
  reparto: z.object({ activo: z.boolean(), al_pasar_a_persona: z.boolean(), roles: z.array(z.enum(['admin', 'agent'])).max(2), personas: z.array(Id).max(100), avisar_a_todos: z.boolean() }).partial().optional().describe('Asignar conversaciones por turnos'),
  consentimiento: z.object({ requerido_para_campanas: z.boolean(), frases: Phrases, mensaje: z.string().max(500) }).partial().optional(),
  bajas: z.object({ activo: z.boolean(), palabras: Phrases, mensaje: z.string().max(1000), palabras_para_volver: Phrases, mensaje_al_volver: z.string().max(1000), pie_activo: z.boolean(), pie: z.string().max(200) }).partial().optional(),
  tope_diario_por_numero: z.number().int().min(0).max(100000).optional().describe('Mensajes de campaña por WhatsApp al día (0 = sin tope)'),
  retencion: z.object({ mensajes_dias: z.number().int().min(0).max(3650), contactos_inactivos_dias: z.number().int().min(0).max(3650) }).partial().optional().describe('0 = conservar siempre; si no, al menos 30'),
});
type SettingsArgs = z.infer<typeof Settings>;

/** De los nombres del Copiloto a los del panel, por sección. */
const MAP = {
  avisos: { key: 'alert_timing', fields: { repetir_espera_min: 'human_repeat_minutes', repetir_error_ia_min: 'ai_error_repeat_minutes', escalar_min: 'escalate_minutes', escalar_a: 'escalate_user_ids' } },
  desconexion: { key: 'connection_alerts', fields: { activo: 'enabled', despues_min: 'after_minutes', repetir_horas: 'repeat_hours', a_administradores: 'notify_admins', correos: 'emails', telefonos: 'phones', al_reconectar: 'notify_reconnected' } },
  reparto: { key: 'assignment', fields: { activo: 'enabled', al_pasar_a_persona: 'on_handoff', roles: 'roles', personas: 'user_ids', avisar_a_todos: 'notify_all' } },
  consentimiento: { key: 'consent', fields: { requerido_para_campanas: 'require_for_campaigns', frases: 'opt_in_keywords', mensaje: 'opt_in_message' } },
  bajas: { key: 'opt_out', fields: { activo: 'enabled', palabras: 'keywords', mensaje: 'confirm_message', palabras_para_volver: 'resume_keywords', mensaje_al_volver: 'resume_message', pie_activo: 'footer_enabled', pie: 'footer_text' } },
  retencion: { key: 'retention', fields: { mensajes_dias: 'messages_days', contactos_inactivos_dias: 'inactive_contacts_days' } },
} as const;

/** Lo que se manda a PUT /api/settings: cada sección completa (la ruta reemplaza la sección entera), con lo pedido encima. */
function settingsBody(a: SettingsArgs, current: any): Record<string, unknown> {
  const body: Record<string, any> = {};
  if (a.zona_horaria) body.timezone = a.zona_horaria;
  if (a.tope_diario_por_numero !== undefined) body.sending = { ...current.sending, daily_cap_per_number: a.tope_diario_por_numero };
  if (a.avisos?.equipo_al_pasar_a_persona !== undefined) body.notify_team_on_handoff = a.avisos.equipo_al_pasar_a_persona;
  for (const [section, m] of Object.entries(MAP) as [keyof typeof MAP, (typeof MAP)[keyof typeof MAP]][]) {
    const given = (a[section] ?? {}) as Record<string, unknown>;
    const mapped = Object.fromEntries(Object.entries(given).filter(([k, v]) => v !== undefined && k in m.fields).map(([k, v]) => [(m.fields as Record<string, string>)[k], v]));
    if (!Object.keys(mapped).length) continue;
    // De la retención solo van los días (lo programado lo decide el servidor).
    const base = section === 'retencion' ? { messages_days: current.retention?.messages_days ?? 0, inactive_contacts_days: current.retention?.inactive_contacts_days ?? 0 } : current[m.key];
    body[m.key] = { ...base, ...mapped };
  }
  return body;
}

const SECTION_ES: Record<string, string> = {
  timezone: 'Zona horaria', sending: 'Envíos', notify_team_on_handoff: 'Avisar al equipo al pasar a una persona', alert_timing: 'Avisos', connection_alerts: 'Desconexión',
  assignment: 'Reparto', consent: 'Consentimiento', opt_out: 'Bajas', retention: 'Retención',
};

const sameDays = (a: any, b: any) => Number(a?.messages_days ?? 0) === Number(b?.messages_days ?? 0) && Number(a?.inactive_contacts_days ?? 0) === Number(b?.inactive_contacts_days ?? 0);

async function settingsRisk(a: SettingsArgs, ctx: Ctx): Promise<RiskInfo> {
  const s = await ctx.call.get<any>('/api/settings');
  const body = settingsBody(a, s);
  if (!Object.keys(body).length) return { level: 'read', reasons: [] };
  if (body.retention && !sameDays(body.retention, s.retention)) {
    return { level: 'code', reasons: ['Cambia cuánto se guardan los datos de los clientes: se confirma con tu código de verificación (solo la persona dueña de la cuenta).'] };
  }
  const added = [...(a.desconexion?.correos ?? []).filter((e) => !(s.connection_alerts?.emails ?? []).includes(e)), ...(a.desconexion?.telefonos ?? []).filter((p) => !(s.connection_alerts?.phones ?? []).includes(p))];
  if (added.length) return { level: 'confirm', reasons: [`Agrega destinatarios fuera del panel: ${added.join(', ')}.`] };
  return { level: 'reversible', reasons: [] };
}

const settingsOut = (s: any) => ({
  zona_horaria: s.timezone,
  avisos: { equipo_al_pasar_a_persona: s.notify_team_on_handoff, repetir_espera_min: s.alert_timing?.human_repeat_minutes, repetir_error_ia_min: s.alert_timing?.ai_error_repeat_minutes, escalar_min: s.alert_timing?.escalate_minutes, escalar_a: s.alert_timing?.escalate_user_ids },
  desconexion: { activo: s.connection_alerts?.enabled, despues_min: s.connection_alerts?.after_minutes, repetir_horas: s.connection_alerts?.repeat_hours, correos: s.connection_alerts?.emails, telefonos: s.connection_alerts?.phones },
  reparto: { activo: s.assignment?.enabled, al_pasar_a_persona: s.assignment?.on_handoff, roles: s.assignment?.roles, personas: s.assignment?.user_ids, avisar_a_todos: s.assignment?.notify_all },
  consentimiento: { requerido_para_campanas: s.consent?.require_for_campaigns, frases: s.consent?.opt_in_keywords, mensaje: s.consent?.opt_in_message },
  bajas: { activo: s.opt_out?.enabled, palabras: s.opt_out?.keywords, mensaje: s.opt_out?.confirm_message, palabras_para_volver: s.opt_out?.resume_keywords, pie_activo: s.opt_out?.footer_enabled, pie: s.opt_out?.footer_text },
  tope_diario_por_numero: s.sending?.daily_cap_per_number,
  retencion: { mensajes_dias: s.retention?.messages_days, contactos_inactivos_dias: s.retention?.inactive_contacts_days, programada: s.retention?.pending ?? undefined },
});

export const ajustesDelNegocio = defineTool({
  name: 'ajustes_del_negocio',
  area: 'cuenta',
  roles: ['admin'],
  description: 'Sin cambios, muestra los ajustes del negocio; con cambios, guarda solo lo indicado: avisos al equipo, desconexión, reparto, consentimiento, bajas, tope de envíos, zona y retención.',
  schema: Settings,
  label: () => 'Revisando los ajustes del negocio…',
  risk: settingsRisk,
  grants: ['PUT /api/settings'],
  async preview(a, ctx) {
    const s = await ctx.call.get<any>('/api/settings');
    const body = settingsBody(a, s);
    // Solo lo que cambia, campo por campo y completo (lo que se va a guardar).
    const lines = Object.entries(body).flatMap(([k, v]) => {
      const label = SECTION_ES[k] ?? k;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${label}: ${JSON.stringify(v)}`];
      return Object.entries(v as Record<string, unknown>).filter(([f, x]) => stableJson(x) !== stableJson(s[k]?.[f])).map(([f, x]) => `${label} · ${f}: ${JSON.stringify(x)}`);
    });
    return {
      title: 'Cambiar los ajustes del negocio',
      lines,
      ...(body.retention ? { warning: 'Si borra más que ahora, entra en 7 días y se le avisa a la persona dueña; mientras, se puede cancelar.' } : {}),
    };
  },
  async execute(a, ctx) {
    const before = await ctx.call.get<any>('/api/settings');
    const body = settingsBody(a, before);
    const keys = Object.keys(body);
    if (!keys.length) return { title: 'Revisé los ajustes del negocio', links: [links.settings('Ver ajustes')], data: settingsOut(before) };
    const saved = await ctx.call.send<any>('PUT', '/api/settings', body);
    // La retención no se deshace desde aquí (se confirma con código); lo demás regresa sección por sección si nadie lo cambió.
    const undoKeys = keys.filter((k) => k !== 'retention');
    return {
      title: `Cambié los ajustes del negocio (${keys.length} sección(es))`,
      links: [links.settings('Ver ajustes')],
      before: snapshot(before, keys),
      after: snapshot(saved, keys),
      undo: undoKeys.length ? { label: 'Deshacer', check: { url: '/api/settings', pick: undoKeys, expect: snapshot(saved, undoKeys) }, steps: [{ method: 'PUT', url: '/api/settings', body: snapshot(before, undoKeys) }] } : null,
      data: settingsOut(saved),
    };
  },
});

// --- Exportar a CSV --------------------------------------------------------------------------------------------------

const KIND = { contactos: 'contacts', conversaciones: 'conversations', mensajes: 'messages', cotizaciones: 'quotes' } as const;
const STATUS = { con_agente: 'bot', con_persona: 'human', cerradas: 'closed' } as const;
/** Valor de la consulta con todo escapado (incluso ! ' ( ) * ~), para que la ruta pase la lista de descargas. */
const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const ExportArgs = z.object({
  que: z.enum(['contactos', 'conversaciones', 'mensajes', 'cotizaciones']),
  desde: DateStr.optional(),
  hasta: DateStr.optional().describe('No aplica a contactos'),
  etiqueta: z.string().trim().min(1).max(60).optional().describe('Contactos'),
  dados_de_baja: z.boolean().optional().describe('Contactos'),
  canal_id: Id.optional(),
  agente_id: Id.optional().describe('Conversaciones'),
  estado: z.enum(['con_agente', 'con_persona', 'cerradas']).optional().describe('Conversaciones'),
  conversacion_id: Id.optional().describe('Mensajes de una sola conversación'),
});
type ExportArgsT = z.infer<typeof ExportArgs>;

/** La consulta de cada exportación, solo con los filtros que esa ruta entiende. */
function exportQuery(a: ExportArgsT): Record<string, string | undefined> {
  if (a.que === 'contactos') return { channel_id: a.canal_id, tag: a.etiqueta, opted_out: a.dados_de_baja === undefined ? undefined : String(a.dados_de_baja), since: a.desde };
  if (a.que === 'conversaciones') return { channel_id: a.canal_id, chatbot_id: a.agente_id, status: a.estado ? STATUS[a.estado] : undefined, from: a.desde, to: a.hasta };
  if (a.que === 'mensajes') return { conversation_id: a.conversacion_id, channel_id: a.canal_id, from: a.desde, to: a.hasta };
  return { from: a.desde, to: a.hasta };
}
const exportHref = (a: ExportArgsT) => {
  const q = Object.entries(exportQuery(a)).filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v!)}`).join('&');
  return `/api/export/${KIND[a.que]}.csv${q ? `?${q}` : ''}`;
};
const FILTER_ES: Record<string, string> = { channel_id: 'canal', tag: 'etiqueta', opted_out: 'dados de baja', since: 'creados desde', chatbot_id: 'agente', status: 'estado', from: 'desde', to: 'hasta', conversation_id: 'conversación' };

export const exportarDatos = defineTool({
  name: 'exportar_datos',
  area: 'datos',
  roles: ['admin'],
  description: 'Exporta a CSV contactos, conversaciones, mensajes o cotizaciones (con filtros). Se confirma con el código en la tarjeta y la persona lo baja con «Descargar»; el archivo no pasa por ti.',
  schema: ExportArgs,
  label: () => 'Preparando la exportación…',
  risk: () => ({ level: 'code', reasons: ['Saca datos de clientes del panel: se confirma con tu código de verificación.'] }),
  download: exportHref,
  async preview(a) {
    const filters = Object.entries(exportQuery(a)).filter(([, v]) => v).map(([k, v]) => `${FILTER_ES[k] ?? k}: ${v}`);
    return {
      title: `Exportar ${a.que} a CSV`,
      lines: [filters.length ? `Filtros: ${filters.join(' · ')}` : 'Sin filtros: todo lo de la cuenta.', 'Al confirmar con tu código, lo descargas con «Descargar» en esta tarjeta; el archivo no pasa por el Copiloto.'],
    };
  },
  async execute(a, ctx) {
    // Que lo que se filtra sea de la cuenta (el canal o la conversación), con los permisos de quien confirma.
    if (a.canal_id && !((await ctx.call.get<any[]>('/api/channels')) ?? []).some((c) => c.id === a.canal_id)) throw new ToolError('no_encontrado', 'Ese canal no es de la cuenta');
    if (a.conversacion_id) await ctx.call.get(path`/api/conversations/${a.conversacion_id}`);
    return { title: `Preparé la exportación de ${a.que} a CSV`, links: [links.stats()], data: { listo: true, nota: 'La persona lo descarga con «Descargar» en la tarjeta.' } };
  },
});

export const BUSINESS_TOOLS = [ajustesDelNegocio, exportarDatos];
