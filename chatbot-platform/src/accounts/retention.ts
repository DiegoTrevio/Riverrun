/**
 * Retención de cuentas: una cuenta que se pausó sola (prueba vencida o falta de pago) y nadie reactiva se borra a los
 * ACCOUNT_RETENTION_DAYS días, con aviso al dueño 7 días antes. Reactivarla, pagar o que el superadmin marque «Conservar
 * sus datos» lo detiene. Las cuentas que dio de alta el superadmin o que pausó a mano no se borran solas.
 */
import { mailBrand } from '../brands.js';
import { notifyUsers } from '../automation/store.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import type { Account } from '../types.js';
import { deleteAccountFully } from './delete.js';

/** Días de aviso antes del borrado. */
export const WARN_DAYS = 7;
const DAY = 86400_000;
const fmt = (d: Date) => d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

/** Lo que se dice al pausar: cuánto tiempo se conservan los datos. */
export const keptNote = () => config.billing.retentionDays > 0
  ? `Tu configuración y tus conversaciones se conservan ${config.billing.retentionDays} días.`
  : 'Tu configuración y tus conversaciones se conservan.';

/** Fecha en que se borraría una cuenta pausada sola (null si no se borra). */
export function deletionDate(acc: Pick<Account, 'paused_at' | 'deletion_warned_at' | 'keep_data' | 'signup_source'>): Date | null {
  const days = config.billing.retentionDays;
  if (!(days > 0) || !acc.paused_at || acc.keep_data || acc.signup_source !== 'signup') return null;
  const due = new Date(new Date(acc.paused_at).getTime() + days * DAY);
  const afterNotice = acc.deletion_warned_at ? new Date(new Date(acc.deletion_warned_at).getTime() + WARN_DAYS * DAY) : null;
  return afterNotice && afterNotice > due ? afterNotice : due;
}

/** Cuentas que se pueden borrar solas: pausadas por el sistema, del registro, sin excepción y sin suscripción que cobre. */
const CANDIDATE = `a.status = 'paused' AND a.paused_at IS NOT NULL AND a.signup_source = 'signup' AND NOT a.keep_data
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id AND s.status IN ('active', 'past_due'))`;

async function superadmins(title: string, body: string) {
  const supers = await query<{ id: string; account_id: string }>(`SELECT id, account_id FROM users WHERE role = 'superadmin' AND active AND account_id IS NOT NULL`);
  for (const s of supers) await notifyUsers(s.account_id, [s.id], { title, body, link: '#/accounts', kind: 'platform' });
  if (config.signup.superadminEmail) await sendMail({ to: config.signup.superadminEmail, subject: title, text: body });
}

export async function checkAccountRetention(now = new Date()): Promise<{ warned: number; deleted: number }> {
  const days = config.billing.retentionDays;
  if (!(days > 0)) return { warned: 0, deleted: 0 };

  // 1) Aviso al dueño 7 días antes (una sola vez: se reserva la fecha del aviso).
  const warn = await query<Account>(
    `UPDATE accounts a SET deletion_warned_at = $1 WHERE ${CANDIDATE} AND a.deletion_warned_at IS NULL
       AND a.paused_at <= $1::timestamptz - make_interval(days => $2) RETURNING a.*`,
    [now, Math.max(0, days - WARN_DAYS)],
  );
  for (const acc of warn) {
    const owner = await queryOne<{ email: string; name: string }>(
      `SELECT email, name FROM users WHERE id = $1 OR (account_id = $2 AND role = 'admin' AND active) ORDER BY (id = $1) DESC, created_at LIMIT 1`,
      [acc.owner_user_id, acc.id],
    );
    const when = deletionDate(acc) ?? new Date(now.getTime() + WARN_DAYS * DAY);
    await logEvent({ level: 'warn', source: 'admin', message: `Aviso de borrado: la cuenta se borra el ${fmt(when)} si no se reactiva`, accountId: acc.id });
    if (!owner) continue;
    const mb = await mailBrand(acc.id);
    await sendMail({
      fromName: mb.fromName, to: owner.email, subject: `Tu cuenta "${acc.name}" se borrará el ${fmt(when)}`,
      text: `Hola ${owner.name || ''},\n\nTu cuenta "${acc.name}" lleva en pausa desde el ${fmt(new Date(acc.paused_at!))}. Si no se reactiva, el ${fmt(when)} borraremos tu agente, su configuración, tus contactos y tus conversaciones. No se puede deshacer.\n\nPara conservarla, reactiva tu plan:\n${mb.base}/#/plan`,
    });
  }

  // 2) Borrado: cumplido el plazo y con al menos 7 días desde el aviso. Pocas por vuelta.
  const due = await query<Account>(
    `SELECT a.* FROM accounts a WHERE ${CANDIDATE} AND a.paused_at <= $1::timestamptz - make_interval(days => $2)
       AND a.deletion_warned_at <= $1::timestamptz - make_interval(days => $3) ORDER BY a.paused_at LIMIT 20`,
    [now, days, WARN_DAYS],
  );
  let deleted = 0;
  for (const acc of due) {
    try {
      await deleteAccountFully(acc);
      deleted++;
      await logEvent({ level: 'warn', source: 'admin', message: `Cuenta borrada por retención: ${acc.name} (en pausa desde el ${fmt(new Date(acc.paused_at!))})` });
      await superadmins(`Cuenta borrada por retención: ${acc.name}`, `"${acc.name}" estuvo en pausa más de ${days} días (${acc.pause_reason === 'trial' ? 'prueba vencida' : 'falta de pago'}) y se borró. Se avisó al dueño el ${fmt(new Date(acc.deletion_warned_at!))}.`);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'admin', message: `No se pudo borrar la cuenta ${acc.name} por retención: ${e?.message ?? e}`, accountId: acc.id });
    }
  }
  return { warned: warn.length, deleted };
}
