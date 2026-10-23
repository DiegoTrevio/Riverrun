import { briefReport } from '../engine/report-format.js';
import * as store from '../store/index.js';

/**
 * Formato común de los avisos de una conversación: quién es el cliente (nombre y teléfono), por qué canal escribió, el
 * motivo y un resumen breve. Quien recibe el aviso sabe de qué va sin abrir la conversación; el enlace lo agrega alertTeam.
 */
export function conversationAlert(o: {
  contact: { name?: string | null; push_name?: string | null; phone?: string | null } | null | undefined;
  channel?: string | null;
  reason?: string | null;
  brief?: string | null;
  extra?: string | null;
}) {
  const c = o.contact;
  const name = c?.name || c?.push_name || '';
  const phone = c?.phone ? `+${c.phone.replace(/^\+/, '')}` : '';
  const who = [name || (phone ? '' : 'Cliente'), phone].filter(Boolean).join(' · ');
  const lines = [`Cliente: ${who}`];
  if (o.channel) lines.push(`Canal: ${o.channel}`);
  if (o.reason) lines.push(`Motivo: ${o.reason}`);
  if (o.extra) lines.push(o.extra);
  return `${lines.join('\n')}${o.brief ? `\n\n${o.brief}` : ''}`;
}

/** El mismo formato a partir de la conversación (para avisos que no tienen el contacto a la mano). */
export async function describeConversation(conversationId: string, reason: string, o: { brief?: boolean } = {}) {
  const conv = await store.getConversation(conversationId);
  if (!conv) return reason;
  const [contact, channel, brief] = await Promise.all([
    store.getContact(conv.contact_id),
    store.getChannel(conv.channel_id),
    o.brief ? briefReport(conversationId, 1200, { customer: false }).catch(() => '') : Promise.resolve(''),
  ]);
  return conversationAlert({ contact, channel: channel?.name, reason, brief });
}
