/**
 * ¿Puede arrancar otro pedido al Copiloto? Los mismos límites para un pedido escrito y para uno que sigue solo después de
 * confirmar («Confirmar y seguir»): IA permitida en la cuenta, pedidos por hora y por día, tope de gasto del día y que el
 * presupuesto de IA no esté por acabarse (para no dejar sin IA al agente que atiende a los clientes).
 */
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { budgetPolicy, normalize, platformAiCap } from '../ai/budget.js';
import { assertAiAllowed } from '../ai/gate.js';
import * as cs from './store.js';

/** ¿El gasto de IA ya pasó el 80 % de un límite? Así el Copiloto no deja sin IA al agente que atiende a los clientes. */
export async function budgetTight(accountId: string): Promise<boolean> {
  const { settings } = await budgetPolicy(accountId);
  const model = normalize(config.copilot.model);
  const caps = [
    ...(settings.monthly_usd !== null ? [{ period: 'month', limit: settings.monthly_usd, model: null as string | null }] : []),
    ...(settings.daily_usd !== null ? [{ period: 'day', limit: settings.daily_usd, model: null as string | null }] : []),
    ...settings.models.filter((m) => normalize(m.model) === model).map((m) => ({ period: m.period, limit: m.limit_usd, model })),
  ];
  for (const cap of caps) {
    if (cap.limit <= 0) return true;
    const [row] = await query<{ used: string }>(
      `SELECT coalesce(sum(coalesce(charged_usd, reserved_usd)), 0) AS used FROM ai_spend
        WHERE account_id = $1 AND created_at >= date_trunc($2, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND ($3::text IS NULL OR $3 = ANY(models)) AND state <> 'rejected'`,
      [accountId, cap.period, cap.model],
    );
    if (Number(row.used) >= cap.limit * 0.8) return true;
  }
  // PAY-6: el tope de la plataforma (plan, prueba o excepción de la cuenta) también: una cuenta sin cupo no usa el Copiloto.
  const platform = await platformAiCap(accountId);
  if (platform !== null) {
    if (platform <= 0) return true;
    const [row] = await query<{ used: string }>(
      `SELECT coalesce(sum(coalesce(charged_usd, reserved_usd)), 0) AS used FROM ai_spend
        WHERE account_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND state <> 'rejected'`,
      [accountId],
    );
    if (Number(row.used) >= platform * 0.8) return true;
  }
  return false;
}

/**
 * Revisa los límites y devuelve cuánto puede gastar el pedido (lo que le queda a la cuenta en el día), o lanza el error
 * que se le muestra a la persona.
 */
export async function turnAllowance(userId: string, accountId: string): Promise<{ maxUsd?: number }> {
  await assertAiAllowed(accountId);
  const used = await cs.recentTurns(userId, accountId);
  if (used.user_hour >= config.copilot.turnsPerHour) throw new HttpError(429, 'Llegaste al límite de pedidos al Copiloto por hora; intenta en un rato');
  if (used.account_day >= config.copilot.accountTurnsPerDay) throw new HttpError(429, 'La cuenta llegó al límite de pedidos al Copiloto de hoy');
  const dayCap = config.copilot.accountUsdPerDay;
  if (dayCap > 0 && used.account_day_usd >= dayCap) throw new HttpError(429, 'La cuenta llegó al tope de gasto del Copiloto de las últimas 24 horas; intenta más tarde');
  if (await budgetTight(accountId)) throw new HttpError(409, 'El presupuesto de IA de la cuenta está por acabarse: el Copiloto se pausa para no dejar sin IA a tu agente. Revísalo en Consumo de IA.');
  // Un pedido no gasta más de lo que le queda a la cuenta en el día.
  return { maxUsd: dayCap > 0 ? dayCap - used.account_day_usd : undefined };
}
