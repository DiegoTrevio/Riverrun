/** Exportar contactos, conversaciones y mensajes a CSV. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { csvCell } = await import('../src/export.js');

/** Lector de CSV mínimo (comillas, saltos de línea y comas dentro de celdas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* se ignora */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  return rows;
}
const csv = async (api: any, url: string) => {
  const r = await api('GET', url);
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers['content-type']), /text\/csv/);
  assert.equal(r.body.charCodeAt(0), 0xfeff, 'lleva BOM para que Excel lea los acentos');
  return { res: r, rows: parseCsv(r.body.slice(1)) };
};
const col = (rows: string[][], name: string) => rows.slice(1).map((r) => r[rows[0].indexOf(name)]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ data_fields: [{ key: 'correo', label: 'Correo', type: 'email' }, { key: 'personas', label: 'Personas', type: 'number' }] });
  h.setScript(() => ({ messages: ['Hola, ¿en qué te ayudo?'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('csvCell: comillas, comas, saltos de línea y neutralización de fórmulas', async () => {
  assert.equal(csvCell('hola'), 'hola');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('dice "hola"'), '"dice ""hola"""');
  assert.equal(csvCell('línea1\nlínea2'), '"línea1\nlínea2"');
  assert.equal(csvCell('=HYPERLINK("http://x","clic")'), '"\'=HYPERLINK(""http://x"",""clic"")"');
  assert.equal(csvCell('+52 55 1234'), "'+52 55 1234");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(new Date('2026-10-01T10:00:00Z')), '2026-10-01T10:00:00.000Z');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

t('contactos: todas las columnas, datos de los campos configurados y filtros', async () => {
  await h.webhook('Hola', { phone: '5215560000001' });
  await h.webhook('Hola', { phone: '5215560000002' });
  await waitFor(() => h.sent.length >= 2);
  const contacts = (await pool.query(`SELECT id, phone FROM contacts WHERE account_id = $1 ORDER BY phone`, [h.accountId])).rows;
  await h.authed('PUT', `/api/contacts/${contacts[0].id}`, { name: 'Ana "la jefa", Pérez', tags: ['vip', 'interesado'], data: { correo: 'ana@x.mx', personas: '4', extra: 'dato suelto' } });
  await h.authed('PUT', `/api/contacts/${contacts[1].id}`, { name: '=HYPERLINK("http://malo.example","clic")', opted_out: true });
  const { res, rows } = await csv(h.authed, `/api/export/contacts.csv?account_id=${h.accountId}`);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="contactos-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.deepEqual(rows[0].slice(0, 3), ['id', 'nombre', 'nombre_en_el_canal']);
  assert.ok(rows[0].includes('Correo') && rows[0].includes('Personas') && rows[0].includes('otros_datos'));
  assert.equal(rows.length, 3);
  const byPhone = Object.fromEntries(rows.slice(1).map((r) => [r[rows[0].indexOf('telefono')], r]));
  const ana = byPhone['5215560000001'];
  assert.equal(ana[rows[0].indexOf('nombre')], 'Ana "la jefa", Pérez');
  assert.equal(ana[rows[0].indexOf('etiquetas')], 'vip; interesado');
  assert.equal(ana[rows[0].indexOf('Correo')], 'ana@x.mx');
  assert.equal(ana[rows[0].indexOf('Personas')], '4');
  assert.equal(JSON.parse(ana[rows[0].indexOf('otros_datos')]).extra, 'dato suelto');
  const evil = byPhone['5215560000002'];
  assert.ok(evil[rows[0].indexOf('nombre')].startsWith("'="), 'el nombre malicioso queda como texto, no como fórmula');
  assert.equal(evil[rows[0].indexOf('dado_de_baja')], 'sí');
  // Filtros
  assert.deepEqual(col((await csv(h.authed, `/api/export/contacts.csv?account_id=${h.accountId}&tag=vip`)).rows, 'telefono'), ['5215560000001']);
  assert.deepEqual(col((await csv(h.authed, `/api/export/contacts.csv?account_id=${h.accountId}&opted_out=true`)).rows, 'telefono'), ['5215560000002']);
  assert.equal((await csv(h.authed, `/api/export/contacts.csv?account_id=${h.accountId}&since=2999-01-01`)).rows.length, 1, 'solo el encabezado');
  assert.equal((await h.authed('GET', `/api/export/contacts.csv?account_id=${h.accountId}&since=ayer`)).statusCode, 400);
});

t('conversaciones y mensajes: estado, conteo, transcripción y filtros', async () => {
  const conv = await csv(h.authed, `/api/export/conversations.csv?account_id=${h.accountId}`);
  assert.equal(conv.rows.length, 3);
  assert.deepEqual(col(conv.rows, 'estado'), ['bot', 'bot']);
  assert.ok(col(conv.rows, 'mensajes').every((n) => Number(n) >= 2));
  assert.equal((await csv(h.authed, `/api/export/conversations.csv?account_id=${h.accountId}&status=human`)).rows.length, 1);
  const msgs = await csv(h.authed, `/api/export/messages.csv?account_id=${h.accountId}`);
  assert.ok(col(msgs.rows, 'direccion').includes('recibido') && col(msgs.rows, 'direccion').includes('enviado'));
  assert.ok(col(msgs.rows, 'texto').includes('Hola, ¿en qué te ayudo?'));
  const one = (await pool.query(`SELECT id FROM conversations WHERE account_id = $1 LIMIT 1`, [h.accountId])).rows[0].id;
  const only = await csv(h.authed, `/api/export/messages.csv?account_id=${h.accountId}&conversation_id=${one}`);
  assert.ok(only.rows.length > 1 && only.rows.length < msgs.rows.length);
});

t('el simulador del panel no se exporta', async () => {
  await h.authed('POST', `/api/chatbots/${h.botId}/playground`, { session: 'zzz', text: 'prueba interna' });
  const msgs = await csv(h.authed, `/api/export/messages.csv?account_id=${h.accountId}`);
  assert.ok(!col(msgs.rows, 'texto').includes('prueba interna'));
  assert.ok(!col((await csv(h.authed, `/api/export/contacts.csv?account_id=${h.accountId}`)).rows, 'nombre').includes('Prueba'));
});

t('más de 1,000 filas se exportan completas, sin repetir ni saltar (paginación por cursor)', async () => {
  const ch = (await pool.query(`SELECT id FROM channels WHERE account_id = $1 AND type = 'whatsapp' LIMIT 1`, [h.accountId])).rows[0].id;
  await pool.query(
    `INSERT INTO contacts (account_id, channel_id, external_id, phone, name, created_at)
     SELECT $1, $2, 'masivo-' || g, '5219' || lpad(g::text, 8, '0'), 'Cliente ' || g, now() - (g || ' seconds')::interval FROM generate_series(1, 2300) g`,
    [h.accountId, ch],
  );
  const { rows } = await csv(h.authed, `/api/export/contacts.csv?account_id=${h.accountId}`);
  const phones = col(rows, 'telefono');
  const inDb = (await pool.query(`SELECT count(*)::int AS n FROM contacts c JOIN channels ch ON ch.id = c.channel_id WHERE c.account_id = $1 AND ch.type <> 'playground'`, [h.accountId])).rows[0].n;
  assert.equal(new Set(phones).size, phones.length, 'sin duplicados');
  assert.equal(phones.length, inDb, 'todas las filas de la base');
  assert.ok(inDb >= 2302);
});

t('permisos: solo administradores de la cuenta; otra cuenta no ve nada de esta', async () => {
  // Un agente no exporta
  await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'agente@export.mx', password: 'clave-agente-1', role: 'agent' });
  const agent = await h.loginAs('agente@export.mx', 'clave-agente-1');
  assert.equal((await agent('GET', '/api/export/contacts.csv')).statusCode, 403);
  // El administrador de otra cuenta solo recibe lo suyo (aunque pida ?account_id= ajeno)
  const other = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.6.6.6', payload: { name: 'Otro', company: 'Otro negocio', business_type: 'otro', email: 'otro@export.mx', password: 'clave-otro-123', accept_terms: true } });
  const cookie = String(other.headers['set-cookie']).split(';')[0];
  const api = (m: string, u: string) => h.app.inject({ method: m as any, url: u, headers: { cookie } });
  const mine = await api('GET', `/api/export/contacts.csv?account_id=${h.accountId}`);
  assert.equal(mine.statusCode, 200);
  assert.equal(parseCsv(mine.body.slice(1)).length, 1, 'solo el encabezado: nada de la otra cuenta');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/export/contacts.csv' })).statusCode, 401);
  // Las exportaciones quedan en el registro
  const log = await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE message LIKE 'Exportación CSV%' AND account_id = $1`, [h.accountId]);
  assert.ok(log.rows[0].n >= 3);
});
