/**
 * Alta sin ayuda: la lista de pendientes de la cuenta (qué le falta para que su agente atienda y quede contratado) y los
 * correos de seguimiento si se queda a medias (conectar su WhatsApp, probar su agente, reactivar tras la prueba).
 */
import { billingEnabled } from './billing/service.js';
import { mailBrand } from './brands.js';
import { config } from './config.js';
import { query, queryOne } from './db.js';
import { NEEDS_RELINK, reasonText } from './lifecycle.js';
import { logEvent } from './logs.js';
import { sendMail } from './mailer.js';
import { hmac, safeEqual } from './secret.js';
import * as store from './store/index.js';

/** Señales de la cuenta con las que se decide qué falta (todas existen ya en la base). */
export async function onboardingSignals(accountId: string, userId: string | null) {
  const s = await queryOne<{
    verified: boolean; bot_id: string | null; connected: boolean; simulated: boolean; switched_on: boolean; paid: boolean; users: number;
    relink: { channel_id: string; reason: string } | null;
  }>(
    `SELECT
       COALESCE((SELECT email_verified_at IS NOT NULL FROM users WHERE id = $2), false) AS verified,
       (SELECT id FROM chatbots WHERE account_id = $1 ORDER BY created_at LIMIT 1) AS bot_id,
       EXISTS (SELECT 1 FROM channels WHERE account_id = $1 AND type <> 'playground' AND connection_state = 'open') AS connected,
       EXISTS (SELECT 1 FROM conversations cv JOIN channels c ON c.id = cv.channel_id WHERE cv.account_id = $1 AND c.type = 'playground')
         OR COALESCE((SELECT (onboarding->>'test')::boolean FROM accounts WHERE id = $1), false) AS simulated,
       EXISTS (SELECT 1 FROM chatbots WHERE account_id = $1 AND (active OR start_on_connect)) AS switched_on,
       EXISTS (SELECT 1 FROM subscriptions WHERE account_id = $1 AND status IN ('active', 'past_due')) AS paid,
       (SELECT count(*)::int FROM users WHERE account_id = $1 AND active) AS users,
       (SELECT json_build_object('channel_id', id, 'reason', disconnect_reason) FROM channels
         WHERE account_id = $1 AND type = 'whatsapp' AND connection_state IS DISTINCT FROM 'open' AND disconnect_reason = ANY($3::text[])
         ORDER BY down_since DESC NULLS LAST LIMIT 1) AS relink`,
    [accountId, userId, NEEDS_RELINK],
  );
  return s!;
}

export interface ChecklistItem {
  key: 'verify' | 'agent' | 'test' | 'connect' | 'activate' | 'plan' | 'team';
  label: string;
  done: boolean;
  optional: boolean;
  /** Adónde lleva el botón (vacío si la acción es otra, como reenviar el correo). */
  href: string;
  action: string;
  hint: string;
}

/** Lista de pendientes en el orden en que conviene hacerlos. */
export async function accountChecklist(accountId: string, userId: string | null) {
  const s = await onboardingSignals(accountId, userId);
  const relink = !s.connected ? s.relink : null;
  const items: ChecklistItem[] = [
    { key: 'verify', label: 'Confirma tu correo', done: s.verified, optional: !config.signup.requireEmail, href: '', action: 'Reenviar correo', hint: 'Te mandamos un enlace al registrarte. Sin confirmarlo no puedes conectar tu WhatsApp.' },
    { key: 'agent', label: 'Crea tu agente', done: !!s.bot_id, optional: false, href: '#/agentes/nuevo', action: 'Crear agente', hint: 'Cuéntale de tu negocio en 3 pantallas.' },
    { key: 'test', label: 'Pruébalo en el simulador', done: s.simulated, optional: false, href: '#/probar', action: 'Probar', hint: 'Escríbele como si fueras un cliente y revisa que responda bien.' },
    {
      key: 'connect', label: relink ? 'Vuelve a vincular tu WhatsApp' : 'Conecta tu WhatsApp u otro canal', done: s.connected, optional: false,
      href: relink ? `#/channel/${relink.channel_id}?conectar=1` : '#/empezar', action: relink ? 'Volver a vincular' : 'Conectar',
      hint: relink ? reasonText(relink.reason) : 'Escanea el código QR con tu WhatsApp; el agente empieza a atender en cuanto se conecta.',
    },
    { key: 'activate', label: 'Enciende tu agente', done: s.switched_on, optional: false, href: s.bot_id ? `#/bot/${s.bot_id}/instrucciones` : '#/agentes/nuevo', action: 'Encender', hint: 'Mientras esté en pausa no responde a tus clientes.' },
  ];
  if (await billingEnabled()) items.push({ key: 'plan', label: 'Elige tu plan', done: s.paid, optional: false, href: '#/plan', action: 'Ver planes', hint: 'Así tu agente sigue atendiendo cuando termine la prueba.' });
  items.push({ key: 'team', label: 'Suma a tu equipo', done: s.users > 1, optional: true, href: '#/users', action: 'Agregar', hint: 'Que tu equipo atienda las conversaciones que pasen a una persona.' });
  const required = items.filter((i) => !i.optional);
  return { items, done_count: required.filter((i) => i.done).length, total: required.length, complete: required.every((i) => i.done) };
}

/* ------------------------------ Correos de seguimiento ------------------------------ */

/** Solo cuentas recientes: al instalar esta función no se escribe a cuentas viejas. */
const WINDOW_DAYS = 14;

export const unsubscribeSig = (accountId: string) => hmac(`nudges-off:${accountId}`);
export const unsubscribeOk = (accountId: string, sig: string) => !!accountId && !!sig && safeEqual(sig, unsubscribeSig(accountId));
/** Baja de los correos de seguimiento (los de cobro y seguridad siguen llegando). */
export const stopNudges = (accountId: string) => store.markOnboarding(accountId, { nudges_off: true });

type Kind = 'connect' | 'test' | 'reactivate';
const MAILS: Record<Kind, { subject: string; body: (name: string, base: string) => string }> = {
  connect: {
    subject: 'Conecta tu WhatsApp y tu agente empieza a atender',
    body: (n, base) => `Tu agente de "${n}" está listo, pero todavía no está conectado a tu WhatsApp.\n\nConéctalo en un minuto escaneando el código QR:\n${base}/#/empezar\n\nEn cuanto se conecte, empieza a responder a tus clientes.`,
  },
  test: {
    subject: 'Prueba tu agente antes de que hable con tus clientes',
    body: (n, base) => `Escríbele a tu agente de "${n}" como si fueras un cliente y revisa que responda bien. Si algo no te gusta, lo ajustas en el momento.\n\nAbrir el simulador:\n${base}/#/probar`,
  },
  reactivate: {
    subject: 'Tu agente está en pausa: reactívalo cuando quieras',
    body: (n, base) => `Tu prueba de "${n}" terminó y tu agente dejó de responder. Tu configuración y tus conversaciones siguen guardadas: elige tu plan y vuelve a atender a tus clientes en minutos.\n\n${base}/#/plan`,
  },
};

/**
 * Cuentas del registro a las que toca escribir, por tipo de correo:
 * - connect: más de 1 día desde el registro y sin ningún canal conectado.
 * - test: más de 3 días sin una sola conversación (ni en el simulador ni con clientes).
 * - reactivate: más de 3 días en pausa porque terminó la prueba, sin plan contratado.
 */
const DUE: Record<Kind, string> = {
  connect: `a.status IN ('trial', 'active') AND a.created_at <= $1::timestamptz - interval '1 day' AND a.created_at > $1::timestamptz - make_interval(days => $2)
    AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.account_id = a.id AND c.type <> 'playground' AND c.connection_state = 'open')`,
  test: `a.status IN ('trial', 'active') AND a.created_at <= $1::timestamptz - interval '3 days' AND a.created_at > $1::timestamptz - make_interval(days => $2)
    AND NOT COALESCE((a.onboarding->>'test')::boolean, false)
    AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.account_id = a.id)`,
  reactivate: `a.status = 'paused' AND a.trial_ends_at <= $1::timestamptz - interval '3 days' AND a.trial_ends_at > $1::timestamptz - make_interval(days => $2)
    AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id AND s.status IN ('active', 'past_due'))`,
};

/** Manda los correos de seguimiento que toquen (cada uno una sola vez por cuenta). Devuelve cuántos salieron. */
export async function checkOnboardingNudges(now = new Date()): Promise<number> {
  let sent = 0;
  for (const kind of Object.keys(DUE) as Kind[]) {
    // Se reserva la fila antes de enviar: dos procesos no mandan el mismo correo.
    const due = await query<{ account_id: string }>(
      `INSERT INTO account_nudges (account_id, kind)
       SELECT a.id, $3 FROM accounts a
       WHERE a.active AND a.signup_source = 'signup' AND NOT COALESCE((a.onboarding->>'nudges_off')::boolean, false) AND ${DUE[kind]}
       ON CONFLICT DO NOTHING RETURNING account_id`,
      [now, WINDOW_DAYS, kind],
    );
    for (const { account_id } of due) {
      const acc = await store.getAccount(account_id);
      const to = acc && (await queryOne<{ email: string; name: string }>(
        `SELECT email, name FROM users WHERE id = $1 OR (account_id = $2 AND role = 'admin' AND active) ORDER BY (id = $1) DESC, created_at LIMIT 1`,
        [acc.owner_user_id, acc.id],
      ));
      if (!acc || !to) continue;
      const mb = await mailBrand(acc.id);
      const off = `${mb.base}/baja-recordatorios?c=${acc.id}&s=${unsubscribeSig(acc.id)}`;
      await sendMail({ fromName: mb.fromName, to: to.email, subject: MAILS[kind].subject, text: `Hola ${to.name || ''},\n\n${MAILS[kind].body(acc.name, mb.base)}\n\n—\nNo quiero recibir estos recordatorios: ${off}` });
      await logEvent({ level: 'info', source: 'system', message: `Correo de seguimiento (${kind}) a ${to.email}`, accountId: acc.id });
      sent++;
    }
  }
  return sent;
}
