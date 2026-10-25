/**
 * Ciclo de vida de las cuentas del autoregistro: fin de la prueba y avisos al superadmin.
 * Se ejecuta periódicamente; cada paso es idempotente (se puede correr las veces que sea).
 */
import { getSettings, notifyUsers } from './automation/store.js';
import { mailBrand } from './brands.js';
import { config } from './config.js';
import { query, queryOne } from './db.js';
import { checkAccountRetention, keptNote } from './accounts/retention.js';
import { checkScheduledDeletions } from './accounts/self-service.js';
import { billingEnabled, cancelLongUnpaid, checkDunning, enforceAccess, syncPendingCheckouts } from './billing/service.js';
import { checkWebhookSilence, processBillingActions, reconcileSubscriptions } from './billing/autopilot.js';
import { checkGlobalInvoice, processCfdi } from './billing/cfdi.js';
import { logEvent } from './logs.js';
import { sendMail } from './mailer.js';
import { checkOnboardingNudges } from './onboarding-checklist.js';
import { emailSuperadmin, sendSuperadminDigest } from './platform/digest.js';
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
/** Aviso al superadmin: en el panel al momento; por correo al momento si es urgente, si no en el resumen del día. */
export async function notifySuperadmins(accountId: string, title: string, body: string, o: { urgent?: boolean } = {}) {
  const supers = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'superadmin' AND active`);
  await notifyUsers(accountId, supers.map((s) => s.id), { title, body, link: `#/accounts`, kind: 'platform' });
  await emailSuperadmin(title, body, { urgent: o.urgent, accountId });
}

/** Qué hacer para seguir: pagar en línea (si hay cobro automático) o escribir al contacto de soporte. */
async function howToContinue(accountId: string) {
  const mb = await mailBrand(accountId);
  if (await billingEnabled()) return { mb, text: `Elige tu plan y paga en línea aquí:\n${mb.base}/#/plan\n\n` };
  return { mb, text: `${config.signup.supportContact ? `Para continuar, escríbenos: ${config.signup.supportContact}\n\n` : ''}${mb.base}` };
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
      const next = await howToContinue(acc.id);
      await sendMail({
        fromName: next.mb.fromName,
        to: o.email,
        subject: 'Tu periodo de prueba está por terminar',
        text: `Hola ${o.name || ''},\n\nTu prueba de "${acc.name}" termina el ${fmt(acc.trial_ends_at!)}. Después de esa fecha tu asistente dejará de responder hasta que se active tu plan.\n\n${next.text}`,
      });
    }
    await notifySuperadmins(acc.id, `Prueba por vencer: ${acc.name}`, `La prueba de "${acc.name}" termina el ${fmt(acc.trial_ends_at!)}${o ? ` (${o.email})` : ''}.`);
  }

  // 2) Prueba vencida: la cuenta se pausa (el panel sigue funcionando; el bot no responde).
  const expired = await query<Account>(
    `UPDATE accounts SET status = 'paused', paused_at = $1, pause_reason = 'trial', updated_at = now() WHERE status = 'trial' AND trial_ends_at <= $1 RETURNING *`,
    [now],
  );
  for (const acc of expired) {
    await logEvent({ level: 'warn', source: 'admin', message: `Prueba terminada: la cuenta "${acc.name}" quedó en pausa`, accountId: acc.id });
    const o = await owner(acc);
    const next = await howToContinue(acc.id);
    if (o) {
      await sendMail({
        fromName: next.mb.fromName,
        to: o.email,
        subject: 'Tu periodo de prueba terminó',
        text: `Hola ${o.name || ''},\n\nLa prueba de "${acc.name}" terminó y tu asistente está en pausa. ${keptNote()} Se reactiva en cuanto se active tu plan.\n\n${next.text}`,
      });
    }
    const paysOnline = await billingEnabled();
    await notifySuperadmins(acc.id, `Prueba terminada: ${acc.name}`, `La cuenta "${acc.name}" quedó en pausa${o ? ` (${o.email})` : ''}. ${paysOnline ? 'Se reactiva sola cuando pague en línea.' : 'Actívala desde Cuentas si ya pagó.'}`);
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
    // Primero se confirman los pagos pendientes y se concilia con el proveedor (un pago ya hecho, o un cobro fallido cuyo
    // aviso se perdió, no debe esperar al aviso); después se pausa, se recuerda y se cancela lo que corresponda.
    syncPendingCheckouts()
      .catch((e) => logEvent({ level: 'error', source: 'system', message: `Revisión de pagos pendientes: ${e?.message ?? e}` }))
      .then(() => reconcileSubscriptions())
      .catch((e) => logEvent({ level: 'error', source: 'system', message: `Conciliación de suscripciones: ${e?.message ?? e}` }))
      .then(() => enforceAccess())
      .then(() => checkDunning())
      .then(() => cancelLongUnpaid())
      .then(() => processBillingActions())
      .then(() => checkWebhookSilence())
      .catch((e) => logEvent({ level: 'error', source: 'system', message: `Revisión de pagos: ${e?.message ?? e}` }));
    checkAccountRetention().catch((e) => logEvent({ level: 'error', source: 'system', message: `Retención de cuentas: ${e?.message ?? e}` }));
    checkScheduledDeletions().catch((e) => logEvent({ level: 'error', source: 'system', message: `Borrado de cuentas pedido por su dueño: ${e?.message ?? e}` }));
    checkAiSpend().catch((e) => logEvent({ level: 'error', source: 'system', message: `Revisión de gasto de IA: ${e?.message ?? e}` }));
    checkOnboardingNudges().catch((e) => logEvent({ level: 'error', source: 'system', message: `Correos de seguimiento: ${e?.message ?? e}` }));
    sendSuperadminDigest().catch((e) => logEvent({ level: 'error', source: 'system', message: `Resumen diario al superadmin: ${e?.message ?? e}` }));
    // Facturas: primero se arma la global del mes que cerró y luego se emite todo lo pendiente.
    checkGlobalInvoice()
      .then(() => processCfdi())
      .catch((e) => logEvent({ level: 'error', source: 'system', message: `Emisión de facturas: ${e?.message ?? e}` }));
  };
  tick();
  setInterval(tick, intervalMs).unref();
}

/**
 * Guarda el último estado de conexión del canal. Al conectar por primera vez se completa el paso del asistente;
 * si un WhatsApp que estaba conectado se cae, se avisa a los administradores de la cuenta (panel y correo).
 */
export async function recordConnectionState(ch: Pick<Channel, 'id' | 'account_id' | 'name' | 'type'>, state: string, reason = '') {
  // FOR UPDATE: dos procesos que reciben el mismo cambio no ven ambos el estado anterior (no se avisa dos veces).
  // connection_state_at solo cambia si cambia el estado (Evolution repite eventos); down_since marca desde cuándo está
  // caído un canal que estaba conectado; disconnect_reason, por qué (decide si se reconecta solo o hace falta el QR).
  const row = await queryOne<{ prev: string; was_down: string | null; was_notified: string | null }>(
    `WITH old AS (SELECT id, connection_state, down_since, disconnect_notified_at FROM channels WHERE id = $1 FOR UPDATE)
     UPDATE channels c SET connection_state = $2,
       connection_state_at = CASE WHEN old.connection_state IS DISTINCT FROM $2 THEN now() ELSE c.connection_state_at END,
       down_since = CASE WHEN $2 = 'open' THEN NULL WHEN old.connection_state = 'open' THEN now() ELSE c.down_since END,
       disconnect_reason = CASE WHEN $2 = 'open' THEN '' WHEN $3 <> '' THEN $3 ELSE c.disconnect_reason END
     FROM old WHERE c.id = old.id
     RETURNING old.connection_state AS prev, old.down_since AS was_down, old.disconnect_notified_at AS was_notified`,
    [ch.id, state, reason ?? ''],
  );
  if (state === 'open') await store.clearConnectionCodes(ch.id);
  if (!row) return;
  if (state === 'open') {
    // En cada «conectado» (no solo el primero: una conexión ya conectada puede cambiar de agente). Un fallo aquí no
    // debe hacer fallar el aviso de conexión.
    await startAgentOnConnect(ch).catch((e) => logEvent({ level: 'error', source: 'channel', message: `No se pudo encender el agente al conectar ${ch.name}: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id }));
    if (row.prev === 'open') return;
    const acc = await queryOne<Account>(`SELECT * FROM accounts WHERE id = $1`, [ch.account_id]);
    if (acc && !acc.onboarding?.whatsapp) {
      await query(`UPDATE accounts SET onboarding = onboarding || '{"whatsapp": true}'::jsonb WHERE id = $1`, [acc.id]);
      await logEvent({ level: 'info', source: 'evolution', message: `Primer WhatsApp conectado: ${ch.name}`, accountId: acc.id, channelId: ch.id });
    }
    // Volvió después de una caída de la que ya se avisó: se avisa que regresó (si así se definió).
    if (row.was_down && row.was_notified && new Date(row.was_notified) >= new Date(row.was_down)) await notifyReconnected(ch);
    return;
  }
  if (state !== 'close') return;
  // Se avisa ya si así se definió (0 minutos), si no es un WhatsApp (sus caídas no las vigila el reloj) o si hace falta
  // volver a vincular (esperar no sirve). Si no, la vigilancia avisa al cumplirse la espera, si sigue caído.
  const alerts = await connectionAlerts(ch.account_id);
  if (!alerts.enabled) return;
  const needsRelink = NEEDS_RELINK.includes(reason);
  if (row.prev === 'open' || (needsRelink && row.was_down)) {
    if (ch.type !== 'whatsapp' || alerts.after_minutes === 0 || needsRelink) {
      if (await claimDisconnectNotice(ch.id, 0, alerts.repeat_hours)) await notifyDisconnected(ch);
    }
  }
}

/**
 * Agentes del asistente de creación: se encienden solos la primera vez que una de sus conexiones queda conectada.
 * Una sola actualización condicional decide: con avisos simultáneos solo una la gana (un aviso y un registro); si alguien
 * lo encendió o apagó a mano, la marca ya no está y no se toca.
 */
export async function startAgentOnConnect(ch: Pick<Channel, 'id' | 'account_id' | 'name'>) {
  const bot = await queryOne<{ id: string; name: string }>(
    `UPDATE chatbots b SET active = true, start_on_connect = false, updated_at = now()
       FROM channels c
      WHERE c.id = $1 AND c.chatbot_id = b.id AND c.connection_state = 'open' AND c.active AND c.type <> 'playground'
        AND b.start_on_connect AND NOT b.active
      RETURNING b.id, b.name`,
    [ch.id],
  );
  if (!bot) return null;
  await logEvent({ level: 'info', source: 'channel', message: `Agente encendido al conectar ${ch.name}: ${bot.name}`, accountId: ch.account_id, chatbotId: bot.id, channelId: ch.id });
  const admins = await query<{ id: string }>(`SELECT id FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [ch.account_id]);
  await notifyUsers(ch.account_id, admins.map((a) => a.id), {
    title: 'Tu agente ya está respondiendo',
    body: `«${bot.name}» se encendió solo al conectar «${ch.name}». Si quieres pausarlo, entra a Agentes → ${bot.name} → Configurar.`,
    link: `#/bot/${bot.id}/empezar`,
    kind: 'channel',
  });
  return bot;
}

/** Motivos con los que la sesión no vuelve sola: hay que escanear el QR otra vez. */
export const NEEDS_RELINK = ['logged_out', 'banned', 'replaced'];

const REASON_TEXT: Record<string, string> = {
  logged_out: 'Se cerró la sesión desde el teléfono (se quitó el dispositivo vinculado, o el teléfono estuvo sin internet más de 14 días). Hay que volver a escanear el código QR.',
  banned: 'WhatsApp bloqueó o restringió este número. Revisa el teléfono; cuando se resuelva, vuelve a vincularlo con el código QR.',
  replaced: 'La sesión se abrió en otro lugar (WhatsApp Web u otro servidor) y esta se cerró. Cierra la otra y vuelve a vincularlo con el código QR.',
  connection_lost: 'Se perdió la conexión con WhatsApp y no se ha podido recuperar sola. Si no vuelve en unos minutos, vincúlalo de nuevo desde el panel.',
};
export const reasonText = (reason: string) => REASON_TEXT[reason] ?? REASON_TEXT.connection_lost;

export async function connectionAlerts(accountId: string) {
  return (await getSettings(accountId)).connection_alerts;
}

/**
 * Reclama el aviso de desconexión (una sola vez con varios procesos): el primero, cuando la caída ya cumplió la espera,
 * y los siguientes, cada `repeatHours` (0 = no se repite), durante 7 días.
 */
export async function claimDisconnectNotice(channelId: string, afterMinutes: number, repeatHours: number): Promise<boolean> {
  const rows = await query(`UPDATE channels SET disconnect_notified_at = now() WHERE id = $1 AND down_since IS NOT NULL
      AND down_since <= now() - make_interval(mins => $2) AND down_since > now() - interval '7 days'
      AND (disconnect_notified_at IS NULL OR disconnect_notified_at < down_since
        OR ($3 > 0 AND disconnect_notified_at < now() - make_interval(hours => $3)))
    RETURNING id`, [channelId, afterMinutes, repeatHours]);
  return rows.length > 0;
}

/** Envío de avisos por WhatsApp a números adicionales (lo registra el servicio: usa otro WhatsApp conectado de la cuenta). */
let alertWhatsapp: ((accountId: string, phone: string, text: string, excludeChannelId?: string) => Promise<void>) | null = null;
export function setAlertWhatsapp(fn: typeof alertWhatsapp) {
  alertWhatsapp = fn;
}

/** Envía un aviso de conexión a quienes se definió: administradores (panel y correo), correos y WhatsApp adicionales. */
async function sendConnectionAlert(ch: Pick<Channel, 'id' | 'account_id' | 'name' | 'type'>, title: string, body: string, force = false, linkTo?: string) {
  const s = await connectionAlerts(ch.account_id);
  const sent = { admins: 0, emails: 0, phones: 0, failed: [] as string[] };
  if (!s.enabled && !force) return sent;
  const link = linkTo ?? (ch.id ? `#/channel/${ch.id}?conectar=1` : '#/agentes');
  const url = `${config.publicBaseUrl}/${link}`;
  if (s.notify_admins) {
    const admins = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [ch.account_id]);
    await notifyUsers(ch.account_id, admins.map((a) => a.id), { title, body, link, kind: 'channel' });
    for (const a of admins) await sendMail({ to: a.email, subject: title, text: `${body}\n\n${url}` });
    sent.admins = admins.length;
  }
  for (const to of s.emails) {
    await sendMail({ to, subject: title, text: `${body}\n\n${url}` });
    sent.emails++;
  }
  for (const phone of s.phones) {
    try {
      if (!alertWhatsapp) throw new Error('sin envío de WhatsApp disponible');
      await alertWhatsapp(ch.account_id, phone, `*${title}*\n${body}\n${url}`, ch.id || undefined);
      sent.phones++;
    } catch (e: any) {
      sent.failed.push(phone);
      await logEvent({ level: 'warn', source: 'channel', message: `Aviso de desconexión no enviado por WhatsApp a ${phone}: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id || null });
    }
  }
  return sent;
}

/**
 * Redes de Zernio sin canal de mensajes (LinkedIn, YouTube, Google…) que hay que reconectar o cuyo permiso vence: un
 * aviso por negocio, con los mismos ajustes de avisos de desconexión y enlace a Redes sociales.
 */
export async function notifySocialAccounts(accountId: string, title: string, body: string) {
  return sendConnectionAlert({ id: '', account_id: accountId, name: '', type: 'zernio' }, title, body, false, '#/redes');
}

/** Aviso de que un canal se desconectó; `hours` si sigue así desde hace horas. El motivo dice si hay que escanear el QR. */
export async function notifyDisconnected(ch: Pick<Channel, 'id' | 'account_id' | 'name' | 'type'>, hours = 0) {
  const social = ch.type !== 'whatsapp';
  const still = hours > 0 ? ` (sigue así desde hace ${hours} h)` : '';
  const reason = String((await queryOne<{ r: string }>(`SELECT disconnect_reason AS r FROM channels WHERE id = $1`, [ch.id]))?.r ?? '');
  const relink = NEEDS_RELINK.includes(reason);
  const facebook = ch.type === 'messenger' || ch.type === 'instagram';
  const title = (facebook ? `Tu ${ch.type === 'instagram' ? 'Instagram' : 'Messenger'} se desconectó` : social ? 'Tu red social se desconectó' : relink ? 'Hay que volver a vincular tu WhatsApp' : 'Tu WhatsApp se desconectó') + still;
  const body = facebook
    ? `El canal "${ch.name}" no está conectado y el asistente no está recibiendo mensajes. ${reason === 'token_revoked' ? 'Facebook retiró el permiso (por ejemplo, se cambió la contraseña o se quitó el acceso a la página). ' : ''}Vuelve a conectarlo desde el panel con «Conectar con Facebook».`
    : social
      ? `El canal "${ch.name}" se desconectó y el asistente no está recibiendo mensajes. Vuelve a conectarlo desde el panel con "Reconectar".`
      : `El canal "${ch.name}" no está conectado y el asistente no está recibiendo mensajes. ${REASON_TEXT[reason] ?? REASON_TEXT.connection_lost}`;
  await sendConnectionAlert(ch, title, body);
}

export async function notifyReconnected(ch: Pick<Channel, 'id' | 'account_id' | 'name' | 'type'>) {
  const s = await connectionAlerts(ch.account_id);
  if (!s.notify_reconnected) return;
  const what = ch.type === 'whatsapp' ? 'Tu WhatsApp' : ch.type === 'messenger' ? 'Tu Messenger' : ch.type === 'instagram' ? 'Tu Instagram' : 'Tu red social';
  await sendConnectionAlert(ch, `${what} volvió a conectarse`, `El canal "${ch.name}" está conectado otra vez y el asistente ya responde los mensajes nuevos.`);
}

/** Alerta de prueba con los ajustes guardados (aunque los avisos estén apagados): para comprobar que llegan. */
export async function testConnectionAlert(accountId: string) {
  const ch = (await query<Pick<Channel, 'id' | 'account_id' | 'name' | 'type'>>(`SELECT id, account_id, name, type FROM channels WHERE account_id = $1 AND type = 'whatsapp' ORDER BY created_at LIMIT 1`, [accountId]))[0]
    ?? { id: '', account_id: accountId, name: 'WhatsApp', type: 'whatsapp' as const };
  return sendConnectionAlert(ch, 'Prueba: aviso de desconexión de WhatsApp', `Así te avisaremos si el canal "${ch.name}" se desconecta. No tienes que hacer nada.`, true);
}
