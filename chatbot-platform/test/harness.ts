/** Arnés compartido: PostgreSQL real + IA simulada + WhatsApp simulado. */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';

/* ---------- APIs externas simuladas (Telegram Bot API y Meta Graph API) ---------- */
export interface ExtRequest { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any; raw: string }
export const ext = { requests: [] as ExtRequest[], fail: new Set<string>(), n: 0 };
/**
 * Evolution API simulada: instancias con su estado, QR numerados y códigos de vinculación. Como Evolution 2.3.7: el
 * número para el código solo cuenta al crear la instancia o al conectar una cerrada (`number`); esperando escaneo,
 * `connect` devuelve el QR vigente (aquí, uno nuevo por llamada para simular que pasó el tiempo) y no hace caso del número.
 */
export const evo = {
  instances: new Map<string, { state: string; qrN: number; number?: string }>(),
  /** Se llama al cerrar la sesión antes de responder (como el webhook "close" 401 que Evolution manda en ese momento). */
  onLogout: null as null | ((instance: string) => Promise<void>),
  /** Instancias "trabadas": connect no devuelve QR. */
  stuck: new Set<string>(),
  /** Archivos que Evolution entrega al pedir un medio recibido, por id del mensaje. */
  media: new Map<string, { buffer: Buffer; mimetype: string }>(),
  owner: { jid: '5218111112222@s.whatsapp.net', name: 'Clínica Sonrisa' },
  down: false,
  connectErrors: new Map<string, number>(),
  createDenied: false,
  openOnConnect: new Set<string>(),
  /** Como Evolution real: tras borrar una instancia, el nombre sigue ocupado unos instantes. */
  slowDeleteMs: 0,
  deleting: new Map<string, number>(),
  /** Versión que informa la raíz (como Evolution v2); null = no la informa. */
  version: '2.3.7' as string | null,
  /** La llave global es rechazada (401), como con una EVOLUTION_API_KEY equivocada. */
  rejectKey: false,
  /** Webhook guardado por instancia (lo devuelve /webhook/find). */
  webhooks: new Map<string, { url: string; enabled: boolean; events: string[] }>(),
  /** Como Evolution 2.4.0-rc2 sin licencia activada: la raíz responde, toda la API da 503 LICENSE_REQUIRED. */
  licenseRequired: false,
};
/** Zernio simulado: perfiles, cuentas conectadas, webhooks y códigos de Telegram, con las respuestas de la API real. */
export const zer = {
  key: 'zk_plataforma',
  /** Usuario dueño de la llave (cambia si la llave es de otra cuenta de Zernio). */
  userId: 'user_1',
  unauthorized: false,
  profiles: [] as any[],
  accounts: new Map<string, any>(),
  webhooks: [] as any[],
  telegram: new Map<string, { status: 'pending' | 'connected' | 'expired'; profileId: string }>(),
  /** Registro de entregas del webhook (GET /webhooks/logs) y los reenvíos pedidos. */
  logs: [] as any[],
  redelivered: [] as Array<{ webhookId: string; eventId: string }>,
  /** Las siguientes N llamadas responden 429 (límite de la llave). */
  rateLimited: 0,
  /** Plantillas de WhatsApp por cuenta conectada (las aprueba la prueba cambiando su estado). */
  templates: [] as any[],
  /** Comentarios y reseñas (Inbox): publicaciones con comentarios por cuenta, comentarios por publicación y reseñas. */
  posts: [] as any[],
  comments: new Map<string, any[]>(),
  reviews: [] as any[],
  /** Comentarios que ya recibieron su respuesta privada (la red permite una). */
  privateReplied: new Set<string>(),
  /** Publicaciones (POST /posts) por id, llaves de idempotencia ya vistas y redes que fallan al publicar (con su error). */
  publications: new Map<string, any>(),
  idem: new Map<string, string>(),
  postFail: new Map<string, string>(),
  /** Salud por cuenta (GET /accounts/health) y estadísticas: seguidores, métricas diarias y Google; sin el complemento, 402/403. */
  health: new Map<string, any>(),
  followers: new Map<string, any[]>(),
  metrics: new Map<string, any[]>(),
  gbp: new Map<string, any>(),
  analyticsAddon: true,
};
/** Graph de Meta simulado para «Conectar con Facebook»: páginas que devuelve me/accounts y tokens que Meta retiró. */
export const metaFake = {
  pages: [
    { id: 'PAGE1', name: 'Hotel Palmas', access_token: 'page_tok_1', picture: { data: { url: 'https://img.test/p1.jpg' } }, instagram_business_account: { id: 'IG1', username: 'hotelpalmas', profile_picture_url: 'https://img.test/ig1.jpg' } },
    { id: 'PAGE2', name: 'Spa Palmas', access_token: 'page_tok_2', picture: { data: { url: '' } } },
  ] as any[],
  revoked: new Set<string>(),
};
const extServer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url!, 'http://x');
    let body: any = raw;
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* multipart */ }
    const path = url.pathname;
    ext.requests.push({ method: req.method!, path, query: url.searchParams, headers: req.headers, body, raw });
    const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const method = path.split('/').pop()!;
    if ([...ext.fail].some((f) => path.includes(f))) return json(500, { ok: false, description: 'fallo simulado', error: { message: 'fallo simulado' } });
    if (path === '/hook') return json(200, { ok: true });
    if (path.startsWith('/zernio-upload/')) return json(200, {});
    if (path.startsWith('/api/v1/')) {
      const p = path.slice('/api/v1'.length);
      const m = req.method;
      if (zer.unauthorized || !String(req.headers.authorization).startsWith('Bearer zk_')) return json(401, { error: 'Unauthorized' });
      if (zer.rateLimited > 0) {
        zer.rateLimited--;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        return res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      }
      const account = (platform: string, profileId: string, username: string) => {
        const a = { _id: `acc_${++ext.n}`, platform, profileId, username, displayName: `Negocio ${username}`, profilePicture: `https://cdn.zernio.example/${username}.jpg`, isActive: true };
        zer.accounts.set(a._id, a);
        return a;
      };
      if (p === '/profiles' && m === 'GET') {
        const ext_ = url.searchParams.get('externalId');
        const list = ext_ ? zer.profiles.filter((x) => x.externalId === ext_) : zer.profiles;
        return json(200, { profiles: list, total: list.length });
      }
      if (p === '/profiles' && m === 'POST') {
        const dup = zer.profiles.find((x) => x.externalId === body.externalId);
        if (dup) return json(409, { error: 'A profile with this externalId already exists', existingProfileId: dup._id });
        const pr = { _id: `prof_${++ext.n}`, name: body.name, externalId: body.externalId };
        zer.profiles.push(pr);
        return json(201, { message: 'ok', profile: pr });
      }
      if (p.startsWith('/profiles/') && m === 'GET') {
        const pr = zer.profiles.find((x) => x._id === decodeURIComponent(p.split('/')[2]));
        return pr ? json(200, { profile: pr }) : json(404, { error: 'Profile not found' });
      }
      if (p.startsWith('/profiles/') && m === 'DELETE') {
        const id = decodeURIComponent(p.split('/')[2]);
        if ([...zer.accounts.values()].some((a) => a.profileId === id)) return json(400, { error: 'Profile has active accounts' });
        const i = zer.profiles.findIndex((x) => x._id === id);
        if (i < 0) return json(404, { error: 'Profile not found' });
        zer.profiles.splice(i, 1);
        return json(200, { message: 'ok' });
      }
      if (p === '/accounts' && m === 'GET') return json(200, { accounts: [...zer.accounts.values()].filter((a) => a.profileId === url.searchParams.get('profileId')) });
      if (p === '/accounts/health' && m === 'GET') return json(200, { summary: { total: zer.health.size }, accounts: [...zer.health.entries()].map(([accountId, x]) => ({ accountId, ...x })) });
      if (p === '/accounts/follower-stats' && m === 'GET') {
        if (!zer.analyticsAddon) return json(403, { error: 'Analytics add-on required', requiresAddon: true });
        const ids = (url.searchParams.get('accountIds') ?? '').split(',').filter(Boolean);
        return json(200, { stats: Object.fromEntries(ids.map((id) => [id, zer.followers.get(id) ?? []])), accounts: [] });
      }
      if (p === '/analytics/daily-metrics' && m === 'GET') {
        if (!zer.analyticsAddon) return json(402, { error: 'analytics_addon_required' });
        const from = url.searchParams.get('fromDate') ?? '';
        return json(200, { dailyData: (zer.metrics.get(url.searchParams.get('accountId') ?? '') ?? []).filter((d) => !from || d.date >= from) });
      }
      if (p === '/analytics/googlebusiness/performance' && m === 'GET') {
        if (!zer.analyticsAddon) return json(402, { error: 'analytics_addon_required' });
        return json(200, { metrics: zer.gbp.get(url.searchParams.get('accountId') ?? '') ?? {} });
      }
      if (p.startsWith('/accounts/') && m === 'DELETE') { zer.accounts.delete(decodeURIComponent(p.split('/')[2])); return json(200, { message: 'ok' }); }
      if (p === '/webhooks/settings' && m === 'GET') return json(200, { webhooks: zer.webhooks });
      if (p === '/webhooks/settings' && m === 'POST') {
        if (!body.name) return json(400, { error: 'name is required' });
        const w = { _id: `wh_${++ext.n}`, ...body };
        zer.webhooks.push(w);
        return json(200, { success: true, webhook: w });
      }
      if (p === '/webhooks/settings' && m === 'PUT') {
        const w = zer.webhooks.find((x) => x._id === body.webhookId);
        if (!w) return json(404, { error: 'not found' });
        Object.assign(w, body);
        return json(200, { success: true, webhook: w });
      }
      if (p === '/whatsapp/templates' && m === 'GET') return json(200, { success: true, templates: zer.templates.filter((t) => t.accountId === url.searchParams.get('accountId')) });
      if (p === '/whatsapp/templates' && m === 'POST') {
        if (!/^[a-z][a-z0-9_]*$/.test(String(body.name)) || !Array.isArray(body.components)) return json(400, { error: 'Invalid template' });
        if (zer.templates.some((t) => t.accountId === body.accountId && t.name === body.name && t.language === body.language)) return json(400, { error: { message: 'Template name already exists' } });
        const t = { id: `tpl_${++ext.n}`, accountId: body.accountId, name: body.name, language: body.language, category: body.category, status: 'PENDING', components: body.components };
        zer.templates.push(t);
        return json(200, { success: true, template: { id: t.id, name: t.name, status: t.status, category: t.category, language: t.language } });
      }
      if (p.startsWith('/whatsapp/templates/') && m === 'DELETE') {
        const name = decodeURIComponent(p.split('/')[3]);
        zer.templates = zer.templates.filter((t) => !(t.accountId === url.searchParams.get('accountId') && t.name === name && (!url.searchParams.get('language') || t.language === url.searchParams.get('language'))));
        return json(200, { success: true });
      }
      if (/^\/accounts\/[^/]+\/whatsapp\/register$/.test(p) && m === 'POST') {
        if (body?.pin === '000000') return json(422, { error: 'PIN mismatch' });
        return json(200, { registered: true, accountId: decodeURIComponent(p.split('/')[2]), phoneNumberId: 'pn_1' });
      }
      if (p === '/webhooks/logs' && m === 'GET') return json(200, { logs: zer.logs, pagination: { total: zer.logs.length, limit: 50, skip: 0, pages: 1, hasMore: false } });
      if (p === '/webhooks/logs/redeliver' && m === 'POST') {
        if (!zer.logs.some((l) => l.webhookId === body.webhookId && l.eventId === body.eventId)) return json(422, { error: 'No delivery matches this event' });
        zer.redelivered.push({ webhookId: body.webhookId, eventId: body.eventId });
        return json(200, { success: true, message: 'Webhook re-delivered' });
      }
      // Comentarios y reseñas: ids de la red codificados en la ruta (los de Google llevan "/").
      const seg = p.split('/').map((x) => decodeURIComponent(x));
      const platformOf = (id: unknown) => zer.accounts.get(String(id ?? ''))?.platform;
      if (p === '/inbox/comments' && m === 'GET') {
        return json(200, { success: true, data: zer.posts.filter((x) => x.accountId === url.searchParams.get('accountId')), pagination: { hasMore: false, nextCursor: null } });
      }
      if (seg[1] === 'inbox' && seg[2] === 'comments' && seg.length === 4) {
        const post = zer.posts.find((x) => x.id === seg[3]);
        if (m === 'GET') return json(200, { comments: zer.comments.get(seg[3]) ?? [], post: post ? { permalink: post.permalink, text: post.content, thumbnailUrl: post.picture } : {}, pagination: { hasMore: false } });
        if (m === 'POST') return json(200, { success: true, data: { commentId: `zc_${++ext.n}`, isReply: !!body.commentId } });
        if (m === 'DELETE') return json(200, { success: true });
      }
      if (seg[1] === 'inbox' && seg[2] === 'comments' && seg.length === 6) {
        const platform = platformOf(body?.accountId ?? url.searchParams.get('accountId'));
        if (seg[5] === 'hide' && !['facebook', 'instagram', 'threads', 'twitter', 'tiktok'].includes(platform)) return json(400, { error: { code: 'PLATFORM_LIMITATION', message: 'Hide is not supported' } });
        if (seg[5] === 'like' && platform === 'instagram') return json(403, { error: { code: 'PLATFORM_BETA_RESTRICTED', message: 'Instagram comment likes are in beta' } });
        if (seg[5] === 'private-reply') {
          if (zer.privateReplied.has(seg[4])) return json(400, { error: 'Private reply already sent', details: { privateReplyConsumed: true } });
          zer.privateReplied.add(seg[4]);
          return json(200, { success: true, messageId: `pr_${++ext.n}`, commentId: seg[4], platform });
        }
        return json(200, { success: true, ...(seg[5] === 'like' && m === 'POST' ? { likeUri: `at://like/${++ext.n}` } : {}) });
      }
      if (p === '/inbox/reviews' && m === 'GET') return json(200, { success: true, data: zer.reviews.filter((r) => r.accountId === url.searchParams.get('accountId')), pagination: { hasMore: false } });
      if (seg[1] === 'inbox' && seg[2] === 'reviews' && seg[4] === 'reply' && m === 'POST') return json(200, { success: true, reply: { id: `rr_${++ext.n}`, text: body.message } });
      // Publicaciones: crear (ya o programada; la misma llave devuelve la misma), consultar, cambiar, borrar y reintentar.
      if (p === '/posts' && m === 'POST') {
        const key = String(req.headers['idempotency-key'] ?? '');
        if (key && zer.idem.has(key)) return json(200, { post: zer.publications.get(zer.idem.get(key)!), message: 'Idempotent replay' });
        for (const pl of body.platforms ?? []) {
          if (!zer.accounts.get(pl.accountId)) return json(403, { error: { code: 'ACCOUNT_DISCONNECTED', message: 'Account disconnected' } });
          if (['instagram', 'tiktok', 'youtube', 'pinterest'].includes(pl.platform) && !(body.mediaItems ?? []).length) return json(400, { error: `${pl.platform} requires media` });
        }
        const id = `zp_${++ext.n}`;
        const now = !!body.publishNow;
        const platforms = (body.platforms ?? []).map((pl: any) => {
          const fail = zer.postFail.get(pl.platform);
          const n = ++ext.n;
          return {
            platform: pl.platform, accountId: { _id: pl.accountId, platform: pl.platform, username: zer.accounts.get(pl.accountId)?.username }, status: !now ? 'pending' : fail ? 'failed' : 'published',
            ...(now && !fail ? { platformPostId: `pp_${n}`, platformPostUrl: `https://${pl.platform}.test/p/${n}` } : {}), ...(now && fail ? { errorMessage: fail } : {}),
          };
        });
        const status = !now ? 'scheduled' : platforms.every((x: any) => x.status === 'published') ? 'published' : platforms.some((x: any) => x.status === 'published') ? 'partial' : 'failed';
        const post = { _id: id, content: body.content, status, scheduledFor: body.scheduledFor ?? null, timezone: body.timezone ?? null, platforms, metadata: body.metadata ?? {} };
        zer.publications.set(id, post);
        if (key) zer.idem.set(key, id);
        return json(status === 'partial' || status === 'failed' ? 207 : 201, { post, message: 'ok' });
      }
      if (seg[1] === 'posts' && seg[2]) {
        const post = zer.publications.get(seg[2]);
        if (!post) return json(404, { error: 'Post not found' });
        if (seg[3] === 'retry' && m === 'POST') {
          post.platforms = post.platforms.map((x: any) => (x.status === 'failed' ? { ...x, status: 'published', platformPostUrl: `https://${x.platform}.test/p/r${++ext.n}`, errorMessage: undefined } : x));
          post.status = 'published';
          return json(200, { post });
        }
        if (m === 'GET') return json(200, { post });
        if (m === 'PUT') {
          if (post.status === 'published') return json(400, { error: 'Published posts cannot be edited' });
          Object.assign(post, { content: body.content, scheduledFor: body.scheduledFor, timezone: body.timezone });
          return json(200, { post });
        }
        if (m === 'DELETE') {
          if (post.status === 'published') return json(400, { error: 'Published posts cannot be deleted' });
          zer.publications.delete(seg[2]);
          return json(200, { message: 'Post deleted' });
        }
      }
      if (p === '/users') return json(200, { currentUserId: zer.userId, users: [] });
      if (p === '/connect/bluesky/credentials') {
        if (body.appPassword === 'mala') return json(400, { error: 'Invalid identifier or password' });
        const profileId = String(body.state).split('-').slice(1).join('-');
        if (!String(body.state).startsWith('user_1-')) return json(400, { error: 'bad state' });
        return json(200, { message: 'ok', account: account('bluesky', profileId, body.identifier) });
      }
      if (p === '/connect/telegram' && m === 'GET') {
        const code = `ZRN-${++ext.n}`;
        zer.telegram.set(code, { status: 'pending', profileId: url.searchParams.get('profileId')! });
        return json(200, { code, expiresAt: new Date(Date.now() + 900_000).toISOString(), expiresIn: 900, botUsername: 'ZernioConnectBot', instructions: ['Agrega el bot', 'Envía el código'] });
      }
      if (p === '/connect/telegram' && m === 'PATCH') {
        const t = zer.telegram.get(url.searchParams.get('code') ?? '');
        if (!t || t.status === 'expired') return json(200, { status: 'expired', message: 'Code expired' });
        if (t.status === 'pending') return json(200, { status: 'pending', expiresIn: 800 });
        const a = account('telegram', t.profileId, 'hotel_bot');
        zer.telegram.delete(url.searchParams.get('code')!);
        return json(200, { status: 'connected', chatId: '-100', chatTitle: 'Hotel', chatType: 'channel', account: { _id: a._id, platform: 'telegram', username: a.username, displayName: a.displayName } });
      }
      if (p.startsWith('/connect/')) return json(200, { authUrl: `https://zernio.example/auth/${++ext.n}`, state: 'st' });
      if (p === '/media/presign') { const n = ++ext.n; return json(200, { uploadUrl: `${extUrl}/zernio-upload/${n}`, publicUrl: `https://cdn.zernio.example/up/${n}/${body.filename}`, key: `k${n}`, type: 'document' }); }
      if (p.startsWith('/whatsapp/media/')) { res.writeHead(200, { 'content-type': 'audio/ogg' }); return res.end(Buffer.from('OggS-zernio')); }
      if (p.endsWith('/typing')) return json(200, { success: true });
      if (p.endsWith('/messages')) return json(200, { success: true, data: { messageId: `zm_${++ext.n}`, conversationId: p.split('/')[3] } });
      return json(404, { error: { message: 'no simulado' } });
    }
    if (path === '/') {
      if (evo.down) return json(503, { message: 'Service Unavailable' });
      return json(200, { status: 200, message: 'Welcome to the Evolution API, it is working!', ...(evo.version ? { version: evo.version } : {}) });
    }
    if (evo.licenseRequired && /^\/(instance|webhook|message|chat)\//.test(path)) return json(503, { error: 'service not activated', code: 'LICENSE_REQUIRED', message: 'This Evolution API instance is not activated.' });
    if (path.startsWith('/instance/') || path.startsWith('/webhook/set/') || path.startsWith('/webhook/find/')) {
      if (evo.down) return json(503, { message: 'Service Unavailable' });
      if (evo.rejectKey) return json(401, { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } });
      const name = decodeURIComponent(path.split('/').pop()!);
      if (path.startsWith('/webhook/find/')) return evo.instances.has(name) ? json(200, evo.webhooks.get(name) ?? null) : json(404, { response: { message: ['not found'] } });
      if (path.startsWith('/instance/connectionState/')) {
        const i = evo.instances.get(name);
        return i ? json(200, { instance: { instanceName: name, state: i.state } }) : json(404, { response: { message: ['not found'] } });
      }
      if (path === '/instance/create') {
        if (evo.createDenied) return json(403, { response: { message: 'Forbidden: invalid API key' } });
        if (evo.instances.has(body.instanceName) || (evo.deleting.get(body.instanceName) ?? 0) > Date.now()) {
          return json(403, { response: { message: [`This name "${body.instanceName}" is already in use.`] } });
        }
        evo.instances.set(body.instanceName, { state: 'connecting', qrN: 1, number: body.number || undefined });
        if (body.webhook) evo.webhooks.set(body.instanceName, body.webhook);
        return json(201, { instance: { instanceName: body.instanceName }, qrcode: { base64: 'data:image/png;base64,QR1', pairingCode: body.number ? 'NEWC0DE1' : null } });
      }
      if (path.startsWith('/instance/connect/')) {
        const i = evo.instances.get(name);
        if (!i) return json(404, { response: { message: ['not found'] } });
        if (evo.connectErrors.has(name)) return json(evo.connectErrors.get(name)!, { message: 'Connect failed' });
        if (evo.openOnConnect.has(name)) { i.state = 'open'; return json(200, { instance: { state: 'open' } }); }
        // Cerrada: empieza una vinculación nueva (con el número pedido, o sin él).
        if (i.state === 'close') { i.state = 'connecting'; i.number = url.searchParams.get('number') || undefined; }
        if (evo.stuck.has(name)) return json(200, { count: 0 });
        i.qrN++;
        return json(200, { base64: `data:image/png;base64,QR${i.qrN}`, code: `2@${i.qrN}`, pairingCode: i.number ? `PAIR${String(i.qrN).padStart(4, '0')}` : null });
      }
      if (path.startsWith('/instance/fetchInstances')) {
        const wanted = url.searchParams.get('instanceName');
        const i = evo.instances.get(wanted ?? '');
        // Como Evolution 2.3.7 real: pedir una instancia que no existe da 404 (después de validar la llave).
        if (wanted && !i) return json(404, { status: 404, error: 'Not Found', response: { message: [`Instance "${wanted}" not found`] } });
        return json(200, i ? [{ name: wanted, connectionStatus: i.state, ownerJid: evo.owner.jid, profileName: evo.owner.name }] : []);
      }
      if (path.startsWith('/instance/logout/')) {
        const i = evo.instances.get(name);
        if (!i) return json(404, { response: { message: [`The "${name}" instance does not exist`] } });
        if (i.state === 'close') return json(400, { status: 400, error: 'Bad Request', response: { message: [`The "${name}" instance is not connected`] } });
        i.state = 'close';
        i.number = undefined;
        if (evo.onLogout) return void evo.onLogout(name).finally(() => json(200, { status: 'SUCCESS' }));
        return json(200, { status: 'SUCCESS' });
      }
      if (path.startsWith('/instance/delete/')) {
        evo.instances.delete(name);
        evo.webhooks.delete(name);
        evo.stuck.delete(name);
        if (evo.slowDeleteMs) evo.deleting.set(name, Date.now() + evo.slowDeleteMs);
        return json(200, { status: 'SUCCESS' });
      }
      if (path.startsWith('/webhook/set/')) {
        evo.webhooks.set(name, body.webhook);
        return json(201, { webhook: body.webhook });
      }
    }
    if (path.startsWith('/chat/getBase64FromMediaMessage/')) {
      const file = evo.media.get(body?.message?.key?.id);
      return file ? json(200, { base64: file.buffer.toString('base64'), mimetype: file.mimetype }) : json(404, { response: { message: ['not found'] } });
    }
    if (path.startsWith('/file/')) { res.writeHead(200, { 'content-type': 'audio/ogg' }); return res.end(Buffer.from('OggS-audio')); }
    if (path.startsWith('/bot')) {
      if (method === 'getMe') return json(200, { ok: true, result: { id: 1, username: 'palmas_bot' } });
      if (method === 'getFile') return json(200, { ok: true, result: { file_path: 'voice/a.ogg' } });
      if (method === 'getWebhookInfo') return json(200, { ok: true, result: { url: 'https://bot.test/webhook/x', pending_update_count: 0 } });
      if (['sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAudio'].includes(method)) return json(200, { ok: true, result: { message_id: ++ext.n } });
      return json(200, { ok: true, result: true });
    }
    if (path.endsWith('/oauth/access_token')) {
      if (url.searchParams.get('client_secret') !== 'meta-app-secret-pruebas') return json(400, { error: { message: 'Invalid client_secret', code: 1 } });
      if (url.searchParams.get('fb_exchange_token')) return json(200, { access_token: `long_${url.searchParams.get('fb_exchange_token')}`, token_type: 'bearer' });
      return url.searchParams.get('code') === 'bad' ? json(400, { error: { message: 'Invalid verification code', code: 100 } }) : json(200, { access_token: 'short_user_tok' });
    }
    if (path.endsWith('/me/accounts')) return json(200, { data: metaFake.pages });
    if (path.endsWith('/me') && metaFake.revoked.has(url.searchParams.get('access_token') ?? '')) return json(400, { error: { message: 'Error validating access token', code: 190 } });
    if (path.endsWith('/me/messages')) return json(200, { recipient_id: body?.recipient?.id, message_id: `m_${++ext.n}` });
    if (path.endsWith('/subscribed_apps')) return json(200, { success: true });
    if (path.endsWith('/me')) {
      // El token de una página dice de qué página es (los de otras pruebas, sin página conocida, siguen siendo de PAGE1).
      const own = metaFake.pages.find((p: any) => p.access_token === url.searchParams.get('access_token'));
      return json(200, own ? { id: own.id, name: own.name } : { id: 'PAGE1', name: 'Hotel Palmas' });
    }
    const pageFields = metaFake.pages.find((p: any) => path.endsWith(`/${p.id}`) && p.access_token === url.searchParams.get('access_token'));
    if (pageFields) return json(200, { id: pageFields.id, instagram_business_account: pageFields.instagram_business_account ? { id: pageFields.instagram_business_account.id } : undefined });
    return json(404, { error: { message: 'ruta simulada desconocida' } });
  });
});
await new Promise<void>((r) => extServer.listen(0, '127.0.0.1', r));
extServer.unref();
const extUrl = `http://127.0.0.1:${(extServer.address() as any).port}`;
process.env.TELEGRAM_API_URL = extUrl;
process.env.META_GRAPH_URL = extUrl;
process.env.META_APP_ID = 'meta-app-pruebas';
process.env.META_APP_SECRET = 'meta-app-secret-pruebas';
process.env.META_VERIFY_TOKEN = 'verificacion-meta-pruebas';
process.env.ZERNIO_API_URL = `${extUrl}/api/v1`;
process.env.ZERNIO_API_KEY = zer.key;
// Presupuesto de llamadas a Zernio holgado en las pruebas (la prueba del presupuesto lo baja).
process.env.ZERNIO_RATE_PER_MIN = process.env.ZERNIO_RATE_PER_MIN || '100000';
process.env.EVOLUTION_URL = extUrl;
process.env.EVOLUTION_API_KEY = 'llave-global-de-pruebas';
process.env.PUBLIC_BASE_URL = 'https://bot.test';
process.env.WEBHOOK_BASE_URL = 'http://backend:3000';
process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://chatbot:chatbot@localhost:5432/chatbot_test';
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-uploads-'));
process.env.ADMIN_USER = 'admin@test.mx';
process.env.ADMIN_PASSWORD = 'secreto123';
process.env.SESSION_SECRET = 'una-clave-de-pruebas-muy-larga';
// Las cotizaciones se convierten a PDF con un convertidor de prueba (QUOTE_PDF_BACKEND=soffice usa LibreOffice).
process.env.QUOTE_PDF_BACKEND ??= 'fake';

export const { pool, migrate } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');
const { defaultTransport } = await import('../src/service.js');
const { bootstrapSuperadmin } = await import('../src/auth.js');
export const store = await import('../src/store/index.js');
export type Req = import('../src/ai/provider.js').CompletionRequest;

export async function dbAvailable() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

type Out = Record<string, unknown> | string | Error;
export type Script = (req: Req, callIndex: number) => Out | Promise<Out>;
/** Respuesta simulada del Copiloto: texto, llamadas a herramientas (con argumentos en objeto o texto) o un error. */
export type CopilotOut = string | Error | { content?: string; tool_calls?: { name: string; arguments?: Record<string, unknown> | string }[] };
export type CopilotScript = (req: Req, callIndex: number) => CopilotOut | Promise<CopilotOut>;

export async function createHarness() {
  const calls: Req[] = [];
  const summaryCalls: Req[] = [];
  const sent: { kind: string; to: string; text: string; image?: string; file?: string; mime?: string; fileKind?: string }[] = [];
  let script: Script = () => ({ messages: ['Ok'] });
  let summary = '- resumen de prueba';
  let summaryError: Error | null = null;
  let summaryAnalysis: Record<string, unknown> | undefined;
  let summaryFields: { field: string; value: string; source_message_id: number }[] = [];
  const copilotCalls: Req[] = [];
  let copilotScript: CopilotScript = () => 'Listo.';
  let n = 0;
  const ai: import('../src/ai/provider.js').AiProvider = {
    async complete(req: Req) {
      // El Copiloto es la única llamada con herramientas: tiene su propio guion.
      if (req.tools?.length) {
        copilotCalls.push(req);
        const index = copilotCalls.length - 1;
        const out = await copilotScript(req, index);
        if (out instanceof Error) throw out;
        const o = typeof out === 'string' ? { content: out } : out;
        const toolCalls = (o.tool_calls ?? []).map((c, i) => ({ id: `call_${index}_${i}`, name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) }));
        return { content: o.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}), finish_reason: toolCalls.length ? 'tool_calls' : 'stop', model: req.model, latency_ms: 1, usage: { input_tokens: 300, cached_tokens: 0, output_tokens: 30 } };
      }
      if (!req.json_schema || req.json_schema.name === 'conversation_report') {
        summaryCalls.push(req);
        if (summaryError && req.json_schema?.name === 'conversation_report') throw summaryError;
        return { content: req.json_schema ? JSON.stringify({ summary, save_data: summaryFields, ...(summaryAnalysis ? { analysis: summaryAnalysis } : {}) }) : summary, model: req.model, latency_ms: 1, usage: { input_tokens: 50, cached_tokens: 0, output_tokens: 10 } };
      }
      calls.push(req);
      const out = await script(req, calls.length - 1);
      if (out instanceof Error) throw out;
      const content = typeof out === 'string' ? out : JSON.stringify({
        thinking: '', action: 'reply', messages: [], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, ...out,
      });
      return { content, model: req.model, latency_ms: 1, usage: { input_tokens: 100, cached_tokens: 0, output_tokens: 20 } };
    },
    async transcribe() {
      return 'transcripción';
    },
  };
  const failNext = { text: 0, image: 0 };
  // WhatsApp se simula en memoria; Telegram y Meta usan sus adaptadores reales contra el servidor falso.
  const transportFactory = (channel: any, contact: any) => (channel.type !== 'whatsapp' ? defaultTransport(channel, contact) : {
    kind: 'whatsapp' as const,
    typingSimulation: false,
    async sendText(text: string) {
      if (failNext.text > 0) {
        failNext.text--;
        throw new Error('Evolution sendText → HTTP 500: Connection Closed');
      }
      sent.push({ kind: 'text', to: contact.phone, text });
      return `OUT-${++n}`;
    },
    async sendImage(image: any, caption: string) {
      if (failNext.image > 0) {
        failNext.image--;
        throw new Error('Evolution sendMedia → HTTP 400: media inválido');
      }
      sent.push({ kind: 'image', to: contact.phone, text: caption, image: image.code });
      return `OUT-${++n}`;
    },
    async sendFile(file: any, caption: string) {
      sent.push({ kind: 'file', to: contact.phone, text: caption, file: file.name, mime: file.mime, fileKind: file.kind });
      return `OUT-${++n}`;
    },
    async notify(number: string, text: string) {
      sent.push({ kind: 'notify', to: number, text });
    },
  });

  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await bootstrapSuperadmin();
  const { app, service } = await buildApp({ ai: ai as any, transportFactory: transportFactory as any });
  // El webhook responde antes de procesar el mensaje: se cuentan las llamadas en curso para que idle() espere también a ellas.
  const inflight = { n: 0 };
  const handleIncomingOriginal = service.handleIncoming.bind(service);
  service.handleIncoming = (async (...args: Parameters<typeof handleIncomingOriginal>) => {
    inflight.n++;
    try { return await handleIncomingOriginal(...args); } finally { inflight.n--; }
  }) as typeof service.handleIncoming;
  const loginAs = async (email: string, password: string) => {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    return Object.assign((method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } }), { cookie });
  };
  const authed = await loginAs('admin@test.mx', 'secreto123');

  let msgN = 0;
  const h = {
    app, service, ai, calls, summaryCalls, copilotCalls, sent, authed, loginAs, cookie: authed.cookie, failNext, token: '', botId: '', accountId: '', channelId: '',
    setScript(s: Script) { script = s; },
    setCopilotScript(s: CopilotScript) { copilotScript = s; },
    setSummary(s: string) { summary = s; },
    setAnalysis(a: Record<string, unknown> | undefined) { summaryAnalysis = a; },
    setSummaryError(error: Error | null) { summaryError = error; },
    setSummaryFields(fields: typeof summaryFields) { summaryFields = fields; },
    reset() { calls.length = 0; summaryCalls.length = 0; copilotCalls.length = 0; sent.length = 0; },
    /** Adelanta el reloj: todas las tareas pendientes vencen ya, y se ejecutan. */
    async fastForward() {
      await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending'`);
      await service.scheduler.runDue();
      await h.idle();
    },
    /** Espera a que la cola termine todo lo pendiente (evita que una prueba contamine a la siguiente). */
    async idle() { await waitFor(async () => service.queue.size === 0 && service.inbox.size === 0 && service.zernioEvents.size === 0 && inflight.n === 0 && (await pool.query("SELECT count(*)::int AS n FROM zernio_events WHERE state IN ('pending','running')")).rows[0].n===0 && (await pool.query("SELECT count(*)::int AS n FROM conversation_work WHERE state IN ('pending','running')")).rows[0].n===0 && (await pool.query("SELECT count(*)::int AS n FROM inbound_receipts WHERE state IN ('pending','running')")).rows[0].n===0, 8000); },
    webhook(text: string, opts: { fromMe?: boolean; phone?: string; id?: string; timestamp?: number; instance?: string } = {}) {
      const phone = opts.phone ?? '5215511112222';
      return app.inject({
        method: 'POST',
        url: `/webhook/${h.token}`,
        payload: {
          event: 'messages.upsert',
          instance: opts.instance ?? 'palmas',
          data: {
            key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: !!opts.fromMe, id: opts.id ?? `IN-${++msgN}-${Date.now()}` },
            pushName: 'Ana', message: { conversation: text },
            messageTimestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
          },
        },
      });
    },
    /** Cuenta de pruebas + chatbot activo + canal de WhatsApp (instancia "palmas") asignado. */
    async createBot(patch: Record<string, unknown> = {}) {
      if (!h.accountId) {
        const acc = await authed('POST', '/api/accounts', { name: 'Cuenta de pruebas' });
        assert.equal(acc.statusCode, 200, acc.body);
        h.accountId = acc.json().id;
      }
      const r = await authed('POST', '/api/chatbots', { account_id: h.accountId, name: 'Hotel Palmas', active: true, ai: { debounce_seconds: 0.2 }, ...patch });
      assert.equal(r.statusCode, 200, r.body);
      h.botId = r.json().id;
      const ch = await authed('POST', '/api/channels', { account_id: h.accountId, type: 'whatsapp', name: 'WhatsApp', chatbot_id: h.botId, config: { instance: 'palmas' } });
      assert.equal(ch.statusCode, 200, ch.body);
      h.channelId = ch.json().id;
      h.token = ch.json().webhook_token;
      return r.json();
    },
    /** Sube una foto del catálogo del chatbot de pruebas con su configuración "cuándo se envía". */
    async uploadImage(code: string, name: string, sendWhen: Record<string, unknown>, extra: Record<string, string> = {}) {
      const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
      const b = '----x';
      const part = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
      const fields = { code, name, caption: '', send_when: JSON.stringify(sendWhen), ...extra };
      const body = Buffer.concat([
        Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join('')),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${code}.png"\r\nContent-Type: image/png\r\n\r\n`),
        PNG,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]);
      const r = await app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: body, headers: { cookie: authed.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
      assert.equal(r.statusCode, 200, r.body);
      return r.json();
    },
    async conversationFor(phone = '5215511112222') {
      const list = (await authed('GET', `/api/conversations?chatbot_id=${h.botId}&search=${phone}`)).json();
      return list[0];
    },
  };
  return h;
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Tiempo de espera agotado');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
