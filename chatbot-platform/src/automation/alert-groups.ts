import type { AlertChannelPrefs, AlertPrefs } from '../types.js';

/**
 * Quién recibe qué. Cada aviso al equipo tiene un tipo (notifications.kind); los tipos se juntan en grupos y cada persona
 * elige, por grupo, si le llegan en el panel, por WhatsApp y por correo. Lo que no elige queda como siempre: todo en el
 * panel, WhatsApp si tiene número y lo activó, y correo solo lo urgente (EMAIL_KINDS).
 */
export const ALERT_GROUPS = [
  { key: 'handoff', label: 'Esperan a una persona', hint: 'Cuando una conversación pasa a una persona y los recordatorios si el cliente sigue esperando.' },
  { key: 'assigned', label: 'Asignadas a mí', hint: 'Cuando te asignan una conversación (por turnos, a mano o por una regla).' },
  { key: 'agenda', label: 'Citas', hint: 'Citas y llamadas agendadas o canceladas.' },
  { key: 'quotes', label: 'Cotizaciones', hint: 'Cotizaciones finales por aprobar.' },
  { key: 'rules', label: 'Objetivos y reglas', hint: 'Objetivos cumplidos y avisos de tus reglas automáticas.' },
  { key: 'followups', label: 'Seguimientos prometidos', hint: 'Cuando el asistente le promete al cliente que alguien le dará seguimiento.' },
  { key: 'social', label: 'Redes sociales', hint: 'Comentarios y reseñas nuevos en tus redes.' },
  { key: 'errors', label: 'Errores y emergencias', hint: 'Clientes sin respuesta por una falla, posibles emergencias y envíos que no salieron. En el panel siempre llegan.' },
] as const;
export type AlertGroup = (typeof ALERT_GROUPS)[number]['key'];

const GROUP_OF: Record<string, AlertGroup> = {
  handoff: 'handoff',
  handoff_wait: 'handoff',
  escalation: 'handoff',
  assignment: 'assigned',
  appointment: 'agenda',
  quote: 'quotes',
  goal: 'rules',
  rule: 'rules',
  follow_up: 'followups',
  social: 'social',
  social_reply: 'social',
  ai_error: 'errors',
  safety: 'errors',
  alert: 'errors',
  automation: 'errors',
};

/** Tipos de aviso de un grupo (para filtrar la página de Notificaciones). */
export const kindsOfGroup = (group: string) => Object.entries(GROUP_OF).filter(([, g]) => g === group).map(([k]) => k);

/** Lo que el panel muestra por grupo, con lo que pasa si la persona no elige nada (correo: solo lo urgente). */
export const alertGroupsForPanel = () =>
  ALERT_GROUPS.map((g) => ({ ...g, defaults: { panel: true, whatsapp: true, email: kindsOfGroup(g.key).some((k) => EMAIL_KINDS.includes(k)) }, panel_locked: g.key === 'errors' }));

/** Grupo de un tipo de aviso; los que no tienen grupo (p. ej. un aviso manual del equipo) llegan siempre como hoy. */
export const alertGroupOf = (kind: string | undefined): AlertGroup | null => (kind ? GROUP_OF[kind] ?? null : null);

/**
 * Si se agrupa: el mismo aviso de la misma conversación no se repite en 10 minutos. Las fallas y emergencias no se agrupan
 * (cada una es nueva) ni los recordatorios de espera, que ya se repiten cada lo que elija la cuenta.
 */
export const groupsRepeats = (kind: string | undefined) => alertGroupOf(kind) !== 'errors' && kind !== 'handoff_wait';

/** Lo urgente también llega por correo: el WhatsApp de la cuenta puede ser justo lo que está fallando. */
export const EMAIL_KINDS = ['ai_error', 'safety', 'alert', 'handoff_wait', 'escalation'];

/** Por dónde le llega un aviso de este tipo a una persona, según lo que eligió. */
export function alertChannels(prefs: AlertPrefs | null | undefined, kind: string | undefined) {
  const group = alertGroupOf(kind);
  const p: AlertChannelPrefs = (group && prefs?.[group]) || {};
  return {
    // Una emergencia o una falla siempre queda en el panel: es la única forma segura de que alguien la vea.
    panel: group === 'errors' || p.panel !== false,
    whatsapp: p.whatsapp !== false,
    email: p.email ?? EMAIL_KINDS.includes(kind ?? ''),
  };
}

/** Lo que guarda el panel: solo grupos conocidos y solo sí/no. */
export function cleanAlertPrefs(raw: unknown): AlertPrefs {
  const out: AlertPrefs = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const g of ALERT_GROUPS) {
    const v = (raw as Record<string, unknown>)[g.key];
    if (!v || typeof v !== 'object') continue;
    const c: AlertChannelPrefs = {};
    for (const ch of ['panel', 'whatsapp', 'email'] as const) {
      const b = (v as Record<string, unknown>)[ch];
      if (typeof b === 'boolean') c[ch] = b;
    }
    if (g.key === 'errors') delete c.panel;
    if (Object.keys(c).length) out[g.key] = c;
  }
  return out;
}
