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
  assert.deepEqual(await migrate(db), ['002_accounts_channels.sql', '003_automation.sql', '004_signup.sql', '005_flow.sql', '006_whatsapp_qr.sql', '007_activation.sql', '008_image_triggers.sql', '009_master_access.sql', '010_conversation_records.sql', '011_knowledge_vectors.sql', '012_knowledge_index_invalidation.sql', '013_knowledge_supervision.sql', '014_knowledge_source.sql', '015_billing.sql', '016_conversation_lease.sql', '017_limits.sql', '018_compliance.sql', '019_pools.sql', '020_integrations.sql', '021_brands.sql', '022_email.sql', '023_fk_indexes.sql', '024_assignment.sql', '025_report_analysis.sql', '026_flow_journey.sql', '027_data_integrity.sql', '028_inbound_media.sql', '029_analytics.sql', '030_attachments.sql', '031_handoff.sql', '032_contact_tasks.sql', '033_internal_notices.sql', '034_zernio_channel.sql', '035_saved_messages.sql', '036_questions_done.sql', '037_system_state.sql', '038_incidents.sql', '039_incident_alerts.sql', '040_conversation_restart.sql', '041_automation_once.sql', '042_conversation_requests.sql', '043_outlook_calendar.sql', '044_pipelines.sql', '045_team_agenda.sql', '046_durable_processing.sql', '047_agent_versions.sql', '048_contacts_ai_budgets.sql', '049_opportunity_value.sql', '050_work_recovery.sql', '051_alert_reminders.sql', '052_disconnect_reason.sql', '053_meta_connect.sql', '054_platform_secrets.sql', '055_checkout_ref.sql', '056_start_on_connect.sql', '057_zernio_isolation.sql', '058_social_accounts.sql', '059_zernio_events.sql', '060_zernio_admin.sql', '061_whatsapp_templates.sql', '062_team_calls.sql', '063_social_engagement.sql', '064_social_publications.sql', '065_social_stats.sql', '066_flow_buttons.sql', '067_quotes.sql', '068_payments.sql', '069_terms.sql', '070_account_nudges.sql', '071_retention.sql', '072_fiscal.sql', '073_cfdi.sql', '074_invitations.sql', '075_media_library.sql', '076_alert_prefs.sql', '077_alert_deliveries.sql', '078_billing_autopilot.sql', '079_owner_self_service.sql', '080_superadmin_digest.sql', '081_receivables.sql', '082_receivable_origins.sql', '083_contact_fields.sql', '084_security.sql', '085_billing_reliability.sql', '086_alert_receipts.sql', '087_performance_indexes.sql', '088_export_indexes.sql', '089_flow_boards.sql', '090_api_idempotency.sql', '091_webhook_events.sql', '092_copilot.sql', '093_copilot_model.sql', '094_subscription_pending_plan.sql', '095_identity_access.sql', '096_identity_account.sql', '097_signup_card.sql', '098_retention_floor.sql', '099_orphan_api_keys.sql', '100_receivable_approval.sql', '101_platform_ai_cap.sql', '102_cfdi_global_seq.sql', '103_gemini_flash_price.sql', '104_private_plans.sql']);
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
  assert.deepEqual(applied, ['001_init.sql', '002_accounts_channels.sql', '003_automation.sql', '004_signup.sql', '005_flow.sql', '006_whatsapp_qr.sql', '007_activation.sql', '008_image_triggers.sql', '009_master_access.sql', '010_conversation_records.sql', '011_knowledge_vectors.sql', '012_knowledge_index_invalidation.sql', '013_knowledge_supervision.sql', '014_knowledge_source.sql', '015_billing.sql', '016_conversation_lease.sql', '017_limits.sql', '018_compliance.sql', '019_pools.sql', '020_integrations.sql', '021_brands.sql', '022_email.sql', '023_fk_indexes.sql', '024_assignment.sql', '025_report_analysis.sql', '026_flow_journey.sql', '027_data_integrity.sql', '028_inbound_media.sql', '029_analytics.sql', '030_attachments.sql', '031_handoff.sql', '032_contact_tasks.sql', '033_internal_notices.sql', '034_zernio_channel.sql', '035_saved_messages.sql', '036_questions_done.sql', '037_system_state.sql', '038_incidents.sql', '039_incident_alerts.sql', '040_conversation_restart.sql', '041_automation_once.sql', '042_conversation_requests.sql', '043_outlook_calendar.sql', '044_pipelines.sql', '045_team_agenda.sql', '046_durable_processing.sql', '047_agent_versions.sql', '048_contacts_ai_budgets.sql', '049_opportunity_value.sql', '050_work_recovery.sql', '051_alert_reminders.sql', '052_disconnect_reason.sql', '053_meta_connect.sql', '054_platform_secrets.sql', '055_checkout_ref.sql', '056_start_on_connect.sql', '057_zernio_isolation.sql', '058_social_accounts.sql', '059_zernio_events.sql', '060_zernio_admin.sql', '061_whatsapp_templates.sql', '062_team_calls.sql', '063_social_engagement.sql', '064_social_publications.sql', '065_social_stats.sql', '066_flow_buttons.sql', '067_quotes.sql', '068_payments.sql', '069_terms.sql', '070_account_nudges.sql', '071_retention.sql', '072_fiscal.sql', '073_cfdi.sql', '074_invitations.sql', '075_media_library.sql', '076_alert_prefs.sql', '077_alert_deliveries.sql', '078_billing_autopilot.sql', '079_owner_self_service.sql', '080_superadmin_digest.sql', '081_receivables.sql', '082_receivable_origins.sql', '083_contact_fields.sql', '084_security.sql', '085_billing_reliability.sql', '086_alert_receipts.sql', '087_performance_indexes.sql', '088_export_indexes.sql', '089_flow_boards.sql', '090_api_idempotency.sql', '091_webhook_events.sql', '092_copilot.sql', '093_copilot_model.sql', '094_subscription_pending_plan.sql', '095_identity_access.sql', '096_identity_account.sql', '097_signup_card.sql', '098_retention_floor.sql', '099_orphan_api_keys.sql', '100_receivable_approval.sql', '101_platform_ai_cap.sql', '102_cfdi_global_seq.sql', '103_gemini_flash_price.sql', '104_private_plans.sql']);
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
  assert.equal(counts.length, 104);
  assert.ok(counts.every(r => r.n === 1));
});

t('097: las cuentas de antes no cambian y el correo de su dueño ya no da otra prueba', async () => {
  const acc = (await db.query(`INSERT INTO accounts (name, status) VALUES ('De antes', 'active') RETURNING id`)).rows[0].id;
  const owner = (await db.query(`INSERT INTO users (account_id, role, name, email, password_hash) VALUES ($1, 'admin', 'Dueña', 'Dueña.Vieja+tienda@Gmail.com', 'x') RETURNING id`, [acc])).rows[0].id;
  await db.query(`UPDATE accounts SET owner_user_id = $2 WHERE id = $1`, [acc, owner]);
  await db.query(`DELETE FROM schema_migrations WHERE name = '097_signup_card.sql'`);
  assert.deepEqual(await migrate(db), ['097_signup_card.sql'], 'se puede volver a correr');
  assert.equal((await db.query(`SELECT status FROM accounts WHERE id = $1`, [acc])).rows[0].status, 'active');
  const key = (await db.query(`SELECT value FROM system_keys WHERE name = 'trial_claims'`)).rows[0].value as Buffer;
  const digest = (await import('node:crypto')).createHmac('sha256', key).update('email:dueñavieja@gmail.com').digest();
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM trial_claims WHERE kind = 'email' AND digest = $1`, [digest])).rows[0].n, 1, 'marca del correo del dueño');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM system_keys WHERE name = 'trial_claims'`)).rows[0].n, 1, 'una sola llave aunque se vuelva a correr');
});

t('096: dueño, google_sub, created_by y change_email', async () => {
  const col = async (table: string, column: string) => (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column])).rows.length === 1;
  for (const [table, column] of [['users', 'google_sub'], ['webhook_endpoints', 'created_by'], ['auth_tokens', 'email']]) assert.ok(await col(table, column), `${table}.${column}`);
  const acc = (await db.query(`INSERT INTO accounts (name) VALUES ('Sin dueño') RETURNING id`)).rows[0].id;
  const user = (email: string, role: string, age: string) =>
    db.query(`INSERT INTO users (account_id, role, name, email, password_hash, created_at) VALUES ($1, $2, $3, $3, 'x', now() - $4::interval) RETURNING id`, [acc, role, email, age]).then((r) => r.rows[0].id);
  await user('agente@m96.mx', 'agent', '3 days');
  const oldest = await user('primera@m96.mx', 'admin', '2 days');
  await user('segunda@m96.mx', 'admin', '1 day');
  await db.query(`UPDATE users SET google_sub = 'sub-1' WHERE email = 'primera@m96.mx'`);
  await assert.rejects(db.query(`UPDATE users SET google_sub = 'sub-1' WHERE email = 'segunda@m96.mx'`), (e: any) => e.code === '23505');
  await db.query(`INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, email) VALUES ($1, 'change_email', 'h96', now() + interval '1 day', 'nuevo@m96.mx')`, [oldest]);
  await db.query(`DELETE FROM schema_migrations WHERE name = '096_identity_account.sql'`);
  assert.deepEqual(await migrate(db), ['096_identity_account.sql'], 'se puede volver a correr');
  assert.equal((await db.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [acc])).rows[0].owner_user_id, oldest, 'la cuenta sin dueño toma al administrador activo más antiguo');
});

t('095: columnas y tablas de identidad', async () => {
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE ANY (ARRAY['totp%', 'mfa%'])`)).rows.map((r) => r.column_name).sort();
  assert.deepEqual(cols, ['mfa_locked_until', 'totp_enabled_at', 'totp_last_step', 'totp_pending', 'totp_pending_at', 'totp_secret']);
  for (const table of ['user_recovery_codes', 'user_devices', 'rate_limits']) assert.ok((await db.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t, table);
  assert.ok((await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'mfa_at'`)).rows.length);
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

t('sube desde la versión 054 con redes de Zernio, flujos y campañas sin perder datos ni conservar el canal equivocado', async () => {
  // Base nueva hasta la 054 (lo que hay en producción antes de este cambio), con datos reales.
  const name = `${dbName}_054`;
  await pool.query(`DROP DATABASE IF EXISTS ${name}`);
  await pool.query(`CREATE DATABASE ${name}`);
  const up = new pg.Pool({ connectionString: new URL(`/${name}`, base).href });
  try {
    await up.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await up.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const f of fs.readdirSync(path.resolve('migrations')).filter((x) => x.endsWith('.sql') && x < '055').sort()) {
      await up.query(fs.readFileSync(path.resolve('migrations', f), 'utf8'));
      await up.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    }
    const q = async (sql: string, params: unknown[] = []) => (await up.query(sql, params)).rows;
    const [a] = await q(`INSERT INTO accounts (name, zernio_profile_id) VALUES ('Hotel A', 'prof_a') RETURNING id`);
    const [b] = await q(`INSERT INTO accounts (name, zernio_profile_id) VALUES ('Tienda B', 'prof_b') RETURNING id`);
    // Dos canales con la misma cuenta de Zernio: el más antiguo no guardó su perfil; el otro es del perfil del negocio.
    const [old] = await q(`INSERT INTO channels (account_id, type, name, webhook_token, config, created_at) VALUES ($1, 'zernio', 'IG viejo', 'tok-old', $2, now() - interval '2 days') RETURNING id`,
      [a.id, JSON.stringify({ platform: 'instagram', account_id: 'acc_dup', username: 'viejo' })]);
    const [mine] = await q(`INSERT INTO channels (account_id, type, name, webhook_token, config) VALUES ($1, 'zernio', 'IG del hotel', 'tok-mine', $2) RETURNING id`,
      [a.id, JSON.stringify({ platform: 'instagram', account_id: 'acc_dup', profile_id: 'prof_a', username: 'hotel' })]);
    const [down] = await q(`INSERT INTO channels (account_id, type, name, webhook_token, config, connection_state) VALUES ($1, 'zernio', 'FB tienda', 'tok-b', $2, 'close') RETURNING id`,
      [b.id, JSON.stringify({ platform: 'facebook', account_id: 'acc_b', profile_id: 'prof_b', username: 'tienda' })]);
    const [seq] = await q(`INSERT INTO sequences (account_id, name, steps) VALUES ($1, 'Seguimiento', $2) RETURNING id`, [a.id, JSON.stringify([{ delay_value: 0, delay_unit: 'minutes', text: 'Hola' }])]);
    const [wa] = await q(`INSERT INTO channels (account_id, type, name, webhook_token, config) VALUES ($1, 'whatsapp', 'WA', 'tok-wa', '{}') RETURNING id`, [a.id]);
    const [ct] = await q(`INSERT INTO contacts (account_id, channel_id, external_id) VALUES ($1, $2, '5215500000001') RETURNING id`, [a.id, wa.id]);
    const [cv] = await q(`INSERT INTO conversations (account_id, channel_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [a.id, wa.id, ct.id]);
    await q(`INSERT INTO sequence_enrollments (account_id, sequence_id, conversation_id, current_step) VALUES ($1, $2, $3, 1)`, [a.id, seq.id, cv.id]);
    await q(`INSERT INTO campaigns (account_id, channel_id, name, message) VALUES ($1, $2, 'Promo', 'Hola')`, [a.id, wa.id]);

    const applied = await migrate(up);
    assert.equal(applied[0], '055_checkout_ref.sql');
    assert.equal(applied.at(-1), '104_private_plans.sql');
    const chans = Object.fromEntries((await q(`SELECT id, config->>'account_id' AS zid, connection_state, disconnect_reason FROM channels WHERE type = 'zernio'`)).map((r) => [r.id, r]));
    assert.equal(chans[mine.id].zid, 'acc_dup', 'se conserva el canal del perfil del negocio');
    assert.deepEqual([chans[old.id].zid, chans[old.id].connection_state, chans[old.id].disconnect_reason], ['', 'close', 'zernio_duplicate'], 'el duplicado queda sin cuenta');
    const socials = await q(`SELECT account_id, zernio_account_id, channel_id, status, down_notified_at FROM social_accounts ORDER BY zernio_account_id`);
    assert.deepEqual(socials.map((s) => [s.account_id, s.zernio_account_id, s.channel_id, s.status]), [[b.id, 'acc_b', down.id, 'needs_reconnect'], [a.id, 'acc_dup', mine.id, 'active']]);
    assert.ok(socials[0].down_notified_at, 'una red ya caída no vuelve a avisar al actualizar');
    assert.deepEqual((await q(`SELECT profile_id, account_id FROM zernio_profiles ORDER BY profile_id`)).map((p) => [p.profile_id, p.account_id]), [['prof_a', a.id], ['prof_b', b.id]]);
    assert.deepEqual((await q(`SELECT kind, sequence_id FROM campaigns`))[0], { kind: 'message', sequence_id: null });
    assert.deepEqual((await q(`SELECT current_step, choice, choice_step, campaign_id, pace_ms FROM sequence_enrollments`))[0], { current_step: 1, choice: '', choice_step: null, campaign_id: null, pace_ms: 0 });
    assert.deepEqual(await migrate(up), [], 'volver a ejecutar no hace nada');
  } finally {
    await up.end();
    await pool.query(`DROP DATABASE IF EXISTS ${name}`);
  }
});
