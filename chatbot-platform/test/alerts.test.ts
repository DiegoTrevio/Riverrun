/** Avisos internos afinados: sin avisos falsos ni dobles, quién recibe qué y avisos con los datos del cliente. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
import { alertChannels, cleanAlertPrefs } from '../src/automation/alert-groups.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let bossId = '';
let bossApi: Awaited<ReturnType<typeof h.loginAs>>;
let agentId = '';
const NOTIFY = '5215599991234';

const notices = async (userId: string, kind?: string) =>
  (await pool.query(`SELECT title, body, kind, link FROM notifications WHERE user_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY id`, kind ? [userId, kind] : [userId])).rows;
async function customer(text: string, phone: string) {
  await h.webhook(text, { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  await h.idle();
  await h.service.automator.settleAll();
}
const settings = async (patch: Record<string, unknown>) => {
  const s = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  delete s.ics_url;
  const r = await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { ...s, ...patch });
  assert.equal(r.statusCode, 200, r.body);
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ rules: { handoff_keywords: ['asesor'], handoff_notify_number: NOTIFY } });
  h.setScript(() => ({ messages: ['Con gusto te ayudo.'] }));
  const boss = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'jefa@avisos.mx', name: 'Jefa', password: 'clave-avisos-1', role: 'admin', phone: '5215511112222', notify_whatsapp: true });
  assert.equal(boss.statusCode, 200, boss.body);
  bossId = boss.json().id;
  bossApi = await h.loginAs('jefa@avisos.mx', 'clave-avisos-1');
  const agent = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'agente@avisos.mx', name: 'Agente', password: 'clave-avisos-1', role: 'agent' });
  assert.equal(agent.statusCode, 200, agent.body);
  agentId = agent.json().id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('preferencias: lo que no se elige queda como siempre y las emergencias siempre llegan al panel', () => {
  assert.deepEqual(alertChannels({}, 'handoff'), { panel: true, whatsapp: true, email: false });
  assert.deepEqual(alertChannels({}, 'handoff_wait'), { panel: true, whatsapp: true, email: true }, 'los recordatorios de espera ya iban por correo');
  assert.deepEqual(alertChannels({ handoff: { panel: false, whatsapp: false } }, 'handoff'), { panel: false, whatsapp: false, email: false });
  assert.equal(alertChannels({ errors: { panel: false } }, 'safety').panel, true, 'una emergencia no se puede silenciar en el panel');
  assert.deepEqual(alertChannels({ handoff: { panel: false } }, 'notice'), { panel: true, whatsapp: true, email: false }, 'un aviso sin grupo llega como siempre');
  assert.deepEqual(cleanAlertPrefs({ handoff: { panel: false, otro: true }, inventado: { panel: false }, errors: { panel: false, email: false } }), { handoff: { panel: false }, errors: { email: false } });
});

t('el eco del aviso al encargado no crea una conversación ni pausa a nadie', async () => {
  const phone = '5215530009001';
  h.reset();
  await customer('quiero hablar con un asesor', phone);
  await waitFor(() => h.sent.some((s) => s.to === NOTIFY), 8000);
  const alert = h.sent.find((s) => s.to === NOTIFY)!;
  assert.match(alert.text, /necesita atención/);
  // WhatsApp devuelve el aviso como un mensaje propio (fromMe) a la conversación del encargado.
  await h.webhook(alert.text, { phone: NOTIFY, fromMe: true });
  await h.idle();
  assert.ok(!(await h.conversationFor(NOTIFY)), 'el eco no abre una conversación del encargado');
  const left = (await pool.query(`SELECT count(*)::int AS n FROM internal_notices WHERE phone = $1`, [NOTIFY])).rows[0].n;
  assert.equal(left, 0, 'el registro del aviso se consumió con su eco');
});

t('el aviso de espera trae nombre, teléfono, canal, motivo y enlace; al encargado no le llega dos veces', async () => {
  const phone = '5215530009002';
  h.reset();
  await customer('necesito un asesor por favor', phone);
  const conv = await h.conversationFor(phone);
  await waitFor(async () => (await notices(bossId, 'handoff')).some((n) => n.link === `#/conversation/${conv.id}`), 8000);
  const n = (await notices(bossId, 'handoff')).find((x) => x.link === `#/conversation/${conv.id}`)!;
  assert.match(n.body, new RegExp(`Cliente: .*\\+${phone}`));
  assert.match(n.body, /Canal: /);
  assert.match(n.body, /Motivo: /);
  // El encargado del agente ya recibió su aviso con el resumen; la jefa recibe el suyo por WhatsApp.
  await waitFor(() => h.sent.some((s) => s.to === '5215511112222'), 8000);
  assert.equal(h.sent.filter((s) => s.to === NOTIFY).length, 1, 'un solo WhatsApp al encargado');
});

t('si alguien contesta desde el teléfono no sale «esperando a una persona»', async () => {
  const phone = '5215530009003';
  await customer('hola, ¿tienen envíos?', phone);
  const before = (await notices(bossId, 'handoff')).length;
  await h.webhook('Hola, te atiende Luis', { phone, fromMe: true, id: `PHONE-${Date.now()}` });
  await h.idle();
  await h.service.automator.settleAll();
  assert.equal((await h.conversationFor(phone)).status, 'human', 'la conversación sí pasa a una persona');
  assert.equal((await notices(bossId, 'handoff')).length, before, 'pero nadie recibe el aviso de espera');
});

t('la misma persona no recibe dos veces el mismo aviso de la misma conversación en 10 minutos', async () => {
  const conv = await h.conversationFor('5215530009003');
  const before = (await notices(bossId, 'goal')).length;
  const alert = { title: '🎯 Objetivo cumplido', body: 'x', link: `#/conversation/${conv.id}`, conversationId: conv.id, kind: 'goal' };
  await h.service.automator.alertTeam(h.accountId, alert);
  await h.service.automator.alertTeam(h.accountId, alert);
  assert.equal((await notices(bossId, 'goal')).length - before, 1);
  // Las fallas y emergencias sí llegan cada vez.
  const s0 = (await notices(bossId, 'safety')).length;
  await h.service.automator.alertTeam(h.accountId, { ...alert, title: '🚨 Posible emergencia', kind: 'safety' });
  await h.service.automator.alertTeam(h.accountId, { ...alert, title: '🚨 Posible emergencia', kind: 'safety' });
  assert.equal((await notices(bossId, 'safety')).length - s0, 2);
});

t('la persona asignada recibe un solo aviso (asignación y espera juntas)', async () => {
  await settings({ assignment: { enabled: true, on_handoff: true, roles: ['agent'], user_ids: [agentId], notify_all: true } });
  const phone = '5215530009004';
  await customer('quiero un asesor', phone);
  const conv = await h.conversationFor(phone);
  await waitFor(async () => (await h.conversationFor(phone)).assigned_user_id === agentId && (await notices(bossId, 'handoff')).some((n) => n.link === `#/conversation/${conv.id}`), 8000);
  const mine = (await notices(agentId)).filter((n) => n.link === `#/conversation/${conv.id}`);
  assert.equal(mine.length, 1, JSON.stringify(mine));
  assert.equal(mine[0].kind, 'assignment');
  assert.match(mine[0].title, /espera a una persona/);
  await settings({ assignment: { enabled: false, on_handoff: true, roles: ['agent'], user_ids: [], notify_all: false } });
});

t('«Mis avisos»: cada persona elige por dónde le llega cada grupo, y el administrador lo cambia por ella', async () => {
  assert.equal((await bossApi('PUT', '/api/me', { alert_prefs: { handoff: { panel: false, whatsapp: false }, errors: { panel: false } } })).statusCode, 200);
  const me = (await bossApi('GET', '/api/me')).json().user;
  assert.deepEqual(me.alert_prefs, { handoff: { panel: false, whatsapp: false } }, 'las emergencias no se apagan en el panel');
  const phone = '5215530009005';
  h.reset();
  await customer('pásame con un asesor', phone);
  const conv = await h.conversationFor(phone);
  await h.service.automator.settleAll();
  assert.equal((await notices(bossId, 'handoff')).filter((n) => n.link === `#/conversation/${conv.id}`).length, 0, 'sin aviso en el panel');
  assert.equal(h.sent.filter((s) => s.to === '5215511112222').length, 0, 'ni por WhatsApp');
  await h.service.automator.alertTeam(h.accountId, { title: '🚨 Emergencia', body: 'x', link: `#/conversation/${conv.id}`, conversationId: conv.id, kind: 'safety' });
  assert.ok((await notices(bossId, 'safety')).some((n) => n.title === '🚨 Emergencia'), 'una emergencia sí llega');
  // El administrador lo ajusta desde Mi equipo; un agente no puede cambiar los avisos de otra persona.
  const agent = await h.loginAs('agente@avisos.mx', 'clave-avisos-1');
  assert.equal((await agent('PUT', `/api/users/${bossId}`, { alert_prefs: {} })).statusCode, 403);
  assert.equal((await h.authed('PUT', `/api/users/${bossId}`, { alert_prefs: {} })).statusCode, 200);
  assert.deepEqual((await bossApi('GET', '/api/me')).json().user.alert_prefs, {});
  // La página de Notificaciones filtra por grupo.
  const list = (await bossApi('GET', '/api/notifications?group=errors')).json();
  assert.ok(list.items.length && list.items.every((n: any) => ['ai_error', 'safety', 'alert', 'automation'].includes(n.kind)));
  assert.ok(list.groups.some((g: any) => g.key === 'agenda'));
});

t('recordatorio de espera configurable y escalamiento una sola vez', async () => {
  const phone = '5215530009006';
  await customer('quiero un asesor ya', phone);
  await customer('¿hay alguien?', phone); // el último mensaje es del cliente: espera a una persona
  const conv = await h.conversationFor(phone);
  await pool.query(`UPDATE conversations SET assigned_user_id = $2, human_reminded_at = NULL, escalated_at = NULL WHERE id = $1`, [conv.id, agentId]);
  await pool.query(`UPDATE messages SET created_at = now() - interval '45 minutes' WHERE conversation_id = $1`, [conv.id]);
  await settings({ alert_timing: { human_repeat_minutes: 0, ai_error_repeat_minutes: 30, escalate_minutes: 40, escalate_user_ids: [] } });
  const waits = async () => (await notices(bossId, 'handoff_wait')).filter((n) => n.link === `#/conversation/${conv.id}`).length;
  const escalations = async () => (await notices(bossId, 'escalation')).filter((n) => n.link === `#/conversation/${conv.id}`).length;
  await h.service.remindHumanWaiting();
  assert.equal(await waits(), 1);
  assert.equal(await escalations(), 1, 'la asignada no respondió en 40 min: se escala a los administradores');
  const esc = (await notices(bossId, 'escalation')).find((n) => n.link === `#/conversation/${conv.id}`)!;
  assert.match(esc.body, /Agente no ha respondido/);
  // Horas después: con «recordar una sola vez» no se repite, y el escalamiento tampoco.
  await pool.query(`UPDATE conversations SET human_reminded_at = now() - interval '3 hours', escalated_at = now() - interval '3 hours' WHERE id = $1`, [conv.id]);
  await pool.query(`UPDATE messages SET created_at = now() - interval '4 hours' WHERE conversation_id = $1`, [conv.id]);
  await h.service.remindHumanWaiting();
  assert.equal(await waits(), 1);
  assert.equal(await escalations(), 1);
  // Con repetición cada 60 min sí vuelve a recordar.
  await settings({ alert_timing: { human_repeat_minutes: 60, ai_error_repeat_minutes: 30, escalate_minutes: 40, escalate_user_ids: [] } });
  await h.service.remindHumanWaiting();
  assert.equal(await waits(), 2);
  await settings({ alert_timing: { human_repeat_minutes: 120, ai_error_repeat_minutes: 30, escalate_minutes: 0, escalate_user_ids: [] } });
});

t('cita cancelada: respeta «avisar al equipo» del servicio y trae el teléfono del cliente', async () => {
  const svc = async (notify_team: boolean) => {
    const r = await h.authed('POST', '/api/services', { account_id: h.accountId, name: notify_team ? 'Con aviso' : 'Sin aviso', duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30, notify_team });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const bookAndCancel = async (s: any) => {
    const slots = (await h.authed('GET', `/api/services/${s.id}/slots?days=30`)).json();
    assert.ok(slots.length, 'hay horarios');
    const a = await h.authed('POST', '/api/appointments', { service_id: s.id, slot: slots[0].key, customer_name: 'Rosa', customer_phone: '5215500002222', notify_customer: false });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal((await h.authed('POST', `/api/appointments/${a.json().id}/cancel`, { notify_customer: false })).statusCode, 200);
  };
  const cancelled = async (name: string) => (await notices(bossId, 'appointment')).filter((n) => n.title.includes('cancelada') && n.title.includes(name));
  await bookAndCancel(await svc(false));
  assert.equal((await cancelled('Sin aviso')).length, 0);
  await bookAndCancel(await svc(true));
  const [n] = await cancelled('Con aviso');
  assert.ok(n, 'sí avisa cuando el servicio lo tiene activado');
  assert.match(n.body, /Rosa \(\+5215500002222\)/);
});
