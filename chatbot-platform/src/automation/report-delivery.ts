/**
 * Reporte de una conversación: se arma con lo ya guardado (resumen, análisis, datos y estadísticas), se puede consultar,
 * descargar y enviar al equipo (panel, correo y WhatsApp) o a una dirección externa. Si la IA no responde, se envía el
 * último resumen disponible avisando que puede estar desactualizado: el reporte nunca depende de que la IA funcione.
 */
import { z } from 'zod';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { AnalysisSchema, type Analysis } from '../engine/report.js';
import { logEvent } from '../logs.js';
import { mailEnabled, sendMail } from '../mailer.js';
import { mailBrand } from '../brands.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import { notifyUsers, teamMembers } from './store.js';

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

export const ReportSendSchema = z.object({
  user_ids: z.array(z.string().uuid()).max(20).default([]),
  /** Correos fuera del equipo (solo administradores). */
  emails: z.array(z.string().trim().toLowerCase().email().max(200)).max(5).default([]),
  /** WhatsApp fuera del equipo (solo administradores). */
  phones: z.array(z.string().trim().max(30)).max(5).default([]),
  note: z.string().trim().max(500).default(''),
  include_transcript: z.boolean().default(false),
  /** Actualizar el resumen antes de enviar (si falla, se envía el último). */
  refresh: z.boolean().default(true),
});

export interface Delivery { via: 'panel' | 'correo' | 'whatsapp'; to: string; ok: boolean; detail?: string }

/**
 * Arma y envía el reporte. `recipients` ya viene validado (personas de la cuenta); los envíos externos solo llegan aquí
 * si quien lo pidió es administrador (o si lo configuró una regla). Devuelve qué se entregó y qué no, sin lanzar por un
 * canal que falle: los demás se entregan.
 */
export async function deliverReport(chat: ChatService, conversationId: string, o: {
  users: { id: string; name: string; email: string; phone: string; notify_whatsapp: boolean }[];
  emails: string[];
  phones: string[];
  note?: string;
  includeTranscript?: boolean;
  refresh?: boolean;
  by?: string;
}) {
  const conv = await store.getConversation(conversationId);
  if (!conv) throw new HttpError(404, 'Conversación no encontrada');
  let warning = '';
  if (o.refresh !== false) {
    try { await chat.summarize(conversationId); }
    catch (e: any) { warning = `No se pudo actualizar el resumen (${String(e?.message ?? e).slice(0, 120)}); se envía el último disponible.`; }
  }
  const report = await buildReport(conversationId);
  if (report.stale && !warning && report.summary) warning = 'Hay mensajes posteriores al resumen; puede estar desactualizado.';
  if (!report.summary && !warning) warning = 'Todavía no hay resumen: se envía la información disponible.';
  const transcript = o.includeTranscript || !report.summary ? await transcriptTail(conversationId, o.includeTranscript ? 40 : 10) : '';
  const text = renderReport(report, { note: o.note, transcript, warning });
  const deliveries: Delivery[] = [];
  const accountId = conv.account_id;

  // 1) Panel: una notificación breve para cada persona del equipo.
  if (o.users.length) {
    const brief = `${report.summary ? report.summary.slice(0, 500) : 'Sin resumen todavía.'}${report.analysis.next_steps.length ? `\nPendiente: ${report.analysis.next_steps[0]}` : ''}`;
    try {
      await notifyUsers(accountId, o.users.map((u) => u.id), { title: `📋 Reporte: ${report.customer.name}`, body: brief, link: `#/conversation/${conversationId}`, kind: 'report' });
      for (const u of o.users) deliveries.push({ via: 'panel', to: u.name || u.email, ok: true });
    } catch (e: any) {
      for (const u of o.users) deliveries.push({ via: 'panel', to: u.name || u.email, ok: false, detail: String(e?.message ?? e).slice(0, 120) });
    }
  }
  // 2) Correo: equipo y direcciones externas. Sin SMTP configurado no se envía nada: se dice claramente.
  const mb = await mailBrand(accountId);
  const emails = [...new Set([...o.users.map((u) => u.email), ...o.emails])];
  for (const to of emails) {
    if (!mailEnabled()) { deliveries.push({ via: 'correo', to, ok: false, detail: 'El servidor no tiene correo configurado (SMTP_URL)' }); continue; }
    const sent = await sendMail({ to, subject: `Reporte de conversación: ${report.customer.name}`, text, fromName: mb.fromName });
    deliveries.push({ via: 'correo', to, ok: sent, detail: sent ? undefined : 'No se pudo enviar (ver Registros)' });
  }
  // 3) WhatsApp: quien lo tiene activado en su perfil y los números externos.
  const phones = new Map<string, string>();
  for (const u of o.users) if (u.notify_whatsapp && u.phone) phones.set(u.phone, u.name || u.email);
  for (const p of o.phones) { const d = p.replace(/\D/g, ''); if (d.length >= 8 && d.length <= 15) phones.set(d, `+${d}`); }
  for (const [phone, label] of phones) {
    try {
      await chat.sendInternalWhatsapp(accountId, phone, text.slice(0, 3800));
      deliveries.push({ via: 'whatsapp', to: label, ok: true });
    } catch (e: any) {
      deliveries.push({ via: 'whatsapp', to: label, ok: false, detail: String(e?.message ?? e).slice(0, 120) });
    }
  }
  const failed = deliveries.filter((d) => !d.ok);
  await logEvent({
    level: failed.length ? 'warn' : 'info', source: 'admin',
    message: `Reporte de conversación enviado${o.by ? ` por ${o.by}` : ''}: ${deliveries.length - failed.length} entregas${failed.length ? `, ${failed.length} fallidas` : ''}`,
    accountId, conversationId, details: { deliveries },
  });
  return { ok: failed.length < deliveries.length, deliveries, warning: warning || null, stale: report.stale };
}

/** Personas del equipo (activas) por ids o por rol. */
export async function reportRecipients(accountId: string, o: { userIds?: string[]; roles?: ('admin' | 'agent')[] }) {
  const team = await teamMembers(accountId, o.roles?.length ? o.roles : ['admin', 'agent']);
  return o.userIds?.length ? team.filter((u) => o.userIds!.includes(u.id)) : o.roles?.length ? team : [];
}
