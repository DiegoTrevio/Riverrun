/** Fotos y documentos de los clientes: se guardan tal como llegaron, se descargan igual y se borran junto con su mensaje. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness, dbAvailable, evo, ext, pool, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let phoneN = 0;
const newPhone = () => `52156${String(8000000 + ++phoneN)}`;
const uploads = () => process.env.UPLOADS_DIR as string; // el arnés fija UPLOADS_DIR antes de cargar la aplicación
const LIMIT = 16 * 1024 * 1024; // = INBOUND_MEDIA_MAX_BYTES (src/channels/media.ts)
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** Un PNG con firma y final válidos; el contenido del medio es propio de cada prueba. */
const png = (tag: string) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(tag), Buffer.from('0000000049454e44ae426082', 'hex')]);
const mediaCalls = () => ext.requests.filter((r) => r.path.startsWith('/chat/getBase64FromMediaMessage/')).length;

/** Mensaje de WhatsApp tal como lo entrega Evolution, con el contenido que se pida. */
async function sendWhatsApp(id: string, message: Record<string, unknown>, phone = newPhone()) {
  const r = await h.app.inject({
    method: 'POST',
    url: `/webhook/${h.token}`,
    payload: {
      event: 'messages.upsert',
      instance: 'palmas',
      data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Ana', message, messageTimestamp: Math.floor(Date.now() / 1000) },
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  // El webhook responde antes de procesar: se espera la respuesta del asistente, que sale solo después de guardar el mensaje.
  await waitFor(() => h.sent.some((s) => s.to === phone), 8000);
  await h.idle();
  return phone;
}

/** El mensaje y su archivo tal como quedaron en la base de datos. */
async function savedMessage(externalId: string) {
  const r = await pool.query(
    `SELECT m.id, m.type, m.content, m.meta, mm.kind, mm.mime, mm.file_name, mm.size_bytes, mm.sha256, mm.file_path, mm.complete
       FROM messages m LEFT JOIN message_media mm ON mm.message_id = m.id WHERE m.external_message_id = $1`,
    [externalId],
  );
  return r.rows[0];
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ personality: { prompt: 'Eres Sofi, la asistente de un taller mecánico.' } });
  h.setScript(() => ({ messages: ['Recibido, gracias.'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('foto del cliente: se guarda con sus bytes originales y el panel la descarga igual', async () => {
  const photo = png('foto-del-cliente-1');
  evo.media.set('MEDIA-1', { buffer: photo, mimetype: 'image/png' });
  const phone = await sendWhatsApp('MEDIA-1', { imageMessage: { caption: 'Así quedó el hueco', mimetype: 'image/png', fileLength: photo.length } });

  const m = await savedMessage('MEDIA-1');
  assert.equal(m.type, 'image');
  assert.equal(m.kind, 'image');
  assert.equal(m.mime, 'image/png');
  assert.equal(m.size_bytes, photo.length);
  assert.equal(m.sha256, sha(photo), 'la huella es la de los bytes que llegaron');
  assert.equal(m.complete, true);
  assert.deepEqual(await fs.readFile(path.join(uploads(), m.file_path)), photo, 'el archivo en disco es idéntico al recibido');

  const res = await h.authed('GET', `/api/messages/${m.id}/media`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.rawPayload, photo, 'la descarga entrega los mismos bytes');

  const conv = await h.conversationFor(phone);
  const detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
  const bubble = detail.messages.find((x: any) => x.external_message_id === 'MEDIA-1');
  assert.equal(bubble.media_kind, 'image', 'el panel recibe el tipo del archivo');
  assert.equal(bubble.media_complete, true);
});

t('documento cortado: se marca como incompleto, conserva su nombre y se descarga como adjunto', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Cotizacion) >>\nendobj\n% sin el final del archivo');
  evo.media.set('MEDIA-2', { buffer: pdf, mimetype: 'application/pdf' });
  await sendWhatsApp('MEDIA-2', { documentMessage: { fileName: 'Cotización (final) ñ.pdf', mimetype: 'application/pdf', fileLength: pdf.length } });

  const m = await savedMessage('MEDIA-2');
  assert.equal(m.kind, 'document');
  assert.equal(m.mime, 'application/pdf');
  assert.equal(m.file_name, 'Cotización (final) ñ.pdf');
  assert.equal(m.complete, false, 'un PDF sin %%EOF llegó cortado');
  assert.match(m.content, /documento: Cotización \(final\) ñ\.pdf/);

  const res = await h.authed('GET', `/api/messages/${m.id}/media`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'application/octet-stream', 'nunca se sirve un documento como página');
  assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('Cotización (final) ñ.pdf')}`);
  assert.deepEqual(res.rawPayload, pdf);
});

t('archivo más grande que el límite: no se descarga y el mensaje dice por qué', async () => {
  const before = mediaCalls();
  await sendWhatsApp('MEDIA-3', { imageMessage: { caption: 'Mira este video en foto', mimetype: 'image/jpeg', fileLength: LIMIT + 1 } });
  assert.equal(mediaCalls(), before, 'no se trae a memoria algo que ya se sabe demasiado grande');

  const m = await savedMessage('MEDIA-3');
  assert.equal(m.kind, null, 'sin archivo guardado');
  assert.match(m.meta.media_error, /pesa más de 16 MB/);
  assert.match(m.content, /Mira este video en foto/, 'el texto del mensaje se guarda igual');
});

t('si WhatsApp no entrega el archivo, el texto se guarda y el motivo queda en el mensaje', async () => {
  // Sin archivo preparado, el simulador de Evolution responde con error.
  await sendWhatsApp('MEDIA-4', { imageMessage: { caption: 'Te mando la foto del recibo', mimetype: 'image/jpeg', fileLength: 1200 } });

  const m = await savedMessage('MEDIA-4');
  assert.ok(m, 'el mensaje se guardó aunque el archivo falló');
  assert.match(m.content, /Te mando la foto del recibo/);
  assert.equal(m.kind, null);
  assert.match(m.meta.media_error, /^La foto no se guardó: /);
});

t('mismo mensaje dos veces: un solo archivo en disco y ninguno huérfano', async () => {
  const photo = png('foto-repetida-5');
  evo.media.set('MEDIA-5', { buffer: photo, mimetype: 'image/png' });
  const phone = newPhone();
  const dir = path.join(uploads(), 'inbound', h.accountId);
  await sendWhatsApp('MEDIA-5', { imageMessage: { mimetype: 'image/png', fileLength: photo.length } }, phone);
  const before = await fs.readdir(dir);
  // El segundo envío es el mismo mensaje reenviado por la plataforma: se procesa en línea para medir el resultado sin esperas.
  const channel = await store.getChannel(h.channelId);
  await h.service.handleIncoming(channel!, {
    messageId: 'MEDIA-5', externalId: `${phone}@s.whatsapp.net`, phone, displayName: 'Ana', fromMe: false,
    type: 'image', text: '', timestamp: Math.floor(Date.now() / 1000), media: { mimeType: 'image/png', size: photo.length },
  });
  assert.deepEqual((await fs.readdir(dir)).sort(), before.sort(), 'el duplicado no deja un archivo suelto');
  const n = await pool.query(`SELECT count(*)::int AS n FROM message_media mm JOIN messages m ON m.id = mm.message_id WHERE m.external_message_id = 'MEDIA-5'`);
  assert.equal(n.rows[0].n, 1);
});

t('borrar los datos de un contacto también borra sus fotos del disco', async () => {
  const photo = png('foto-para-borrar-6');
  evo.media.set('MEDIA-6', { buffer: photo, mimetype: 'image/png' });
  const phone = await sendWhatsApp('MEDIA-6', { imageMessage: { mimetype: 'image/png', fileLength: photo.length } });
  const m = await savedMessage('MEDIA-6');
  const file = path.join(uploads(), m.file_path);
  assert.ok((await fs.stat(file)).size > 0);

  const conv = await h.conversationFor(phone);
  const contactId = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().contact.id;
  const r = await h.authed('DELETE', `/api/contacts/${contactId}`);
  assert.equal(r.statusCode, 200, r.body);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }, 'el archivo se borró del disco');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_media WHERE message_id = $1', [m.id])).rows[0].n, 0);
});

t('al eliminar una cuenta se borra la carpeta de sus archivos recibidos', async () => {
  const accountId = crypto.randomUUID();
  const dir = path.join(uploads(), 'inbound', accountId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'archivo.jpg'), 'bytes');
  await store.deleteAccount(accountId);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});

t('lectura del mensaje: foto, documento y nota de voz llevan tipo, nombre, tamaño y duración', async () => {
  const { parseWebhook } = await import('../src/evolution/parse.js');
  const parseOne = (id: string, message: Record<string, unknown>) =>
    parseWebhook({
      event: 'messages.upsert',
      instance: 'palmas',
      data: { key: { remoteJid: '5215566660001@s.whatsapp.net', fromMe: false, id }, pushName: 'Ana', message, messageTimestamp: 1700000000 },
    }).messages[0];

  const image = parseOne('P-1', { imageMessage: { caption: 'Hola', mimetype: 'image/jpeg', fileLength: '2048' } });
  assert.equal(image.type, 'image');
  assert.equal(image.text, 'Hola');
  assert.equal(image.media?.mimeType, 'image/jpeg');
  assert.equal(image.media?.size, 2048);

  const doc = parseOne('P-2', { documentMessage: { fileName: 'lista.pdf', mimetype: 'application/pdf', fileLength: 5000 } });
  assert.equal(doc.type, 'document');
  assert.equal(doc.text, 'lista.pdf');
  assert.equal(doc.media?.filename, 'lista.pdf');
  assert.equal(doc.media?.mimeType, 'application/pdf');
  assert.equal(doc.media?.size, 5000);

  const voice = parseOne('P-3', { audioMessage: { seconds: 7 } });
  assert.equal(voice.type, 'audio');
  assert.equal(voice.media?.seconds, 7, 'la duración de la nota de voz sigue disponible para el costo');
});

t('retención: al borrar mensajes viejos también se borran sus archivos', async () => {
  // Va al final: aplica la retención a toda la cuenta de pruebas.
  const photo = png('foto-vieja-9');
  evo.media.set('MEDIA-9', { buffer: photo, mimetype: 'image/png' });
  await pool.query(`UPDATE accounts SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retention}', '{"messages_days": 5}'::jsonb) WHERE id = $1`, [h.accountId]);
  await sendWhatsApp('MEDIA-9', { imageMessage: { mimetype: 'image/png', fileLength: photo.length } });
  const m = await savedMessage('MEDIA-9');
  const file = path.join(uploads(), m.file_path);
  await pool.query(`UPDATE messages SET created_at = now() - interval '10 days' WHERE id = $1`, [m.id]);

  const { applyRetention } = await import('../src/privacy.js');
  const r = await applyRetention();
  assert.ok(r.messages >= 1, 'la retención borró mensajes');
  assert.equal((await pool.query('SELECT 1 FROM messages WHERE id = $1', [m.id])).rowCount, 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }, 'el archivo también se borró');
});
