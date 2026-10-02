import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as astore from './store.js';
import { query } from '../db.js';
import { nextOpen } from './time.js';

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
    const audience = await astore.campaignAudience(c);
    await astore.setCampaignStatus(c.id, 'sending');
    const gapMs = Math.ceil(60_000 / Math.max(1, c.rate_per_minute));
    const settings = await astore.getSettings(c.account_id);
    // Cada envío, a ritmo constante; con "solo en horario", lo que caiga fuera se pasa a la siguiente apertura.
    let at = new Date();
    for (const r of audience) {
      if (c.business_hours_only) at = nextOpen(settings.business_hours, settings.holidays, at, settings.timezone);
      await query(`INSERT INTO campaign_recipients (campaign_id, conversation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.id, r.conversation_id]);
      await astore.scheduleJob({
        account_id: c.account_id,
        type: 'campaign_send',
        payload: { campaign_id: c.id, conversation_id: r.conversation_id },
        run_at: at,
      });
      at = new Date(at.getTime() + gapMs);
    }
    await astore.campaignStats(c.id);
    if (!audience.length) await astore.setCampaignStatus(c.id, 'sent');
    await logEvent({ level: 'info', source: 'engine', message: `Campaña "${c.name}" iniciada: ${audience.length} destinatarios`, accountId: c.account_id, channelId: c.channel_id });
    return { status: audience.length ? ('sending' as const) : ('sent' as const), recipients: audience.length };
  }

  async sendOne(payload: { campaign_id: string; conversation_id: string }) {
    const c = await astore.getCampaign(payload.campaign_id);
    if (!c || c.status !== 'sending') return;
    const r = await this.chat.outbound.send(payload.conversation_id, {
      text: c.message,
      imageId: c.image_id ?? undefined,
      source: 'campaign',
      // Una promoción no interrumpe una conversación que está atendiendo una persona.
      meta: { campaign_id: c.id },
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
