import { config } from '../config.js';
import type { Contact, Conversation } from '../types.js';
import { spanishDate, spanishTime } from './time.js';
import type { Appointment } from './types.js';

export interface TemplateContext {
  contact?: Pick<Contact, 'name' | 'push_name' | 'phone' | 'data'> | null;
  conversation?: Pick<Conversation, 'id'> | null;
  businessName?: string;
  channelName?: string;
  message?: string;
  appointment?: Appointment | null;
  location?: string;
  timezone: string;
}

/**
 * Sustituye variables {{...}}. Las desconocidas quedan vacías (nunca se envía "{{algo}}" al cliente).
 * Variables: nombre, cliente, telefono, negocio, canal, mensaje, link, dato.CAMPO,
 * cita.servicio, cita.fecha, cita.hora, cita.lugar, cita.tipo
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const c = ctx.contact;
  const a = ctx.appointment;
  const firstName = (c?.name || c?.push_name || '').trim().split(/\s+/)[0] ?? '';
  const vars: Record<string, string> = {
    nombre: firstName,
    nombre_completo: (c?.name || c?.push_name || '').trim(),
    // Para alertas internas: nunca queda vacío.
    cliente: (c?.name || c?.push_name || '').trim() || (c?.phone ? `+${c.phone}` : 'Un cliente'),
    telefono: c?.phone ? `+${c.phone}` : '',
    negocio: ctx.businessName ?? '',
    canal: ctx.channelName ?? '',
    mensaje: (ctx.message ?? '').slice(0, 500),
    link: ctx.conversation ? `${config.publicBaseUrl}/#/conversation/${ctx.conversation.id}` : '',
    'cita.servicio': a?.service_name ?? '',
    'cita.fecha': a ? spanishDate(new Date(a.starts_at), ctx.timezone) : '',
    'cita.hora': a ? spanishTime(new Date(a.starts_at), ctx.timezone) : '',
    'cita.lugar': ctx.location ?? '',
    'cita.tipo': a ? (a.kind === 'call' ? 'llamada' : 'cita') : '',
  };
  return template
    .replace(/\{\{\s*([a-z_]+(?:\.[a-z0-9_]+)?)\s*\}\}/gi, (_m, key: string) => {
      const k = key.toLowerCase();
      if (k.startsWith('dato.')) return c?.data?.[k.slice(5)] ?? '';
      return vars[k] ?? '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1')
    .replace(/(^|[¡¿])\s*,\s*/g, '$1')
    .trim();
}
