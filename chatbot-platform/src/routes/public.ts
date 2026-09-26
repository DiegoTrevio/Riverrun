import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adapterFor } from '../channels/index.js';
import { signedImageUrl, verifyImageSignature } from '../channels/media.js';
import { WEBCHAT_SESSION_RE, newWebchatSession } from '../channels/webchat.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { toPlainText } from '../engine/text.js';
import { imageAbsolutePath } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';

/** Webhooks de las plataformas, API del chat web e imágenes públicas firmadas. */
export async function publicRoutes(app: FastifyInstance, service: ChatService) {
  /* ------------------------------ Webhooks ------------------------------ */

  // Verificación de suscripción (Meta: hub.challenge).
  app.get('/webhook/:token', async (req: any, reply) => {
    const channel = await store.getChannelByToken(req.params.token);
    const adapter = channel ? adapterFor(channel.type) : null;
    const challenge = channel && adapter?.handleVerification ? adapter.handleVerification({ channel, headers: req.headers, query: req.query, body: null }) : null;
    if (challenge === null) return reply.code(403).send('forbidden');
    return reply.type('text/plain').send(challenge);
  });

  const handler = async (req: any, reply: FastifyReply) => {
    const channel = await store.getChannelByToken(req.params.token);
    if (!channel || channel.type === 'playground' || channel.type === 'webchat') {
      await logEvent({ level: 'warn', source: 'webhook', message: 'Webhook con token inválido', details: { ip: req.ip } });
      return reply.code(404).send({ ok: false });
    }
    const adapter = adapterFor(channel.type);
    const webhookReq = { channel, headers: req.headers, query: req.query, body: req.body, rawBody: req.rawBody };
    if (adapter.verifyRequest && !adapter.verifyRequest(webhookReq)) {
      await logEvent({ level: 'warn', source: 'webhook', message: `${adapter.label}: firma o secreto inválido; se rechaza`, accountId: channel.account_id, channelId: channel.id, details: { ip: req.ip } });
      return reply.code(401).send({ ok: false });
    }
    // Responder rápido a la plataforma y procesar en segundo plano.
    reply.send({ ok: true });
    try {
      const { messages, notices } = adapter.parse(webhookReq);
      for (const n of notices ?? []) await logEvent({ level: n.level, source: 'channel', message: n.message, accountId: channel.account_id, channelId: channel.id });
      for (const m of messages) await service.handleIncoming(channel, m);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'webhook', message: `Error procesando webhook: ${e?.message ?? e}`, accountId: channel.account_id, channelId: channel.id, details: e });
    }
  };
  // Evolution puede agregar el nombre del evento al final de la URL (webhook_by_events); lo aceptamos.
  app.post('/webhook/:token', handler);
  app.post('/webhook/:token/:event', handler);

  /* ------------------------------ Chat web ------------------------------ */

  /** CORS del widget: cualquier origen si la lista está vacía; si no, solo los permitidos. */
  const cors = (req: FastifyRequest, reply: FastifyReply, channel: Channel | null) => {
    const origin = String(req.headers.origin ?? '');
    const allowed: string[] = channel?.config.allowed_origins ?? [];
    if (allowed.length && origin) {
      const host = (() => {
        try {
          return new URL(origin).host.toLowerCase();
        } catch {
          return '';
        }
      })();
      const ok = allowed.some((a) => {
        const h = a.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
        return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1)));
      });
      if (!ok) return false;
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
    } else {
      reply.header('access-control-allow-origin', '*');
    }
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS').header('access-control-allow-headers', 'content-type').header('access-control-max-age', '600');
    return true;
  };

  const webchat = async (req: any, reply: FastifyReply): Promise<Channel | null> => {
    const ch = await store.getChannelByToken(req.params.token);
    const valid = ch && ch.type === 'webchat' && ch.active && ch.account_active !== false;
    if (!cors(req, reply, valid ? ch : null)) {
      reply.code(403).send({ error: 'Origen no permitido' });
      return null;
    }
    if (!valid) {
      reply.code(404).send({ error: 'Chat no disponible' });
      return null;
    }
    return ch;
  };

  app.options('/webchat/:token/*', async (req: any, reply) => {
    const ch = await store.getChannelByToken(req.params.token);
    if (!cors(req, reply, ch?.type === 'webchat' ? ch : null)) return reply.code(403).send();
    return reply.code(204).send();
  });

  app.get('/webchat/:token/config', async (req: any, reply) => {
    const ch = await webchat(req, reply);
    if (!ch) return;
    const { title, subtitle, color, welcome_message, launcher_text } = ch.config;
    return { title, subtitle, color, welcome_message, launcher_text };
  });

  app.post('/webchat/:token/session', async (req: any, reply) => {
    const ch = await webchat(req, reply);
    if (!ch) return;
    // Límite por IP: evita crear sesiones sin fin para saltarse el límite por sesión (y gastar IA).
    if (rateLimited(`session-ip:${ch.id}:${req.ip}`, 10)) return reply.code(429).send({ error: 'Demasiadas solicitudes, espera un momento' });
    return { session: newWebchatSession() };
  });

  const recent = new Map<string, number[]>();
  const rateLimited = (key: string, max = 15) => {
    const now = Date.now();
    const list = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    recent.set(key, list);
    if (recent.size > 20_000) for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
    return list.length > max;
  };

  app.post('/webchat/:token/messages', async (req: any, reply) => {
    const ch = await webchat(req, reply);
    if (!ch) return;
    const { session, text, name } = (req.body ?? {}) as { session?: string; text?: string; name?: string };
    if (!session || !WEBCHAT_SESSION_RE.test(session)) return reply.code(400).send({ error: 'Sesión inválida' });
    const clean = String(text ?? '').trim().slice(0, 2000);
    if (!clean) return reply.code(400).send({ error: 'Mensaje vacío' });
    if (rateLimited(`${ch.id}:${session}`) || rateLimited(`msg-ip:${ch.id}:${req.ip}`, 40)) {
      return reply.code(429).send({ error: 'Demasiados mensajes, espera un momento' });
    }
    const r = await service.handleIncoming(ch, {
      messageId: `web-${crypto.randomUUID()}`,
      externalId: session,
      phone: '',
      displayName: String(name ?? '').slice(0, 80),
      fromMe: false,
      type: 'text',
      text: clean,
      timestamp: Math.floor(Date.now() / 1000),
    });
    return { id: r.messageId };
  });

  app.get('/webchat/:token/messages', async (req: any, reply) => {
    const ch = await webchat(req, reply);
    if (!ch) return;
    const session = String(req.query.session ?? '');
    if (!WEBCHAT_SESSION_RE.test(session)) return reply.code(400).send({ error: 'Sesión inválida' });
    const contact = await store.findContact(ch.id, session);
    if (!contact) return { messages: [], typing: false };
    const after = Number(req.query.after) || 0;
    const rows = await query<{ id: number; direction: string; sender: string; content: string; image_id: string | null; created_at: Date; conv_status: string; pending: boolean }>(
      `SELECT m.id, m.direction, m.sender, m.content, m.image_id, m.created_at FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
       WHERE c.contact_id = $1 AND m.id > $2 AND m.status = 'ok' ORDER BY m.id LIMIT 200`,
      [contact.id, after],
    );
    // "Escribiendo…" mientras el bot tiene mensajes pendientes por responder.
    const [state] = await query<{ pending: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                      WHERE c.contact_id = $1 AND c.status = 'bot' AND m.direction = 'in' AND NOT m.processed) AS pending`,
      [contact.id],
    );
    return {
      typing: !!state?.pending,
      messages: rows.map((m) => ({
        id: m.id,
        from: m.direction === 'in' ? 'customer' : m.sender,
        text: m.direction === 'in' ? m.content : toPlainText(m.content),
        image_url: m.image_id ? signedImageUrl(m.image_id) : null,
        created_at: m.created_at,
      })),
    };
  });

  /* ------------------------------ Imágenes firmadas ------------------------------ */
  app.get('/media/:id', async (req: any, reply) => {
    const { e, s } = req.query as { e?: string; s?: string };
    if (!e || !s || !verifyImageSignature(req.params.id, e, s)) return reply.code(403).send();
    const img = await store.getImage(req.params.id);
    if (!img || !img.active) return reply.code(404).send();
    const p = imageAbsolutePath(img);
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('content-type', img.mime_type).header('cache-control', 'public, max-age=86400').header('access-control-allow-origin', '*');
    return reply.send(fs.createReadStream(p));
  });

  void config;
}
