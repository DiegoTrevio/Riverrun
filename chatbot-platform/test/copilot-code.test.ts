/**
 * Confirmar con código: lo que en el panel pide el código de verificación (aquí, una regla que manda datos de clientes a
 * un número de fuera) el Copiloto lo deja como propuesta que solo se ejecuta con el código escrito en la tarjeta. Sin
 * código, con uno equivocado o escrito en el chat no se hace nada; los topes de intentos son los del panel; el permiso
 * de un uso no hace dueño a nadie.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor, type CopilotOut } from './harness.js';

const { mintCopilotGrant } = await import('../src/identity/copilot-grant.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const OWNER = 'duena@codigo.mx';
let owner: Awaited<ReturnType<typeof h.loginAs>>;

function script(outs: CopilotOut[]) {
  let k = 0;
  h.setCopilotScript(() => outs[k++] ?? 'Listo.');
}
const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ name, arguments: args }] });

async function ask(text: string) {
  const id = (await owner('POST', '/api/copilot/threads', {})).json().id as string;
  const r = await owner('POST', `/api/copilot/threads/${id}/messages`, { text });
  assert.equal(r.statusCode, 202, r.body);
  await waitFor(async () => (await owner('GET', `/api/copilot/threads/${id}`)).json().turn?.status !== 'running', 8000);
  return { id, thread: (await owner('GET', `/api/copilot/threads/${id}`)).json() };
}

/** Propone una regla que avisa por WhatsApp a un número de fuera (manda datos de clientes afuera). */
async function proposeDataOut(name: string) {
  script([call('crear_regla', { nombre: name, cuando: { type: 'tag_added', tag: 'vip' }, acciones: [{ type: 'alert_team', message: 'Llegó un VIP', phones: ['5215598765432'] }] }), 'Confírmalo con tu código.']);
  const { id, thread } = await ask(`Cuando alguien sea VIP, avisa por WhatsApp al 55 9876 5432 (${name})`);
  const action = thread.actions.find((a: any) => a.tool === 'crear_regla');
  assert.ok(action, JSON.stringify(thread.actions));
  return { id, action };
}

const confirm = (a: any, body: Record<string, unknown>) => owner('POST', `/api/copilot/actions/${a.id}/confirm`, { seen_hash: a.seen_hash, ...body });
const sidOf = (cookie: string) => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString()).sid as string;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  // La primera administradora de la cuenta es su dueña.
  await h.addUser({ email: OWNER, name: 'Dueña', password: 'Pz-139-Qx-339-Kv', role: 'admin' });
  owner = await h.loginAs(OWNER, 'Pz-139-Qx-339-Kv');
});

after(async () => {
  if (ok) await h.app.close();
});

t('una regla que manda datos afuera se confirma con el código escrito en la tarjeta (sin código, equivocado o en el chat, no)', async () => {
  const { id, action } = await proposeDataOut('Avisar a Pepe');
  assert.equal(action.risk, 'code');
  assert.equal(action.status, 'proposed');
  assert.ok(action.reasons.some((r: string) => /código/.test(r)), JSON.stringify(action.reasons));
  const tool = (await pool.query(`SELECT content FROM copilot_messages WHERE thread_id = $1 AND role = 'tool'`, [id])).rows[0].content;
  assert.match(tool, /"con_codigo":true/);
  assert.match(tool, /Nunca le pidas el código en el chat/);

  // El código escrito en el chat no llega a la IA.
  const inChat = await owner('POST', `/api/copilot/threads/${id}/messages`, { text: '123 456' });
  assert.deepEqual([inChat.statusCode, inChat.json().code], [400, 'code_in_chat']);

  const none = await confirm(action, {});
  assert.deepEqual([none.statusCode, none.json().code], [400, 'code_required']);
  const wrong = await confirm(action, { code: '000000' });
  assert.deepEqual([wrong.statusCode, wrong.json().code], [400, 'bad_code']);
  const still = (await owner('GET', `/api/copilot/threads/${id}`)).json().actions.find((a: any) => a.id === action.id);
  assert.equal(still.status, 'proposed', 'un código equivocado deja la propuesta como estaba');
  assert.equal((await pool.query(`SELECT 1 FROM automations WHERE account_id = $1 AND name = 'Avisar a Pepe'`, [h.accountId])).rowCount, 0);

  const good = await confirm(action, { code: await h.codeFor(OWNER) });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().status, 'done', good.body);
  assert.equal(good.json().can_undo, false, 'lo confirmado con código no se deshace desde la tarjeta');
  const rule = (await pool.query(`SELECT actions FROM automations WHERE account_id = $1 AND name = 'Avisar a Pepe'`, [h.accountId])).rows[0];
  assert.deepEqual(rule.actions[0].phones, ['5215598765432']);
  const sec = await pool.query(`SELECT target FROM security_events WHERE kind = 'copilot.code_confirmed' AND account_id = $1`, [h.accountId]);
  assert.deepEqual(sec.rows.map((r) => r.target), ['crear_regla'], 'queda en la bitácora de seguridad');
  assert.equal((await confirm(action, { code: await h.codeFor(OWNER) })).statusCode, 409, 'una sola vez');
});

t('el permiso de un uso no hace dueño a nadie y no sirve dos veces', async () => {
  const socia = await h.addUser({ email: 'socia@codigo.mx', name: 'Socia', password: 'Pz-140-Qx-340-Kv', role: 'admin' });
  const agente = await h.addUser({ email: 'agente@codigo.mx', name: 'Luis', password: 'Pz-141-Qx-341-Kv', role: 'agent' });
  const sociaReq = await h.loginAs('socia@codigo.mx', 'Pz-140-Qx-340-Kv');
  const action = '55555555-5555-4555-8555-555555555555';
  const promote = (cookie: string, grant: string) => h.app.inject({
    method: 'PUT', url: `/api/users/${agente.id}`, payload: { role: 'admin' },
    headers: { cookie, 'x-copilot': '1', 'x-copilot-action': action, 'x-copilot-grant': grant },
  });
  // Una administradora que no es la dueña: con permiso, pasa el bloqueo del Copiloto pero no la regla del dueño.
  const notOwner = await promote(sociaReq.cookie, mintCopilotGrant({ userId: socia.id, sessionId: sidOf(sociaReq.cookie), actionId: action, routes: ['PUT /api/users/:id'] }));
  assert.deepEqual([notOwner.statusCode, notOwner.json().code], [403, 'owner_only']);
  // La dueña con permiso: lo hace (el permiso cuenta como su código reciente), una sola vez.
  const ownerId = (await pool.query(`SELECT id FROM users WHERE email = $1`, [OWNER])).rows[0].id;
  const grant = mintCopilotGrant({ userId: ownerId, sessionId: sidOf(owner.cookie), actionId: action, routes: ['PUT /api/users/:id'] });
  const done = await promote(owner.cookie, grant);
  assert.equal(done.statusCode, 200, done.body);
  const again = await promote(owner.cookie, grant);
  assert.deepEqual([again.statusCode, again.json().code], [403, 'copilot_blocked'], 'gastado, ya no abre nada');
  // Sin permiso, la misma ruta sigue cerrada para el Copiloto.
  const without = await h.app.inject({ method: 'PUT', url: `/api/users/${agente.id}`, payload: { role: 'agent' }, headers: { cookie: owner.cookie, 'x-copilot': '1' } });
  assert.deepEqual([without.statusCode, without.json().code], [403, 'copilot_blocked']);
});

t('los intentos de código son los del panel: al sexto equivocado en 15 minutos, 429', async () => {
  const { action } = await proposeDataOut('Avisar a Lola');
  // Contadores limpios: la primera prueba ya gastó un intento equivocado en esta sesión.
  await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'mfa-%'`);
  for (let i = 0; i < 5; i++) assert.equal((await confirm(action, { code: '000000' })).statusCode, 400);
  assert.equal((await confirm(action, { code: await h.codeFor(OWNER) })).statusCode, 429, 'ni con el bueno: la sesión ya gastó sus intentos');
  assert.equal((await pool.query(`SELECT 1 FROM automations WHERE account_id = $1 AND name = 'Avisar a Lola'`, [h.accountId])).rowCount, 0);
  // El diálogo de código del panel comparte el mismo tope.
  assert.equal((await owner('POST', '/api/2fa/step-up', { code: await h.codeFor(OWNER) })).statusCode, 429);
});
