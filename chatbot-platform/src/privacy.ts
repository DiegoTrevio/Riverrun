/**
 * Privacidad: derechos de las personas (acceso/portabilidad y supresión) y retención automática de datos.
 */
import { query, queryOne, withTransaction } from './db.js';
import { removeInboundFiles } from './channels/media.js';
import { logEvent } from './logs.js';
import * as astore from './automation/store.js';

/** Todo lo que el sistema guarda de un contacto, listo para entregárselo (acceso / portabilidad). */
export async function contactDataExport(contactId: string) {
  const contact = await queryOne<any>(
    `SELECT c.id, c.name, c.push_name, c.phone, c.external_id, c.data, c.notes, c.tags, c.opted_out, c.opted_out_at, c.consent_at, c.consent_source, c.created_at, ch.name AS channel, ch.type AS channel_type
       FROM contacts c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`,
    [contactId],
  );
  if (!contact) return null;
  const conversations = await query<any>(`SELECT id, status, handoff_reason, summary, data, created_at, last_message_at FROM conversations WHERE contact_id = $1 ORDER BY created_at`, [contactId]);
  const messages = await query<any>(
    `SELECT m.conversation_id, m.created_at, m.direction, m.sender, m.type, m.content FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.contact_id = $1 ORDER BY m.id`,
    [contactId],
  );
  const appointments = await query<any>(`SELECT service_name, kind, starts_at, ends_at, status, customer_name, customer_phone, notes FROM appointments WHERE contact_id = $1 ORDER BY starts_at`, [contactId]).catch(() => []);
  const tasks = await query<any>(`SELECT kind, body, status, to_char(due_on, 'YYYY-MM-DD') AS due_on, created_via, created_at, done_at FROM contact_tasks WHERE contact_id = $1 ORDER BY created_at`, [contactId]);
  return { generated_at: new Date().toISOString(), contact, conversations, messages, appointments, tasks };
}

/**
 * Supresión: borra al contacto y todo lo que cuelga de él (conversaciones, mensajes, inscripciones, tareas pendientes,
 * registros con su contenido). Las citas se anonimizan; el consumo de IA se conserva sin contenido (es contabilidad).
 */
export async function eraseContact(contactId: string, guard: { accountId?: string; inactiveSince?: Date } = {}): Promise<{ conversations: number; messages: number } | null> {
  const erased = await withTransaction(async (client) => {
    const contact = (await client.query<{ id: string; account_id: string; channel_id: string; external_id: string }>(`SELECT id, account_id, channel_id, external_id FROM contacts WHERE id = $1 FOR UPDATE`, [contactId])).rows[0];
    if (!contact || (guard.accountId && contact.account_id !== guard.accountId)) return null;
    // Desde la retención: si el contacto volvió a escribir mientras se decidía, no se borra.
    if (guard.inactiveSince && (await client.query(`SELECT 1 FROM conversations WHERE contact_id = $1 AND last_message_at >= $2 LIMIT 1`, [contactId, guard.inactiveSince])).rows.length) return null;
    const convIds = (await client.query<{ id: string }>(`SELECT id FROM conversations WHERE contact_id = $1`, [contactId])).rows.map((r) => r.id);
    const messages = convIds.length ? (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ANY($1)`, [convIds])).rows[0].n : 0;
    if (convIds.length) {
      await client.query(`UPDATE ai_runs SET conversation_id = NULL, decision = NULL, validation = NULL WHERE conversation_id = ANY($1)`, [convIds]);
      await client.query(`UPDATE jobs SET status = 'cancelled' WHERE status = 'pending' AND payload->>'conversation_id' = ANY($1::text[])`, [convIds]);
      await client.query(`DELETE FROM event_logs WHERE conversation_id = ANY($1)`, [convIds]);
    }
    // Entregas de webhooks (pendientes o ya hechas) que llevan sus datos, y el hilo de correo con su dirección.
    await client.query(
      `DELETE FROM jobs WHERE type = 'webhook_delivery' AND account_id = $1 AND (payload->'body'->'data'->'contact'->>'id' = $2 OR payload->'body'->'data'->'conversation'->>'id' = ANY($3::text[]))`,
      [contact.account_id, contactId, convIds],
    );
    await client.query(`DELETE FROM email_threads WHERE channel_id = $1 AND address = lower($2)`, [contact.channel_id, contact.external_id]);
    await client.query(`UPDATE appointments SET customer_name = '', customer_phone = '', notes = '' WHERE contact_id = $1 OR conversation_id = ANY($2)`, [contactId, convIds]);
    // Las rutas de sus archivos se leen antes de borrar el contacto: al borrarlo, esas filas desaparecen con los mensajes.
    const files = convIds.length ? (await client.query<{ file_path: string }>(`SELECT mm.file_path FROM message_media mm JOIN messages m ON m.id = mm.message_id WHERE m.conversation_id = ANY($1)`, [convIds])).rows.map((r) => r.file_path) : [];
    await client.query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
    return { conversations: convIds.length, messages, files };
  });
  if (!erased) return null;
  // Los archivos se borran del disco solo después de confirmar la transacción.
  await removeInboundFiles(erased.files);
  return { conversations: erased.conversations, messages: erased.messages };
}

/**
 * Retención por cuenta (Ajustes → Privacidad): borra mensajes viejos y, si se pide, contactos inactivos sin citas futuras.
 * Devuelve cuántos se borraron. Idempotente; se ejecuta periódicamente.
 */
export async function applyRetention(now = new Date()): Promise<{ accounts: number; messages: number; contacts: number }> {
  await query(`DELETE FROM webhook_deliveries WHERE created_at < $1`, [new Date(now.getTime() - 30 * 86400_000)]); // la bitácora de entregas dura 30 días
  const accounts = await query<{ id: string; name: string; settings: unknown }>(`SELECT id, name, settings FROM accounts WHERE active`);
  let messagesDeleted = 0, contactsDeleted = 0, touched = 0;
  for (const a of accounts) {
    try {
    const s = (a.settings ?? {}) as { retention?: { messages_days?: number; inactive_contacts_days?: number } };
    const days = s.retention?.messages_days ?? 0;
    const inactive = s.retention?.inactive_contacts_days ?? 0;
    if (!days && !inactive) continue;
    let m = 0, c = 0;
    if (days > 0) {
      const cutoff = new Date(now.getTime() - days * 86400_000);
      for (;;) {
        // Las rutas de los archivos se leen en la misma sentencia que borra los mensajes; luego se borran del disco (no quedan archivos huérfanos).
        const [r] = await query<{ deleted: number; files: string[] }>(
          `WITH doomed AS (
             SELECT m.id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.account_id = $1 AND m.created_at < $2 LIMIT 5000
           ), files AS (
             SELECT mm.file_path FROM message_media mm WHERE mm.message_id IN (SELECT id FROM doomed)
           ), gone AS (
             DELETE FROM messages WHERE id IN (SELECT id FROM doomed) RETURNING id
           )
           SELECT (SELECT count(*)::int FROM gone) AS deleted, COALESCE((SELECT array_agg(file_path) FROM files), '{}') AS files`,
          [a.id, cutoff],
        );
        m += r.deleted;
        await removeInboundFiles(r.files);
        if (r.deleted < 5000) break;
      }
      // El resumen y los datos de la conversación también contienen lo que dijo el cliente: se limpian junto con los mensajes.
      await query(`UPDATE conversations SET summary = '', report_summary = '', data = '{}'::jsonb WHERE account_id = $1 AND last_message_at < $2 AND (summary <> '' OR report_summary <> '' OR data <> '{}'::jsonb)`, [a.id, cutoff]);
    }
    if (inactive > 0) {
      const cutoff = new Date(now.getTime() - inactive * 86400_000);
      const old = await query<{ id: string }>(
        `SELECT ct.id FROM contacts ct
          WHERE ct.account_id = $1 AND ct.created_at < $2 AND NOT ct.opted_out AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = ct.id AND cv.last_message_at >= $2)
            AND NOT EXISTS (SELECT 1 FROM appointments ap WHERE ap.contact_id = ct.id AND ap.ends_at >= $3)
          LIMIT 2000`,
        [a.id, cutoff, now],
      );
      for (const o of old) if (await eraseContact(o.id, { accountId: a.id, inactiveSince: cutoff })) c++;
    }
    if (m || c) {
      touched++;
      messagesDeleted += m;
      contactsDeleted += c;
      await logEvent({ level: 'info', source: 'system', message: `Retención de datos: ${m} mensajes y ${c} contactos eliminados`, accountId: a.id });
    }
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'system', message: `Retención de datos falló: ${e?.message ?? e}`, accountId: a.id });
    }
  }
  void astore;
  return { accounts: touched, messages: messagesDeleted, contacts: contactsDeleted };
}
