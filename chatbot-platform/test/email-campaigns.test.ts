/**
 * Campañas por correo (simuladas: Resend es un doble de prueba). Envío desde el subdominio de campañas con Reply-To al
 * canal, enlace y cabeceras de baja, lista de bajas, rebotes y quejas, calentamiento, pausa automática y respuestas que
 * caen en la conversación y contesta el asistente.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const inbound = await import('../src/channels/email-inbound.js');
const campaign = await import('../src/channels/email-campaign.js');
type Received = import('../src/channels/email-inbound.js').ReceivedEmail;

const SECRET = `whsec_${Buffer.from('secreto-de-prueba-de-resend-32b!').toString('base64')}`;
config.emailInbound.domain = 'correo.riverrun.test';
config.emailInbound.webhookSecret = SECRET;
config.emailCampaigns.domain = 'envios.riverrun.test';
config.emailCampaigns.apiPerSecond = 1000;
config.mail.resendApiKey = config.mail.resendApiKey || 're_test';

const received = new Map<string, Received>();
const sent: any[] = [];
inbound.setResendBackend({
  async getReceived(id) {
    const e = received.get(id);
    if (!e) throw new Error(`Resend respondió 404: ${id}`);
    return e;
  },
  async send(payload) { sent.push(payload); return `re_${sent.length}`; },
});

let h: Awaited<ReturnType<typeof createHarness>>;
let channelId = '';
let alias = '';

function sign(raw: string, id: string) {
  const ts = Math.floor(Date.now() / 1000);
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}
let n = 0;
const webhook = (body: unknown) => {
  const raw = JSON.stringify(body);
  return h.app.inject({ method: 'POST', url: '/email/resend', headers: { 'content-type': 'application/json', ...sign(raw, `msg_${++n}`) }, payload: raw });
};
const deliveryEvent = (type: 'email.bounced' | 'email.complained', emailId: string, bounceType = 'Permanent') =>
  webhook({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: ['x'], ...(type === 'email.bounced' ? { bounce: { type: bounceType, message: 'Mailbox does not exist' } } : {}) } });

const importBase = (csv: string, confirmed = true) =>
  h.authed('POST', '/api/contacts/import', { channel_id: channelId, csv, consent: { confirmed, source: 'Formulario del sitio' } });
const newCampaign = (over: Record<string, unknown> = {}) =>
  h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: channelId, name: 'Promo de diciembre', subject: 'Promo para {{nombre}}', message: 'Hola {{nombre}}, este mes rentamos sillas con 20% de descuento.', audience: {}, rate_per_minute: 120, business_hours_only: false, ...over });
const contact = async (address: string) => (await pool.query(`SELECT * FROM contacts WHERE channel_id = $1 AND external_id = $2`, [channelId, address])).rows[0];
const sentTo = (address: string) => sent.filter((m) => m.to?.[0] === address);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Correo de Eventos', chatbot_id: h.botId, config: { mode: 'forward', from_address: 'hola@eventos.mx', from_name: 'Eventos Luna' } });
  assert.equal(r.statusCode, 200, r.body);
  channelId = r.json().id;
  assert.equal((await h.authed('POST', `/api/channels/${channelId}/setup`)).json().ok, true);
  alias = (await pool.query(`SELECT config->>'forward_alias' AS a FROM channels WHERE id = $1`, [channelId])).rows[0].a;
});
after(async () => {
  inbound.setResendBackend(null);
  if (h) await h.app.close();
  await pool.end();
});

t('una campaña sale desde el subdominio de campañas, con Reply-To al canal, asunto propio y baja de un clic', async () => {
  assert.equal((await importBase('correo,nombre\nana@cliente.com,Ana\nluis@cliente.com,Luis\n')).statusCode, 200);
  assert.equal((await importBase('correo,nombre\nsin-permiso@cliente.com,Pedro\n', false)).statusCode, 200);
  const c = await newCampaign();
  assert.equal(c.statusCode, 200, c.body);
  const preview = (await h.authed('POST', `/api/campaigns/${c.json().id}/preview`)).json();
  assert.equal(preview.count, 2, 'quien no aceptó queda fuera');
  assert.equal(preview.excluded_no_consent, 1);
  assert.equal(preview.email_daily_cap, 50, 'el primer día el tope es el del calentamiento');
  assert.equal(preview.problem, null);
  assert.equal((await h.authed('POST', `/api/campaigns/${c.json().id}/launch`)).json().status, 'sending');
  await h.fastForward();
  await h.idle();
  const m = sentTo('ana@cliente.com')[0];
  assert.ok(m, JSON.stringify(sent));
  assert.equal(m.from, `"Eventos Luna" <${alias}@envios.riverrun.test>`);
  assert.deepEqual(m.reply_to, [`${alias}@correo.riverrun.test`]);
  assert.equal(m.subject, 'Promo para Ana');
  assert.match(m.text, /^Hola Ana, este mes rentamos sillas con 20% de descuento\./);
  const ana = await contact('ana@cliente.com');
  const url = campaign.unsubscribeUrl(ana.id);
  assert.ok(m.text.includes(`date de baja aquí: ${url}`), m.text);
  assert.equal(m.headers['List-Unsubscribe'], `<${url}>`);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(m.headers['Auto-Submitted'], undefined, 'una campaña no es una respuesta automática');
  assert.equal(sentTo('sin-permiso@cliente.com').length, 0);
  const stats = (await pool.query(`SELECT status, stats FROM campaigns WHERE id = $1`, [c.json().id])).rows[0];
  assert.equal(stats.status, 'sent');
  assert.equal(stats.stats.sent, 2);
  // El correo queda en la conversación del cliente, como enviado por la campaña.
  const out = (await pool.query(`SELECT m.meta->>'source' AS source, m.external_message_id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.contact_id = $1 AND m.direction = 'out'`, [ana.id])).rows;
  assert.deepEqual(out.map((o) => o.source), ['campaign']);
  assert.match(out[0].external_message_id, /^re_\d+$/);
});

t('la respuesta a una campaña cae en la conversación y el asistente contesta en el mismo hilo', async () => {
  h.setScript(() => ({ messages: ['¡Hola Ana! Claro, te aparto las 40 sillas.'] }));
  const before = sent.length;
  received.set('em_r1', {
    id: 'em_r1', from: 'Ana <ana@cliente.com>', to: [`${alias}@correo.riverrun.test`], subject: 'Re: Promo para Ana',
    text: 'Me interesan 40 sillas\n\nEl lun, Eventos Luna escribió:\n> Hola Ana', message_id: '<r1@cliente.com>', created_at: new Date().toISOString(),
    headers: {}, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  });
  const r = await webhook({ type: 'email.received', data: { email_id: 'em_r1', to: [`${alias}@correo.riverrun.test`], received_for: [] } });
  assert.equal(r.statusCode, 200, r.body);
  await waitFor(() => sent.length === before + 1, 8000);
  const reply = sent.at(-1);
  assert.equal(reply.from, `"Eventos Luna" <${alias}@correo.riverrun.test>`, 'la respuesta sale de la dirección del canal, no del subdominio de campañas');
  assert.equal(reply.subject, 'Re: Promo para Ana');
  assert.equal(reply.headers['In-Reply-To'], '<r1@cliente.com>');
  const ana = await contact('ana@cliente.com');
  const msgs = (await pool.query(`SELECT direction, content FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.contact_id = $1 ORDER BY m.id`, [ana.id])).rows;
  assert.deepEqual(msgs.map((x) => x.direction), ['out', 'in', 'out'], 'campaña, respuesta del cliente y del asistente en una sola conversación');
  assert.equal(msgs[1].content, 'Me interesan 40 sillas');
});

t('quien contesta al remitente de la campaña (sin respetar el Reply-To) también llega al canal', async () => {
  assert.deepEqual(inbound.aliasesIn([`${alias}@envios.riverrun.test`]), [alias]);
  assert.deepEqual(inbound.aliasesIn(['otro@dominio.com']), []);
});

t('la baja de un clic (POST) y la página de baja (GET pide confirmar) sacan al cliente de las campañas', async () => {
  const luis = await contact('luis@cliente.com');
  const url = new URL(campaign.unsubscribeUrl(luis.id));
  const path = `${url.pathname}${url.search}`;
  const page = await h.app.inject({ method: 'GET', url: path });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /¿Dejar de recibir correos de/);
  assert.equal((await contact('luis@cliente.com')).opted_out, false, 'abrir el enlace no da de baja (los antivirus lo abren)');
  const bad = await h.app.inject({ method: 'POST', url: path.replace(/s=[^&]+/, 's=falsa') });
  assert.equal(bad.statusCode, 400);
  const oneClick = await h.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
  assert.equal(oneClick.statusCode, 200, oneClick.body);
  assert.match(oneClick.body, /Ya no recibirás correos/);
  assert.equal((await contact('luis@cliente.com')).opted_out, true);
  const sup = (await pool.query(`SELECT reason FROM email_suppressions WHERE account_id = $1 AND address = 'luis@cliente.com'`, [h.accountId])).rows[0];
  assert.equal(sup.reason, 'unsubscribed');
  // Volver a importarlo no lo regresa.
  await importBase('correo\nluis@cliente.com\n');
  assert.equal((await contact('luis@cliente.com')).opted_out, true);
  const before = sent.length;
  const c = await newCampaign({ name: 'Segunda' });
  await h.authed('POST', `/api/campaigns/${c.json().id}/launch`);
  await h.fastForward();
  await h.idle();
  assert.equal(sent.slice(before).filter((m) => m.to[0] === 'luis@cliente.com').length, 0);
  assert.equal(sent.slice(before).filter((m) => m.to[0] === 'ana@cliente.com').length, 1);
});

t('un rebote definitivo y una queja dan de baja la dirección; un rebote temporal no', async () => {
  await importBase('correo\nrebota@cliente.com\ntemporal@cliente.com\nqueja@cliente.com\n');
  const before = sent.length;
  const c = await newCampaign({ name: 'Tercera' });
  await h.authed('POST', `/api/campaigns/${c.json().id}/launch`);
  await h.fastForward();
  await h.idle();
  const idOf = async (address: string) => (await pool.query(
    `SELECT m.external_message_id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
      WHERE ct.channel_id = $1 AND ct.external_id = $2 AND m.direction = 'out' ORDER BY m.id DESC LIMIT 1`, [channelId, address])).rows[0].external_message_id;
  assert.ok(sent.length > before);
  assert.equal((await deliveryEvent('email.bounced', await idOf('rebota@cliente.com'))).statusCode, 200);
  assert.equal((await deliveryEvent('email.bounced', await idOf('temporal@cliente.com'), 'Transient')).statusCode, 200);
  assert.equal((await deliveryEvent('email.complained', await idOf('queja@cliente.com'))).statusCode, 200);
  // El mismo aviso repetido no se cuenta dos veces.
  await deliveryEvent('email.complained', await idOf('queja@cliente.com'));
  assert.equal((await contact('rebota@cliente.com')).opted_out, true);
  assert.equal((await contact('temporal@cliente.com')).opted_out, false);
  assert.equal((await contact('queja@cliente.com')).opted_out, true);
  const reasons = Object.fromEntries((await pool.query(`SELECT address, reason FROM email_suppressions WHERE account_id = $1`, [h.accountId])).rows.map((r) => [r.address, r.reason]));
  assert.equal(reasons['rebota@cliente.com'], 'bounced');
  assert.equal(reasons['queja@cliente.com'], 'complained');
  assert.equal(reasons['temporal@cliente.com'], undefined);
  const stats = (await pool.query(`SELECT stats FROM campaigns WHERE id = $1`, [c.json().id])).rows[0].stats;
  assert.equal(stats.bounced, 1);
  assert.equal(stats.complained, 1);
  // Un aviso de un correo que no es nuestro no rompe nada.
  assert.equal((await deliveryEvent('email.bounced', 're_no_existe')).statusCode, 200);
});

t('una campaña con demasiadas quejas se detiene sola', async () => {
  assert.equal(campaign.shouldPause({ sent: 99, complained: 10 }), null, 'con pocos enviados no se juzga');
  assert.equal(campaign.shouldPause({ sent: 1000, complained: 3, bounced: 50 }), null);
  assert.equal(campaign.shouldPause({ sent: 1000, complained: 4 }), 'complained');
  assert.equal(campaign.shouldPause({ sent: 1000, bounced: 51 }), 'bounced');
  // Una campaña en marcha que ya pasó el límite se cancela al llegar la queja, y se avisa a los administradores.
  await h.addUser({ account_id: h.accountId, name: 'Dueña', email: 'duena@eventos.mx', password: 'Pz-144-Qx-344-Kv', role: 'admin' });
  const c = (await newCampaign({ name: 'Con quejas' })).json();
  await pool.query(`UPDATE campaigns SET status = 'sending', stats = '{"sent": 400, "complained": 0}'::jsonb WHERE id = $1`, [c.id]);
  const conv = (await pool.query(`SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.channel_id = $1 AND ct.external_id = 'ana@cliente.com'`, [channelId])).rows[0].id;
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, content, status, external_message_id, meta) VALUES ($1, 'out', 'bot', 'x', 'ok', 're_queja_1', $2), ($1, 'out', 'bot', 'x', 'ok', 're_queja_2', $2)`, [conv, JSON.stringify({ source: 'campaign', campaign_id: c.id })]);
  await deliveryEvent('email.complained', 're_queja_1');
  assert.equal((await pool.query(`SELECT status FROM campaigns WHERE id = $1`, [c.id])).rows[0].status, 'sending', 'una queja de 400 no la detiene');
  await deliveryEvent('email.complained', 're_queja_2');
  assert.equal((await pool.query(`SELECT status FROM campaigns WHERE id = $1`, [c.id])).rows[0].status, 'cancelled');
  const note = (await pool.query(`SELECT title FROM notifications WHERE account_id = $1 ORDER BY id DESC LIMIT 1`, [h.accountId])).rows[0];
  assert.equal(note?.title, 'Detuvimos tu campaña de correo');
});

t('calentamiento: el tope diario sube con los días en que ya se envió', async () => {
  assert.equal(campaign.warmupCap(0), 50);
  assert.equal(campaign.warmupCap(3), 400);
  assert.equal(campaign.warmupCap(99), Math.min(5000, config.emailCampaigns.dailyMax));
  // Los envíos de hoy no cuentan como día ya calentado.
  assert.equal(await campaign.emailDailyCap(h.accountId), 50);
  await pool.query(`UPDATE campaign_recipients r SET sent_at = now() - interval '2 days' FROM campaigns c WHERE c.id = r.campaign_id AND c.account_id = $1 AND c.name = 'Promo de diciembre'`, [h.accountId]);
  assert.equal(await campaign.emailDailyCap(h.accountId), 100);
});

t('sin el subdominio de campañas, sin asunto, con foto o con un canal por IMAP la campaña no sale y dice por qué', async () => {
  const prev = config.emailCampaigns.domain;
  config.emailCampaigns.domain = '';
  try {
    const c = (await newCampaign({ name: 'Sin dominio' })).json();
    const r = await h.authed('POST', `/api/campaigns/${c.id}/launch`);
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /aún no están disponibles/);
  } finally { config.emailCampaigns.domain = prev; }
  const noSubject = (await newCampaign({ name: 'Sin asunto', subject: '' })).json();
  assert.match((await h.authed('POST', `/api/campaigns/${noSubject.id}/launch`)).json().error, /asunto/);
  const imap = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Buzón IMAP', config: { mode: 'imap', imap_host: 'imap.ejemplo.com', imap_user: 'a@ejemplo.com', imap_password: 'x' } });
  const viaImap = (await newCampaign({ name: 'Por IMAP', channel_id: imap.json().id })).json();
  assert.match((await h.authed('POST', `/api/campaigns/${viaImap.id}/launch`)).json().error, /por reenvío/);
});

t('el seguimiento a quien no contestó la campaña sale en el mismo hilo, con su enlace de baja y desde el subdominio de campañas', async () => {
  const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Seguimiento de campaña', trigger: { type: 'no_reply', minutes: 60 }, actions: [{ type: 'send_message', text: '¿Te interesa apartar sillas, {{nombre}}?' }] });
  assert.equal(r.statusCode, 200, r.body);
  await importBase('correo,nombre\nfrio@cliente.com,Rosa\n');
  const c = await newCampaign({ name: 'Con seguimiento', audience: { tags_any: [], tags_none: [], active_within_days: 0, statuses: [] } });
  await h.authed('POST', `/api/campaigns/${c.json().id}/launch`);
  await h.fastForward(); // la campaña
  await h.idle();
  const before = sent.length;
  await h.fastForward(); // los seguimientos por falta de respuesta
  await h.idle();
  const follow = sent.slice(before).find((m) => m.to[0] === 'frio@cliente.com');
  assert.ok(follow, JSON.stringify(sent.slice(before)));
  assert.equal(follow.subject, 'Re: Promo para Rosa');
  assert.equal(follow.from, `"Eventos Luna" <${alias}@envios.riverrun.test>`);
  assert.match(follow.text, /^¿Te interesa apartar sillas, Rosa\?/);
  assert.match(follow.text, /date de baja aquí: http/);
  assert.ok(follow.headers['List-Unsubscribe']);
  // Quien ya platicó con el asistente recibe el seguimiento como respuesta normal del canal.
  const warm = sent.slice(before).find((m) => m.to[0] === 'ana@cliente.com');
  if (warm) assert.equal(warm.from, `"Eventos Luna" <${alias}@correo.riverrun.test>`);
  await h.authed('DELETE', `/api/automations/${r.json().id}`);
});

t('la lista de bajas se respeta al enviar aunque el contacto se haya creado de nuevo, y ALTA no levanta una queja', async () => {
  // El contacto que se quejó se borra y vuelve a aparecer (otra importación o vuelve a escribir): sigue fuera.
  await pool.query(`DELETE FROM contacts WHERE channel_id = $1 AND external_id = 'queja@cliente.com'`, [channelId]);
  await importBase('correo\nqueja@cliente.com\n');
  await pool.query(`UPDATE contacts SET opted_out = false WHERE channel_id = $1 AND external_id = 'queja@cliente.com'`, [channelId]);
  const before = sent.length;
  const c = await newCampaign({ name: 'Después de la queja' });
  await h.authed('POST', `/api/campaigns/${c.json().id}/launch`);
  await h.fastForward();
  await h.idle();
  assert.equal(sent.slice(before).filter((m) => m.to[0] === 'queja@cliente.com').length, 0);
  const skipped = (await pool.query(
    `SELECT r.reason FROM campaign_recipients r JOIN conversations cv ON cv.id = r.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
      WHERE r.campaign_id = $1 AND ct.external_id = 'queja@cliente.com'`, [c.json().id])).rows[0];
  assert.equal(skipped.reason, 'el cliente marcó un correo como spam');
  // Las estadísticas de rebotes y quejas no se borran al terminar la campaña.
  const third = (await pool.query(`SELECT stats FROM campaigns WHERE name = 'Tercera'`)).rows[0].stats;
  assert.equal(third.complained, 1);
  assert.equal(third.bounced, 1);
  // Una baja por enlace sí se levanta si el cliente escribe ALTA; una queja no.
  assert.equal(await campaign.resumeAddress(h.accountId, 'queja@cliente.com'), false);
  assert.equal(await campaign.resumeAddress(h.accountId, 'luis@cliente.com'), true);
  assert.equal(await campaign.suppressionOf(h.accountId, 'luis@cliente.com'), null);
});
