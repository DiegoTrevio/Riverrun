/**
 * La página que la persona tiene abierta en el panel: así «este contacto» o «este flujo» se entiende sin decir cuál.
 * El panel solo manda la ruta (`#/contact/…`); el nombre del registro lo busca el servidor con los permisos de quien
 * pregunta (no se confía en un título que mande el navegador).
 */
import type { Caller } from './executor.js';
import { path } from './executor.js';
import type { Page } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v?: string | null) => (v && UUID.test(v) ? v : undefined);

/** Ruta del panel → qué es y de qué área (espejo de las rutas de public/js/main.js). */
export function parsePage(raw: string | undefined | null): Page {
  const hash = String(raw ?? '').replace(/^#/, '').slice(0, 300);
  const [pathPart, query = ''] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  const page = (p: Omit<Page, 'hash'>): Page => ({ hash: `#${hash || '/'}`, ...p });
  switch (parts[0]) {
    case 'contact': return page({ kind: 'contact', id: id(parts[1]), area: 'contactos' });
    case 'contacts': return page({ kind: 'contacts', area: 'contactos' });
    case 'conversation': return page({ kind: 'conversation', id: id(parts[1]), area: 'conversaciones' });
    case 'conversations': return page({ kind: 'conversations', area: 'conversaciones' });
    case 'bot': return page({ kind: 'bot', id: id(parts[1]), area: 'agente', label: parts[2] && /^[a-z]{1,20}$/.test(parts[2]) ? parts[2] : undefined });
    case 'automation':
      if (parts[1] === 'lienzo' && id(parts[2])) return page({ kind: 'board', id: id(parts[2]), area: 'automatizacion' });
      if (parts[1] === 'rules' && id(parts[2])) return page({ kind: 'rule', id: id(parts[2]), area: 'automatizacion' });
      if (parts[1] === 'sequences' && id(parts[2])) return page({ kind: 'sequence', id: id(parts[2]), area: 'automatizacion' });
      if (parts[1] === 'campaigns' && id(parts[2])) return page({ kind: 'campaign', id: id(parts[2]), area: 'automatizacion' });
      if (parts[1] === 'settings') return page({ kind: 'settings', area: 'cuenta' });
      return page({ kind: 'automation', area: 'automatizacion' });
    case 'pipeline': return page({ kind: 'pipeline', id: id(parts[1]), area: 'oportunidades' });
    case 'cotizaciones': return page({ kind: params.get('id') ? 'quote' : 'quotes', id: id(params.get('id')), area: 'cotizaciones' });
    case 'agenda': return page({ kind: 'agenda', area: 'agenda' });
    case 'cobros': return page({ kind: 'receivables', id: id(params.get('contact')), area: 'cobros' });
    case 'estadisticas': case 'consumo': return page({ kind: 'stats', area: 'datos' });
    case undefined: case 'agentes': case 'asistentes': return page({ kind: 'agents', area: 'agente' });
    default: return page({ kind: /^[a-z-]{1,30}$/.test(parts[0]) ? parts[0] : 'otra', area: 'cuenta' });
  }
}

const KIND_NAMES: Record<string, string> = {
  contact: 'Contacto', conversation: 'Conversación', bot: 'Agente', board: 'Flujo', rule: 'Regla', sequence: 'Secuencia',
  campaign: 'Campaña', pipeline: 'Oportunidades', quote: 'Cotización', receivables: 'Cobros de un cliente',
  contacts: 'Lista de contactos', conversations: 'Bandeja de conversaciones', agents: 'Agentes', agenda: 'Agenda',
  quotes: 'Cotizaciones', stats: 'Estadísticas', settings: 'Horario y avisos', automation: 'Automatización',
};

/** Nombre legible de la página («Contacto · Ana López»), buscado con los permisos de quien pregunta. */
export async function describePage(page: Page, call: Caller): Promise<Page & { contactId?: string }> {
  const kind = KIND_NAMES[page.kind ?? ''] ?? 'Página del panel';
  let name = '';
  let contactId: string | undefined;
  try {
    if (page.id) {
      if (page.kind === 'contact' || page.kind === 'receivables') {
        const p = await call.get(path`/api/contacts/${page.id}/profile`);
        name = p.contact?.name || p.contact?.push_name || p.contact?.phone || '';
        contactId = p.contact?.id;
      } else if (page.kind === 'conversation') {
        const c = await call.get(path`/api/conversations/${page.id}`);
        name = c.contact?.name || c.contact?.push_name || c.contact?.phone || '';
        contactId = c.contact?.id;
      } else if (page.kind === 'bot') name = (await call.get(path`/api/chatbots/${page.id}`))?.name ?? '';
      else if (page.kind === 'board') name = (await call.get(path`/api/flow-boards/${page.id}`))?.name ?? '';
      else if (page.kind === 'quote') name = (await call.get(path`/api/quotes/${page.id}`))?.folio ?? '';
      else if (page.kind === 'pipeline') name = ((await call.get('/api/pipelines')) as any[]).find((p) => p.id === page.id)?.name ?? '';
    }
  } catch {
    // Sin permiso o ya no existe: se describe solo el tipo de página.
    return { ...page, id: undefined, label: kind };
  }
  // El nombre de un cliente lo escribió él: va entre comillas, en una línea y dicho como tal.
  const shown = String(name).replace(/\s+/g, ' ').trim().slice(0, 80);
  const label = !shown ? kind : contactId ? `${kind} · «${shown}» (nombre escrito por el cliente)` : `${kind} · ${shown}`;
  return { ...page, label, ...(contactId ? { contactId } : {}) };
}
