/**
 * Verificación reciente: las acciones delicadas (contraseña, equipo, llaves, webhooks, secretos, dinero, borrar o exportar
 * la cuenta, ajustes de la plataforma) piden el código otra vez si pasaron más de 15 minutos desde el último. Entrar con
 * un dispositivo recordado no cuenta como código escrito.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const ID = '00000000-0000-4000-8000-000000000000';
export const STEP_UP: [string, string][] = [
  ['PUT', '/api/me/password'],
  ['PUT', '/api/me/email'],
  ['POST', '/api/me/sessions/revoke-others'],
  ['DELETE', `/api/me/devices/${ID}`],
  ['POST', '/api/me/2fa/recovery-codes'],
  ['POST', '/api/me/2fa/authenticator'],
  ['POST', '/api/me/2fa/authenticator/confirm'],
  ['DELETE', `/api/users/${ID}`],
  ['POST', `/api/users/${ID}/2fa/reset`],
  ['POST', '/api/api-keys'],
  ['DELETE', `/api/api-keys/${ID}`],
  ['POST', '/api/webhook-endpoints'],
  ['PUT', `/api/webhook-endpoints/${ID}`],
  ['POST', '/api/settings/rotate-webhook-secret'],
  ['POST', '/api/settings/rotate-secrets'],
  ['GET', '/api/settings/secrets'],
  ['POST', '/api/billing/checkout'],
  ['POST', '/api/billing/change'],
  ['POST', '/api/billing/payment-method'],
  ['POST', '/api/billing/portal'],
  ['POST', '/api/billing/cancel'],
  ['PUT', '/api/billing/fiscal'],
  ['DELETE', '/api/billing/card-check-brake'],
  ['GET', '/api/account/export.zip'],
  ['GET', '/api/export/contacts.csv'],
  ['GET', '/api/export/conversations.csv'],
  ['GET', '/api/export/quotes.csv'],
  ['GET', '/api/export/messages.csv'],
  ['POST', '/api/account/deletion'],
  ['DELETE', '/api/account/deletion'],
  ['POST', '/api/account/transfer'],
  ['POST', '/api/accounts'],
  ['DELETE', `/api/accounts/${ID}`],
  ['POST', `/api/accounts/${ID}/trial-without-card`],
  ['PUT', '/api/system/zernio'],
  ['DELETE', '/api/system/zernio'],
];
const PASS = 'Pz-985-Qx-986-Kv';
const age = (email: string, minutes: number) =>
  pool.query(`UPDATE user_sessions SET mfa_at = now() - make_interval(mins => $2) WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email, minutes]);
let admin: Awaited<ReturnType<typeof h.loginAs>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  await h.addUser({ account_id: h.accountId, name: 'Mía', email: 'mia@paso.mx', password: PASS, role: 'admin' });
  admin = await h.loginAs('mia@paso.mx', PASS);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('cada ruta delicada pide el código si pasaron más de 15 minutos', async () => {
  await age('admin@test.mx', 16);
  for (const [method, url] of STEP_UP) {
    const r = await h.authed(method, url, {});
    assert.equal(r.statusCode, 403, `${method} ${url}: ${r.body}`);
    assert.deepEqual(r.json(), { error: 'Escribe tu código de verificación para continuar', code: 'step_up' }, `${method} ${url}`);
  }
  assert.equal((await h.authed('GET', '/api/me')).statusCode, 200, 'lo demás no pide nada');
  assert.deepEqual((await h.authed('GET', '/api/2fa/recent')).json(), { recent: false });
});

t('con el código, la misma acción pasa; un código malo no', async () => {
  await age('mia@paso.mx', 16);
  assert.equal((await admin('POST', '/api/api-keys', { name: 'Integración' })).statusCode, 403);
  assert.equal((await admin('POST', '/api/2fa/step-up', { code: '111111' })).statusCode, 400);
  assert.equal((await admin('POST', '/api/2fa/step-up', { code: await h.codeFor('mia@paso.mx') })).statusCode, 200);
  assert.deepEqual((await admin('GET', '/api/2fa/recent')).json(), { recent: true });
  const r = await admin('POST', '/api/api-keys', { name: 'Integración' });
  assert.equal(r.statusCode, 200, r.body);
});

t('algunas acciones lo piden según lo que cambian', async () => {
  assert.equal((await h.authed('POST', '/api/2fa/step-up', { code: await h.codeFor('admin@test.mx') })).statusCode, 200);
  const agent = (await h.addUser({ account_id: h.accountId, name: 'Nico', email: 'nico@paso.mx', password: PASS, role: 'agent' }));
  await age('mia@paso.mx', 16);
  assert.equal((await admin('PUT', `/api/users/${agent.id}`, { name: 'Nico Ruiz' })).statusCode, 200, 'un cambio de nombre no');
  assert.equal((await admin('PUT', `/api/users/${agent.id}`, { role: 'admin' })).json().code, 'step_up', 'un cambio de rol sí');
  assert.equal((await admin('PUT', `/api/users/${agent.id}`, { active: false })).json().code, 'step_up', 'dar de baja sí');
  assert.equal((await admin('POST', '/api/invitations', { email: 'otra@paso.mx', role: 'agent' })).statusCode, 200, 'invitar a un agente no');
  assert.equal((await admin('POST', '/api/invitations', { email: 'jefa@paso.mx', role: 'admin' })).json().code, 'step_up', 'invitar a un administrador sí');
});

t('una regla que manda datos afuera pide el código; una que solo etiqueta, no (ID-14)', async () => {
  await age('mia@paso.mx', 16);
  const rule = (actions: unknown[]) => ({ name: 'Regla', trigger: { type: 'message_received' }, actions });
  const out: [string, unknown][] = [
    ['webhook', { type: 'webhook', url: 'https://hooks.example.com/x' }],
    ['reporte a un correo', { type: 'send_report', emails: ['fuera@example.com'] }],
    ['reporte a un número', { type: 'send_report', phones: ['+5215500000000'] }],
    ['aviso a un número', { type: 'alert_team', phones: ['+5215500000000'] }],
  ];
  for (const [what, action] of out) {
    assert.equal((await admin('POST', '/api/automations', rule([action]))).json().code, 'step_up', `${what}: crear`);
  }
  const tag = await admin('POST', '/api/automations', rule([{ type: 'add_tag', tag: 'nuevo' }]));
  assert.equal(tag.statusCode, 200, `etiquetar no: ${tag.body}`);
  const id = tag.json().id;
  assert.equal((await admin('PUT', `/api/automations/${id}`, { actions: [{ type: 'webhook', url: 'https://hooks.example.com/x' }] })).json().code, 'step_up', 'cambiarla para que mande datos, sí');
  assert.equal((await admin('PUT', `/api/automations/${id}`, { name: 'Etiquetar a los nuevos' })).statusCode, 200, 'renombrarla, no');
  // Con el código se guarda; después, cambiar solo el nombre de una regla que ya mandaba datos al mismo lugar no lo pide.
  await admin('POST', '/api/2fa/step-up', { code: await h.codeFor('mia@paso.mx') });
  const hook = await admin('POST', '/api/automations', rule([{ type: 'webhook', url: 'https://hooks.example.com/x' }]));
  assert.equal(hook.statusCode, 200, hook.body);
  await age('mia@paso.mx', 16);
  assert.equal((await admin('PUT', `/api/automations/${hook.json().id}`, { name: 'Avisar a mi sistema' })).statusCode, 200);
  assert.equal((await admin('PUT', `/api/automations/${hook.json().id}`, { actions: [{ type: 'webhook', url: 'https://otro.example.com/y' }] })).json().code, 'step_up', 'otro destino, sí');
});

t('Ajustes ya no muestra los secretos; «Mostrar» los pide con verificación reciente', async () => {
  await admin('POST', '/api/2fa/step-up', { code: await h.codeFor('mia@paso.mx') });
  const s = (await admin('GET', '/api/settings')).json();
  assert.equal(s.webhook_secret, '');
  assert.equal(s.calendar_token, '');
  assert.equal(s.ics_url, '');
  assert.equal(s.secrets_hidden, true);
  const saved = (await admin('PUT', '/api/settings', { timezone: 'America/Mexico_City' })).json();
  assert.equal(saved.webhook_secret, '', 'guardar tampoco los devuelve');
  const shown = (await admin('GET', '/api/settings/secrets')).json();
  assert.ok(shown.webhook_secret.length >= 16);
  assert.match(shown.ics_url, new RegExp(`/calendar/${shown.calendar_token}\\.ics$`));
  await age('mia@paso.mx', 16);
  assert.equal((await admin('GET', '/api/settings/secrets')).json().code, 'step_up');
});

t('el Copiloto no llega a ninguna ruta delicada', async () => {
  const files = (fs.readdirSync('src/copilot', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
  const src = files.map((f) => fs.readFileSync(`src/copilot/${f}`, 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/['`](\/api\/[\w/-]+)/g)].map((m) => m[1]));
  const sensitive = new Set(STEP_UP.map(([, u]) => u.replace(`/${ID}`, '')));
  assert.deepEqual([...used].filter((u) => sensitive.has(u)), ['/api/users'], 'solo lee el equipo');
  assert.doesNotMatch(src, /send<[^>]*>\(\s*'(POST|PUT|DELETE)',\s*'\/api\/users/);
});
