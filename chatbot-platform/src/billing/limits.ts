/**
 * Límites reales por plan: mensajes del asistente al mes, canales, usuarios y asistentes.
 *
 * Cómo se decide el límite de una cuenta (el primero que exista):
 *   1. excepción del superadmin (accounts.limits_override)
 *   2. los límites de su plan contratado (plans.limits)
 *   3. los de la prueba gratuita (TRIAL_MAX_*), si está en prueba
 *   4. sin límite (cuentas activadas a mano, sin plan)
 */
import { z } from 'zod';
import { HttpError } from '../access.js';
import { notifyUsers } from '../automation/store.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { sendMail } from '../mailer.js';

export const LIMIT_KEYS = ['messages_per_month', 'channels', 'users', 'chatbots'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Partial<Record<LimitKey, number | null>>;

const Limit = z.number().int().min(1).max(100_000_000).nullable().optional();
export const LimitsSchema = z.object({ messages_per_month: Limit, channels: Limit, users: Limit, chatbots: Limit }).strict();

export const LIMIT_LABELS: Record<LimitKey, { singular: string; plural: string }> = {
  messages_per_month: { singular: 'mensaje del asistente al mes', plural: 'mensajes del asistente al mes' },
  channels: { singular: 'canal', plural: 'canales' },
  users: { singular: 'usuario', plural: 'usuarios' },
  chatbots: { singular: 'asistente', plural: 'asistentes' },
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
  return out;
}

export interface EffectiveLimits {
  limits: Limits;
  source: 'override' | 'plan' | 'trial' | 'none';
  plan_key: string;
}

export async function effectiveLimits(accountId: string): Promise<EffectiveLimits> {
  const acc = await queryOne<{ status: string; plan: string; limits_override: unknown }>(`SELECT status, plan, limits_override FROM accounts WHERE id = $1`, [accountId]);
  if (!acc) return { limits: {}, source: 'none', plan_key: '' };
  const override = clean(acc.limits_override);
  const plan = acc.plan ? await queryOne<{ limits: unknown }>(`SELECT limits FROM plans WHERE key = $1`, [acc.plan]) : null;
  const base = plan ? clean(plan.limits) : acc.status === 'trial' ? trialLimits() : {};
  const source = Object.keys(override).length ? 'override' : plan ? 'plan' : acc.status === 'trial' ? 'trial' : 'none';
  // La excepción puede cambiar solo algunos límites: el resto sigue el plan.
  return { limits: { ...base, ...override }, source, plan_key: acc.plan };
}

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export async function messagesUsed(accountId: string, month = monthKey()): Promise<number> {
  return (await queryOne<{ messages: number }>(`SELECT messages FROM usage_counters WHERE account_id = $1 AND month = $2`, [accountId, month]))?.messages ?? 0;
}

export interface Usage {
  messages_per_month: number;
  channels: number;
  users: number;
  chatbots: number;
}

export async function usageOf(accountId: string): Promise<Usage> {
  const r = await queryOne<{ channels: number; users: number; chatbots: number }>(
    `SELECT (SELECT count(*)::int FROM channels WHERE account_id = $1 AND type <> 'playground') AS channels,
            (SELECT count(*)::int FROM users WHERE account_id = $1 AND active) AS users,
            (SELECT count(*)::int FROM chatbots WHERE account_id = $1) AS chatbots`,
    [accountId],
  );
  return { messages_per_month: await messagesUsed(accountId), channels: r?.channels ?? 0, users: r?.users ?? 0, chatbots: r?.chatbots ?? 0 };
}

/** Falla con un mensaje claro si crear `adding` más de este recurso pasa el límite de la cuenta. */
export async function assertWithinLimit(accountId: string, key: Exclude<LimitKey, 'messages_per_month'>, adding = 1) {
  const { limits, source } = await effectiveLimits(accountId);
  const max = limits[key];
  if (!max) return;
  const used = (await usageOf(accountId))[key];
  if (used + adding > max) {
    const who = source === 'trial' ? 'Tu periodo de prueba permite' : 'Tu plan permite';
    const l = LIMIT_LABELS[key];
    throw new HttpError(403, `${who} hasta ${max} ${max === 1 ? l.singular : l.plural} y ya tienes ${used}. Para agregar más, cambia de plan en Ajustes → Mi plan y pagos.`, ['limit_reached']);
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
  const body = full
    ? `Tu asistente ya envió los ${max.toLocaleString('es-MX')} mensajes que incluye tu plan este mes, así que dejó de responder solo. Sube de plan para que siga atendiendo; el contador se reinicia el día 1.`
    : `Tu asistente lleva ${used.toLocaleString('es-MX')} de ${max.toLocaleString('es-MX')} mensajes de tu plan este mes (80 %). Cuando llegue al 100 % dejará de responder solo.`;
  await notifyUsers(accountId, admins.map((a) => a.id), { title, body, link: '#/plan', kind: 'billing' });
  for (const a of admins) await sendMail({ to: a.email, subject: title, text: `${body}\n\n${config.publicBaseUrl}/#/plan` });
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
