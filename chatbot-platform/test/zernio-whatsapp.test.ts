/**
 * WhatsApp oficial por Zernio: alta guiada (seguir usando la app del teléfono o no), un perfil de Zernio por número,
 * PIN de verificación en dos pasos, plantillas (crear, revisión de Meta, traer de Meta, borrar) y la regla de las 24 h:
 * fuera de la ventana solo sale una plantilla aprobada, con las variables del contacto.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, pool, store, zer } from './harness.js';
// Después del arnés (que define las variables de entorno con await de nivel superior).
const { platformWebhookSecret } = await import('../src/channels/zernio.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let wa: any;
let wa2: any;
let conv: any;
let templateId = '';

const lastConnect = () => [...ext.requests].reverse().find((r) => r.path.startsWith('/api/v1/connect/'))!;
const tokenOf = (redirect: string) => redirect.split('/').pop()!;
const back = (token: string, query: string) => h.app.inject({ method: 'GET', url: `/zernio/return/${token}?${query}` });
const deliver = (body: Record<string, unknown>) => {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', platformWebhookSecret()).update(raw).digest('hex');
  return h.app.inject({ method: 'POST', url: '/zernio/events', headers: { 'content-type': 'application/json', 'x-zernio-signature': sig }, payload: raw });
};
/** Conecta un número de WhatsApp desde "Redes sociales" y devuelve la red y el perfil usado. */
async function connectWhatsapp(zid: string, onboarding: 'api' | 'business_app') {
  const r = await owner('POST', '/api/social-accounts/connect', { platform: 'whatsapp', chatbot_id: h.botId, onboarding });
  assert.equal(r.statusCode, 200, r.body);
  const q = lastConnect().query;
  const profileId = q.get('profileId')!;
  zer.accounts.set(zid, { _id: zid, platform: 'whatsapp', profileId, username: `+52 81 ${zid}`, displayName: `Hotel ${zid}`, isActive: true });
  const ret = await back(tokenOf(q.get('redirect_url')!), `connected=whatsapp&profileId=${profileId}&accountId=${zid}`);
  assert.match(String(ret.headers.location), /zernio=ok$/);
  const account = (await owner('GET', '/api/social-accounts')).json().accounts.find((a: any) => a.platform === 'whatsapp' && a.display_name === `Hotel ${zid}`);
  return { account, profileId, query: q };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'wa@palmas.mx', name: 'Dueña', password: 'Pz-151-Qx-351-Kv', role: 'admin' });
  await pool.query('UPDATE users SET email_verified_at = now()');
  owner = await h.loginAs('wa@palmas.mx', 'Pz-151-Qx-351-Kv');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('alta guiada: WhatsApp se conecta con la página de Zernio en español y la opción de seguir usando la app', async () => {
  const c = await connectWhatsapp('acc_wa1', 'business_app');
  assert.equal(c.query.get('signup'), 'hosted');
  assert.equal(c.query.get('language'), 'es');
  assert.equal(c.query.get('onboarding'), 'business_app');
  assert.equal(c.profileId, (await pool.query(`SELECT zernio_profile_id AS p FROM accounts WHERE id = $1`, [h.accountId])).rows[0].p, 'el primer número va en el perfil del negocio');
  wa = c.account;
  assert.equal(wa.dm, true);
  const ch = (await store.getChannel(wa.channel_id))!;
  assert.deepEqual([ch.type, ch.config.platform, ch.config.account_id, ch.chatbot_id], ['zernio', 'whatsapp', 'acc_wa1', h.botId]);
});

t('un segundo número va en otro perfil del mismo negocio (Zernio permite un WhatsApp por perfil)', async () => {
  const c = await connectWhatsapp('acc_wa2', 'api');
  assert.equal(c.query.get('onboarding'), 'api');
  assert.notEqual(c.profileId, wa && (await store.getChannel(wa.channel_id))!.config.profile_id);
  const extra = (await pool.query(`SELECT account_id, external_id, is_primary FROM zernio_profiles WHERE profile_id = $1`, [c.profileId])).rows[0];
  assert.deepEqual(extra, { account_id: h.accountId, external_id: `${h.accountId}:wa2`, is_primary: false });
  wa2 = c.account;
  // Los mensajes de ese número llegan a su conexión (el perfil adicional es del negocio).
  const ch2 = (await store.getChannel(wa2.channel_id))!;
  assert.equal(ch2.config.profile_id, c.profileId);
  const ev = { id: `evt_${crypto.randomUUID()}`, event: 'message.received', timestamp: new Date().toISOString(),
    message: { id: 'zm_in2', conversationId: 'conv_wa2', platformMessageId: 'wamid_2', direction: 'incoming', text: 'Hola', sender: { name: 'Luis', phoneNumber: '+5218100000002' }, sentAt: new Date().toISOString() },
    conversation: { id: 'conv_wa2' }, account: { id: 'acc_wa2', profileId: c.profileId, platform: 'whatsapp' } };
  assert.equal((await deliver(ev)).statusCode, 200);
  await h.idle();
  const got = (await pool.query(`SELECT c.channel_id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.external_id = 'conv_wa2'`)).rows[0];
  assert.equal(got.channel_id, wa2.channel_id);
});

t('PIN de verificación en dos pasos: Meta lo rechaza con un aviso claro o registra el número', async () => {
  let r = await owner('POST', `/api/social-accounts/${wa.id}/whatsapp-pin`, { pin: '12' });
  assert.equal(r.statusCode, 400);
  r = await owner('POST', `/api/social-accounts/${wa.id}/whatsapp-pin`, { pin: '000000' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Meta no aceptó el PIN/);
  r = await owner('POST', `/api/social-accounts/${wa.id}/whatsapp-pin`, { pin: '481902' });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(ext.requests.some((x) => x.path === '/api/v1/accounts/acc_wa1/whatsapp/register' && x.body.pin === '481902'));
});

t('plantillas: se crean con ejemplos, Meta las aprueba (aviso al negocio), se traen de Meta y se borran', async () => {
  let r = await owner('POST', '/api/wa-templates', { social_account_id: wa.id, name: 'recordatorio', category: 'UTILITY', body: 'Hola {{1}}, tu reservación es el {{2}}.' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /ejemplo para cada variable/);
  r = await owner('POST', '/api/wa-templates', { social_account_id: wa.id, name: 'Recordatorio Cita', category: 'UTILITY', body: 'Hola' });
  assert.equal(r.statusCode, 400);
  r = await owner('POST', '/api/wa-templates', {
    social_account_id: wa.id, name: 'recordatorio', category: 'UTILITY', language: 'es_MX', header: 'Hotel Palmas',
    body: 'Hola {{1}}, tu reservación es el {{2}}.', examples: ['Ana', '12 de noviembre'], footer: 'Responde BAJA para no recibir más',
    buttons: [{ type: 'quick_reply', text: 'Confirmo' }, { type: 'url', text: 'Ver reserva', url: 'https://hotel.test/r' }],
  });
  assert.equal(r.statusCode, 200, r.body);
  const created = r.json();
  templateId = created.id;
  assert.deepEqual([created.status, created.variables, created.sendable], ['PENDING', 2, false]);
  const sent = ext.requests.filter((x) => x.path === '/api/v1/whatsapp/templates' && x.method === 'POST').pop()!;
  assert.equal(sent.body.accountId, 'acc_wa1');
  assert.deepEqual(sent.body.components.map((c: any) => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
  assert.deepEqual(sent.body.components[1].example, { body_text: [['Ana', '12 de noviembre']] });

  // Meta la aprueba: Zernio avisa por el webhook y el negocio recibe la notificación.
  const ev = { id: `evt_${crypto.randomUUID()}`, event: 'whatsapp.template.status_updated', timestamp: new Date().toISOString(),
    account: { accountId: 'acc_wa1', profileId: (await store.getChannel(wa.channel_id))!.config.profile_id, platform: 'whatsapp', username: 'x' },
    template: { templateId: 'meta_tpl_1', name: 'recordatorio', language: 'es_MX', status: 'APPROVED', reason: 'NONE' } };
  assert.equal((await deliver(ev)).statusCode, 200);
  await h.idle();
  const list = (await owner('GET', `/api/wa-templates?social_account_id=${wa.id}`)).json();
  assert.deepEqual(list.map((x: any) => [x.name, x.status, x.sendable]), [['recordatorio', 'APPROVED', true]]);
  const note = (await pool.query(`SELECT title, body FROM notifications WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`, [h.accountId])).rows[0];
  assert.match(note.title, /recordatorio/);
  assert.match(note.body, /aprobó/);

  // Creada en Meta directamente: "Traer de Meta" la agrega; la borrada allá se quita.
  zer.templates.push({ id: 'tpl_meta', accountId: 'acc_wa1', name: 'promo_octubre', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'Promo para {{1}}' }] });
  zer.templates.push({ id: 'tpl_foto', accountId: 'acc_wa1', name: 'con_foto', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Mira' }] });
  zer.templates.find((x) => x.name === 'recordatorio')!.status = 'APPROVED';
  assert.equal((await owner('POST', '/api/wa-templates/sync', { social_account_id: wa.id })).json().templates, 3);
  let names = (await owner('GET', '/api/wa-templates')).json();
  assert.deepEqual(names.map((x: any) => [x.name, x.sendable]), [['con_foto', false], ['promo_octubre', true], ['recordatorio', true]]);
  zer.templates = zer.templates.filter((x) => x.name !== 'con_foto');
  await owner('POST', '/api/wa-templates/sync', { social_account_id: wa.id });
  names = (await owner('GET', '/api/wa-templates')).json();
  assert.deepEqual(names.map((x: any) => x.name), ['promo_octubre', 'recordatorio']);
  const promo = names.find((x: any) => x.name === 'promo_octubre');
  assert.equal((await owner('DELETE', `/api/wa-templates/${promo.id}`)).statusCode, 200);
  assert.ok(ext.requests.some((x) => x.method === 'DELETE' && x.path === '/api/v1/whatsapp/templates/promo_octubre' && x.query.get('language') === 'es_MX'));
  assert.ok(!zer.templates.some((x) => x.name === 'promo_octubre'));
});

t('fuera de las 24 h solo sale una plantilla aprobada, con las variables del contacto; dentro, el mensaje normal', async () => {
  const profileId = (await store.getChannel(wa.channel_id))!.config.profile_id;
  const ev = { id: `evt_${crypto.randomUUID()}`, event: 'message.received', timestamp: new Date().toISOString(),
    message: { id: 'zm_in1', conversationId: 'conv_wa1', platformMessageId: 'wamid_1', direction: 'incoming', text: 'Hola, quiero reservar', sender: { name: 'Ana López', phoneNumber: '+5218100000001' }, sentAt: new Date().toISOString() },
    conversation: { id: 'conv_wa1' }, account: { id: 'acc_wa1', profileId, platform: 'whatsapp' } };
  await deliver(ev);
  await h.idle();
  conv = (await pool.query(`SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.external_id = 'conv_wa1'`)).rows[0];
  const send = (o: Record<string, unknown>) => h.service.outbound.send(conv.id, { text: '¿Seguimos con tu reservación, {{nombre}}?', source: 'automation', ...o } as any);
  const messagesPosted = () => ext.requests.filter((x) => x.method === 'POST' && x.path === '/api/v1/inbox/conversations/conv_wa1/messages');

  // Dentro de las 24 h: el mensaje normal, aunque haya plantilla.
  let before = messagesPosted().length;
  assert.equal((await send({ waTemplate: { template_id: templateId, params: ['{{nombre}}', 'viernes'] } })).sent, true);
  assert.equal(messagesPosted()[before].body.message, '¿Seguimos con tu reservación, Ana?');

  await pool.query(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1 AND direction = 'in'`, [conv.id]);
  let r = await send({});
  assert.deepEqual(r, { sent: false, reason: 'fuera de la ventana de 24 h: elige una plantilla aprobada de WhatsApp' });
  r = await send({ waTemplate: { template_id: templateId, params: ['{{nombre}}', ''] } });
  assert.equal(r.sent, false);
  assert.match((r as any).reason, /variable \{\{2\}\}/);

  before = messagesPosted().length;
  r = await send({ waTemplate: { template_id: templateId, params: ['{{nombre}}', 'viernes 12'] } });
  assert.equal(r.sent, true, JSON.stringify(r));
  const posted = messagesPosted()[before].body;
  assert.equal(posted.message, undefined);
  assert.deepEqual(posted.template, { elements: [{ name: 'recordatorio', language: 'es_MX', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: 'viernes 12' }] }] }] });
  const stored = (await pool.query(`SELECT content, meta FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1`, [conv.id])).rows[0];
  assert.equal(stored.content, 'Hola Ana, tu reservación es el viernes 12.');
  assert.equal(stored.meta.wa_template, 'recordatorio');

  // La plantilla de otro número del negocio no sirve en esta conversación.
  const other = await pool.query(`INSERT INTO wa_templates (account_id, social_account_id, name, language, status, components) VALUES ($1, $2, 'del_otro', 'es_MX', 'APPROVED', '[{"type":"BODY","text":"Hola"}]') RETURNING id`, [h.accountId, wa2.id]);
  r = await send({ waTemplate: { template_id: other.rows[0].id, params: [] } });
  assert.match((r as any).reason, /otro número de WhatsApp/);
});

t('desde la conversación: una persona envía la plantilla a mano; una regla o campaña no acepta plantillas de otro negocio', async () => {
  let r = await owner('POST', `/api/conversations/${conv.id}/send-template`, { template_id: templateId, params: ['Ana'] });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /variable \{\{2\}\}/);
  r = await owner('POST', `/api/conversations/${conv.id}/send-template`, { template_id: templateId, params: ['{{nombre}}', 'sábado'] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sender, 'human');
  assert.equal(r.json().content, 'Hola Ana, tu reservación es el sábado.');
  assert.equal((await store.getConversation(conv.id))!.status, 'human', 'la persona tomó la conversación');

  const other = (await h.authed('POST', '/api/accounts', { name: 'Otro hotel' })).json();
  const rule = await h.authed('POST', '/api/automations', {
    account_id: other.id, name: 'Seguimiento', trigger: { type: 'new_contact' },
    actions: [{ type: 'send_message', text: 'Hola', wa_template: { template_id: templateId, params: [] } }],
  });
  assert.equal(rule.statusCode, 400);
  assert.match(rule.json().error, /plantilla de WhatsApp no pertenece/);
  const mine = await owner('POST', '/api/automations', {
    name: 'Seguimiento', trigger: { type: 'new_contact' },
    actions: [{ type: 'send_message', text: 'Hola', wa_template: { template_id: templateId, params: ['{{nombre}}', 'mañana'] } }],
  });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.deepEqual(mine.json().actions[0].wa_template, { template_id: templateId, params: ['{{nombre}}', 'mañana'] });
});

t('revisión: promociones con plantilla dicen cómo darse de baja; aviso adelantado; solo plantilla dentro de 24 h; sincronizar perfiles adicionales', async () => {
  // Promoción (campaña) fuera de 24 h: una plantilla sin la palabra de baja no sale; la que la dice, sí.
  const promo = (await pool.query(`INSERT INTO wa_templates (account_id, social_account_id, name, language, category, status, components) VALUES ($1, $2, 'promo_sin_baja', 'es_MX', 'MARKETING', 'APPROVED', $3) RETURNING id`,
    [h.accountId, wa.id, JSON.stringify([{ type: 'BODY', text: 'Promo para {{1}}' }])])).rows[0].id;
  await pool.query(`UPDATE contacts SET consent_at = now() WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [conv.id]);
  await pool.query(`UPDATE conversations SET status = 'bot' WHERE id = $1`, [conv.id]);
  await pool.query(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1 AND direction = 'in'`, [conv.id]);
  let r: any = await h.service.outbound.send(conv.id, { text: 'Promo', source: 'campaign', waTemplate: { template_id: promo, params: ['{{nombre}}'] } });
  assert.equal(r.sent, false);
  assert.match(r.reason, /no dice cómo darse de baja/);
  r = await h.service.outbound.send(conv.id, { text: 'Promo', source: 'campaign', waTemplate: { template_id: templateId, params: ['{{nombre}}', 'el lunes'] } });
  assert.equal(r.sent, true, JSON.stringify(r));

  // Dentro de 24 h, un mensaje que solo tiene plantilla sale con ella (no queda "vacío").
  await pool.query(`UPDATE messages SET created_at = now() WHERE conversation_id = $1 AND direction = 'in'`, [conv.id]);
  const before = ext.requests.filter((x) => x.path === '/api/v1/inbox/conversations/conv_wa1/messages').length;
  r = await h.service.outbound.send(conv.id, { text: '', source: 'automation', waTemplate: { template_id: templateId, params: ['{{nombre}}', 'hoy'] } });
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.equal(ext.requests.filter((x) => x.path === '/api/v1/inbox/conversations/conv_wa1/messages')[before].body.template.elements[0].name, 'recordatorio');

  // Meta avisa de una plantilla que todavía no estaba guardada: se traen las del número. Las de código no se envían.
  zer.templates.push({ id: 'tpl_nueva', accountId: 'acc_wa1', name: 'nueva', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola' }] });
  zer.templates.push({ id: 'tpl_codigo', accountId: 'acc_wa1', name: 'codigo', language: 'es_MX', category: 'AUTHENTICATION', status: 'APPROVED', components: [{ type: 'BODY', text: 'Tu código es {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] }] });
  const profileId = (await store.getChannel(wa.channel_id))!.config.profile_id;
  await deliver({ id: `evt_${crypto.randomUUID()}`, event: 'whatsapp.template.status_updated', timestamp: new Date().toISOString(),
    account: { accountId: 'acc_wa1', profileId, platform: 'whatsapp', username: 'x' }, template: { templateId: 'tpl_nueva', name: 'nueva', language: 'es_MX', status: 'APPROVED', reason: 'NONE' } });
  // Un aviso sin estado no cambia nada.
  await deliver({ id: `evt_${crypto.randomUUID()}`, event: 'whatsapp.template.status_updated', timestamp: new Date().toISOString(),
    account: { accountId: 'acc_wa1', profileId, platform: 'whatsapp', username: 'x' }, template: { name: 'recordatorio', language: 'es_MX' } });
  await h.idle();
  const list = Object.fromEntries((await owner('GET', `/api/wa-templates?social_account_id=${wa.id}`)).json().map((x: any) => [x.name, [x.status, x.sendable]]));
  assert.deepEqual(list.nueva, ['APPROVED', true]);
  assert.deepEqual(list.codigo, ['APPROVED', false]);
  assert.deepEqual(list.recordatorio, ['APPROVED', true]);

  // Sincronizar revisa también el perfil adicional: un número conectado allá en Zernio se adopta.
  const extraProfile = (await store.getChannel(wa2.channel_id))!.config.profile_id;
  zer.accounts.set('acc_wa2_ig', { _id: 'acc_wa2_ig', platform: 'linkedin', profileId: extraProfile, username: 'otra', displayName: 'Otra', isActive: true });
  const sync = (await h.authed('POST', `/api/system/zernio/tenants/${h.accountId}/sync`)).json();
  assert.ok(sync.accounts >= 3, JSON.stringify(sync));
  const rows = Object.fromEntries((await pool.query(`SELECT zernio_account_id, status FROM social_accounts WHERE account_id = $1`, [h.accountId])).rows.map((x) => [x.zernio_account_id, x.status]));
  assert.equal(rows.acc_wa2_ig, 'active');
  assert.equal(rows.acc_wa2, 'active');
});

t('recordatorio de pago fuera de las 24 h: sale con la plantilla y los datos del cobro; sin plantilla no sale y queda el motivo', async () => {
  const contactId = (await pool.query(`SELECT contact_id FROM conversations WHERE id = $1`, [conv.id])).rows[0].contact_id;
  await pool.query(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1 AND direction = 'in'`, [conv.id]);
  const due = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  const made = await owner('POST', '/api/receivables', { contact_id: contactId, conversation_id: conv.id, concept: 'Reservación 12', amount_cents: 320000, due_date: due });
  assert.equal(made.statusCode, 201, made.body);
  const id = made.json().receivable.id;
  const posted = () => ext.requests.filter((x) => x.method === 'POST' && x.path === '/api/v1/inbox/conversations/conv_wa1/messages');

  // Sin plantilla: WhatsApp no deja escribir fuera de la ventana; no sale, no cuenta y el panel dice por qué.
  let before = posted().length;
  let r = await owner('POST', `/api/receivables/${id}/remind`);
  assert.equal(r.statusCode, 422, r.body);
  assert.match(r.json().error, /plantilla aprobada/);
  assert.equal(posted().length, before);
  assert.equal((await owner('GET', `/api/receivables/${id}`)).json().receivable.reminders_sent, 0);

  // Con la plantilla en los ajustes de cobro: sale con el nombre y el monto del cobro como variables.
  const s = await owner('PUT', '/api/receivables/settings', { payment_instructions: 'CLABE 012180001234567890', wa_template: { template_id: templateId, params: ['{{nombre}}', '{{pago.vencimiento}} por {{pago.monto}}'] } });
  assert.equal(s.statusCode, 200, s.body);
  before = posted().length;
  r = await owner('POST', `/api/receivables/${id}/remind`);
  assert.equal(r.statusCode, 200, r.body);
  const body = posted()[before].body;
  assert.equal(body.template.elements[0].name, 'recordatorio');
  const params = body.template.elements[0].components[0].parameters.map((p: any) => p.text);
  assert.equal(params[0], 'Ana');
  assert.match(params[1], /por \$3,200\.00$/);
  assert.equal((await owner('GET', `/api/receivables/${id}`)).json().receivable.reminders_sent, 1);
});

t('recordatorio de cita fuera de las 24 h: sale con la plantilla del servicio y los datos de la cita; sin plantilla no sale y queda el motivo', async () => {
  const contactId = (await pool.query(`SELECT contact_id FROM conversations WHERE id = $1`, [conv.id])).rows[0].contact_id;
  await pool.query(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1 AND direction = 'in'`, [conv.id]);
  const svc = await owner('POST', '/api/services', { name: 'Masaje relajante', duration_minutes: 60 });
  assert.equal(svc.statusCode, 200, svc.body);
  const appt = (await pool.query(`INSERT INTO appointments (account_id, service_id, service_name, contact_id, conversation_id, customer_name, starts_at, ends_at)
    VALUES ($1, $2, 'Masaje relajante', $3, $4, 'Ana', now() + interval '1 day', now() + interval '1 day 1 hour') RETURNING id`, [h.accountId, svc.json().id, contactId, conv.id])).rows[0].id;
  const posted = () => ext.requests.filter((x) => x.method === 'POST' && x.path === '/api/v1/inbox/conversations/conv_wa1/messages');
  const warned = async () => (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1 AND message LIKE 'Recordatorio no enviado%' ORDER BY id DESC LIMIT 1`, [conv.id])).rows[0]?.message;

  let before = posted().length;
  await h.service.agenda.sendReminder({ appointment_id: appt });
  assert.equal(posted().length, before, 'sin plantilla no sale');
  assert.match(await warned(), /plantilla aprobada/);

  const saved = await owner('PUT', `/api/services/${svc.json().id}`, { reminder_wa_template: { template_id: templateId, params: ['{{nombre}}', '{{cita.servicio}} el {{cita.fecha}}'] } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().reminder_wa_template.template_id, templateId);
  before = posted().length;
  await h.service.agenda.sendReminder({ appointment_id: appt });
  const body = posted()[before]?.body;
  assert.ok(body, 'sale con la plantilla');
  const params = body.template.elements[0].components[0].parameters.map((p: any) => p.text);
  assert.equal(params[0], 'Ana');
  assert.match(params[1], /^Masaje relajante el \S+ \d+ de \S+$/);
});
