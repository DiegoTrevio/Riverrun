/** Planes con límites reales: canales, usuarios, asistentes y mensajes del mes. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const lim = await import('../src/billing/limits.js');

const as = (cookie: string) => (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
let ip = 0;
async function signup(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: `10.7.7.${++ip}`, payload: { name: 'Dueño', company: `Negocio ${email}`, business_type: 'otro', email, password: 'clave-segura-1', accept_terms: true } });
  assert.equal(r.statusCode, 200, r.body);
  return { api: as(String(r.headers['set-cookie']).split(';')[0]), account: r.json().user.account_id as string };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('la prueba gratuita trae límites por defecto y los muestra con su uso', async () => {
  const a = await signup('prueba@limites.mx');
  const eff = await lim.effectiveLimits(a.account);
  assert.equal(eff.source, 'trial');
  assert.deepEqual(eff.limits, { messages_per_month: 300, channels: 2, users: 3, chatbots: 2 });
  const view = (await a.api('GET', '/api/billing')).json();
  assert.deepEqual(view.limits.items.map((i: any) => [i.key, i.max]), [['messages_per_month', 300], ['channels', 2], ['users', 3], ['chatbots', 2]]);
  assert.equal(view.limits.items.find((i: any) => i.key === 'users').used, 1);
});

t('crear canales, usuarios y asistentes por encima del límite se rechaza con un mensaje claro', async () => {
  const a = await signup('tope@limites.mx');
  await h.authed('PUT', `/api/accounts/${a.account}`, { limits_override: { channels: 1, users: 2, chatbots: 1 } });
  assert.equal((await a.api('POST', '/api/chatbots', { name: 'Uno', active: true })).statusCode, 200);
  const second = await a.api('POST', '/api/chatbots', { name: 'Dos', active: true });
  assert.equal(second.statusCode, 403);
  assert.match(second.json().error, /Tu plan permite hasta 1 asistente y ya tienes 1/);
  assert.equal((await a.api('POST', '/api/channels', { type: 'webchat', name: 'Web' })).statusCode, 200);
  const ch2 = await a.api('POST', '/api/channels', { type: 'telegram', name: 'TG', config: { bot_token: '123:abc' } });
  assert.equal(ch2.statusCode, 403);
  assert.match(ch2.json().error, /1 canal/);
  assert.equal((await a.api('POST', '/api/users', { email: 'agente1@limites.mx', password: 'clave-agente-1', role: 'agent' })).statusCode, 200);
  assert.equal((await a.api('POST', '/api/users', { email: 'agente2@limites.mx', password: 'clave-agente-2', role: 'agent' })).statusCode, 403);
  // Duplicar también cuenta
  const bot = (await a.api('GET', '/api/chatbots')).json()[0];
  assert.equal((await a.api('POST', `/api/chatbots/${bot.id}/duplicate`)).statusCode, 403);
});

t('el plan contratado manda sobre la prueba, y la excepción del superadmin sobre el plan', async () => {
  const a = await signup('plan@limites.mx');
  await h.authed('POST', '/api/plans', { key: 'basico', name: 'Básico', price: 299, limits: { channels: 1, messages_per_month: 1000 } });
  await pool.query(`UPDATE accounts SET status = 'active', plan = 'basico' WHERE id = $1`, [a.account]);
  let eff = await lim.effectiveLimits(a.account);
  assert.equal(eff.source, 'plan');
  assert.deepEqual(eff.limits, { channels: 1, messages_per_month: 1000 });
  await h.authed('PUT', `/api/accounts/${a.account}`, { limits_override: { channels: 10 } });
  eff = await lim.effectiveLimits(a.account);
  assert.equal(eff.source, 'override');
  assert.deepEqual(eff.limits, { channels: 10, messages_per_month: 1000 }, 'la excepción cambia solo lo indicado');
  await h.authed('PUT', `/api/accounts/${a.account}`, { limits_override: {} });
  assert.equal((await lim.effectiveLimits(a.account)).source, 'plan');
  // Una cuenta activada a mano, sin plan, no tiene límites
  await pool.query(`UPDATE accounts SET status = 'active', plan = '' WHERE id = $1`, [a.account]);
  assert.deepEqual((await lim.effectiveLimits(a.account)).limits, {});
  // Validación de planes
  assert.equal((await h.authed('POST', '/api/plans', { key: 'malo', name: 'x', price: 1, limits: { channels: 0 } })).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'malo', name: 'x', price: 1, limits: { inventado: 5 } })).statusCode, 400);
});

t('mensajes del mes: avisa al 80 % y al 100 %, y el asistente deja de responder al agotarse', async () => {
  await h.createBot();
  await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [h.accountId]);
  await h.authed('PUT', `/api/accounts/${h.accountId}`, { limits_override: { messages_per_month: 5 } });
  await h.authed('POST', `/api/accounts/${h.accountId}/admins`, {}).catch(() => undefined);
  const admin = await pool.query(`INSERT INTO users (account_id, role, name, email, password_hash, active) VALUES ($1,'admin','Dueña','dueña@cupo.mx','x',true) RETURNING id`, [h.accountId]);
  assert.ok(admin.rows[0].id);
  h.setScript(() => ({ messages: ['Respuesta'] }));
  const phone = (i: number) => `52155400000${i}`;
  for (let i = 1; i <= 5; i++) {
    await h.webhook(`mensaje ${i}`, { phone: phone(i) });
    await waitFor(() => h.sent.filter((s) => s.kind === 'text').length === i, 8000);
  }
  await waitFor(async () => (await lim.messagesUsed(h.accountId)) === 5, 5000);
  await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND kind = 'billing'`, [h.accountId])).rows[0].n >= 2, 5000);
  const notices = async () => (await pool.query(`SELECT title FROM notifications WHERE account_id = $1 AND kind = 'billing' ORDER BY id`, [h.accountId])).rows.map((r: any) => r.title);
  const titles = await notices();
  assert.equal(titles.filter((x: string) => /Estás por llegar/.test(x)).length, 1, 'un solo aviso al 80 %');
  assert.equal(titles.filter((x: string) => /Llegaste al límite/.test(x)).length, 1, 'un solo aviso al 100 %');
  assert.ok(outbox.some((m) => m.to === 'dueña@cupo.mx' && /Llegaste al límite/.test(m.subject)));
  // El sexto mensaje ya no se responde (y no se queda en bucle)
  h.reset();
  await h.webhook('mensaje 6', { phone: phone(6) });
  await h.idle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.calls.length, 0, 'ni siquiera se llamó a la IA');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE processed = false AND direction = 'in'`)).rows[0].n, 0);
  assert.equal((await notices()).filter((x: string) => /Llegaste al límite/.test(x)).length, 1, 'no repite el aviso');
  // Sube el límite: vuelve a responder
  await h.authed('PUT', `/api/accounts/${h.accountId}`, { limits_override: { messages_per_month: 50 } });
  await h.webhook('mensaje 7', { phone: phone(7) });
  await waitFor(() => h.sent.length === 1, 8000);
  // El simulador no cuenta
  const before = await lim.messagesUsed(h.accountId);
  await h.authed('POST', `/api/chatbots/${h.botId}/playground`, { session: 'abc', text: 'hola' });
  assert.equal(await lim.messagesUsed(h.accountId), before);
});

t('el contador es mensual: otro mes empieza en cero', async () => {
  const a = await signup('mes@limites.mx');
  await lim.recordMessage(a.account, new Date('2026-09-30T23:00:00Z'));
  await lim.recordMessage(a.account, new Date('2026-10-01T01:00:00Z'));
  assert.equal(await lim.messagesUsed(a.account, '2026-09'), 1);
  assert.equal(await lim.messagesUsed(a.account, '2026-10'), 1);
});

t('una campaña más grande que el cupo restante no se lanza', async () => {
  await h.authed('PUT', `/api/accounts/${h.accountId}`, { limits_override: { messages_per_month: await lim.messagesUsed(h.accountId) + 1 } });
  const camp = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Grande', message: 'Promo', audience: {}, rate_per_minute: 60 })).json();
  const r = await h.authed('POST', `/api/campaigns/${camp.id}/launch`);
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Tu plan permite 1 mensajes más este mes/);
  assert.equal((await h.authed('GET', '/api/campaigns')).json().find((x: any) => x.id === camp.id).status, 'draft');
});
