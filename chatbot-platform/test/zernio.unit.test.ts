import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZernioEvent, zernioAdapter, zernioAuthUrl, zernioSignature } from '../src/channels/zernio.js';
import { config } from '../src/config.js';
import { ChannelConfigSchemas, SECRET_FIELDS } from '../src/types.js';

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { id: 'msg_1' } };
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const channel = (cfg: Record<string, unknown> = {}) =>
  ({
    id: 'ch_1',
    account_id: 'acc_1',
    type: 'zernio',
    webhook_token: 'tok',
    config: {
      api_key: 'zk_test',
      account_id: 'acc_zernio',
      platform: 'bluesky',
      profile_id: 'prof_1',
      webhook_secret: 'whsec',
      ...cfg,
    },
  }) as any;

const sentBody = () => JSON.parse(String(calls[0].init.body));

test('firma del webhook: acepta solo el HMAC del cuerpo crudo con el secreto del canal', () => {
  const raw = Buffer.from('{"event":"message.received"}');
  const sig = zernioSignature(raw, 'whsec');
  const verify = (headers: Record<string, string | undefined>, rawBody: Buffer | undefined, ch = channel()) =>
    zernioAdapter.verifyRequest!({ channel: ch, headers, query: {}, body: null, rawBody });

  assert.equal(verify({ 'x-zernio-signature': sig }, raw), true);
  assert.equal(verify({ 'x-zernio-signature': zernioSignature(raw, 'otro') }, raw), false);
  assert.equal(verify({ 'x-zernio-signature': sig }, Buffer.from('{"event":"alterado"}')), false);
  assert.equal(verify({}, raw), false, 'sin firma se rechaza');
  assert.equal(verify({ 'x-zernio-signature': sig }, undefined), false, 'sin cuerpo crudo no se puede verificar');
  assert.equal(verify({ 'x-zernio-signature': sig }, raw, channel({ webhook_secret: '' })), false, 'sin secreto se rechaza');
});

test('parse: message.received se convierte en mensaje entrante con la conversación como contacto', () => {
  const r = parseZernioEvent({
    event: 'message.received',
    payload: {
      id: 'evt_1',
      conversationId: 'conv_9',
      message: { id: 'm_1', text: 'Hola', createdAt: '2026-10-08T12:00:00Z' },
      sender: { id: 'p_1', name: 'Ana' },
    },
  });
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.messages[0], {
    messageId: 'm_1',
    externalId: 'conv_9',
    phone: '',
    displayName: 'Ana',
    fromMe: false,
    type: 'text',
    text: 'Hola',
    timestamp: Date.parse('2026-10-08T12:00:00Z') / 1000,
  });
});

test('parse: message.sent es un eco saliente, no un mensaje del cliente', () => {
  const r = parseZernioEvent({
    event: 'message.sent',
    payload: { id: 'evt_2', conversationId: 'conv_9', message: { id: 'm_2', text: 'Gracias' } },
  });
  assert.equal(r.messages[0].fromMe, true);
  assert.equal(r.messages[0].displayName, '');
  assert.equal(r.messages[0].externalId, 'conv_9');
});

test('parse: un evento con forma desconocida deja aviso con las claves recibidas, sin mensajes', () => {
  const r = parseZernioEvent({ event: 'message.received', payload: { foo: 1 } });
  assert.deepEqual(r.messages, []);
  assert.equal(r.notices?.[0].level, 'warn');
  assert.match(r.notices?.[0].message ?? '', /foo/);
});

test('parse: eventos no soportados se ignoran con aviso informativo', () => {
  const r = parseZernioEvent({ event: 'account.updated', payload: {} });
  assert.deepEqual(r.messages, []);
  assert.equal(r.notices?.[0].level, 'info');
});

test('envío de texto: va al hilo de la conversación con la cuenta conectada y la API key', async () => {
  const t = zernioAdapter.transport(channel(), { external_id: 'conv 9/x' } as any);
  const id = await t.sendText('Hola Ana', 0);
  assert.equal(id, 'msg_1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/inbox\/conversations\/conv%209%2Fx\/messages$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer zk_test');
  assert.deepEqual(sentBody(), { accountId: 'acc_zernio', message: 'Hola Ana' });
});

test('envío de imagen: usa la URL firmada y exige HTTPS público', async () => {
  const prev = config.publicBaseUrl;
  const image = { id: 'img_1', code: 'doble', name: 'Doble', mime_type: 'image/jpeg', file_path: '' } as any;
  const t = zernioAdapter.transport(channel(), { external_id: 'conv_9' } as any);
  try {
    config.publicBaseUrl = 'http://localhost:3000';
    await assert.rejects(t.sendImage(image, 'Mira', 0), /HTTPS/);
    assert.equal(calls.length, 0);

    config.publicBaseUrl = 'https://bots.example.com';
    await t.sendImage(image, 'Mira', 0);
    assert.match(sentBody().attachmentUrl, /^https:\/\/bots\.example\.com\/media\/img_1\?/);
    assert.equal(sentBody().message, 'Mira');
  } finally {
    config.publicBaseUrl = prev;
  }
});

test('envío sin cuenta conectada no llama a Zernio', async () => {
  const t = zernioAdapter.transport(channel({ account_id: '' }), { external_id: 'conv_9' } as any);
  await assert.rejects(t.sendText('Hola', 0), /no está conectada/);
  assert.equal(calls.length, 0);
});

test('errores de la API se propagan una sola vez: un envío no se reintenta', async () => {
  reply = { status: 401, body: { error: { message: 'API key inválida' } } };
  const t = zernioAdapter.transport(channel(), { external_id: 'conv_9' } as any);
  await assert.rejects(t.sendText('Hola', 0), /401.*API key inválida/);
  assert.equal(calls.length, 1);
});

test('registro del webhook: envía la URL, el secreto y los eventos de mensajes', async () => {
  const r = await zernioAdapter.setup!(channel(), 'https://bots.example.com/webhook/tok');
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /\/webhooks\/settings$/);
  assert.deepEqual(sentBody(), {
    url: 'https://bots.example.com/webhook/tok',
    secret: 'whsec',
    events: ['message.received', 'message.sent'],
  });
});

test('registro del webhook: exige HTTPS y no llama a Zernio si la URL no es segura', async () => {
  const r = await zernioAdapter.setup!(channel(), 'http://localhost:3000/webhook/tok');
  assert.equal(r.ok, false);
  assert.match(r.message, /HTTPS/);
  assert.equal(calls.length, 0);
});

test('conexión de cuenta: pide la autorización del perfil y devuelve la URL', async () => {
  reply = { status: 200, body: { authUrl: 'https://zernio.example/auth/abc' } };
  const url = await zernioAuthUrl(channel(), 'https://bots.example.com/zernio/callback/tok/st');
  assert.equal(url, 'https://zernio.example/auth/abc');
  const q = new URL(calls[0].url).searchParams;
  assert.match(calls[0].url, /\/connect\/bluesky\?/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(q.get('profileId'), 'prof_1');
  assert.equal(q.get('redirect_url'), 'https://bots.example.com/zernio/callback/tok/st');
});

test('conexión de cuenta: sin red o perfil no llama a Zernio', async () => {
  await assert.rejects(zernioAuthUrl(channel({ platform: '' }), 'https://bots.example.com/x'), /Indica la red/);
  await assert.rejects(zernioAuthUrl(channel({ profile_id: '' }), 'https://bots.example.com/x'), /Indica la red/);
  assert.equal(calls.length, 0);
});

test('secreto del webhook: se genera distinto para cada canal', () => {
  const a = zernioAdapter.initialConfig!().webhook_secret as string;
  const b = zernioAdapter.initialConfig!().webhook_secret as string;
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test('configuración: los secretos de Zernio quedan enmascarados y los campos tienen valores por defecto', () => {
  for (const f of ['api_key', 'webhook_secret', 'connect_state']) assert.ok(SECRET_FIELDS.includes(f), f);
  const parsed = ChannelConfigSchemas.zernio.parse({});
  assert.equal(parsed.platform, '');
  assert.equal(parsed.account_id, '');
  assert.equal(parsed.api_key, '');
});

test('límite de velocidad: un 429 se repite una vez tras Retry-After y el envío queda hecho', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0', 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'msg_9' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const id = await zernioAdapter.transport(channel(), { external_id: 'conv_1' } as any).sendText('Hola', 0);
  assert.equal(id, 'msg_9');
  assert.equal(calls, 2);
});

test('errores 5xx no se repiten: el mensaje pudo haber llegado', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"message":"caído"}', { status: 503, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  await assert.rejects(zernioAdapter.transport(channel(), { external_id: 'conv_1' } as any).sendText('Hola', 0), /503/);
  assert.equal(calls, 1);
});

test('plataforma: se normaliza a minúsculas y sin espacios', () => {
  assert.equal(ChannelConfigSchemas.zernio.parse({ platform: '  WhatsApp ' }).platform, 'whatsapp');
});

test('límite de velocidad: un 429 sin Retry-After espera 2 s antes de repetir (no reintenta de inmediato)', async () => {
  const at: number[] = [];
  globalThis.fetch = (async () => {
    at.push(Date.now());
    if (at.length === 1) return new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'msg_10' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const id = await zernioAdapter.transport(channel(), { external_id: 'conv_1' } as any).sendText('Hola', 0);
  assert.equal(id, 'msg_10');
  assert.ok(at[1] - at[0] >= 1900, `esperó ${at[1] - at[0]} ms`);
});

test('parse: un evento de otra cuenta de la misma API key se ignora; los de la cuenta del canal (o sin cuenta) pasan', () => {
  const event = (accountId?: string) => ({
    event: 'message.received',
    payload: { ...(accountId ? { accountId } : {}), conversationId: 'conv_9', message: { id: 'm1', text: 'hola' }, sender: { name: 'Ana' } },
  });
  const other = parseZernioEvent(event('acc_otra'), 'acc_zernio');
  assert.equal(other.messages.length, 0);
  assert.match(other.notices?.[0]?.message ?? '', /otra cuenta/);
  assert.equal(parseZernioEvent(event('acc_zernio'), 'acc_zernio').messages.length, 1);
  assert.equal(parseZernioEvent(event(), 'acc_zernio').messages.length, 1, 'sin cuenta en el evento no se descarta');
  assert.equal(zernioAdapter.parse({ channel: channel(), headers: {}, query: {}, body: event('acc_otra') }).messages.length, 0, 'el adaptador usa la cuenta conectada del canal');
});

test('parse: foto o documento del cliente quedan con su tipo y su pie (no se pierden ni salen como "no compatible")', () => {
  const photo = parseZernioEvent({
    event: 'message.received',
    payload: { conversationId: 'conv_9', message: { id: 'm2', text: '¿tienen esta talla?', attachments: [{ type: 'image/jpeg', url: 'https://cdn.example/p.jpg' }] }, sender: { name: 'Ana' } },
  }).messages[0];
  assert.equal(photo.type, 'image');
  assert.equal(photo.text, '¿tienen esta talla?');
  assert.equal(photo.media?.url, 'https://cdn.example/p.jpg');
  const doc = parseZernioEvent({
    event: 'message.received',
    payload: { conversationId: 'conv_9', message: { id: 'm3', attachments: [{ type: 'application/pdf', url: 'https://cdn.example/c.pdf', name: 'cotizacion.pdf' }] } },
  }).messages[0];
  assert.equal(doc.type, 'document');
  assert.equal(doc.media?.filename, 'cotizacion.pdf');
  const echo = parseZernioEvent({ event: 'message.sent', payload: { conversationId: 'conv_9', message: { id: 'm4', text: '', attachments: [{ type: 'image' }] } } }).messages[0];
  assert.equal(echo.type, 'image', 'el eco de una foto sin pie se reconoce como foto');
});
