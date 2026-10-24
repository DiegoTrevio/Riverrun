/**
 * El dueño de la cuenta se atiende solo: descarga todos sus datos (ZIP) y borra su cuenta.
 * Borrar se pide desde el panel (escribiendo el nombre de la cuenta), se confirma con el enlace que llega al correo del
 * dueño y se ejecuta 7 días después; mientras tanto se puede cancelar. Al confirmar, el plan deja de renovarse.
 */
import PizZip from 'pizzip';
import { mailBrand } from '../brands.js';
import { providers, getSubscription, queueAction } from '../billing/service.js';
import { alertSuperadmins } from '../billing/ledger.js';
import { query, queryOne } from '../db.js';
import { csvRow } from '../export.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { hmac, safeEqual } from '../secret.js';
import * as store from '../store/index.js';
import type { Account, User } from '../types.js';
import { deleteAccountFully } from './delete.js';

const DAY = 86400_000;
/** Días entre la confirmación y el borrado (para arrepentirse). */
export const DELETION_GRACE_DAYS = 7;
/** Vigencia del enlace de confirmación que llega por correo. */
const LINK_MS = DAY;
const fmt = (d: Date) => d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

/** El dueño de la cuenta: quien la creó o, si ya no está, su administrador más antiguo. */
export async function ownerOf(acc: Pick<Account, 'id' | 'owner_user_id'>) {
  return queryOne<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM users WHERE (id = $1 AND account_id = $2) OR (account_id = $2 AND role = 'admin' AND active) ORDER BY (id = $1) DESC, created_at LIMIT 1`,
    [acc.owner_user_id, acc.id],
  );
}

export async function isOwner(user: Pick<User, 'id' | 'role' | 'account_id'>, acc: Pick<Account, 'id' | 'owner_user_id'>) {
  if (user.role !== 'admin' || user.account_id !== acc.id) return false;
  return (await ownerOf(acc))?.id === user.id;
}

/* ------------------------------ Borrar la cuenta ------------------------------ */

/** Enlace firmado para confirmar el borrado: cuenta y vencimiento, con HMAC. */
export function deletionToken(accountId: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ a: accountId, exp: now + LINK_MS })).toString('base64url');
  return `${payload}.${hmac(`account-delete:${payload}`)}`;
}

/** Cuenta del enlace si es auténtico y vigente; null si no. */
export function readDeletionToken(token: string, now = Date.now()): string | null {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(`account-delete:${payload}`))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof d.a === 'string' && typeof d.exp === 'number' && d.exp > now ? d.a : null;
  } catch {
    return null;
  }
}

/** Primer paso: manda al correo del dueño el enlace para confirmar. No cambia nada todavía. */
export async function requestDeletion(acc: Account, owner: { email: string; name: string }) {
  const mb = await mailBrand(acc.id);
  const link = `${mb.base}/borrar-cuenta?t=${encodeURIComponent(deletionToken(acc.id))}`;
  await sendMail({
    fromName: mb.fromName,
    to: owner.email,
    subject: `Confirma que quieres borrar "${acc.name}"`,
    text: `Hola ${owner.name || ''},\n\nPediste borrar tu cuenta "${acc.name}". Para confirmarlo abre este enlace (vence en 24 horas):\n${link}\n\nAl confirmar, tu plan deja de renovarse y la cuenta se borra ${DELETION_GRACE_DAYS} días después: tu agente, sus conexiones, tus contactos y tus conversaciones. Hasta entonces puedes cancelarlo desde tu panel. Si no fuiste tú, ignora este correo: no se borrará nada.\n\nAntes de borrarla puedes descargar todos tus datos en Mi plan y pagos → Tus datos.`,
  });
  await logEvent({ level: 'warn', source: 'admin', message: `Se pidió borrar la cuenta (confirmación enviada a ${owner.email})`, accountId: acc.id });
}

/**
 * Segundo paso (desde el enlace del correo): queda programado el borrado y el plan deja de renovarse. Repetirlo no
 * cambia la fecha. Devuelve la fecha del borrado (null si la cuenta ya no existe).
 */
export async function scheduleDeletion(accountId: string, now = new Date()): Promise<Date | null> {
  const row = await queryOne<{ deletion_scheduled_for: Date; name: string; fresh: boolean }>(
    `UPDATE accounts SET deletion_requested_at = COALESCE(deletion_requested_at, $2), deletion_scheduled_for = COALESCE(deletion_scheduled_for, $3), updated_at = now()
     WHERE id = $1 RETURNING deletion_scheduled_for, name, (deletion_requested_at = $2) AS fresh`,
    [accountId, now, new Date(now.getTime() + DELETION_GRACE_DAYS * DAY)],
  );
  if (!row) return null;
  if (!row.fresh) return row.deletion_scheduled_for;
  // Que no se cobre otro periodo de una cuenta que se va a borrar.
  const sub = await getSubscription(accountId);
  if (sub?.provider_subscription_id && ['active', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end) {
    try {
      await providers[sub.provider].setCancelAtPeriodEnd(sub, true);
    } catch (e: any) {
      await logEvent({ level: 'warn', source: 'admin', message: `No se pudo detener la renovación al pedir el borrado, se reintenta: ${e?.message ?? e}`, accountId });
      await queueAction({ provider: sub.provider, kind: 'cancel', ref: sub.provider_subscription_id, accountId, reason: 'deleted' });
    }
    await query(`UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE account_id = $1`, [accountId]);
  }
  const acc = await store.getAccount(accountId);
  const owner = acc ? await ownerOf(acc) : null;
  if (owner) {
    const mb = await mailBrand(accountId);
    await sendMail({
      fromName: mb.fromName, to: owner.email, subject: `"${row.name}" se borrará el ${fmt(row.deletion_scheduled_for)}`,
      text: `Confirmaste borrar tu cuenta "${row.name}". Se borrará el ${fmt(row.deletion_scheduled_for)} y tu plan ya no se renovará.\n\nSi cambias de opinión, entra a tu panel antes de esa fecha y pulsa «Cancelar el borrado»:\n${mb.base}/#/plan`,
    });
  }
  await logEvent({ level: 'warn', source: 'admin', message: `Borrado de la cuenta confirmado: se borra el ${fmt(row.deletion_scheduled_for)}`, accountId });
  return row.deletion_scheduled_for;
}

/** Cancela un borrado programado. Stripe vuelve a renovar; en Mercado Pago (que no reanuda) se vuelve a contratar. */
export async function cancelDeletion(accountId: string): Promise<{ canceled: boolean; resubscribe: boolean }> {
  const row = await queryOne<{ id: string }>(`UPDATE accounts SET deletion_requested_at = NULL, deletion_scheduled_for = NULL, updated_at = now() WHERE id = $1 AND deletion_scheduled_for IS NOT NULL RETURNING id`, [accountId]);
  if (!row) return { canceled: false, resubscribe: false };
  let resubscribe = false;
  const sub = await getSubscription(accountId);
  if (sub?.provider_subscription_id && ['active', 'past_due'].includes(sub.status) && sub.cancel_at_period_end) {
    if (sub.provider === 'stripe') {
      try {
        await providers.stripe.setCancelAtPeriodEnd(sub, false);
        await query(`UPDATE subscriptions SET cancel_at_period_end = false, updated_at = now() WHERE account_id = $1`, [accountId]);
      } catch (e: any) {
        resubscribe = true;
        await logEvent({ level: 'warn', source: 'admin', message: `No se pudo reanudar la renovación al cancelar el borrado: ${e?.message ?? e}`, accountId });
      }
    } else resubscribe = true;
  }
  await logEvent({ level: 'info', source: 'admin', message: 'Borrado de la cuenta cancelado', accountId });
  return { canceled: true, resubscribe };
}

/** Revisión periódica: borra las cuentas cuyo plazo para arrepentirse ya terminó. Pocas por vuelta. */
export async function checkScheduledDeletions(now = new Date()): Promise<number> {
  const due = await query<Account>(`SELECT * FROM accounts WHERE deletion_scheduled_for <= $1 ORDER BY deletion_scheduled_for LIMIT 20`, [now]);
  let deleted = 0;
  for (const acc of due) {
    try {
      const owner = await ownerOf(acc);
      const mb = await mailBrand(acc.id);
      await deleteAccountFully(acc);
      deleted++;
      await logEvent({ level: 'warn', source: 'admin', message: `Cuenta borrada a petición de su dueño: ${acc.name}` });
      if (owner) await sendMail({ fromName: mb.fromName, to: owner.email, subject: `Borramos tu cuenta "${acc.name}"`, text: `Como lo pediste, borramos tu cuenta "${acc.name}" con su agente, contactos y conversaciones. Tus pagos y facturas se conservan por obligación fiscal.\n\nGracias por usar el servicio. Si algún día quieres volver, puedes crear una cuenta nueva.` });
      await alertSuperadmins(null, `Cuenta borrada por su dueño: ${acc.name}`, `"${acc.name}" pidió borrar su cuenta el ${fmt(new Date(acc.deletion_requested_at!))} y se borró hoy, terminado el plazo de ${DELETION_GRACE_DAYS} días.`);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'admin', message: `No se pudo borrar la cuenta ${acc.name} pedida por su dueño: ${e?.message ?? e}`, accountId: acc.id });
    }
  }
  return deleted;
}

/* ------------------------------ Descargar todos los datos ------------------------------ */

const csv = (header: string[], rows: unknown[][]) => '﻿' + csvRow(header) + rows.map(csvRow).join('');
const json = (v: unknown) => JSON.stringify(v, null, 2);
/** Tope de mensajes en el ZIP (una cuenta enorme no debe tumbar el servidor); el panel exporta por fechas si hace falta. */
export const EXPORT_MAX_MESSAGES = 200_000;

/**
 * Todo lo de la cuenta en un ZIP: configuración (cuenta, equipo, agentes con su conocimiento, automatizaciones, agenda),
 * contactos, conversaciones, mensajes, cotizaciones, pagos y facturas. Nunca contraseñas ni credenciales de los canales.
 */
export async function buildAccountExport(accountId: string, now = new Date()): Promise<Buffer> {
  const one = <T extends Record<string, any>>(sql: string) => query<T>(sql, [accountId]);
  const [account, users, bots, knowledge, automations, sequences, services, appointments, channels, contacts, conversations, messages, quotes, payments, invoices] = await Promise.all([
    one<{ a: unknown }>(`SELECT to_jsonb(a) - 'limit_notices' AS a FROM accounts a WHERE a.id = $1`),
    one<any>(`SELECT id, name, email, role, active, phone, created_at FROM users WHERE account_id = $1 ORDER BY created_at`),
    one<{ b: any }>(`SELECT to_jsonb(b) AS b FROM chatbots b WHERE b.account_id = $1 ORDER BY b.created_at`),
    one<{ chatbot_id: string; k: unknown }>(`SELECT k.chatbot_id, to_jsonb(k) - 'embedding' - 'embedding_model' - 'search_vector' AS k FROM knowledge_items k JOIN chatbots b ON b.id = k.chatbot_id WHERE b.account_id = $1`),
    one<{ r: unknown }>(`SELECT to_jsonb(r) AS r FROM automations r WHERE r.account_id = $1`),
    one<{ r: unknown }>(`SELECT to_jsonb(r) AS r FROM sequences r WHERE r.account_id = $1`),
    one<{ r: unknown }>(`SELECT to_jsonb(r) AS r FROM services r WHERE r.account_id = $1`),
    one<{ r: unknown }>(`SELECT to_jsonb(r) AS r FROM appointments r WHERE r.account_id = $1`),
    one<any>(`SELECT id, type, name, created_at FROM channels WHERE account_id = $1 AND type <> 'playground' ORDER BY created_at`),
    one<any>(`SELECT c.id, c.name, c.push_name, c.phone, ch.name AS channel, c.tags, c.data, c.notes, c.opted_out, c.created_at FROM contacts c JOIN channels ch ON ch.id = c.channel_id WHERE c.account_id = $1 AND ch.type <> 'playground' ORDER BY c.created_at`),
    one<any>(`SELECT cv.id, cv.contact_id, ch.name AS channel, cv.status, cv.summary, cv.data, cv.created_at, cv.last_message_at FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id WHERE cv.account_id = $1 AND ch.type <> 'playground' ORDER BY cv.created_at`),
    query<any>(`SELECT m.id, m.conversation_id, m.created_at, m.direction, m.sender, m.type, m.content FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN channels ch ON ch.id = cv.channel_id
                WHERE cv.account_id = $1 AND ch.type <> 'playground' ORDER BY m.id LIMIT ${EXPORT_MAX_MESSAGES}`, [accountId]),
    one<{ q: unknown }>(`SELECT to_jsonb(q) AS q FROM quotes q WHERE q.account_id = $1 ORDER BY q.created_at`),
    one<any>(`SELECT provider, provider_payment_id, plan_key, currency, subtotal_cents, tax_cents, total_cents, refunded_cents, status, paid_at FROM billing_payments WHERE account_id = $1 ORDER BY paid_at`),
    one<any>(`SELECT kind, status, series, folio, sat_uuid, amount_cents, issued_at FROM cfdi_invoices WHERE account_id = $1 ORDER BY created_at`),
  ]);
  const pesos = (c: number) => (Number(c) / 100).toFixed(2);
  const zip = new PizZip();
  zip.file('LEEME.txt', [
    `Datos de tu cuenta, descargados el ${now.toISOString().slice(0, 10)}.`,
    '',
    'cuenta.json, equipo.csv, agentes.json (con su conocimiento), automatizaciones.json, agenda.json y canales.csv: tu configuración.',
    'contactos.csv, conversaciones.csv y mensajes.csv: tus clientes y lo que platicaron (los CSV se abren en Excel o Google Sheets).',
    'cotizaciones.json, pagos.csv y facturas.csv: tus cotizaciones y lo que has pagado.',
    `No incluye contraseñas ni las credenciales de tus canales.${messages.length >= EXPORT_MAX_MESSAGES ? ` Los mensajes se cortaron en ${EXPORT_MAX_MESSAGES.toLocaleString('es-MX')}: descarga los más recientes por fechas en Conversaciones → Exportar.` : ''}`,
  ].join('\r\n'));
  zip.file('cuenta.json', json(account[0]?.a ?? {}));
  zip.file('equipo.csv', csv(['id', 'nombre', 'correo', 'rol', 'activo', 'telefono', 'creado'], users.map((u) => [u.id, u.name, u.email, u.role, u.active ? 'sí' : 'no', u.phone, u.created_at])));
  zip.file('agentes.json', json(bots.map((b) => ({ ...b.b, conocimiento: knowledge.filter((k) => k.chatbot_id === b.b.id).map((k) => k.k) }))));
  zip.file('automatizaciones.json', json({ reglas: automations.map((r) => r.r), secuencias: sequences.map((r) => r.r) }));
  zip.file('agenda.json', json({ servicios: services.map((r) => r.r), citas: appointments.map((r) => r.r) }));
  zip.file('canales.csv', csv(['id', 'tipo', 'nombre', 'creado'], channels.map((c) => [c.id, c.type, c.name, c.created_at])));
  zip.file('contactos.csv', csv(['id', 'nombre', 'nombre_en_el_canal', 'telefono', 'canal', 'etiquetas', 'datos', 'notas', 'dado_de_baja', 'creado'],
    contacts.map((c) => [c.id, c.name, c.push_name, c.phone, c.channel, (c.tags ?? []).join('; '), c.data, (c.notes ?? []).join(' | '), c.opted_out ? 'sí' : 'no', c.created_at])));
  zip.file('conversaciones.csv', csv(['id', 'contacto', 'canal', 'estado', 'resumen', 'datos', 'creada', 'ultimo_mensaje'],
    conversations.map((c) => [c.id, c.contact_id, c.channel, c.status, c.summary, c.data, c.created_at, c.last_message_at])));
  zip.file('mensajes.csv', csv(['id', 'conversacion', 'fecha', 'direccion', 'remitente', 'tipo', 'texto'],
    messages.map((m) => [m.id, m.conversation_id, m.created_at, m.direction === 'in' ? 'recibido' : 'enviado', m.sender, m.type, m.content])));
  zip.file('cotizaciones.json', json(quotes.map((q) => q.q)));
  zip.file('pagos.csv', csv(['proveedor', 'pago', 'plan', 'moneda', 'subtotal', 'iva', 'total', 'reembolsado', 'estado', 'fecha'],
    payments.map((p) => [p.provider, p.provider_payment_id, p.plan_key, p.currency, pesos(p.subtotal_cents), pesos(p.tax_cents), pesos(p.total_cents), pesos(p.refunded_cents), p.status, p.paid_at])));
  zip.file('facturas.csv', csv(['tipo', 'estado', 'serie', 'folio', 'uuid', 'monto', 'emitida'], invoices.map((f) => [f.kind, f.status, f.series, f.folio, f.sat_uuid, pesos(f.amount_cents), f.issued_at])));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
