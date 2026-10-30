/** Alta sin ayuda: lista de pendientes de la cuenta («Para empezar») y correos de seguimiento si se queda a medias. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const { checkOnboardingNudges } = await import('../src/onboarding-checklist.js');
const store = await import('../src/store/index.js');

let ip = 0;
/** Cuenta nueva del registro, con su sesión. */
async function newAccount(email: string, company = 'Café Luna') {
  const r = await h.app.inject({
    method: 'POST', url: '/api/signup', remoteAddress: `10.66.0.${++ip}`,
    payload: { name: 'Luna Díaz', company, business_type: 'restaurante', email, password: 'Pz-133-Qx-333-Kv', accept_terms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = await h.sessionFrom(r);
  const api = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { api, account: r.json().account.id as string, user: r.json().user.id as string };
}
const checklist = async (api: Awaited<ReturnType<typeof newAccount>>['api']) => {
  const r = await api('GET', '/api/onboarding/checklist');
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const done = (list: any) => Object.fromEntries(list.items.map((i: any) => [i.key, i.done]));
const mails = (to: string) => outbox.filter((m) => m.to === to);
const age = (account: string, sql: string) => pool.query(`UPDATE accounts SET ${sql} WHERE id = $1`, [account]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  h.setScript(() => ({ messages: ['¡Hola! ¿Qué se te antoja?'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('lista de pendientes: cada paso se marca con lo que ya hizo la cuenta', async () => {
  const A = await newAccount('luna@cafe.mx');
  let list = await checklist(A.api);
  assert.deepEqual(list.items.map((i: any) => i.key), ['verify', 'agent', 'test', 'connect', 'activate', 'team'], 'sin cobro en línea no se pide plan');
  assert.deepEqual([list.done_count, list.total, list.complete, list.show], [0, 5, false, true]);
  assert.equal(list.items.find((i: any) => i.key === 'team').optional, true);

  await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [A.user]);
  const bot = await A.api('POST', '/api/chatbots', { name: 'Luna', active: false });
  assert.equal(bot.statusCode, 200, bot.body);
  const botId = bot.json().id;
  list = await checklist(A.api);
  assert.deepEqual(done(list), { verify: true, agent: true, test: false, connect: false, activate: false, team: false });
  assert.equal(list.items.find((i: any) => i.key === 'activate').href, `#/bot/${botId}/instrucciones`);

  // El primer mensaje en el simulador marca la prueba.
  assert.equal((await A.api('POST', `/api/chatbots/${botId}/playground`, { session: 'lista', text: 'Hola' })).statusCode, 200);
  assert.equal((await store.getAccount(A.account))!.onboarding.test, true);

  // WhatsApp caído porque se cerró la sesión en el teléfono: pide volver a vincular, con el motivo.
  const wa = await store.createChannel({ account_id: A.account, chatbot_id: botId, type: 'whatsapp', name: 'WhatsApp', config: {} });
  await pool.query(`UPDATE channels SET connection_state = 'close', disconnect_reason = 'logged_out', down_since = now() WHERE id = $1`, [wa.id]);
  list = await checklist(A.api);
  const connect = list.items.find((i: any) => i.key === 'connect');
  assert.deepEqual([connect.done, connect.label, connect.action, connect.href], [false, 'Vuelve a vincular tu WhatsApp', 'Volver a vincular', `#/channel/${wa.id}?conectar=1`]);
  assert.match(connect.hint, /Se cerró la sesión desde el teléfono/);

  await pool.query(`UPDATE channels SET connection_state = 'open', disconnect_reason = '', down_since = NULL WHERE id = $1`, [wa.id]);
  await pool.query(`UPDATE chatbots SET active = true WHERE id = $1`, [botId]);
  list = await checklist(A.api);
  assert.deepEqual(done(list), { verify: true, agent: true, test: true, connect: true, activate: true, team: false });
  assert.deepEqual([list.done_count, list.complete, list.show], [5, true, false], 'completa: la tarjeta ya no se muestra');
  assert.equal((await store.getAccount(A.account))!.onboarding.checklist_done, true);
});

t('lista de pendientes: «Ocultar», permisos y cuentas creadas por el superadmin', async () => {
  const B = await newAccount('sol@cafe.mx', 'Café Sol');
  assert.equal((await B.api('POST', '/api/onboarding/step', { step: 'hide_checklist' })).statusCode, 200);
  let list = await checklist(B.api);
  assert.equal(list.show, false);
  assert.equal(list.complete, false, 'ocultarla no da los pasos por hechos');
  assert.equal(done(list).team, false);

  // Un agente de la cuenta no la ve; con él, el paso opcional del equipo queda hecho.
  const agent = await h.addUser({ account_id: B.account, name: 'Beto', email: 'beto@cafe.mx', password: 'Pz-108-Qx-308-Kv', role: 'agent' });
  assert.equal((await (await h.loginAs('beto@cafe.mx', 'Pz-108-Qx-308-Kv'))('GET', '/api/onboarding/checklist')).statusCode, 403);
  list = await checklist(B.api);
  assert.equal(done(list).team, true);

  // Una cuenta que dio de alta el superadmin no muestra la tarjeta.
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Taller Pepe' })).json();
  const own = await h.authed('GET', `/api/onboarding/checklist?account_id=${acc.id}`);
  assert.equal(own.statusCode, 200, own.body);
  assert.deepEqual([own.json().show, own.json().complete], [false, false]);
});

t('correos de seguimiento: conectar al día 1, probar al día 3, una sola vez cada uno', async () => {
  const C = await newAccount('mar@cafe.mx', 'Café Mar');
  outbox.length = 0;
  assert.equal(await checkOnboardingNudges(), 0, 'recién registrada no se le escribe');

  await age(C.account, `created_at = now() - interval '25 hours'`);
  await checkOnboardingNudges();
  assert.deepEqual(mails('mar@cafe.mx').map((m) => m.subject), ['Conecta tu WhatsApp y tu agente empieza a atender']);
  const mail = mails('mar@cafe.mx')[0];
  assert.match(mail.text, /Café Mar/);
  assert.match(mail.text, /https:\/\/bot\.test\/#\/empezar/);
  assert.match(mail.text, /\/baja-recordatorios\?c=[0-9a-f-]{36}&s=[\w-]+/);

  await checkOnboardingNudges();
  assert.equal(mails('mar@cafe.mx').length, 1, 'no se repite');

  await age(C.account, `created_at = now() - interval '4 days'`);
  await checkOnboardingNudges();
  assert.deepEqual(mails('mar@cafe.mx').map((m) => m.subject).slice(1), ['Prueba tu agente antes de que hable con tus clientes']);
  await checkOnboardingNudges();
  assert.equal(mails('mar@cafe.mx').length, 2);
  assert.deepEqual((await pool.query(`SELECT kind FROM account_nudges WHERE account_id = $1 ORDER BY kind`, [C.account])).rows.map((r) => r.kind), ['connect', 'test']);
});

t('correos de seguimiento: no se mandan si el paso ya está hecho, a cuentas viejas ni a las del superadmin', async () => {
  // Ya conectó y ya probó.
  const D = await newAccount('rio@cafe.mx', 'Café Río');
  const bot = (await D.api('POST', '/api/chatbots', { name: 'Río' })).json();
  const ch = await store.createChannel({ account_id: D.account, chatbot_id: bot.id, type: 'whatsapp', name: 'WhatsApp', config: {} });
  await pool.query(`UPDATE channels SET connection_state = 'open' WHERE id = $1`, [ch.id]);
  await store.markOnboarding(D.account, { test: true });
  await age(D.account, `created_at = now() - interval '4 days'`);
  // Registrada hace más de 14 días (de antes de esta función).
  const E = await newAccount('lago@cafe.mx', 'Café Lago');
  await age(E.account, `created_at = now() - interval '20 days'`);
  // Creada por el superadmin.
  const F = await newAccount('mina@cafe.mx', 'Café Mina');
  await age(F.account, `created_at = now() - interval '4 days', signup_source = 'admin'`);
  outbox.length = 0;
  await checkOnboardingNudges();
  for (const to of ['rio@cafe.mx', 'lago@cafe.mx', 'mina@cafe.mx']) assert.equal(mails(to).length, 0, to);
});

t('correo para reactivar: 3 días después de la pausa por fin de la prueba, si no contrató', async () => {
  const G = await newAccount('nube@cafe.mx', 'Café Nube');
  await age(G.account, `status = 'paused', created_at = now() - interval '13 days', trial_ends_at = now() - interval '2 days'`);
  outbox.length = 0;
  await checkOnboardingNudges();
  assert.ok(!mails('nube@cafe.mx').some((m) => /pausa/.test(m.subject)), 'aún no');
  await age(G.account, `trial_ends_at = now() - interval '4 days'`);
  await checkOnboardingNudges();
  const re = mails('nube@cafe.mx').filter((m) => /pausa/.test(m.subject));
  assert.equal(re.length, 1);
  assert.match(re[0].text, /#\/plan/);
});

t('baja de los recordatorios: el enlace firmado del correo los detiene; uno alterado no', async () => {
  const K = await newAccount('cielo@cafe.mx', 'Café Cielo');
  await age(K.account, `created_at = now() - interval '25 hours'`);
  outbox.length = 0;
  await checkOnboardingNudges();
  const link = mails('cielo@cafe.mx')[0].text.match(/https:\/\/bot\.test(\/baja-recordatorios\?\S+)/)![1];

  // Abrir el enlace solo pide confirmar (los antivirus de correo abren los enlaces).
  const page = await h.app.inject({ method: 'GET', url: link });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Dejar de recibirlos/);
  assert.notEqual((await store.getAccount(K.account))!.onboarding.nudges_off, true);

  // La firma es base64url (puede empezar con «-»): se reemplaza completa para que siempre quede alterada.
  const bad = link.replace(/s=[^&]+/, 's=firma-alterada');
  assert.notEqual(bad, link);
  assert.equal((await h.app.inject({ method: 'GET', url: bad })).statusCode, 400);
  assert.equal((await h.app.inject({ method: 'POST', url: bad, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' })).statusCode, 400);
  assert.equal((await h.app.inject({ method: 'GET', url: '/baja-recordatorios' })).statusCode, 400);

  const r = await h.app.inject({ method: 'POST', url: link, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.body, /Ya no recibirás estos recordatorios/);
  assert.equal((await store.getAccount(K.account))!.onboarding.nudges_off, true);

  await age(K.account, `created_at = now() - interval '4 days'`);
  await checkOnboardingNudges();
  assert.equal(mails('cielo@cafe.mx').length, 1, 'ya no llega el de probar');
});
