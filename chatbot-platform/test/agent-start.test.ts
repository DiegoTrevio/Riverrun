/** Probar y conectar: el WhatsApp de cada agente y el encendido automático la primera vez que se conecta. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { recordConnectionState } = await import('../src/lifecycle.js');

const agent = async (name: string, extra: Record<string, unknown> = {}) => {
  const r = await h.authed('POST', '/api/chatbots/wizard', { account_id: h.accountId, ...extra, company: { name, business_type: 'otro', description: `${name}: tienda de ropa con envíos a todo el país y precios en la página.` } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const bot = async (id: string) => (await pool.query(`SELECT active, start_on_connect FROM chatbots WHERE id = $1`, [id])).rows[0];
const whatsapp = (id: string, as = h.authed) => as('POST', `/api/chatbots/${id}/whatsapp`);
const connection = (ch: any, state: string) => h.app.inject({ method: 'POST', url: `/webhook/${ch.webhook_token}`, payload: { event: 'connection.update', instance: ch.config.instance, data: { state } } });
const turnedOnLogs = async (botId: string) => (await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE chatbot_id = $1 AND message LIKE 'Agente encendido al conectar%'`, [botId])).rows[0].n;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  // Una administradora de la cuenta, para recibir el aviso de "ya está respondiendo".
  await h.addUser({ account_id: h.accountId, email: 'duena@tienda.mx', name: 'Dueña', password: 'Pz-117-Qx-317-Kv', role: 'admin' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el WhatsApp del agente se crea una sola vez y queda asignado a él', async () => {
  const a = await agent('Tienda Uno');
  const [r1, r2] = await Promise.all([whatsapp(a.id), whatsapp(a.id)]);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().id, r2.json().id, 'dos clics al mismo tiempo no crean dos WhatsApp');
  assert.equal(r1.json().chatbot_id, a.id);
  assert.equal(r1.json().type, 'whatsapp');
  assert.equal((await whatsapp(a.id)).json().id, r1.json().id);
});

t('al conectarse el WhatsApp, el agente se enciende solo, una vez, con un registro y un aviso', async () => {
  const a = await agent('Tienda Dos');
  assert.deepEqual(await bot(a.id), { active: false, start_on_connect: true });
  const ch = (await whatsapp(a.id)).json();
  await connection(ch, 'connecting');
  assert.equal((await bot(a.id)).active, false, 'conectando todavía no cuenta');
  await connection(ch, 'open');
  await waitFor(async () => (await bot(a.id)).active === true);
  assert.deepEqual(await bot(a.id), { active: true, start_on_connect: false });
  assert.equal(await turnedOnLogs(a.id), 1);
  const owner = await h.loginAs('duena@tienda.mx', 'Pz-117-Qx-317-Kv');
  const notes = (await owner('GET', '/api/notifications')).json().items.filter((n: any) => n.title === 'Tu agente ya está respondiendo');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].link, `#/bot/${a.id}/empezar`);

  // Si alguien lo apaga a mano, una reconexión no lo vuelve a encender.
  assert.equal((await h.authed('PUT', `/api/chatbots/${a.id}`, { active: false })).statusCode, 200);
  await connection(ch, 'close');
  await connection(ch, 'open');
  assert.deepEqual(await bot(a.id), { active: false, start_on_connect: false });
  assert.equal(await turnedOnLogs(a.id), 1);
});

t('avisos de conexión simultáneos encienden el agente una sola vez', async () => {
  const a = await agent('Tienda Tres');
  const ch = (await whatsapp(a.id)).json();
  await pool.query(`UPDATE channels SET connection_state = 'close' WHERE id = $1`, [ch.id]);
  const row = { id: ch.id, account_id: ch.account_id, name: ch.name, type: ch.type };
  await Promise.all([recordConnectionState(row, 'open'), recordConnectionState(row, 'open'), recordConnectionState(row, 'open')]);
  assert.equal((await bot(a.id)).active, true);
  assert.equal(await turnedOnLogs(a.id), 1);
});

t('encenderlo a mano también quita la marca; pedir que no se encienda solo se respeta', async () => {
  const a = await agent('Tienda Cuatro');
  assert.equal((await h.authed('PUT', `/api/chatbots/${a.id}`, { active: true })).statusCode, 200);
  assert.deepEqual(await bot(a.id), { active: true, start_on_connect: false });

  // En otra cuenta: esta ya usó sus 4 perfiles de WhatsApp.
  const other = (await h.authed('POST', '/api/accounts', { name: 'Cuenta Cinco' })).json();
  const b = await agent('Tienda Cinco', { start_on_connect: false, account_id: other.id });
  const ch = (await whatsapp(b.id)).json();
  await connection(ch, 'open');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await bot(b.id), { active: false, start_on_connect: false });
});

t('asignarle una conexión que ya estaba conectada también lo enciende', async () => {
  const a = await agent('Tienda Seis');
  await pool.query(`UPDATE channels SET connection_state = 'open' WHERE id = $1`, [h.channelId]);
  const r = await h.authed('PUT', `/api/channels/${h.channelId}`, { chatbot_id: a.id });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await bot(a.id), { active: true, start_on_connect: false });
});

t('permisos: otra cuenta no lo ve, un operador no conecta y hace falta el correo confirmado', async () => {
  const a = await agent('Tienda Siete');
  const other = (await h.authed('POST', '/api/accounts', { name: 'Otra cuenta' })).json();
  await h.addUser({ account_id: other.id, email: 'ajeno@otra.mx', name: 'Ajeno', password: 'Pz-104-Qx-304-Kv', role: 'admin' });
  assert.equal((await whatsapp(a.id, await h.loginAs('ajeno@otra.mx', 'Pz-104-Qx-304-Kv'))).statusCode, 404);
  await h.addUser({ account_id: h.accountId, email: 'operador@tienda.mx', name: 'Operador', password: 'Pz-135-Qx-335-Kv', role: 'agent' });
  assert.equal((await whatsapp(a.id, await h.loginAs('operador@tienda.mx', 'Pz-135-Qx-335-Kv'))).statusCode, 403);

  // Quien se registra solo confirma su correo antes de conectar.
  const s = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.88.0.1', payload: { name: 'Rita', company: 'Florería Rita', business_type: 'tienda', email: 'rita@flores.mx', password: 'Pz-141-Qx-341-Kv', accept_terms: true } });
  assert.equal(s.statusCode, 200, s.body);
  const cookie = await h.sessionFrom(s);
  const rita = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  const mine = await rita('POST', '/api/chatbots/wizard', { company: { name: 'Florería Rita', business_type: 'tienda', description: 'Arreglos florales a domicilio en Guadalajara, desde $450.' } });
  assert.equal(mine.statusCode, 200, mine.body);
  const denied = await rita('POST', `/api/chatbots/${mine.json().id}/whatsapp`);
  assert.equal(denied.statusCode, 403);
  assert.match(denied.json().error, /Reenviar correo/);
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = 'rita@flores.mx'`);
  assert.equal((await rita('POST', `/api/chatbots/${mine.json().id}/whatsapp`)).statusCode, 200);
});
