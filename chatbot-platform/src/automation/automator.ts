import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { matchKeyword } from '../engine/engine.js';
import { normalize } from '../engine/text.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { Channel, Chatbot, Contact, Conversation, Message } from '../types.js';
import * as astore from './store.js';
import { renderTemplate } from './templates.js';
import { isOpen, nextOpen, nextTimeOfDay } from './time.js';
import type { AccountSettings, Action, Automation, AutomationEvent, Condition, SequenceStep, Trigger } from './types.js';

interface Ctx {
  conv: Conversation;
  contact: Contact;
  channel: Channel;
  bot: Chatbot | null;
  settings: AccountSettings;
  accountName: string;
}

const MAX_DEPTH = 3;

/* ------------------------------ Coincidencias ------------------------------ */

export function triggerMatches(t: Trigger, e: AutomationEvent): boolean {
  if (t.type !== e.type) return false;
  switch (t.type) {
    case 'message_received': {
      if (t.first_message_only && !e.isFirstMessage) return false;
      const text = e.text ?? '';
      const words = t.keywords.map((k) => k.trim()).filter(Boolean);
      if (t.match === 'any') return true;
      if (!words.length) return false;
      if (t.match === 'keywords') return !!matchKeyword(text, words);
      const norm = normalize(text).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (t.match === 'exact') return words.some((w) => normalize(w).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim() === norm);
      return words.some((w) => normalize(text).includes(normalize(w)));
    }
    case 'intent':
      return (e.intents ?? []).includes(t.intent);
    case 'data_captured':
      return !t.field || t.field === e.field;
    case 'tag_added':
      return normalize(t.tag) === normalize(e.tag ?? '');
    case 'appointment_booked':
    case 'appointment_cancelled':
      return !t.service_id || t.service_id === e.appointment?.service_id;
    default:
      return true;
  }
}

export function conditionsMatch(conditions: Condition[], ctx: Ctx, now = new Date()): boolean {
  return conditions.every((c) => {
    switch (c.type) {
      case 'channel':
        return !c.channel_types.length || c.channel_types.includes(ctx.channel.type);
      case 'business_hours':
        return isOpen(ctx.settings.business_hours, ctx.settings.holidays, now, ctx.settings.timezone) === c.inside;
      case 'has_tag': {
        const has = (ctx.contact.tags ?? []).some((t) => normalize(t) === normalize(c.tag));
        return c.negate ? !has : has;
      }
      case 'field': {
        const v = (c.field === 'nombre' ? ctx.contact.name || ctx.contact.data?.nombre : ctx.contact.data?.[c.field]) ?? '';
        if (c.op === 'present') return !!v;
        if (c.op === 'absent') return !v;
        if (c.op === 'equals') return normalize(v) === normalize(c.value);
        return normalize(v).includes(normalize(c.value));
      }
      case 'status':
        return ctx.conv.status === c.status;
      default:
        return true;
    }
  });
}

/* ------------------------------ Webhooks salientes seguros ------------------------------ */

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

/** POST firmado a un servicio externo (n8n, Zapier, CRM). Bloquea la red interna (evita SSRF). */
export async function postWebhook(url: string, body: unknown, secret: string) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Solo se permiten URLs http(s)');
  if (!config.allowPrivateWebhooks) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('La URL apunta a una red interna; no está permitido');
  }
  const payload = JSON.stringify(body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}` },
    body: payload,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`El webhook respondió ${res.status}`);
}

/* ------------------------------ Automatizador ------------------------------ */

export class Automator {
  /** Trabajo en curso por conversación (el simulador espera a que termine para mostrarlo). */
  private inflight = new Map<string, Set<Promise<unknown>>>();

  constructor(private chat: ChatService) {}

  private async loadCtx(conversationId: string): Promise<Ctx | null> {
    const conv = await store.getConversation(conversationId);
    if (!conv) return null;
    const [contact, channel, account] = await Promise.all([store.getContact(conv.contact_id), store.getChannel(conv.channel_id), store.getAccount(conv.account_id)]);
    if (!contact || !channel || !account) return null;
    const bot = conv.chatbot_id ? await store.getChatbot(conv.chatbot_id) : null;
    return { conv, contact, channel, bot, settings: await astore.getSettings(conv.account_id), accountName: account.name };
  }

  /** Dispara un evento sin esperar (desde el motor de IA o la agenda). */
  emit(e: AutomationEvent) {
    const p = this.handle(e).catch((err) =>
      logEvent({ level: 'error', source: 'engine', message: `Error en automatización (${e.type}): ${err?.message ?? err}`, conversationId: e.conversationId, details: err }),
    );
    let set = this.inflight.get(e.conversationId);
    if (!set) this.inflight.set(e.conversationId, (set = new Set()));
    set.add(p);
    void p.finally(() => {
      set!.delete(p);
      if (!set!.size) this.inflight.delete(e.conversationId);
    });
  }

  /** Espera a que terminen las automatizaciones pendientes de una conversación. */
  async settle(conversationId: string) {
    for (let i = 0; i < 5; i++) {
      const set = this.inflight.get(conversationId);
      if (!set?.size) return;
      await Promise.allSettled([...set]);
    }
  }

  /** Evalúa las reglas de un evento y ejecuta sus acciones. Devuelve si alguna pidió que la IA no responda. */
  async handle(e: AutomationEvent): Promise<{ stopAi: boolean; matched: string[] }> {
    const ctx = await this.loadCtx(e.conversationId);
    if (!ctx || ctx.channel.account_active === false) return { stopAi: false, matched: [] };
    if (e.type === 'handoff' && ctx.settings.notify_team_on_handoff && ctx.channel.type !== 'playground') {
      await this.alertTeam(ctx.conv.account_id, {
        title: '🙋 Conversación esperando a una persona',
        body: `${ctx.contact.name || ctx.contact.push_name || 'Cliente'} (${ctx.channel.name}): ${ctx.conv.handoff_reason || 'transferida'}`,
        link: `#/conversation/${ctx.conv.id}`,
        kind: 'handoff',
      });
    }
    const rules = await astore.activeAutomations(ctx.conv.account_id, e.type, ctx.conv.chatbot_id);
    const matched: string[] = [];
    let stopAi = false;
    for (const rule of rules) {
      if (!triggerMatches(rule.trigger, e) || !conditionsMatch(rule.conditions, ctx)) continue;
      matched.push(rule.name);
      if (rule.stop_ai) stopAi = true;
      await this.runRule(rule, ctx, e);
    }
    return { stopAi, matched };
  }

  private async runRule(rule: Automation, ctx: Ctx, e: AutomationEvent) {
    await astore.markAutomationRun(rule.id);
    await logEvent({ level: 'info', source: 'engine', message: `Regla ejecutada: "${rule.name}"`, accountId: ctx.conv.account_id, chatbotId: ctx.conv.chatbot_id, channelId: ctx.conv.channel_id, conversationId: ctx.conv.id });
    for (const [i, action] of rule.actions.entries()) {
      try {
        await this.runAction(action, ctx, rule, e, i);
      } catch (err: any) {
        await logEvent({ level: 'error', source: 'engine', message: `Regla "${rule.name}", acción ${action.type}: ${err?.message ?? err}`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id });
      }
    }
  }

  private render(text: string, ctx: Ctx, e: AutomationEvent) {
    return renderTemplate(text, {
      contact: ctx.contact,
      conversation: ctx.conv,
      businessName: ctx.bot?.name ?? ctx.accountName,
      channelName: ctx.channel.name,
      message: e.text,
      appointment: e.appointment,
      timezone: ctx.settings.timezone,
    });
  }

  /** En el simulador, las alertas y webhooks no salen: quedan como nota visible en la conversación de prueba. */
  private async simulated(ctx: Ctx, text: string) {
    await store.insertMessage({ conversation_id: ctx.conv.id, direction: 'out', sender: 'system', type: 'text', content: `(simulador) ${text}`, meta: { source: 'simulation' } });
  }

  private async runAction(a: Action, ctx: Ctx, rule: Automation, e: AutomationEvent, index: number) {
    const depth = (e.depth ?? 0) + 1;
    const isSim = ctx.channel.type === 'playground';
    switch (a.type) {
      case 'send_message': {
        const source = e.type === 'no_reply' ? 'no_reply' : 'automation';
        if (a.delay_minutes > 0) {
          await astore.scheduleJob({
            account_id: ctx.conv.account_id,
            type: 'automation_send',
            payload: { automation_id: rule.id, conversation_id: ctx.conv.id, text: a.text, image_id: a.image_id, source, appointment_id: e.appointment?.id ?? null },
            run_at: new Date(Date.now() + a.delay_minutes * 60_000),
            dedupe_key: `auto:${rule.id}:${index}:${ctx.conv.id}`,
          });
          return;
        }
        const r = await this.chat.outbound.send(ctx.conv.id, { text: a.text, imageId: a.image_id || undefined, source, appointment: e.appointment, meta: { automation_id: rule.id } });
        if (!r.sent) await logEvent({ level: 'info', source: 'engine', message: `Regla "${rule.name}": mensaje no enviado (${r.reason})`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id });
        return;
      }
      case 'add_tag':
      case 'remove_tag': {
        const tag = a.tag.trim();
        const current = ctx.contact.tags ?? [];
        const exists = current.some((t) => normalize(t) === normalize(tag));
        if (a.type === 'add_tag' && !exists) {
          ctx.contact.tags = [...current, tag];
          await astore.setTags(ctx.contact.id, ctx.contact.tags);
          if (depth <= MAX_DEPTH) await this.handle({ type: 'tag_added', conversationId: ctx.conv.id, tag, depth });
        } else if (a.type === 'remove_tag' && exists) {
          ctx.contact.tags = current.filter((t) => normalize(t) !== normalize(tag));
          await astore.setTags(ctx.contact.id, ctx.contact.tags);
        }
        return;
      }
      case 'set_field': {
        const value = this.render(a.value, ctx, e);
        ctx.contact.data = { ...(ctx.contact.data ?? {}), [a.field]: value };
        await store.updateContact(ctx.contact.id, { data: ctx.contact.data });
        if (depth <= MAX_DEPTH) await this.handle({ type: 'data_captured', conversationId: ctx.conv.id, field: a.field, depth });
        return;
      }
      case 'alert_team': {
        if (isSim) return this.simulated(ctx, `🔔 Alerta al equipo — ${rule.name}: ${this.render(a.message, ctx, e)}`);
        await this.alertTeam(ctx.conv.account_id, {
          title: `🔔 ${rule.name}`,
          body: this.render(a.message, ctx, e),
          link: `#/conversation/${ctx.conv.id}`,
          userIds: a.user_ids.length ? a.user_ids : undefined,
          roles: a.roles,
          phones: a.phones,
        });
        return;
      }
      case 'handoff': {
        if (ctx.conv.status === 'human') return;
        await store.setConversationStatus(ctx.conv.id, 'human', a.reason);
        await store.markAllProcessed(ctx.conv.id);
        ctx.conv.status = 'human';
        ctx.conv.handoff_reason = a.reason;
        if (depth <= MAX_DEPTH) await this.handle({ type: 'handoff', conversationId: ctx.conv.id, depth });
        return;
      }
      case 'resume_bot':
        await store.setConversationStatus(ctx.conv.id, 'bot', '');
        ctx.conv.status = 'bot';
        return;
      case 'close_conversation':
        await store.setConversationStatus(ctx.conv.id, 'closed', `Cerrada por la regla "${rule.name}"`);
        ctx.conv.status = 'closed';
        return;
      case 'start_sequence':
        await this.enroll(a.sequence_id, ctx.conv.id, `regla "${rule.name}"`);
        return;
      case 'stop_sequences':
        await astore.stopEnrollments(ctx.conv.id, `regla "${rule.name}"`);
        return;
      case 'webhook':
        if (isSim) return this.simulated(ctx, `🔗 Se llamaría al webhook ${a.url}`);
        await postWebhook(
          a.url,
          {
            event: e.type,
            rule: rule.name,
            account_id: ctx.conv.account_id,
            conversation_id: ctx.conv.id,
            channel: { type: ctx.channel.type, name: ctx.channel.name },
            contact: { name: ctx.contact.name || ctx.contact.push_name, phone: ctx.contact.phone, data: ctx.contact.data, tags: ctx.contact.tags },
            message: e.text ?? null,
            appointment: e.appointment ?? null,
            at: new Date().toISOString(),
          },
          ctx.settings.webhook_secret,
        );
        return;
    }
  }

  /* ------------------------------ Alertas al equipo ------------------------------ */

  /** Notificación en el panel y, a quien lo tenga activado, por WhatsApp. */
  async alertTeam(accountId: string, o: { title: string; body: string; link?: string; userIds?: string[]; roles?: ('admin' | 'agent')[]; phones?: string[]; kind?: string }) {
    const team = await astore.teamMembers(accountId, ['admin', 'agent']);
    const recipients = o.userIds?.length ? team.filter((u) => o.userIds!.includes(u.id)) : team.filter((u) => (o.roles ?? ['admin', 'agent']).includes(u.role as 'admin'));
    await astore.notifyUsers(accountId, recipients.map((u) => u.id), { title: o.title, body: o.body, link: o.link, kind: o.kind });
    const link = o.link ? `\n${config.publicBaseUrl}/${o.link}` : '';
    const phones = new Set([...recipients.filter((u) => u.notify_whatsapp && u.phone).map((u) => u.phone), ...(o.phones ?? []).map((p) => p.replace(/\D/g, '')).filter(Boolean)]);
    for (const phone of phones) {
      try {
        await this.chat.sendInternalWhatsapp(accountId, phone, `*${o.title}*\n${o.body}${link}`);
      } catch (e: any) {
        await logEvent({ level: 'warn', source: 'channel', message: `Alerta no enviada por WhatsApp a ${phone}: ${e?.message ?? e}`, accountId });
      }
    }
  }

  /* ------------------------------ Mensajes entrantes ------------------------------ */

  /**
   * Antes de la IA: bajas, secuencias que se detienen al responder y reglas por mensaje.
   * Devuelve true si la IA no debe responder este mensaje.
   */
  async onInbound(conv: Conversation, contact: Contact, message: Message, text: string): Promise<boolean> {
    const settings = await astore.getSettings(conv.account_id);
    const norm = normalize(text).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const oo = settings.opt_out;
    if (oo.enabled && norm && oo.keywords.some((k) => normalize(k) === norm)) {
      await astore.setOptOut(contact.id, true);
      await astore.stopEnrollments(conv.id, 'el cliente se dio de baja');
      await this.chat.outbound.send(conv.id, { text: oo.confirm_message, source: 'opt_out', transactional: true, allowWhenHuman: true });
      await logEvent({ level: 'info', source: 'engine', message: 'El cliente se dio de baja de los mensajes', accountId: conv.account_id, conversationId: conv.id });
      await this.handle({ type: 'opt_out', conversationId: conv.id, text });
      return true;
    }
    if (oo.enabled && contact.opted_out && norm && oo.resume_keywords.some((k) => normalize(k) === norm)) {
      await astore.setOptOut(contact.id, false);
      await this.chat.outbound.send(conv.id, { text: oo.resume_message, source: 'opt_out', transactional: true, allowWhenHuman: true });
      return true;
    }
    // Secuencias que se detienen cuando el cliente responde.
    await astore.stopEnrollmentsOnReply(conv.id);
    const first = (await store.countInbound(conv.id)) === 1;
    let stop = false;
    if (first) stop = (await this.handle({ type: 'new_contact', conversationId: conv.id, text })).stopAi || stop;
    stop = (await this.handle({ type: 'message_received', conversationId: conv.id, text, isFirstMessage: first })).stopAi || stop;
    void message;
    return stop;
  }

  /** Después de cada mensaje enviado: programa los seguimientos por falta de respuesta. */
  async onOutbound(conv: Conversation, msg: Message) {
    if (msg.meta?.source === 'no_reply' || msg.meta?.source === 'opt_out') return;
    const rules = await astore.activeAutomations(conv.account_id, 'no_reply', conv.chatbot_id);
    for (const rule of rules) {
      if (rule.trigger.type !== 'no_reply') continue;
      await astore.scheduleJob({
        account_id: conv.account_id,
        type: 'no_reply',
        payload: { automation_id: rule.id, conversation_id: conv.id, after_message_id: msg.id },
        run_at: new Date(Date.now() + rule.trigger.minutes * 60_000),
        dedupe_key: `noreply:${rule.id}:${conv.id}`,
      });
    }
  }

  /** Intenciones que la IA debe detectar (de las reglas activas). */
  async intentsFor(accountId: string, chatbotId: string | null) {
    const rules = await astore.activeAutomations(accountId, 'intent', chatbotId);
    const seen = new Map<string, string>();
    for (const r of rules) if (r.trigger.type === 'intent' && !seen.has(r.trigger.intent)) seen.set(r.trigger.intent, r.trigger.description);
    return [...seen].map(([intent, description]) => ({ intent, description }));
  }

  /* ------------------------------ Secuencias ------------------------------ */

  async enroll(sequenceId: string, conversationId: string, by: string) {
    const [seq, conv] = await Promise.all([astore.getSequence(sequenceId), store.getConversation(conversationId)]);
    if (!seq || !conv || seq.account_id !== conv.account_id) throw new Error('Secuencia no encontrada');
    if (!seq.active) throw new Error('La secuencia está desactivada');
    const last = await astore.lastInbound(conv.id);
    const enrollment = await astore.createEnrollment(conv.account_id, seq.id, conv.id, last?.id ?? 0);
    if (!enrollment) return null; // ya estaba inscrito
    const settings = await astore.getSettings(conv.account_id);
    const runAt = stepTime(new Date(), seq.steps[0], settings, seq.business_hours_only);
    await astore.updateEnrollment(enrollment.id, { next_run_at: runAt });
    await astore.scheduleJob({
      account_id: conv.account_id,
      type: 'sequence_step',
      payload: { enrollment_id: enrollment.id, conversation_id: conv.id, step: 0 },
      run_at: runAt,
    });
    await logEvent({ level: 'info', source: 'engine', message: `Inscrito en la secuencia "${seq.name}" (${by})`, accountId: conv.account_id, conversationId: conv.id });
    return enrollment;
  }

  /** Tarea programada: envía un paso de secuencia y programa el siguiente. */
  async runSequenceStep(payload: { enrollment_id: string; step: number }) {
    const en = await astore.getEnrollment(payload.enrollment_id);
    if (!en || en.status !== 'active' || en.current_step !== payload.step) return;
    const seq = await astore.getSequence(en.sequence_id);
    const ctx = await this.loadCtx(en.conversation_id);
    const stop = (reason: string) => astore.updateEnrollment(en.id, { status: 'stopped', stop_reason: reason, next_run_at: null });
    if (!seq || !seq.active) return stop('secuencia desactivada');
    if (!ctx) return stop('conversación eliminada');
    if (ctx.contact.opted_out) return stop('el cliente se dio de baja');
    if (ctx.conv.status === 'human') return stop('una persona está atendiendo la conversación');
    if (seq.stop_on_reply) {
      const last = await astore.lastInbound(ctx.conv.id);
      if (last && last.id > en.last_inbound_id) return stop('el cliente respondió');
    }
    const step = seq.steps[payload.step];
    if (step && conditionsMatch(step.conditions, ctx)) {
      const r = await this.chat.outbound.send(ctx.conv.id, { text: step.text, imageId: step.image_id || undefined, source: 'sequence', meta: { sequence_id: seq.id, step: payload.step } });
      if (!r.sent) return stop(r.reason);
    }
    const next = payload.step + 1;
    if (next >= seq.steps.length) return astore.updateEnrollment(en.id, { status: 'completed', current_step: next, next_run_at: null, last_step: true });
    const runAt = stepTime(new Date(), seq.steps[next], ctx.settings, seq.business_hours_only);
    await astore.updateEnrollment(en.id, { current_step: next, next_run_at: runAt, last_step: true });
    await astore.scheduleJob({ account_id: ctx.conv.account_id, type: 'sequence_step', payload: { enrollment_id: en.id, conversation_id: ctx.conv.id, step: next }, run_at: runAt });
  }

  /** Tarea programada: seguimiento si el cliente no respondió. */
  async runNoReply(payload: { automation_id: string; conversation_id: string; after_message_id: number }) {
    const rule = await astore.getAutomation(payload.automation_id);
    if (!rule || !rule.active || rule.trigger.type !== 'no_reply') return;
    const last = await astore.lastInbound(payload.conversation_id);
    if (last && last.id > payload.after_message_id) return; // sí respondió
    const ctx = await this.loadCtx(payload.conversation_id);
    if (!ctx || !conditionsMatch(rule.conditions, ctx)) return;
    await this.runRule(rule, ctx, { type: 'no_reply', conversationId: ctx.conv.id });
  }

  /** Tarea programada: mensaje de una regla con espera. */
  async runDelayedSend(payload: { automation_id: string; conversation_id: string; text: string; image_id: string; source: string; appointment_id: string | null }) {
    const rule = await astore.getAutomation(payload.automation_id);
    if (!rule || !rule.active) return;
    const appointment = payload.appointment_id ? await astore.getAppointment(payload.appointment_id) : null;
    const r = await this.chat.outbound.send(payload.conversation_id, { text: payload.text, imageId: payload.image_id || undefined, source: payload.source, appointment, meta: { automation_id: rule.id } });
    if (!r.sent) await logEvent({ level: 'info', source: 'engine', message: `Regla "${rule.name}": mensaje programado no enviado (${r.reason})`, conversationId: payload.conversation_id, accountId: rule.account_id });
  }
}

/** Momento de envío de un paso: espera + hora del día opcional + horario del negocio. */
export function stepTime(from: Date, step: SequenceStep, settings: AccountSettings, businessOnly: boolean): Date {
  const unit = step.delay_unit === 'days' ? 86400_000 : step.delay_unit === 'hours' ? 3600_000 : 60_000;
  let t = new Date(from.getTime() + step.delay_value * unit);
  if (step.at_time) t = nextTimeOfDay(t, step.at_time, settings.timezone);
  if (businessOnly) t = nextOpen(settings.business_hours, settings.holidays, t, settings.timezone);
  return t;
}
