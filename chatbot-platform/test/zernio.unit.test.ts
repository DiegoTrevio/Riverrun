import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePlatformWebhook, parseZernioEvent, platformWebhookSecret, profileFor, ZernioClient, zernioAdapter, zernioAuthUrl, zernioSignature } from '../src/channels/zernio.js';
import { config } from '../src/config.js';
import { ChannelConfigSchemas, SECRET_FIELDS } from '../src/types.js';

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { success: true, data: { messageId: 'msg_1', conversationId: 'conv_9' } } };
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
      platform: 'instagram',
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
  assert.equal(verify({ 'x-zernio-signature': sig }, raw, channel({ webhook_secret: '' })), false, 'sin el secreto del canal se rechaza');
  assert.equal(verify({ 'x-zernio-signature': zernioSignature(raw, platformWebhookSecret()) }, raw, channel({ webhook_secret: '' })), true, 'el secreto de la plataforma vale');
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

test('conexión de cuenta: pide la autorización del perfil y devuelve la URL', async () => {
  reply = { status: 200, body: { authUrl: 'https://zernio.example/auth/abc' } };
  const url = await zernioAuthUrl(channel({ platform: 'instagram' }), 'https://bots.example.com/zernio/callback/tok/st');
  assert.equal(url, 'https://zernio.example/auth/abc');
  const q = new URL(calls[0].url).searchParams;
  assert.match(calls[0].url, /\/connect\/instagram\?/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(q.get('profileId'), 'prof_1');
  assert.equal(q.get('redirect_url'), 'https://bots.example.com/zernio/callback/tok/st');
});

test('conexión de cuenta: Bluesky y Telegram no usan la página de autorización', async () => {
  await assert.rejects(zernioAuthUrl(channel({ platform: 'bluesky' }), 'https://bots.example.com/x'), /desde el panel/);
  assert.equal(calls.length, 0);
});

test('configuración: los secretos de Zernio quedan enmascarados y los campos tienen valores por defecto', () => {
  for (const f of ['api_key', 'webhook_secret', 'connect_state']) assert.ok(SECRET_FIELDS.includes(f), f);
  assert.equal(zernioAdapter.initialConfig, undefined, 'los canales nuevos no guardan secretos propios: firma la plataforma');
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
    return new Response(JSON.stringify({ success: true, data: { messageId: 'msg_9' } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    return new Response(JSON.stringify({ success: true, data: { messageId: 'msg_10' } }), { status: 200, headers: { 'content-type': 'application/json' } });
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

/* ------------------------------ Formato real de los eventos (plano) y de la API ------------------------------ */

const flat = (over: Record<string, any> = {}, msg: Record<string, any> = {}) => ({
  id: 'evt_9', event: 'message.received', timestamp: '2026-10-08T12:00:00Z',
  message: {
    id: 'zm_internal', conversationId: 'conv_9', platform: 'instagram', platformMessageId: 'ig_mid_1', direction: 'incoming', text: 'Hola',
    attachments: [], sender: { id: 'u1', name: 'Ana López', username: 'ana', phoneNumber: null }, sentAt: '2026-10-08T12:00:00Z', ...msg,
  },
  conversation: { id: 'conv_9', participantName: 'Ana López' },
  account: { id: 'acc_zernio', platform: 'instagram', username: 'hotel' },
  ...over,
});

test('parse (formato actual): message.received plano usa el id de la plataforma, la conversación y el nombre del cliente', () => {
  const [m] = parseZernioEvent(flat(), 'acc_zernio').messages;
  assert.deepEqual(m, {
    messageId: 'ig_mid_1', externalId: 'conv_9', phone: '', displayName: 'Ana López', fromMe: false, type: 'text', text: 'Hola',
    timestamp: Date.parse('2026-10-08T12:00:00Z') / 1000,
  });
});

test('parse (formato actual): WhatsApp trae el teléfono; direction outgoing y message.sent son ecos', () => {
  assert.equal(parseZernioEvent(flat({}, { sender: { name: 'Ana', phoneNumber: '+52 1 55 1234 5678' } })).messages[0].phone, '5215512345678');
  assert.equal(parseZernioEvent(flat({}, { direction: 'outgoing' })).messages[0].fromMe, true);
  assert.equal(parseZernioEvent(flat({ event: 'message.sent' })).messages[0].fromMe, true);
});

test('parse (formato actual): nota de voz, foto y documento quedan con su tipo y su URL', () => {
  const voice = parseZernioEvent(flat({}, { text: '', attachments: [{ type: 'audio', url: 'https://zernio.com/api/v1/whatsapp/media/77', payload: { voice: true } }] })).messages[0];
  assert.equal(voice.type, 'audio');
  assert.equal(voice.media?.url, 'https://zernio.com/api/v1/whatsapp/media/77');
  assert.equal(parseZernioEvent(flat({}, { attachments: [{ type: 'image', url: 'https://cdn/x.jpg' }] })).messages[0].type, 'image');
  assert.equal(parseZernioEvent(flat({}, { attachments: [{ type: 'file', mimeType: 'application/pdf', url: 'https://cdn/x.pdf' }] })).messages[0].type, 'document');
});

test('parse (formato actual): eventos de otra cuenta se ignoran; conexión y desconexión cambian el estado', () => {
  assert.equal(parseZernioEvent(flat({ account: { id: 'acc_otra' } }), 'acc_zernio').messages.length, 0);
  const down = parseZernioEvent({ event: 'account.disconnected', account: { accountId: 'acc_zernio', platform: 'instagram', reason: 'token expired', disconnectionType: 'unintentional' } }, 'acc_zernio');
  assert.equal(down.connection, 'close');
  assert.match(down.notices?.[0].message ?? '', /token expired/);
  assert.equal(parseZernioEvent({ event: 'account.disconnected', account: { accountId: 'acc_otra' } }, 'acc_zernio').connection, undefined, 'la desconexión de otra cuenta no toca este canal');
  assert.equal(parseZernioEvent({ event: 'account.connected', account: { accountId: 'acc_zernio' } }, 'acc_zernio').connection, 'open');
  const failed = parseZernioEvent({ ...flat({ event: 'message.failed' }), error: { message: 'Fuera de la ventana de 24 h' } }, 'acc_zernio');
  assert.equal(failed.messages.length, 0);
  assert.match(failed.notices?.[0].message ?? '', /24 h/);
});

test('envío: «escribiendo…» antes del texto en las redes que lo permiten; el id es el de la plataforma', async () => {
  const id = await zernioAdapter.transport(channel({ platform: 'instagram' }), { external_id: 'conv_9' } as any).sendText('Hola', 10);
  assert.equal(id, 'msg_1');
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname.split('/').pop()), ['typing', 'messages']);
  calls = [];
  await zernioAdapter.transport(channel({ platform: 'reddit' }), { external_id: 'conv_9' } as any).sendText('Hola', 10);
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname.split('/').pop()), ['messages'], 'Reddit no tiene indicador de escritura');
});

test('envío de imagen: va como adjunto de tipo image', async () => {
  const prev = config.publicBaseUrl;
  config.publicBaseUrl = 'https://bots.example.com';
  try {
    await zernioAdapter.transport(channel({ platform: 'instagram' }), { external_id: 'conv_9' } as any).sendImage({ id: 'img_1' } as any, '', 0);
    assert.equal(sentBody().attachmentType, 'image');
  } finally { config.publicBaseUrl = prev; }
  await assert.rejects(zernioAdapter.transport(channel({ platform: 'bluesky' }), { external_id: 'conv_9' } as any).sendImage({ id: 'img_1' } as any, '', 0), /no permite enviar fotos/);
});

test('llave: sin la del canal se usa ZERNIO_API_KEY de la plataforma; sin ninguna, no se llama a Zernio', async () => {
  const prev = process.env.ZERNIO_API_KEY;
  try {
    process.env.ZERNIO_API_KEY = 'zk_plataforma';
    await zernioAdapter.transport(channel({ api_key: '' }), { external_id: 'conv_9' } as any).sendText('Hola', 0);
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer zk_plataforma');
    calls = [];
    delete process.env.ZERNIO_API_KEY;
    await assert.rejects(zernioAdapter.transport(channel({ api_key: '' }), { external_id: 'conv_9' } as any).sendText('Hola', 0), /ZERNIO_API_KEY/);
    assert.equal(calls.length, 0);
  } finally { if (prev === undefined) delete process.env.ZERNIO_API_KEY; else process.env.ZERNIO_API_KEY = prev; }
});

test('perfil del negocio: se reutiliza el que tiene su externalId; si no, se crea uno', async () => {
  const client = new ZernioClient('zk_x', 'https://z.example/api/v1');
  reply = { status: 200, body: { profiles: [{ _id: 'prof_a', externalId: 'otra' }, { _id: 'prof_b', externalId: 'acc_1' }] } };
  assert.equal(await profileFor(client, { id: 'acc_1', name: 'Hotel' }), 'prof_b');
  assert.equal(calls.length, 1);
  calls = [];
  let n = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = n++ === 0 ? { profiles: [] } : { message: 'ok', profile: { _id: 'prof_new' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  assert.equal(await profileFor(client, { id: 'acc_2', name: 'Clínica' }), 'prof_new');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { name: 'Clínica', externalId: 'acc_2' });
});

test('webhook de la plataforma: se crea uno solo con nombre, secreto derivado y eventos; si ya existe igual, no se toca', async () => {
  const prev = config.publicBaseUrl;
  config.publicBaseUrl = 'https://bots.example.com';
  try {
    const client = new ZernioClient('zk_x', 'https://z.example/api/v1');
    reply = { status: 200, body: { webhooks: [{ _id: 'wh_otro', url: 'https://otra.app/hook', events: [] }] } };
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(init.method === 'GET' ? reply.body : { success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await ensurePlatformWebhook(client);
    const created = calls.find((c) => c.init.method === 'POST')!;
    const body = JSON.parse(String(created.init.body));
    assert.equal(body.url, 'https://bots.example.com/zernio/events');
    assert.equal(body.secret, platformWebhookSecret());
    assert.ok(body.name);
    assert.ok(body.events.includes('message.received') && body.events.includes('account.disconnected'));
    calls = [];
    reply = { status: 200, body: { webhooks: [{ _id: 'wh_1', ...body }] } };
    await ensurePlatformWebhook(client);
    assert.deepEqual(calls.map((c) => c.init.method), ['GET'], 'ya existe con los mismos eventos');
    calls = [];
    reply = { status: 200, body: { webhooks: [{ _id: 'wh_1', ...body, events: ['message.received'] }] } };
    await ensurePlatformWebhook(client);
    assert.equal(calls[1].init.method, 'PUT');
    assert.equal(JSON.parse(String(calls[1].init.body)).webhookId, 'wh_1');
    config.publicBaseUrl = 'http://localhost:3000';
    calls = [];
    await assert.rejects(ensurePlatformWebhook(client), /HTTPS/);
    assert.equal(calls.length, 0);
  } finally { config.publicBaseUrl = prev; }
});

test('descarga de adjuntos: los de la API de Zernio llevan la llave; los de la red, no', async () => {
  const base = new URL(config.zernioApiUrl).origin;
  await zernioAdapter.downloadMedia!(channel(), { media: { url: `${config.zernioApiUrl}/whatsapp/media/77` } } as any);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer zk_test');
  assert.ok(calls[0].url.startsWith(base));
  calls = [];
  await zernioAdapter.downloadAudio!(channel(), { media: { url: 'https://scontent.cdninstagram.com/v/a.mp4' } } as any);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);
  calls = [];
  assert.equal(await zernioAdapter.downloadMedia!(channel(), { media: { url: 'http://169.254.169.254/latest' } } as any), null, 'solo HTTPS');
  assert.equal(calls.length, 0);
});
