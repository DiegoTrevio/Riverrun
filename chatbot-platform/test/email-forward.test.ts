/** Canal de correo por reenvío: webhook firmado de Resend, mismos filtros que IMAP y respuestas por la API de Resend. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const inbound = await import('../src/channels/email-inbound.js');
type Received = import('../src/channels/email-inbound.js').ReceivedEmail;

const SECRET = `whsec_${Buffer.from('secreto-de-prueba-de-resend-32b!').toString('base64')}`;
config.emailInbound.domain = 'correo.riverrun.test';
config.emailInbound.webhookSecret = SECRET;
config.mail.resendApiKey = config.mail.resendApiKey || 're_test';

const received = new Map<string, Received>();
const sent: any[] = [];
inbound.setResendBackend({
  async getReceived(id) {
    const e = received.get(id);
    if (!e) throw new Error(`Resend respondió 404: ${id}`);
    return e;
  },
  async send(payload) { sent.push(payload); return `out-${sent.length}`; },
});

let h: Awaited<ReturnType<typeof createHarness>>;
let channelId = '';
let address = '';

function sign(raw: string, id = 'msg_1', ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

const post = (raw: string, headers: Record<string, string>) =>
  h.app.inject({ method: 'POST', url: '/email/resend', headers: { 'content-type': 'application/json', ...headers }, payload: raw });

let n = 0;
/** Simula que llegó un correo: lo deja en la «API» de Resend y manda el aviso firmado. */
async function arrive(over: Partial<Received> = {}, to = address) {
  const id = `em_${++n}`;
  received.set(id, {
    id, from: 'Ana López <ana@cliente.com>', to: [to], subject: 'Precio de sillas',
    text: '¿Cuánto cuestan 40 sillas?\n\nEl lun, 5 oct 2026, Eventos escribió:\n> Hola', message_id: `<m${n}@cliente.com>`,
    created_at: new Date().toISOString(), headers: {}, authentication: { spf: 'fail', dkim: 'pass', dmarc: 'pass' }, ...over,
  });
  const raw = JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: id, from: 'ana@cliente.com', to: [to], cc: [], bcc: [], received_for: [], subject: 'x', attachments: [] } });
  return post(raw, sign(raw, `msg_${id}`));
}

const inMessages = async () => (await pool.query(
  `SELECT m.content FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
    WHERE ct.channel_id = $1 AND m.direction = 'in' ORDER BY m.id`, [channelId])).rows.map((r) => r.content as string);
const channelConfig = async () => (await pool.query(`SELECT config FROM channels WHERE id = $1`, [channelId])).rows[0].config;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Correo de Eventos', chatbot_id: h.botId, config: { mode: 'forward', from_address: 'hola@eventos.mx', from_name: 'Eventos Luna', forward_alias: 'robado' } });
  assert.equal(r.statusCode, 200, r.body);
  channelId = r.json().id;
});
after(async () => {
  inbound.setResendBackend(null);
  if (h) await h.app.close();
  await pool.end();
});

t('conectar crea la dirección de reenvío (no la elige el panel) y no pide contraseñas', async () => {
  const res = (await h.authed('POST', `/api/channels/${channelId}/setup`)).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  const cfg = await channelConfig();
  assert.match(cfg.forward_alias, /^c[0-9a-f]{16}$/, 'el alias «robado» que mandó el panel se ignora');
  address = `${cfg.forward_alias}@correo.riverrun.test`;
  assert.ok(res.message.includes(address), res.message);
  assert.equal((await h.authed('GET', `/api/channels/${channelId}/status`)).json().state, 'open');
  // Conectar otra vez conserva la misma dirección (el negocio ya configuró su reenvío).
  await h.authed('POST', `/api/channels/${channelId}/setup`);
  assert.equal((await channelConfig()).forward_alias, cfg.forward_alias);
});

t('sin EMAIL_INBOUND_DOMAIN en el servidor, conectar explica que no está disponible', async () => {
  const prev = config.emailInbound.domain;
  config.emailInbound.domain = '';
  try {
    const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Sin dominio', config: { mode: 'forward' } });
    const res = (await h.authed('POST', `/api/channels/${r.json().id}/setup`)).json();
    assert.equal(res.ok, false);
    assert.match(res.message, /aún no está disponible/);
  } finally { config.emailInbound.domain = prev; }
});

t('un aviso con firma mala, viejo o sin encabezados se rechaza', async () => {
  const raw = JSON.stringify({ type: 'email.received', data: { email_id: 'x', to: [address] } });
  const bad = await post(raw, { 'svix-id': 'a', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' });
  assert.equal(bad.statusCode, 401);
  const old = await post(raw, sign(raw, 'old', Math.floor(Date.now() / 1000) - 3600));
  assert.equal(old.statusCode, 401);
  assert.equal(inbound.verifyResendSignature({}, Buffer.from(raw), SECRET), false);
  // Una de varias firmas válida basta (Resend manda dos mientras se cambia el secreto).
  const good = sign(raw, 'multi');
  assert.equal(inbound.verifyResendSignature({ ...good, 'svix-signature': `v1,AAAA ${good['svix-signature']}` }, Buffer.from(raw), SECRET), true);
});

t('un correo reenviado se contesta por Resend desde la dirección del canal, en el mismo hilo', async () => {
  h.setScript(() => ({ messages: ['Hola Ana, con gusto te paso el precio de las sillas.'] }));
  const r = await arrive();
  assert.equal(r.statusCode, 200, r.body);
  await waitFor(() => sent.length === 1, 8000);
  const m = sent[0];
  assert.equal(m.from, `"Eventos Luna" <${address}>`);
  assert.deepEqual(m.to, ['ana@cliente.com']);
  assert.equal(m.subject, 'Re: Precio de sillas');
  assert.equal(m.headers['In-Reply-To'], '<m1@cliente.com>');
  assert.equal(m.headers['Auto-Submitted'], 'auto-replied');
  assert.match(m.text, /precio de las sillas/);
  assert.equal((await inMessages()).at(-1), '[Asunto: Precio de sillas]\n¿Cuánto cuestan 40 sillas?', 'lo citado no llega a la IA');
});

t('el mismo aviso repetido por Resend no se contesta dos veces', async () => {
  const before = sent.length;
  const count = (await inMessages()).length;
  const raw = JSON.stringify({ type: 'email.received', data: { email_id: `em_${n}`, to: [address] } });
  const r = await post(raw, sign(raw, 'retry'));
  assert.equal(r.statusCode, 200);
  await h.idle();
  assert.equal(sent.length, before);
  assert.equal((await inMessages()).length, count);
});

t('remitente que no pasa DMARC, avisos automáticos y el propio buzón del negocio no se contestan', async () => {
  const before = sent.length;
  await arrive({ from: 'jefe@banco.com', authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } });
  await arrive({ from: 'no-reply@tienda.com' });
  await arrive({ from: 'Eventos <hola@eventos.mx>' });
  await h.idle();
  assert.equal(sent.length, before);
  assert.ok((await inMessages()).some((c) => c.startsWith('[Remitente no verificado]')), 'el no verificado se guarda para el equipo');
});

t('la confirmación de reenvío de Gmail se guarda y se avisa, sin contestarla; el panel no la puede cambiar', async () => {
  const before = sent.length;
  await h.addUser({ account_id: h.accountId, email: 'dueno@eventos.mx', password: 'una-clave-larga-123', role: 'admin' });
  await arrive({ from: 'Gmail Team <forwarding-noreply@google.com>', subject: '(#123456789) Gmail Forwarding Confirmation - Receive Mail from hola@eventos.mx', text: 'Confirmation code: 123456789\nhttps://mail-settings.google.com/mail/vf-abc123', authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
  await h.idle();
  assert.equal(sent.length, before);
  const cfg = await channelConfig();
  assert.match(cfg.forward_confirmation, /123456789/);
  assert.match(cfg.forward_confirmation, /mail-settings\.google\.com/);
  const note = (await pool.query(`SELECT title FROM notifications WHERE account_id = $1 ORDER BY id DESC LIMIT 1`, [h.accountId])).rows[0];
  assert.equal(note?.title, 'Confirma el reenvío de tu correo');
  await h.authed('PUT', `/api/channels/${channelId}`, { config: { ...cfg, forward_alias: 'cfeedfeedfeedfeed', forward_confirmation: 'x' } });
  const again = await channelConfig();
  assert.equal(again.forward_alias, cfg.forward_alias);
  assert.match(again.forward_confirmation, /123456789/);
});

t('una «confirmación de Gmail» falsa (sin DMARC o de otro remitente) no se guarda ni avisa', async () => {
  const prev = (await channelConfig()).forward_confirmation;
  await arrive({ from: 'Gmail Team <forwarding-noreply@google.com>', subject: 'Gmail Forwarding Confirmation', text: 'Tu código es 999999999 https://mail-settings.google.com/mail/vf-falso', authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } });
  await arrive({ from: 'Soporte <soporte@g00gle.com>', subject: 'Gmail Forwarding Confirmation', text: 'Código 888888888', authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
  await h.idle();
  assert.equal((await channelConfig()).forward_confirmation, prev);
});

t('dos avisos del mismo correo a la vez se contestan una sola vez; los encabezados en lista también se leen', async () => {
  const before = sent.length;
  h.setScript(() => ({ messages: ['Claro, te ayudo.'] }));
  const id = `em_${++n}`;
  received.set(id, { id, from: 'beto@cliente.com', to: [address], subject: 'Hola', text: 'Hola', message_id: '<doble@cliente.com>', headers: [], authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
  const raw = JSON.stringify({ type: 'email.received', data: { email_id: id, to: [address] } });
  const [a, b] = await Promise.all([post(raw, sign(raw, 'dup-a')), post(raw, sign(raw, 'dup-b'))]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  await waitFor(() => sent.length === before + 1, 8000);
  await h.idle();
  assert.equal(sent.length, before + 1);
  // Un aviso automático con los encabezados como lista de {name, value} se reconoce y no se contesta.
  await arrive({ from: 'carla@cliente.com', headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] });
  await h.idle();
  assert.equal(sent.length, before + 1);
});

t('un remitente que no es una sola dirección válida se omite', async () => {
  const before = (await inMessages()).length;
  await arrive({ from: 'a@x.com, b@y.com' });
  await h.idle();
  assert.equal((await inMessages()).length, before);
});

t('un correo para una dirección que no es de ningún canal se acepta sin hacer nada; si la API de Resend falla, se pide reintento', async () => {
  const none = await arrive({}, 'cdeadbeefdeadbeef@correo.riverrun.test');
  assert.equal(none.statusCode, 200);
  const raw = JSON.stringify({ type: 'email.received', data: { email_id: 'no-existe', to: [address] } });
  assert.equal((await post(raw, sign(raw, 'fail'))).statusCode, 503);
});

t('el canal por reenvío no se lee por IMAP aunque tenga datos de IMAP', async () => {
  const em = await import('../src/channels/email.js');
  let fetched = 0;
  em.setMailBackend({ fetchNew: async () => { fetched++; return { mails: [], lastUid: 0, uidValidity: 1 }; }, send: async () => 'x', verify: async () => undefined });
  try {
    await pool.query(`UPDATE channels SET config = config || '{"imap_host":"imap.gmail.com","imap_password":"p"}'::jsonb WHERE id = $1`, [channelId]);
    await em.pollEmailChannels(h.service);
    assert.equal(fetched, 0);
  } finally { em.setMailBackend(null); }
});
