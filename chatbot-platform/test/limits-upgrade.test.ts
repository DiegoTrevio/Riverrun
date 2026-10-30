/** Al topar un límite: qué se topó y a qué plan subir (en la respuesta, el mensaje y los avisos de uso). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const lim = await import('../src/billing/limits.js');

const as = (cookie: string) => (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
let ip = 0;
/** Cuenta activa con el plan `plan`. */
async function account(email: string, plan: string) {
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: `10.7.8.${++ip}`, payload: { name: 'Dueño', company: `Negocio ${email}`, business_type: 'otro', email, password: 'Pz-144-Qx-344-Kv', accept_terms: true } });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().user.account_id as string;
  await pool.query(`UPDATE accounts SET status = 'active', plan = $2, trial_ends_at = NULL WHERE id = $1`, [id, plan]);
  return { api: as(await h.sessionFrom(r)), id };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  for (const p of [
    { key: 'basico', name: 'Básico', price: 199, limits: { channels: 1, users: 2, messages_per_month: 1000 } },
    // Más canales pero un solo usuario: no le sirve a quien ya tiene 2 usuarios.
    { key: 'solo', name: 'Solo', price: 249, limits: { channels: 3, users: 1, messages_per_month: 2000 } },
    { key: 'pro', name: 'Pro', price: 499, limits: { channels: 5, users: 5, messages_per_month: 5000 } },
    // Más barato por mes, pero anual: no se le sugiere a quien paga cada mes.
    { key: 'pro-anual', name: 'Pro anual', price: 4990, interval: 'year', limits: { channels: 5, users: 5, messages_per_month: 5000 } },
    { key: 'total', name: 'Total', price: 999 },
  ]) assert.equal((await h.authed('POST', '/api/plans', p)).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('al topar un límite, la respuesta dice qué se topó y el plan más barato del mismo periodo en el que cabe todo', async () => {
  const a = await account('canales@subir.mx', 'basico');
  assert.equal((await a.api('POST', '/api/users', { email: 'agente@subir.mx', password: 'Pz-101-Qx-301-Kv', role: 'agent' })).statusCode, 200);
  assert.equal((await a.api('POST', '/api/channels', { type: 'webchat', name: 'Web' })).statusCode, 200);
  const r = await a.api('POST', '/api/channels', { type: 'webchat', name: 'Otra web' });
  assert.equal(r.statusCode, 403);
  const body = r.json();
  assert.deepEqual(body.issues, ['limit_reached']);
  assert.deepEqual({ ...body.limit, next_plan: body.limit.next_plan.key }, { key: 'channels', label: 'canales', used: 1, max: 1, next_plan: 'pro' });
  assert.deepEqual(body.limit.next_plan, { key: 'pro', name: 'Pro', price: 499, total: 578.84, currency: 'MXN', interval: 'month', allows: 5 });
  assert.match(body.error, /Tu plan permite hasta 1 canal y ya tienes 1\. El plan Pro incluye hasta 5 canales\./);
});

t('con plan anual se sugiere el anual; sin un plan que alcance, no se sugiere ninguno', async () => {
  const a = await account('anual@subir.mx', 'basico');
  await pool.query(`UPDATE plans SET billing_interval = 'year' WHERE key = 'basico'`);
  try {
    assert.equal((await lim.nextPlanFor(a.id, 'channels', 2))?.key, 'pro-anual');
  } finally {
    await pool.query(`UPDATE plans SET billing_interval = 'month' WHERE key = 'basico'`);
  }
  assert.equal((await lim.nextPlanFor(a.id, 'channels', 6))?.key, 'total', 'sin límite también alcanza');
  await pool.query(`UPDATE plans SET active = false WHERE key = 'total'`);
  try {
    assert.equal(await lim.nextPlanFor(a.id, 'channels', 6), null);
    await a.api('POST', '/api/channels', { type: 'webchat', name: 'Web' });
    const r = await a.api('POST', '/api/channels', { type: 'webchat', name: 'Otra' });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().limit.next_plan?.key, 'solo', 'para 2 canales sí hay plan');
  } finally {
    await pool.query(`UPDATE plans SET active = true WHERE key = 'total'`);
  }
});

t('invitar por encima del límite de usuarios también sugiere el plan', async () => {
  const a = await account('equipo@subir.mx', 'basico');
  assert.equal((await a.api('POST', '/api/invitations', { email: 'uno@subir.mx', name: 'Uno', role: 'agent' })).statusCode, 200);
  const r = await a.api('POST', '/api/invitations', { email: 'dos@subir.mx', name: 'Dos', role: 'agent' });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().limit.key, 'users');
  assert.equal(r.json().limit.next_plan.key, 'pro', '"Solo" no alcanza: permite 1 usuario');
  assert.match(r.json().error, /El plan Pro incluye hasta 5 usuarios/);
});

t('el aviso de mensajes nombra el plan sugerido y su enlace lo deja elegido en Mi plan', async () => {
  const a = await account('mensajes@subir.mx', 'basico');
  outbox.length = 0;
  await lim.noticeMessagesReached(a.id);
  const n = (await pool.query(`SELECT body, link FROM notifications WHERE account_id = $1 AND kind = 'billing' ORDER BY id DESC LIMIT 1`, [a.id])).rows[0];
  assert.equal(n.link, '#/plan?subir=solo', 'Solo alcanza en mensajes y cabe (1 usuario)');
  assert.match(n.body, /El plan Solo incluye hasta 2,000 mensajes del asistente al mes\./);
  const mail = outbox.find((m) => m.to === 'mensajes@subir.mx')!;
  assert.match(mail.text, /Subir al plan Solo: https:\/\/bot\.test\/#\/plan\?subir=solo/);
});
