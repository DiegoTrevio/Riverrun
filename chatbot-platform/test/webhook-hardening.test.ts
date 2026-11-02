/**
 * IN-2: el webhook de WhatsApp (Evolution) solo se acepta desde la red interna cuando WEBHOOK_BASE_URL es interna.
 * IN-3: los webhooks tienen tope de 1 MB, la bitácora no se llena con rechazos y una petición tiene tiempo máximo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';
const { internalWebhookBase, WEBHOOK_BODY_LIMIT } = await import('../src/routes/public.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const upsert = (text: string, id: string) => ({
  event: 'messages.upsert', instance: 'palmas',
  data: { key: { remoteJid: '5215511112222@s.whatsapp.net', fromMe: false, id }, pushName: 'Ana', message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) },
});
const stored = async (text: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE content = $1`, [text])).rows[0].n);

test('IN-2: qué cuenta como dirección interna para los webhooks', () => {
  for (const base of ['http://backend:3000', 'http://localhost:3000', 'http://10.0.0.5:3000', 'http://[::1]:3000']) assert.equal(internalWebhookBase(base), true, base);
  for (const base of ['https://bot.ejemplo.com', 'http://203.0.113.5:3000', 'no es url']) assert.equal(internalWebhookBase(base), false, base);
});

t('IN-2: un aviso de WhatsApp por el proxy o desde una IP pública se rechaza como token inválido; desde Evolution entra', async () => {
  const url = `/webhook/${h.token}`;
  const viaProxy = await h.app.inject({ method: 'POST', url, payload: upsert('Inventado por el proxy', 'X-1'), headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(viaProxy.statusCode, 404);
  const publicIp = await h.app.inject({ method: 'POST', url, payload: upsert('Inventado desde afuera', 'X-2'), remoteAddress: '203.0.113.9' });
  assert.equal(publicIp.statusCode, 404);
  const internal = await h.app.inject({ method: 'POST', url, payload: upsert('Mensaje real de Evolution', 'X-3'), remoteAddress: '172.18.0.4' });
  assert.equal(internal.statusCode, 200, internal.body);
  await h.idle();
  assert.equal(await stored('Inventado por el proxy'), 0);
  assert.equal(await stored('Inventado desde afuera'), 0);
  assert.equal(await stored('Mensaje real de Evolution'), 1);
});

t('IN-3: un webhook de más de 1 MB se rechaza sin procesarlo', async () => {
  const big = 'x'.repeat(WEBHOOK_BODY_LIMIT + 10);
  for (const url of [`/webhook/${h.token}`, `/webhook/${h.token}/messages-upsert`, '/zernio/events', '/meta/webhook', '/webhook/billing/stripe']) {
    const r = await h.app.inject({ method: 'POST', url, payload: JSON.stringify({ big }), headers: { 'content-type': 'application/json' } });
    assert.equal(r.statusCode, 413, `${url}: ${r.statusCode}`);
  }
  // Un aviso normal sigue entrando.
  assert.equal((await h.app.inject({ method: 'POST', url: `/webhook/${h.token}`, payload: upsert('Aviso normal', 'X-4') })).statusCode, 200);
});

t('IN-3: muchos rechazos desde la misma conexión dejan a lo más 10 registros por minuto en la bitácora', async () => {
  const count = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE message = 'Webhook con token inválido'`)).rows[0].n);
  const before = await count();
  for (let i = 0; i < 40; i++) {
    const r = await h.app.inject({ method: 'POST', url: '/webhook/token-que-no-existe', payload: { x: i }, remoteAddress: '198.51.100.20' });
    assert.equal(r.statusCode, 404);
  }
  const added = (await count()) - before;
  assert.ok(added <= 10 && added >= 1, `se registraron ${added}`);
});

t('IN-3: una petición tiene 2 minutos para llegar completa', async () => {
  assert.equal(h.app.server.requestTimeout, 120_000);
});
