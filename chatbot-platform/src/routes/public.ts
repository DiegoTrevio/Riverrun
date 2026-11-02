import { truncateChars } from '../engine/text.js';
import { ipLimitKey, limited } from '../identity/rate-limit.js';
import net from 'node:net';
import { isPrivateIp } from '../automation/automator.js';
import { parsePayload } from '../automation/buttons.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adapterFor, mergeChannelConfig } from '../channels/index.js';
import { safeFileName, signedImageUrl, verifyImageSignature, verifyQuoteSignature } from '../channels/media.js';
import { attachmentAbsolutePath } from '../attachments.js';
import { findQuote } from '../store/quotes.js';
import type { WebhookRequest } from '../channels/types.js';
import { newWebchatSession, readWebchatSession } from '../channels/webchat.js';
import { ipKey, rateLimited as limitedFor } from '../auth.js';
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
import { dispositionHeader, sendRanged } from './util.js';

const HOUR = 3600_000;
/** Tiempo para volver de Zernio después de pulsar "Conectar cuenta". */
const ZERNIO_CONNECT_TTL_MS = 30 * 60_000;

/** Webhooks de las plataformas, API del chat web e imágenes públicas firmadas. */

/** Consultas de mensajes por minuto y sesión del chat web (IN-22). Las pruebas que consultan muy seguido lo suben. */
export const webchatLimits = { pollsPerMin: 120 };

/** Tope del cuerpo de un webhook entrante (IN-3): los avisos de los proveedores son de unos KB; 10 MB (el general) no. */
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
const webhookRoute = { bodyLimit: WEBHOOK_BODY_LIMIT };

/**
 * IN-2: con WEBHOOK_BASE_URL interna (en Docker, http://backend:3000), Evolution le habla al backend por la red interna,
 * sin pasar por Caddy. Un aviso de WhatsApp que llega por el proxy (trae X-Forwarded-For) o desde una IP pública no viene
 * de Evolution: con solo conocer el token de la URL se podrían inventar mensajes de cualquier cliente.
 */
export function internalWebhookBase(base = config.webhookBaseUrl): boolean {
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || (net.isIP(host) ? isPrivateIp(host) : !host.includes('.'));
  } catch {
    return false;
  }
}
const fromInternalNetwork = (req: FastifyRequest) =>
  !req.headers['x-forwarded-for'] && !req.headers.forwarded && isPrivateIp(String(req.socket?.remoteAddress ?? ''));

/** Un rechazo va a la bitácora, pero no más de 10 por minuto por conexión (IN-3): un ataque no la llena. */
async function logRejected(req: FastifyRequest, kind: string, entry: Parameters<typeof logEvent>[0]) {
  if (await limited(ipLimitKey(`webhook-reject:${kind}`, req.ip), 10, 60_000)) return;
  await logEvent(entry);
}

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
      await logRejected(req, 'token', { level: 'warn', source: 'webhook', message: 'Webhook con token inválido', details: { ip: req.ip } });
      return reply.code(404).send({ ok: false });
    }
    // Para quien llega de afuera, igual que un token que no existe: no confirma que el token sea de un WhatsApp.
    if (channel.type === 'whatsapp' && internalWebhookBase() && !fromInternalNetwork(req)) {
      await logRejected(req, 'external', { level: 'warn', source: 'webhook', message: 'WhatsApp: aviso desde fuera de la red interna; se rechaza (Evolution habla por la red interna)', accountId: channel.account_id, channelId: channel.id, details: { ip: req.ip } });
      return reply.code(404).send({ ok: false });
    }
    const adapter = adapterFor(channel.type);
    const webhookReq = { channel, headers: req.headers, query: req.query, body: req.body, rawBody: req.rawBody };
    if (adapter.verifyRequest && !adapter.verifyRequest(webhookReq)) {
      await logRejected(req, `sig:${channel.id}`, { level: 'warn', source: 'webhook', message: `${adapter.label}: firma o secreto inválido; se rechaza`, accountId: channel.account_id, channelId: channel.id, details: { ip: req.ip } });
      return reply.code(401).send({ ok: false });
    }
    // La recepción se guarda antes de responder; los workers de PostgreSQL la procesan.
    try {
      await processEvent(webhookReq);
      return reply.send({ ok: true });
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'webhook', message: 'webhook_receipt_failed', accountId: channel.account_id, channelId: channel.id, details: { reason: 'parse_or_storage', error: String(e?.message ?? e).slice(0, 500) } }).catch(() => undefined);
      return reply.code(503).send({ ok: false, error: 'No se pudo guardar la recepción. Reintenta.' });
    }
  };

  /** Lo que llegó por el webhook de un canal: QR, estado de conexión, avisos y mensajes (guardados para los workers). */
  const processEvent = async (webhookReq: WebhookRequest) => {
    const { channel } = webhookReq;
    const adapter = adapterFor(channel.type);
    const { messages, notices, connection, connectionReason, qr, pairingCode } = adapter.parse(webhookReq);
    // El QR, la vinculación y el estado de conexión no deben costar los mensajes del mismo aviso: si algo de eso falla,
    // se registra y los mensajes se guardan igual (si no, el aviso se rechaza y el proveedor podría no reintentarlo).
    try {
      if (qr) await store.saveQr(channel.id, qr);
      if (pairingCode) await store.refreshPairingCode(channel.id, pairingCode);
      for (const n of notices ?? []) await logEvent({ level: n.level, source: 'channel', message: n.message, accountId: channel.account_id, channelId: channel.id });
      if (connection) await recordConnectionState(channel, connection, connectionReason);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'webhook', message: 'webhook_connection_state_failed', accountId: channel.account_id, channelId: channel.id, details: { error: String(e?.message ?? e).slice(0, 500) } }).catch(() => undefined);
    }
    await service.inbox.accept(channel, messages);
    if (adapter.acknowledge) void adapter.acknowledge(webhookReq).catch(() => undefined);
  };
  // Evolution puede agregar el nombre del evento al final de la URL (webhook_by_events); lo aceptamos.
  app.post('/webhook/:token', webhookRoute, handler);
  app.post('/webhook/:token/:event', webhookRoute, handler);

  /**
   * Webhook único de Zernio para toda la plataforma. Firmado con el secreto derivado de la clave del servidor. Cada
   * evento se acepta una sola vez (por su id) y solo llega al canal del perfil que dice el evento; los mensajes se
   * guardan al momento y lo demás se procesa después (src/channels/zernio-events.ts).
   */
  app.post('/zernio/events', webhookRoute, async (req: any, reply) => {
    if (!verifySignature(req.headers, req.rawBody, [platformWebhookSecret()])) {
      await logRejected(req, 'zernio', { level: 'warn', source: 'webhook', message: 'Zernio: firma inválida en el webhook de la plataforma; se rechaza', details: { ip: req.ip } });
      return reply.code(401).send({ ok: false });
    }
    try {
      const code = await receiveZernioEvent(req,
        (channel) => processEvent({ channel, headers: req.headers, query: req.query, body: req.body, rawBody: req.rawBody }),
        () => service.zernioEvents.wake());
      return reply.code(code).send({ ok: true });
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'webhook', message: 'webhook_receipt_failed', details: { reason: 'parse_or_storage', error: String(e?.message ?? e).slice(0, 500), zernioAccount: eventAccountId(req.body) } }).catch(() => undefined);
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
  app.post('/meta/webhook', webhookRoute, async (req: any, reply) => {
    if (!verifyMetaSignature(req.headers['x-hub-signature-256'], req.rawBody)) {
      await logRejected(req, 'meta', { level: 'warn', source: 'webhook', message: 'Facebook: firma inválida en el webhook de la plataforma; se rechaza', details: { ip: req.ip } });
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
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS').header('access-control-allow-headers', 'content-type, x-webchat-session').header('access-control-max-age', '600');
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
    const { title, subtitle, color, welcome_message, launcher_text, theme } = ch.config;
    return { title, subtitle, color, welcome_message, launcher_text, theme: theme || 'auto' };
  });

  /** Red de una conexión: /24 en IPv4 y /64 en IPv6 (ver `ipKey`). */
  const netKey = (ip: string) => {
    const k = ipKey(ip);
    const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(k);
    return v4 ? `${v4[1]}.0/24` : k;
  };
  const NEW_PER_NET_HOUR = 20;

  app.post('/webchat/:token/session', async (req: any, reply) => {
    const ch = await webchat(req, reply);
    if (!ch) return;
    // Sesiones nuevas por conexión: un visitante abre una sola (el widget la guarda); 30 por hora alcanzan aunque borre su
    // navegador o varios compartan la conexión (redes móviles). El tope del canal cuenta clientes nuevos, no sesiones
    // pedidas: pedirlas no cuesta nada y con ellas cualquiera cerraría el chat a los demás.
    if (limitedFor(`webchat-session-ip:${ch.id}:${ipKey(req.ip)}`, 30, HOUR)) return reply.code(429).send({ error: 'Demasiadas solicitudes, espera un momento' });
    return { session: newWebchatSession(ch.id) };
  });

  const recent = new Map<string, number[]>();
  const rateLimited = (key: string, max = 15) => {
    const now = Date.now();
    const list = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    recent.set(key, list);
    return list.length > max;
  };
  // Cada minuto se olvida a quien no escribió en el último minuto (sin esto, el mapa crece con cada visitante).
  const pruneRecent = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
  }, 60_000);
  pruneRecent.unref();
  app.addHook('onClose', async () => clearInterval(pruneRecent));

  app.post('/webchat/:token/messages', async (req: any, reply) => {
    const ch = await webchat(req, reply);
    if (!ch) return;
    const { text, name, button } = (req.body ?? {}) as { session?: string; text?: string; name?: string; button?: string };
    // Solo una sesión que entregó el servidor para este canal: una inventada sería un cliente nuevo en cada mensaje.
    const session = readWebchatSession(ch.id, req.body?.session);
    if (!session) return reply.code(400).send({ error: 'Sesión inválida', code: 'invalid_session' });
    const clean = truncateChars(String(text ?? '').trim(), 2000);
    if (!clean) return reply.code(400).send({ error: 'Mensaje vacío' });
    const ip = ipKey(req.ip);
    if (rateLimited(`${ch.id}:${session}`) || rateLimited(`msg-ip:${ch.id}:${ip}`, 40)
      || limitedFor(`webchat-msg-ip:${ch.id}:${ip}`, 120, HOUR) || limitedFor(`webchat-msg-day:${ch.id}:${session}`, 300, 24 * HOUR)) {
      return reply.code(429).send({ error: 'Demasiados mensajes, espera un momento' });
    }
    // Cada cliente nuevo gasta IA y cupo del plan. Primero 20 por hora por red (/24 en IPv4, /64 en IPv6) y canal: así unas
    // pocas conexiones no agotan el cupo del canal para los demás (IN-22); después, a lo más 300 por hora en el canal.
    if (!(await store.findContact(ch.id, session))) {
      if (await limited(`webchat-new-net:${ch.id}:${netKey(req.ip)}`, NEW_PER_NET_HOUR, HOUR)) {
        return reply.code(429).send({ error: 'Demasiadas conversaciones nuevas desde tu red: intenta en un rato' });
      }
      if (await limited(`webchat-new:${ch.id}`, 300, HOUR)) {
        return reply.code(429).send({ error: 'El chat está recibiendo demasiadas conversaciones nuevas: intenta en unos minutos' });
      }
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
    // La sesión viaja en la cabecera (no queda en registros de URL ni en el Referer); la de la URL se acepta todavía para
    // los widgets que ya están cargados en los sitios (hasta el 1 de diciembre de 2026).
    const session = readWebchatSession(ch.id, String(req.headers['x-webchat-session'] ?? '') || req.query.session);
    if (!session) return reply.code(400).send({ error: 'Sesión inválida', code: 'invalid_session' });
    // Leer también tiene tope (IN-22): el widget consulta cada pocos segundos; 120 por minuto por sesión sobra.
    if (limitedFor(`webchat-poll:${ch.id}:${session}`, webchatLimits.pollsPerMin, 60_000)) return reply.code(429).send({ error: 'Demasiadas consultas, espera un momento' });
    const contact = await store.findContact(ch.id, session);
    if (!contact) return { messages: [], typing: false };
    const after = Number(req.query.after) || 0;
    const rows = await query<{ id: number; direction: string; sender: string; type: string; content: string; image_id: string | null; file_name: string | null; created_at: Date; buttons: any; choice: string | null }>(
      `SELECT m.id, m.direction, m.sender, m.type, m.content, m.image_id, m.meta->>'file_name' AS file_name, m.created_at, m.meta->'buttons' AS buttons, m.meta->>'choice' AS choice FROM messages m
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
        image_url: m.image_id && m.type === 'image' ? signedImageUrl(m.image_id) : null,
        // Video, documento o audio de la biblioteca del agente: el widget lo reproduce o lo ofrece para descargar.
        ...(m.image_id && m.type !== 'image' ? { file: { url: signedImageUrl(m.image_id), name: m.file_name || 'archivo', kind: m.type } } : {}),
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
    reply.header('content-type', img.mime_type).header('cache-control', 'public, max-age=86400').header('access-control-allow-origin', '*').header('x-content-type-options', 'nosniff');
    // Los documentos se descargan con su nombre; fotos, videos y audios se pueden ver en línea.
    if ((img.kind ?? 'image') === 'document') reply.header('content-disposition', dispositionHeader(img.file_name || 'archivo'));
    return sendRanged(req, reply, p);
  });

  /** PDF de una cotización enviada, por enlace firmado (canales que no envían archivos). */
  app.get('/q/:id', async (req: any, reply) => {
    const { e, s } = req.query as { e?: string; s?: string };
    if (!e || !s || !verifyQuoteSignature(req.params.id, e, s)) return reply.code(403).send();
    const q = await findQuote(req.params.id);
    // Además de las enviadas: la que se está enviando por un canal que descarga el archivo de este enlace (Messenger,
    // Instagram), es decir, una final ya aprobada o una aproximada. Una final sin aprobar nunca sale.
    const sending = q?.status === 'approved' || (q?.status === 'draft' && q.kind === 'approximate');
    if (!q || !(['sent', 'expired'].includes(q.status) || sending) || !q.pdf_path) return reply.code(404).send();
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
