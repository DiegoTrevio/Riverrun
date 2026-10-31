/**
 * Límites reales por plan: mensajes del asistente al mes, canales, usuarios, asistentes y redes sociales conectadas
 * (cada cuenta conectada en Zernio la paga la plataforma).
 *
 * Cómo se decide el límite de una cuenta (el primero que exista):
 *   1. excepción del superadmin (accounts.limits_override)
 *   2. los límites de su plan contratado (plans.limits)
 *   3. los de la prueba gratuita (TRIAL_MAX_*), si está en prueba
 *   4. sin límite (cuentas activadas a mano, sin plan)
 */
import { mailBrand } from '../brands.js';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { notifyUsers } from '../automation/store.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';

/** Una conexión de transacción (con su candado) o, sin ella, el pool: dentro de un candado no se pide otra conexión. */
type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
const one = async <T extends Record<string, any>>(q: Q | undefined, sql: string, args: unknown[]): Promise<T | null> => (q ? ((await q.query(sql, args)).rows[0] as T | undefined) ?? null : queryOne<T>(sql, args));
const many = async <T extends Record<string, any>>(q: Q | undefined, sql: string, args: unknown[] = []): Promise<T[]> => (q ? ((await q.query(sql, args)).rows as T[]) : query<T>(sql, args));
import { sendMail } from '../mailer.js';
import { logEvent } from '../logs.js';
import { chargeCents } from './tax.js';

export const LIMIT_KEYS = ['messages_per_month', 'channels', 'users', 'chatbots', 'social_accounts'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Partial<Record<LimitKey, number | null>>;

const Limit = z.number().int().min(1).max(100_000_000).nullable().optional();
export const LimitsSchema = z.object({ messages_per_month: Limit, channels: Limit, users: Limit, chatbots: Limit, social_accounts: Limit }).strict();

export const LIMIT_LABELS: Record<LimitKey, { singular: string; plural: string }> = {
  messages_per_month: { singular: 'mensaje del asistente al mes', plural: 'mensajes del asistente al mes' },
  channels: { singular: 'canal', plural: 'canales' },
  users: { singular: 'usuario', plural: 'usuarios' },
  chatbots: { singular: 'asistente', plural: 'asistentes' },
  social_accounts: { singular: 'red social conectada', plural: 'redes sociales conectadas' },
};

const clean = (l: unknown): Limits => {
  const out: Limits = {};
  const src = (l ?? {}) as Record<string, unknown>;
  for (const k of LIMIT_KEYS) if (typeof src[k] === 'number' && Number.isInteger(src[k]) && (src[k] as number) > 0) out[k] = src[k] as number;
  return out;
};

export function trialLimits(): Limits {
  const t = config.signup.trialLimits;
  const out: Limits = {};
  if (t.messages > 0) out.messages_per_month = t.messages;
  if (t.channels > 0) out.channels = t.channels;
  if (t.users > 0) out.users = t.users;
  if (t.chatbots > 0) out.chatbots = t.chatbots;
  if (t.socialAccounts > 0) out.social_accounts = t.socialAccounts;
  return out;
}

export interface EffectiveLimits {
  limits: Limits;
  source: 'override' | 'plan' | 'trial' | 'none';
  plan_key: string;
}

export async function effectiveLimits(accountId: string, q?: Q): Promise<EffectiveLimits> {
  const acc = await one<{ status: string; plan: string; limits_override: unknown }>(q, `SELECT status, plan, limits_override FROM accounts WHERE id = $1`, [accountId]);
  if (!acc) return { limits: {}, source: 'none', plan_key: '' };
  const override = clean(acc.limits_override);
  const plan = acc.plan ? await one<{ limits: unknown }>(q, `SELECT limits FROM plans WHERE key = $1`, [acc.plan]) : null;
  // Un plan que ya no existe (clave mal escrita o borrada) no puede dejar a la cuenta sin límites: se aplican los de prueba.
  const missingPlan = !!acc.plan && !plan;
  if (missingPlan) await logEvent({ level: 'error', source: 'admin', message: `La cuenta tiene el plan "${acc.plan}", que no existe; se aplican límites restrictivos`, accountId });
  const base = plan ? clean(plan.limits) : acc.status === 'trial' || missingPlan ? trialLimits() : {};
  const source = Object.keys(override).length ? 'override' : plan ? 'plan' : acc.status === 'trial' || missingPlan ? 'trial' : 'none';
  // La excepción puede cambiar solo algunos límites: el resto sigue el plan.
  return { limits: { ...base, ...override }, source, plan_key: acc.plan };
}

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export async function messagesUsed(accountId: string, month = monthKey(), q?: Q): Promise<number> {
  return (await one<{ messages: number }>(q, `SELECT messages FROM usage_counters WHERE account_id = $1 AND month = $2`, [accountId, month]))?.messages ?? 0;
}

export interface Usage {
  messages_per_month: number;
  channels: number;
  users: number;
  chatbots: number;
  social_accounts: number;
}

export async function usageOf(accountId: string, q?: Q): Promise<Usage> {
  const r = await one<{ channels: number; users: number; chatbots: number; social_accounts: number }>(q,
    `SELECT (SELECT count(*)::int FROM channels WHERE account_id = $1 AND type <> 'playground') AS channels,
            (SELECT count(*)::int FROM users WHERE account_id = $1 AND active) AS users,
            (SELECT count(*)::int FROM chatbots WHERE account_id = $1) AS chatbots,
            (SELECT count(*)::int FROM social_accounts WHERE account_id = $1 AND status <> 'disconnected') AS social_accounts`,
    [accountId],
  );
  return {
    messages_per_month: await messagesUsed(accountId, monthKey(), q), channels: r?.channels ?? 0, users: r?.users ?? 0, chatbots: r?.chatbots ?? 0, social_accounts: r?.social_accounts ?? 0,
  };
}

export interface UpgradeOffer {
  key: string;
  name: string;
  /** Precio sin IVA por periodo, total con IVA y cuánto permite del límite que se topó (null = sin límite). */
  price: number;
  total: number;
  currency: string;
  interval: 'month' | 'year';
  allows: number | null;
}

/**
 * Plan al que conviene subir para tener `needed` de `key`: de los que se ofrecen, uno que lo permite y en el que cabe
 * todo lo que la cuenta ya usa; primero los del mismo periodo que su plan (mensual si no tiene) y, entre ellos, el más
 * barato. null si ningún plan alcanza (o no hay planes).
 */
export async function nextPlanFor(accountId: string, key: LimitKey, needed: number, q?: Q): Promise<UpgradeOffer | null> {
  const [acc, used, plans] = await Promise.all([
    one<{ plan: string }>(q, `SELECT plan FROM accounts WHERE id = $1`, [accountId]),
    usageOf(accountId, q),
    many<{ key: string; name: string; price_cents: number; currency: string; billing_interval: 'month' | 'year'; limits: unknown }>(q, `SELECT key, name, price_cents, currency, billing_interval, limits FROM plans WHERE active`),
  ]);
  const fits = (max: number | null | undefined, n: number) => !max || max >= n;
  const monthly = (p: { price_cents: number; billing_interval: string }) => (p.billing_interval === 'year' ? p.price_cents / 12 : p.price_cents);
  // Quien paga cada mes no debería ver como "siguiente plan" un compromiso anual solo por salir más barato al mes.
  const period = plans.find((p) => p.key === acc?.plan)?.billing_interval ?? 'month';
  const best = plans
    .map((p) => ({ ...p, lim: clean(p.limits) }))
    .filter((p) => p.key !== acc?.plan && fits(p.lim[key], needed) && LIMIT_KEYS.every((k) => k === key || k === 'messages_per_month' || fits(p.lim[k], used[k])))
    .sort((a, b) => Number(a.billing_interval !== period) - Number(b.billing_interval !== period) || monthly(a) - monthly(b))[0];
  if (!best) return null;
  return { key: best.key, name: best.name, price: best.price_cents / 100, total: chargeCents(best) / 100, currency: best.currency, interval: best.billing_interval, allows: best.lim[key] ?? null };
}

/** Lo que el panel necesita para ofrecer subir de plan al topar un límite. */
export async function limitDetail(accountId: string, key: LimitKey, used: number, max: number, q?: Q) {
  return { key, label: LIMIT_LABELS[key].plural, used, max, next_plan: await nextPlanFor(accountId, key, Math.max(used, max) + 1, q) };
}

/** "El plan Pro incluye hasta 5 canales" / "…sin límite de canales". */
export const offerText = (o: UpgradeOffer, key: LimitKey) =>
  `El plan ${o.name} incluye ${o.allows ? `hasta ${o.allows.toLocaleString('es-MX')} ${o.allows === 1 ? LIMIT_LABELS[key].singular : LIMIT_LABELS[key].plural}` : `${LIMIT_LABELS[key].plural} sin límite`}.`;

/**
 * Como assertWithinLimit, pero dentro de la transacción que va a crear el recurso y con la fila de la cuenta bloqueada:
 * dos pedidos a la vez se forman y el segundo cuenta lo que el primero ya creó (PAY-19). Sin esto, 20 pedidos
 * simultáneos pasaban todos la cuenta antes de que alguno insertara.
 */
export async function assertWithinLimitLocked(client: Q, accountId: string, key: Exclude<LimitKey, 'messages_per_month'>, adding = 1) {
  await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  // Todo con la misma conexión: con el candado tomado, pedir otra al pool puede quedarse esperando a que se libere una
  // que ocupan los demás pedidos formados detrás de este candado.
  await assertWithinLimit(accountId, key, adding, client);
}

/** Falla con un mensaje claro si crear `adding` más de este recurso pasa el límite de la cuenta. */
export async function assertWithinLimit(accountId: string, key: Exclude<LimitKey, 'messages_per_month'>, adding = 1, q?: Q) {
  const { limits, source } = await effectiveLimits(accountId, q);
  const max = limits[key];
  if (!max) return;
  const used = (await usageOf(accountId, q))[key];
  if (used + adding > max) {
    const who = source === 'trial' ? 'Tu periodo de prueba permite' : 'Tu plan permite';
    const l = LIMIT_LABELS[key];
    const detail = await limitDetail(accountId, key, used, max, q);
    const offer = detail.next_plan ? ` ${offerText(detail.next_plan, key)}` : '';
    throw new HttpError(403, `${who} hasta ${max} ${max === 1 ? l.singular : l.plural} y ya tienes ${used}.${offer} Para agregar más, cambia de plan en Ajustes → Mi plan y pagos.`, ['limit_reached'], { limit: detail });
  }
}

export interface MessageQuota {
  max: number | null;
  used: number;
  remaining: number | null;
  reached: boolean;
}

export async function messageQuota(accountId: string): Promise<MessageQuota> {
  const { limits } = await effectiveLimits(accountId);
  const max = limits.messages_per_month ?? null;
  const used = await messagesUsed(accountId);
  return { max, used, remaining: max === null ? null : Math.max(0, max - used), reached: max !== null && used >= max };
}

/** Suma un mensaje enviado por el asistente o las automatizaciones y avisa al llegar al 80 % y al 100 %. */
export async function recordMessage(accountId: string, now = new Date()) {
  const month = monthKey(now);
  const row = await queryOne<{ messages: number }>(
    `INSERT INTO usage_counters (account_id, month, messages) VALUES ($1, $2, 1)
     ON CONFLICT (account_id, month) DO UPDATE SET messages = usage_counters.messages + 1 RETURNING messages`,
    [accountId, month],
  );
  const used = row?.messages ?? 0;
  const { limits } = await effectiveLimits(accountId);
  const max = limits.messages_per_month;
  if (!max) return;
  if (used >= max) await notifyLimit(accountId, 'messages_100', month, used, max);
  else if (used >= Math.ceil(max * 0.8)) await notifyLimit(accountId, 'messages_80', month, used, max);
}

async function notifyLimit(accountId: string, notice: 'messages_80' | 'messages_100', month: string, used: number, max: number) {
  // Se avisa una sola vez por mes y umbral (la marca se pone primero: evita avisos dobles con envíos simultáneos).
  const claimed = await queryOne<{ id: string }>(
    `UPDATE accounts SET limit_notices = limit_notices || jsonb_build_object($2::text, $3::text) WHERE id = $1 AND COALESCE(limit_notices->>$2, '') <> $3 RETURNING id`,
    [accountId, notice, month],
  );
  if (!claimed) return;
  const admins = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [accountId]);
  const full = notice === 'messages_100';
  const title = full ? 'Llegaste al límite de mensajes de tu plan' : 'Estás por llegar al límite de mensajes de tu plan';
  // El plan sugerido va en el texto y el enlace lo deja elegido en Mi plan (un clic para subir).
  const next = await nextPlanFor(accountId, 'messages_per_month', max + 1);
  const suggest = next ? ` ${offerText(next, 'messages_per_month')}` : '';
  const body = full
    ? `Tu asistente ya envió los ${max.toLocaleString('es-MX')} mensajes que incluye tu plan este mes, así que dejó de responder solo. Sube de plan para que siga atendiendo; el contador se reinicia el día 1.${suggest}`
    : `Tu asistente lleva ${used.toLocaleString('es-MX')} de ${max.toLocaleString('es-MX')} mensajes de tu plan este mes (80 %). Cuando llegue al 100 % dejará de responder solo.${suggest}`;
  const link = next ? `#/plan?subir=${encodeURIComponent(next.key)}` : '#/plan';
  await notifyUsers(accountId, admins.map((a) => a.id), { title, body, link, kind: 'billing' });
  const mb = await mailBrand(accountId);
  for (const a of admins) await sendMail({ fromName: mb.fromName, to: a.email, subject: title, text: `${body}\n\n${next ? `Subir al plan ${next.name}: ` : ''}${mb.base}/${link}` });
}

/** Resumen para el panel: límite, uso y porcentaje de cada recurso. */
export async function limitsReport(accountId: string) {
  const [eff, usage] = await Promise.all([effectiveLimits(accountId), usageOf(accountId)]);
  return {
    source: eff.source,
    items: LIMIT_KEYS.map((k) => ({
      key: k,
      label: LIMIT_LABELS[k].plural,
      used: usage[k],
      max: eff.limits[k] ?? null,
      percent: eff.limits[k] ? Math.min(100, Math.round((usage[k] / eff.limits[k]!) * 100)) : null,
    })),
  };
}

/** Se pidió responder pero el cupo del mes ya se agotó: avisa (una vez al mes) por si el límite cambió a mitad de mes. */
export async function noticeMessagesReached(accountId: string) {
  const q = await messageQuota(accountId);
  if (q.max) await notifyLimit(accountId, 'messages_100', monthKey(), q.used, q.max);
}
