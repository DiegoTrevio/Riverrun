import { truncateChars } from '../engine/text.js';
import { parsePayload } from '../automation/buttons.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adapterFor, mergeChannelConfig } from '../channels/index.js';
import { safeFileName, signedImageUrl, verifyImageSignature, verifyQuoteSignature } from '../channels/media.js';
import { attachmentAbsolutePath } from '../attachments.js';
import { findQuote } from '../store/quotes.js';
import type { WebhookRequest } from '../channels/types.js';
import { WEBCHAT_SESSION_RE, newWebchatSession } from '../channels/webchat.js';
import { eventAccountId, platformWebhookSecret, verifySignature } from '../channels/zernio.js';
import { receiveZernioEvent } from '../channels/zernio-events.js';
import { saveZernioAccount, ZernioOwnershipError } from '../channels/zernio-connect.js';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { toPlainText } from '../engine/text.js';
import { imageAbsolutePath } from '../engine/transport.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { safeEqual } from '../secret.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { channelsForEntry, finishMetaConnect, META_NONCE_COOKIE, metaVerifyToken, verifyMetaSignature } from '../channels/meta-connect.js';

/** Tiempo para volver de Zernio después de pulsar "Conectar cuenta". */
const ZERNIO_CONNECT_TTL_MS = 30 * 60_000;

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
    // La recepción se guarda antes de responder; los workers de PostgreSQL la procesan.
    try {
      await processEvent(webhookReq);
      return reply.send({ ok: true });
    } catch {
      await logEvent({ level: 'error', source: 'webhook', message: 'webhook_receipt_failed', accountId: channel.account_id, channelId: channel.id, details: { reason: 'parse_or_storage' } }).catch(() => undefined);
      return reply.code(503).send({ ok: false, error: 'No se pudo guardar la recepción. Reintenta.' });
    }
  };

  /** Lo que llegó por el webhook de un canal: QR, estado de conexión, avisos y mensajes (guardados para los workers). */
  const processEvent = async (webhookReq: WebhookRequest) => {
    const { channel } = webhookReq;
    const adapter = adapterFor(channel.type);
    const { messages, notices, connection, connectionReason, qr } = adapter.parse(webhookReq);
    if (qr) await store.saveQr(channel.id, qr);
    for (const n of notices ?? []) await logEvent({ level: n.level, source: 'channel', message: n.message, accountId: channel.account_id, channelId: channel.id });
    if (connection) await recordConnectionState(channel, connection, connectionReason);
    await service.inbox.accept(channel, messages);
    if (adapter.acknowledge) void adapter.acknowledge(webhookReq).catch(() => undefined);
  };
  // Evolution puede agregar el nombre del evento al final de la URL (webhook_by_events); lo aceptamos.
  app.post('/webhook/:token', handler);
  app.post('/webhook/:token/:event', handler);

  /**
   * Webhook único de Zernio para toda la plataforma. Firmado con el secreto derivado de la clave del servidor. Cada
   * evento se acepta una sola vez (por su id) y solo llega al canal del perfil que dice el evento; los mensajes se
   * guardan al momento y lo demás se procesa después (src/channels/zernio-events.ts).
   */
  app.post('/zernio/events', async (req: any, reply) => {
    if (!verifySignature(req.headers, req.rawBody, [platformWebhookSecret()])) {
      await logEvent({ level: 'warn', source: 'webhook', message: 'Zernio: firma inválida en el webhook de la plataforma; se rechaza', details: { ip: req.ip } });
      return reply.code(401).send({ ok: false });
    }
    try {
      const code = await receiveZernioEvent(req,
        (channel) => processEvent({ channel, headers: req.headers, query: req.query, body: req.body, rawBody: req.rawBody }),
        () => service.zernioEvents.wake());
      return reply.code(code).send({ ok: true });
    } catch {
      await logEvent({ level: 'error', source: 'webhook', message: 'webhook_receipt_failed', details: { reason: 'parse_or_storage', zernioAccount: eventAccountId(req.body) } }).catch(() => undefined);
      return reply.code(503).send({ ok: false, error: 'No se pudo guardar la recepción. Reintenta.' });
    }
  });

  /* ------------------------------ Facebook e Instagram con un botón (app de Meta de la plataforma) ------------------------------ */
  app.get('/meta/callback', async (req: any, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const fail = (msg: string) => reply.redirect(`${config.publicBaseUrl}/#/conectar-facebook?error=${encodeURIComponent(msg)}`);
    const nonce = String(req.cookies?.[META_NONCE_COOKIE] ?? '');
    reply.clearCookie(META_NONCE_COOKIE, { path: '/meta' });
    // El texto de error de la URL no se muestra (cualquiera puede armar el enlace): solo un mensaje fijo.
    if (q.error || !q.code || !q.state) return fail('Se canceló la conexión con Facebook o no se aceptaron los permisos.');
    const r = await finishMetaConnect(String(q.state), String(q.code), nonce);
    if ('error' in r) return fail(r.error);
    return reply.redirect(`${config.publicBaseUrl}/#/conectar-facebook/${r.sessionId}?account_id=${r.accountId}`);
  });

  // Meta verifica el webhook de la app una vez (lo configura el administrador de la plataforma en Meta for Developers).
  app.get('/meta/webhook', async (req: any, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEqual(String(q['hub.verify_token']), metaVerifyToken())) return reply.type('text/plain').send(String(q['hub.challenge'] ?? ''));
    return reply.code(403).send('forbidden');
  });

  /** Mensajes de todas las páginas e Instagram conectados con el botón: cada evento va al canal de su página o cuenta. */
  app.post('/meta/webhook', async (req: any, reply) => {
    if (!verifyMetaSignature(req.headers['x-hub-signature-256'], req.rawBody)) {
      await logEvent({ level: 'warn', source: 'webhook', message: 'Facebook: firma inválida en el webhook de la plataforma; se rechaza', details: { ip: req.ip } });
      return reply.code(401).send({ ok: false });
    }
    const object = String(req.body?.object ?? '');
    const ids = [...new Set<string>((req.body?.entry ?? []).map((e: any) => String(e?.id ?? '')).filter(Boolean))];
    try {
      for (const id of ids) {
        for (const channel of await channelsForEntry(object, id)) {
          await processEvent({ channel, headers: req.headers, query: req.query, body: req.body, rawBody: req.rawBody });
        }
      }
      return reply.send({ ok: true });
    } catch {
      await logEvent({ level: 'error', source: 'webhook', message: 'webhook_receipt_failed', details: { reason: 'parse_or_storage', meta: object } }).catch(() => undefined);
      return reply.code(503).send({ ok: false, error: 'No se pudo guardar la recepción. Reintenta.' });
    }
  });

  // Zernio redirige aquí al terminar de autorizar la cuenta. El estado de un solo uso evita callbacks falsos.
  app.get('/zernio/callback/:token/:state', async (req: any, reply) => {
    const channel = await store.getChannelByToken(req.params.token);
    const expected = channel?.type === 'zernio' ? String(channel.config.connect_state ?? '') : '';
    if (!channel || !expected || !safeEqual(String(req.params.state), expected)) {
      await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: retorno de conexión con estado inválido; se rechaza', details: { ip: req.ip } });
      return reply.code(403).send('forbidden');
    }
    // Un solo uso, salga bien o no: el enlace queda en el historial del navegador y no debe servir después.
    await store.updateChannel(channel.id, { config: mergeChannelConfig('zernio', channel.config, { connect_state: '' }) });
    const panel = `${config.publicBaseUrl}/#/channel/${channel.id}`;
    const issued = parseInt(expected.split('.')[0], 36);
    if (!Number.isFinite(issued) || Date.now() - issued > ZERNIO_CONNECT_TTL_MS) {
      await logEvent({ level: 'warn', source: 'channel', message: 'Zernio: el enlace de conexión venció; vuelve a pulsar "Conectar cuenta"', accountId: channel.account_id, channelId: channel.id });
      return reply.redirect(panel);
    }
    const q = req.query as Record<string, string | undefined>;
    // El texto de error de la URL no se muestra (cualquiera puede armar el enlace): solo un código fijo.
    if (q.error || !q.accountId) {
      await logEvent({ level: 'warn', source: 'channel', message: `Zernio: la conexión no se completó${q.error ? ` (${String(q.error).slice(0, 80)})` : ''}`, accountId: channel.account_id, channelId: channel.id });
      return reply.redirect(`${panel}?zernio=${q.error ? 'cancelled' : 'error'}`);
    }
    try {
      await saveZernioAccount(channel, { id: String(q.accountId), username: String(q.username ?? '') });
    } catch (e: any) {
      if (e instanceof ZernioOwnershipError) return reply.redirect(`${panel}?zernio=${e.code}`);
      if (e instanceof HttpError && e.issues?.includes('limit_reached')) return reply.redirect(`${panel}?zernio=limit`);
      await logEvent({ level: 'error', source: 'channel', message: `Zernio: no se pudo guardar la cuenta conectada: ${e?.message ?? e}`, accountId: channel.account_id, channelId: channel.id });
      return reply.redirect(`${panel}?zernio=error`);
    }
    return reply.redirect(panel);
  });

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
    const { session, text, name, button } = (req.body ?? {}) as { session?: string; text?: string; name?: string; button?: string };
    if (!session || !WEBCHAT_SESSION_RE.test(session)) return reply.code(400).send({ error: 'Sesión inválida' });
    const clean = truncateChars(String(text ?? '').trim(), 2000);
    if (!clean) return reply.code(400).send({ error: 'Mensaje vacío' });
    if (rateLimited(`${ch.id}:${session}`) || rateLimited(`msg-ip:${ch.id}:${req.ip}`, 40)) {
      return reply.code(429).send({ error: 'Demasiados mensajes, espera un momento' });
    }
    const r = await service.handleIncoming(ch, {
      messageId: `web-${crypto.randomUUID()}`,
      externalId: session,
      phone: '',
      displayName: truncateChars(String(name ?? ''), 80),
      fromMe: false,
      type: 'text',
      text: clean,
      timestamp: Math.floor(Date.now() / 1000),
      // Toque de un botón de un flujo (cualquier otro valor se ignora).
      ...(parsePayload(button) ? { payload: String(button) } : {}),
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
    const rows = await query<{ id: number; direction: string; sender: string; content: string; image_id: string | null; created_at: Date; buttons: any; choice: string | null }>(
      `SELECT m.id, m.direction, m.sender, m.content, m.image_id, m.created_at, m.meta->'buttons' AS buttons, m.meta->>'choice' AS choice FROM messages m
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
        // Botones del mensaje: de respuesta (se tocan) o de enlace (https).
        ...(m.direction === 'out' && Array.isArray(m.buttons) ? { buttons: m.buttons.filter((b: any) => b && typeof b.label === 'string').map((b: any) => (b.kind === 'url' ? { kind: 'url', label: b.label, url: /^https:\/\//.test(String(b.url ?? '')) ? b.url : '' } : { kind: 'reply', label: b.label, payload: String(b.payload ?? '') })) } : {}),
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

  /** PDF de una cotización enviada, por enlace firmado (canales que no envían archivos). */
  app.get('/q/:id', async (req: any, reply) => {
    const { e, s } = req.query as { e?: string; s?: string };
    if (!e || !s || !verifyQuoteSignature(req.params.id, e, s)) return reply.code(403).send();
    const q = await findQuote(req.params.id);
    if (!q || !['sent', 'expired'].includes(q.status) || !q.pdf_path) return reply.code(404).send();
    const p = attachmentAbsolutePath(q.pdf_path);
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(safeFileName(`Cotizacion-${q.folio}.pdf`))}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('referrer-policy', 'no-referrer');
    return reply.send(fs.createReadStream(p));
  });

  void config;
}
