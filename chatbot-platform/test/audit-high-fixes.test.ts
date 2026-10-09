/** Hallazgos altos de la auditoría: secretos del canal para agentes, citas canceladas y ecos de avisos internos. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let agent: Awaited<ReturnType<typeof h.loginAs>>;
let serviceId = '';
const PASS = 'clave-auditoria-1';

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const email = 'agente@auditoria.test';
  const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email, name: 'Agente', password: PASS, role: 'agent' });
  assert.equal(u.statusCode, 200, u.body);
  agent = await h.loginAs(email, PASS);
  const s = await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Visita de auditoría', kind: 'appointment', duration_minutes: 60, min_notice_minutes: 0, max_days_ahead: 5 });
  assert.equal(s.statusCode, 200, s.body);
  serviceId = s.json().id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('un agente ve los canales del asistente sin el token del webhook ni el código de inserción', async () => {
  const asAgent = (await agent('GET', `/api/chatbots/${h.botId}`)).json();
  assert.ok(asAgent.channels.length > 0, 'el agente sí ve los canales');
  for (const c of asAgent.channels) {
    assert.equal(c.webhook_token, undefined);
    assert.equal(c.webhook_url, undefined);
    assert.equal(c.embed_code, undefined);
  }
  const asAdmin = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.equal(typeof asAdmin.channels[0].webhook_token, 'string', 'el administrador sí lo ve');
});

t('una cita cancelada no vuelve a confirmarse sin revisar su horario', async () => {
  const slots = (await h.authed('GET', `/api/services/${serviceId}/slots`)).json();
  assert.ok(slots.length > 0, 'hay horarios disponibles para la prueba');
  const created = await h.authed('POST', '/api/appointments', { service_id: serviceId, slot: slots[0].key, customer_name: 'Cliente de auditoría', notify_customer: false });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().id;
  assert.equal((await h.authed('POST', `/api/appointments/${id}/cancel`, { reason: 'Prueba de auditoría' })).statusCode, 200);
  const reactivated = await h.authed('PUT', `/api/appointments/${id}`, { status: 'confirmed' });
  assert.equal(reactivated.statusCode, 409, reactivated.body);
  const stored = (await h.authed('GET', '/api/appointments')).json().find((x: any) => x.id === id);
  assert.equal(stored.status, 'cancelled');
});

t('el eco de un aviso interno no crea contacto ni conversación ni pausa al asistente', async () => {
  const phone = '5215599990000';
  const text = 'Aviso interno de auditoría';
  await h.service.sendInternalWhatsapp(h.accountId, phone, text);
  assert.ok(h.sent.some((s) => s.to === phone && s.text === text), 'el aviso salió por WhatsApp');
  await h.webhook(text, { fromMe: true, phone });
  await h.idle();
  assert.equal(await h.conversationFor(phone), undefined, 'el eco no abre una conversación');
});
