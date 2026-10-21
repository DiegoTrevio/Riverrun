/** Cobro automático: planes (los define el superadmin), contratar, administrar el pago y avisos de Stripe / Mercado Pago. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { baseFor } from '../brands.js';
import { providers, applyState, confirmCheckout, enabledProviders, getPlan, getSubscription, listPlans, payable, recordEvent, startCheckout } from '../billing/service.js';
import { applyRefund, listPayments, recordPayment } from '../billing/payments.js';
import { chargeCents, taxPercent } from '../billing/tax.js';
import { ProviderError, WebhookError, type Plan, type ProviderName, type WebhookResult } from '../billing/types.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { limitsReport, LimitsSchema } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import { parse } from './util.js';

const PlanBody = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Clave: minúsculas, números, guion y guion bajo'),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(400).default(''),
  /** Precio sin IVA por periodo (mes o año). */
  price: z.number().positive().max(10_000_000),
  interval: z.enum(['month', 'year']).default('month'),
  currency: z.string().length(3).transform((c) => c.toUpperCase()).default('MXN'),
  stripe_price_id: z.string().max(120).default(''),
  active: z.boolean().default(true),
  sort_order: z.number().int().default(0),
  /** Límites del plan; vacío o ausente = sin límite. */
  limits: LimitsSchema.default({}),
});

const publicSub = (s: any) =>
  s && { provider: s.provider, plan_key: s.plan_key, status: s.status, current_period_end: s.current_period_end, cancel_at_period_end: s.cancel_at_period_end, past_due_since: s.past_due_since, can_portal: s.provider === 'stripe' && !!s.provider_customer_id };

/** Plan para el panel: precio sin IVA, IVA y total que se cobra. */
const planOut = (p: any) => ({ ...p, price: p.price_cents / 100, interval: p.billing_interval, tax_percent: taxPercent(), total: chargeCents(p) / 100 });

const paymentOut = (p: any) => ({
  id: p.id, provider: p.provider, plan_key: p.plan_key, currency: p.currency, paid_at: p.paid_at, period_start: p.period_start, period_end: p.period_end, status: p.status,
  total: p.total_cents / 100, subtotal: p.subtotal_cents / 100, tax: p.tax_cents / 100, tax_percent: Number(p.tax_percent), refunded: p.refunded_cents / 100,
});

/**
 * Anota el cobro o el reembolso que trae un aviso. El cobro se asocia a la cuenta de su suscripción (la suscripción del
 * proveedor siempre trae la cuenta); un cobro sin cuenta no es de esta plataforma (otro producto en la misma cuenta del
 * proveedor) y solo se registra en la bitácora.
 */
async function recordMoney(name: ProviderName, result: WebhookResult, accountId: string | null) {
  if (result.payment) {
    const sub = await queryOne<{ account_id: string; plan_key: string }>(
      `SELECT account_id, plan_key FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`, [name, result.payment.subscriptionId]);
    const account = accountId ?? sub?.account_id ?? null;
    const planKey = result.state?.planKey || sub?.plan_key || '';
    if (!account) await logEvent({ level: 'warn', source: 'system', message: `Cobro ${result.payment.paymentId} (${name}) sin cuenta de la plataforma: no se registra` });
    else if (await recordPayment({ accountId: account, provider: name, planKey, payment: result.payment })) {
      await logEvent({ level: 'info', source: 'admin', message: `Pago recibido (${name}): ${result.payment.totalCents / 100} ${result.payment.currency}`, accountId: account });
    }
  }
  if (result.refund) {
    const p = await applyRefund(name, result.refund);
    if (p) await logEvent({ level: 'warn', source: 'admin', message: `Reembolso (${name}): pago ${p.status === 'refunded' ? 'reembolsado completo' : 'reembolsado en parte'}`, accountId: p.account_id ?? undefined });
  }
}

/** Planes que se pueden contratar, con los proveedores que los cobran (para "Mi plan" y el registro). */
export async function offeredPlans() {
  const on = enabledProviders();
  return (await listPlans()).map((p: Plan) => ({ ...planOut(p), providers: on.filter((x) => x.supportsPlan(p)).map((x) => ({ name: x.name, label: x.label })) }));
}

/** Rutas públicas: los proveedores avisan aquí. La firma se verifica sobre el cuerpo original. */
export async function billingWebhooks(app: FastifyInstance) {
  // Regreso desde la página de pago. Va al panel en el mismo dominio (y con la misma sesión) desde el que se pagó; el
  // panel confirma el pago con el proveedor. Una ruta sin "#" evita que el proveedor rompa la dirección al agregarle datos.
  app.get('/pago/:provider', async (req: any, reply) => {
    const canceled = req.query?.estado === 'cancelado';
    return reply.redirect(canceled ? '/#/plan?pago=cancelado' : '/#/plan?pago=ok');
  });

  for (const name of Object.keys(providers) as ProviderName[]) {
    app.post(`/webhook/billing/${name}`, async (req, reply) => {
      const provider = providers[name];
      if (!provider.enabled()) return reply.code(404).send({ error: 'No configurado' });
      try {
        const result = await provider.handleWebhook({ rawBody: req.rawBody ?? Buffer.alloc(0), headers: req.headers, query: req.query as Record<string, string | undefined>, plans: await listPlans(true) });
        if (!result) return { ok: true };
        // Primero se anota el aviso: si ya se procesó, no se repite. Si falla el proceso, se libera para que el proveedor reintente.
        if (!(await recordEvent(name, result.eventId, result.type, null))) return { ok: true };
        try {
          const accountId = result.state ? await applyState(result.state) : null;
          await recordMoney(name, result, accountId);
          if (accountId) await query(`UPDATE billing_events SET account_id = $3 WHERE provider = $1 AND event_id = $2`, [name, result.eventId, accountId]);
        } catch (e) {
          await query(`DELETE FROM billing_events WHERE provider = $1 AND event_id = $2`, [name, result.eventId]);
          throw e;
        }
        return { ok: true };
      } catch (e: any) {
        if (e instanceof WebhookError) return reply.code(400).send({ error: e.message });
        await logEvent({ level: 'error', source: 'system', message: `Aviso de cobro (${name}): ${e?.message ?? e}` });
        // 500: el proveedor reintenta más tarde.
        return reply.code(500).send({ error: 'No se pudo procesar' });
      }
    });
  }
}

export async function billingRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };
  const supers = { preHandler: requireRole('superadmin') };

  /* ------------------------------ Planes ------------------------------ */
  api.get('/api/plans', admins, async (req) => (await listPlans(req.user.role === 'superadmin')).map(planOut));

  const savePlan = async (b: z.infer<typeof PlanBody>) => {
    const cents = Math.round(b.price * 100);
    await query(
      `INSERT INTO plans (key, name, description, price_cents, currency, stripe_price_id, active, sort_order, limits, billing_interval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (key) DO UPDATE SET name = $2, description = $3, price_cents = $4, currency = $5, stripe_price_id = $6, active = $7, sort_order = $8, limits = $9, billing_interval = $10`,
      [b.key, b.name, b.description, cents, b.currency, b.stripe_price_id.trim(), b.active, b.sort_order, JSON.stringify(Object.fromEntries(Object.entries(b.limits).filter(([, v]) => v))), b.interval],
    );
    return planOut(await getPlan(b.key));
  };
  api.post('/api/plans', supers, async (req) => savePlan(parse(PlanBody, req.body)));
  api.put('/api/plans/:key', supers, async (req: any) => {
    if (!(await getPlan(req.params.key))) throw new HttpError(404, 'No encontrado');
    return savePlan(parse(PlanBody, { ...(req.body ?? {}), key: req.params.key }));
  });
  api.delete('/api/plans/:key', supers, async (req: any) => {
    const used = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM subscriptions WHERE plan_key = $1 AND status IN ('active', 'past_due')`, [req.params.key]);
    if (used?.n) throw new HttpError(409, `Hay ${used.n} suscripciones activas con este plan: desactívalo en lugar de borrarlo.`);
    const assigned = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE plan = $1`, [req.params.key]);
    if (assigned?.n) throw new HttpError(409, `Hay ${assigned.n} cuentas asignadas a este plan: cámbiales el plan o desactívalo en lugar de borrarlo.`);
    await query(`DELETE FROM plans WHERE key = $1`, [req.params.key]);
    return { ok: true };
  });

  /** Resumen para el superadmin: qué está configurado, URLs de aviso y cuántas suscripciones hay. */
  api.get('/api/billing/overview', supers, async () => {
    const counts = await query<{ provider: string; status: string; n: number }>(`SELECT provider, status, count(*)::int AS n FROM subscriptions GROUP BY 1, 2`);
    const mrr = await query<{ currency: string; cents: string }>(
      // Sin IVA (el IVA no es ingreso); los planes anuales cuentan su doceava parte.
      `SELECT p.currency, round(sum(CASE WHEN p.billing_interval = 'year' THEN p.price_cents / 12.0 ELSE p.price_cents END))::text AS cents
       FROM subscriptions s JOIN plans p ON p.key = s.plan_key WHERE s.status IN ('active', 'past_due') GROUP BY 1`,
    );
    return {
      providers: Object.values(providers).map((p) => ({ name: p.name, label: p.label, enabled: p.enabled(), webhook_url: `${config.publicBaseUrl}/webhook/billing/${p.name}` })),
      counts,
      monthly_revenue: mrr.map((m) => ({ currency: m.currency, amount: Number(m.cents) / 100 })),
      grace_days: config.billing.graceDays,
      tax_percent: taxPercent(),
    };
  });

  /* ------------------------------ Cuenta ------------------------------ */
  api.get('/api/billing', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const [acc, plans, sub, limits, payments] = await Promise.all([
      queryOne<any>(`SELECT status, plan, trial_ends_at FROM accounts WHERE id = $1`, [accountId]), offeredPlans(), getSubscription(accountId), limitsReport(accountId), listPayments(accountId),
    ]);
    return {
      account: acc,
      plans,
      subscription: publicSub(sub),
      payments: payments.map(paymentOut),
      limits,
      grace_days: config.billing.graceDays,
      support_contact: config.signup.supportContact,
    };
  });

  api.post('/api/billing/checkout', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const b = parse(z.object({ plan: z.string().max(40), provider: z.enum(['stripe', 'mercadopago']) }), req.body);
    const { plan, provider } = await payable(b.plan, b.provider);
    const sub = await getSubscription(accountId);
    if (sub && ['active', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end && sub.provider_subscription_id) throw new HttpError(409, 'Ya tienes un plan activo. Para cambiar la tarjeta o cancelar usa "Administrar pago".');
    try {
      return { url: await startCheckout({ accountId, email: req.user.email, plan, provider, base: await baseFor(req) }) };
    } catch (e: any) {
      if (e instanceof ProviderError) throw new HttpError(502, `${e.message}. Intenta de nuevo o escríbenos.`);
      throw e;
    }
  });

  /** Al volver de la página de pago: se pregunta al proveedor por el pago iniciado y, si ya se cobró, la cuenta se activa. */
  api.post('/api/billing/confirm', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    if (rateLimited(`billing-confirm:${accountId}`, 60, 3600_000)) return reply.code(429).send({ error: 'Demasiadas consultas, espera un momento' });
    let confirmed = false;
    try {
      confirmed = await confirmCheckout(accountId);
    } catch (e: any) {
      // El proveedor no respondió: el aviso o la revisión periódica lo confirmarán.
      await logEvent({ level: 'warn', source: 'admin', message: `No se pudo confirmar el pago al volver: ${e?.message ?? e}`, accountId });
    }
    const [acc, sub] = await Promise.all([queryOne<{ status: string }>(`SELECT status FROM accounts WHERE id = $1`, [accountId]), getSubscription(accountId)]);
    return { confirmed, account_status: acc?.status, subscription: publicSub(sub) };
  });

  /** Stripe: página para cambiar tarjeta, ver facturas y cancelar. */
  api.post('/api/billing/portal', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const sub = await getSubscription(accountId);
    const provider = sub && providers[sub.provider];
    if (!sub || !provider?.portal || !sub.provider_customer_id) throw new HttpError(400, 'Tu plan no tiene página de administración: cancélalo desde aquí.');
    try {
      return await provider.portal(sub.provider_customer_id, `${await baseFor(req)}/#/plan`);
    } catch (e: any) {
      throw new HttpError(502, e.message);
    }
  });

  api.post('/api/billing/cancel', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const { resume } = parse(z.object({ resume: z.boolean().default(false) }), req.body);
    const sub = await getSubscription(accountId);
    if (!sub?.provider_subscription_id || !['active', 'past_due'].includes(sub.status)) throw new HttpError(400, 'No tienes un plan activo');
    try {
      await providers[sub.provider].setCancelAtPeriodEnd(sub, !resume);
    } catch (e: any) {
      throw new HttpError(502, e.message);
    }
    // El proveedor confirmará por aviso; mientras tanto se refleja en el panel.
    await query(`UPDATE subscriptions SET cancel_at_period_end = $2, updated_at = now() WHERE account_id = $1`, [accountId, !resume]);
    await logEvent({ level: 'info', source: 'admin', message: resume ? 'Cancelación del plan revertida' : 'Cancelación del plan solicitada', accountId });
    return { ok: true };
  });
}
