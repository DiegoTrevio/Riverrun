/**
 * Consultas a escala (auditoría, PR 5b): contactos filtrados antes de agrupar y paginados por cursor, bandeja ordenada
 * por su índice, un solo orden de candados (contacto y luego conversación), campañas programadas en una sola
 * transacción y cuentas borradas por partes.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { beginRequest, deleteAccount } = await import('../src/store/index.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

/** Un contacto con su conversación, con la última actividad hace `minutes` minutos. */
async function person(phone: string, minutes: number, o: { channel?: string; name?: string; tags?: string[] } = {}) {
  const ct = (await pool.query(`INSERT INTO contacts (account_id, channel_id, external_id, phone, name, tags) VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
    [h.accountId, o.channel ?? h.channelId, phone, o.name ?? `Cliente ${phone.slice(-3)}`, JSON.stringify(o.tags ?? [])])).rows[0].id;
  const cv = (await pool.query(`INSERT INTO conversations (account_id, channel_id, chatbot_id, contact_id, last_message_at) VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5)) RETURNING id`,
    [h.accountId, o.channel ?? h.channelId, h.botId, ct, minutes])).rows[0].id;
  return { contact: ct, conversation: cv };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('contactos: la página siguiente sigue por cursor, sin repetir ni saltar a nadie', async () => {
  for (let i = 0; i < 60; i++) await person(`52155500${String(i).padStart(4, '0')}`, i + 1);
  const first = (await h.authed('GET', `/api/contacts?account_id=${h.accountId}`)).json();
  assert.equal(first.items.length, 50);
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  const second = (await h.authed('GET', `/api/contacts?account_id=${h.accountId}&cursor=${first.next_cursor}`)).json();
  assert.equal(second.items.length, 10);
  assert.equal(second.has_more, false);
  const ids = [...first.items, ...second.items].map((c: any) => c.id);
  assert.equal(new Set(ids).size, 60, 'nadie repetido');
  const times = [...first.items, ...second.items].map((c: any) => new Date(c.last_activity).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'de lo más reciente a lo más antiguo');
  assert.equal((await h.authed('GET', `/api/contacts?account_id=${h.accountId}&cursor=no-es-un-cursor`)).statusCode, 400);
});

t('contactos: el mismo teléfono en dos canales es una persona, y basta con que uno coincida con la búsqueda', async () => {
  const tg = (await pool.query(`INSERT INTO channels (account_id, chatbot_id, type, name, webhook_token, config) VALUES ($1, $2, 'telegram', 'Telegram', 'tok-tg-consultas', '{}') RETURNING id`, [h.accountId, h.botId])).rows[0].id;
  await person('5215599990001', 5, { name: 'Lucía Pérez' });
  await person('5215599990001', 3, { channel: tg, name: 'Lu', tags: ['vip'] });
  const byName = (await h.authed('GET', `/api/contacts?account_id=${h.accountId}&search=Lucía`)).json().items;
  assert.equal(byName.length, 1);
  assert.equal(byName[0].channels, 2, 'los dos registros del mismo teléfono');
  assert.deepEqual(byName[0].tags, ['vip'], 'con las etiquetas de los dos');
  const byTag = (await h.authed('GET', `/api/contacts?account_id=${h.accountId}&tag=vip`)).json().items;
  assert.equal(byTag.length, 1);
  assert.equal(byTag[0].name, 'Lu', 'el nombre del registro más reciente');
});

t('bandeja: ordena por la última actividad y pagina por cursor con el último mensaje de cada conversación', async () => {
  const a = await person('5215588880001', 0);
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, content) VALUES ($1, 'in', 'customer', 'primero'), ($1, 'out', 'bot', 'respuesta')`, [a.conversation]);
  const page1 = (await h.authed('GET', `/api/conversations?account_id=${h.accountId}&page=true&limit=5`)).json();
  assert.equal(page1.items.length, 5);
  assert.equal(page1.items[0].id, a.conversation, 'la más reciente primero');
  assert.equal(page1.items[0].last_message, 'respuesta');
  assert.equal(page1.items[0].last_direction, 'out');
  assert.equal('message_count' in page1.items[0], false);
  const page2 = (await h.authed('GET', `/api/conversations?account_id=${h.accountId}&page=true&limit=5&cursor=${page1.next_cursor}`)).json();
  assert.equal(page2.items.length, 5);
  assert.equal(new Set([...page1.items, ...page2.items].map((c: any) => c.id)).size, 10);
  assert.ok(new Date(page2.items[0].last_message_at) <= new Date(page1.items.at(-1).last_message_at));
});

t('empezar otra solicitud bloquea primero el contacto y luego la conversación (como todo lo demás)', async () => {
  const p = await person('5215577770001', 1);
  const holder = await pool.connect();
  const other = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM contacts WHERE id = $1 FOR UPDATE', [p.contact]);
    const pending = beginRequest(p.conversation, { reason: 'tiempo' });
    await new Promise((r) => setTimeout(r, 300));
    // Mientras espera el contacto, todavía no tiene la conversación: otro proceso la puede tomar (antes, al revés, no).
    await other.query('BEGIN');
    await other.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE NOWAIT', [p.conversation]);
    await other.query('ROLLBACK');
    await holder.query('ROLLBACK');
    assert.equal(await pending, 2, 'y al liberarse el contacto, termina');
  } finally {
    holder.release();
    other.release();
  }
});

t('una campaña que no se puede programar completa no deja nada a medias', async () => {
  for (let i = 0; i < 3; i++) await person(`52155666600${i}`, i + 1, { tags: ['promo'] });
  await pool.query(`UPDATE contacts SET consent_at = now() WHERE tags ? 'promo'`); // aceptaron recibir promociones
  const camp = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Atómica', message: 'Hola', audience: { tags_any: ['promo'] }, rate_per_minute: 60 })).json();
  await pool.query(`CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falla simulada'; END $$`);
  await pool.query(`CREATE TRIGGER test_boom BEFORE INSERT ON jobs FOR EACH ROW WHEN (NEW.type = 'campaign_send') EXECUTE FUNCTION test_boom()`);
  try {
    const r = await h.authed('POST', `/api/campaigns/${camp.id}/launch`);
    assert.ok(r.statusCode >= 400, r.body);
  } finally {
    await pool.query('DROP TRIGGER test_boom ON jobs');
  }
  assert.equal((await pool.query(`SELECT status FROM campaigns WHERE id = $1`, [camp.id])).rows[0].status, 'draft');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1`, [camp.id])).rows[0].n, 0, 'sin destinatarios sueltos');
  // Al volver a lanzarla, cada persona queda programada una sola vez (con su llave).
  assert.equal((await h.authed('POST', `/api/campaigns/${camp.id}/launch`)).json().status, 'sending');
  const jobs = (await pool.query(`SELECT dedupe_key FROM jobs WHERE type = 'campaign_send' AND payload->>'campaign_id' = $1`, [camp.id])).rows;
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((j) => j.dedupe_key.startsWith(`campaign_send:${camp.id}:`)));
  // Aunque el contador de pendientes quede alto (un envío que se perdió), la campaña termina cuando ya no queda nadie.
  await pool.query(`UPDATE campaigns SET stats = stats || '{"pending": 9}' WHERE id = $1`, [camp.id]);
  await h.fastForward();
  const done = (await pool.query(`SELECT status, stats FROM campaigns WHERE id = $1`, [camp.id])).rows[0];
  assert.equal(done.status, 'sent');
  assert.equal(done.stats.pending, 0);
});

t('borrar una cuenta quita primero lo más pesado y luego todo lo demás', async () => {
  const acc = (await pool.query(`INSERT INTO accounts (name) VALUES ('Para borrar') RETURNING id`)).rows[0].id;
  const ch = (await pool.query(`INSERT INTO channels (account_id, type, name, webhook_token, config) VALUES ($1, 'whatsapp', 'WA', 'tok-borrar', '{}') RETURNING id`, [acc])).rows[0].id;
  const ct = (await pool.query(`INSERT INTO contacts (account_id, channel_id, external_id) VALUES ($1, $2, '5215500001234') RETURNING id`, [acc, ch])).rows[0].id;
  const cv = (await pool.query(`INSERT INTO conversations (account_id, channel_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [acc, ch, ct])).rows[0].id;
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, content) SELECT $1, 'in', 'customer', 'm' || g FROM generate_series(1, 30) g`, [cv]);
  await pool.query(`INSERT INTO event_logs (account_id, level, source, message) SELECT $1, 'info', 'system', 'x' FROM generate_series(1, 20)`, [acc]);
  await deleteAccount(acc);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM accounts WHERE id = $1`, [acc])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`, [cv])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM event_logs WHERE account_id = $1`, [acc])).rows[0].n, 0);
});
