/**
 * Plan único de Riverrun: un solo plan mensual con dos precios, 5,000 MXN + IVA (México) y 270 USD sin IVA (Estados
 * Unidos). Lo aplica `./riverrun plan-unico` (src/cli/single-plan.ts): crea o actualiza los dos y apaga los demás planes
 * sin borrarlos (quien ya pagaba uno lo conserva hasta cambiarse).
 *
 * Los límites cubren lo que paga la plataforma por cada negocio: Zernio cobra por red conectada (6 USD al mes en su
 * tarifa más alta) y por mensaje enviado (0.0001 USD), y la IA se corta en `ai_usd_per_month`. En el peor mes (todo al
 * tope) cuesta 111 USD de los 270 que se cobran; ver worstMonthCostUsd y docs/plan-unico.md.
 */
import { withTransaction } from '../db.js';
import type { Limits } from './limits.js';

/** Tarifas de Zernio (zernio.com/pricing, noviembre de 2026): la más alta por red conectada y la de cada mensaje enviado. */
export const ZERNIO_USD_PER_SOCIAL_ACCOUNT = 6;
export const ZERNIO_USD_PER_MESSAGE = 0.0001;

const LIMITS: Limits = { messages_per_month: 10_000, channels: 10, social_accounts: 10, users: 10, chatbots: 5, storage_mb: 5120 };
const AI_USD_PER_MONTH = 50;
const DESCRIPTION = 'Todo Riverrun para tu negocio: asistente en WhatsApp y redes sociales, cotizaciones, agenda y cobros.';

export interface SinglePlan {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: 'MXN' | 'USD';
  interval: 'month';
  public: boolean;
  limits: Limits;
  ai_usd_per_month: number;
}

/** Los dos precios del plan. El de dólares queda privado hasta que la versión en inglés lo publique (`usdPublic`). */
export function singlePlans(o: { usdPublic?: boolean } = {}): [SinglePlan, SinglePlan] {
  const base = { name: 'Riverrun', description: DESCRIPTION, interval: 'month' as const, limits: { ...LIMITS }, ai_usd_per_month: AI_USD_PER_MONTH };
  return [
    { ...base, key: 'riverrun', price: 5000, currency: 'MXN', public: true },
    { ...base, key: 'riverrun-usd', price: 270, currency: 'USD', public: !!o.usdPublic },
  ];
}

/** Lo más que le puede costar a la plataforma un negocio en un mes con este plan, en USD (sin contar el servidor). */
export function worstMonthCostUsd(limits: Limits, aiUsd: number): number {
  return (limits.social_accounts ?? 0) * ZERNIO_USD_PER_SOCIAL_ACCOUNT + (limits.messages_per_month ?? 0) * ZERNIO_USD_PER_MESSAGE + aiUsd;
}

/**
 * Crea o actualiza los dos precios del plan y apaga los demás planes activos. Devuelve las claves que apagó. Borra el ID
 * de precio de Stripe que tuvieran: Stripe cobra el monto de este archivo (con IVA si es en pesos), no uno viejo.
 */
export async function applySinglePlan(o: { usdPublic?: boolean } = {}): Promise<{ plans: string[]; deactivated: string[] }> {
  const plans = singlePlans(o);
  return withTransaction(async (c) => {
    for (const [i, p] of plans.entries()) {
      await c.query(
        `INSERT INTO plans (key, name, description, price_cents, currency, active, sort_order, limits, billing_interval, ai_usd_per_month, public)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10)
         ON CONFLICT (key) DO UPDATE SET name = $2, description = $3, price_cents = $4, currency = $5, active = true, sort_order = $6,
           stripe_price_id = '', limits = $7, billing_interval = $8, ai_usd_per_month = $9, public = $10`,
        [p.key, p.name, p.description, Math.round(p.price * 100), p.currency, i, JSON.stringify(p.limits), p.interval, p.ai_usd_per_month, p.public],
      );
    }
    const off = await c.query<{ key: string }>(`UPDATE plans SET active = false WHERE active AND NOT (key = ANY($1)) RETURNING key`, [plans.map((p) => p.key)]);
    return { plans: plans.map((p) => p.key), deactivated: off.rows.map((r) => r.key) };
  });
}
