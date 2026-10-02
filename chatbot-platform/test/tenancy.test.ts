/** Cuentas, usuarios y roles: cada cuenta solo ve y modifica lo suyo. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

type Api = Awaited<ReturnType<typeof h.loginAs>>;
const A = { id: '', bot: '', channel: '', token: '', knowledge: '', conv: '', contact: '', api: null as unknown as Api };
const B = { id: '', bot: '', channel: '', token: '', knowledge: '', conv: '', contact: '', api: null as unknown as Api };

async function setupAccount(x: typeof A, name: string, email: string, instance: string, phone: string) {
  const acc = await h.authed('POST', '/api/accounts', { name, admin: { name: `Admin ${name}`, email, password: 'clave-segura-1' } });
  assert.equal(acc.statusCode, 200, acc.body);
  x.id = acc.json().id;
  x.api = await h.loginAs(email, 'clave-segura-1');
  // El administrador crea todo sin indicar cuenta: se usa la suya.
  const bot = await x.api('POST', '/api/chatbots', { name: `Bot ${name}`, active: true, ai: { debounce_seconds: 0.1 } });
  assert.equal(bot.statusCode, 200, bot.body);
  x.bot = bot.json().id;
  assert.equal(bot.json().account_id, x.id);
  x.knowledge = (await x.api('POST', `/api/chatbots/${x.bot}/knowledge`, { title: 'Info', content: `Datos de ${name}` })).json().id;
  const ch = await x.api('POST', '/api/channels', { type: 'whatsapp', name: `WA ${name}`, chatbot_id: x.bot, config: { instance } });
  assert.equal(ch.statusCode, 200, ch.body);
  x.channel = ch.json().id;
  x.token = ch.json().webhook_token;
  h.token = x.token;
  h.sent.length = 0;
  await h.app.inject({
    method: 'POST',
    url: `/webhook/${x.token}`,
    payload: { event: 'messages.upsert', instance, data: { key: { remoteJid: `${phone}@s.whatsapp.net`, id: `M-${name}` }, pushName: name, message: { conversation: 'hola' }, messageTimestamp: Math.floor(Date.now() / 1000) } },
  });
  await waitFor(() => h.sent.length === 1);
  const conv = (await x.api('GET', '/api/conversations')).json()[0];
  x.conv = conv.id;
  x.contact = conv.contact_id;
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  h.setScript(() => ({ messages: ['Hola'] }));
  await setupAccount(A, 'Hotel', 'admin@hotel.mx', 'hotel', '5215511110001');
  await setupAccount(B, 'Inmobiliaria', 'admin@inmo.mx', 'inmo', '5215511110002');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('cada administrador solo lista lo de su cuenta', async () => {
  for (const [x, other] of [[A, B], [B, A]] as const) {
    const bots = (await x.api('GET', '/api/chatbots')).json();
    assert.deepEqual(bots.map((b: any) => b.id), [x.bot]);
    const channels = (await x.api('GET', '/api/channels')).json();
    assert.deepEqual(channels.map((c: any) => c.id), [x.channel]);
    const convs = (await x.api('GET', '/api/conversations')).json();
    assert.deepEqual(convs.map((c: any) => c.id), [x.conv]);
    const accounts = (await x.api('GET', '/api/accounts')).json();
    assert.deepEqual(accounts.map((a: any) => a.id), [x.id]);
    const users = (await x.api('GET', '/api/users')).json();
    assert.ok(users.every((u: any) => u.account_id === x.id));
    const logs = (await x.api('GET', '/api/logs')).json();
    assert.ok(logs.length > 0 && logs.every((l: any) => l.account_id === x.id));
    // Pedir explícitamente otra cuenta no sirve
    assert.deepEqual((await x.api('GET', `/api/chatbots?account_id=${other.id}`)).json().map((b: any) => b.id), [x.bot]);
  }
});

t('no se puede leer ni modificar nada de otra cuenta (404)', async () => {
  const api = A.api;
  const attempts: [string, string, unknown?][] = [
    ['GET', `/api/chatbots/${B.bot}`],
    ['PUT', `/api/chatbots/${B.bot}`, { name: 'hackeado' }],
    ['DELETE', `/api/chatbots/${B.bot}`],
    ['POST', `/api/chatbots/${B.bot}/duplicate`, {}],
    ['GET', `/api/chatbots/${B.bot}/knowledge`],
    ['POST', `/api/chatbots/${B.bot}/knowledge`, { title: 'x', content: 'x' }],
    ['PUT', `/api/knowledge/${B.knowledge}`, { content: 'hackeado' }],
    ['DELETE', `/api/knowledge/${B.knowledge}`],
    ['GET', `/api/chatbots/${B.bot}/images`],
    ['POST', `/api/chatbots/${B.bot}/playground`, { text: 'hola' }],
    ['GET', `/api/channels/${B.channel}`],
    ['PUT', `/api/channels/${B.channel}`, { name: 'hackeado' }],
    ['DELETE', `/api/channels/${B.channel}`],
    ['POST', `/api/channels/${B.channel}/setup`, {}],
    ['GET', `/api/conversations/${B.conv}`],
    ['POST', `/api/conversations/${B.conv}/takeover`],
    ['POST', `/api/conversations/${B.conv}/send`, { text: 'hola' }],
    ['POST', `/api/conversations/${B.conv}/reset-memory`],
    ['PUT', `/api/contacts/${B.contact}`, { name: 'hackeado' }],
  ];
  for (const [method, url, payload] of attempts) {
    const r = await api(method, url, payload);
    assert.equal(r.statusCode, 404, `${method} ${url} → ${r.statusCode} ${r.body}`);
  }
  // Nada cambió en la cuenta B
  const botB = (await B.api('GET', `/api/chatbots/${B.bot}`)).json();
  assert.equal(botB.name, 'Bot Inmobiliaria');
  assert.equal((await B.api('GET', `/api/chatbots/${B.bot}/knowledge`)).json()[0].content, 'Datos de Inmobiliaria');
  assert.equal((await B.api('GET', `/api/conversations/${B.conv}`)).json().conversation.status, 'bot');
});

t('no se puede asignar a un canal el chatbot de otra cuenta ni crear cosas en otra cuenta', async () => {
  const r = await A.api('PUT', `/api/channels/${A.channel}`, { chatbot_id: B.bot });
  assert.equal(r.statusCode, 404);
  const c = await A.api('POST', '/api/channels', { type: 'telegram', name: 'x', chatbot_id: B.bot });
  assert.equal(c.statusCode, 404);
  // account_id ajeno se ignora: se crea en la propia cuenta
  const bot = await A.api('POST', '/api/chatbots', { name: 'Otro', account_id: B.id });
  assert.equal(bot.json().account_id, A.id);
  const user = await A.api('POST', '/api/users', { email: 'agente@hotel.mx', password: 'clave-agente-1', role: 'agent', account_id: B.id });
  assert.equal(user.statusCode, 200, user.body);
  assert.equal(user.json().account_id, A.id);
  // Un administrador no puede crear superadministradores ni cuentas
  assert.equal((await A.api('POST', '/api/users', { email: 'x@x.mx', password: 'clave-segura-9', role: 'superadmin' })).statusCode, 403);
  assert.equal((await A.api('POST', '/api/accounts', { name: 'x' })).statusCode, 403);
  const usersB = (await h.authed('GET', `/api/users?account_id=${B.id}`)).json();
  assert.equal((await A.api('PUT', `/api/users/${usersB[0].id}`, { active: false })).statusCode, 404);
});

t('el agente solo atiende conversaciones: no ve ni cambia configuración', async () => {
  const agent = await h.loginAs('agente@hotel.mx', 'clave-agente-1');
  const bots = (await agent('GET', '/api/chatbots')).json();
  assert.ok(bots.length >= 1);
  assert.equal(bots[0].personality, undefined, 'el agente no ve la configuración');
  const channels = (await agent('GET', '/api/channels')).json();
  assert.equal(channels[0].config, undefined);
  assert.equal(channels[0].webhook_token, undefined);
  for (const [method, url, payload] of [
    ['PUT', `/api/chatbots/${A.bot}`, { name: 'x' }],
    ['POST', '/api/chatbots', { name: 'x' }],
    ['GET', `/api/chatbots/${A.bot}/knowledge`],
    ['POST', '/api/channels', { type: 'webchat', name: 'x' }],
    ['GET', `/api/channels/${A.channel}`],
    ['GET', '/api/logs'],
    ['GET', '/api/users'],
  ] as const) {
    assert.equal((await agent(method, url, payload)).statusCode, 403, `${method} ${url}`);
  }
  // Pero sí atiende conversaciones de su cuenta
  assert.equal((await agent('GET', `/api/conversations/${A.conv}`)).statusCode, 200);
  h.sent.length = 0;
  const send = await agent('POST', `/api/conversations/${A.conv}/send`, { text: 'Hola, soy del equipo' });
  assert.equal(send.statusCode, 200, send.body);
  assert.equal(h.sent[0].text, 'Hola, soy del equipo');
  assert.equal((await agent('GET', `/api/conversations/${A.conv}`)).json().conversation.status, 'human');
  assert.equal((await agent('GET', `/api/conversations/${B.conv}`)).statusCode, 404);
});

t('superadmin ve todas las cuentas y puede filtrar por una', async () => {
  const all = (await h.authed('GET', '/api/chatbots')).json().map((b: any) => b.account_id);
  assert.ok(all.includes(A.id) && all.includes(B.id));
  const onlyB = (await h.authed('GET', `/api/conversations?account_id=${B.id}`)).json();
  assert.ok(onlyB.length > 0 && onlyB.every((c: any) => c.account_id === B.id));
});

t('desactivar una cuenta: sus usuarios pierden acceso y sus canales dejan de responder', async () => {
  await h.authed('PUT', `/api/accounts/${B.id}`, { active: false });
  assert.equal((await B.api('GET', '/api/chatbots')).statusCode, 401, 'la sesión abierta deja de servir');
  const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@inmo.mx', password: 'clave-segura-1' } });
  assert.equal(login.statusCode, 401);
  h.sent.length = 0;
  h.calls.length = 0;
  await h.app.inject({
    method: 'POST',
    url: `/webhook/${B.token}`,
    payload: { event: 'messages.upsert', instance: 'inmo', data: { key: { remoteJid: '5215511110002@s.whatsapp.net', id: 'M-B-2' }, message: { conversation: 'sigue ahí?' }, messageTimestamp: Math.floor(Date.now() / 1000) } },
  });
  await sleep(400);
  assert.equal(h.sent.length, 0);
  assert.equal(h.calls.length, 0);
  // Se guardó para cuando la cuenta vuelva
  const conv = (await h.authed('GET', `/api/conversations/${B.conv}`)).json();
  assert.equal(conv.messages.at(-1).content, 'sigue ahí?');
  await h.authed('PUT', `/api/accounts/${B.id}`, { active: true });
  const again = await h.loginAs('admin@inmo.mx', 'clave-segura-1');
  assert.equal((await again('GET', '/api/me')).statusCode, 200, 'al reactivar la cuenta vuelve el acceso');
});

t('protecciones de usuarios: no autodesactivarse, siempre queda un superadmin, contraseña propia', async () => {
  const me = (await h.authed('GET', '/api/me')).json().user;
  assert.equal((await h.authed('PUT', `/api/users/${me.id}`, { active: false })).statusCode, 400);
  assert.equal((await h.authed('DELETE', `/api/users/${me.id}`)).statusCode, 400);
  const bad = await A.api('PUT', '/api/me/password', { current: 'incorrecta', password: 'nueva-clave-123' });
  assert.equal(bad.statusCode, 400);
  const other = await h.loginAs('admin@hotel.mx', 'clave-segura-1'); // otra sesión abierta (p.ej. otro dispositivo)
  const good = await A.api('PUT', '/api/me/password', { current: 'clave-segura-1', password: 'nueva-clave-123' });
  assert.equal(good.statusCode, 200);
  assert.equal((await other('GET', '/api/me')).statusCode, 401, 'las otras sesiones se cierran al cambiar la contraseña');
  A.api = await h.loginAs('admin@hotel.mx', 'nueva-clave-123');
  const weak = await A.api('POST', '/api/users', { email: 'otro@hotel.mx', password: '123', role: 'agent' });
  assert.equal(weak.statusCode, 400);
  const dup = await A.api('POST', '/api/users', { email: 'AGENTE@hotel.mx', password: 'clave-agente-2', role: 'agent' });
  assert.equal(dup.statusCode, 409, 'correo duplicado sin importar mayúsculas');
});

t('eliminar una cuenta borra todo lo suyo y nada de las demás', async () => {
  const r = await h.authed('DELETE', `/api/accounts/${B.id}`);
  assert.equal(r.statusCode, 200);
  assert.equal((await h.authed('GET', `/api/chatbots/${B.bot}`)).statusCode, 404);
  assert.equal((await h.authed('GET', `/api/conversations/${B.conv}`)).statusCode, 404);
  const a2 = await h.loginAs('admin@hotel.mx', 'nueva-clave-123');
  assert.equal((await a2('GET', `/api/chatbots/${A.bot}`)).statusCode, 200);
});

t('falsear X-Forwarded-For no sirve para saltarse el límite de intentos de login', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 10; i++) {
    // El cliente inventa una IP distinta cada vez; el proxy (último salto) agrega la real.
    const r = await h.app.inject({ method: 'POST', url: '/api/login', headers: { 'x-forwarded-for': `1.2.3.${i}, 10.9.9.9` }, payload: { email: 'nadie@x.mx', password: 'mala-clave-1' } });
    codes.push(r.statusCode);
  }
  assert.ok(codes.includes(429), JSON.stringify(codes));
});
