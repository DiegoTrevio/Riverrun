import { logEvent } from '../logs.js';
import { getReceivable, latestConversationOf } from '../receivables/index.js';
import { liveUntilOf, windowOf } from './send-window.js';
import * as astore from './store.js';
import type { Job } from './store.js';
import { inSendWindow, sendableAt, spanishDate, spanishTime } from './time.js';
import type { SendWindow } from './types.js';

/*
 * Horario para mensajes programados, al momento de enviar: antes de correr una tarea que le escribe al cliente, si es
 * de noche (en la zona del negocio) espera a la hora de inicio en vez de correr. Así también respetan el horario los
 * reintentos, lo atrasado después de una caída y lo programado antes de cambiarlo. Esperar no ejecuta nada de la tarea
 * (ni aparta destinatarios ni avanza el flujo), así que no hay siete formas distintas de posponer.
 */

/** Tareas que le escriben al cliente por su cuenta. Las respuestas, confirmaciones y lo que envía el equipo no esperan. */
export const QUIET_HELD_TYPES = new Set(['sequence_step', 'campaign_send', 'automation_send', 'no_reply', 'receivable_reminder', 'receivable_overdue', 'appointment_reminder']);
/** Una tarea que debía salir en horario y corre apenas tarde (el planificador iba atrasado) sale igual. */
export const QUIET_GRACE_MS = 10 * 60_000;

/** null = que corra ya; Date = que espere hasta entonces; 'drop' = ya no sirve (el recordatorio llegaría después de la cita). */
export function quietDecision(o: { now: Date; runAt: Date; window: SendWindow; tz: string; liveUntil: Date | null; startsAt?: Date | null }): Date | 'drop' | null {
  if (inSendWindow(o.window, o.now, o.tz)) return null;
  // El cliente está conversando: lo que le toca sale normal.
  if (o.liveUntil && o.now.getTime() < o.liveUntil.getTime()) return null;
  if (inSendWindow(o.window, o.runAt, o.tz) && o.now.getTime() - o.runAt.getTime() < QUIET_GRACE_MS) return null;
  const at = sendableAt(o.window, o.now, o.tz);
  if (o.startsAt && at.getTime() >= o.startsAt.getTime()) return 'drop';
  return at;
}

interface Target { conversationId: string | null; enrollmentId?: string; paceMs?: number; startsAt?: Date }

/** A quién le escribe la tarea. null: no le toca esperar o ya no haría nada (que corra y termine sola). */
async function targetOf(job: Job): Promise<Target | null> {
  const p = job.payload as Record<string, any>;
  switch (job.type) {
    case 'automation_send': {
      const rule = await astore.getAutomation(p.automation_id);
      return rule?.active ? { conversationId: p.conversation_id } : null;
    }
    case 'no_reply': {
      const rule = await astore.getAutomation(p.automation_id);
      // Solo espera si en ese momento le escribe al cliente: avisar al equipo o poner etiquetas sigue de noche (y lo
      // que la regla manda con espera o un flujo que inicia esperan por su cuenta).
      if (!rule?.active || !rule.actions.some((a) => a.type === 'send_message' && !(a.delay_minutes > 0))) return null;
      const last = await astore.lastInbound(p.conversation_id);
      return last && last.id > Number(p.after_message_id) ? null : { conversationId: p.conversation_id };
    }
    case 'sequence_step': {
      // Lo pidió un botón (el cliente está ahí) o lo inició el equipo desde el panel: sale ya.
      if (p.tap || p.team) return null;
      const en = await astore.getEnrollment(p.enrollment_id);
      return en && en.status === 'active' && en.current_step === p.step ? { conversationId: en.conversation_id, enrollmentId: en.id } : null;
    }
    case 'campaign_send': {
      const c = await astore.getCampaign(p.campaign_id);
      return c?.status === 'sending' ? { conversationId: p.conversation_id, paceMs: Math.ceil(60_000 / Math.max(1, c.rate_per_minute)) } : null;
    }
    case 'appointment_reminder': {
      const a = await astore.getAppointment(p.appointment_id);
      if (!a || a.status !== 'confirmed' || (p.starts_at && new Date(a.starts_at).getTime() !== new Date(p.starts_at).getTime())) return null;
      return { conversationId: a.conversation_id, startsAt: new Date(a.starts_at) };
    }
    case 'receivable_reminder':
    case 'receivable_overdue': {
      const r = await getReceivable(p.receivable_id);
      if (!r || r.status !== 'pending') return null;
      return { conversationId: r.conversation_id ?? (r.contact_id ? await latestConversationOf(r.contact_id) : null) };
    }
  }
  return null;
}

/** Si es de noche, deja la tarea para la hora de inicio (o la cancela si ya no sirve). Devuelve si no debe correr ahora. */
export async function holdIfQuiet(job: Job, now = new Date()): Promise<boolean> {
  if (!QUIET_HELD_TYPES.has(job.type) || !job.account_id) return false;
  const settings = await astore.getSettings(job.account_id);
  const w = windowOf(settings);
  const tz = settings.timezone;
  if (inSendWindow(w, now, tz)) return false;
  const target = await targetOf(job);
  if (!target) return false;
  const ctx = target.conversationId ? await astore.sendContext(target.conversationId) : null;
  // El simulador del panel no es un cliente: no espera.
  if (ctx?.channel_type === 'playground') return false;
  const decision = quietDecision({ now, runAt: new Date(job.run_at), window: w, tz, liveUntil: liveUntilOf(ctx?.last_inbound_at ? { created_at: ctx.last_inbound_at } : null), startsAt: target.startsAt });
  if (decision === null) return false;
  if (decision === 'drop') {
    await astore.finishJob(job.id, 'cancelled', 'quiet_hours: llegaría después de la cita');
    await logEvent({ level: 'info', source: 'engine', message: 'Recordatorio de cita no enviado: caía de noche y a la hora de inicio la cita ya habría empezado', accountId: job.account_id, conversationId: target.conversationId ?? undefined });
    return true;
  }
  // Una campaña conserva su ritmo al abrir: cada envío toma el siguiente turno del número, no todos a la misma hora.
  const at = target.paceMs && ctx ? await astore.reservePacedSlot(ctx.channel_id, target.paceMs, decision) : decision;
  if (await astore.holdJob(job.id, at)) {
    if (target.enrollmentId) await astore.setEnrollmentNextRun(target.enrollmentId, at);
    if (job.type !== 'campaign_send' && target.conversationId) {
      await logEvent({ level: 'info', source: 'engine', message: `Mensaje programado en espera hasta el ${spanishDate(at, tz)} a las ${spanishTime(at, tz)} (horario para mensajes programados)`, accountId: job.account_id, conversationId: target.conversationId });
    }
  }
  return true;
}
