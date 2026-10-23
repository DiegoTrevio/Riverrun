/** Videos y documentos «igual que las fotos»: se suben a la biblioteca del agente, la IA los elige por contexto y salen como archivo; y lo que manda el cliente (fotos, PDF, Word, videos) se guarda y se entiende. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
// El arnés va primero: define las variables de entorno antes de que se cargue la configuración.
import { createHarness, dbAvailable, evo, pool, sleep, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const IDS: Record<string, string> = {};

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Menu) >>\nendobj\n%%EOF\n');
/** MP4 mínimo: lo reconoce su caja «ftyp». */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32, 1)]);
const docx = (text: string) => {
  const zip = new PizZip();
  zip.file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
};

async function upload(code: string, name: string, fileName: string, mime: string, bytes: Buffer, extra: Record<string, string> = {}) {
  const b = '----x';
  const part = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const fields = { code, name, ...extra };
  const body = Buffer.concat([
    Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join('')),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: body, headers: { cookie: h.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
}
const say = async (text: string, phone: string) => {
  assert.equal((await h.webhook(text, { phone })).statusCode, 200);
  await sleep(350);
  await h.idle();
};
const filesTo = (phone: string) => h.sent.filter((s) => s.kind === 'file' && s.to === phone);
const lastPrompt = () => String(h.calls[h.calls.length - 1].messages[0].content);
const readCalls = () => h.summaryCalls.filter((c) => Array.isArray(c.messages[0].content));

/** Mensaje de WhatsApp con un archivo, tal como lo entrega Evolution. */
async function sendWhatsApp(id: string, message: Record<string, unknown>, phone: string) {
  const r = await h.app.inject({
    method: 'POST', url: `/webhook/${h.token}`,
    payload: { event: 'messages.upsert', instance: 'palmas', data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Ana', message, messageTimestamp: Math.floor(Date.now() / 1000) } },
  });
  assert.equal(r.statusCode, 200, r.body);
  await waitFor(() => h.sent.some((s) => s.to === phone), 8000);
  await h.idle();
}
const saved = async (externalId: string) =>
  (await pool.query(`SELECT m.type, m.content, mm.kind, mm.mime, mm.ai_summary FROM messages m LEFT JOIN message_media mm ON mm.message_id = m.id WHERE m.external_message_id = $1`, [externalId])).rows[0];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('biblioteca: acepta PDF, video y Word por su contenido; rechaza lo que no se manda a un cliente', async () => {
  let r = await upload('menu_pdf', 'Menú', 'Menu 2026.pdf', 'application/pdf', PDF, { description: 'Menú completo con precios', usage_rule: 'Cuando pidan el menú o los precios' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().kind, r.json().file_name, r.json().mime_type], ['document', 'Menu 2026.pdf', 'application/pdf']);
  IDS.menu = r.json().id;
  r = await upload('recorrido', 'Video del recorrido', 'clip.bin', 'video/mp4', MP4, { description: 'Recorrido por el lugar' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().kind, r.json().mime_type], ['video', 'video/mp4']);
  assert.equal(r.json().file_name, 'Video del recorrido.mp4', 'sin un nombre válido se usa el del negocio con su extensión');
  IDS.video = r.json().id;
  // Un ejecutable con extensión de PDF, un HTML o un ZIP no se aceptan.
  for (const [name, bytes] of [['virus.pdf', Buffer.from('MZ\x90\x00programa')], ['pagina.txt', Buffer.from('<html><script>alert(1)</script></html>')], ['fotos.zip', Buffer.from('PK\x03\x04comprimido')]] as const) {
    const bad = await upload(`x_${name.replace(/\W/g, '')}`, 'X', name, 'application/octet-stream', bytes);
    assert.equal(bad.statusCode, 400, name);
    assert.match(bad.json().error, /Formato no válido/);
  }
  const list = (await h.authed('GET', `/api/chatbots/${h.botId}/images`)).json();
  assert.deepEqual(list.map((i: any) => i.kind).sort(), ['document', 'video']);
});

t('la IA elige el PDF por contexto y sale como documento; no se repite y queda en el historial', async () => {
  h.reset();
  const phone = '5215550000001';
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Te mando el menú en PDF'], image_ids: ['menu_pdf'] }));
  await say('¿me pasas el menú?', phone);
  const p = lastPrompt();
  assert.match(p, /## Fotos y archivos/);
  assert.match(p, /`menu_pdf` \| Menú \(documento PDF\) \| contiene: Menú completo con precios/);
  assert.match(p, /`recorrido` \| Video del recorrido \(video\)/);
  assert.deepEqual(filesTo(phone).map((f) => [f.file, f.fileKind, f.mime]), [['Menu 2026.pdf', 'document', 'application/pdf']]);
  assert.equal(h.sent.filter((s) => s.kind === 'image' && s.to === phone).length, 0, 'un documento no sale como foto');
  const conv = await h.conversationFor(phone);
  const out = (await pool.query(`SELECT type, image_id, meta->>'file_name' AS file_name FROM messages WHERE conversation_id = $1 AND image_id IS NOT NULL`, [conv.id])).rows;
  assert.deepEqual(out, [{ type: 'document', image_id: IDS.menu, file_name: 'Menu 2026.pdf' }]);

  // Ya se envió: aunque la IA lo vuelva a elegir, no se repite (el cliente no pidió que se lo reenvíen).
  await say('gracias, ¿y el horario?', phone);
  assert.equal(filesTo(phone).length, 1);
  assert.match(JSON.stringify(h.calls[h.calls.length - 1].messages), /\[Documento enviado: menu_pdf - Menú\]/);
});

t('prometer un documento que no sale: la frase se quita', async () => {
  h.reset();
  const phone = '5215550000002';
  h.setScript(() => ({ action: 'reply', messages: ['Claro. Te envío el documento con los precios ahorita. ¿Algo más?'] }));
  await say('precios?', phone);
  const texts = h.sent.filter((s) => s.to === phone && s.kind === 'text').map((s) => s.text).join(' ');
  assert.doesNotMatch(texts, /Te envío el documento/);
  assert.equal(filesTo(phone).length, 0);
});

t('envío manual desde la conversación: un video de la biblioteca sale como archivo', async () => {
  h.reset();
  const phone = '5215550000003';
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  await say('hola', phone);
  const conv = await h.conversationFor(phone);
  const r = await h.authed('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.video, takeover: false });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().type, 'video');
  assert.deepEqual(filesTo(phone).map((f) => [f.file, f.fileKind]), [['Video del recorrido.mp4', 'video']]);
});

t('PDF del cliente: la IA lo lee una vez, el asistente recibe su contenido y queda el costo', async () => {
  h.reset();
  const phone = '5215550000004';
  h.setSummary('Comprobante de transferencia por $1,250 MXN del 3 de octubre, folio 8812.');
  evo.media.set('DOC-1', { buffer: PDF, mimetype: 'application/pdf' });
  h.setScript(() => ({ messages: ['Recibido, gracias.'] }));
  await sendWhatsApp('DOC-1', { documentMessage: { fileName: 'pago.pdf', mimetype: 'application/pdf', fileLength: PDF.length } }, phone);
  const m = await saved('DOC-1');
  assert.equal(m.kind, 'document');
  assert.equal(m.ai_summary, 'Comprobante de transferencia por $1,250 MXN del 3 de octubre, folio 8812.');
  assert.match(m.content, /^\[El cliente envió el documento «pago\.pdf»\. Contenido: Comprobante de transferencia por \$1,250 MXN/);
  const read = readCalls()[0];
  assert.ok(read, 'se pidió a la IA leer el archivo');
  assert.equal((read.messages[0].content as any[])[1].type, 'file', 'el PDF va como archivo');
  assert.ok(h.calls.some((c) => JSON.stringify(c.messages).includes('folio 8812')), 'el asistente ve lo que dice el documento');
  const run = (await pool.query(`SELECT kind FROM ai_runs WHERE kind = 'media' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.equal(run?.kind, 'media');
  const conv = await h.conversationFor(phone);
  const bubble = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().messages.find((x: any) => x.external_message_id === 'DOC-1');
  assert.match(bubble.media_summary, /folio 8812/, 'el panel muestra lo que entendió el asistente');
  h.setSummary('- resumen de prueba');
});

t('Word del cliente: se lee su texto sin llamar a la IA; video: se guarda para el equipo', async () => {
  h.reset();
  const phone = '5215550000005';
  const word = docx('Necesito 30 playeras talla M para el 15 de noviembre');
  evo.media.set('DOC-2', { buffer: word, mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  await sendWhatsApp('DOC-2', { documentMessage: { fileName: 'pedido.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileLength: word.length } }, phone);
  const m = await saved('DOC-2');
  assert.match(m.content, /Contenido: Necesito 30 playeras talla M para el 15 de noviembre/);
  assert.equal(readCalls().length, 0, 'el Word se lee sin IA');

  evo.media.set('VID-1', { buffer: MP4, mimetype: 'video/mp4' });
  await sendWhatsApp('VID-1', { videoMessage: { caption: 'así suena el motor', mimetype: 'video/mp4', fileLength: MP4.length } }, '5215550000006');
  const v = await saved('VID-1');
  assert.deepEqual([v.kind, v.mime], ['video', 'video/mp4']);
  assert.match(v.content, /video: "así suena el motor"/);
});

t('con «Entender fotos y documentos» apagado no se llama a la IA', async () => {
  await pool.query(`UPDATE chatbots SET ai = ai || '{"understand_media": false}'::jsonb WHERE id = $1`, [h.botId]);
  h.reset();
  evo.media.set('DOC-3', { buffer: PDF, mimetype: 'application/pdf' });
  await sendWhatsApp('DOC-3', { documentMessage: { fileName: 'otro.pdf', mimetype: 'application/pdf', fileLength: PDF.length } }, '5215550000007');
  const m = await saved('DOC-3');
  assert.equal(m.ai_summary, '');
  assert.match(m.content, /^\[El cliente envió un documento: otro\.pdf\]$/);
  assert.equal(readCalls().length, 0);
  await pool.query(`UPDATE chatbots SET ai = ai - 'understand_media' WHERE id = $1`, [h.botId]);
});
