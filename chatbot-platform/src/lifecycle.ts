/**
 * Ciclo de vida de las cuentas del autoregistro: fin de la prueba y avisos al superadmin.
 * Se ejecuta periódicamente; cada paso es idempotente (se puede correr las veces que sea).
 */
import { notifyUsers } from './automation/store.js';
import { config } from './config.js';
import { query, queryOne } from './db.js';
import { enforceAccess } from './billing/service.js';
import { logEvent } from './logs.js';
import { sendMail } from './mailer.js';
import * as store from './store/index.js';
import type { Account, Channel } from './types.js';

const WARN_DAYS = 3;
const fmt = (d: Date) => new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

async function owner(acc: Account) {
  return queryOne<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM users WHERE id = $1 OR (account_id = $2 AND role = 'admin') ORDER BY (id = $1) DESC, created_at LIMIT 1`,
    [acc.owner_user_id, acc.id],
  );
}

/** Avisa al superadmin: notificación en el panel y, si hay SUPERADMIN_EMAIL, correo. */
export async function notifySuperadmins(accountId: string, title: string, body: string) {
  const supers = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'superadmin' AND active`);
  await notifyUsers(accountId, supers.map((s) => s.id), { title, body, link: `#/accounts`, kind: 'platform' });
  if (config.signup.superadminEmail) await sendMail({ to: config.signup.superadminEmail, subject: title, text: body });
}

export async function checkTrials(now = new Date()) {
  // 1) Aviso unos días antes de que termine la prueba.
  const warn = await query<Account>(
    `UPDATE accounts SET trial_warned_at = now() WHERE status = 'trial' AND active AND trial_warned_at IS NULL
       AND trial_ends_at > $1 AND trial_ends_at <= $1 + make_interval(days => $2) RETURNING *`,
    [now, WARN_DAYS],
  );
  for (const acc of warn) {
    const o = await owner(acc);
    if (o) {
      await sendMail({
        to: o.email,
        subject: 'Tu periodo de prueba está por terminar',
        text: `Hola ${o.name || ''},\n\nTu prueba de "${acc.name}" termina el ${fmt(acc.trial_ends_at!)}. Después de esa fecha tu asistente dejará de responder hasta que se active tu plan.\n\n${config.signup.supportContact ? `Para continuar, escríbenos: ${config.signup.supportContact}\n\n` : ''}${config.publicBaseUrl}`,
      });
    }
    await notifySuperadmins(acc.id, `Prueba por vencer: ${acc.name}`, `La prueba de "${acc.name}" termina el ${fmt(acc.trial_ends_at!)}${o ? ` (${o.email})` : ''}.`);
  }

  // 2) Prueba vencida: la cuenta se pausa (el panel sigue funcionando; el bot no responde).
  const expired = await query<Account>(
    `UPDATE accounts SET status = 'paused', updated_at = now() WHERE status = 'trial' AND trial_ends_at <= $1 RETURNING *`,
    [now],
  );
  for (const acc of expired) {
    await logEvent({ level: 'warn', source: 'admin', message: `Prueba terminada: la cuenta "${acc.name}" quedó en pausa`, accountId: acc.id });
    const o = await owner(acc);
    if (o) {
      await sendMail({
        to: o.email,
        subject: 'Tu periodo de prueba terminó',
        text: `Hola ${o.name || ''},\n\nLa prueba de "${acc.name}" terminó y tu asistente está en pausa. Tu configuración y tus conversaciones se conservan.\n\n${config.signup.supportContact ? `Para activar tu plan, escríbenos: ${config.signup.supportContact}\n\n` : ''}${config.publicBaseUrl}`,
      });
    }
    await notifySuperadmins(acc.id, `Prueba terminada: ${acc.name}`, `La cuenta "${acc.name}" quedó en pausa${o ? ` (${o.email})` : ''}. Actívala desde Cuentas si ya pagó.`);
  }
  return { warned: warn.length, paused: expired.length };
}

/** Aviso (sin bloquear) cuando una cuenta supera AI_ALERT_USD_PER_ACCOUNT en el mes. Una vez por mes y cuenta. */
export async function checkAiSpend(now = new Date()) {
  const limit = config.aiAlertUsdPerAccount;
  if (!(limit > 0)) return 0;
  const month = now.toISOString().slice(0, 7);
  const rows = await query<{ id: string; name: string; cost: string }>(
    `SELECT a.id, a.name, sum(r.cost_usd)::text AS cost FROM accounts a JOIN ai_runs r ON r.account_id = a.id
     WHERE r.created_at >= date_trunc('month', $1::timestamptz) AND a.ai_alert_month <> $2
     GROUP BY a.id HAVING sum(r.cost_usd) > $3`,
    [now, month, limit],
  );
  for (const r of rows) {
    await query(`UPDATE accounts SET ai_alert_month = $2 WHERE id = $1`, [r.id, month]);
    await notifySuperadmins(r.id, `Gasto de IA alto: ${r.name}`, `"${r.name}" lleva US$${Number(r.cost).toFixed(2)} de IA este mes (aviso a partir de US$${limit}).`);
  }
  return rows.length;
}

export function startLifecycle(intervalMs = 10 * 60_000) {
  const tick = () => {
    checkTrials().catch((e) => logEvent({ level: 'error', source: 'system', message: `Revisión de pruebas: ${e?.message ?? e}` }));
    enforceAccess().catch((e) => logEvent({ level: 'error', source: 'system', message: `Revisión de pagos: ${e?.message ?? e}` }));
    checkAiSpend().catch((e) => logEvent({ level: 'error', source: 'system', message: `Revisión de gasto de IA: ${e?.message ?? e}` }));
  };
  tick();
  setInterval(tick, intervalMs).unref();
}

/**
 * Guarda el último estado de conexión del canal. Al conectar por primera vez se completa el paso del asistente;
 * si un WhatsApp que estaba conectado se cae, se avisa a los administradores de la cuenta (panel y correo).
 */
export async function recordConnectionState(ch: Pick<Channel, 'id' | 'account_id' | 'name' | 'type'>, state: string) {
  const row = await queryOne<{ prev: string }>(
    `WITH old AS (SELECT connection_state FROM channels WHERE id = $1)
     UPDATE channels SET connection_state = $2, connection_state_at = now() WHERE id = $1 RETURNING (SELECT connection_state FROM old) AS prev`,
    [ch.id, state],
  );
  if (state === 'open') await store.clearConnectionCodes(ch.id);
  if (!row || row.prev === state) return;
  if (state === 'open') {
    const acc = await queryOne<Account>(`SELECT * FROM accounts WHERE id = $1`, [ch.account_id]);
    if (acc && !acc.onboarding?.whatsapp) {
      await query(`UPDATE accounts SET onboarding = onboarding || '{"whatsapp": true}'::jsonb WHERE id = $1`, [acc.id]);
      await logEvent({ level: 'info', source: 'evolution', message: `Primer WhatsApp conectado: ${ch.name}`, accountId: acc.id, channelId: ch.id });
    }
  } else if (state === 'close' && row.prev === 'open') {
    const admins = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [ch.account_id]);
    const body = `El canal "${ch.name}" se desconectó y el asistente no está recibiendo mensajes. Vuelve a vincularlo en un minuto desde el panel: escanea el código QR o usa "Con mi número".`;
    await notifyUsers(ch.account_id, admins.map((a) => a.id), { title: 'Tu WhatsApp se desconectó', body, link: `#/channel/${ch.id}?conectar=1`, kind: 'channel' });
    for (const a of admins) await sendMail({ to: a.email, subject: 'Tu WhatsApp se desconectó', text: `${body}\n\n${config.publicBaseUrl}/#/channel/${ch.id}?conectar=1` });
  }
}
