/** Cumplimiento: consentimiento, pie de baja, derechos de las personas y retención de datos. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { applyRetention } = await import('../src/privacy.js');

const contactBy = async (phone: string) => (await pool.query(`SELECT * FROM contacts WHERE phone = $1`, [phone])).rows[0];
const send = async (phone: string, text: string) => { const n = h.sent.length; await h.webhook(text, { phone }); await waitFor(() => h.sent.length > n, 6000); };
const settings = async (patch: Record<string, unknown>) => { const r = await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, patch); assert.equal(r.statusCode, 200, r.body); return r.json(); };

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('los contactos nuevos no tienen consentimiento; "ACEPTO" lo registra y confirma', async () => {
  await send('5215570000001', 'Hola');
  let c = await contactBy('5215570000001');
  assert.equal(c.consent_at, null);
  h.reset();
  await h.webhook('Acepto', { phone: '5215570000001' });
  await waitFor(() => h.sent.length === 1);
  assert.match(h.sent[0].text, /Te enviaremos novedades y promociones/);
  c = await contactBy('5215570000001');
  assert.ok(c.consent_at);
  assert.equal(c.consent_source, 'keyword');
  assert.equal(h.calls.length, 0, 'es una respuesta del sistema: no gasta IA');
});

t('las campañas solo van a quienes aceptaron; la vista previa dice cuántos quedan fuera', async () => {
  await send('5215570000002', 'Hola'); // sin consentimiento
  await send('5215570000003', 'Hola'); // sin consentimiento, lo marcará el equipo
  const c3 = await contactBy('5215570000003');
  await h.authed('PUT', `/api/contacts/${c3.id}`, { consent: true });
  assert.equal((await contactBy('5215570000003')).consent_source, 'panel');
  const camp = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Promo', message: 'Hola {{nombre}}, 20% de descuento', audience: {}, rate_per_minute: 60 })).json();
  const preview = (await h.authed('POST', `/api/campaigns/${camp.id}/preview`)).json();
  assert.equal(preview.count, 2);
  assert.equal(preview.excluded_no_consent, 1);
  h.reset();
  assert.equal((await h.authed('POST', `/api/campaigns/${camp.id}/launch`)).json().status, 'sending');
  await h.fastForward();
  const promos = h.sent.filter((s) => /20% de descuento/.test(s.text));
  assert.deepEqual(promos.map((p) => p.to).sort(), ['5215570000001', '5215570000003']);
  // Todas las promociones llevan cómo darse de baja
  assert.ok(promos.every((p) => /Responde BAJA para dejar de recibir estos mensajes\./.test(p.text)), JSON.stringify(promos));
});

t('el pie de baja usa la primera palabra configurada y se puede apagar; las respuestas normales no lo llevan', async () => {
  const s0 = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  await settings({ opt_out: { ...s0.opt_out, keywords: ['stop', 'baja'], footer_text: 'Escribe {{palabra_baja}} y te quitamos de la lista.' } });
  const c = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Otra', message: 'Novedad de octubre', audience: {}, rate_per_minute: 60 });
  h.reset();
  await h.authed('POST', `/api/campaigns/${c.json().id}/launch`);
  await h.fastForward();
  assert.ok(h.sent.some((s) => /Novedad de octubre\n\nEscribe STOP y te quitamos de la lista\./.test(s.text)), JSON.stringify(h.sent));
  await settings({ opt_out: { ...s0.opt_out, footer_enabled: false } });
  const c2 = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Sin pie', message: 'Sin pie de baja', audience: {}, rate_per_minute: 60 });
  h.reset();
  await h.authed('POST', `/api/campaigns/${c2.json().id}/launch`);
  await h.fastForward();
  const plain = h.sent.find((s) => s.text.startsWith('Sin pie de baja'));
  assert.ok(plain && !/dejar de recibir|quitamos/.test(plain.text));
  await settings({ opt_out: s0.opt_out });
  h.reset();
  await send('5215570000001', 'precio?');
  assert.ok(!/dejar de recibir/.test(h.sent[0].text), 'las respuestas del asistente no llevan pie');
});

t('con el requisito apagado se envía a todos; darse de baja y volver (ALTA) devuelve el consentimiento', async () => {
  await settings({ consent: { require_for_campaigns: false } });
  const camp = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Todos', message: 'Para todos', audience: {}, rate_per_minute: 60 })).json();
  assert.equal((await h.authed('POST', `/api/campaigns/${camp.id}/preview`)).json().count, 3);
  await settings({ consent: { require_for_campaigns: true } });
  // Baja → ya no recibe; ALTA → vuelve a recibir y queda con consentimiento
  await send('5215570000002', 'BAJA');
  assert.equal((await contactBy('5215570000002')).opted_out, true);
  await send('5215570000002', 'ALTA');
  const c2 = await contactBy('5215570000002');
  assert.equal(c2.opted_out, false);
  assert.equal(c2.consent_source, 'keyword');
});

t('derecho de acceso: el administrador descarga todo lo que se guarda del contacto', async () => {
  const c = await contactBy('5215570000001');
  const r = await h.authed('GET', `/api/contacts/${c.id}/data`);
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-disposition']), /datos-del-contacto\.json/);
  const d = r.json();
  assert.equal(d.contact.phone, '5215570000001');
  assert.ok(d.conversations.length >= 1);
  assert.ok(d.messages.some((m: any) => m.content === 'Hola' || m.content === 'Acepto'));
  assert.ok(d.contact.consent_at);
});

t('derecho de supresión: borra al contacto y su historial, anonimiza citas y conserva solo la contabilidad de IA', async () => {
  await send('5215570000009', 'Hola, soy Beto y mi tarjeta es privada');
  const c = await contactBy('5215570000009');
  const conv = (await pool.query(`SELECT id FROM conversations WHERE contact_id = $1`, [c.id])).rows[0].id;
  await pool.query(`INSERT INTO appointments (account_id, contact_id, conversation_id, customer_name, customer_phone, starts_at, ends_at, notes) VALUES ($1,$2,$3,'Beto','5215570000009', now() + interval '2 days', now() + interval '2 days 1 hour', 'alergia')`, [h.accountId, c.id, conv]);
  await pool.query(`INSERT INTO event_logs (account_id, conversation_id, level, source, message) VALUES ($1,$2,'info','engine','contenido: tarjeta privada')`, [h.accountId, conv]);
  const aiRuns = (await pool.query(`SELECT count(*)::int AS n FROM ai_runs WHERE conversation_id = $1`, [conv])).rows[0].n;
  assert.ok(aiRuns >= 1);
  // Un agente no puede; otra cuenta tampoco
  await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'agente@priv.mx', password: 'clave-agente-1', role: 'agent' });
  const agent = await h.loginAs('agente@priv.mx', 'clave-agente-1');
  assert.equal((await agent('DELETE', `/api/contacts/${c.id}`)).statusCode, 403);
  assert.equal((await agent('GET', `/api/contacts/${c.id}/data`)).statusCode, 403);
  const other = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.5.5.5', payload: { name: 'Otro', company: 'Otro negocio', business_type: 'otro', email: 'otro@priv.mx', password: 'clave-otro-123', accept_terms: true } });
  const cookie = String(other.headers['set-cookie']).split(';')[0];
  assert.equal((await h.app.inject({ method: 'DELETE', url: `/api/contacts/${c.id}`, headers: { cookie } })).statusCode, 404);
  // El administrador sí
  // Entregas de webhook con sus datos y el hilo de correo también se borran
  await pool.query(`INSERT INTO jobs (account_id, type, payload, run_at) VALUES ($1,'webhook_delivery',$2,now() + interval '1 hour')`, [h.accountId, JSON.stringify({ endpoint_id: 'x', event_id: 'e', event: 'contact.created', body: { data: { contact: { id: c.id, name: 'Dato privado' } } } })]);
  await pool.query(`INSERT INTO email_threads (channel_id, address, subject) SELECT channel_id, lower(external_id), 'Asunto privado' FROM contacts WHERE id = $1`, [c.id]);
  const del = await h.authed('DELETE', `/api/contacts/${c.id}`);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'webhook_delivery' AND payload::text LIKE '%Dato privado%'`)).rows[0].n, 0, 'las entregas pendientes con sus datos se borran');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM email_threads WHERE subject = 'Asunto privado'`)).rows[0].n, 0);
  assert.equal(del.statusCode, 200, del.body);
  assert.ok(del.json().messages >= 2);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [c.id])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`, [conv])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE message LIKE '%tarjeta privada%'`)).rows[0].n, 0);
  const appt = (await pool.query(`SELECT customer_name, customer_phone, notes FROM appointments WHERE account_id = $1 AND starts_at > now() ORDER BY created_at DESC LIMIT 1`, [h.accountId])).rows[0];
  assert.deepEqual(appt, { customer_name: '', customer_phone: '', notes: '' });
  const kept = (await pool.query(`SELECT count(*)::int AS n, count(decision)::int AS with_content FROM ai_runs WHERE account_id = $1 AND conversation_id IS NULL`, [h.accountId])).rows[0];
  assert.ok(kept.n >= aiRuns && kept.with_content === 0, 'el costo de IA se conserva sin contenido');
});

t('retención: borra mensajes viejos y su resumen; borra contactos inactivos salvo con citas futuras', async () => {
  await send('5215570000011', 'Hola, cliente viejo');
  await send('5215570000012', 'Hola, cliente con cita');
  await send('5215570000013', 'Hola, cliente reciente');
  const ids = Object.fromEntries(await Promise.all(['11', '12', '13'].map(async (n) => [n, await contactBy(`52155700000${n}`)])));
  const convOf = async (c: any) => (await pool.query(`SELECT id FROM conversations WHERE contact_id = $1`, [c.id])).rows[0].id;
  const [v, cita] = [await convOf(ids['11']), await convOf(ids['12'])];
  for (const cv of [v, cita]) {
    await pool.query(`UPDATE messages SET created_at = now() - interval '400 days' WHERE conversation_id = $1`, [cv]);
    await pool.query(`UPDATE conversations SET last_message_at = now() - interval '400 days', summary = 'resumen con datos personales' WHERE id = $1`, [cv]);
  }
  await pool.query(`INSERT INTO appointments (account_id, contact_id, conversation_id, customer_name, starts_at, ends_at) VALUES ($1,$2,$3,'Con cita', now() + interval '3 days', now() + interval '3 days 1 hour')`, [h.accountId, ids['12'].id, cita]);
  // Un contacto nuevo (importado hoy) sin conversaciones recientes no se borra: la inactividad se mide desde su creación
  await pool.query(`UPDATE contacts SET created_at = now() - interval '500 days' WHERE id = ANY($1)`, [[ids['11'].id, ids['12'].id]]);
  // Sin política de retención no se borra nada
  assert.deepEqual(await applyRetention(), { accounts: 0, messages: 0, contacts: 0 });
  await settings({ retention: { messages_days: 365, inactive_contacts_days: 365 } });
  const r = await applyRetention();
  assert.equal(r.accounts, 1);
  assert.ok(r.messages >= 2 && r.contacts === 1, JSON.stringify(r));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [ids['11'].id])).rows[0].n, 0, 'el inactivo se borra');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [ids['12'].id])).rows[0].n, 1, 'con cita futura se conserva');
  assert.equal((await pool.query(`SELECT summary FROM conversations WHERE id = $1`, [cita])).rows[0].summary, '', 'el resumen se limpia con los mensajes');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [ids['13'].id])).rows[0].n, 1, 'el reciente no se toca');
  assert.deepEqual(await applyRetention(), { accounts: 0, messages: 0, contacts: 0 }, 'idempotente');
  // Quien se dio de baja de promociones conserva su registro aunque esté inactivo (si no, podría volver a recibirlas)
  await send('5215570000014', 'Hola, me di de baja');
  const baja = await contactBy('5215570000014');
  const cb = (await pool.query(`SELECT id FROM conversations WHERE contact_id = $1`, [baja.id])).rows[0].id;
  await pool.query(`UPDATE contacts SET created_at = now() - interval '500 days', opted_out = true WHERE id = $1`, [baja.id]);
  await pool.query(`UPDATE conversations SET last_message_at = now() - interval '400 days' WHERE id = $1`, [cb]);
  await applyRetention();
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [baja.id])).rows[0].n, 1, 'la baja se respeta');
});
