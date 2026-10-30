/** El dueño se atiende solo: descargar todos sus datos, borrar su cuenta (con confirmación y plazo), contacto, estado y privacidad. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Api = Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
const A = { account: '', owner: null as unknown as Api, admin2: null as unknown as Api, agent: null as unknown as Api };
const B = { account: '', owner: null as unknown as Api };
let outbox: { to: string; subject: string; text: string; replyTo?: string }[];
let self: typeof import('../src/accounts/self-service.js');
let config: typeof import('../src/config.js').config;

async function account(name: string, email: string) {
  const r = await h.addAccount({ name, admin: { name: `Dueño ${name}`, email, password: 'Pz-144-Qx-344-Kv' } });
  return r.id as string;
}
const linkFor = (to: string) => {
  const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes('/borrar-cuenta?t='));
  assert.ok(mail, `sin enlace de borrado para ${to}`);
  return new URL(/(https?:\/\/\S+\/borrar-cuenta\?t=\S+)/.exec(mail.text)![1]);
};
const accRow = async (id: string) => (await pool.query(`SELECT deletion_requested_at, deletion_scheduled_for FROM accounts WHERE id = $1`, [id])).rows[0];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  outbox = (await import('../src/mailer.js')).outbox as any;
  self = await import('../src/accounts/self-service.js');
  config = (await import('../src/config.js')).config;
  A.account = await account('Florería Sol', 'sol@floreria.mx');
  B.account = await account('Otra Cuenta', 'beto@otra.mx');
  A.owner = await h.loginAs('sol@floreria.mx', 'Pz-144-Qx-344-Kv');
  B.owner = await h.loginAs('beto@otra.mx', 'Pz-144-Qx-344-Kv');
  await h.addUser({ account_id: A.account, name: 'Socia', email: 'socia@floreria.mx', password: 'Pz-144-Qx-344-Kv', role: 'admin' });
  await h.addUser({ account_id: A.account, name: 'Agente', email: 'agente@floreria.mx', password: 'Pz-144-Qx-344-Kv', role: 'agent' });
  A.admin2 = await h.loginAs('socia@floreria.mx', 'Pz-144-Qx-344-Kv');
  A.agent = await h.loginAs('agente@floreria.mx', 'Pz-144-Qx-344-Kv');
  // Datos de cada cuenta para comprobar que la descarga no mezcla cuentas.
  for (const [acc, phone, text] of [[A.account, '5215550001111', 'Quiero un ramo de rosas'], [B.account, '5215559999999', 'Mensaje secreto de B']]) {
    const ch = (await pool.query(`INSERT INTO channels (account_id, type, name, config, webhook_token) VALUES ($1, 'whatsapp', 'WA', $2::jsonb, md5(random()::text)) RETURNING id`, [acc, JSON.stringify({ instance: `exp-${phone}`, apikey: 'clave-del-canal' })])).rows[0].id;
    const ct = (await pool.query(`INSERT INTO contacts (account_id, channel_id, external_id, phone, name) VALUES ($1, $2, $3, $3, 'Cliente') RETURNING id`, [acc, ch, phone])).rows[0].id;
    const cv = (await pool.query(`INSERT INTO conversations (account_id, channel_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [acc, ch, ct])).rows[0].id;
    await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content) VALUES ($1, 'in', 'customer', 'text', $2)`, [cv, text]);
  }
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('descargar mis datos: ZIP con todo lo de la cuenta, sin credenciales ni datos de otra cuenta', async () => {
  const r = await h.app.inject({ method: 'GET', url: '/api/account/export.zip', headers: { cookie: A.owner.cookie } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'application/zip');
  assert.match(String(r.headers['content-disposition']), /attachment; filename="mis-datos-/);
  const zip = new PizZip(r.rawPayload);
  for (const f of ['LEEME.txt', 'cuenta.json', 'equipo.csv', 'agentes.json', 'automatizaciones.json', 'agenda.json', 'canales.csv', 'contactos.csv', 'conversaciones.csv', 'mensajes.csv', 'cotizaciones.json', 'pagos.csv', 'facturas.csv']) {
    assert.ok(zip.file(f), `falta ${f}`);
  }
  const all = Object.values(zip.files).map((f) => f.asText()).join('\n');
  assert.match(zip.file('mensajes.csv')!.asText(), /Quiero un ramo de rosas/);
  assert.match(zip.file('equipo.csv')!.asText(), /socia@floreria\.mx/);
  assert.equal(JSON.parse(zip.file('cuenta.json')!.asText()).name, 'Florería Sol');
  assert.ok(!all.includes('Mensaje secreto de B') && !all.includes('5215559999999') && !all.includes('beto@otra.mx'), 'no trae datos de otra cuenta');
  assert.ok(!all.includes('clave-del-canal'), 'no trae credenciales de los canales');
  assert.ok(!/password_hash|\$2[aby]\$/.test(all), 'no trae contraseñas');
});

t('descargar mis datos: solo el dueño (otro admin y un agente no), y el superadmin con ?account_id', async () => {
  const get = (api: Api, q = '') => h.app.inject({ method: 'GET', url: `/api/account/export.zip${q}`, headers: { cookie: api.cookie } });
  assert.equal((await get(A.admin2)).statusCode, 403);
  assert.equal((await get(A.agent)).statusCode, 403);
  assert.equal((await get(h.authed, `?account_id=${B.account}`)).statusCode, 200);
});

t('borrar la cuenta: solo el dueño y escribiendo el nombre; el correo trae el enlace firmado', async () => {
  assert.equal((await A.admin2('POST', '/api/account/deletion', { confirm: 'Florería Sol' })).statusCode, 403);
  assert.equal((await A.agent('POST', '/api/account/deletion', { confirm: 'Florería Sol' })).statusCode, 403);
  const wrong = await A.owner('POST', '/api/account/deletion', { confirm: 'Floreria' });
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.json().error, /Florería Sol/);
  const r = await A.owner('POST', '/api/account/deletion', { confirm: '  florería sol ' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().email, 'sol@floreria.mx');
  assert.equal((await accRow(A.account)).deletion_scheduled_for, null, 'pedirlo no programa nada todavía');

  const link = linkFor('sol@floreria.mx');
  // El GET solo pregunta (los antivirus abren los enlaces del correo).
  const page = await h.app.inject({ method: 'GET', url: link.pathname + link.search });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Sí, borrar mi cuenta en 7 días/);
  assert.equal((await accRow(A.account)).deletion_scheduled_for, null);
  // Un enlace alterado no sirve.
  const forged = self.deletionToken(B.account).split('.')[0] + '.' + link.searchParams.get('t')!.split('.')[1];
  assert.equal((await h.app.inject({ method: 'POST', url: `/borrar-cuenta?t=${encodeURIComponent(forged)}` })).statusCode, 400);
  assert.equal((await accRow(B.account)).deletion_scheduled_for, null);

  const done = await h.app.inject({ method: 'POST', url: link.pathname + link.search });
  assert.equal(done.statusCode, 200, done.body);
  const row = await accRow(A.account);
  const days = (new Date(row.deletion_scheduled_for).getTime() - new Date(row.deletion_requested_at).getTime()) / 86400_000;
  assert.equal(Math.round(days), 7);
  assert.ok(outbox.some((m) => m.to === 'sol@floreria.mx' && /se borrará el/.test(m.subject)), 'confirmación por correo');
  // Repetir el enlace no mueve la fecha.
  await h.app.inject({ method: 'POST', url: link.pathname + link.search });
  assert.equal(String((await accRow(A.account)).deletion_scheduled_for), String(row.deletion_scheduled_for));
  // /api/me lo trae para la franja del panel; ya programado, pedirlo otra vez → 409.
  assert.ok((await A.owner('GET', '/api/me')).json().account.deletion_scheduled_for);
  assert.equal((await A.owner('POST', '/api/account/deletion', { confirm: 'Florería Sol' })).statusCode, 409);
});

t('cancelar el borrado: solo el dueño (otro admin y un agente no); sin borrado programado → 409', async () => {
  assert.equal((await A.agent('DELETE', '/api/account/deletion')).statusCode, 403);
  assert.equal((await A.admin2('DELETE', '/api/account/deletion')).json().code, 'owner_only');
  const r = await A.owner('DELETE', '/api/account/deletion');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await accRow(A.account), { deletion_requested_at: null, deletion_scheduled_for: null });
  assert.equal((await A.owner('DELETE', '/api/account/deletion')).statusCode, 409);
});

t('un enlace vencido no sirve', async () => {
  const old = self.deletionToken(A.account, Date.now() - 2 * 86400_000);
  assert.equal(self.readDeletionToken(old), null);
  assert.equal((await h.app.inject({ method: 'GET', url: `/borrar-cuenta?t=${encodeURIComponent(old)}` })).statusCode, 400);
  assert.equal(self.readDeletionToken('basura'), null);
});

t('pasados los 7 días la cuenta se borra sola, se avisa al dueño, y antes de la fecha no', async () => {
  const id = await account('Cuenta Que Se Va', 'adios@cuenta.mx');
  const when = await self.scheduleDeletion(id);
  assert.ok(when);
  assert.equal(await self.checkScheduledDeletions(new Date(Date.now() + 86400_000)), 0);
  assert.ok(await accRow(id), 'antes del plazo sigue');
  assert.equal(await self.checkScheduledDeletions(new Date(when!.getTime() + 1000)), 1);
  assert.equal((await pool.query(`SELECT 1 FROM accounts WHERE id = $1`, [id])).rowCount, 0);
  assert.ok(outbox.some((m) => m.to === 'adios@cuenta.mx' && /Borramos tu cuenta/.test(m.subject)));
  assert.ok(await accRow(A.account), 'las demás cuentas siguen');
});

t('contacto: llega al buzón de soporte con «responder a», campo trampa y límite por conexión', async () => {
  const prev = config.signup.superadminEmail;
  config.signup.superadminEmail = 'soporte@plataforma.mx';
  try {
    const form = (body: Record<string, string>, ip = '10.40.0.1') =>
      h.app.inject({ method: 'POST', url: '/contacto', remoteAddress: ip, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });
    assert.equal((await h.app.inject({ method: 'GET', url: '/contacto' })).statusCode, 200);
    const sentBefore = outbox.length;
    const r = await form({ name: 'Marta', email: 'marta@cliente.mx', message: 'No me llega el código de WhatsApp' });
    assert.equal(r.statusCode, 200, r.body);
    const mail = outbox.slice(sentBefore).find((m) => m.to === 'soporte@plataforma.mx');
    assert.ok(mail);
    assert.equal(mail.replyTo, 'marta@cliente.mx');
    assert.match(mail.text, /No me llega el código/);

    assert.equal((await form({ name: 'Marta', email: 'no-es-correo', message: 'Mensaje suficientemente largo' })).statusCode, 400);
    const n = outbox.length;
    assert.equal((await form({ name: 'Bot', email: 'bot@spam.mx', message: 'Compra seguidores baratos', web: 'http://spam' })).statusCode, 200);
    assert.equal(outbox.length, n, 'el campo trampa no manda correo');
    for (let i = 0; i < 2; i++) await form({ name: 'Marta', email: 'marta@cliente.mx', message: 'Otro mensaje de prueba' });
    const limited = await form({ name: 'Marta', email: 'marta@cliente.mx', message: 'Otro mensaje de prueba' });
    assert.equal(limited.statusCode, 429);
    assert.equal((await form({ name: 'Luis', email: 'luis@cliente.mx', message: 'Desde otra conexión sí' }, '10.40.0.2')).statusCode, 200);
  } finally {
    config.signup.superadminEmail = prev;
  }
});

t('estado: componentes y su estado, sin mensajes de error ni direcciones internas', async () => {
  const r = await h.app.inject({ method: 'GET', url: '/estado' });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Estado del servicio/);
  assert.match(r.body, /<ul class="status">/);
  assert.ok(!/postgres:\/\/|localhost:\d+|127\.0\.0\.1|ECONNREFUSED|Error:/i.test(r.body), 'no expone detalles internos');
});

t('privacidad: aviso con derechos ARCO y el contacto configurado; precios y ayuda lo enlazan', async () => {
  const prev = config.signup.privacyContact;
  config.signup.privacyContact = 'privacidad@plataforma.mx';
  try {
    const r = await h.app.inject({ method: 'GET', url: '/privacidad' });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /ARCO/);
    assert.match(r.body, /20 días hábiles/);
    assert.match(r.body, /privacidad@plataforma\.mx/);
  } finally {
    config.signup.privacyContact = prev;
  }
  const precios = await h.app.inject({ method: 'GET', url: '/precios' });
  assert.match(precios.body, /href="\/privacidad"/);
  assert.match(precios.body, /href="\/contacto"/);
  const ayuda = await h.app.inject({ method: 'GET', url: '/ayuda.html' });
  assert.match(ayuda.body, /id="pagos"/);
  assert.match(ayuda.body, /href="\/privacidad"/);
});
