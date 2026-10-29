/**
 * Lo que el modelo ve de cada herramienta: corto (campos elegidos, textos y listas recortados) y con el texto escrito
 * por clientes separado bajo `datos_del_cliente`, que el prompt trata como dato y nunca como instrucción.
 */
import type { Link } from './store.js';

const MAX_TEXT = 300;
const MAX_ITEMS = 20;
export const MAX_RESULT = 3000;

/** Recorta textos largos y listas largas (con «y N más»), a cualquier profundidad. */
export function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => clip(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `… y ${value.length - MAX_ITEMS} más`] : items;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (depth > 6) return '…';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null && v !== '') out[k] = clip(v, depth + 1);
    return out;
  }
  return value;
}

/** El resultado como texto para el modelo, con un tope de caracteres. */
export function forModel(value: unknown, max = MAX_RESULT): string {
  const text = JSON.stringify(clip(value));
  return text.length > max ? `${text.slice(0, max)}… (recortado)` : text;
}

/** Elige campos de un objeto. */
export function pick<T extends Record<string, any>>(obj: T | null | undefined, keys: string[]): Record<string, unknown> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  return out;
}

/** Fecha y hora en la zona de la cuenta, legible («mar 4 nov, 17:00»). */
export function when(value: string | Date | null | undefined, timeZone: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-MX', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Solo una fecha («2026-11-04»). */
export function day(value: string | Date | null | undefined, timeZone: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone });
}

// --- Enlaces al panel: solo estas rutas -------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_TABS = new Set(['general', 'instrucciones', 'preguntas', 'activacion', 'avisos', 'cotizaciones', 'conocimiento', 'imagenes', 'conexiones', 'probar']);

export const links = {
  contact: (id: string, label = 'Ver contacto'): Link => ({ label, href: `#/contact/${id}` }),
  conversation: (id: string, label = 'Ver conversación'): Link => ({ label, href: `#/conversation/${id}` }),
  bot: (id: string, tab = 'general', label = 'Ver agente'): Link => ({ label, href: `#/bot/${id}/${BOT_TABS.has(tab) ? tab : 'general'}` }),
  board: (id: string, label = 'Ver flujo'): Link => ({ label, href: `#/automation/lienzo/${id}` }),
  rule: (id: string, label = 'Ver regla'): Link => ({ label, href: `#/automation/rules/${id}` }),
  sequence: (id: string, label = 'Ver secuencia'): Link => ({ label, href: `#/automation/sequences/${id}` }),
  campaign: (id: string, label = 'Ver campaña'): Link => ({ label, href: `#/automation/campaigns/${id}` }),
  settings: (label = 'Ver horario y avisos'): Link => ({ label, href: '#/automation/settings' }),
  pipeline: (id: string, label = 'Ver oportunidades'): Link => ({ label, href: `#/pipeline/${id}` }),
  quote: (id: string, label = 'Ver cotización'): Link => ({ label, href: `#/cotizaciones/historial?id=${id}` }),
  prices: (label = 'Ver lista de precios'): Link => ({ label, href: '#/cotizaciones/precios' }),
  agenda: (label = 'Ver agenda'): Link => ({ label, href: '#/agenda/citas' }),
  receivables: (contactId?: string, label = 'Ver cobros'): Link => ({ label, href: contactId ? `#/cobros?contact=${contactId}` : '#/cobros' }),
};

/** ¿Es un enlace que el panel puede abrir sin riesgo? (el panel vuelve a revisarlo antes de pintarlo) */
export function safeLink(href: string): boolean {
  if (!href.startsWith('#/') || href.length > 200) return false;
  const [path, query = ''] = href.slice(2).split('?');
  const parts = path.split('/');
  const known = new Set(['contact', 'conversation', 'bot', 'automation', 'pipeline', 'cotizaciones', 'agenda', 'cobros', 'contacts', 'conversations', 'consumo', 'plan', 'users', 'integraciones', 'agentes', 'ajustes', 'estadisticas', 'negocio', 'datos-clientes']);
  if (!known.has(parts[0])) return false;
  if (!parts.every((p) => /^[a-z0-9-]{0,60}$/i.test(p) || UUID.test(p))) return false;
  return /^([a-z_]+=[0-9a-z-]{1,60}(&[a-z_]+=[0-9a-z-]{1,60})*)?$/i.test(query);
}
