/** Contratos que sostienen los recorridos UX: atomicidad, páginas, permisos y zona horaria. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';
import { DataFieldSchema } from '../src/types.js';
import { buildAgent, WizardSchema } from '../src/templates/agent-builder.js';

const available = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !available && 'PostgreSQL aislado no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
before(async () => { if (available) { h = await createHarness(); await h.createBot(); } });
after(async () => { await h?.app.close(); await pool.end(); });

t('la importación revisada es atómica y conserva la edición sin volver a llamar a IA', async () => {
  const url = `/api/chatbots/${h.botId}/knowledge/import-reviewed`;
  const initial = { sections: { catalog: 'Taco $25', hours: 'Horario anterior' } };
  let response = await h.authed('POST', url, initial);
  assert.equal(response.statusCode, 200, response.body);
  const before = (await h.authed('GET', `/api/chatbots/${h.botId}/knowledge`)).json();
  const calls = h.calls.length;
  await pool.query(`CREATE FUNCTION fail_reviewed_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content = 'FALLAR_TRANSACCION' THEN RAISE EXCEPTION 'fallo de prueba'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_reviewed_import BEFORE INSERT OR UPDATE ON knowledge_items FOR EACH ROW EXECUTE FUNCTION fail_reviewed_import()');
  try {
    response = await h.authed('POST', url, { sections: { catalog: 'Taco $30', hours: 'FALLAR_TRANSACCION', faq: 'Nuevo contenido' } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual((await h.authed('GET', `/api/chatbots/${h.botId}/knowledge`)).json(), before);
  } finally { await pool.query('DROP TRIGGER fail_reviewed_import ON knowledge_items'); await pool.query('DROP FUNCTION fail_reviewed_import()'); }
  response = await h.authed('POST', url, { sections: { catalog: 'Taco $30', hours: 'Lunes a viernes' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(h.calls.length, calls);
  const items = (await h.authed('GET', `/api/chatbots/${h.botId}/knowledge`)).json();
  assert.equal(items.length, 2); assert.ok(items.some((i: any) => i.content === 'Taco $30'));
});

t('el guardado revisado verifica permisos, pertenencia y tamaño', async () => {
  const account = (await h.authed('POST', '/api/accounts', { name: 'Otro perfil UX' })).json();
  await h.authed('POST', '/api/users', { account_id: account.id, name: 'Otro admin', email: 'otro-ux@test.mx', role: 'admin', password: 'pruebas123' });
  const other = await h.loginAs('otro-ux@test.mx', 'pruebas123');
  assert.equal((await other('POST', `/api/chatbots/${h.botId}/knowledge/import-reviewed`, { sections: { catalog: 'No permitido' } })).statusCode, 404);
  assert.equal((await h.authed('POST', `/api/chatbots/${h.botId}/knowledge/import-reviewed`, { sections: { catalog: 'x'.repeat(50001) } })).statusCode, 400);
  const selector = (await other('GET', '/api/accounts?view=selector')).json();
  assert.deepEqual(selector.map((a: any) => a.id), [account.id]);
  assert.ok(!Object.hasOwn(selector[0], 'ai_cost_month'));
});

t('el asistente conserva datos elegidos sin imponer preguntas obligatorias', async () => {
  const built = buildAgent(WizardSchema.parse({ company: { name: 'Tacos UX', description: 'Taquería que atiende pedidos con entrega a domicilio.' }, scope: { collect: ['nombre', 'correo', 'personas'], collect_other: 'Zona de entrega\nContraseña de acceso' } }));
  assert.deepEqual(built.data_fields.slice(0, 3).map((f) => f.key), ['nombre', 'correo', 'personas']);
  assert.equal(built.data_fields.length, 4);
  for (const field of built.data_fields) { assert.equal(DataFieldSchema.parse(field).required, false); assert.equal(field.question, ''); }
});

t('la lista mantiene el contrato anterior y pagina 150 conversaciones con fechas empatadas', async () => {
  await pool.query(`WITH contacts AS (INSERT INTO contacts (account_id, channel_id, external_id, phone, name) SELECT $1, $2, 'ux-page-' || n, '555' || n, 'Cliente UX ' || n FROM generate_series(1,150) n RETURNING id) INSERT INTO conversations (account_id, channel_id, chatbot_id, contact_id, last_message_at) SELECT $1, $2, $3, id, '2026-10-10T12:00:00Z' FROM contacts`, [h.accountId, h.channelId, h.botId]);
  const old = await h.authed('GET', '/api/conversations'); assert.equal(old.statusCode, 200, old.body); assert.ok(Array.isArray(old.json())); assert.equal(old.json().length, 100);
  let cursor = ''; const ids = new Set(); let pages = 0;
  do {
    const page = await h.authed('GET', `/api/conversations?page=true&limit=37${cursor ? '&cursor=' + cursor : ''}`);
    assert.equal(page.statusCode, 200, page.body);
    for (const row of page.json().items) { assert.ok(!ids.has(row.id)); ids.add(row.id); }
    cursor = page.json().next_cursor || ''; pages++;
  } while (cursor && pages < 10);
  assert.equal(ids.size, 150); assert.equal(pages, 5);
  assert.equal((await h.authed('GET', '/api/conversations?limit=-1')).statusCode, 400);
  assert.equal((await h.authed('GET', '/api/conversations?page=true&cursor=invalido')).statusCode, 400);
});

t('los cursores conservan microsegundos de PostgreSQL sin perder conversaciones', async () => {
  await pool.query(`WITH ranked AS (SELECT id, row_number() OVER (ORDER BY id) n FROM conversations) UPDATE conversations c SET last_message_at = '2026-10-10T12:00:00Z'::timestamptz + ranked.n * interval '1 microsecond' FROM ranked WHERE c.id = ranked.id`);
  let cursor = ''; const ids = new Set();
  do {
    const response = await h.authed('GET', `/api/conversations?page=true&limit=37${cursor ? '&cursor=' + cursor : ''}`);
    assert.equal(response.statusCode, 200, response.body);
    for (const row of response.json().items) { assert.ok(!ids.has(row.id)); ids.add(row.id); assert.ok(!Object.hasOwn(row, 'page_cursor_at')); }
    cursor = response.json().next_cursor || '';
  } while (cursor && ids.size < 200);
  assert.equal(ids.size, 150);
});

t('se pueden leer 600 mensajes y actualizar entregas sin mensajes nuevos', async () => {
  const conv = (await h.authed('GET', '/api/conversations?limit=1')).json()[0];
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, content) SELECT $1, 'out', 'human', 'Mensaje ' || n FROM generate_series(1,600) n`, [conv.id]);
  const latest = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
  assert.equal(latest.messages.length, 500); assert.equal(latest.has_more_messages, true);
  const older = (await h.authed('GET', `/api/conversations/${conv.id}?before=${latest.messages[0].id}`)).json();
  assert.equal(older.messages.length, 100); assert.equal(older.has_more_messages, false);
  const last = latest.messages.at(-1).id;
  await pool.query("UPDATE messages SET status = 'failed' WHERE id = $1", [last]);
  const incremental = (await h.authed('GET', `/api/conversations/${conv.id}?after=${last}&watch=${last}`)).json();
  assert.equal(incremental.messages_incremental, true); assert.equal(incremental.messages.length, 1); assert.equal(incremental.messages[0].status, 'failed');
});

t('la lectura incremental no omite mensajes tras más de 500 novedades', async () => {
  const conv = (await h.authed('GET', '/api/conversations?limit=1')).json()[0];
  let cursor = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().messages.at(-1).id;
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, content) SELECT $1, 'in', 'customer', 'Novedad ' || n FROM generate_series(1,1200) n`, [conv.id]);
  const ids = new Set();
  for (let page = 0; page < 5; page++) {
    const response = await h.authed('GET', `/api/conversations/${conv.id}?after=${cursor}`);
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    for (const message of data.messages) { assert.ok(!ids.has(message.id)); ids.add(message.id); }
    if (!data.has_more_messages) break;
    cursor = data.messages.at(-1).id;
  }
  assert.equal(ids.size, 1200);
});

t('las campañas convierten la hora del negocio y rechazan fechas imposibles', async () => {
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { timezone: 'America/Mexico_City' });
  const response = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, name: 'Prueba de zona', channel_id: h.channelId, message: 'Hola', scheduled_local: '2027-01-12T10:00' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(new Date(response.json().scheduled_at).toISOString(), '2027-01-12T16:00:00.000Z');
  const invalid = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, name: 'Fecha imposible', channel_id: h.channelId, scheduled_local: '2027-02-31T10:00' });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal((await h.authed('POST', '/api/campaigns')).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/campaigns', { account_id: h.accountId, name: 'Hora inválida', channel_id: h.channelId, scheduled_local: false })).statusCode, 400);
});

t('revisar una campaña editada no guarda ni reprograma antes de confirmar', async () => {
  const campaign = (await h.authed('GET', `/api/campaigns?account_id=${h.accountId}`)).json().find((c: any) => c.name === 'Prueba de zona');
  const before = JSON.stringify(campaign);
  const preview = await h.authed('POST', `/api/campaigns/${campaign.id}/preview`, { message: 'Mensaje editado sin guardar', scheduled_local: '2027-02-12T11:00' });
  assert.equal(preview.statusCode, 200, preview.body);
  const after = (await h.authed('GET', `/api/campaigns?account_id=${h.accountId}`)).json().find((c: any) => c.id === campaign.id);
  assert.equal(JSON.stringify(after), before);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'campaign_id' = $1", [campaign.id])).rows[0].n, 0);
});
