/**
 * Lo que el superadmin necesita para operar sin vigilar: las cifras del negocio (tablero `#/negocio`) y un solo correo
 * al día con lo que pasó. Lo urgente (un contracargo, una factura que no salió, algo que hay que hacer a mano) sigue
 * llegando al momento; lo demás (cuentas nuevas, pruebas que vencen, cobros que se recuperan solos) espera al resumen.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';

const DAY = 86400_000;
const TZ = 'America/Mexico_City';

/** Fecha y hora de México de un instante: el resumen sale una vez por día de México, a partir de la hora configurada. */
function localParts(now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/**
 * Correo al superadmin. Urgente: sale ya. Si no, se guarda para el resumen del día (o sale ya si el resumen está
 * apagado con SUPERADMIN_DIGEST=false).
 */
export async function emailSuperadmin(title: string, body: string, o: { urgent?: boolean; accountId?: string | null } = {}) {
  const to = config.signup.superadminEmail;
  if (!to) return;
  if (o.urgent || !config.signup.superadminDigest) {
    await sendMail({ to, subject: title, text: body });
    return;
  }
  await query(`INSERT INTO superadmin_digest (title, body, account_id) VALUES ($1, $2, $3)`, [title, body, o.accountId ?? null]);
}

/* ------------------------------ Cifras del negocio ------------------------------ */

export interface BusinessMetrics {
  generated_at: string;
  signups: { last_30d: number; prev_30d: number };
  trials_active: number;
  /** De las pruebas que terminaron en los últimos 90 días, cuántas pagaron. */
  conversion: { ended: number; paid: number; percent: number | null };
  subscriptions: { active: number; past_due: number; canceled_30d: number };
  /** Sin IVA (no es ingreso); los anuales cuentan su doceava parte. */
  revenue: { currency: string; mrr: number; arr: number }[];
  /** Lo cobrado en 30 días, sin IVA y descontando reembolsos. */
  collected_30d: { currency: string; amount: number }[];
  disputes: { open: number; lost_30d: number };
  cfdi: { pending: number; failed: number };
  actions: { pending: number; failed: number };
  last_reconciled_at: string | null;
  digest_pending: number;
}

export async function businessMetrics(now = new Date()): Promise<BusinessMetrics> {
  const d30 = new Date(now.getTime() - 30 * DAY);
  const d60 = new Date(now.getTime() - 60 * DAY);
  const d90 = new Date(now.getTime() - 90 * DAY);
  const [signups, trials, conv, subs, revenue, collected, disputes, cfdi, actions, rec, digest] = await Promise.all([
    queryOne<{ last: number; prev: number }>(
      `SELECT count(*) FILTER (WHERE created_at >= $1)::int AS last, count(*) FILTER (WHERE created_at >= $2 AND created_at < $1)::int AS prev
       FROM accounts WHERE signup_source = 'signup' AND created_at >= $2`, [d30, d60]),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE status = 'trial' AND active`),
    queryOne<{ ended: number; paid: number }>(
      `SELECT count(*)::int AS ended, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM billing_payments p WHERE p.account_id = a.id AND p.refunded_cents < p.total_cents))::int AS paid
       FROM accounts a WHERE a.signup_source = 'signup' AND a.trial_ends_at >= $1 AND a.trial_ends_at <= $2`, [d90, now]),
    queryOne<{ active: number; past_due: number; canceled: number }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'past_due')::int AS past_due,
              count(*) FILTER (WHERE status = 'canceled' AND updated_at >= $1)::int AS canceled FROM subscriptions`, [d30]),
    query<{ currency: string; cents: string }>(
      `SELECT p.currency, round(sum(CASE WHEN p.billing_interval = 'year' THEN p.price_cents / 12.0 ELSE p.price_cents END))::text AS cents
       FROM subscriptions s JOIN plans p ON p.key = s.plan_key WHERE s.status IN ('active', 'past_due') GROUP BY 1 ORDER BY 1`),
    query<{ currency: string; cents: string }>(
      `SELECT currency, round(sum(subtotal_cents * (total_cents - LEAST(refunded_cents, total_cents))::numeric / NULLIF(total_cents, 0)))::text AS cents
       FROM billing_payments WHERE paid_at >= $1 GROUP BY 1 ORDER BY 1`, [d30]),
    queryOne<{ open: number; lost: number }>(
      `SELECT count(*) FILTER (WHERE dispute_status = 'open')::int AS open, count(*) FILTER (WHERE dispute_status = 'lost' AND updated_at >= $1)::int AS lost FROM billing_payments`, [d30]),
    queryOne<{ pending: number; failed: number }>(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM cfdi_invoices`),
    queryOne<{ pending: number; failed: number }>(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM billing_actions`),
    queryOne<{ at: Date | null }>(`SELECT max(reconciled_at) AS at FROM subscriptions`),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM superadmin_digest WHERE sent_at IS NULL`),
  ]);
  const ended = conv?.ended ?? 0;
  const paid = conv?.paid ?? 0;
  return {
    generated_at: now.toISOString(),
    signups: { last_30d: signups?.last ?? 0, prev_30d: signups?.prev ?? 0 },
    trials_active: trials?.n ?? 0,
    conversion: { ended, paid, percent: ended ? Math.round((paid / ended) * 1000) / 10 : null },
    subscriptions: { active: subs?.active ?? 0, past_due: subs?.past_due ?? 0, canceled_30d: subs?.canceled ?? 0 },
    revenue: revenue.map((r) => ({ currency: r.currency, mrr: Number(r.cents) / 100, arr: (Number(r.cents) * 12) / 100 })),
    collected_30d: collected.map((r) => ({ currency: r.currency, amount: Number(r.cents) / 100 })),
    disputes: { open: disputes?.open ?? 0, lost_30d: disputes?.lost ?? 0 },
    cfdi: { pending: cfdi?.pending ?? 0, failed: cfdi?.failed ?? 0 },
    actions: { pending: actions?.pending ?? 0, failed: actions?.failed ?? 0 },
    last_reconciled_at: rec?.at ? new Date(rec.at).toISOString() : null,
    digest_pending: digest?.n ?? 0,
  };
}

const amount = (n: number, currency: string) => `${n.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;

/** Las cifras en texto, para el correo del resumen. */
export function metricsText(m: BusinessMetrics) {
  const lines = [
    `Registros (30 días): ${m.signups.last_30d} (los 30 anteriores: ${m.signups.prev_30d}) · Pruebas activas: ${m.trials_active}`,
    `Conversión de prueba a pago (90 días): ${m.conversion.percent === null ? 'sin pruebas terminadas' : `${m.conversion.percent} % (${m.conversion.paid} de ${m.conversion.ended})`}`,
    `Suscripciones: ${m.subscriptions.active} activas · ${m.subscriptions.past_due} con cobro pendiente · ${m.subscriptions.canceled_30d} bajas en 30 días`,
    `Ingreso recurrente sin IVA: ${m.revenue.length ? m.revenue.map((r) => `${amount(r.mrr, r.currency)} al mes (${amount(r.arr, r.currency)} al año)`).join(' · ') : 'sin suscripciones'}`,
  ];
  const attention = [
    m.disputes.open ? `${m.disputes.open} contracargo(s) abierto(s)` : '',
    m.cfdi.failed ? `${m.cfdi.failed} factura(s) que no se pudieron emitir` : '',
    m.actions.failed ? `${m.actions.failed} cancelación(es) o reembolso(s) para hacer a mano` : '',
  ].filter(Boolean);
  if (attention.length) lines.push(`Pide tu atención: ${attention.join(' · ')}`);
  return lines.join('\n');
}

/* ------------------------------ Resumen diario ------------------------------ */

/**
 * Un correo al día (hora de México, desde SUPERADMIN_DIGEST_HOUR) con los avisos guardados y las cifras. Solo sale si
 * hubo avisos. El día se aparta en system_state: aunque corran varios procesos, sale uno.
 */
export async function sendSuperadminDigest(now = new Date()): Promise<number> {
  const to = config.signup.superadminEmail;
  if (!to || !config.signup.superadminDigest) return 0;
  const { day, hour } = localParts(now);
  if (hour < config.signup.superadminDigestHour) return 0;
  const pending = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM superadmin_digest WHERE sent_at IS NULL AND created_at <= $1`, [now]);
  if (!pending?.n) return 0;
  const claimed = await queryOne<{ key: string }>(
    `INSERT INTO system_state (key, value, updated_at) VALUES ('superadmin_digest', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now() WHERE system_state.value->>'day' IS DISTINCT FROM $2
     RETURNING key`,
    [{ day }, day],
  );
  if (!claimed) return 0;
  const items = await query<{ id: string; title: string; body: string; created_at: Date }>(
    `SELECT id, title, body, created_at FROM superadmin_digest WHERE sent_at IS NULL AND created_at <= $1 ORDER BY created_at, id LIMIT 500`, [now]);
  const m = await businessMetrics(now);
  const when = (d: Date) => new Date(d).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const text = [
    `Resumen de tu plataforma (${day}).`,
    '',
    metricsText(m),
    '',
    `Lo que pasó (${items.length}):`,
    ...items.map((i) => `- ${when(i.created_at)} · ${i.title}${i.body ? `\n  ${i.body.replace(/\s*\n+\s*/g, ' ')}` : ''}`),
    '',
    `Tablero: ${config.publicBaseUrl}/#/negocio`,
    'Lo urgente (contracargos, facturas que no salieron y lo que hay que hacer a mano) te sigue llegando al momento.',
  ].join('\n');
  try {
    await sendMail({ to, subject: `Resumen del día: ${items.length} aviso(s)`, text });
  } catch (e) {
    // Se libera el día para reintentar en la siguiente vuelta; los avisos siguen pendientes.
    await query(`UPDATE system_state SET value = '{}', updated_at = now() WHERE key = 'superadmin_digest'`);
    throw e;
  }
  await query(`UPDATE superadmin_digest SET sent_at = $2 WHERE id = ANY($1::bigint[])`, [items.map((i) => i.id), now]);
  // Lo ya enviado solo sirve un tiempo (el panel conserva sus propios avisos).
  await query(`DELETE FROM superadmin_digest WHERE sent_at < $1`, [new Date(now.getTime() - 90 * DAY)]);
  await logEvent({ level: 'info', source: 'system', message: `Resumen diario enviado al superadmin (${items.length} avisos)` });
  return items.length;
}
