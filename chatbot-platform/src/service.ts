import { syncStaffEvent } from './integrations/staff-calendars.js';
import { syncAppointment as syncOutlookAppointment } from './integrations/outlook.js';
import { accountAi, audioSeconds } from './ai/budget.js';
import { syncAppointment } from './integrations/google.js';
import crypto from 'node:crypto';
import type { AiProvider } from './ai/provider.js';
import { Agenda } from './automation/agenda.js';
import { Automator } from './automation/automator.js';
import { Pipelines } from './automation/pipelines.js';
import { Campaigns } from './automation/campaigns.js';
import { Outbound } from './automation/outbound.js';
import { Scheduler } from './automation/scheduler.js';
import * as astore from './automation/store.js';
import { isOpen, nextOpen, spanishDate, spanishTime } from './automation/time.js';
import { detectRisk, maskSensitive } from './engine/safety.js';
import { customerLabel } from './engine/customer-data.js';
import { assertOutbound, guardTransport } from './outbound-guard.js';
import { cleanText, deepClean, toPlainText } from './engine/text.js';
import { adapterFor } from './channels/index.js';
import { INBOUND_MEDIA_MAX_BYTES, removeInboundFiles, saveInboundMedia, type StoredMedia } from './channels/media.js';
import { config } from './config.js';
import { gate } from './engine/activation.js';
import { describeInbound, type InboundMessage } from './channels/types.js';
import { query, queryOne } from './db.js';
import { summarizeConversation } from './engine/report.js';
import { Engine, type ProcessResult } from './engine/engine.js';
import { setAlertWhatsapp } from './lifecycle.js';
import { RETRYABLE_DEAD } from './engine/queue.js';
import { deliver } from './integrations/webhooks.js';
import { messageQuota, noticeMessagesReached } from './billing/limits.js';
import { ConversationQueue } from './engine/queue.js';
import { InboundQueue } from './engine/inbox.js';
import { ZernioEventQueue } from './channels/zernio-events.js';
import { zernioCleanup } from './channels/zernio-connect.js';
import { fillBody, outgoingTemplate, templateBody, templateForChannel, templateVarCount } from './channels/zernio-templates.js';
import { renderTemplate } from './automation/templates.js';
import { DeliveryUncertain,currentOperation } from './engine/coordination.js';
import { PlaygroundTransport, type Transport } from './engine/transport.js';
import { logEvent } from './logs.js';
import * as store from './store/index.js';
import type { Channel, Chatbot, Contact, Conversation } from './types.js';

/** Antigüedad máxima de un mensaje entrante para responderlo automáticamente. */
const MAX_MESSAGE_AGE_SECONDS = 30 * 60;

export type TransportFactory = (channel: Channel, contact: Contact) => Transport;

/** Transferencias por emergencia o riesgo para la vida (engine.ts): no vuelven solas al asistente. */
const isSafetyHandoff = (reason?: string | null) => /^(Riesgo para la vida|Posible emergencia)/.test(reason ?? '');
const SAFETY_HANDOFF_SQL = `coalesce(c.handoff_reason, '') ~ '^(Riesgo para la vida|Posible emergencia)'`;

export const defaultTransport: TransportFactory = (channel, contact) => adapterFor(channel.type).transport(channel, contact);

/** Orquesta: webhook → almacenamiento → cola → motor → envío, para cualquier canal. */
const LEASE_SECONDS = 300;

/**
 * ¿El eco corresponde a este mensaje enviado? Igual sin formato ("*doble*" vuelve como "doble"), o una de sus partes
 * cuando la plataforma lo dividió (Instagram parte los textos largos).
 */
function sameText(sent: string, echo: string) {
  const a = toPlainText(sent).trim();
  const b = toPlainText(echo).trim();
  return a === b || (b.length >= 20 && a.includes(b));
}

export class ChatService {
  readonly inbox: InboundQueue;
  /** Eventos de Zernio que no son mensajes (conexión, entregado, leído, fallido). */
  readonly zernioEvents = new ZernioEventQueue();
  get aiProvider() { return this.ai; }
  engine: Engine;
  queue: ConversationQueue;
  outbound: Outbound;
  automator: Automator;
  pipelines: Pipelines;
  agenda: Agenda;
  campaigns: Campaigns;
  scheduler: Scheduler;

  constructor(private ai: AiProvider, private transportFactory: TransportFactory = defaultTransport) {
    this.outbound = new Outbound(this);
    this.automator = new Automator(this);
    this.pipelines = new Pipelines(this);
    this.agenda = new Agenda(this);
    this.campaigns = new Campaigns(this);
    this.engine = new Engine(ai, {
      intents: (accountId, chatbotId) => this.automator.intentsFor(accountId, chatbotId),
      pipeline: (conv) => this.pipelines.contextFor(conv),
      agenda: this.agenda,
      onEvent: (e) => this.automator.emit(e),
      settleEvents: (id)=>this.automator.settle(id),
      onOutbound: (conv, msg) => this.automator.onOutbound(conv, msg),
      business: async (accountId) => {
        const st = await astore.getSettings(accountId);
        const now = new Date();
        const openNow = isOpen(st.business_hours, st.holidays, now, st.timezone);
        // Cuándo vuelve a abrir: el asistente lo dice al cliente en vez de prometer una respuesta inmediata.
        const hasHours = Object.values(st.business_hours).some((w) => w.length > 0);
        const next = !openNow && hasHours ? nextOpen(st.business_hours, st.holidays, now, st.timezone) : null;
        return {
          timezone: st.timezone,
          hours: st.business_hours,
          holidays: st.holidays,
          openNow,
          nextOpen: next ? `${spanishDate(next, st.timezone)} a las ${spanishTime(next, st.timezone)}` : undefined,
        };
      },
      alertTeam: (accountId, o) => this.automator.alertTeam(accountId, o),
      deferImage: async (conv, image, o) => {
        await astore.scheduleJob({
          account_id: conv.account_id,
          type: 'flow_image',
          payload: { conversation_id: conv.id, image_id: image.id, reason: o.reason, journey: conv.flow_started_at ? new Date(conv.flow_started_at).toISOString() : null, at: new Date().toISOString(), allow_ended: o.allowEnded, allow_repeat: !!o.allowRepeat },
          run_at: new Date(Date.now() + o.delaySeconds * 1000),
          dedupe_key: `flow_image:${conv.id}:${image.id}`,
        });
      },
    });
    // Los avisos de desconexión a WhatsApp adicionales salen por otro WhatsApp conectado de la cuenta.
    setAlertWhatsapp((accountId, phone, text, excludeChannelId) => this.sendInternalWhatsapp(accountId, phone, text, null, excludeChannelId));
    this.queue = new ConversationQueue((id, a) => this.runConversation(id, a.restarts), 2, config.queue.retryMs, (id) => this.aiUnavailable(id));
    this.inbox = new InboundQueue((channel,msg)=>this.handleIncoming(channel,msg),channel=>this.automator.alertTeam(channel.account_id,{title:'⚠️ Recepción pendiente de revisión',body:'No se pudo completar la recepción de un mensaje. Revisa los trabajos pendientes de este perfil.',kind:'alert',link:'#/logs'}));
    this.scheduler = new Scheduler({
      automation_send: (p) => this.automator.runDelayedSend(p),
      flow_image: (p) => this.automator.runDeferredImage(p),
      webhook_delivery: (p, job) => deliver(p, job.attempts),
      gcal_sync: (p) => syncAppointment(p),
      outlook_sync: (p) => syncOutlookAppointment(p),
      staff_cal_sync: (p) => syncStaffEvent(p),
      no_reply: (p) => this.automator.runNoReply(p),
      sequence_step: (p) => this.automator.runSequenceStep(p),
      appointment_reminder: (p) => this.agenda.sendReminder(p),
      campaign_start: (p) => this.campaigns.start(p.campaign_id),
      campaign_send: (p) => this.campaigns.sendOne(p),
      zernio_cleanup: (p) => zernioCleanup(p),
    },()=>this.automator.settleAll());
  }

  summarize(conversationId: string) {
    return summarizeConversation(this.ai, conversationId);
  }

  async closeConversation(conversationId: string, reason: string) {
    const closed = await store.setConversationStatus(conversationId, 'closed', reason);
    if (!closed) throw new Error('Conversación no encontrada');
    try { return await this.summarize(conversationId); }
    catch (error) {
      await logEvent({ level: 'error', source: 'ai', message: 'Conversación cerrada; el resumen no pudo generarse y se puede volver a solicitar', accountId: closed.account_id, chatbotId: closed.chatbot_id, conversationId, details: { error: error instanceof Error ? error.message : String(error) } });
      return (await store.getConversation(conversationId))!;
    }
  }

  /** Aviso interno por WhatsApp (alertas al equipo), usando un WhatsApp activo de la cuenta. */
  async sendInternalWhatsapp(accountId: string, number: string, text: string, preferChatbotId?: string | null, excludeChannelId?: string) {
    // Primero los WhatsApp conectados: un aviso por uno desconectado no llegaría.
    const channels = (await store.listChannels(accountId))
      .filter((c) => c.type === 'whatsapp' && c.active && c.config.instance && c.id !== excludeChannelId)
      .sort((a, b) => Number(b.connection_state === 'open') - Number(a.connection_state === 'open'));
    const wa = channels.find((c) => c.chatbot_id === preferChatbotId && c.connection_state === 'open') ?? channels[0];
    if (!wa) throw new Error(excludeChannelId ? 'La cuenta no tiene otro WhatsApp conectado para enviar el aviso' : 'La cuenta no tiene un canal de WhatsApp activo para enviar el aviso');
    const digits = number.replace(/\D/g, '');
    // Antes de registrar nada: en sandbox un aviso a un número no permitido no debe quedar como enviado.
    assertOutbound(digits);
    // Se registra antes de enviar: el eco puede llegar antes de que responda el envío.
    await store.recordInternalNotice(accountId, digits, text.trim());
    const t = this.transportFactory(wa, { phone: digits, external_id: digits } as Contact);
    await t.sendText(text, 0);
  }

  /**
   * Transporte del canal; los avisos al encargado salen siempre por un WhatsApp de la cuenta. Todo envío pasa por el freno
   * de salida (outbound-guard): en producción no cambia nada, en sandbox solo salen los destinos permitidos.
   * El simulador del panel no sale de la plataforma, así que queda fuera.
   */
  transportFor(channel: Channel, contact: Contact): Transport {
    const t = this.transportFactory(channel, contact);
    if (channel.type === 'playground') return t;
    const guarded = guardTransport(t, contact.phone || contact.external_id);
    if (channel.type === 'whatsapp') return guarded;
    return { ...guarded, notify: (number, text) => this.notifyViaWhatsapp(channel, number, text) };
  }

  private notifyViaWhatsapp(channel: Channel, number: string, text: string) {
    return this.sendInternalWhatsapp(channel.account_id, number, text, channel.chatbot_id);
  }

  /** Identifica a este proceso en los arrendamientos de conversaciones. */
  readonly instanceId = crypto.randomUUID();
  private sweeper?: NodeJS.Timeout;

  /**
   * Una conversación la atiende un solo proceso a la vez (arrendamiento en PostgreSQL), así que se pueden
   * correr varios procesos sin respuestas dobles, y si uno muere a la mitad otro retoma el trabajo.
   */
  private async runConversation(conversationId: string, restarts: number): Promise<ProcessResult> {
    const incomplete = (await store.pendingInbound(conversationId)).filter(m=>m.meta?.receipt_ready === false);
    if (incomplete.length) {
      if (incomplete.some(m=>Date.now()-new Date(m.created_at).getTime()>30_000)) throw new DeliveryUncertain();
      return {status:'busy'};
    }
    if (!(await store.claimConversation(conversationId, this.instanceId, LEASE_SECONDS))) return { status: 'busy' };
    const renew = setInterval(() => void store.renewConversationLease(conversationId, this.instanceId, LEASE_SECONDS).catch(() => undefined), (LEASE_SECONDS / 3) * 1000);
    try {
      return await this.runClaimed(conversationId, restarts);
    } finally {
      clearInterval(renew);
      await store.releaseConversation(conversationId, this.instanceId).catch(() => undefined);
    }
  }

  /** Busca mensajes sin responder que nadie atiende (temporizador perdido o proceso caído) y los programa. */
  async sweepPending(): Promise<number> {
    const ids = (await store.recoverableConversations()).filter((id) => !this.queue.has(id));
    for (const id of ids) await this.queue.schedule(id, 0);
    return ids.length;
  }

  /**
   * Conversaciones en revisión: las que fallaron por la IA se reintentan cada 10 minutos (hasta 12 veces, unas 2 horas);
   * las demás (envío incierto o reintentos agotados) vuelven a avisar al equipo cada 30 minutos mientras el cliente siga
   * esperando, durante 24 horas.
   */
  async reviveFailed(): Promise<{ retried: number; reminded: number }> {
    const retried = await query<{ conversation_id: string }>(`UPDATE conversation_work w SET state='pending',attempts=0,run_at=now(),reason=NULL,revivals=revivals+1,updated_at=now()
      WHERE w.state='dead' AND w.reason='processing_error' AND w.revivals<12 AND w.updated_at<now()-interval '10 minutes'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=w.conversation_id AND m.direction='in' AND NOT m.processed)
      RETURNING w.conversation_id`);
    const due = await query<{ conversation_id: string }>(`UPDATE conversation_work w SET alerted_at=now()
      WHERE w.state='dead' AND (w.reason<>'processing_error' OR w.revivals>=12)
        AND w.updated_at>now()-interval '24 hours' AND (w.alerted_at IS NULL OR w.alerted_at<now()-interval '30 minutes')
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=w.conversation_id AND m.direction='in' AND NOT m.processed)
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=w.conversation_id AND c.status='bot')
      RETURNING w.conversation_id`);
    for (const row of due) await this.remindWaiting(row.conversation_id);
    return { retried: retried.length, reminded: due.length };
  }

  /** Recordatorio al equipo: un cliente sigue esperando y el asistente no puede responderle solo. */
  private async remindWaiting(conversationId: string) {
    try {
      const conv = await store.getConversation(conversationId);
      if (!conv) return;
      const [contact, channel] = await Promise.all([store.getContact(conv.contact_id), store.getChannel(conv.channel_id)]);
      if (!channel || channel.type === 'playground') return;
      const who = contact?.name || contact?.push_name || (contact?.phone ? `+${contact.phone}` : 'Un cliente');
      await this.automator.alertTeam(conv.account_id, {
        title: '⏰ Un cliente sigue esperando respuesta',
        body: `${who} (${channel.name}) sigue sin respuesta y el asistente no puede contestarle solo. Ábrelo y respóndele o confirma que ya se atendió.`,
        link: `#/conversation/${conversationId}`,
        conversationId,
        kind: 'ai_error',
        roles: ['admin','agent'],
      });
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'system', message: `No se pudo recordar al equipo un cliente en espera: ${e?.message ?? e}`, conversationId });
    }
  }

  /**
   * Clientes que esperan a una persona del equipo: si el último mensaje es del cliente y lleva más de
   * `handoff_reminder_minutes`, se recuerda al equipo (y se repite cada 2 horas, durante 24 horas).
   */
  async remindHumanWaiting(): Promise<number> {
    const rows = await query<{ id: string; chatbot_id: string | null; waiting_min: number }>(`SELECT c.id, c.chatbot_id, floor(extract(epoch FROM now() - m.created_at) / 60)::int AS waiting_min
      FROM conversations c
      JOIN LATERAL (SELECT direction, created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) m ON true
      WHERE c.status = 'human' AND m.direction = 'in' AND m.created_at > now() - interval '24 hours'
        AND (c.human_reminded_at IS NULL OR c.human_reminded_at < m.created_at OR c.human_reminded_at < now() - interval '2 hours')
      LIMIT 200`);
    let n = 0;
    for (const row of rows) {
      const bot = row.chatbot_id ? await store.getChatbot(row.chatbot_id) : null;
      const minutes = bot?.rules.handoff_reminder_minutes ?? 30;
      if (!minutes || row.waiting_min < minutes) continue;
      const claimed = await query(`UPDATE conversations SET human_reminded_at = now() WHERE id = $1 AND status = 'human'
        AND (human_reminded_at IS NULL OR human_reminded_at < now() - interval '2 hours' OR human_reminded_at < (SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'in')) RETURNING id`, [row.id]);
      if (!claimed.length) continue;
      const conv = await store.getConversation(row.id);
      if (!conv) continue;
      const [contact, channel] = await Promise.all([store.getContact(conv.contact_id), store.getChannel(conv.channel_id)]);
      if (!channel || channel.type === 'playground') continue;
      const who = contact?.name || contact?.push_name || (contact?.phone ? `+${contact.phone}` : 'Un cliente');
      const resume = bot?.rules.auto_resume_minutes ? '' : ' Si nadie puede atenderlo, devuelve la conversación al asistente desde Conversaciones.';
      await this.automator.alertTeam(conv.account_id, {
        title: '⏳ Un cliente espera a una persona',
        body: `${who} (${channel.name}) espera respuesta de alguien del equipo desde hace ${row.waiting_min} min.${resume}`,
        link: `#/conversation/${conv.id}`,
        conversationId: conv.id,
        kind: 'handoff_wait',
        roles: ['admin', 'agent'],
      }).catch(() => undefined);
      n++;
    }
    return n;
  }

  /**
   * «Devolver al asistente después de N minutos sin actividad humana»: si nadie del equipo escribió en ese tiempo, la
   * conversación vuelve al asistente aunque el cliente no escriba otra vez; y si el cliente quedó esperando (mensajes
   * suyos sin respuesta de las últimas 24 h), el asistente le contesta.
   */
  async autoResumeIdle(): Promise<number> {
    // Una emergencia o un riesgo para la vida nunca vuelve solo al asistente: lo atiende una persona.
    const rows = await query<{ id: string; minutes: number }>(`SELECT c.id, r.minutes
      FROM conversations c
      JOIN chatbots b ON b.id = c.chatbot_id
      JOIN channels ch ON ch.id = c.channel_id AND ch.active AND ch.type <> 'playground'
      CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(b.rules->'auto_resume_minutes') = 'number'
        THEN floor((b.rules->>'auto_resume_minutes')::numeric)::int ELSE 0 END AS minutes) r
      WHERE c.status = 'human' AND b.active AND r.minutes > 0
        AND c.status_changed_at < now() - make_interval(mins => r.minutes)
        AND NOT (${SAFETY_HANDOFF_SQL})
      LIMIT 200`);
    let n = 0;
    for (const row of rows) {
      // Atómico y solo si nadie del equipo escribió en esos minutos (otro proceso o una persona pudo adelantarse).
      const resumed = await queryOne<{ id: string; account_id: string }>(`UPDATE conversations c SET status = 'bot', handoff_reason = '', status_changed_at = now()
        WHERE c.id = $1 AND c.status = 'human' AND c.status_changed_at < now() - make_interval(mins => $2) AND NOT (${SAFETY_HANDOFF_SQL})
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'human' AND m.created_at > now() - make_interval(mins => $2))
        RETURNING c.id, c.account_id`, [row.id, row.minutes]);
      if (!resumed) continue;
      n++;
      await logEvent({ level: 'info', source: 'engine', message: `El bot retomó la conversación: nadie del equipo respondió en ${row.minutes} min`, accountId: resumed.account_id, conversationId: row.id });
      const waiting = await query(`UPDATE messages SET processed = false WHERE conversation_id = $1 AND direction = 'in' AND processed
          AND created_at > now() - interval '24 hours'
          AND id > coalesce((SELECT max(id) FROM messages WHERE conversation_id = $1 AND direction = 'out'), 0) RETURNING id`, [row.id]);
      if (waiting.length) await this.queue.schedule(row.id, 0, true);
    }
    return n;
  }

  startSweeper(intervalMs = 30_000) {
    let laps = 0;
    this.sweeper = setInterval(() => {
      if (laps % 2 === 0) this.autoResumeIdle().catch(() => undefined);
      if (laps++ % 10 === 0) this.remindHumanWaiting().catch(() => undefined);
      this.sweepPending()
        .then(async (n) => { if (n) await logEvent({ level: 'warn', source: 'engine', message: `Se retomaron ${n} conversaciones con mensajes sin responder` }); })
        .catch(() => undefined);
      this.reviveFailed()
        .then(async (r) => { if (r.retried) await logEvent({ level: 'warn', source: 'engine', message: `Se reintentaron ${r.retried} conversaciones en las que el asistente no pudo responder` }); })
        .catch(() => undefined);
    }, intervalMs);
    this.sweeper.unref();
  }

  stopSweeper() { clearInterval(this.sweeper); }

  private async runClaimed(conversationId: string, restarts: number): Promise<ProcessResult> {
    const conv = await store.getConversation(conversationId);
    if (!conv) return { status: 'nothing' };
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) return { status: 'nothing' };
    let transport: Transport;
    try {
      transport = this.transportFor(channel, contact);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'channel', message: e?.message ?? String(e), accountId: channel.account_id, channelId: channel.id, conversationId });
      await store.markAllProcessed(conversationId);
      return { status: 'nothing' };
    }
    // Cupo mensual del plan: al agotarse el asistente deja de responder solo (y se avisa al equipo una vez al mes).
    if (channel.type !== 'playground' && (await messageQuota(channel.account_id)).reached) {
      await store.markAllProcessed(conversationId);
      await noticeMessagesReached(channel.account_id).catch(() => undefined);
      await logEvent({ level: 'warn', source: 'engine', message: 'Límite mensual de mensajes del plan alcanzado: el asistente no respondió', accountId: channel.account_id, channelId: channel.id, conversationId });
      return { status: 'nothing' };
    }
    return this.engine.process(conversationId, transport, { allowRestart: this.queue.canRestart(restarts) });
  }

  /** La IA falló dos veces seguidas en una conversación: se avisa al equipo para que no quede sin respuesta. */
  private async aiUnavailable(conversationId: string) {
    try {
      const conv = await store.getConversation(conversationId);
      if (!conv || conv.status !== 'bot') return;
      const [contact, channel] = await Promise.all([store.getContact(conv.contact_id), store.getChannel(conv.channel_id)]);
      if (!channel || channel.type === 'playground') return;
      const who = contact?.name || contact?.push_name || (contact?.phone ? `+${contact.phone}` : 'Un cliente');
      const work=(await query('SELECT reason,revivals FROM conversation_work WHERE conversation_id=$1',[conversationId]))[0];
      if(!work || work.reason==='processing_error') await this.engine.sendRuleImagesWithoutAi(conversationId).catch(()=>undefined);
      // Si nada se envió a medias, el cliente sabe que se le atenderá (un envío incierto pudo haber llegado: no se agrega nada).
      if(!work || RETRYABLE_DEAD.includes(work.reason)) {
        try {
          if (contact) await this.engine.sendUnavailableNotice(conversationId, this.transportFor(channel, contact));
        } catch (e: any) {
          await logEvent({ level: 'warn', source: 'engine', message: `No se pudo enviar el mensaje de demora: ${e?.message ?? e}`, accountId: conv.account_id, channelId: conv.channel_id, conversationId });
        }
      }
      // Los reintentos automáticos (cada 10 min) no repiten el aviso: el equipo ya lo tiene, y si sigue sin resolverse
      // recibe los recordatorios cada 30 minutos.
      if (work && Number(work.revivals) > 0 && work.reason === 'processing_error' && Number(work.revivals) < 12) return;
      await query('UPDATE conversation_work SET alerted_at=now() WHERE conversation_id=$1',[conversationId]);
      await logEvent({ level: 'error', source: 'ai', message: 'Un cliente espera respuesta; se avisó al equipo', accountId: conv.account_id, channelId: conv.channel_id, conversationId });
      await this.automator.alertTeam(conv.account_id, {
        title: '⚠️ Un cliente espera respuesta',
        body: `${who} (${channel.name}) escribió y el asistente no pudo responder o se interrumpió una operación. Revisa la conversación y sus envíos pendientes desde el panel.`,
        link: `#/conversation/${conversationId}`,
        conversationId,
        kind: 'ai_error',
        roles: ['admin','agent'],
      });
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'system', message: `No se pudo avisar de la falla de IA: ${e?.message ?? e}`, conversationId });
    }
  }

  /** Maneja un mensaje ya normalizado que llegó por cualquier canal. */
  async handleIncoming(channel: Channel, msg: InboundMessage): Promise<{ conversationId: string | null; messageId: number | null }> {
    // Lo que llega de la plataforma se limpia una vez aquí (NUL y surrogates sueltos no caben en PostgreSQL).
    msg = deepClean(msg);
    // El eco de un aviso interno (alerta al equipo) no es una conversación: no crea contacto ni pausa al asistente.
    if (msg.fromMe && msg.text && (await store.consumeInternalNotice(channel.account_id, (msg.phone || msg.externalId).replace(/\D/g, ''), msg.text))) {
      return { conversationId: null, messageId: null };
    }
    const bot = channel.chatbot_id ? await store.getChatbot(channel.chatbot_id) : null;
    const contact = await store.upsertContact(channel, msg.externalId, msg.phone, msg.fromMe ? '' : msg.displayName);
    const conv = await store.getOrCreateConversation(channel, contact.id);
    const logBase = { accountId: channel.account_id, chatbotId: bot?.id ?? null, channelId: channel.id, conversationId: conv.id };

    if (msg.fromMe) {
      await this.handleOwnMessage(bot, conv, msg);
      return { conversationId: conv.id, messageId: null };
    }
    // Zernio entrega al menos una vez: un reintento de un mensaje ya guardado no debe volver a responderse.
    if (channel.type === 'zernio' && (await store.findMessageByExternalId(conv.id, msg.messageId))) {
      return { conversationId: conv.id, messageId: null };
    }

    let content = describeInbound(msg);
    const adapter = adapterFor(channel.type);
    if (msg.type === 'audio' && bot?.ai.transcribe_audio && adapter.downloadAudio) {
      try {
        const audio = await adapter.downloadAudio(channel, msg);
        if (audio) {
          const started = Date.now();
          const seconds = msg.media?.seconds || audioSeconds(audio.buffer, audio.mimeType);
          const result = await accountAi(this.ai,channel.account_id,bot?.id??null,'transcription').transcribe(audio.buffer, audio.mimeType, seconds);
          const text = typeof result === 'string' ? result : result.content;
          if (text) content = `[Nota de voz del cliente, transcrita]: "${text}"`;
          // Se registra para el costo por cuenta. Sin duración de la plataforma, se estima (~2 KB por segundo de Opus).
          await store.insertAiRun({
            account_id: channel.account_id,
            chatbot_id: bot.id,
            conversation_id: conv.id,
            kind: 'transcription',
            model: typeof result === 'string' ? config.openai.transcriptionModel : result.model,
            input_tokens: typeof result === 'string' ? 0 : result.usage.input_tokens,
            cached_tokens: typeof result === 'string' ? 0 : result.usage.cached_tokens,
            output_tokens: typeof result === 'string' ? 0 : result.usage.output_tokens,
            cost_usd: typeof result === 'string' ? undefined : result.cost_usd,
            latency_ms: Date.now() - started,
            audio_seconds: seconds,
          });
        }
      } catch (e: any) {
        await logEvent({ level: 'warn', source: 'ai', message: `No se pudo transcribir la nota de voz: ${e?.message ?? e}`, ...logBase });
      }
    }

    // Datos sensibles: el número de una tarjeta se guarda solo con sus últimos 4 dígitos.
    content = maskSensitive(content);
    // Mensajes viejos (reconexión, reenvíos de la plataforma) se guardan pero no se contestan.
    const stale = Date.now() / 1000 - msg.timestamp > MAX_MESSAGE_AGE_SECONDS;
    const triggers = msg.type !== 'reaction' && !stale && !msg.captureOnly;
    // Foto o documento del cliente: se guarda tal como llegó. Si no se puede, el mensaje se guarda igual y el motivo queda visible en el panel.
    let media: StoredMedia | undefined;
    let mediaError = '';
    if (msg.type === 'image' || msg.type === 'document') {
      try {
        const captured = await this.captureInboundMedia(channel, msg, msg.type);
        media = captured.media;
        mediaError = captured.error ?? '';
      } catch (e: any) {
        mediaError = `${msg.type === 'image' ? 'La foto' : 'El documento'} no se guardó: ${e?.message ?? e}`;
        await logEvent({ level: 'warn', source: 'engine', message: `No se pudo guardar un archivo del cliente: ${e?.message ?? e}`, ...logBase });
      }
    }
    const meta: Record<string, unknown> = stale ? { name: msg.displayName, stale: true } : msg.captureOnly ? { name: msg.displayName, held: 'limite_de_correos' } : { name: msg.displayName };
    if (mediaError) meta.media_error = mediaError;
    if (triggers) meta.receipt_ready = false;
    const inserted = await store.insertMessage({
      conversation_id: conv.id,
      direction: 'in',
      sender: 'customer',
      type: msg.type,
      content,
      external_message_id: msg.messageId,
      processed: !triggers,
      queueDelayMs: triggers ? (bot?.ai.debounce_seconds ?? 3)*1000 : undefined,
      meta,
      media,
    }).catch(async (e) => {
      if (media) await removeInboundFiles([media.file_path]);
      throw e;
    });
    if (!inserted) {
      // Duplicado: el archivo que se acaba de descargar no se conserva.
      if (media) await removeInboundFiles([media.file_path]);
      return { conversationId: conv.id, messageId: null };
    }

    let current = conv;
    if (conv.status === 'closed' && triggers) {
      // El cliente vuelve a escribir: se reabre (la memoria se conserva; el recorrido empieza de nuevo, salvo que una
      // campaña lo haya empezado en una etapa después del cierre: entonces sigue desde ahí).
      await store.resetFlowState(conv.id, { keepCampaignStart: true });
      current = (await store.setConversationStatus(conv.id, 'bot', '')) ?? conv;
    } else if (conv.status === 'human' && bot && bot.rules.auto_resume_minutes > 0 && !isSafetyHandoff(conv.handoff_reason)) {
      const lastHuman = await store.lastHumanActivity(conv.id);
      const since = Math.max(new Date(conv.status_changed_at).getTime(), lastHuman ? new Date(lastHuman).getTime() : 0);
      if (Date.now() - since > bot.rules.auto_resume_minutes * 60_000) {
        current = (await store.setConversationStatus(conv.id, 'bot', '')) ?? conv;
        await logEvent({ level: 'info', source: 'engine', message: 'El bot retomó la conversación automáticamente', ...logBase });
      }
    }
    // El cliente vuelve tras un tiempo sin actividad: empieza una solicitud nueva (otra reserva, el mismo problema otra
    // vez…) y se le atiende de nuevo. Cuenta desde este mensaje, así sus respuestas valen para la solicitud nueva.
    const gapHours = bot?.flow.new_request_after_hours ?? 0;
    if (triggers && conv.status !== 'closed' && current.status === 'bot' && gapHours > 0) {
      const last = await store.lastActivityBefore(conv.id, inserted.id);
      if (last && Date.now() - new Date(last).getTime() >= gapHours * 3600_000) {
        const n = await store.beginRequest(conv.id, { reason: 'tiempo', since: inserted.created_at });
        current = (await store.getConversation(conv.id)) ?? current;
        await logEvent({ level: 'info', source: 'engine', message: `Solicitud nueva (${n}.ª): el cliente volvió después de más de ${gapHours} h sin actividad`, ...logBase });
      }
    }

    if (!triggers) return { conversationId: conv.id, messageId: inserted.id };
    // Automatizaciones (bajas, reglas por mensaje, secuencias): corren aunque atienda una persona o el bot esté apagado.
    if (channel.account_active !== false) {
      const stopAi = await this.automator.onInbound(current, contact, inserted, content).catch(async (e) => {
        await logEvent({ level: 'error', source: 'engine', message: `Error en automatizaciones: ${e?.message ?? e}`, ...logBase, details: e });
        return false;
      });
      if (stopAi) await store.markMessageProcessed(inserted.id);
      current = (await store.getConversation(conv.id)) ?? current;
    }
    let canReply = current.status === 'bot' && !!bot && bot.active && channel.active && channel.account_active !== false;
    // Activadores y desactivadores del asistente (palabras que lo encienden o lo apagan en esta conversación).
    if (canReply) canReply = await this.applyGate(bot!, channel, current, contact, content);
    if (!canReply) {
      // El asistente no va a responder (pausa, palabra de activación o una persona atiende): si hay una emergencia,
      // el equipo se entera igual. Con el asistente activo, el motor se encarga de responder y avisar.
      if (triggers && channel.type !== 'playground' && detectRisk(content)) {
        await this.automator.alertTeam(channel.account_id, {
          title: '🚨 Posible emergencia en una conversación',
          body: `${customerLabel(contact)} (${channel.name}): "${content.slice(0, 200)}". Atiéndelo cuanto antes.`,
          link: `#/conversation/${conv.id}`,
          conversationId: conv.id,
          kind: 'safety',
        }).catch(() => undefined);
      }
      await this.automator.settle(conv.id);
      await store.markProcessed(conv.id, inserted.id);
      await store.updateMessage(inserted.id,{meta:{receipt_ready:true}});
      return { conversationId: conv.id, messageId: inserted.id };
    }
    await this.automator.settle(conv.id);
    await store.updateMessage(inserted.id, {meta:{receipt_ready:true}});
    // El cliente volvió a escribir: si su conversación quedó en revisión por una falla que se puede repetir, se reintenta.
    await this.queue.schedule(conv.id, bot!.ai.debounce_seconds * 1000, true);
    return { conversationId: conv.id, messageId: inserted.id };
  }

  /** Descarga la foto o el documento del cliente y lo guarda con sus bytes originales. Si el canal no puede o el archivo es muy grande, devuelve el motivo. */
  private async captureInboundMedia(channel: Channel, msg: InboundMessage, kind: 'image' | 'document'): Promise<{ media?: StoredMedia; error?: string }> {
    const label = kind === 'image' ? 'La foto' : 'El documento';
    const limit = `${INBOUND_MEDIA_MAX_BYTES / 1024 / 1024} MB`;
    const adapter = adapterFor(channel.type);
    if (!adapter.downloadMedia) return { error: `${label} no se guardó: este canal todavía no permite descargar archivos` };
    // Se revisa el tamaño que declara la plataforma antes de descargar: un documento de cientos de MB no se trae a memoria.
    if ((msg.media?.size ?? 0) > INBOUND_MEDIA_MAX_BYTES) return { error: `${label} no se guardó: pesa más de ${limit}` };
    const file = await adapter.downloadMedia(channel, msg);
    if (!file) return { error: `${label} no se guardó: la plataforma no entregó el archivo` };
    if (file.buffer.length > INBOUND_MEDIA_MAX_BYTES) return { error: `${label} no se guardó: pesa más de ${limit}` };
    const media = await saveInboundMedia(channel.account_id, kind, file.buffer, file.fileName ?? msg.media?.filename ?? '');
    return { media };
  }

  /** Aplica los activadores/desactivadores a un mensaje del cliente. Devuelve si la IA debe responder. */
  async applyGate(bot: Chatbot, channel: Channel, conv: Conversation, contact: Contact, text: string, transport?: Transport, engine = this.engine): Promise<boolean> {
    const g = gate(bot.rules.activation, conv, text);
    if (g.change === 'on') {
      await store.setAgentOn(conv.id);
      await logEvent({ level: 'info', source: 'engine', message: `Asistente activado: ${g.reason}`, accountId: conv.account_id, chatbotId: bot.id, channelId: channel.id, conversationId: conv.id });
    } else if (g.change === 'off') {
      let t = transport;
      try {
        t ??= this.transportFor(channel, contact);
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'channel', message: e?.message ?? String(e), accountId: conv.account_id, channelId: channel.id, conversationId: conv.id });
        await store.setAgentOff(conv.id, g.reason, null);
        return false;
      }
      await engine.deactivate(bot, conv, contact, t, g.reason);
    }
    return g.reply;
  }

  /** Manual ownership changes share the same handoff event as bot transfers. */
  /** Pasa la conversación a una persona. Queda en el contacto quién la tomó y desde dónde (teléfono, panel…). */
  async takeover(conversationId: string, reason: string, byUserId?: string, via: store.HandoffVia = byUserId ? 'panel' : 'telefono') {
    const changed = await store.takeConversation(conversationId, reason);
    await query('UPDATE conversations SET control_version=control_version+1 WHERE id=$1',[conversationId]);
    await store.markAllProcessed(conversationId);
    if (changed) {
      await store.markHandoff(changed.contact_id, byUserId ?? null, via);
      this.automator.emit({ type: 'handoff', conversationId, byUserId });
    }
    if(currentOperation()?.startsWith('receipt:')) await this.automator.settle(conversationId);
    return changed ?? await store.getConversation(conversationId);
  }

  /** Mensaje enviado desde la cuenta del negocio: eco de un envío nuestro o respuesta manual de una persona. */
  private async handleOwnMessage(bot: Chatbot | null, conv: Conversation, msg: InboundMessage) {
    const content = describeInbound(msg).replace(/^\[El cliente /, '[Se ');
    const known =
      (await store.findMessageByExternalId(conv.id, msg.messageId)) ??
      (msg.text ? await store.findRecentOutgoingEcho(conv.id, msg.text) : null) ??
      // Algunas plataformas (Zernio) devuelven el eco sin formato: "*doble*" vuelve como "doble".
      (msg.text ? (await store.recentOutgoing(conv.id)).find((m) => sameText(m.content, msg.text)) ?? null : null) ??
      (msg.type === 'image' ? await store.findRecentOutgoingImageEcho(conv.id) : null);
    if (known) {
      if (!known.external_message_id) await store.updateMessage(known.id, { external_message_id: msg.messageId });
      return;
    }
    await store.insertMessage({
      conversation_id: conv.id,
      direction: 'out',
      sender: 'human',
      type: msg.type,
      // Lo que escribe una persona desde el teléfono también se enmascara (p. ej. números de tarjeta), como lo del cliente.
      content: msg.type === 'text' ? maskSensitive(msg.text) : content,
      external_message_id: msg.messageId,
      meta: { source: 'platform' },
    });
    // Una persona que escribe desde el teléfono pausa al asistente aunque la conversación esté cerrada (la reabre con ella).
    if ((bot?.rules.pause_on_human_reply ?? true) && conv.status !== 'human') {
      await this.takeover(conv.id, 'Una persona respondió desde la plataforma', undefined, 'telefono');
      await logEvent({
        level: 'info',
        source: 'engine',
        message: 'Bot pausado: una persona respondió directamente desde la plataforma',
        accountId: conv.account_id,
        chatbotId: bot?.id ?? null,
        channelId: conv.channel_id,
        conversationId: conv.id,
      });
    }
  }

  /** Simulador del panel: mismo motor, sin plataforma externa. */
  async playground(bot: Chatbot, session: string, text: string) {
    text = cleanText(text);
    const channel = await store.getOrCreatePlaygroundChannel(bot);
    const contact = await store.upsertContact(channel, `playground:${session}`, '', 'Prueba');
    let conv = await store.getOrCreateConversation(channel, contact.id);
    const mark = await query<{ id: string }>(`SELECT coalesce(max(id), 0) AS id FROM event_logs WHERE conversation_id = $1`, [conv.id]);
    if (conv.status === 'closed') {
      // Como en un canal real: si el cliente vuelve a escribir, la conversación se reabre.
      await store.resetFlowState(conv.id);
      conv = (await store.setConversationStatus(conv.id, 'bot', '')) ?? conv;
    }
    const inserted = await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', type: 'text', content: maskSensitive(text), processed: false });
    // Las reglas automáticas también se prueban en el simulador.
    if (inserted) {
      const stopAi = await this.automator.onInbound(conv, contact, inserted, text).catch(() => false);
      if (stopAi) await store.markMessageProcessed(inserted.id);
    }
    const transport = new PlaygroundTransport();
    // Igual que en un canal real: el mensaje puede encender o apagar al asistente antes de la IA.
    const current = (await store.getConversation(conv.id)) ?? conv;
    let replies = true;
    if (inserted && current.status === 'bot') replies = await this.applyGate(bot, channel, current, contact, text, transport);
    const result: ProcessResult = replies
      ? await this.queue.exclusive(conv.id, () => this.engine.process(conv.id, transport, { ignoreInactive: true }))
      : (await store.markAllProcessed(conv.id), { status: 'paused' });
    await this.automator.settle(conv.id);
    const [freshContact, freshConv] = await Promise.all([store.getContact(contact.id), store.getConversation(conv.id)]);
    // Qué se activó en este turno (reglas, activación/pausa del asistente, objetivo, transferencias).
    const events = await query<{ level: string; message: string; created_at: Date }>(
      `SELECT level, message, created_at FROM event_logs WHERE conversation_id = $1 AND id > $2 ORDER BY id`,
      [conv.id, mark[0].id],
    );
    return {
      events,
      agent: freshConv ? this.engine.agentState(bot, freshConv) : null,
      outputs: transport.outputs,
      result: {
        status: result.status,
        action: result.plan?.action,
        thinking: (result.decision as any)?.thinking ?? '',
        info_not_found: result.plan?.infoNotFound ?? false,
        fallback_used: result.fallbackUsed ?? false,
        attempts: result.attempts ?? [],
        error: result.error,
      },
      contact: freshContact,
      conversation: freshConv,
    };
  }

  async playgroundMessages(bot: Chatbot, session: string) {
    return query(
      `SELECT m.*, i.code AS image_code FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
         JOIN channels ch ON ch.id = ct.channel_id
         LEFT JOIN images i ON i.id = m.image_id
       WHERE ch.chatbot_id = $1 AND ch.type = 'playground' AND ct.external_id = $2 ORDER BY m.id`,
      [bot.id, `playground:${session}`],
    );
  }

  async resetPlayground(bot: Chatbot, session: string) {
    await query(
      `DELETE FROM contacts WHERE external_id = $2 AND channel_id IN (SELECT id FROM channels WHERE chatbot_id = $1 AND type = 'playground')`,
      [bot.id, `playground:${session}`],
    );
  }

  /** Mensaje manual desde el panel (por la misma plataforma de la conversación). */
  async sendManual(conversationId: string, text: string, byUserId?: string) {
    const conv = await store.getConversation(conversationId);
    if (!conv) throw new Error('Conversación no encontrada');
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) throw new Error('Datos incompletos');
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const transport = channel.type === 'playground' ? new PlaygroundTransport() : this.transportFor(channel, contact);
    // Quién lo envió queda en el mensaje (las estadísticas por persona lo cuentan así).
    const sent = await this.queue.exclusive((await store.getConversation(conv.id))?.status==='human'?`human:${conv.id}`:conv.id,()=>this.engine.sendOut(bot, conv, transport, { sender: 'human', text, delay: 0, meta: { source: 'panel', ...(byUserId ? { user_id: byUserId } : {}) } }));
    if (!sent) throw new Error('No se pudo enviar el mensaje (revisa los registros)');
    return sent;
  }

  /**
   * Plantilla de WhatsApp enviada a mano (WhatsApp oficial; fuera de las 24 h es lo único que se puede enviar). Las
   * variables aceptan los datos del contacto ({{nombre}}…).
   */
  async sendManualTemplate(conversationId: string, templateId: string, params: string[], beforeSend?: () => Promise<void>, byUserId?: string) {
    const conv = await store.getConversation(conversationId);
    if (!conv) throw new Error('Conversación no encontrada');
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) throw new Error('Datos incompletos');
    const t = await templateForChannel(conv.account_id, channel, templateId);
    if (typeof t === 'string') throw new Error(`No se puede enviar: ${t}`);
    const settings = await astore.getSettings(conv.account_id);
    const values = params.map((p) => renderTemplate(p, { contact, conversation: conv, businessName: '', channelName: channel.name, timezone: settings.timezone }).trim());
    const n = templateVarCount(t.components);
    const empty = Array.from({ length: n }, (_, i) => i).find((i) => !values[i]);
    if (empty !== undefined) throw new Error(`Escribe el valor de la variable {{${empty + 1}}}`);
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const transport = this.transportFor(channel, contact);
    await beforeSend?.();
    const sent = await this.queue.exclusive((await store.getConversation(conv.id))?.status==='human'?`human:${conv.id}`:conv.id,()=>this.engine.sendOut(bot, conv, transport, {
      sender: 'human', text: fillBody(templateBody(t.components), values), template: outgoingTemplate(t, values), delay: 0,
      meta: { source: 'panel', wa_template: t.name, ...(byUserId ? { user_id: byUserId } : {}) },
    }));
    if (!sent) throw new Error('No se pudo enviar la plantilla (revisa los registros)');
    return sent;
  }

  /** Foto del catálogo enviada a mano desde el panel (por la misma plataforma de la conversación). */
  async sendManualImage(conversationId: string, imageId: string, beforeSend?: () => Promise<void>, byUserId?: string) {
    const conv = await store.getConversation(conversationId);
    if (!conv) throw new Error('Conversación no encontrada');
    const image = await store.getImage(imageId);
    const owner = image ? await store.getChatbot(image.chatbot_id) : null;
    if (!image || owner?.account_id !== conv.account_id) throw new Error('Foto no encontrada');
    if (!image.active) throw new Error('La foto está desactivada; actívala en Fotos para poder enviarla');
    const [channel, contact] = await Promise.all([store.getChannel(conv.channel_id), store.getContact(conv.contact_id)]);
    if (!channel || !contact) throw new Error('Datos incompletos');
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    const transport = channel.type === 'playground' ? new PlaygroundTransport() : this.transportFor(channel, contact);
    await beforeSend?.();
    const sent = await this.queue.exclusive((await store.getConversation(conv.id))?.status==='human'?`human:${conv.id}`:conv.id,()=>this.engine.sendOut(bot, conv, transport, { sender: 'human', text: image.caption, image, delay: 0, meta: { source: 'panel', ...(byUserId ? { user_id: byUserId } : {}) } }));
    if (!sent) throw new Error('No se pudo enviar la foto (revisa los registros)');
    return sent;
  }

  /** Al arrancar: retoma conversaciones con mensajes sin responder de los últimos minutos. */
  async resumePending() {
    const rows = await query<{conversation_id:string;state:string}>(`INSERT INTO conversation_work(conversation_id,run_at,state,reason)
      SELECT m.conversation_id,now()+interval '2 seconds',
        CASE WHEN max(m.created_at)<now()-interval '15 minutes' THEN 'dead' ELSE 'pending' END,
        CASE WHEN max(m.created_at)<now()-interval '15 minutes' THEN 'stale_pending' ELSE NULL END FROM messages m
      JOIN conversations c ON c.id=m.conversation_id JOIN channels ch ON ch.id=c.channel_id
      WHERE NOT m.processed AND m.direction='in' AND ch.type<>'playground'
      GROUP BY m.conversation_id ON CONFLICT(conversation_id) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,run_at=EXCLUDED.run_at WHERE conversation_work.state='done' RETURNING conversation_id,state`);
    for(const row of rows.filter(r=>r.state==='dead')) await this.aiUnavailable(row.conversation_id);
    return rows.length;
  }
}
