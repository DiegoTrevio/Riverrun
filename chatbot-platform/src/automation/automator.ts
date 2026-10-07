import * as assignment from './assignment.js';
import { deliverReport, reportRecipients } from './report-delivery.js';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config.js';
import { agentActive, gate } from '../engine/activation.js';
import { matchKeyword } from '../engine/engine.js';
import { imagesBeforeReply } from '../engine/images.js';
import { normalize } from '../engine/text.js';
import { dispatchEvent, eventData, publicEventFor } from '../integrations/webhooks.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { Channel, Chatbot, Contact, Conversation, Message } from '../types.js';
import * as astore from './store.js';
import { renderTemplate } from './templates.js';
import { addDays, isOpen, localParts, nextOpen, nextTimeOfDay, zonedToUtc } from './time.js';
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
      case 'agent': {
        const on = !!ctx.bot && agentActive(ctx.bot, ctx.conv, now);
        return c.state === 'on' ? on : !on;
      }
      default:
        return true;
    }
  });
}

/** Condición en palabras (para el probador). */
export function describeCondition(c: Condition): string {
  switch (c.type) {
    case 'channel': return `canal ${c.channel_types.join(' o ') || 'cualquiera'}`;
    case 'business_hours': return c.inside ? 'dentro del horario' : 'fuera del horario';
    case 'has_tag': return `${c.negate ? 'no tiene' : 'tiene'} la etiqueta "${c.tag}"`;
    case 'field': return `dato "${c.field}" ${({ present: 'tiene valor', absent: 'está vacío', equals: `es "${c.value}"`, contains: `contiene "${c.value}"` } as const)[c.op]}`;
    case 'status': return `conversación ${({ bot: 'con el bot', human: 'con una persona', closed: 'cerrada' } as const)[c.status]}`;
    case 'agent': return c.state === 'on' ? 'asistente activo' : 'asistente en pausa';
    default: return 'condición';
  }
}

/* ------------------------------ Webhooks salientes seguros ------------------------------ */

export function isPrivateIp(ip: string): boolean {
  const v4 = net.isIPv4(ip) ? ip.split('.').map(Number) : null;
  if (v4) {
    const [a, b, c] = v4;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || // "esta red", privada, loopback, multicast y reservadas
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19))
    );
  }
  if (!net.isIPv6(ip)) return true; // lo que no se reconoce no se permite
  const bytes = ipv6Bytes(ip);
  if (!bytes) return true;
  const zeros = (n: number) => bytes.slice(0, n).every((x) => x === 0);
  const embedded = (at: number) => isPrivateIp(bytes.slice(at, at + 4).join('.'));
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) return embedded(12); // ::ffff:a.b.c.d (cualquier escritura)
  if (zeros(12)) return bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] <= 1 ? true : embedded(12); // ::, ::1 y ::a.b.c.d
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((x) => x === 0)) return embedded(12); // 64:ff9b::/96
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embedded(2); // 2002::/16 (6to4)
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) >= 0x80) return true; // fe80::/10 y fec0::/10
  if (bytes[0] === 0xff) return true; // multicast
  return false;
}

/** Las 16 posiciones de una dirección IPv6 (acepta "::" y la cola con puntos). */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const q = tail[1].split('.').map(Number);
    if (q.some((n) => n > 255)) return null;
    s = s.slice(0, -tail[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
  }
  const [head, rest, extra] = s.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? [] : rest ? rest.split(':') : [];
  if (rest === undefined && h.length !== 8) return null;
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/.test(g) || Number.isNaN(n)) return null;
    out.push(n >> 8, n & 255);
  }
  return out;
}

/**
 * Resolución DNS que rechaza direcciones internas. Se usa en la conexión misma (no antes), así un dominio
 * que cambia de IP entre la revisión y la conexión ("DNS rebinding") tampoco llega a la red interna.
 */
export function safeLookup(hostname: string, options: any, callback: (err: Error | null, address?: any, family?: number) => void) {
  dns
    .lookup(hostname, { all: true })
    .then((addrs) => {
      const bad = addrs.find((a) => isPrivateIp(a.address));
      if (bad || !addrs.length) return callback(new Error('La URL apunta a una red interna; no está permitido'));
      if (options?.all) return callback(null, addrs);
      callback(null, addrs[0].address, addrs[0].family);
    })
    .catch((e) => callback(e));
}

/** POST firmado a un servicio externo (n8n, Zapier, CRM). Bloquea la red interna (evita SSRF). */
export async function postWebhook(url: string, body: unknown, secret: string) {
  const { status } = await postSigned(url, body, secret);
  if (status < 200 || status >= 300) throw new Error(`El webhook respondió ${status}`);
}

/** Igual, pero devuelve el código de respuesta (sin lanzar por 4xx/5xx) y permite cabeceras extra. */
export async function postSigned(url: string, body: unknown, secret: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number }> {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Solo se permiten URLs http(s)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!config.allowPrivateWebhooks && net.isIP(host) && isPrivateIp(host)) throw new Error('La URL apunta a una red interna; no está permitido');
  const payload = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-signature': `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`,
    'x-riverrun-timestamp': String(Math.floor(Date.now() / 1000)),
    ...extraHeaders,
  };
  const mod = u.protocol === 'https:' ? https : http;
  // Sin redirecciones (una redirección podría apuntar a la red interna) y con tiempo máximo de 10 s.
  const status = await new Promise<number>((resolve, reject) => {
    const req = mod.request(u, { method: 'POST', headers, timeout: 10_000, ...(config.allowPrivateWebhooks ? {} : { lookup: safeLookup as any }) }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('El webhook no respondió a tiempo')));
    const deadline = setTimeout(() => req.destroy(new Error('El webhook no respondió a tiempo')), 10_000); // tope total, aunque el servidor gotee bytes
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(payload);
  });
  return { status };
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

  async settleAll() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()].flatMap(set => [...set]));
  }

  /** Evalúa las reglas de un evento y ejecuta sus acciones. Devuelve si alguna pidió que la IA no responda. */
  async handle(e: AutomationEvent): Promise<{ stopAi: boolean; matched: string[] }> {
    const ctx = await this.loadCtx(e.conversationId);
    if (!ctx || ctx.channel.account_active === false) return { stopAi: false, matched: [] };
    if (e.type === 'handoff' && ctx.channel.type !== 'playground') {
      const who = ctx.contact.name || ctx.contact.push_name || 'Cliente';
      const alert = { link: `#/conversation/${ctx.conv.id}`, body: `${who} (${ctx.channel.name}): ${ctx.conv.handoff_reason || 'transferida'}` };
      const asg = ctx.settings.assignment;
      let assigned: string | null = null;
      if (e.byUserId && ctx.conv.assigned_user_id === e.byUserId) {
        assigned = e.byUserId; // la persona que la tomó ya la atiende: no se reparte ni se le avisa a ella misma
      } else if (asg.enabled && asg.on_handoff) {
        // Si ya tenía a alguien asignado (y sigue disponible) se le avisa a esa persona; si no, toca el siguiente turno.
        const current = ctx.conv.assigned_user_id ? (await assignment.eligibleUsers(ctx.conv.account_id, { roles: ['admin', 'agent'] })).find((u) => u.id === ctx.conv.assigned_user_id) : null;
        const user = current ?? (await assignment.assignRoundRobin(ctx.conv, { scope: 'handoff', roles: asg.roles, userIds: asg.user_ids, reason: 'transferencia a una persona' }));
        if (user) {
          assigned = user.id;
          ctx.conv.assigned_user_id = user.id;
          await this.alertTeam(ctx.conv.account_id, { ...alert, title: '📥 Te asignaron una conversación', userIds: [user.id], kind: 'assignment' });
        }
      }
      if (ctx.settings.notify_team_on_handoff && (!assigned || asg.notify_all)) {
        await this.alertTeam(ctx.conv.account_id, { ...alert, title: '🙋 Conversación esperando a una persona', kind: 'handoff' });
      }
    }
    // Webhooks de eventos de la cuenta (Zapier, Make, CRM…). El simulador del panel no dispara avisos reales.
    const publicEvent = publicEventFor(e);
    if (publicEvent && ctx.channel.type !== 'playground') {
      dispatchEvent(ctx.conv.account_id, publicEvent, eventData(e, ctx)).catch((err) => logEvent({ level: 'error', source: 'system', message: `Webhooks de eventos: ${err?.message ?? err}`, accountId: ctx.conv.account_id }));
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
        // Se leen las etiquetas actuales: otra regla (disparada en cadena) pudo agregar alguna mientras tanto.
        const current = (await store.getContact(ctx.contact.id))?.tags ?? ctx.contact.tags ?? [];
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
        if (isSim) return this.simulated(ctx, `🔔 Alerta al equipo${a.round_robin ? ' (a una persona, por turnos)' : ''} — ${rule.name}: ${this.render(a.message, ctx, e)}`);
        let userIds = a.user_ids.length ? a.user_ids : undefined;
        if (a.round_robin) {
          // Un solo aviso por evento, para quien sigue en el turno (entre las personas elegidas o las del rol).
          const pick = await assignment.nextInTurn(ctx.conv.account_id, `alert:${rule.id}`, await assignment.eligibleUsers(ctx.conv.account_id, { roles: a.roles, userIds: a.user_ids }));
          if (!pick) return void (await logEvent({ level: 'warn', source: 'engine', message: `Regla "${rule.name}": nadie disponible para el aviso por turnos`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id }));
          userIds = [pick.id];
        }
        await this.alertTeam(ctx.conv.account_id, {
          title: `🔔 ${rule.name}`,
          body: this.render(a.message, ctx, e),
          link: `#/conversation/${ctx.conv.id}`,
          userIds,
          roles: a.roles,
          phones: a.phones,
        });
        return;
      }
      case 'send_report': {
        if (isSim) return this.simulated(ctx, `📋 Enviaría el reporte de la conversación — ${rule.name}`);
        const users = await reportRecipients(ctx.conv.account_id, { userIds: a.user_ids, roles: a.user_ids.length ? undefined : a.roles });
        const r = await deliverReport(this.chat, ctx.conv.id, { users, emails: a.emails, phones: a.phones, note: a.note ? this.render(a.note, ctx, e) : `Regla "${rule.name}"`, includeTranscript: a.include_transcript, by: `regla "${rule.name}"` });
        if (!r.ok) await logEvent({ level: 'warn', source: 'engine', message: `Regla "${rule.name}": el reporte no se pudo entregar a nadie`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id });
        return;
      }
      case 'assign': {
        if (isSim) return this.simulated(ctx, `📥 Asignaría la conversación a la siguiente persona del turno — ${rule.name}`);
        const user = await assignment.assignRoundRobin(ctx.conv, { scope: `rule:${rule.id}`, roles: a.roles, userIds: a.user_ids, reason: `regla "${rule.name}"` });
        if (!user) return;
        ctx.conv.assigned_user_id = user.id;
        await this.alertTeam(ctx.conv.account_id, { title: '📥 Te asignaron una conversación', body: this.render(a.message, ctx, e), link: `#/conversation/${ctx.conv.id}`, userIds: [user.id], kind: 'assignment' });
        if (a.take_over && ctx.conv.status !== 'human') {
          await store.setConversationStatus(ctx.conv.id, 'human', `Asignada a ${user.name || user.email}`);
          await store.markAllProcessed(ctx.conv.id);
          ctx.conv.status = 'human';
        }
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
      case 'resume_bot': {
        // Devuelve la conversación al asistente y lo enciende (quita la pausa y cuenta como activado).
        await store.setConversationStatus(ctx.conv.id, 'bot', '');
        const on = await store.setAgentOn(ctx.conv.id);
        if (on) Object.assign(ctx.conv, on);
        ctx.conv.status = 'bot';
        await logEvent({ level: 'info', source: 'engine', message: `Asistente activado por la regla "${rule.name}"`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id });
        return;
      }
      case 'pause_bot': {
        const until = a.hours > 0 ? new Date(Date.now() + a.hours * 3600_000) : null;
        const reason = a.reason.trim() || `regla "${rule.name}"`;
        const off = await store.setAgentOff(ctx.conv.id, reason, until);
        if (off) Object.assign(ctx.conv, off);
        await store.markAllProcessed(ctx.conv.id);
        await logEvent({ level: 'info', source: 'engine', message: `Asistente en pausa: ${reason}${until ? ` (se reactiva en ${a.hours} h)` : ''}`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id });
        if (depth <= MAX_DEPTH) await this.handle({ type: 'agent_off', conversationId: ctx.conv.id, text: reason, depth });
        return;
      }
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
      await astore.setConsent(contact.id, true, 'keyword'); // volver a pedir mensajes es aceptarlos
      await this.chat.outbound.send(conv.id, { text: oo.resume_message, source: 'opt_out', transactional: true, allowWhenHuman: true });
      return true;
    }
    // Consentimiento: escribir "ACEPTO" (u otra frase configurada) autoriza recibir promociones.
    const co = settings.consent;
    if (norm && !contact.opted_out && !contact.consent_at && co.opt_in_keywords.some((k) => normalize(k) === norm)) {
      await astore.setConsent(contact.id, true, 'keyword');
      if (co.opt_in_message.trim()) await this.chat.outbound.send(conv.id, { text: co.opt_in_message, source: 'opt_out', transactional: true, allowWhenHuman: true });
      await logEvent({ level: 'info', source: 'engine', message: 'El cliente aceptó recibir promociones', accountId: conv.account_id, conversationId: conv.id });
      return true;
    }
    // Secuencias que se detienen cuando el cliente responde.
    await astore.stopEnrollmentsOnReply(conv.id);
    const first = await store.isFirstLiveInbound(conv.id, message.id);
    let stop = false;
    if (first) stop = (await this.handle({ type: 'new_contact', conversationId: conv.id, text })).stopAi || stop;
    stop = (await this.handle({ type: 'message_received', conversationId: conv.id, text, isFirstMessage: first })).stopAi || stop;
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

  /* ------------------------------ Probador (sin IA, sin enviar nada) ------------------------------ */

  /**
   * Qué pasaría si un cliente escribe `text`: bajas, reglas por mensaje, activadores/desactivadores del
   * asistente y palabras de transferencia, en el mismo orden que con un mensaje real. No guarda ni envía nada.
   */
  async testMessage(bot: Chatbot, o: { text: string; firstMessage: boolean; channelType: string; agent: 'on' | 'paused' | 'waiting'; tags: string[] }) {
    const [settings, account] = await Promise.all([astore.getSettings(bot.account_id), store.getAccount(bot.account_id)]);
    const now = new Date();
    const conv = {
      id: '', account_id: bot.account_id, channel_id: '', chatbot_id: bot.id, contact_id: '', status: 'bot', status_changed_at: now, handoff_reason: '',
      summary: '', summary_until_id: 0, last_message_at: now,
      agent_off_at: o.agent === 'paused' ? now : null, agent_off_reason: o.agent === 'paused' ? 'prueba' : '', agent_off_until: null,
      agent_on_at: o.agent === 'on' ? now : null,
    } as Conversation;
    const contact = { id: '', tags: o.tags, data: {}, name: '', opted_out: false } as unknown as Contact;
    const channel = { id: '', type: o.channelType, name: 'Prueba', active: true } as unknown as Channel;
    const ctx: Ctx = { conv, contact, channel, bot, settings, accountName: account?.name ?? '' };
    const steps: { kind: string; title: string; detail: string; ok: boolean }[] = [];
    const verdict = (reply: boolean, why: string) => ({ steps, rules, ai_replies: reply, why });
    const rules: { id: string; name: string; trigger: string; matched: boolean; reason: string; actions: string[]; stop_ai: boolean }[] = [];

    // 1) Bajas de mensajes promocionales.
    const norm = normalize(o.text).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const oo = settings.opt_out;
    const optOut = oo.enabled && norm ? oo.keywords.find((k) => normalize(k) === norm) : undefined;
    if (optOut) {
      steps.push({ kind: 'opt_out', title: 'Baja de mensajes', detail: `"${optOut}" da de baja al cliente: se le confirma y la IA no responde.`, ok: true });
      return verdict(false, 'El cliente se da de baja de los mensajes promocionales.');
    }

    // 2) Reglas por mensaje (las de intención las decide la IA: se prueban en el simulador).
    let stopAi = false;
    let after: 'bot' | 'human' | 'closed' = 'bot';
    let pausedByRule = false;
    let resumedByRule = false;
    const events: AutomationEvent[] = [
      ...(o.firstMessage ? [{ type: 'new_contact' as const, conversationId: '', text: o.text }] : []),
      { type: 'message_received', conversationId: '', text: o.text, isFirstMessage: o.firstMessage },
    ];
    for (const e of events) {
      for (const rule of await astore.activeAutomations(bot.account_id, e.type, bot.id)) {
        let reason = '';
        if (!triggerMatches(rule.trigger, e)) {
          const t = rule.trigger;
          reason = t.type === 'message_received' && t.first_message_only && !o.firstMessage ? 'solo aplica en el primer mensaje del cliente' : t.type === 'message_received' ? `el mensaje no coincide con: ${t.keywords.join(', ') || '(sin palabras)'}` : 'no aplica';
        } else {
          const failed = rule.conditions.find((c) => !conditionsMatch([c], ctx, now));
          if (failed) reason = `no se cumple la condición: ${describeCondition(failed)}`;
        }
        const matched = !reason;
        rules.push({ id: rule.id, name: rule.name, trigger: e.type, matched, reason: matched ? 'se activaría' : reason, actions: rule.actions.map((a) => a.type), stop_ai: rule.stop_ai });
        if (!matched) continue;
        if (rule.stop_ai) stopAi = true;
        for (const a of rule.actions) {
          if (a.type === 'handoff') after = 'human';
          if (a.type === 'close_conversation') after = 'closed';
          if (a.type === 'pause_bot') { pausedByRule = true; resumedByRule = false; }
          if (a.type === 'resume_bot') { after = 'bot'; pausedByRule = false; resumedByRule = true; }
        }
      }
    }
    const fired = rules.filter((r) => r.matched);
    steps.push({ kind: 'rules', title: 'Reglas automáticas', detail: fired.length ? `Se activarían: ${fired.map((r) => `"${r.name}"`).join(', ')}.` : rules.length ? 'Ninguna regla coincide con este mensaje.' : 'No hay reglas activas por mensaje.', ok: fired.length > 0 });
    if (after !== 'bot') return verdict(false, after === 'human' ? 'Una regla pasa la conversación a una persona.' : 'Una regla cierra la conversación.');
    if (resumedByRule) Object.assign(conv, { agent_off_at: null, agent_off_until: null, agent_on_at: now });
    if (pausedByRule) {
      steps.push({ kind: 'agent', title: 'Asistente', detail: 'Una regla lo pone en pausa en esta conversación.', ok: false });
      return verdict(false, 'Una regla pausa al asistente.');
    }

    // 3) Activadores y desactivadores del asistente.
    const g = gate(bot.rules.activation, conv, o.text, now);
    steps.push({
      kind: 'agent',
      title: 'Asistente',
      detail: g.change === 'on' ? `Se activa: ${g.reason}.` : g.change === 'off' ? `Se apaga: ${g.reason} (${({ pause: 'queda en pausa', handoff: 'pasa a una persona', close: 'se cierra la conversación' } as const)[bot.rules.activation.off_action]}).` : g.reply ? 'Está activo y responde.' : `No responde: ${g.reason}.`,
      ok: g.reply,
    });
    if (!g.reply) return verdict(false, g.change === 'off' ? 'El mensaje apaga al asistente.' : `El asistente no responde: ${g.reason}.`);

    // 4) Transferencia inmediata por palabra (sin IA).
    const kw = matchKeyword(o.text, bot.rules.handoff_keywords);
    if (kw) {
      steps.push({ kind: 'handoff', title: 'Pasar con una persona', detail: `"${kw}" pasa la conversación a una persona de inmediato.`, ok: true });
      return verdict(false, 'Pasa con una persona sin consultar a la IA.');
    }
    if (stopAi) return verdict(false, 'Una regla indica que la IA no responda este mensaje.');
    // 5) Fotos que el sistema envía solo junto con la respuesta (palabras del cliente o bienvenida).
    const photos = imagesBeforeReply(await store.listImages(bot.id, true), { text: o.text, firstReply: o.firstMessage, sentIds: [] });
    if (photos.length) steps.push({ kind: 'images', title: 'Fotos', detail: `Se enviarían: ${photos.map((p) => `"${p.image.name}" (${p.reason})`).join(', ')}.`, ok: true });
    if (!bot.active) return verdict(true, 'La IA respondería, pero el asistente está apagado: en tus canales no contestará hasta que lo enciendas.');
    return verdict(true, 'La IA respondería este mensaje.');
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
  async runSequenceStep(payload: { enrollment_id: string; step: number; first_due?: string }) {
    const en = await astore.getEnrollment(payload.enrollment_id);
    if (!en || en.status !== 'active' || en.current_step !== payload.step) return;
    const seq = await astore.getSequence(en.sequence_id);
    const ctx = await this.loadCtx(en.conversation_id);
    const stop = (reason: string) => astore.updateEnrollment(en.id, { status: 'stopped', stop_reason: reason, next_run_at: null });
    if (!seq || !seq.active) return stop('secuencia desactivada');
    if (!ctx) return stop('conversación eliminada');
    if (ctx.contact.opted_out) return stop('el cliente se dio de baja');
    if (ctx.conv.status === 'human') return stop('una persona está atendiendo la conversación');
    if (!ctx.channel.active || ctx.channel.account_active === false) {
      // Canal apagado o cuenta en pausa: la secuencia espera (hasta 7 días) en lugar de perderse.
      const firstDue = payload.first_due ? new Date(payload.first_due) : new Date();
      if (Date.now() - firstDue.getTime() > 7 * 86400_000) return stop('el canal o la cuenta siguen inactivos después de 7 días');
      const retryAt = new Date(Date.now() + 3600_000);
      await astore.updateEnrollment(en.id, { next_run_at: retryAt });
      await astore.scheduleJob({
        account_id: ctx.conv.account_id,
        type: 'sequence_step',
        payload: { enrollment_id: en.id, conversation_id: ctx.conv.id, step: payload.step, first_due: firstDue.toISOString() },
        run_at: retryAt,
      });
      return;
    }
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
    if (!ctx || ctx.channel.account_active === false || !conditionsMatch(rule.conditions, ctx)) return;
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
  if (step.at_time && step.delay_unit === 'days' && step.delay_value > 0) {
    // "N días después a las HH:MM" = ese día del calendario a esa hora (no la siguiente HH:MM después de N×24 h).
    const day = zonedToUtc(addDays(localParts(from, settings.timezone).date, step.delay_value), step.at_time, settings.timezone);
    t = day.getTime() > from.getTime() ? day : nextTimeOfDay(t, step.at_time, settings.timezone);
  } else if (step.at_time) {
    t = nextTimeOfDay(t, step.at_time, settings.timezone);
  }
  if (businessOnly) t = nextOpen(settings.business_hours, settings.holidays, t, settings.timezone);
  return t;
}
