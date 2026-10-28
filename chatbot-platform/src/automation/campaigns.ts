import { messageQuota } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as astore from './store.js';
import { query, queryOne, withTransaction } from '../db.js';
import { addDays, localParts, zonedToUtc } from './time.js';
import { sendTime } from './send-window.js';
import type { AccountSettings } from './types.js';
import type { OutboundResult } from './outbound.js';
import { OwnershipLost } from '../engine/coordination.js';

/** Campañas: envío programado a un segmento, espaciado para no parecer spam (y no arriesgar el número). */
export class Campaigns {
  constructor(private chat: ChatService) {}

  /** Programa (o inicia ya) una campaña. */
  async launch(campaignId: string) {
    const c = await astore.getCampaign(campaignId);
    if (!c) throw new Error('Campaña no encontrada');
    if (!['draft', 'scheduled'].includes(c.status)) throw new Error('La campaña ya se envió o se canceló');
    if (c.kind === 'sequence') {
      const seq = c.sequence_id ? await astore.getSequence(c.sequence_id) : null;
      if (!seq || seq.account_id !== c.account_id) throw new Error('El flujo de la campaña ya no existe');
      if (!seq.active) throw new Error(`El flujo "${seq.name}" está desactivado: actívalo antes de enviarlo`);
    } else if (!c.message.trim() && !c.image_id) throw new Error('La campaña no tiene mensaje');
    if (c.scheduled_at && new Date(c.scheduled_at).getTime() > Date.now() + 30_000) {
      await astore.setCampaignStatus(c.id, 'scheduled');
      await astore.scheduleJob({ account_id: c.account_id, type: 'campaign_start', payload: { campaign_id: c.id }, run_at: new Date(c.scheduled_at), dedupe_key: `campaign:${c.id}` });
      return { status: 'scheduled' as const };
    }
    return this.start(c.id);
  }

  /** Arma la lista de destinatarios y programa cada envío a ritmo constante. */
  async start(campaignId: string) {
    const c = await astore.getCampaign(campaignId);
    if (!c || !['draft', 'scheduled'].includes(c.status)) return { status: c?.status ?? 'cancelled' };
    // Se reclama de forma atómica: dos clics (o un reintento) no programan dos veces cada mensaje.
    const claimed = await queryOne<{ id: string }>(`UPDATE campaigns SET status = 'sending' WHERE id = $1 AND status IN ('draft', 'scheduled') RETURNING id`, [c.id]);
    if (!claimed) return { status: 'sending' };
    try {
      return await this.startClaimed(c);
    } catch (e) {
      await astore.setCampaignStatus(c.id, 'draft');
      throw e;
    }
  }

  private async startClaimed(c: NonNullable<Awaited<ReturnType<typeof astore.getCampaign>>>) {
    const settingsNow = await astore.getSettings(c.account_id);
    const audience = await astore.campaignAudience(c, 100000, { requireConsent: settingsNow.consent.require_for_campaigns });
    const quota = await messageQuota(c.account_id);
    // Un flujo son tantos mensajes por persona como pasos tiene.
    const perPerson = c.kind === 'sequence' && c.sequence_id ? ((await astore.getSequence(c.sequence_id))?.steps.length ?? 1) : 1;
    if (quota.remaining !== null && audience.length * perPerson > quota.remaining) {
      await astore.setCampaignStatus(c.id, 'draft');
      throw new Error(`Tu plan permite ${quota.remaining.toLocaleString('es-MX')} mensajes más este mes y esta campaña son ${(audience.length * perPerson).toLocaleString('es-MX')} (${audience.length.toLocaleString('es-MX')} destinatarios${perPerson > 1 ? ` × ${perPerson} mensajes del flujo` : ''}). Reduce el segmento o cambia de plan.`);
    }
    await astore.setCampaignStatus(c.id, 'sending');
    const gapMs = Math.ceil(60_000 / Math.max(1, c.rate_per_minute));
    const settings = await astore.getSettings(c.account_id);
    const tz = settings.timezone;
    const cap = settings.sending.daily_cap_per_number;
    // Cada número lleva su propio ritmo (con varios números la campaña termina antes sin acelerar ninguno) y, si hay tope
    // diario, lo que no cabe hoy pasa al día siguiente. Los ya enviados hoy por otras campañas cuentan para el tope, y
    // cada persona de un flujo cuenta como todos sus mensajes (con un tope de 100 y un flujo de 4, 25 personas por día).
    const used = new Map<string, number>();
    if (cap) {
      const midnight = zonedToUtc(localParts(new Date(), tz).date, '00:00', tz);
      for (const r of await astore.campaignSentSince(c.account_id, midnight)) used.set(`${r.channel_id}|${localParts(new Date(), tz).date}`, r.n);
    }
    const plan = planSends(audience, { now: new Date(), gapMs, cap, perPerson, used, settings, businessOnly: c.business_hours_only });
    // Destinatarios y envíos en lotes y en una sola transacción: o queda toda la campaña programada o nada (y vuelve a
    // borrador). Cada envío lleva su llave: un reintento no programa dos veces a la misma persona.
    await withTransaction(async (db) => {
      for (let i = 0; i < plan.length; i += 1000) {
        const part = plan.slice(i, i + 1000);
        const convs = part.map((p) => p.conversation_id);
        await db.query(`INSERT INTO campaign_recipients (campaign_id, conversation_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [c.id, convs]);
        await db.query(
          `INSERT INTO jobs (account_id, type, payload, run_at, dedupe_key)
           SELECT $1, 'campaign_send', jsonb_build_object('campaign_id', $2::text, 'conversation_id', conv), at, 'campaign_send:' || $2 || ':' || conv
           FROM unnest($3::text[], $4::timestamptz[]) AS t(conv, at)
           ON CONFLICT (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL
           DO UPDATE SET run_at = EXCLUDED.run_at, payload = EXCLUDED.payload`,
          [c.account_id, c.id, convs, part.map((p) => p.at)],
        );
      }
    });
    await astore.campaignStats(c.id);
    if (!audience.length) await astore.setCampaignStatus(c.id, 'sent');
    await logEvent({ level: 'info', source: 'engine', message: `Campaña "${c.name}" iniciada: ${audience.length} destinatarios`, accountId: c.account_id, channelId: c.channel_id });
    return { status: audience.length ? ('sending' as const) : ('sent' as const), recipients: audience.length };
  }

  async sendOne(payload: { campaign_id: string; conversation_id: string }) {
    const c = await astore.getCampaign(payload.campaign_id);
    if (!c || c.status !== 'sending') return;
    // Un destinatario se envía una sola vez aunque haya tareas duplicadas.
    const mine = await queryOne(`UPDATE campaign_recipients SET reason = 'enviando' WHERE campaign_id = $1 AND conversation_id = $2 AND status = 'pending' AND reason = '' RETURNING 1`, [c.id, payload.conversation_id]);
    if (!mine) return;
    const r = c.kind === 'sequence' ? await this.startFlow(c, payload.conversation_id) : await this.chat.outbound.send(payload.conversation_id, {
      text: c.message,
      imageId: c.image_id ?? undefined,
      source: 'campaign',
      // Una promoción no interrumpe una conversación que está atendiendo una persona.
      meta: { campaign_id: c.id },
      flowStep: c.flow_step,
      waTemplate: c.wa_template,
    });
    await query(
      `UPDATE campaign_recipients SET status = $3, reason = $4, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END
       WHERE campaign_id = $1 AND conversation_id = $2`,
      [c.id, payload.conversation_id, r.sent ? 'sent' : 'skipped', r.sent ? '' : r.reason],
    );
    // Se suma este envío a las estadísticas sin recontar toda la campaña. El contador puede quedar alto (un destinatario
    // que se borró, un proceso que se cayó entre los dos pasos): lo que decide si terminó es que no quede nadie pendiente.
    const pending = await astore.bumpCampaignStats(c.id, r.sent ? 'sent' : 'skipped');
    const done = pending === 0 || !(await queryOne(`SELECT 1 FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`, [c.id]));
    const stats = done ? await astore.campaignStats(c.id) : null;
    if (stats && !stats.pending) {
      await astore.setCampaignStatus(c.id, 'sent');
      await logEvent({ level: 'info', source: 'engine', message: `Campaña "${c.name}" terminada: ${stats.sent} enviados, ${stats.skipped} omitidos`, accountId: c.account_id });
    }
  }

  /**
   * Flujo enviado a un grupo: la persona entra al flujo y su primer paso sale ya; los siguientes, a su hora y espaciados
   * por número al ritmo de la campaña.
   */
  private async startFlow(c: NonNullable<Awaited<ReturnType<typeof astore.getCampaign>>>, conversationId: string): Promise<OutboundResult> {
    if (!c.sequence_id) return { sent: false, reason: 'el flujo de la campaña ya no existe' };
    let r: OutboundResult;
    try {
      const e = await this.chat.automator.enroll(c.sequence_id, conversationId, `campaña "${c.name}"`, { campaignId: c.id, paceMs: Math.ceil(60_000 / Math.max(1, c.rate_per_minute)), now: true });
      if (!e) return { sent: false, reason: 'ya estaba en este flujo' };
      r = 'result' in e ? e.result : { sent: true };
    } catch (err: any) {
      if (err instanceof OwnershipLost) throw err;
      r = { sent: false, reason: err?.message ?? String(err) };
    }
    // Si su primer mensaje no salió, la persona queda fuera del flujo (no lo recibe más tarde sin que conste).
    if (!r.sent) await query(`UPDATE sequence_enrollments SET status = 'stopped', stop_reason = $3, finished_at = now() WHERE campaign_id = $1 AND conversation_id = $2 AND status = 'active'`, [c.id, conversationId, r.reason.slice(0, 300)]);
    return r;
  }

  async cancel(campaignId: string) {
    const c = await astore.getCampaign(campaignId);
    if (!c || (['sent', 'cancelled'].includes(c.status) && c.kind !== 'sequence')) return;
    // Un flujo enviado a un grupo se detiene para todos, aunque la campaña ya haya terminado de inscribir.
    const flows = await query<{ id: string }>(`UPDATE sequence_enrollments SET status = 'stopped', stop_reason = 'campaña cancelada', finished_at = now() WHERE campaign_id = $1 AND status = 'active' RETURNING id`, [c.id]);
    for (const e of flows) await astore.cancelJobs('enrollment_id', e.id);
    // Una campaña de flujo ya enviada sigue como enviada: solo se detienen sus flujos.
    if (c.status === 'cancelled' || c.status === 'sent') return;
    await astore.setCampaignStatus(c.id, 'cancelled');
    await astore.cancelJobs('campaign_id', c.id);
    await query(`UPDATE campaign_recipients SET status = 'skipped', reason = 'campaña cancelada' WHERE campaign_id = $1 AND status = 'pending'`, [c.id]);
    await astore.campaignStats(c.id);
  }
}

/**
 * Hora de envío de cada destinatario: cada número lleva su propio ritmo (`gapMs`), en horario del negocio si se pide
 * y siempre dentro del horario para mensajes programados (lo que cae de noche sigue a la hora de inicio, con el mismo
 * ritmo). Con tope diario, lo que no cabe en el día pasa al siguiente. `used`: lo ya enviado por número y día
 * (`canal|YYYY-MM-DD`); cada persona de un flujo cuenta como sus `perPerson` mensajes.
 */
export function planSends(recipients: { conversation_id: string; channel_id: string }[], o: { now: Date; gapMs: number; cap: number; perPerson: number; used: Map<string, number>; settings: AccountSettings; businessOnly: boolean }) {
  const tz = o.settings.timezone;
  const nextFree = new Map<string, Date>();
  const plan: { conversation_id: string; at: Date }[] = [];
  for (const r of recipients) {
    let at = nextFree.get(r.channel_id) ?? o.now;
    for (let guard = 0; guard < 400; guard++) {
      at = sendTime(at, o.settings, { businessOnly: o.businessOnly });
      if (!o.cap) break;
      const day = localParts(at, tz).date;
      const key = `${r.channel_id}|${day}`;
      const today = o.used.get(key) ?? 0;
      // Un flujo más largo que el tope entra solo en un día vacío (una persona ese día).
      if (today >= o.cap || (today > 0 && today + o.perPerson > o.cap)) {
        at = zonedToUtc(addDays(day, 1), '00:00', tz);
        continue;
      }
      o.used.set(key, today + o.perPerson);
      break;
    }
    plan.push({ conversation_id: r.conversation_id, at });
    nextFree.set(r.channel_id, new Date(at.getTime() + o.gapMs));
  }
  return plan;
}
