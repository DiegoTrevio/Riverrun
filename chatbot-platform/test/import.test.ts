/** Importar conocimiento desde una página web, un archivo o texto pegado. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { config } = await import('../src/config.js');
const { htmlToText, normalizeUrl } = await import('../src/knowledge-import.js');

const PAGE = `<html><head><title>Clínica</title><style>.x{color:red}</style><script>alert('no')</script></head>
<body><nav>Inicio | Contacto</nav><h1>Clínica Sonrisa</h1><p>Limpieza dental &mdash; $650</p><p>Abrimos de lunes a viernes</p></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/redir') { res.writeHead(302, { location: '/pagina' }); return res.end(); }
  if (req.url === '/pagina') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (req.url === '/vacia') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>Hola</body></html>'); }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const answer = (over: Record<string, string> = {}) => JSON.stringify({
  description: 'Clínica dental', catalog: 'Limpieza dental — $650', hours: 'Lunes a viernes', location: '', faq: '', other: '', ...over,
});

function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const b = '----prueba';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}`, cookie: h.cookie } };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  server.close();
  if (h) await h.app.close();
  await pool.end();
});

t('htmlToText quita scripts, estilos y etiquetas', async () => {
  const text = htmlToText(PAGE);
  assert.match(text, /Limpieza dental — \$650/);
  assert.doesNotMatch(text, /alert|color:red|<p>/);
});

t('las hojas de Google Sheets se leen como CSV', async () => {
  assert.equal(normalizeUrl('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=5').toString(), 'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=5');
  assert.equal(normalizeUrl('midominio.com/menu').toString(), 'https://midominio.com/menu');
});

t('importar desde una página: propuesta sin guardar, siguiendo redirecciones y registrando el gasto', async () => {
  h.reset();
  h.setScript(() => answer());
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, { url: `${base}/redir` });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sections.catalog, 'Limpieza dental — $650');
  assert.equal(r.json().description, 'Clínica dental');
  const sent = JSON.stringify(h.calls[0].messages);
  assert.match(sent, /Clínica Sonrisa/);
  assert.doesNotMatch(sent, /alert/);
  assert.equal((await h.authed('GET', `/api/chatbots/${h.botId}/knowledge`)).json().length, 0, 'sin save no se guarda nada');
  const run = await pool.query(`SELECT count(*)::int AS n FROM ai_runs WHERE kind = 'import'`);
  assert.equal(run.rows[0].n, 1);
});

t('importar y guardar: crea las secciones, recuerda la página y al repetir las reemplaza', async () => {
  h.setScript(() => answer());
  const url = `${base}/pagina`;
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, { url, save: true });
  assert.equal(r.statusCode, 200, r.body);
  let items = (await h.authed('GET', `/api/chatbots/${h.botId}/knowledge`)).json();
  assert.deepEqual(items.map((i: any) => i.title).sort(), ['Horarios', 'Productos, servicios y precios']);
  assert.ok(items.every((i: any) => i.source_url === url && i.active && i.always_include));
  h.setScript(() => answer({ catalog: 'Limpieza dental — $700' }));
  await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, { url, save: true });
  items = (await h.authed('GET', `/api/chatbots/${h.botId}/knowledge`)).json();
  assert.equal(items.length, 2, 'se actualiza, no se duplica');
  assert.equal(items.find((i: any) => i.category === 'precios').content, 'Limpieza dental — $700');
});

t('texto pegado y archivo de texto/CSV', async () => {
  h.setScript(() => answer({ catalog: 'Café — $40' }));
  const pasted = await h.authed('POST', `/api/onboarding/import?account_id=${h.accountId}`, { text: 'Café $40, pastel $60. Abrimos todos los días de 8 a 20.' });
  assert.equal(pasted.statusCode, 200, pasted.body);
  const m = multipart({}, { name: 'precios.csv', type: 'text/csv', data: Buffer.from('producto,precio\nCafé,40\nPastel,60\n') });
  const file = await h.app.inject({ method: 'POST', url: `/api/onboarding/import?account_id=${h.accountId}`, ...m });
  assert.equal(file.statusCode, 200, file.body);
  assert.match(JSON.stringify(h.calls.at(-1)!.messages), /Pastel,60/);
});

t('PDF y fotos se envían al modelo como archivo adjunto', async () => {
  h.setScript(() => answer());
  const m = multipart({}, { name: 'menu.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 prueba') });
  const r = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/knowledge/import`, ...m });
  assert.equal(r.statusCode, 200, r.body);
  const parts = h.calls.at(-1)!.messages[1].content as any[];
  assert.equal(parts[1].type, 'file');
  assert.match(parts[1].file.file_data, /^data:application\/pdf;base64,/);
  const img = multipart({}, { name: 'menu.jpg', type: 'image/jpeg', data: Buffer.from('jpg') });
  const r2 = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/knowledge/import`, ...img });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal((h.calls.at(-1)!.messages[1].content as any[])[1].type, 'image_url');
});

t('errores claros: Excel, sin datos, página vacía y respuesta sin información', async () => {
  const xl = multipart({}, { name: 'lista.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: Buffer.from('x') });
  const r = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/knowledge/import`, ...xl });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /CSV|PDF/);
  assert.equal((await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, {})).statusCode, 400);
  assert.equal((await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, { url: `${base}/vacia` })).statusCode, 400);
  assert.equal((await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, { url: `${base}/no-existe` })).statusCode, 400);
  h.setScript(() => answer({ description: '', catalog: '', hours: '' }));
  const empty = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, { text: 'Texto cualquiera sin datos útiles del negocio.' });
  assert.equal(empty.statusCode, 400);
});

t('no se puede leer la red interna', async () => {
  config.allowPrivateWebhooks = false;
  try {
    for (const url of ['http://127.0.0.1:1/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data']) {
      const r = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import`, { url });
      assert.equal(r.statusCode, 400, url);
    }
  } finally {
    config.allowPrivateWebhooks = true;
  }
});
