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
  text: 'Hola, ¿cuánto cuesta?\n\nEl lun, 5 oct 2026 10:00, Hotel escribió:\n> Gracias por escribir', date: new Date(), references: '', automated: false, ...over,
});
let inbox: ReturnType<typeof mail>[] = [];
let uid = 100;
const sent: any[] = [];
let verifyError: string | null = null;
em.setMailBackend({
  async fetchNew(cfg) {
    // Primera lectura: parte desde el final del buzón, sin devolver historial.
    if (!cfg.last_uid) return { mails: [], lastUid: uid, uidValidity: 7 };
    const mails = inbox.filter((m) => m.uid > cfg.last_uid);
    return { mails, lastUid: Math.max(cfg.last_uid, ...mails.map((m) => m.uid)), uidValidity: 7 };
  },
  async send(cfg, m) { sent.push({ cfg, ...m }); return `<out-${sent.length}@test>`; },
  async verify() { if (verifyError) throw new Error(verifyError); },
});

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
