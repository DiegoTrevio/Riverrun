/**
 * Enviar una conversación a la app del cliente: el resumen, la conversación completa o ambos. Lo deciden las reglas
 * (por contexto: intención detectada, objetivo cumplido, transferencia, dato capturado…; o por marcas: etiquetas que pone
 * el equipo), una persona desde el panel, o la app misma pidiéndolo por la API. Sale como el evento `conversation.sent`
 * por los webhooks de la cuenta: firmado, con reintentos y en la bitácora de entregas.
 */
import { z } from 'zod';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { buildReport } from '../engine/report-format.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { contactPayload, dispatchEvent } from './webhooks.js';

/** summary: resumen y análisis · full: todos los mensajes · both: las dos cosas. */
export const ExportContentSchema = z.enum(['summary', 'full', 'both']);
export type ExportContent = z.infer<typeof ExportContentSchema>;
export const CONTENT_LABEL: Record<ExportContent, string> = { summary: 'resumen', full: 'conversación completa', both: 'resumen y conversación completa' };

/** Tope de mensajes por envío (los más recientes). Una conversación más larga se completa con la API de mensajes. */
export const MAX_TRANSCRIPT_MESSAGES = 1000;

const withSummary = (c: ExportContent) => c !== 'full';
const withTranscript = (c: ExportContent) => c !== 'summary';

/** Mismo formato que GET /api/v1/conversations/:id/messages, para que la app use un solo lector. */
const messageOut = (m: { id: string | number; created_at: Date; direction: string; sender: string; type: string; content: string }) =>
  ({ id: Number(m.id), at: m.created_at, direction: m.direction === 'in' ? 'inbound' : 'outbound', sender: m.sender, type: m.type, text: m.content });

/**
 * Arma lo que se envía. Con resumen, `refresh` lo actualiza antes (si ya está al día no llama a la IA; si falla, se
 * envía el último con un aviso: el envío nunca depende de que la IA responda). La transcripción solo
 * lleva mensajes entregados del cliente, el asistente y el equipo (no avisos internos del sistema).
 */
export async function conversationExport(conversationId: string, o: {
  content: ExportContent;
  refresh?: (conversationId: string) => Promise<unknown>;
  reason?: string;
  trigger?: Record<string, unknown> | null;
  maxMessages?: number;
}) {
  let warning = '';
  if (withSummary(o.content) && o.refresh) {
    try { await o.refresh(conversationId); }
    catch (e: any) { warning = `No se pudo actualizar el resumen (${String(e?.message ?? e).slice(0, 120)}); se envía el último disponible.`; }
  }
  const conv = await store.getConversation(conversationId);
  if (!conv) throw new HttpError(404, 'Conversación no encontrada');
  const [contact, channel] = await Promise.all([store.getContact(conv.contact_id), store.getChannel(conv.channel_id)]);

  const out: Record<string, unknown> = {
    content: o.content,
    reason: o.reason || null,
    trigger: o.trigger ?? null,
    // El mismo contacto que en los demás eventos.
    contact: contact && channel ? contactPayload(contact, channel) : null,
    conversation: {
      id: conv.id, status: conv.status, handoff_reason: conv.handoff_reason || null, assigned_user_id: conv.assigned_user_id ?? null,
      channel: channel && { id: channel.id, type: channel.type, name: channel.name },
      data: conv.data ?? {}, flow_step: conv.flow_step ?? 0, goal_completed_at: conv.goal_completed_at ?? null,
      created_at: (conv as { created_at?: Date }).created_at ?? null, last_message_at: conv.last_message_at, url: `${config.publicBaseUrl}/#/conversation/${conv.id}`,
    },
  };

  if (withSummary(o.content)) {
    const r = await buildReport(conversationId);
    if (!r.summary && !warning) warning = 'Todavía no hay resumen de esta conversación.';
    out.summary = { text: r.summary || null, analysis: r.analysis, generated_at: r.generated_at, stale: r.stale, warning: warning || null };
  }

  if (withTranscript(o.content)) {
    const max = Math.max(1, o.maxMessages ?? MAX_TRANSCRIPT_MESSAGES);
    const filter = `conversation_id = $1 AND status = 'ok' AND sender <> 'system'`;
    const [rows, total] = await Promise.all([
      query<any>(`SELECT id, created_at, direction, sender, type, content FROM messages WHERE ${filter} ORDER BY id DESC LIMIT ${max}`, [conversationId]),
      queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE ${filter}`, [conversationId]),
    ]);
    const messages = rows.reverse().map(messageOut);
    const n = total?.n ?? messages.length;
    out.transcript = {
      messages,
      total: n,
      included: messages.length,
      // Si no cupo todo, van los más recientes; los anteriores se piden a la API desde el primero.
      truncated: n > messages.length,
      more: n > messages.length ? `/api/v1/conversations/${conv.id}/messages?after=0` : null,
    };
  }
  return out;
}

/**
 * Envía la conversación a la app (los webhooks activos que reciben `conversation.sent`, o solo `endpointId`).
 * Devuelve a cuántos destinos se programó la entrega (0 = no hay una app conectada).
 */
export async function sendConversation(accountId: string, conversationId: string, o: {
  content: ExportContent;
  endpointId?: string;
  refresh?: (conversationId: string) => Promise<unknown>;
  reason: string;
  trigger?: Record<string, unknown> | null;
}) {
  const data = await conversationExport(conversationId, o);
  const sent = await dispatchEvent(accountId, 'conversation.sent', data, { endpointId: o.endpointId || undefined });
  await logEvent({
    level: sent ? 'info' : 'warn', source: 'admin',
    message: sent
      ? `Conversación enviada a tu app (${CONTENT_LABEL[o.content]}) — ${o.reason}`
      : `No se envió la conversación (${o.reason}): no hay una app conectada que reciba conversaciones (Ajustes → Integraciones)`,
    accountId, conversationId,
  });
  return sent;
}

/** Apps conectadas que reciben conversaciones (para elegir destino en el panel; sin la URL completa, que puede llevar un token). */
export async function appDestinations(accountId: string) {
  const rows = await query<{ id: string; url: string; description: string; events: string[] }>(
    `SELECT id, url, description, events FROM webhook_endpoints WHERE account_id = $1 AND active ORDER BY created_at`,
    [accountId],
  );
  return rows.map((r) => {
    let host = r.url;
    try { host = new URL(r.url).host; } catch { /* se muestra tal cual */ }
    return { id: r.id, label: r.description || host, host, receives_conversations: r.events.includes('*') || r.events.includes('conversation.sent') };
  });
}
