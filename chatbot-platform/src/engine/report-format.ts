/**
 * Reporte de una conversación en forma de datos y de texto: sirve igual para consultarlo, descargarlo, enviarlo por
 * correo/WhatsApp y para los avisos al equipo (objetivo cumplido, transferencia). Solo lee lo ya guardado.
 */
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import * as store from '../store/index.js';
import { AnalysisSchema, type Analysis } from './report.js';

export interface ReportView {
  conversation_id: string;
  customer: { name: string; phone: string; tags: string[] };
  channel: { name: string; type: string };
  assistant: string | null;
  status: string;
  handoff_reason: string;
  assignee: string | null;
  messages: number;
  first_at: Date | null;
  last_at: Date | null;
  summary: string;
  analysis: Analysis;
  data: Record<string, string>;
  notes: string[];
  generated_at: Date | null;
  /** Hay mensajes (o cambios de datos) posteriores al resumen. */
  stale: boolean;
  url: string;
}

const STATUS = { bot: 'atendida por el asistente', human: 'con una persona', closed: 'cerrada' } as const;
const SENTIMENT = { positivo: 'positivo', neutral: 'neutral', negativo: 'negativo' } as const;
const INTEREST = { alto: 'alto', medio: 'medio', bajo: 'bajo', sin_dato: 'sin dato' } as const;

export async function buildReport(conversationId: string): Promise<ReportView> {
  const conv = await store.getConversation(conversationId);
  if (!conv) throw new HttpError(404, 'Conversación no encontrada');
  const [contact, channel, bot, assignee, stats, latestOk] = await Promise.all([
    store.getContact(conv.contact_id),
    store.getChannel(conv.channel_id),
    conv.chatbot_id ? store.getChatbot(conv.chatbot_id) : null,
    conv.assigned_user_id ? store.getUserBasic(conv.assigned_user_id) : null,
    queryOne<{ n: number; first: Date | null; last: Date | null }>(`SELECT count(*)::int AS n, min(created_at) AS first, max(created_at) AS last FROM messages WHERE conversation_id = $1`, [conversationId]),
    queryOne<{ id: number }>(`SELECT COALESCE(max(id), 0) AS id FROM messages WHERE conversation_id = $1 AND status = 'ok'`, [conversationId]),
  ]);
  const analysis = AnalysisSchema.catch(AnalysisSchema.parse({})).parse(conv.report_analysis ?? {});
  return {
    conversation_id: conv.id,
    customer: { name: contact?.name || contact?.push_name || 'Cliente', phone: contact?.phone ?? '', tags: contact?.tags ?? [] },
    channel: { name: channel?.name ?? '', type: channel?.type ?? '' },
    assistant: bot?.name ?? null,
    status: conv.status,
    handoff_reason: conv.handoff_reason,
    assignee: assignee ? assignee.name || assignee.email : null,
    messages: stats?.n ?? 0,
    first_at: stats?.first ?? null,
    last_at: stats?.last ?? null,
    summary: conv.report_summary,
    analysis,
    data: conv.data ?? {},
    notes: contact?.notes ?? [],
    generated_at: conv.report_at ?? null,
    stale: !conv.report_summary || conv.report_until_id < (latestOk?.id ?? 0) || conv.report_data_version !== conv.data_version,
    url: `${config.publicBaseUrl}/#/conversation/${conv.id}`,
  };
}

const when = (d: Date | null) => (d ? new Date(d).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Mexico_City' }) : '—');

/** Últimos mensajes (acotados) para adjuntar al reporte si se pide. */
export async function transcriptTail(conversationId: string, limit = 40, maxChars = 6000): Promise<string> {
  const rows = await query<{ created_at: Date; direction: string; sender: string; content: string; type: string }>(
    `SELECT created_at, direction, sender, content, type FROM messages WHERE conversation_id = $1 AND status = 'ok' ORDER BY id DESC LIMIT $2`,
    [conversationId, limit],
  );
  const lines = rows.reverse().map((m) => `[${when(m.created_at)}] ${m.direction === 'in' ? 'Cliente' : m.sender === 'human' ? 'Equipo' : 'Asistente'}: ${(m.content || `(${m.type})`).replace(/\s+/g, ' ').slice(0, 400)}`);
  let out = '';
  for (const l of lines.reverse()) { if (out.length + l.length > maxChars) break; out = `${l}\n${out}`; }
  return out.trim();
}

/** Texto plano del reporte (sirve igual para correo, WhatsApp y descarga). */
export function renderReport(r: ReportView, o: { note?: string; transcript?: string; warning?: string } = {}): string {
  const dataLines = Object.entries(r.data).map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${v}`);
  const a = r.analysis;
  return [
    '📋 REPORTE DE CONVERSACIÓN',
    `Cliente: ${r.customer.name}${r.customer.phone ? ` (+${r.customer.phone})` : ''}${r.customer.tags.length ? ` · ${r.customer.tags.join(', ')}` : ''}`,
    `Canal: ${r.channel.name}${r.assistant ? ` · Asistente: ${r.assistant}` : ''}`,
    `Estado: ${STATUS[r.status as keyof typeof STATUS] ?? r.status}${r.handoff_reason && r.status === 'human' ? ` (${r.handoff_reason})` : ''}${r.assignee ? ` · Atiende: ${r.assignee}` : ''}`,
    `Actividad: ${r.messages} mensajes · del ${when(r.first_at)} al ${when(r.last_at)}`,
    o.note ? `\nNota: ${o.note}` : '',
    o.warning ? `\n⚠️ ${o.warning}` : '',
    `\nRESUMEN${r.generated_at ? ` (generado ${when(r.generated_at)})` : ''}\n${r.summary || 'Aún no hay resumen de esta conversación.'}`,
    a.intent ? `\nQué busca: ${a.intent}` : '',
    r.summary ? `Ánimo: ${SENTIMENT[a.sentiment]} · Interés: ${INTEREST[a.interest]}` : '',
    dataLines.length ? `\nDATOS CONFIRMADOS\n${dataLines.join('\n')}` : '',
    r.notes.length ? `\nNOTAS\n${r.notes.map((n) => `• ${n}`).join('\n')}` : '',
    a.agreements.length ? `\nACUERDOS\n${a.agreements.map((x) => `• ${x}`).join('\n')}` : '',
    a.next_steps.length ? `\nPENDIENTES\n${a.next_steps.map((x) => `• ${x}`).join('\n')}` : '',
    o.transcript ? `\nÚLTIMOS MENSAJES\n${o.transcript}` : '',
    `\nAbrir la conversación: ${r.url}`,
  ].filter((x) => x !== '').join('\n');
}


const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text);

/**
 * Versión corta para avisos al equipo (panel y WhatsApp): quién es, resumen, datos confirmados y pendientes.
 * Si todavía no hay resumen (la IA falló o no ha corrido), se anexan los últimos mensajes para que el aviso sirva igual.
 */
export async function briefReport(conversationId: string, max = 1500, o: { customer?: boolean } = {}): Promise<string> {
  const r = await buildReport(conversationId);
  const a = r.analysis;
  const data = Object.entries(r.data).map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${v}`);
  const parts = [
    o.customer === false ? '' : `Cliente: ${r.customer.name}${r.customer.phone ? ` (+${r.customer.phone})` : ''}`,
    r.summary ? clip(r.summary, 600) : '',
    !r.summary ? await transcriptTail(conversationId, 4, 500) : '',
    a.intent ? `Qué busca: ${a.intent}` : '',
    data.length ? `Datos:\n${data.join('\n')}` : '',
    a.agreements.length ? `Acuerdos: ${a.agreements.join('; ')}` : '',
    a.next_steps.length ? `Pendiente: ${a.next_steps.join('; ')}` : '',
  ].filter(Boolean);
  return clip(parts.join('\n'), max);
}
