import { messageQuota } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as astore from './store.js';
import { query, queryOne } from '../db.js';
import { addDays, localParts, nextOpen, zonedToUtc } from './time.js';

/** Campañas: envío programado a un segmento, espaciado para no parecer spam (y no arriesgar el número). */
export class Campaigns {
  constructor(private chat: ChatService) {}

  /** Programa (o inicia ya) una campaña. */
  async launch(campaignId: string) {
    const c = await astore.getCampaign(campaignId);
    if (!c) throw new Error('Campaña no encontrada');
    if (!['draft', 'scheduled'].includes(c.status)) throw new Error('La campaña ya se envió o se canceló');
    if (!c.message.trim() && !c.image_id) throw new Error('La campaña no tiene mensaje');
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
    if (quota.remaining !== null && audience.length > quota.remaining) {
      await astore.setCampaignStatus(c.id, 'draft');
      throw new Error(`Tu plan permite ${quota.remaining.toLocaleString('es-MX')} mensajes más este mes y esta campaña tiene ${audience.length.toLocaleString('es-MX')} destinatarios. Reduce el segmento o cambia de plan.`);
    }
    await astore.setCampaignStatus(c.id, 'sending');
    const gapMs = Math.ceil(60_000 / Math.max(1, c.rate_per_minute));
    const settings = await astore.getSettings(c.account_id);
    const tz = settings.timezone;
    const cap = settings.sending.daily_cap_per_number;
    // Cada número lleva su propio ritmo (con varios números la campaña termina antes sin acelerar ninguno) y, si hay tope
    // diario, lo que no cabe hoy pasa al día siguiente. Los ya enviados hoy por otras campañas cuentan para el tope.
    const nextFree = new Map<string, Date>();
    const used = new Map<string, number>();
    if (cap) {
      const midnight = zonedToUtc(localParts(new Date(), tz).date, '00:00', tz);
      for (const r of await astore.campaignSentSince(c.account_id, midnight)) used.set(`${r.channel_id}|${localParts(new Date(), tz).date}`, r.n);
    }
    for (const r of audience) {
      let at = nextFree.get(r.channel_id) ?? new Date();
      for (let guard = 0; guard < 400; guard++) {
        if (c.business_hours_only) at = nextOpen(settings.business_hours, settings.holidays, at, tz);
        if (!cap) break;
        const day = localParts(at, tz).date;
        const key = `${r.channel_id}|${day}`;
        if ((used.get(key) ?? 0) >= cap) {
          at = zonedToUtc(addDays(day, 1), '00:00', tz);
          continue;
        }
        used.set(key, (used.get(key) ?? 0) + 1);
        break;
      }
      await query(`INSERT INTO campaign_recipients (campaign_id, conversation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.id, r.conversation_id]);
      await astore.scheduleJob({
        account_id: c.account_id,
        type: 'campaign_send',
        payload: { campaign_id: c.id, conversation_id: r.conversation_id },
        run_at: at,
      });
      nextFree.set(r.channel_id, new Date(at.getTime() + gapMs));
    }
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
    const r = await this.chat.outbound.send(payload.conversation_id, {
      text: c.message,
      imageId: c.image_id ?? undefined,
      source: 'campaign',
      // Una promoción no interrumpe una conversación que está atendiendo una persona.
      meta: { campaign_id: c.id },
      flowStep: c.flow_step,
    });
    await query(
      `UPDATE campaign_recipients SET status = $3, reason = $4, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END
       WHERE campaign_id = $1 AND conversation_id = $2`,
      [c.id, payload.conversation_id, r.sent ? 'sent' : 'skipped', r.sent ? '' : r.reason],
    );
    const stats = await astore.campaignStats(c.id);
    if (!stats.pending) {
      await astore.setCampaignStatus(c.id, 'sent');
      await logEvent({ level: 'info', source: 'engine', message: `Campaña "${c.name}" terminada: ${stats.sent} enviados, ${stats.skipped} omitidos`, accountId: c.account_id });
    }
  }

  async cancel(campaignId: string) {
    const c = await astore.getCampaign(campaignId);
    if (!c || ['sent', 'cancelled'].includes(c.status)) return;
    await astore.setCampaignStatus(c.id, 'cancelled');
    await astore.cancelJobs('campaign_id', c.id);
    await query(`UPDATE campaign_recipients SET status = 'skipped', reason = 'campaña cancelada' WHERE campaign_id = $1 AND status = 'pending'`, [c.id]);
    await astore.campaignStats(c.id);
  }
}
