/** Archivos para automatizaciones: subida, permisos, descarga, envío por WhatsApp y borrado. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let agent: Awaited<ReturnType<typeof h.loginAs>>;

const PDF = Buffer.from('%PDF-1.4\n% Cotización de prueba\n1 0 obj << >> endobj\ntrailer\n%%EOF\n');
const HTML = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');

/** Sube un archivo como multipart, con la sesión que se indique (por defecto, la del superadministrador). */
async function upload(name: string, buffer: Buffer, cookie: string = h.cookie) {
  const b = '----archivos';
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const body = Buffer.concat([head, buffer, Buffer.from(`\r\n--${b}--\r\n`)]);
  return h.app.inject({ method: 'POST', url: `/api/attachments?account_id=${h.accountId}`, payload: body, headers: { cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'agente@archivos.test', name: 'Agente', password: 'clave-archivos-1', role: 'agent' });
  assert.equal(r.statusCode, 200, r.body);
  agent = await h.loginAs('agente@archivos.test', 'clave-archivos-1');
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('subir: un PDF queda guardado con su tipo real y aparece en la lista', async () => {
  const r = await upload('cotizacion.pdf', PDF);
  assert.equal(r.statusCode, 200, r.body);
  const a = r.json();
  assert.equal(a.kind, 'document');
  assert.equal(a.mime, 'application/pdf');
  assert.equal(a.name, 'cotizacion.pdf');
  const list = (await h.authed('GET', `/api/attachments?account_id=${h.accountId}`)).json();
  assert.ok(list.some((x: { id: string }) => x.id === a.id));
});

t('subir: se rechaza HTML con nombre de PDF y se aceptan archivos de hasta 16 MB', async () => {
  const bad = await upload('factura.pdf', HTML);
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().error, /Tipo de archivo no permitido/);
  // Un archivo grande (12 MB) pasa: el límite del archivo es 16 MB, no el de 10 MB del resto de la API.
  const big = await upload('catalogo.pdf', Buffer.concat([PDF, Buffer.alloc(12 * 1024 * 1024)]));
  assert.equal(big.statusCode, 200, big.body);
});

t('un agente lista y descarga los archivos de su cuenta, pero no los sube', async () => {
  assert.equal((await upload('otro.pdf', PDF, agent.cookie)).statusCode, 403);
  const list = (await agent('GET', `/api/attachments`)).json();
  assert.ok(list.length >= 2);
  const first = list.find((x: { name: string }) => x.name === 'cotizacion.pdf');
  const file = await agent('GET', `/api/attachments/${first.id}/file`);
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.match(String(file.headers['content-disposition']), /^attachment;/);
  assert.ok(file.rawPayload.equals(PDF), 'los bytes son los que se subieron');
});

t('una regla envía el PDF por WhatsApp como documento y queda en el historial', async () => {
  const pdf = (await h.authed('GET', `/api/attachments?account_id=${h.accountId}`)).json().find((x: { name: string }) => x.name === 'cotizacion.pdf');
  const rule = await h.authed('POST', '/api/automations', {
    account_id: h.accountId,
    name: 'Enviar cotización',
    trigger: { type: 'message_received', match: 'keywords', keywords: ['cotizacion'] },
    actions: [{ type: 'send_message', text: 'Aquí tienes la cotización', attachment_id: pdf.id }],
  });
  assert.equal(rule.statusCode, 200, rule.body);
  h.reset();
  const phone = '5215520000001';
  await h.webhook('me mandas la cotizacion?', { phone });
  await waitFor(() => h.sent.some((s) => s.kind === 'file'), 8000);
  const sent = h.sent.find((s) => s.kind === 'file')!;
  assert.equal(sent.to, phone);
  assert.equal(sent.file, 'cotizacion.pdf');
  assert.equal(sent.mime, 'application/pdf');
  assert.equal(sent.fileKind, 'document');
  // El texto sale como mensaje aparte, antes que el archivo (igual que con las fotos): el archivo va sin leyenda.
  assert.equal(sent.text, '');
  assert.ok(h.sent.indexOf(h.sent.find((s) => s.kind === 'text' && s.text === 'Aquí tienes la cotización')!) < h.sent.indexOf(sent));
  const row = (await pool.query(`SELECT m.type, m.meta FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.phone = $1 AND m.type = 'document'`, [phone])).rows[0];
  assert.equal(row.meta.attachment_id, pdf.id);
  assert.equal(row.meta.file_name, 'cotizacion.pdf');
});

t('borrar: el archivo deja de estar disponible y no se puede descargar', async () => {
  const pdf = (await h.authed('GET', `/api/attachments?account_id=${h.accountId}`)).json().find((x: { name: string }) => x.name === 'cotizacion.pdf');
  assert.equal((await agent('DELETE', `/api/attachments/${pdf.id}`)).statusCode, 403, 'solo un administrador borra');
  assert.equal((await h.authed('DELETE', `/api/attachments/${pdf.id}`)).statusCode, 200);
  assert.equal((await agent('GET', `/api/attachments/${pdf.id}/file`)).statusCode, 404);
});
