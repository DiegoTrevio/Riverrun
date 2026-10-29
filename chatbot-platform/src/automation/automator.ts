import { eventVars, lookupVars } from './template-vars.js';
import * as assignment from './assignment.js';
import { alertChannels, groupsRepeats } from './alert-groups.js';
import { conversationAlert } from './alert-format.js';
import { deliverReport, reportRecipients } from './report-delivery.js';
import { briefReport } from '../engine/report-format.js';
import { imageSendWhen } from '../types.js';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { DeliveryUncertain, OwnershipLost } from '../engine/coordination.js';
import { emailSuperadmin } from '../platform/digest.js';
import { attemptDelivery, isImportantAlert, newAlertKey, queueDelivery, type Receipt } from './alert-delivery.js';
import { assertOutbound } from '../outbound-guard.js';
import { agentActive, gate } from '../engine/activation.js';
import { matchKeyword } from '../engine/engine.js';
import { imagesBeforeReply } from '../engine/images.js';
import { normalize } from '../engine/text.js';
import { dispatchEvent, eventData, publicEventFor } from '../integrations/webhooks.js';
import { CONTENT_LABEL, sendConversation } from '../integrations/conversation-export.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { Channel, Chatbot, Contact, Conversation, Message } from '../types.js';
import * as astore from './store.js';
import { renderTemplate } from './templates.js';
import type { OutboundResult, PendingButtons } from './outbound.js';
import { matchChoice, parsePayload } from './buttons.js';
import { addDays, isOpen, localParts, nextOpen, nextTimeOfDay, zonedToUtc } from './time.js';
import type { AccountSettings, Action, Automation, AutomationEvent, Condition, SequenceStep, Trigger, WaTemplateRef } from './types.js';

interface Ctx {
  conv: Conversation;
  contact: Contact;
  channel: Channel;
  bot: Chatbot | null;
  settings: AccountSettings;
  accountName: string;
  /** Variables de la regla en curso: las del evento y las que consultan la base (template-vars.ts). */
  vars?: Record<string, string>;
}

const MAX_DEPTH = 3;
/** Tras elegir, el mismo texto escrito otra vez cuenta como repetido (y no se contesta) durante este tiempo. */
const USED_TYPED_MS = 2 * 60_000;
/** Disparadores que vienen de algo que hizo el cliente: el flujo que inician le contesta (no pide consentimiento). */
const CUSTOMER_TRIGGERS = new Set<string | undefined>(['message_received', 'new_contact', 'intent', 'data_captured']);
/** Mientras el cliente haya escrito en estas horas, un flujo que él empezó le sigue contestando. */
const CUSTOMER_WINDOW_MS = 24 * 3600_000;

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
      // La IA devuelve las intenciones normalizadas (minúsculas, sin acentos): se compara igual.
      return (e.intents ?? []).some((i) => normalize(i) === normalize(t.intent));
    case 'data_captured':
      return !t.field || t.field === e.field;
    case 'stage_reached':
      return !t.step || t.step === e.step;
    case 'pipeline_stage':
      return (!t.pipeline_id || t.pipeline_id === e.pipeline?.id) && (!t.stage_id || t.stage_id === e.pipeline?.stage_id);
    case 'tag_added':
      return normalize(t.tag) === normalize(e.tag ?? '');
    case 'appointment_booked':
    case 'appointment_cancelled':
      return !t.service_id || t.service_id === e.appointment?.service_id;
    case 'quote_sent':
      return !t.kind || t.kind === e.quote?.kind;
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
  // Sandbox: los webhooks de clientes solo salen a las URLs de OUTBOUND_SANDBOX_ALLOW (también cubre integrations/webhooks).
  assertOutbound(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!config.allowPrivateWebhooks && net.isIP(host) && isPrivateIp(host)) throw new Error('La URL apunta a una red interna; no está permitido');
  const payload = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-signature': `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`,
    'x-riverrun-timestamp': ts,
    // La firma con la hora adentro: quien la verifica puede rechazar una entrega vieja que alguien repita.
    'x-riverrun-signature': `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`,
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
    if (e.type === 'handoff') {
      // Una persona toma la conversación: sus flujos se detienen al momento y sus botones dejan de contar.
      await astore.stopEnrollments(ctx.conv.id, 'una persona tomó la conversación');
      await query(`UPDATE conversations SET pending_buttons = NULL WHERE id = $1`, [ctx.conv.id]);
    }
    if (e.type === 'handoff' && ctx.channel.type !== 'playground') {
      // Si alguien contestó desde el teléfono, ya hay una persona atendiendo: no es una espera. Se reparte igual (queda a
      // cargo de alguien del panel), pero sin «esperando a una persona».
      const fromPhone = e.via === 'telefono';
      // El aviso lleva quién es el cliente, el motivo, el resumen y los datos ya capturados: quien atiende sabe de qué va
      // antes de abrir la conversación.
      const brief = await briefReport(ctx.conv.id, 1500, { customer: false }).catch(() => '');
      const alert = {
        link: `#/conversation/${ctx.conv.id}`,
        body: conversationAlert({ contact: ctx.contact, channel: ctx.channel.name, reason: ctx.conv.handoff_reason || 'transferida', brief }),
        conversationId: ctx.conv.id,
        // El encargado del agente (handoff_notify_number) ya recibió su propio aviso con el resumen: no le llega otro igual.
        // Solo si de verdad le llegó (una regla o un botón de un flujo no se lo mandan; un envío puede fallar).
        skipPhones: e.managerNotified ? [e.managerNotified] : [],
      };
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
          // Un solo aviso para quien la recibe: «te asignaron» ya dice que espera a una persona.
          await this.alertTeam(ctx.conv.account_id, { ...alert, title: fromPhone ? '📥 Te asignaron una conversación' : '📥 Te asignaron una conversación que espera a una persona', userIds: [user.id], kind: 'assignment', conversationId: undefined });
        }
      }
      if (!fromPhone && ctx.settings.notify_team_on_handoff && (!assigned || asg.notify_all)) {
        await this.alertTeam(ctx.conv.account_id, { ...alert, title: '🙋 Conversación esperando a una persona', kind: 'handoff', excludeUserIds: assigned ? [assigned] : [] });
      }
    }
    // Pipeline: la solicitud se crea en su primera columna y avanza según lo que pasa (antes de las reglas, que pueden
    // reaccionar al cambio de columna).
    await this.chat.pipelines.onEvent(e, ctx.conv, ctx.channel.type).catch((err) =>
      logEvent({ level: 'error', source: 'engine', message: `Pipeline (${e.type}): ${err?.message ?? err}`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id, details: err }),
    );
    // Webhooks de eventos de la cuenta (Zapier, Make, CRM…). El simulador del panel no dispara avisos reales.
    const publicEvent = publicEventFor(e);
    if (publicEvent && ctx.channel.type !== 'playground') {
      dispatchEvent(ctx.conv.account_id, publicEvent, eventData(e, ctx), { origin: e.origin }).catch((err) => logEvent({ level: 'error', source: 'system', message: `Webhooks de eventos: ${err?.message ?? err}`, accountId: ctx.conv.account_id }));
    }
    const rules = await astore.activeAutomations(ctx.conv.account_id, e.type, ctx.conv.chatbot_id);
    const matched: string[] = [];
    let stopAi = false;
    for (const rule of rules) {
      if (!triggerMatches(rule.trigger, e) || !conditionsMatch(rule.conditions, ctx)) continue;
      // «Una vez por conversación»: si ya se ejecutó en este recorrido, no se repite (ni detiene a la IA).
      if (rule.once_per_conversation && !(await astore.claimConversationRun(rule.id, ctx.conv.id, ctx.conv.flow_started_at))) continue;
      matched.push(rule.name);
      if (rule.stop_ai) stopAi = true;
      await this.runRule(rule, ctx, e);
    }
    return { stopAi, matched };
  }

  private async runRule(rule: Automation, ctx: Ctx, e: AutomationEvent) {
    await astore.markAutomationRun(rule.id);
    const texts = rule.actions.flatMap((a) => Object.values(a).filter((v): v is string => typeof v === 'string'));
    // Si una consulta de variables falla, las acciones corren igual (esas variables quedan vacías).
    const looked = await lookupVars(texts, { accountId: ctx.conv.account_id, contactId: ctx.contact.id, data: ctx.contact.data, assignedUserId: ctx.conv.assigned_user_id, timezone: ctx.settings.timezone }).catch(() => ({}));
    ctx = { ...ctx, vars: { ...looked, ...eventVars(e, ctx.settings.timezone) } };
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
      vars: ctx.vars ?? eventVars(e, ctx.settings.timezone),
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
            // Las variables del evento (cobro, cotización) se guardan: al enviarse ya no está el evento.
            payload: { automation_id: rule.id, conversation_id: ctx.conv.id, text: a.text, image_id: a.image_id, attachment_id: a.attachment_id, wa_template: a.wa_template ?? null, source, appointment_id: e.appointment?.id ?? null, vars: eventVars(e, ctx.settings.timezone) },
            run_at: new Date(Date.now() + a.delay_minutes * 60_000),
            dedupe_key: `auto:${rule.id}:${index}:${ctx.conv.id}`,
          });
          return;
        }
        const r = await this.chat.outbound.send(ctx.conv.id, { text: a.text, imageId: a.image_id || undefined, attachmentId: a.attachment_id || undefined, waTemplate: a.wa_template, source, appointment: e.appointment, vars: eventVars(e, ctx.settings.timezone), meta: { automation_id: rule.id } });
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
        const message = this.render(a.message, ctx, e);
        await this.alertTeam(ctx.conv.account_id, {
          title: `🔔 ${rule.name}`,
          body: conversationAlert({ contact: ctx.contact, channel: ctx.channel.name, extra: message }),
          link: `#/conversation/${ctx.conv.id}`,
          conversationId: ctx.conv.id,
          userIds,
          roles: a.roles,
          // Los números extra de la regla no son del equipo: reciben solo el mensaje que escribió quien la configuró
          // (como antes), sin el nombre ni el teléfono del cliente.
          phones: a.phones,
          phonesBody: message,
          kind: 'rule',
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
        await this.alertTeam(ctx.conv.account_id, { title: '📥 Te asignaron una conversación', body: conversationAlert({ contact: ctx.contact, channel: ctx.channel.name, reason: `regla «${rule.name}»`, extra: this.render(a.message, ctx, e) }), link: `#/conversation/${ctx.conv.id}`, userIds: [user.id], kind: 'assignment' });
        if (a.take_over && ctx.conv.status !== 'human') {
          await store.setConversationStatus(ctx.conv.id, 'human', `Asignada a ${user.name || user.email}`);
          await store.markHandoff(ctx.conv.contact_id, user.id, 'regla');
          await store.markAllProcessed(ctx.conv.id);
          ctx.conv.status = 'human';
        }
        return;
      }
      case 'handoff': {
        if (ctx.conv.status === 'human') return;
        await store.setConversationStatus(ctx.conv.id, 'human', a.reason);
        await store.markHandoff(ctx.conv.contact_id, null, 'regla');
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
      case 'create_task': {
        // Se cuenta por caracteres (no por unidades de código) para no partir un emoji al recortar.
        const body = [...this.render(a.body, ctx, e).trim()].slice(0, 1000).join('');
        if (isSim) return this.simulated(ctx, `📝 Crearía ${a.kind === 'nota' ? 'una nota' : 'un pendiente'}: "${body}" — ${rule.name}`);
        if (!body) return;
        // Queda vinculado a la conversación donde se disparó la regla: así se sabe dónde se quedó.
        await store.insertContactTask({
          account_id: ctx.conv.account_id,
          contact_id: ctx.contact.id,
          conversation_id: ctx.conv.id,
          kind: a.kind,
          body,
          due_on: a.due_days > 0 ? addDays(localParts(new Date(), ctx.settings.timezone).date, a.due_days) : null,
          created_by: null,
          created_via: 'regla',
        });
        return;
      }
      case 'close_conversation':
        await store.setConversationStatus(ctx.conv.id, 'closed', `Cerrada por la regla "${rule.name}"`);
        ctx.conv.status = 'closed';
        return;
      case 'start_sequence':
        await this.enroll(a.sequence_id, ctx.conv.id, `regla "${rule.name}"`, { byCustomer: CUSTOMER_TRIGGERS.has(rule.trigger?.type) });
        return;
      case 'stop_sequences':
        await astore.stopEnrollments(ctx.conv.id, `regla "${rule.name}"`);
        return;
      case 'send_conversation':
        if (isSim) return this.simulated(ctx, `📤 Enviaría ${CONTENT_LABEL[a.content]} a tu app — ${rule.name}`);
        await sendConversation(ctx.conv.account_id, ctx.conv.id, {
          content: a.content, endpointId: a.endpoint_id, refresh: (id) => this.chat.summarize(id), reason: `regla "${rule.name}"`,
          // Qué la disparó: la app puede decidir qué hacer según el motivo (etiqueta, intención, objetivo…).
          trigger: { rule: rule.name, event: e.type, ...(e.tag ? { tag: e.tag } : {}), ...(e.field ? { field: e.field } : {}), ...(e.intents?.length ? { intents: e.intents } : {}), ...(e.step ? { step: e.step } : {}) },
        });
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

  /**
   * Tarea programada: foto que el sistema debía enviar al marcarse una etapa/objetivo (o por una regla del negocio) y que no
   * salió en su momento. Se entrega si sigue vigente: el recorrido no se reinició, la foto no llegó ya, y ninguna persona
   * ha respondido desde entonces. Si la plataforma la rechaza otra vez, lanza el error para que el programador reintente.
   */
  async runDeferredImage(p: { conversation_id: string; image_id: string; reason: string; journey: string | null; at: string; allow_ended: boolean; allow_repeat?: boolean }) {
    const conv = await store.getConversation(p.conversation_id);
    if (!conv) return;
    const skip = (why: string) => logEvent({ level: 'info', source: 'engine', message: `Foto pendiente no enviada (${why})`, accountId: conv.account_id, chatbotId: conv.chatbot_id, conversationId: conv.id, details: { image_id: p.image_id, reason: p.reason } });
    const journey = conv.flow_started_at ? new Date(conv.flow_started_at).toISOString() : null;
    if (journey !== p.journey) return skip('el recorrido se reinició');
    if (conv.status !== 'bot' && !p.allow_ended) return skip('ya no atiende el asistente');
    // El cliente pausó al asistente (palabra de desactivación) después de programarse: ya no se envía.
    if (!p.allow_ended && conv.chatbot_id) {
      const bot = await store.getChatbot(conv.chatbot_id);
      if (bot && !agentActive(bot, conv)) return skip('el asistente está en pausa');
    }
    const human = await store.lastHumanActivity(conv.id);
    if (human && human.getTime() > new Date(p.at).getTime()) return skip('una persona respondió');
    const image = await store.getImage(p.image_id);
    if (!image || !image.active) return skip('la foto ya no está activa');
    if (await store.imageSentSince(conv.id, image.id, new Date(p.at))) return skip('ya llegó desde que se programó');
    // "Una sola vez" no aplica cuando el cliente la pidió de nuevo (por eso se programó).
    if (!p.allow_repeat && imageSendWhen(image).once && (await store.sentImageIds(conv.id)).includes(image.id)) return skip('ya se había enviado (solo una vez por conversación)');
    const r = await this.chat.outbound.send(conv.id, { imageId: image.id, source: 'flow', transactional: true, allowWhenHuman: p.allow_ended, meta: { image_trigger: p.reason, deferred: true } });
    if (r.sent) {
      await logEvent({ level: 'info', source: 'engine', message: `Foto enviada por regla (pendiente): ${image.code} (${p.reason})`, accountId: conv.account_id, chatbotId: conv.chatbot_id, channelId: conv.channel_id, conversationId: conv.id });
    } else if (/rechaz/.test(r.reason)) {
      throw new Error(`${image.code}: ${r.reason}`);
    } else {
      await skip(r.reason);
    }
  }

  /* ------------------------------ Alertas al equipo ------------------------------ */

  /**
   * Avisa al equipo. Un aviso de una conversación (conversationId) o de una cita (staffId) llega siempre a los administradores,
   * y a un agente solo si tiene esa conversación o cita asignada: lo demás no lo puede abrir.
   * Cada persona recibe el aviso por donde eligió en «Mis avisos» (panel, WhatsApp, correo; ver alert-groups). El mismo
   * aviso (título y texto) de la misma conversación no le llega dos veces en 10 minutos por ningún canal (salvo fallas,
   * emergencias y recordatorios). excludeUserIds: quienes ya recibieron otro aviso del mismo caso; skipPhones: números que
   * ya recibieron su propio aviso (el encargado del agente). phonesBody: el texto para los números externos (o.phones),
   * que no son del equipo: solo lo que escribió quien configuró el aviso, sin los datos del cliente.
   */
  async alertTeam(accountId: string, o: { title: string; body: string; link?: string; userIds?: string[]; roles?: ('admin' | 'agent')[]; phones?: string[]; phonesBody?: string; kind?: string; conversationId?: string; staffId?: string | null; excludeUserIds?: string[]; skipPhones?: string[] }) {
    const team = await astore.teamMembers(accountId, ['admin', 'agent']);
    const picked = o.userIds?.length ? team.filter((u) => o.userIds!.includes(u.id)) : team.filter((u) => (o.roles ?? ['admin', 'agent']).includes(u.role as 'admin'));
    const owner = o.conversationId ? await astore.assigneeOf(o.conversationId) : o.staffId;
    let recipients = (o.conversationId || o.staffId !== undefined ? team.filter((u) => u.role === 'admin' || (picked.includes(u) && u.id === owner)) : picked)
      .filter((u) => !o.excludeUserIds?.includes(u.id));
    // Nadie a quién avisar (sin administradores activos, todos excluidos): no se pierde en silencio.
    if (!recipients.length && !o.phones?.length && !o.excludeUserIds?.length) await this.noRecipients(accountId, o.kind, o.title).catch(() => undefined);
    if (o.conversationId && o.link && groupsRepeats(o.kind)) {
      // Mismo aviso = mismo título y texto: otra cotización, otro motivo u otro mensaje de una regla sí llegan.
      const digest = crypto.createHash('sha256').update(`${o.title}\n${o.body}`).digest('hex');
      const fresh = await astore.claimAlertDeliveries(recipients.map((u) => u.id), o.kind ?? 'alert', o.link, digest, 10);
      recipients = recipients.filter((u) => fresh.has(u.id));
    }
    const ch = new Map(recipients.map((u) => [u.id, alertChannels(u.alert_prefs, o.kind)]));
    const panelIds = await astore.notifyUsers(accountId, recipients.filter((u) => ch.get(u.id)!.panel).map((u) => u.id), { title: o.title, body: o.body, link: o.link, kind: o.kind });
    const url = o.link ? `${config.publicBaseUrl}/${o.link}` : undefined;
    // Cada entrega por WhatsApp o correo queda registrada: si falla se reintenta y, si es urgente, sale por el otro canal.
    const receipts: Receipt[] = [];
    const queue = (d: Omit<Parameters<typeof queueDelivery>[0], 'accountId' | 'kind'>) => queueDelivery({ ...d, accountId, kind: o.kind }).then((r) => receipts.push(r));
    const skip = new Set((o.skipPhones ?? []).map((p) => p.replace(/\D/g, '')));
    const phonesUsed = new Set<string>();
    for (const u of recipients) {
      const key = newAlertKey();
      const base = { notificationId: panelIds.get(u.id) ?? null, userId: u.id, alertKey: key, payload: { title: o.title, body: o.body, url } };
      if (u.email && ch.get(u.id)!.email) await queue({ ...base, channel: 'email', destination: u.email });
      const phone = u.phone?.replace(/\D/g, '') ?? '';
      if (u.notify_whatsapp && phone && ch.get(u.id)!.whatsapp && !skip.has(phone) && !phonesUsed.has(phone)) {
        phonesUsed.add(phone);
        await queue({ ...base, channel: 'whatsapp', destination: phone });
      }
    }
    // Los números externos de una regla no son del equipo: reciben solo el texto de quien configuró el aviso.
    for (const phone of new Set((o.phones ?? []).map((p) => p.replace(/\D/g, '')))) {
      if (!phone || skip.has(phone) || phonesUsed.has(phone)) continue;
      phonesUsed.add(phone);
      await queue({ userId: null, alertKey: newAlertKey(), channel: 'whatsapp', destination: phone, payload: { title: o.title, body: o.phonesBody ?? o.body, url } });
    }
    // En paralelo: un WhatsApp lento no hace esperar a los demás (ni a la conversación más de lo que tarda uno).
    await Promise.allSettled(receipts.map((r) => attemptDelivery(r)));
  }

  /** Un aviso sin nadie que lo reciba: queda en la bitácora y, si es urgente, el superadmin se entera (una vez al día). */
  private async noRecipients(accountId: string, kind: string | undefined, title: string) {
    await logEvent({ level: 'warn', source: 'engine', message: `Aviso sin nadie que lo reciba: ${title}`, accountId, details: { kind: kind ?? 'alert', reason: 'alert_no_recipients' } });
    if (!isImportantAlert(kind)) return;
    const day = new Date().toISOString().slice(0, 10);
    const first = await queryOne(`INSERT INTO system_state (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING RETURNING key`, [`alert-no-recipients:${accountId}:${day}`]);
    if (!first) return;
    const acc = await queryOne<{ name: string }>(`SELECT name FROM accounts WHERE id = $1`, [accountId]);
    await emailSuperadmin(`Avisos sin destinatario: ${acc?.name ?? accountId}`, `La cuenta "${acc?.name ?? accountId}" no tiene a nadie activo que reciba sus avisos urgentes («${title}»). Revisa que tenga al menos un administrador activo.`, { accountId, urgent: true });
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
    // Botón de un flujo (tocado o escrito): hace lo que dice el botón; no cuenta como "respondió" y la IA no contesta.
    if (await this.handleTap(conv, contact, message, text)) return true;
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
    // «Ya pagué» o un comprobante con un cobro pendiente: aviso al equipo (el asistente contesta, pero no lo confirma).
    await this.chat.receivables.onCustomerMessage(conv, contact, message, text).catch((e) =>
      logEvent({ level: 'error', source: 'engine', message: `No se pudo revisar el reporte de pago: ${e?.message ?? e}`, accountId: conv.account_id, conversationId: conv.id }));
    const first = await store.isFirstLiveInbound(conv.id, message.id);
    let stop = false;
    if (first) stop = (await this.handle({ type: 'new_contact', conversationId: conv.id, text })).stopAi || stop;
    stop = (await this.handle({ type: 'message_received', conversationId: conv.id, text, isFirstMessage: first })).stopAi || stop;
    return stop;
  }

  /**
   * ¿El mensaje es la elección de un botón del juego vigente? El toque trae su identificador; escrito, vale el texto del
   * botón y, solo si el mensaje con botones es el último que se le envió, el número. Cada juego se aplica una vez: un
   * segundo toque (o el mismo toque por dos réplicas) no repite nada.
   */
  private async handleTap(conv: Conversation, contact: Contact, message: Message, text: string): Promise<boolean> {
    const p = (await queryOne<{ pending_buttons: (PendingButtons & { used?: number; used_at?: string }) | null }>(`SELECT pending_buttons FROM conversations WHERE id = $1`, [conv.id]))?.pending_buttons;
    if (!p?.buttons?.length || Date.parse(p.expires_at) < Date.now()) return false;
    const raw = String(message.meta?.button ?? '');
    const tapped = parsePayload(raw);
    let n: number | null = null;
    if (tapped) n = tapped.set === p.set ? tapped.n : null;
    else if (!raw) {
      const lastOut = await queryOne<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1`, [conv.id]);
      n = matchChoice(text, p.buttons.map((b) => b.label), Number(lastOut?.id) === Number(p.message_id));
    }
    if (!n || n > p.buttons.length) return false;
    // Ya eligió en este mensaje: el mismo toque repetido no hace nada más; escrito, solo cuenta como repetido unos
    // minutos (después, "sí" es una respuesta normal a lo que se le pregunte y la contesta la IA).
    if (p.used) return !!tapped || Date.now() - Date.parse(String(p.used_at ?? 0)) < USED_TYPED_MS;
    const claimed = await queryOne(
      `UPDATE conversations SET pending_buttons = pending_buttons || jsonb_build_object('used', $3::int, 'used_at', now())
        WHERE id = $1 AND pending_buttons->>'set' = $2 AND NOT (pending_buttons ? 'used') RETURNING id`, [conv.id, p.set, n]);
    if (!claimed) return true;
    await this.runTap(conv, contact, message, text, p, n);
    return true;
  }

  /** Lo que hace el botón elegido: su respuesta y su acción (seguir, terminar, otro flujo, etiqueta o una persona). */
  private async runTap(conv: Conversation, contact: Contact, message: Message, text: string, p: PendingButtons, n: number) {
    const b = p.buttons[n - 1];
    await logEvent({ level: 'info', source: 'engine', message: `👆 Eligió: "${b.label}"`, accountId: conv.account_id, conversationId: conv.id });
    await query(`UPDATE messages SET meta = coalesce(meta, '{}'::jsonb) || $2 WHERE id = $1`, [message.id, JSON.stringify({ choice: b.label })]);
    const en = p.enrollment_id ? await astore.getEnrollment(p.enrollment_id) : null;
    const live = en?.status === 'active' ? en : null;
    // Elegir no es "responder": el flujo sigue (y "esperar a que elija" sabe que eligió).
    if (en) await query(`UPDATE sequence_enrollments SET choice_step = $2, choice = $3, last_inbound_id = greatest(last_inbound_id, $4) WHERE id = $1`, [en.id, p.step, b.label, message.id]);
    // La respuesta del botón no impide su acción (terminar, pasar con una persona…) aunque falle.
    if (b.reply.trim()) {
      const r = await this.chat.outbound.send(conv.id, { text: b.reply, source: 'flow_reply', meta: { button: b.label } })
        .catch((err): OutboundResult => ({ sent: false, reason: err instanceof DeliveryUncertain ? 'entrega sin confirmar' : err?.message ?? String(err) }));
      if (!r.sent) await logEvent({ level: 'info', source: 'engine', message: `Respuesta del botón "${b.label}" no enviada (${r.reason})`, accountId: conv.account_id, conversationId: conv.id });
    }
    const ctx = await this.loadCtx(conv.id);
    if (!ctx) return;
    const e: AutomationEvent = { type: 'message_received', conversationId: conv.id, text };
    const as = { id: '', name: `botón "${b.label}"` } as Automation;
    switch (b.action) {
      case 'next': {
        // El paso siguiente sale ya (si el flujo sigue en ese punto); el que estaba programado deja de contar.
        if (!live || p.step === null || live.current_step !== p.step + 1) return;
        await astore.cancelJobs('enrollment_id', live.id);
        await this.runSequenceStep({ enrollment_id: live.id, step: p.step + 1, tap: true }).catch(async (err) => {
          if (err instanceof OwnershipLost) throw err;
          await logEvent({ level: 'warn', source: 'engine', message: `Botón "${b.label}": el paso siguiente se reintentará (${err?.message ?? err})`, accountId: conv.account_id, conversationId: conv.id });
          await astore.scheduleJob({ account_id: conv.account_id, type: 'sequence_step', payload: { enrollment_id: live.id, conversation_id: conv.id, step: p.step! + 1, tap: true }, run_at: new Date(Date.now() + 60_000) });
        });
        return;
      }
      case 'end':
        if (live) await astore.stopEnrollments(conv.id, `el cliente eligió "${b.label}"`, live.sequence_id);
        return;
      case 'start_sequence': {
        if (live) await astore.stopEnrollments(conv.id, `el cliente eligió "${b.label}" (cambió de flujo)`, live.sequence_id);
        if (!b.sequence_id) return;
        await this.enroll(b.sequence_id, conv.id, `botón "${b.label}"`, { byCustomer: true }).catch((err) =>
          logEvent({ level: 'warn', source: 'engine', message: `Botón "${b.label}": no se pudo empezar el flujo (${err?.message ?? err})`, accountId: conv.account_id, conversationId: conv.id }));
        return;
      }
      case 'tag':
        if (b.tag) await this.runAction({ type: 'add_tag', tag: b.tag }, ctx, as, e, 0);
        return;
      case 'handoff':
        await this.runAction({ type: 'handoff', reason: `Eligió "${b.label}" en un flujo` }, ctx, as, e, 0);
        return;
    }
  }

  /** Después de cada mensaje enviado: programa los seguimientos por falta de respuesta. */
  async onOutbound(conv: Conversation, msg: Message) {
    // El aviso de demora no es una respuesta: el cliente espera la nuestra, no se le pregunta si sigue interesado.
    if (msg.meta?.source === 'no_reply' || msg.meta?.source === 'opt_out' || msg.meta?.source === 'unavailable') return;
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
    // Una intención por identificador normalizado: "Queja" y "queja" son la misma.
    const seen = new Map<string, { intent: string; description: string }>();
    for (const r of rules) if (r.trigger.type === 'intent' && !seen.has(normalize(r.trigger.intent))) seen.set(normalize(r.trigger.intent), { intent: r.trigger.intent, description: r.trigger.description });
    return [...seen.values()];
  }

  /* ------------------------------ Secuencias ------------------------------ */

  /**
   * Inscribe la conversación en un flujo. `campaignId` y `paceMs`: flujo enviado a un grupo (sus pasos siguientes salen
   * espaciados por número). Con `now`, el primer paso se envía en este momento (la campaña ya eligió la hora) y se
   * devuelve si salió.
   */
  async enroll(sequenceId: string, conversationId: string, by: string, opts: { campaignId?: string; paceMs?: number; now?: boolean; byCustomer?: boolean } = {}) {
    const [seq, conv] = await Promise.all([astore.getSequence(sequenceId), store.getConversation(conversationId)]);
    if (!seq || !conv || seq.account_id !== conv.account_id) throw new Error('Secuencia no encontrada');
    if (!seq.active) throw new Error('La secuencia está desactivada');
    const last = await astore.lastInbound(conv.id);
    const enrollment = await astore.createEnrollment(conv.account_id, seq.id, conv.id, last?.id ?? 0, { campaignId: opts.campaignId, paceMs: opts.paceMs, byCustomer: opts.byCustomer });
    if (!enrollment) return null; // ya estaba inscrito
    await logEvent({ level: 'info', source: 'engine', message: `Inscrito en la secuencia "${seq.name}" (${by})`, accountId: conv.account_id, conversationId: conv.id });
    if (opts.now) {
      const result = await this.runSequenceStep({ enrollment_id: enrollment.id, step: 0 });
      return { ...enrollment, result: result ?? { sent: false as const, reason: 'el paso no se envió' } };
    }
    const settings = await astore.getSettings(conv.account_id);
    const runAt = stepTime(new Date(), seq.steps[0], settings, seq.business_hours_only);
    await astore.updateEnrollment(enrollment.id, { next_run_at: runAt });
    await astore.scheduleJob({
      account_id: conv.account_id,
      type: 'sequence_step',
      payload: { enrollment_id: enrollment.id, conversation_id: conv.id, step: 0 },
      run_at: runAt,
    });
    return enrollment;
  }

  /**
   * Tarea programada: envía un paso de secuencia y programa el siguiente. `tap`: lo pidió un botón "seguir" (sale ya,
   * sin esperar turno). Devuelve si el paso salió (undefined si no le tocaba a esta tarea).
   */
  async runSequenceStep(payload: { enrollment_id: string; step: number; first_due?: string; tap?: boolean; paced?: boolean }): Promise<OutboundResult | undefined> {
    const en = await astore.getEnrollment(payload.enrollment_id);
    if (!en || en.status !== 'active') return;
    if (en.current_step !== payload.step) {
      // El paso ya estaba apartado y nadie programó el siguiente: el proceso que lo enviaba se cayó a medio envío. El
      // flujo sigue (sin reenviarlo: pudo haber salido) en vez de quedarse detenido sin aviso.
      if (en.current_step === payload.step + 1 && !(await astore.hasPendingStepJob(en.id))) await this.resumeAfterCrash(en.id, payload.step);
      return;
    }
    const seq = await astore.getSequence(en.sequence_id);
    const ctx = await this.loadCtx(en.conversation_id);
    const stop = async (reason: string): Promise<OutboundResult> => {
      await astore.updateEnrollment(en.id, { status: 'stopped', stop_reason: reason, next_run_at: null });
      return { sent: false, reason };
    };
    if (!seq || !seq.active) return stop('secuencia desactivada');
    if (!ctx) return stop('conversación eliminada');
    if (ctx.contact.opted_out) return stop('el cliente se dio de baja');
    if (ctx.conv.status === 'human') return stop('una persona está atendiendo la conversación');
    const reschedule = async (runAt: Date, extra: Record<string, unknown> = {}) => {
      await astore.updateEnrollment(en.id, { next_run_at: runAt });
      await astore.scheduleJob({ account_id: ctx.conv.account_id, type: 'sequence_step', payload: { enrollment_id: en.id, conversation_id: ctx.conv.id, step: payload.step, ...extra }, run_at: runAt });
    };
    if (!ctx.channel.active || ctx.channel.account_active === false) {
      // Canal apagado o cuenta en pausa: la secuencia espera (hasta 7 días) en lugar de perderse.
      const firstDue = payload.first_due ? new Date(payload.first_due) : new Date();
      if (Date.now() - firstDue.getTime() > 7 * 86400_000) return stop('el canal o la cuenta siguen inactivos después de 7 días');
      await reschedule(new Date(Date.now() + 3600_000), { first_due: firstDue.toISOString() });
      return { sent: false, reason: 'canal o cuenta inactivos (se reintenta)' };
    }
    if (seq.stop_on_reply) {
      const last = await astore.lastInbound(ctx.conv.id);
      if (last && last.id > en.last_inbound_id) return stop('el cliente respondió');
    }
    // El paso anterior esperaba una elección y no llegó.
    const prev = payload.step > 0 ? seq.steps[payload.step - 1] : undefined;
    if (prev?.wait_for_choice && prev.buttons.some((b) => b.kind === 'reply') && en.choice_step !== payload.step - 1 && prev.if_no_choice === 'end') return stop('el cliente no eligió una opción');
    // Flujo enviado a un grupo: los pasos siguientes salen espaciados por número (salvo el que pidió un botón).
    if (en.pace_ms > 0 && payload.step > 0 && !payload.tap && !payload.paced) {
      let slot = await astore.reservePacedSlot(ctx.channel.id, en.pace_ms);
      if (seq.business_hours_only) slot = nextOpen(ctx.settings.business_hours, ctx.settings.holidays, slot, ctx.settings.timezone);
      if (slot.getTime() > Date.now() + 1000) {
        await reschedule(slot, { paced: true });
        return { sent: false, reason: 'esperando su turno de envío' };
      }
    }
    if (!(await astore.claimStep(en.id, payload.step))) return;
    const step = seq.steps[payload.step];
    if (step && conditionsMatch(step.conditions, ctx)) {
      let r: OutboundResult;
      try {
        const lastIn = en.started_by_customer ? await astore.lastInbound(ctx.conv.id) : null;
        const conversational = !!lastIn && Date.now() - new Date(lastIn.created_at).getTime() < CUSTOMER_WINDOW_MS;
        r = await this.chat.outbound.send(ctx.conv.id, {
          text: step.text, imageId: step.image_id || undefined, attachmentId: step.attachment_id || undefined, waTemplate: step.wa_template, source: 'sequence', conversational, meta: { sequence_id: seq.id, step: payload.step },
          buttons: step.buttons?.length ? step.buttons : undefined, buttonsFrom: { enrollment_id: en.id, sequence_id: seq.id, step: payload.step },
        });
      } catch (e) {
        // Sin confirmar la entrega (es probable que haya salido): no se reenvía, para no duplicarlo, y el flujo sigue.
        if (e instanceof DeliveryUncertain) {
          await logEvent({ level: 'warn', source: 'engine', message: `Flujo "${seq.name}": no se confirmó la entrega del mensaje ${payload.step + 1}; el flujo sigue sin reenviarlo`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id });
          r = { sent: true };
        } else {
          // Falló antes de enviarse (o se perdió el turno): el paso vuelve a quedar pendiente y la tarea se reintenta.
          await astore.releaseStep(en.id, payload.step);
          throw e;
        }
      }
      if (!r.sent) return stop(r.reason);
    }
    const next = payload.step + 1;
    if (next >= seq.steps.length) {
      await astore.updateEnrollment(en.id, { status: 'completed', current_step: next, next_run_at: null, last_step: true });
      return { sent: true };
    }
    const runAt = stepTime(new Date(), seq.steps[next], ctx.settings, seq.business_hours_only);
    await astore.updateEnrollment(en.id, { current_step: next, next_run_at: runAt, last_step: true });
    await astore.scheduleJob({ account_id: ctx.conv.account_id, type: 'sequence_step', payload: { enrollment_id: en.id, conversation_id: ctx.conv.id, step: next }, run_at: runAt });
    return { sent: true };
  }

  /** Retoma un flujo cuyo paso `step` quedó apartado por un proceso que se cayó: programa el siguiente (o lo termina). */
  private async resumeAfterCrash(enrollmentId: string, step: number) {
    const en = await astore.getEnrollment(enrollmentId);
    const seq = en ? await astore.getSequence(en.sequence_id) : null;
    const ctx = en ? await this.loadCtx(en.conversation_id) : null;
    if (!en || !seq || !ctx || en.status !== 'active' || en.current_step !== step + 1) return;
    await logEvent({ level: 'warn', source: 'engine', message: `Flujo "${seq.name}": se retomó tras una interrupción; el mensaje ${step + 1} pudo no haber salido`, accountId: ctx.conv.account_id, conversationId: ctx.conv.id });
    const next = step + 1;
    if (next >= seq.steps.length) {
      await astore.updateEnrollment(en.id, { status: 'completed', next_run_at: null });
      return;
    }
    const runAt = stepTime(new Date(), seq.steps[next], ctx.settings, seq.business_hours_only);
    await astore.updateEnrollment(en.id, { next_run_at: runAt });
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
  async runDelayedSend(payload: { automation_id: string; conversation_id: string; text: string; image_id: string; attachment_id?: string; wa_template?: WaTemplateRef | null; source: string; appointment_id: string | null; vars?: Record<string, string> }) {
    const rule = await astore.getAutomation(payload.automation_id);
    if (!rule || !rule.active) return;
    const appointment = payload.appointment_id ? await astore.getAppointment(payload.appointment_id) : null;
    const r = await this.chat.outbound.send(payload.conversation_id, { text: payload.text, imageId: payload.image_id || undefined, attachmentId: payload.attachment_id || undefined, waTemplate: payload.wa_template, source: payload.source, appointment, vars: payload.vars, meta: { automation_id: rule.id } });
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
