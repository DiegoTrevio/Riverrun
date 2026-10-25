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
  /** Variables propias del contexto (p. ej. las de un cobro: pago.monto, pago.vencimiento…). */
  vars?: Record<string, string>;
  now?: Date;
}

/**
 * Sustituye variables {{...}}. Las desconocidas quedan vacías (nunca se envía "{{algo}}" al cliente).
 * Variables: nombre, cliente, telefono, negocio, canal, mensaje, link, fecha_hoy, dato.CAMPO, campo.CAMPO,
 * cita.servicio, cita.fecha, cita.hora, cita.lugar, cita.tipo. Las que consultan la base (campo.* con su formato, asesor,
 * saldo, pagos_pendientes, proxima_cita.*) y las del evento (pago.*, cotizacion.*) llegan en `vars` (template-vars.ts).
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
    'cita.persona': a?.assigned_user_name ?? '',
    'cita.enlace': a?.meeting_url ?? '',
    fecha_hoy: spanishDate(ctx.now ?? new Date(), ctx.timezone),
    ...ctx.vars,
  };
  return template
    .replace(/\{\{\s*([a-z_]+(?:\.[a-z0-9_]+)?)\s*\}\}/gi, (_m, key: string) => {
      const k = key.toLowerCase();
      // Object.hasOwn: {{constructor}} no debe leer el prototipo del objeto.
      if (Object.hasOwn(vars, k)) return vars[k];
      // campo.CLAVE es dato.CLAVE con el formato de su tipo (una fecha en palabras), si se precargó en `vars`.
      const field = k.startsWith('dato.') || k.startsWith('campo.') ? k.slice(k.indexOf('.') + 1) : '';
      return field && c?.data && Object.hasOwn(c.data, field) ? c.data[field] : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1')
    .replace(/(^|[¡¿])\s*,\s*/g, '$1')
    .trim();
}
