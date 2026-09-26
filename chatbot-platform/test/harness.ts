/** Arnés compartido: PostgreSQL real + IA simulada + WhatsApp simulado. */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';

/* ---------- APIs externas simuladas (Telegram Bot API y Meta Graph API) ---------- */
export interface ExtRequest { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any; raw: string }
export const ext = { requests: [] as ExtRequest[], fail: new Set<string>(), n: 0 };
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
    if (path.startsWith('/file/')) { res.writeHead(200, { 'content-type': 'audio/ogg' }); return res.end(Buffer.from('OggS-audio')); }
    if (path.startsWith('/bot')) {
      if (method === 'getMe') return json(200, { ok: true, result: { id: 1, username: 'palmas_bot' } });
      if (method === 'getFile') return json(200, { ok: true, result: { file_path: 'voice/a.ogg' } });
      if (method === 'getWebhookInfo') return json(200, { ok: true, result: { url: 'https://bot.test/webhook/x', pending_update_count: 0 } });
      if (method === 'sendMessage' || method === 'sendPhoto') return json(200, { ok: true, result: { message_id: ++ext.n } });
      return json(200, { ok: true, result: true });
    }
    if (path.endsWith('/me/messages')) return json(200, { recipient_id: body?.recipient?.id, message_id: `m_${++ext.n}` });
    if (path.endsWith('/subscribed_apps')) return json(200, { success: true });
    if (path.endsWith('/me')) return json(200, { id: 'PAGE1', name: 'Hotel Palmas' });
    return json(404, { error: { message: 'ruta simulada desconocida' } });
  });
});
await new Promise<void>((r) => extServer.listen(0, '127.0.0.1', r));
extServer.unref();
const extUrl = `http://127.0.0.1:${(extServer.address() as any).port}`;
process.env.TELEGRAM_API_URL = extUrl;
process.env.META_GRAPH_URL = extUrl;
process.env.PUBLIC_BASE_URL = 'https://bot.test';
process.env.WEBHOOK_BASE_URL = 'http://backend:3000';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://chatbot:chatbot@localhost:5432/chatbot_test';
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-uploads-'));
process.env.ADMIN_USER = 'admin@test.mx';
process.env.ADMIN_PASSWORD = 'secreto123';
process.env.SESSION_SECRET = 'una-clave-de-pruebas-muy-larga';

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

export async function createHarness() {
  const calls: Req[] = [];
  const summaryCalls: Req[] = [];
  const sent: { kind: string; to: string; text: string; image?: string }[] = [];
  let script: Script = () => ({ messages: ['Ok'] });
  let summary = '- resumen de prueba';
  let n = 0;
  const ai = {
    async complete(req: Req) {
      if (!req.json_schema) {
        summaryCalls.push(req);
        return { content: summary, model: req.model, latency_ms: 1, usage: { input_tokens: 50, cached_tokens: 0, output_tokens: 10 } };
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
  const failNext = { text: 0 };
  // WhatsApp se simula en memoria; Telegram y Meta usan sus adaptadores reales contra el servidor falso.
  const transportFactory = (channel: any, contact: any) => (channel.type !== 'whatsapp' ? defaultTransport(channel, contact) : {
    kind: 'whatsapp' as const,
    async sendText(text: string) {
      if (failNext.text > 0) {
        failNext.text--;
        throw new Error('Evolution sendText → HTTP 500: Connection Closed');
      }
      sent.push({ kind: 'text', to: contact.phone, text });
      return `OUT-${++n}`;
    },
    async sendImage(image: any, caption: string) {
      sent.push({ kind: 'image', to: contact.phone, text: caption, image: image.code });
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
  const loginAs = async (email: string, password: string) => {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    return Object.assign((method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } }), { cookie });
  };
  const authed = await loginAs('admin@test.mx', 'secreto123');

  let msgN = 0;
  const h = {
    app, service, calls, summaryCalls, sent, authed, loginAs, cookie: authed.cookie, failNext, token: '', botId: '', accountId: '', channelId: '',
    setScript(s: Script) { script = s; },
    setSummary(s: string) { summary = s; },
    reset() { calls.length = 0; summaryCalls.length = 0; sent.length = 0; },
    /** Espera a que la cola termine todo lo pendiente (evita que una prueba contamine a la siguiente). */
    async idle() { await waitFor(() => service.queue.size === 0, 8000); },
    webhook(text: string, opts: { fromMe?: boolean; phone?: string; id?: string; timestamp?: number } = {}) {
      const phone = opts.phone ?? '5215511112222';
      return app.inject({
        method: 'POST',
        url: `/webhook/${h.token}`,
        payload: {
          event: 'messages.upsert',
          instance: 'palmas',
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
