/**
 * Retención (ID-13): borrar el historial de la cuenta es tan delicado como borrar la cuenta. Cambiarla es del dueño, con
 * el código reciente; menos de 30 días no se acepta; y lo que borra más entra 7 días después, con aviso al dueño.
 * Borrar un canal con conversaciones (se van en cascada) también es del dueño con el código.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Api = Awaited<ReturnType<typeof h.loginAs>>;
const { effectiveRetention } = await import('../src/automation/types.js');
const { applyRetention } = await import('../src/privacy.js');
const { outbox } = await import('../src/mailer.js');

const PASS = 'Pz-911-Qx-912-Kv';
let acc: string;
let owner: Api;
let other: Api;
const age = (email: string, minutes: number) =>
  pool.query(`UPDATE user_sessions SET mfa_at = now() - make_interval(mins => $2) WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email, minutes]);
const stored = async () => (await pool.query(`SELECT settings->'retention' AS r FROM accounts WHERE id = $1`, [acc])).rows[0].r;
const setStored = (r: unknown) => pool.query(`UPDATE accounts SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retention}', $2::jsonb) WHERE id = $1`, [acc, JSON.stringify(r)]);
const retention = (messages_days: number, inactive_contacts_days = 0) => ({ retention: { messages_days, inactive_contacts_days } });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  acc = (await h.addAccount({ name: 'Florería Luna', admin: { name: 'Lucía', email: 'lucia@luna.mx', password: PASS } })).id;
  await h.addUser({ account_id: acc, name: 'Omar', email: 'omar@luna.mx', password: PASS, role: 'admin' });
  owner = await h.loginAs('lucia@luna.mx', PASS);
  other = await h.loginAs('omar@luna.mx', PASS);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('un administrador que no es dueño no cambia la retención, pero sí lo demás de Ajustes', async () => {
  const r = await other('PUT', '/api/settings', retention(90));
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(r.json().code, 'owner_only');
  assert.equal((await other('PUT', '/api/settings', { timezone: 'America/Monterrey' })).statusCode, 200, 'la zona horaria sí');
});

t('el dueño sin código reciente no la cambia', async () => {
  await age('lucia@luna.mx', 16);
  assert.equal((await owner('PUT', '/api/settings', retention(90))).json().code, 'step_up');
  await owner('POST', '/api/2fa/step-up', { code: await h.codeFor('lucia@luna.mx') });
});

t('menos de 30 días no se acepta (0 sigue siendo conservar siempre)', async () => {
  for (const days of [1, 7, 29]) {
    assert.equal((await owner('PUT', '/api/settings', retention(days))).statusCode, 400, `${days} días`);
    assert.equal((await owner('PUT', '/api/settings', retention(0, days))).statusCode, 400, `${days} días de contactos`);
  }
});

t('borrar más entra a los 7 días, con aviso al dueño y los valores en la bitácora', async () => {
  const mails = outbox.length;
  const r = await owner('PUT', '/api/settings', retention(90, 365));
  assert.equal(r.statusCode, 200, r.body);
  const saved = await stored();
  assert.equal(saved.messages_days, 0, 'lo vigente no cambia todavía');
  assert.equal(saved.inactive_contacts_days, 0);
  assert.equal(saved.pending.messages_days, 90);
  assert.equal(saved.pending.inactive_contacts_days, 365);
  const due = new Date(saved.pending.effective_at).getTime();
  assert.ok(Math.abs(due - (Date.now() + 7 * 86400_000)) < 60_000, 'en 7 días');
  assert.deepEqual(effectiveRetention(saved, new Date()), { messages_days: 0, inactive_contacts_days: 0 });
  assert.deepEqual(effectiveRetention(saved, new Date(due + 1000)), { messages_days: 90, inactive_contacts_days: 365 });
  const mail = outbox.slice(mails).find((m) => m.to === 'lucia@luna.mx');
  assert.ok(mail, 'aviso al dueño');
  assert.match(mail!.text, /90 días/);
  const log = (await pool.query(`SELECT details FROM event_logs WHERE account_id = $1 AND message LIKE 'Retención%' ORDER BY id DESC LIMIT 1`, [acc])).rows[0];
  assert.equal(log.details.messages_days, 90);
  assert.equal(log.details.inactive_contacts_days, 365);
});

t('el borrado programado se aplica al llegar su fecha, no antes', async () => {
  const saved = await stored();
  await applyRetention(new Date());
  assert.ok((await stored()).pending, 'antes de la fecha sigue pendiente');
  await applyRetention(new Date(new Date(saved.pending.effective_at).getTime() + 1000));
  const now = await stored();
  assert.equal(now.messages_days, 90);
  assert.equal(now.inactive_contacts_days, 365);
  assert.equal(now.pending, null);
});

t('conservar más (o apagarla) entra al momento y cancela lo programado', async () => {
  assert.equal((await owner('PUT', '/api/settings', retention(365, 365))).statusCode, 200);
  assert.deepEqual(await stored(), { messages_days: 365, inactive_contacts_days: 365, pending: null });
  await owner('PUT', '/api/settings', retention(60, 365));
  assert.equal((await stored()).pending.messages_days, 60);
  // Guardar otra cosa (el panel manda lo programado tal como lo leyó) no lo toca; cancelarlo lo puede cualquier administrador.
  const shown = (await other('GET', '/api/settings')).json();
  assert.equal((await other('PUT', '/api/settings', { ...shown, timezone: 'America/Cancun' })).statusCode, 200);
  assert.equal((await stored()).pending.messages_days, 60);
  assert.equal((await other('PUT', '/api/settings', { retention: { ...shown.retention, pending: null } })).statusCode, 200);
  assert.deepEqual(await stored(), { messages_days: 365, inactive_contacts_days: 365, pending: null });
  await owner('PUT', '/api/settings', retention(60, 365));
  assert.equal((await owner('PUT', '/api/settings', retention(0, 0))).statusCode, 200);
  assert.deepEqual(await stored(), { messages_days: 0, inactive_contacts_days: 0, pending: null });
});

t('lo programado no se puede mandar desde fuera', async () => {
  const r = await other('PUT', '/api/settings', { retention: { messages_days: 0, inactive_contacts_days: 0, pending: { messages_days: 30, inactive_contacts_days: 30, effective_at: '2020-01-01T00:00:00.000Z' } } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await stored()).pending, null);
});

t('lo de antes de 30 días que ya estaba guardado se lee igual, y la migración 098 lo sube a 30 y lo anota', async () => {
  await setStored({ messages_days: 5, inactive_contacts_days: 0 });
  assert.deepEqual(effectiveRetention(await stored(), new Date()), { messages_days: 5, inactive_contacts_days: 0 });
  assert.equal((await other('PUT', '/api/settings', { timezone: 'America/Mexico_City' })).statusCode, 200, 'guardar otra cosa no choca con lo viejo');
  const sql = fs.readFileSync('migrations/098_retention_floor.sql', 'utf8');
  await pool.query(sql);
  await pool.query(sql);
  assert.deepEqual(await stored(), { messages_days: 30, inactive_contacts_days: 0, pending: null });
  const logs = (await pool.query(`SELECT details FROM event_logs WHERE account_id = $1 AND message = 'Retención de datos subida al mínimo de 30 días'`, [acc])).rows;
  assert.deepEqual(logs.map((l) => l.details.messages_days), [5], 'una sola nota, con el valor de antes');
  await setStored({ messages_days: 0, inactive_contacts_days: 0, pending: null });
});

t('borrar un canal con conversaciones es del dueño con el código; uno vacío, de cualquier administrador', async () => {
  const mk = async (name: string) => (await owner('POST', '/api/channels', { account_id: acc, type: 'webchat', name, config: {} })).json().id as string;
  const full = await mk('Chat con historial');
  const empty = await mk('Chat vacío');
  const contact = (await pool.query(`INSERT INTO contacts (account_id, channel_id, external_id) VALUES ($1, $2, 'v-1') RETURNING id`, [acc, full])).rows[0].id;
  await pool.query(`INSERT INTO conversations (account_id, channel_id, contact_id) VALUES ($1, $2, $3)`, [acc, full, contact]);
  assert.equal((await other('DELETE', `/api/channels/${full}`)).json().code, 'owner_only');
  await age('lucia@luna.mx', 16);
  assert.equal((await owner('DELETE', `/api/channels/${full}`)).json().code, 'step_up');
  assert.equal((await other('DELETE', `/api/channels/${empty}`)).statusCode, 200, 'el vacío, cualquiera');
  await owner('POST', '/api/2fa/step-up', { code: await h.codeFor('lucia@luna.mx') });
  assert.equal((await owner('DELETE', `/api/channels/${full}`)).statusCode, 200);
});
