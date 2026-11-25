/** Bases de correos: importar un CSV a un canal de correo, con el origen de la base, el consentimiento y la lista de bajas. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
config.emailInbound.domain = 'correo.riverrun.test';
config.mail.resendApiKey = config.mail.resendApiKey || 're_test';

let h: Awaited<ReturnType<typeof createHarness>>;
let channelId = '';

const contacts = async () => (await pool.query(
  `SELECT external_id, name, phone, tags, opted_out, consent_at, consent_source FROM contacts WHERE channel_id = $1 ORDER BY external_id`, [channelId])).rows;
const importCsv = (csv: string, consent?: { confirmed: boolean; source: string }) =>
  h.authed('POST', '/api/contacts/import', { channel_id: channelId, csv, ...(consent ? { consent } : {}) });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'email', name: 'Correo de Eventos', chatbot_id: h.botId, config: { mode: 'forward', from_address: 'hola@eventos.mx', from_name: 'Eventos Luna' } });
  assert.equal(r.statusCode, 200, r.body);
  channelId = r.json().id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('una base de correos se importa por correo, con su origen y el consentimiento que confirmó el negocio', async () => {
  const csv = 'correo;nombre;telefono;etiquetas\nAna@Cliente.com;Ana López;5215512345678;boda|vip\n"Luis <luis@cliente.com>";Luis;;\nno-es-correo;Pedro;;\nana@cliente.com;Repetida;;\n;Sin correo;;\n';
  const r = await importCsv(csv, { confirmed: true, source: 'Formulario de mi sitio' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.created, 2);
  assert.equal(body.updated, 0);
  assert.deepEqual(body.errors.map((e: any) => [e.row, e.error]), [
    [4, 'Correo inválido: no-es-correo'],
    [5, 'Correo repetido en el archivo'],
    [6, 'Falta el correo'],
  ]);
  const rows = await contacts();
  assert.deepEqual(rows.map((c) => c.external_id), ['ana@cliente.com', 'luis@cliente.com']);
  const ana = rows[0];
  assert.equal(ana.name, 'Ana López');
  assert.equal(ana.phone, '5215512345678');
  assert.deepEqual(ana.tags, ['boda', 'vip']);
  assert.ok(ana.consent_at, 'queda la fecha del consentimiento');
  assert.equal(ana.consent_source, 'importación: Formulario de mi sitio');
  // Cada contacto tiene su conversación en el canal (es lo que recibe la campaña).
  const convs = (await pool.query(`SELECT count(*)::int AS n FROM conversations WHERE channel_id = $1`, [channelId])).rows[0].n;
  assert.equal(convs, 2);
});

t('volver a importar no cambia el consentimiento ya guardado ni lo da por quien no lo confirmó', async () => {
  const prev = (await contacts()).find((c) => c.external_id === 'ana@cliente.com');
  const r = await importCsv('email,nombre\nana@cliente.com,Ana\nmaria@cliente.com,María\n', { confirmed: false, source: 'Lista de la expo' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().created, 1);
  assert.equal(r.json().updated, 1);
  const rows = await contacts();
  const ana = rows.find((c) => c.external_id === 'ana@cliente.com');
  assert.equal(ana.consent_source, 'importación: Formulario de mi sitio');
  assert.equal(new Date(ana.consent_at).getTime(), new Date(prev.consent_at).getTime());
  const maria = rows.find((c) => c.external_id === 'maria@cliente.com');
  assert.equal(maria.consent_at, null, 'sin la casilla no hay consentimiento');
});

t('quien se dio de baja o rebotó sigue fuera aunque venga en el archivo', async () => {
  await pool.query(`INSERT INTO email_suppressions (account_id, address, reason) VALUES ($1, 'rebote@cliente.com', 'bounced')`, [h.accountId]);
  await pool.query(`UPDATE contacts SET opted_out = true, opted_out_at = now() WHERE channel_id = $1 AND external_id = 'luis@cliente.com'`, [channelId]);
  const r = await importCsv('correo\nrebote@cliente.com\nluis@cliente.com\nnuevo@cliente.com\n', { confirmed: true, source: 'Clientes 2025' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().suppressed, 2);
  const rows = await contacts();
  assert.equal(rows.find((c) => c.external_id === 'rebote@cliente.com').opted_out, true, 'el rebote entra dado de baja');
  assert.equal(rows.find((c) => c.external_id === 'luis@cliente.com').opted_out, true, 'la baja no se quita');
  assert.equal(rows.find((c) => c.external_id === 'nuevo@cliente.com').opted_out, false);
});

t('una base de correos pide su columna de correo y de dónde salió', async () => {
  const noColumn = await importCsv('telefono,nombre\n5215512345678,Ana\n', { confirmed: true, source: 'Sitio' });
  assert.equal(noColumn.statusCode, 400);
  assert.match(noColumn.json().error, /correo/);
  const noSource = await importCsv('correo\nana@cliente.com\n');
  assert.equal(noSource.statusCode, 400);
  assert.match(noSource.json().error, /de dónde salió/);
  const blankSource = await importCsv('correo\nana@cliente.com\n', { confirmed: true, source: '   ' });
  assert.equal(blankSource.statusCode, 400);
});
