/** Enviar conversaciones a la app del cliente: resumen, completa o ambos, por reglas (contexto o etiquetas), a mano o por la API. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { conversationExport } = await import('../src/integrations/conversation-export.js');

/** La app del cliente (receptor de webhooks de prueba). */
const received: { path: string; headers: http.IncomingHttpHeaders; raw: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body: any = null; try { body = JSON.parse(raw); } catch { /* */ }
    received.push({ path: req.url!, headers: req.headers, raw, body });
    res.writeHead(200); res.end('ok');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = (p: string) => `http://127.0.0.1:${(server.address() as any).port}${p}`;
const until = (cond: () => boolean) => waitFor(async () => { await h.service.automator.settleAll(); await h.fastForward(); return cond(); }, 8000);
const sentTo = (path: string) => received.filter((r) => r.path === path && r.body?.type === 'conversation.sent');
const endpoint = async (path: string, events: string[]) => {
  const r = await h.authed('POST', '/api/webhook-endpoints', { account_id: h.accountId, url: url(path), description: `App ${path}`, events });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const rule = async (body: Record<string, unknown>) => {
  const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, ...body });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const PHONE = '5215590000001';
let conv: any;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({});
  h.setScript(() => ({ messages: ['¡Hola! Tenemos citas el lunes.'] }));
  h.setSummary('Ana quiere una cita para limpieza dental el lunes.');
  await h.webhook('Hola, quiero una cita para limpieza', { phone: PHONE });
  await waitFor(() => h.sent.length >= 1, 10_000);
  await h.idle();
  conv = await h.conversationFor(PHONE);
  assert.ok(conv?.id);
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('sin una app conectada: el envío manual lo explica y no gasta IA', async () => {
  const before = h.summaryCalls.length;
  const r = await h.authed('POST', `/api/conversations/${conv.id}/send-to-app`, { content: 'summary' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Integraciones/);
  assert.equal(h.summaryCalls.length, before);
});

t('una marca del equipo (etiqueta) envía la conversación completa a la app, firmada', async () => {
  await endpoint('/crm', ['conversation.sent']);
  await rule({ name: 'Marcada → completa a mi app', trigger: { type: 'tag_added', tag: 'enviar-completa' }, actions: [{ type: 'send_conversation', content: 'full' }] });
  received.length = 0;
  // Alguien del equipo marca al cliente desde el panel.
  const put = await h.authed('PUT', `/api/contacts/${conv.contact_id}`, { tags: ['enviar-completa'] });
  assert.equal(put.statusCode, 200, put.body);
  await until(() => sentTo('/crm').length >= 1);
  const [got] = sentTo('/crm');
  const secret = (await h.authed('GET', `/api/settings/secrets?account_id=${h.accountId}`)).json().webhook_secret;
  assert.equal(got.headers['x-signature'], `sha256=${crypto.createHmac('sha256', secret).update(got.raw).digest('hex')}`);
  assert.equal(got.headers['x-riverrun-event'], 'conversation.sent');
  const d = got.body.data;
  assert.equal(d.content, 'full');
  assert.equal(d.conversation.id, conv.id);
  assert.equal(d.contact.phone, PHONE);
  assert.deepEqual(d.trigger, { rule: 'Marcada → completa a mi app', event: 'tag_added', tag: 'enviar-completa' });
  assert.equal(d.summary, undefined, 'solo se pidió la conversación');
  assert.equal(d.transcript.truncated, false);
  assert.deepEqual(d.transcript.messages.map((m: any) => [m.direction, m.text]), [['inbound', 'Hola, quiero una cita para limpieza'], ['outbound', '¡Hola! Tenemos citas el lunes.']]);
});

t('por contexto (objetivo cumplido): el resumen, actualizado solo si hace falta', async () => {
  await rule({ name: 'Objetivo → resumen a mi app', trigger: { type: 'goal_completed' }, actions: [{ type: 'send_conversation', content: 'summary' }] });
  received.length = 0;
  const before = h.summaryCalls.length;
  h.service.automator.emit({ type: 'goal_completed', conversationId: conv.id });
  await until(() => sentTo('/crm').length >= 1);
  const d = sentTo('/crm')[0].body.data;
  assert.equal(d.content, 'summary');
  assert.equal(d.summary.text, 'Ana quiere una cita para limpieza dental el lunes.');
  assert.equal(d.summary.stale, false);
  assert.equal(d.transcript, undefined, 'solo se pidió el resumen');
  assert.equal(d.trigger.event, 'goal_completed');
  assert.equal(h.summaryCalls.length, before + 1, 'no había resumen: se generó');

  // Ya al día: un segundo envío no vuelve a gastar IA.
  received.length = 0;
  h.service.automator.emit({ type: 'goal_completed', conversationId: conv.id });
  await until(() => sentTo('/crm').length >= 1);
  assert.equal(h.summaryCalls.length, before + 1);
});

t('ambos a una app elegida: solo esa lo recibe', async () => {
  const otra = await endpoint('/otra', ['contact.created']);
  await rule({ name: 'VIP → todo a la otra app', trigger: { type: 'tag_added', tag: 'vip' }, actions: [{ type: 'send_conversation', content: 'both', endpoint_id: otra.id }] });
  received.length = 0;
  await h.authed('PUT', `/api/contacts/${conv.contact_id}`, { tags: ['enviar-completa', 'vip'] });
  await until(() => sentTo('/otra').length >= 1);
  const d = sentTo('/otra')[0].body.data;
  assert.equal(d.content, 'both');
  assert.ok(d.summary.text);
  assert.equal(d.transcript.messages.length, 2);
  assert.equal(sentTo('/crm').length, 0, 'la regla eligió la otra app');
});

t('una regla no puede apuntar a la app de otra cuenta', async () => {
  const otherAcc = (await h.authed('POST', '/api/accounts', { name: 'Otra empresa' })).json();
  const foreign = (await h.authed('POST', '/api/webhook-endpoints', { account_id: otherAcc.id, url: url('/ajena'), events: ['*'] })).json();
  const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Ajena', trigger: { type: 'goal_completed' }, actions: [{ type: 'send_conversation', content: 'full', endpoint_id: foreign.id }] });
  assert.equal(r.statusCode, 400);
});

t('a mano desde el panel; un operador solo envía las conversaciones que ve', async () => {
  received.length = 0;
  const dests = (await h.authed('GET', `/api/conversations/${conv.id}/app-destinations`)).json();
  assert.ok(dests.every((x: any) => !('url' in x)), 'no se expone la URL completa');
  assert.ok(dests.some((x: any) => x.receives_conversations));
  const r = await h.authed('POST', `/api/conversations/${conv.id}/send-to-app`, { content: 'full' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sent, 1, 'solo la app que recibe conversaciones');
  await until(() => sentTo('/crm').length >= 1);
  const d = sentTo('/crm')[0].body.data;
  assert.match(d.reason, /desde el panel/);
  assert.equal(d.trigger.event, 'manual');

  await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'operador@clinica.mx', name: 'Operador', password: 'Pz-135-Qx-335-Kv', role: 'agent' });
  const agent = await h.loginAs('operador@clinica.mx', 'Pz-135-Qx-335-Kv');
  assert.equal((await agent('POST', `/api/conversations/${conv.id}/send-to-app`, { content: 'summary' })).statusCode, 404, 'no la tiene asignada');
});

t('la app también puede pedirla por la API v1, solo de su cuenta', async () => {
  const key = (await h.authed('POST', '/api/api-keys', { account_id: h.accountId, name: 'Mi app', scope: 'read' })).json().key;
  const get = (path: string) => h.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${key}` } });
  const r = await get(`/api/v1/conversations/${conv.id}/export?content=full`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().content, 'full');
  assert.equal(r.json().transcript.messages[0].text, 'Hola, quiero una cita para limpieza');
  assert.equal((await get(`/api/v1/conversations/${conv.id}/export`)).json().content, 'both', 'por omisión, ambos');
  assert.equal((await get(`/api/v1/conversations/${conv.id}/export?content=todo`)).statusCode, 400);
  assert.equal((await get(`/api/v1/conversations/${crypto.randomUUID()}/export`)).statusCode, 404);
  const spec = (await h.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
  assert.ok(spec.paths['/conversations/{id}/export']);
});

t('conversación muy larga: van los mensajes más recientes y la ruta para pedir el resto', async () => {
  const d: any = await conversationExport(conv.id, { content: 'full', maxMessages: 1 });
  assert.equal(d.transcript.truncated, true);
  assert.equal(d.transcript.included, 1);
  assert.equal(d.transcript.total, 2);
  assert.equal(d.transcript.messages[0].text, '¡Hola! Tenemos citas el lunes.', 'el más reciente');
  assert.equal(d.transcript.more, `/api/v1/conversations/${conv.id}/messages?after=0`);
});

t('el evento se puede elegir al crear el webhook', async () => {
  const events = (await h.authed('GET', '/api/webhook-events')).json();
  assert.ok(events.some((e: any) => e.type === 'conversation.sent'));
});
