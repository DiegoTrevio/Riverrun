/** Arnés compartido: PostgreSQL real + IA simulada + WhatsApp simulado. */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://chatbot:chatbot@localhost:5432/chatbot_test';
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-uploads-'));
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'secreto123';
process.env.SESSION_SECRET = 'una-clave-de-pruebas-muy-larga';

export const { pool, migrate } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');
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
  const transportFactory = (_bot: any, contact: any) => ({
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
  const { app, service } = await buildApp({ ai: ai as any, transportFactory: transportFactory as any });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'admin', password: 'secreto123' } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const authed = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });

  let msgN = 0;
  const h = {
    app, service, calls, summaryCalls, sent, authed, failNext, token: '', botId: '',
    setScript(s: Script) { script = s; },
    setSummary(s: string) { summary = s; },
    reset() { calls.length = 0; summaryCalls.length = 0; sent.length = 0; },
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
    async createBot(patch: Record<string, unknown> = {}) {
      const r = await authed('POST', '/api/chatbots', { name: 'Hotel Palmas', evolution_instance: 'palmas', active: true, ai: { debounce_seconds: 0.2 }, ...patch });
      assert.equal(r.statusCode, 200, r.body);
      h.botId = r.json().id;
      h.token = r.json().webhook_url.split('/').pop();
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
