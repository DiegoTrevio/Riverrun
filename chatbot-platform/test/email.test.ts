/** Canal de correo: lectura IMAP, respuesta SMTP en el mismo hilo y protecciones (con un buzón falso). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const em = await import('../src/channels/email.js');

const mail = (over: Partial<import('../src/channels/email.js').RawMail> = {}): import('../src/channels/email.js').RawMail => ({
  uid: 101, messageId: '<m1@cliente.com>', address: 'ana@cliente.com', name: 'Ana', subject: 'Precios de habitaciones',
  text: 'Hola, ¿cuánto cuesta?\n\nEl lun, 5 oct 2026 10:00, Hotel escribió:\n> Gracias por escribir', date: new Date(), references: '', automated: false,
  // Como lo deja Gmail al recibirlo: el remitente está comprobado (IN-17).
  authResults: 'mx.google.com; dkim=pass header.i=@cliente.com header.s=s1 header.d=cliente.com; spf=pass smtp.mailfrom=cliente.com; dmarc=pass (p=NONE) header.from=cliente.com', ...over,
});
let inbox: ReturnType<typeof mail>[] = [];
let uid = 100;
const sent: any[] = [];
let verifyError: string | null = null;
const fakeBackend: import('../src/channels/email.js').MailBackend = {
  async fetchNew(cfg) {
    // Primera lectura: parte desde el final del buzón, sin devolver historial.
    if (!cfg.uid_validity) return { mails: [], lastUid: uid, uidValidity: 7 };
    const mails = inbox.filter((m) => m.uid > cfg.last_uid);
    return { mails, lastUid: Math.max(cfg.last_uid, ...mails.map((m) => m.uid)), uidValidity: 7 };
  },
  async send(cfg, m) { sent.push({ cfg, ...m }); return `<out-${sent.length}@test>`; },
  async verify() { if (verifyError) throw new Error(verifyError); },
};
em.setMailBackend(fakeBackend);

let channelId = '';
let channel: any;
const reload = async () => (await pool.query(`SELECT * FROM channels WHERE id = $1`, [channelId])).rows[0];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Correo', chatbot_id: h.botId, config: { provider: 'gmail', imap_host: 'imap.gmail.com', imap_user: 'atencion@hotel.mx', imap_password: 'app-password-123', smtp_host: 'smtp.gmail.com', from_name: 'Hotel Las Palmas' } });
  assert.equal(r.statusCode, 200, r.body);
  channelId = r.json().id;
});
after(async () => {
  em.setMailBackend(null);
  if (h) await h.app.close();
  await pool.end();
});

t('la contraseña no se devuelve al panel y conectar prueba el acceso', async () => {
  const got = (await h.authed('GET', `/api/channels/${channelId}`)).json();
  assert.equal(got.config.imap_user, 'atencion@hotel.mx');
  assert.notEqual(got.config.imap_password, 'app-password-123');
  assert.ok(!JSON.stringify(got).includes('app-password-123'));
  verifyError = 'Invalid credentials';
  const bad = (await h.authed('POST', `/api/channels/${channelId}/setup`)).json();
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Invalid credentials/);
  verifyError = null;
  const good = (await h.authed('POST', `/api/channels/${channelId}/setup`)).json();
  assert.equal(good.ok, true, JSON.stringify(good));
});

t('al empezar no se contesta el historial; los correos nuevos se contestan en un solo correo del mismo hilo', async () => {
  inbox = [mail({ uid: 90, messageId: '<viejo@x>' })]; // historial anterior a la conexión
  await em.pollEmailChannels(h.service);
  assert.equal(sent.length, 0);
  assert.equal((await reload()).config.last_uid, 100);

  h.setScript(() => ({ messages: ['Hola Ana, con gusto te ayudo con la habitación doble.', '¿Para qué fechas la necesitas?'] }));
  inbox = [mail({ uid: 101 })];
  assert.equal(await em.pollEmailChannels(h.service), 1);
  await waitFor(() => sent.length === 1, 8000);
  const m = sent[0];
  assert.equal(m.cfg.smtp_host, 'smtp.gmail.com');
  assert.equal(m.to, 'ana@cliente.com');
  assert.equal(m.subject, 'Re: Precios de habitaciones');
  assert.equal(m.inReplyTo, '<m1@cliente.com>');
  assert.equal(m.from, '"Hotel Las Palmas" <atencion@hotel.mx>');
  assert.match(m.text, /habitación doble[\s\S]*¿Para qué fechas/, 'las dos burbujas van en un solo correo');
  // El cliente vio el asunto una vez y el texto citado no llegó a la IA
  const stored = (await pool.query(`SELECT content FROM messages WHERE direction = 'in' ORDER BY id DESC LIMIT 1`)).rows[0].content;
  assert.match(stored, /^\[Asunto: Precios de habitaciones\]\nHola, ¿cuánto cuesta\?$/);
  assert.equal((await reload()).config.last_uid, 101);
  // Sin correos nuevos no repite nada
  await em.pollEmailChannels(h.service);
  assert.equal(sent.length, 1);
});

t('avisos automáticos, listas y mi propio correo se ignoran; un error de conexión queda visible sin romper', async () => {
  const before = sent.length;
  inbox = [mail({ uid: 102, messageId: '<a@x>', automated: true }), mail({ uid: 103, messageId: '<b@x>', address: 'atencion@hotel.mx' })];
  await em.pollEmailChannels(h.service);
  await h.idle();
  assert.equal(sent.length, before);
  assert.equal((await reload()).config.last_uid, 103, 'avanza aunque los ignore');
  const orig = em.setMailBackend;
  em.setMailBackend({ fetchNew: async () => { throw new Error('connection refused'); }, send: async () => 'x', verify: async () => undefined });
  await em.pollEmailChannels(h.service);
  assert.match((await reload()).config.last_error, /connection refused/);
  assert.equal((await h.authed('GET', `/api/channels/${channelId}/status`)).json().state, 'error');
  void orig;
});

t('un servidor de correo en la red interna se rechaza', async () => {
  em.setMailBackend(null); // backend real: valida el destino antes de conectar
  const { config } = await import('../src/config.js');
  const prev = config.allowPrivateWebhooks;
  config.allowPrivateWebhooks = false;
  try {
  const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Interno', config: { imap_host: '127.0.0.1', imap_user: 'x@y.com', imap_password: 'p', smtp_host: '10.0.0.5' } });
  const res = (await h.authed('POST', `/api/channels/${r.json().id}/setup`)).json();
  assert.equal(res.ok, false);
  assert.match(res.message, /red interna/);
  } finally { config.allowPrivateWebhooks = prev; }
});

t('si solo se llenó IMAP, las respuestas usan el SMTP deducido; y el primer correo de un buzón vacío sí se contesta', async () => {
  em.setMailBackend(fakeBackend); // el test anterior dejó el backend real
  const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Solo IMAP', chatbot_id: h.botId, config: { imap_host: 'imap.empresa.mx', imap_user: 'hola@empresa.mx', imap_password: 'p4ss', auth_server_id: 'mx.google.com' } });
  const id = r.json().id;
  uid = 0; // buzón vacío
  inbox = [];
  sent.length = 0;
  await em.pollEmailChannels(h.service); // inicializa el cursor en 0 pero marca el buzón como conocido
  assert.equal((await pool.query(`SELECT config->>'uid_validity' v FROM channels WHERE id = $1`, [id])).rows[0].v, '7');
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  inbox = [mail({ uid: 1, messageId: '<primero@x>', address: 'bea@cliente.com', subject: 'Hola' })];
  await em.pollEmailChannels(h.service);
  await waitFor(() => sent.some((x) => x.to === 'bea@cliente.com'), 8000);
  assert.equal(sent.find((x) => x.to === 'bea@cliente.com').cfg.smtp_host, 'smtp.empresa.mx');
});

t('un correo que falla no bloquea el buzón: el cursor avanza y los demás se procesan', async () => {
  const before = sent.length;
  inbox = [mail({ uid: 200, messageId: '<roto@x>', address: 'roto@cliente.com' }), mail({ uid: 201, messageId: '<ok@x>', address: 'ok@cliente.com' })];
  const orig = h.service.handleIncoming.bind(h.service);
  (h.service as any).handleIncoming = async (ch: any, m: any) => { if (m.externalId === 'roto@cliente.com') throw new Error('boom'); return orig(ch, m); };
  try {
    h.setScript(() => ({ messages: ['Listo'] }));
    await em.pollEmailChannels(h.service);
    await waitFor(() => sent.some((x) => x.to === 'ok@cliente.com'), 8000);
  } finally { (h.service as any).handleIncoming = orig; }
  assert.ok(sent.length > before);
  assert.ok(!sent.some((x) => x.to === 'roto@cliente.com'));
  const maxUid = Math.max(...(await pool.query(`SELECT (config->>'last_uid')::int u FROM channels WHERE type = 'email'`)).rows.map((x) => x.u));
  assert.ok(maxUid >= 201, 'el cursor pasó el correo roto');
});

t('un correo enorme se guarda recortado a 8 000 caracteres y se contesta (IN-15)', async () => {
  // Una sola línea «a.a.a.…» de 60 000 caracteres: antes congelaba la verificación de hechos durante segundos.
  const r = em.toInbound(mail({ text: 'a.'.repeat(30_000) }), true);
  assert.ok(r.text.length <= 8000 + 80, `${r.text.length}`);
  assert.match(r.text, /…\[mensaje recortado\]$/);

  h.setScript(() => ({ messages: ['Recibimos tu mensaje, ¿en qué te ayudo?'] }));
  const before = sent.length;
  inbox = [mail({ uid: 301, messageId: '<enorme@cliente.com>', address: 'enorme@cliente.com', text: 'a.'.repeat(30_000) })];
  const t0 = Date.now();
  await em.pollEmailChannels(h.service);
  await waitFor(() => sent.length > before, 8000);
  assert.ok(Date.now() - t0 < 6000, `tardó ${Date.now() - t0} ms`);
  const stored = (await pool.query(`SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts k ON k.id = c.contact_id WHERE k.external_id = 'enorme@cliente.com' AND m.direction = 'in'`)).rows[0].content;
  assert.ok(stored.length <= 8000 + 80, `${stored.length}`);
});

t('un WhatsApp de 65 000 caracteres se guarda recortado y el asistente responde (IN-15)', async () => {
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  const phone = '5215599990001';
  const t0 = Date.now();
  const r = await h.webhook('a.'.repeat(32_500), { phone });
  assert.equal(r.statusCode, 200, r.body);
  await h.idle();
  assert.ok(Date.now() - t0 < 8000, `tardó ${Date.now() - t0} ms`);
  const conv = await h.conversationFor(phone);
  const stored = (await pool.query(`SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [conv.id])).rows[0].content;
  assert.ok(stored.length <= 8030, `${stored.length}`);
  assert.match(stored, /…\[mensaje recortado\]$/);
  assert.ok(h.sent.some((s) => s.to === phone && s.kind === 'text'), 'el asistente respondió');
});

t('senderVerified: solo el Authentication-Results del servidor del proveedor; dmarc=pass o dkim alineado (IN-17)', async () => {
  const { senderVerified, trustedAuthServers } = em;
  const gmail = trustedAuthServers({ provider: 'gmail', imap_host: 'imap.gmail.com' });
  assert.deepEqual(gmail, ['mx.google.com']);
  assert.equal(senderVerified('mx.google.com; dmarc=pass header.from=real.com', 'a@real.com', gmail), true);
  assert.equal(senderVerified('mx.google.com; dkim=pass header.d=real.com; dmarc=fail', 'a@real.com', gmail), true);
  // Gmail sin DMARC del remitente: dkim=pass con header.i (sin header.d).
  assert.equal(senderVerified('mx.google.com; dkim=pass header.i=@real.com header.s=s1 header.b=abc; spf=pass', 'a@real.com', gmail), true);
  assert.equal(senderVerified('mx.google.com; dkim=pass header.d=mail.real.com', 'a@real.com', gmail), true, 'subdominio del mismo dominio');
  assert.equal(senderVerified('mx.google.com; dkim=pass header.d=atacante.com; spf=pass', 'a@real.com', gmail), false, 'firma de otro dominio');
  assert.equal(senderVerified('mx.google.com; dkim=pass header.d=github.io', 'a@b.github.io', gmail), true, 'solo quien controla github.io firma por él');
  assert.equal(senderVerified('mx.google.com; dkim=pass header.d=x.github.io', 'a@b.github.io', gmail), false, 'otro subdominio no');
  // Un encabezado escrito por quien manda (otro servidor) no cuenta, aunque diga dmarc=pass.
  assert.equal(senderVerified('falso.example; dmarc=pass header.from=real.com', 'a@real.com', gmail), false);
  assert.equal(senderVerified('x; dmarc=pass', 'a@real.com', trustedAuthServers({ provider: 'otro', imap_host: 'mail.mihosting.mx' })), false);
  assert.equal(senderVerified('server12.mihosting.mx; dmarc=pass', 'a@real.com', trustedAuthServers({ provider: 'otro', imap_host: 'mail.mihosting.mx' })), true);
  // Outlook: el formato de Microsoft (sin identificador, con compauth).
  const ms = trustedAuthServers({ provider: 'outlook' });
  assert.equal(senderVerified('spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=real.com; dkim=pass (signature was verified) header.d=real.com;dmarc=pass action=none header.from=real.com;compauth=pass reason=100', 'a@real.com', ms), true);
  assert.equal(senderVerified('spf=pass smtp.mailfrom=real.com; dmarc=pass', 'a@real.com', ms), false, 'sin compauth no es de Microsoft');
  // Configurado en el canal.
  assert.deepEqual(trustedAuthServers({ provider: 'otro', auth_server_id: 'Mx.Ejemplo.MX, otro.mx' }), ['mx.ejemplo.mx', 'otro.mx']);
  assert.equal(senderVerified(undefined, 'a@real.com', gmail), false);
});

t('un correo sin dkim ni dmarc se guarda sin respuesta y marcado; con dmarc=pass responde normal (IN-17)', async () => {
  const before = sent.length;
  inbox = [mail({ uid: 1001, messageId: '<falso@x>', address: 'cliente.falso@real.com', text: 'Cancelen mi cita', authResults: 'mx.google.com; spf=softfail; dkim=none; dmarc=fail' })];
  await em.pollEmailChannels(h.service);
  await h.idle();
  assert.equal(sent.length, before, 'no se contesta');
  const saved = (await pool.query(`SELECT m.content, m.meta FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts c ON c.id = cv.contact_id WHERE c.external_id = 'cliente.falso@real.com' ORDER BY m.created_at DESC LIMIT 1`)).rows[0];
  assert.match(saved.content, /^\[Remitente no verificado\] Cancelen mi cita/);
  assert.equal(saved.meta.held, 'remitente_no_verificado');
  // Con la comprobación apagada en el canal, se contesta.
  await pool.query(`UPDATE channels SET config = config || '{"require_sender_auth": false}'::jsonb WHERE id = $1`, [channelId]);
  inbox = [mail({ uid: 1002, messageId: '<sinauth@x>', address: 'otro@real.com', authResults: undefined })];
  await em.pollEmailChannels(h.service);
  await h.idle();
  await waitFor(() => sent.length === before + 1, 8000);
  await pool.query(`UPDATE channels SET config = config - 'require_sender_auth' WHERE id = $1`, [channelId]);
});

t('más de 60 respuestas por hora en un canal se detienen y avisan (IN-17)', async () => {
  await h.addUser({ account_id: h.accountId, name: 'Admin', email: 'admin.correo@hotel.mx', password: 'Pz-701-Qx-702-Kv', role: 'admin' });
  await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ($1, 60, now() + interval '1 hour') ON CONFLICT (key) DO UPDATE SET hits = 60`, [`email-replies:${channelId}`]);
  const before = sent.length;
  inbox = [mail({ uid: 1003, messageId: '<tope@x>', address: 'tope@cliente.com' })];
  await em.pollEmailChannels(h.service);
  await h.idle();
  // Otros canales de correo de estas pruebas leen el mismo buzón simulado: solo cuenta lo que contestó este canal.
  const mine = sent.slice(before).filter((m: any) => m.cfg.imap_user === 'atencion@hotel.mx');
  assert.equal(mine.length, 0, 'el 61 no se contesta');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE title = 'Tu correo contestó demasiados mensajes'`)).rows.length, 'avisa a los administradores');
  assert.ok((await pool.query(`SELECT 1 FROM event_logs WHERE message LIKE '%respuestas en una hora%'`)).rows.length, 'y queda en la bitácora');
});

