/**
 * Facturas (CFDI 4.0) de los cobros: quien pidió factura recibe una por pago a su nombre; los demás pagos van a la
 * factura global del mes a público en general (una por forma de pago); un reembolso posterior lleva nota de crédito.
 *
 * Todo pasa por la tabla cfdi_invoices y se emite en la revisión periódica (`processCfdi`): una fila se reserva antes
 * de llamar al PAC y, antes de reintentar, se busca en el PAC por su referencia, así un CFDI nunca se timbra dos veces.
 */
import { notifyUsers } from '../automation/store.js';
import { mailBrand } from '../brands.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { accountOwner } from '../identity/ownership.js';
import { countHit } from '../identity/rate-limit.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { facturapi, type CfdiDocument, type CfdiReceiver, type InvoiceProvider } from './facturapi.js';
import { fiscalComplete, getFiscal, usesFor } from './fiscal.js';
import { taxPercent } from './tax.js';
import { emailSuperadmin } from '../platform/digest.js';
import { ProviderError, type ProviderName } from './types.js';

export const invoicer: InvoiceProvider = facturapi;

export interface Cfdi {
  id: string;
  kind: 'payment' | 'global' | 'credit';
  account_id: string | null;
  payment_id: string | null;
  related_id: string | null;
  global_period: string;
  payment_form: string;
  amount_cents: number;
  receiver: CfdiReceiver;
  status: 'pending' | 'issued' | 'failed' | 'void';
  attempts: number;
  next_attempt_at: Date;
  last_error: string;
  data_error: boolean;
  provider_invoice_id: string;
  sat_uuid: string;
  series: string;
  folio: string;
  issued_at: Date | null;
}

const TZ = 'America/Mexico_City';
/** Forma de pago del SAT: tarjeta (Stripe) o intermediario de pagos (Mercado Pago). */
export const PAYMENT_FORM: Record<ProviderName, string> = { stripe: '04', mercadopago: '31' };
const PUBLIC: Omit<CfdiReceiver, 'zip'> = { rfc: 'XAXX010101000', legal_name: 'PUBLICO EN GENERAL', tax_regime: '616', cfdi_use: 'S01', email: '' };
/** Espera antes de cada reintento ante una falla del PAC: 5 min, 30 min, 2 h, 6 h y después cada 24 h. */
const BACKOFF_MIN = [5, 30, 120, 360, 1440];
/** Plazo de una fila reservada: si el proceso muere a medias, otro la retoma. */
const LEASE_MIN = 5;

const fmtMonth = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** Mes (AAAA-MM) en hora de México. */
export function mexicoMonth(d: Date) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
}

/** Datos del receptor que se copian al CFDI. El correo de facturas o, si está vacío, el del dueño de la cuenta. */
async function receiverOf(accountId: string): Promise<CfdiReceiver | null> {
  const f = await getFiscal(accountId);
  if (!f.wants_invoice || !fiscalComplete(f)) return null;
  const owner = await accountOwner(accountId);
  return { rfc: f.rfc, legal_name: f.legal_name, tax_regime: f.tax_regime, zip: f.zip, cfdi_use: f.cfdi_use, email: f.invoice_email || owner?.email || '' };
}

/** Pago nuevo: si la cuenta pidió factura, queda su CFDI por emitir; si no, el pago espera la global de su mes. */
export async function queuePaymentCfdi(paymentId: string) {
  const p = await queryOne<{ account_id: string | null; global_cfdi_id: string | null }>(`SELECT account_id, global_cfdi_id FROM billing_payments WHERE id = $1`, [paymentId]);
  if (!p?.account_id || p.global_cfdi_id) return false;
  const receiver = await receiverOf(p.account_id);
  if (!receiver) return false;
  const row = await queryOne(
    `INSERT INTO cfdi_invoices (kind, account_id, payment_id, receiver) VALUES ('payment', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
    [p.account_id, paymentId, JSON.stringify(receiver)],
  );
  return !!row;
}

/**
 * La cuenta guardó sus datos fiscales: los CFDI que el PAC rechazó por datos (y los que aún no salen) toman los nuevos y
 * se reintentan; si ahora pide factura, sus pagos del mes en curso que no están en una global reciben la suya.
 */
export async function onFiscalSaved(accountId: string, now = new Date()) {
  const receiver = await receiverOf(accountId);
  if (!receiver) return;
  await query(
    `UPDATE cfdi_invoices SET receiver = $2, status = 'pending', data_error = false, last_error = '', attempts = 0, next_attempt_at = now(), updated_at = now()
     WHERE account_id = $1 AND kind = 'payment' AND (status = 'pending' OR (status = 'failed' AND data_error))`,
    [accountId, JSON.stringify(receiver)],
  );
  const missing = await query<{ id: string }>(
    `SELECT p.id FROM billing_payments p WHERE p.account_id = $1 AND p.global_cfdi_id IS NULL AND p.refunded_cents < p.total_cents
       AND to_char(p.paid_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $2
       AND NOT EXISTS (SELECT 1 FROM cfdi_invoices c WHERE c.payment_id = p.id AND c.kind = 'payment')`,
    [accountId, mexicoMonth(now)],
  );
  for (const m of missing) await queuePaymentCfdi(m.id);
}

/**
 * Global de cada mes cerrado (hora de México), una por forma de pago, con los pagos sin factura propia. El SAT la pide en
 * las 24 horas siguientes al cierre del mes: se arma en la primera revisión del mes y se emite enseguida.
 */
export async function checkGlobalInvoice(now = new Date()) {
  if (!invoicer.enabled() || !config.billing.cfdi.issuerZip) return 0;
  // Todos los meses ya cerrados que tienen pagos sin factura (del más antiguo al más nuevo), no solo el anterior: si un
  // mes se saltó (Facturapi o el código postal se configuraron tarde, el servidor estuvo apagado), su global sale igual.
  // Hasta 3 meses atrás: lo más viejo se revisa con el contador, no se timbra solo.
  const months = await query<{ period: string }>(
    `SELECT DISTINCT to_char(paid_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS period FROM billing_payments
     WHERE global_cfdi_id IS NULL AND refunded_cents < total_cents AND to_char(paid_at AT TIME ZONE '${TZ}', 'YYYY-MM') < $1
       AND paid_at > $2::timestamptz - interval '3 months'
       AND NOT EXISTS (SELECT 1 FROM cfdi_invoices x WHERE x.payment_id = billing_payments.id AND x.kind = 'payment' AND x.status <> 'void')
     ORDER BY 1`,
    [mexicoMonth(now), now],
  );
  let created = 0;
  for (const { period } of months) created += await globalFor(period);
  // Lo de más de 3 meses ya no se timbra solo: si quedó un pago sin factura, el superadmin lo revisa con el contador.
  const orphans = (await queryOne<{ n: number; total: string }>(
    `SELECT count(*)::int AS n, coalesce(sum(total_cents), 0)::text AS total FROM billing_payments
     WHERE global_cfdi_id IS NULL AND refunded_cents < total_cents AND paid_at <= $1::timestamptz - interval '3 months'
       AND NOT EXISTS (SELECT 1 FROM cfdi_invoices x WHERE x.payment_id = billing_payments.id AND x.kind = 'payment' AND x.status <> 'void')`,
    [now],
  ))!;
  if (orphans.n && (await countHit(`cfdi-orphans:${now.toISOString().slice(0, 10)}`, 86400_000)) === 1) {
    const text = `${orphans.n} pago(s) por ${(Number(orphans.total) / 100).toFixed(2)} llevan más de 3 meses sin CFDI (ni propio ni en una global). Revísalos con tu contador.`;
    await logEvent({ level: 'error', source: 'admin', message: `Pagos sin CFDI: ${text}` });
    await emailSuperadmin('Pagos sin factura', text).catch(() => undefined);
  }
  return created;
}

/** La global de un mes, una por forma de pago. Devuelve cuántas se crearon. */
async function globalFor(period: string) {
  let created = 0;
  for (const [provider, form] of Object.entries(PAYMENT_FORM)) {
    const done = await withTransaction(async (c) => {
      const pay = `provider = $1 AND global_cfdi_id IS NULL AND refunded_cents < total_cents AND to_char(paid_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $2
        AND NOT EXISTS (SELECT 1 FROM cfdi_invoices x WHERE x.payment_id = billing_payments.id AND x.kind = 'payment' AND x.status <> 'void')`;
      // Un proceso a la vez por mes y forma de pago: así la siguiente global no se crea dos veces.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`cfdi-global:${period}:${form}`]);
      const any = (await c.query(`SELECT 1 FROM billing_payments WHERE ${pay} LIMIT 1`, [provider, period])).rows.length;
      if (!any) return false;
      // Si la global de ese mes ya salió, los pagos que llegaron después van en otra del mismo mes (PAY-22).
      const g = (await c.query(
        `INSERT INTO cfdi_invoices (kind, global_period, payment_form, receiver, seq)
         VALUES ('global', $1, $2, $3, (SELECT coalesce(max(seq), 0) + 1 FROM cfdi_invoices WHERE kind = 'global' AND global_period = $1 AND payment_form = $2))
         ON CONFLICT DO NOTHING RETURNING id`,
        [period, form, JSON.stringify({ ...PUBLIC, zip: config.billing.cfdi.issuerZip })],
      )).rows[0];
      if (!g) return false;
      await c.query(`UPDATE billing_payments SET global_cfdi_id = $3, updated_at = now() WHERE ${pay}`, [provider, period, g.id]);
      return true;
    });
    if (done) created++;
  }
  return created;
}

/**
 * Notas de crédito: un pago ya facturado que después se reembolsó (en todo o en parte) lleva una por lo que falta
 * acreditar. Un CFDI que no ha salido y cuyo pago se reembolsó completo ya no se emite.
 */
async function syncCredits() {
  await query(
    `UPDATE cfdi_invoices c SET status = 'void', updated_at = now() FROM billing_payments p
     WHERE c.payment_id = p.id AND c.kind = 'payment' AND c.status IN ('pending', 'failed') AND p.refunded_cents >= p.total_cents`,
  );
  await withTransaction(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('cfdi-credits'))`);
    await c.query(
      `INSERT INTO cfdi_invoices (kind, account_id, payment_id, related_id, receiver, amount_cents)
       SELECT 'credit', p.account_id, p.id, o.id, o.receiver, p.invoiced_cents - (p.total_cents - p.refunded_cents) - COALESCE(cr.cents, 0)
       FROM billing_payments p
       JOIN cfdi_invoices o ON o.status = 'issued' AND ((o.kind = 'payment' AND o.payment_id = p.id) OR (o.kind = 'global' AND o.id = p.global_cfdi_id))
       LEFT JOIN LATERAL (SELECT sum(amount_cents)::int AS cents FROM cfdi_invoices x WHERE x.kind = 'credit' AND x.payment_id = p.id AND x.status <> 'void') cr ON true
       WHERE p.invoiced_cents > 0 AND p.invoiced_cents - (p.total_cents - p.refunded_cents) - COALESCE(cr.cents, 0) > 0`,
    );
  });
}

const planName = async (key: string) => (await queryOne<{ name: string }>(`SELECT name FROM plans WHERE key = $1`, [key]))?.name || key;
const period = (a: Date | null, b: Date | null) =>
  a && b ? ` del ${a.toLocaleDateString('es-MX', { timeZone: TZ })} al ${b.toLocaleDateString('es-MX', { timeZone: TZ })}` : '';

/** Arma el documento. Devuelve null si ya no hay nada que facturar (todo reembolsado). */
async function build(row: Cfdi): Promise<{ doc: CfdiDocument; invoiced: { id: string; cents: number }[] } | null> {
  const percent = taxPercent();
  if (row.kind === 'payment') {
    const p = await queryOne<any>(`SELECT * FROM billing_payments WHERE id = $1`, [row.payment_id]);
    const net = p ? p.total_cents - p.refunded_cents : 0;
    if (!(net > 0)) return null;
    return {
      doc: { externalId: row.id, type: 'I', receiver: row.receiver, paymentForm: PAYMENT_FORM[p.provider as ProviderName], taxPercent: Number(p.tax_percent ?? percent),
        lines: [{ description: `Suscripción ${await planName(p.plan_key)}${period(p.period_start, p.period_end)}`, cents: net }] },
      invoiced: [{ id: p.id, cents: net }],
    };
  }
  if (row.kind === 'global') {
    const ps = await query<any>(`SELECT * FROM billing_payments WHERE global_cfdi_id = $1 AND refunded_cents < total_cents ORDER BY paid_at`, [row.id]);
    if (!ps.length) return null;
    const [year, months] = row.global_period.split('-');
    const lines = [];
    for (const p of ps) lines.push({ description: `Suscripción ${await planName(p.plan_key)} (pago ${p.provider_payment_id})`, cents: p.total_cents - p.refunded_cents });
    return {
      doc: { externalId: row.id, type: 'I', receiver: row.receiver, paymentForm: row.payment_form, taxPercent: Number(ps[0].tax_percent ?? percent), lines, global: { months, year: Number(year) } },
      invoiced: ps.map((p) => ({ id: p.id, cents: p.total_cents - p.refunded_cents })),
    };
  }
  const origin = await queryOne<Cfdi>(`SELECT * FROM cfdi_invoices WHERE id = $1`, [row.related_id]);
  const p = await queryOne<any>(`SELECT * FROM billing_payments WHERE id = $1`, [row.payment_id]);
  if (!origin || !p || !(row.amount_cents > 0)) return null;
  // Devoluciones (G02) si el régimen del receptor puede deducir; si no (o a público en general), sin efectos fiscales.
  const use = origin.kind === 'payment' && usesFor(origin.receiver.tax_regime).includes('G03') ? 'G02' : 'S01';
  return {
    doc: { externalId: row.id, type: 'E', receiver: { ...origin.receiver, cfdi_use: use }, paymentForm: origin.payment_form || PAYMENT_FORM[p.provider as ProviderName],
      taxPercent: Number(p.tax_percent ?? percent), relatedUuid: origin.sat_uuid, lines: [{ description: `Reembolso del pago ${p.provider_payment_id}`, cents: row.amount_cents }] },
    invoiced: [],
  };
}

/** Avisa al superadmin, al momento (una factura que no sale es urgente). Sin cuenta (la global no es de ninguna) solo por correo. */
async function alertPlatform(accountId: string | null, title: string, body: string) {
  if (accountId) {
    const supers = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'superadmin' AND active`);
    await notifyUsers(accountId, supers.map((s) => s.id), { title, body, link: '#/accounts', kind: 'platform' });
  }
  await emailSuperadmin(title, body, { urgent: true, accountId });
}

async function tellAccount(accountId: string, title: string, body: string) {
  const admins = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [accountId]);
  await notifyUsers(accountId, admins.map((a) => a.id), { title, body, link: '#/plan', kind: 'billing' });
  const mb = await mailBrand(accountId);
  for (const a of admins) await sendMail({ fromName: mb.fromName, to: a.email, subject: title, text: `${body}\n\n${mb.base}/#/plan` });
}

/** Correo al cliente con su factura (PDF y XML). Un fallo aquí no deshace el CFDI: se puede descargar en «Mi plan». */
async function deliver(row: Cfdi) {
  if (row.kind === 'global' || !row.receiver.email) return;
  try {
    const [pdf, xml] = await Promise.all([invoicer.download(row.provider_invoice_id, 'pdf'), invoicer.download(row.provider_invoice_id, 'xml')]);
    const mb = await mailBrand(row.account_id);
    const name = `${row.series}${row.folio}` || row.sat_uuid;
    const credit = row.kind === 'credit';
    await sendMail({
      fromName: mb.fromName,
      to: row.receiver.email,
      subject: credit ? 'Tu nota de crédito' : 'Tu factura',
      text: `Hola,\n\nTe enviamos ${credit ? 'la nota de crédito de tu reembolso' : 'la factura de tu pago'} (folio fiscal ${row.sat_uuid}) a nombre de ${row.receiver.legal_name}, RFC ${row.receiver.rfc}. Van adjuntos el PDF y el XML.\n\nTambién la puedes descargar en Mi plan:\n${mb.base}/#/plan`,
      attachments: [
        { filename: `${name}.pdf`, content: pdf, contentType: 'application/pdf' },
        { filename: `${name}.xml`, content: xml, contentType: 'application/xml' },
      ],
    });
  } catch (e: any) {
    await logEvent({ level: 'warn', source: 'admin', message: `No se pudo enviar por correo el CFDI ${row.sat_uuid}: ${e?.message ?? e}`, accountId: row.account_id ?? undefined });
  }
}

const label = (row: Cfdi) => (row.kind === 'global' ? `factura global de ${fmtMonth(row.global_period)}` : row.kind === 'credit' ? 'nota de crédito' : 'factura');

/** El PAC rechazó los datos (no es una caída): no sirve insistir, hay que corregirlos. */
const rejected = (e: unknown) => e instanceof ProviderError && e.status >= 400 && e.status < 500 && ![401, 403, 408, 429].includes(e.status);

async function attempt(row: Cfdi, now: Date) {
  try {
    const built = await build(row);
    if (!built) {
      await query(`UPDATE cfdi_invoices SET status = 'void', updated_at = now() WHERE id = $1`, [row.id]);
      return;
    }
    // Si el intento anterior sí timbró pero se perdió la respuesta, el CFDI ya existe en el PAC.
    const r = (await invoicer.findByExternal(row.id)) ?? (await invoicer.issue(built.doc));
    const total = built.doc.lines.reduce((s, l) => s + l.cents, 0);
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE cfdi_invoices SET status = 'issued', provider_invoice_id = $2, sat_uuid = $3, series = $4, folio = $5, amount_cents = $6, payment_form = $7,
           issued_at = now(), last_error = '', data_error = false, updated_at = now() WHERE id = $1`,
        [row.id, r.id, r.uuid, r.series, r.folio, total, built.doc.paymentForm],
      );
      for (const p of built.invoiced) await c.query(`UPDATE billing_payments SET invoiced_cents = $2, updated_at = now() WHERE id = $1`, [p.id, p.cents]);
    });
    await logEvent({ level: 'info', source: 'admin', message: `CFDI emitido (${label(row)}): ${r.uuid}`, accountId: row.account_id ?? undefined });
    await deliver({ ...row, provider_invoice_id: r.id, sat_uuid: r.uuid, series: r.series, folio: r.folio });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    const named = row.kind !== 'global' && row.receiver.rfc !== PUBLIC.rfc;
    if (rejected(e)) {
      await query(`UPDATE cfdi_invoices SET status = 'failed', last_error = $2, data_error = $3, updated_at = now() WHERE id = $1`, [row.id, msg, named]);
      await logEvent({ level: 'error', source: 'admin', message: `El PAC rechazó la ${label(row)}: ${msg}`, accountId: row.account_id ?? undefined });
      if (named && row.account_id) {
        await tellAccount(row.account_id, 'No pudimos emitir tu factura', `El SAT no aceptó tus datos de facturación: ${msg.replace(/^Facturapi: /, '')}\n\nRevisa que coincidan con tu Constancia de Situación Fiscal (RFC, nombre o razón social, régimen y código postal) y guárdalos en «Facturación»: la emitimos de nuevo en cuanto los corrijas.`);
      } else await alertPlatform(row.account_id, 'CFDI rechazado por el PAC', `La ${label(row)} (${row.id}) no se pudo emitir: ${msg}`);
      return;
    }
    if (row.attempts >= config.billing.cfdi.maxAttempts) {
      await query(`UPDATE cfdi_invoices SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [row.id, msg]);
      await logEvent({ level: 'error', source: 'admin', message: `CFDI sin emitir tras ${row.attempts} intentos: ${msg}`, accountId: row.account_id ?? undefined });
      await alertPlatform(row.account_id, 'CFDI sin emitir', `La ${label(row)} (${row.id}) no se pudo emitir tras ${row.attempts} intentos: ${msg}. Revisa tu cuenta de Facturapi.`);
      return;
    }
    const wait = BACKOFF_MIN[Math.min(row.attempts - 1, BACKOFF_MIN.length - 1)];
    await query(`UPDATE cfdi_invoices SET last_error = $2, next_attempt_at = $3, updated_at = now() WHERE id = $1`, [row.id, msg, new Date(now.getTime() + wait * 60_000)]);
    await logEvent({ level: 'warn', source: 'admin', message: `CFDI: intento ${row.attempts} fallido, se reintenta en ${wait} min: ${msg}`, accountId: row.account_id ?? undefined });
  }
}

/** Emite lo pendiente. Idempotente: se puede correr desde varios procesos a la vez. */
export async function processCfdi(now = new Date(), limit = 20) {
  await syncCredits();
  if (!invoicer.enabled()) return 0;
  // Una a la vez: la reserva (LEASE_MIN) cubre solo la que se está emitiendo, así otra revisión no toma a medio lote
  // una que sigue esperando su turno aquí.
  let done = 0;
  while (done < limit) {
    const row = await queryOne<Cfdi>(
      `UPDATE cfdi_invoices SET attempts = attempts + 1, next_attempt_at = $1::timestamptz + make_interval(mins => $2), updated_at = now()
       WHERE id = (
         -- GREATEST: lo que se acaba de crear en esta misma revisión (notas de crédito) también entra.
         SELECT c.id FROM cfdi_invoices c WHERE c.status = 'pending' AND c.next_attempt_at <= GREATEST($1::timestamptz, now())
           -- Una nota de crédito espera a que salga el CFDI que corrige.
           AND (c.kind <> 'credit' OR EXISTS (SELECT 1 FROM cfdi_invoices o WHERE o.id = c.related_id AND o.status = 'issued'))
         ORDER BY c.next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [now, LEASE_MIN],
    );
    if (!row) break;
    await attempt(row, now);
    done++;
  }
  return done;
}

/** CFDI de los pagos de una cuenta para «Mi plan»: el propio, la global en la que entró y sus notas de crédito. */
export async function cfdiForPayments(ids: string[]) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const rows = await query<Cfdi>(`SELECT * FROM cfdi_invoices WHERE payment_id = ANY($1::uuid[]) AND kind IN ('payment', 'credit') ORDER BY created_at`, [ids]);
  const globals = await query<{ id: string; status: string }>(
    `SELECT p.id, g.status FROM billing_payments p JOIN cfdi_invoices g ON g.id = p.global_cfdi_id WHERE p.id = ANY($1::uuid[])`, [ids]);
  for (const id of ids) out.set(id, { status: 'none', credits: [] });
  for (const g of globals) out.set(g.id, { status: 'global', credits: [] });
  for (const r of rows) {
    const o = out.get(r.payment_id!);
    if (r.status === 'void') continue;
    if (r.kind === 'credit') o.credits.push({ id: r.id, status: r.status, amount: r.amount_cents / 100 });
    else Object.assign(o, { id: r.id, status: r.status, error: r.data_error ? r.last_error.replace(/^Facturapi: /, '') : '' });
  }
  return out;
}

export const getCfdi = (id: string) => queryOne<Cfdi>(`SELECT * FROM cfdi_invoices WHERE id = $1`, [id]);

/** Resumen para el superadmin. */
export const cfdiCounts = () => query<{ kind: string; status: string; n: number }>(`SELECT kind, status, count(*)::int AS n FROM cfdi_invoices GROUP BY 1, 2 ORDER BY 1, 2`);
