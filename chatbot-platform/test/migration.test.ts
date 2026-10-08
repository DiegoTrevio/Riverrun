/** La migración 002 convierte una instalación existente (un chatbot = un WhatsApp) sin perder datos. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { dbAvailable, migrate, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const base = new URL(process.env.DATABASE_URL!);
const dbName = `${base.pathname.slice(1)}_migration`;
let db: pg.Pool;

before(async () => {
  if (!ok) return;
  await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await pool.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  db = new pg.Pool({ connectionString: url.toString() });
  // Esquema v1 tal como estaba instalado
  await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await db.query(fs.readFileSync(path.resolve('migrations/001_init.sql'), 'utf8'));
  await db.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`INSERT INTO schema_migrations(name) VALUES ('001_init.sql')`);
  // Datos v1: un chatbot con WhatsApp, conversaciones, simulador, imagen, uso de IA y registros; otro sin WhatsApp
  const bot = (await db.query(`INSERT INTO chatbots (name, active, whatsapp_number, evolution_instance, evolution_api_key, webhook_token, personality)
    VALUES ('Hotel', true, '5215500000000', 'hotel', 'KEY', 'TOKEN-HOTEL', '{"prompt":"Eres recepcionista"}') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO chatbots (name, webhook_token) VALUES ('Borrador', 'TOKEN-BORRADOR')`);
  const img = (await db.query(`INSERT INTO images (chatbot_id, code, name, file_path, mime_type) VALUES ($1,'suite','Suite','x.png','image/png') RETURNING id`, [bot])).rows[0].id;
  const wa = (await db.query(`INSERT INTO contacts (chatbot_id, jid, phone, name, data, channel) VALUES ($1,'521550@s.whatsapp.net','521550','Ana','{"correo":"ana@mail.com"}','whatsapp') RETURNING id`, [bot])).rows[0].id;
  const pgc = (await db.query(`INSERT INTO contacts (chatbot_id, jid, channel) VALUES ($1,'playground:abc','playground') RETURNING id`, [bot])).rows[0].id;
  const c1 = (await db.query(`INSERT INTO conversations (chatbot_id, contact_id, status, summary) VALUES ($1,$2,'human','Ana quiere la suite') RETURNING id`, [bot, wa])).rows[0].id;
  const c2 = (await db.query(`INSERT INTO conversations (chatbot_id, contact_id) VALUES ($1,$2) RETURNING id`, [bot, pgc])).rows[0].id;
  await db.query(`INSERT INTO messages (conversation_id, direction, sender, content, evolution_message_id) VALUES ($1,'in','customer','hola','EV1'), ($1,'out','bot','Hola Ana',NULL)`, [c1]);
  await db.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, image_id) VALUES ($1,'out','bot','image','',$2)`, [c2, img]);
  await db.query(`INSERT INTO ai_runs (chatbot_id, conversation_id, model, input_tokens) VALUES ($1,$2,'gpt',100)`, [bot, c1]);
  await db.query(`INSERT INTO event_logs (chatbot_id, level, source, message) VALUES ($1,'info','engine','x'), (NULL,'info','system','arranque')`, [bot]);
});

after(async () => {
  if (db) await db.end();
  if (ok) await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await pool.end();
});

t('migra una instalación existente sin perder datos', async () => {
  assert.deepEqual(await migrate(db), ['002_accounts_channels.sql', '003_automation.sql', '004_signup.sql', '005_flow.sql', '006_whatsapp_qr.sql', '007_activation.sql', '008_image_triggers.sql', '009_master_access.sql', '010_conversation_records.sql', '011_knowledge_vectors.sql', '012_knowledge_index_invalidation.sql', '013_knowledge_supervision.sql', '014_knowledge_source.sql', '015_billing.sql', '016_conversation_lease.sql', '017_limits.sql', '018_compliance.sql', '019_pools.sql', '020_integrations.sql', '021_brands.sql', '022_email.sql', '023_fk_indexes.sql', '024_assignment.sql', '025_report_analysis.sql', '026_flow_journey.sql', '027_data_integrity.sql', '028_inbound_media.sql']);
  const q = async (sql: string) => (await db.query(sql)).rows;

  const accounts = await q('SELECT * FROM accounts');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, 'Cuenta principal');
  assert.equal(accounts[0].status, 'active', 'las cuentas existentes no entran a prueba');
  assert.equal((await q(`SELECT count(*)::int n FROM users WHERE email_verified_at IS NULL`))[0].n, 0, 'los usuarios existentes quedan verificados');
  const acc = accounts[0].id;
  assert.equal((await q(`SELECT count(*)::int n FROM chatbots WHERE account_id = '${acc}'`))[0].n, 2);

  const channels = await q(`SELECT c.*, b.name AS bot FROM channels c JOIN chatbots b ON b.id = c.chatbot_id ORDER BY c.type DESC`);
  assert.equal(channels.length, 2, 'WhatsApp del hotel + simulador; el borrador sin WhatsApp no genera canal');
  const wa = channels.find((c) => c.type === 'whatsapp');
  assert.equal(wa.bot, 'Hotel');
  assert.equal(wa.webhook_token, 'TOKEN-HOTEL', 'la URL del webhook en Evolution sigue funcionando');
  assert.deepEqual(wa.config, { instance: 'hotel', api_key: 'KEY', number: '5215500000000' });

  const contacts = await q(`SELECT ct.external_id, ct.data, ct.name, ch.type FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id ORDER BY ch.type DESC`);
  assert.deepEqual(contacts.map((c) => [c.type, c.external_id]), [['whatsapp', '521550@s.whatsapp.net'], ['playground', 'playground:abc']]);
  assert.deepEqual(contacts[0].data, { correo: 'ana@mail.com' });

  const convs = await q(`SELECT cv.status, cv.summary, cv.account_id, ch.type FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id ORDER BY ch.type DESC`);
  assert.equal(convs[0].status, 'human');
  assert.equal(convs[0].summary, 'Ana quiere la suite');
  assert.ok(convs.every((c) => c.account_id === acc));

  assert.deepEqual((await q(`SELECT external_message_id FROM messages WHERE content = 'hola'`))[0], { external_message_id: 'EV1' });
  assert.equal((await q('SELECT count(*)::int n FROM messages'))[0].n, 3);
  assert.equal((await q(`SELECT account_id FROM ai_runs`))[0].account_id, acc);
  const logs = await q(`SELECT account_id FROM event_logs ORDER BY id`);
  assert.equal(logs[0].account_id, acc);
  assert.equal(logs[1].account_id, null, 'los registros del sistema no pertenecen a una cuenta');

  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'chatbots'`)).map((r) => r.column_name);
  for (const gone of ['evolution_instance', 'evolution_api_key', 'webhook_token', 'whatsapp_number']) assert.ok(!cols.includes(gone), gone);
  assert.deepEqual(await migrate(db), [], 'volver a ejecutar no hace nada');
});

t('una instalación nueva (sin datos) migra sin crear cuentas vacías', async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const applied = await migrate(db);
  assert.deepEqual(applied, ['001_init.sql', '002_accounts_channels.sql', '003_automation.sql', '004_signup.sql', '005_flow.sql', '006_whatsapp_qr.sql', '007_activation.sql', '008_image_triggers.sql', '009_master_access.sql', '010_conversation_records.sql', '011_knowledge_vectors.sql', '012_knowledge_index_invalidation.sql', '013_knowledge_supervision.sql', '014_knowledge_source.sql', '015_billing.sql', '016_conversation_lease.sql', '017_limits.sql', '018_compliance.sql', '019_pools.sql', '020_integrations.sql', '021_brands.sql', '022_email.sql', '023_fk_indexes.sql', '024_assignment.sql', '025_report_analysis.sql', '026_flow_journey.sql', '027_data_integrity.sql', '028_inbound_media.sql']);
  assert.equal((await db.query('SELECT count(*)::int n FROM accounts')).rows[0].n, 0);
  // Integridad: nada sin llave primaria, nada sin validar y toda llave foránea de una columna con índice (borrar cuentas no recorre tablas enteras)
  const noPk = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')`)).rows;
  assert.deepEqual(noPk, [], 'tablas sin llave primaria');
  assert.deepEqual((await db.query(`SELECT conname FROM pg_constraint WHERE NOT convalidated`)).rows, [], 'restricciones sin validar');
  const noIdx = (await db.query(`SELECT c.conrelid::regclass || '.' || a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`)).rows.map((r) => r.col);
  assert.deepEqual(noIdx, [], 'llaves foráneas sin índice');
});

t('varias réplicas pueden migrar simultáneamente una instalación nueva', async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => migrate(db)));
  assert.ok(results.every(r => r.status === 'fulfilled'), JSON.stringify(results));
  const counts = (await db.query('SELECT name, count(*)::int n FROM schema_migrations GROUP BY name')).rows;
  assert.equal(counts.length, 28);
  assert.ok(counts.every(r => r.n === 1));
});

t('una migración fallida revierte el esquema y libera el bloqueo para otra réplica', async () => {
  await db.query(`DELETE FROM schema_migrations WHERE name = '013_knowledge_supervision.sql';
    DROP TABLE knowledge_monitor_state, knowledge_monitor_samples, knowledge_alerts;
    DROP INDEX knowledge_events_monitor_idx;
    CREATE FUNCTION fail_migration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated migration failure'; END $$;
    CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION fail_migration();`);
  await assert.rejects(migrate(db), /simulated migration failure/);
  assert.equal((await db.query("SELECT to_regclass('knowledge_alerts') AS relation")).rows[0].relation, null);
  await db.query('DROP TRIGGER fail_migration ON schema_migrations; DROP FUNCTION fail_migration();');
  const replica = new pg.Pool({ connectionString: new URL(`/${dbName}`, base).href, max: 1, options: '-c lock_timeout=2000' });
  try {
    assert.deepEqual(await migrate(replica), ['013_knowledge_supervision.sql']);
    assert.deepEqual(await migrate(replica), []);
  } finally { await replica.end(); }
});
