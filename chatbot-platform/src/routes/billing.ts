/** Cobro automático: planes (los define el superadmin), contratar, administrar el pago y avisos de Stripe / Mercado Pago. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { providers, applyState, beginCheckout, enabledProviders, getPlan, getSubscription, listPlans, recordEvent } from '../billing/service.js';
import { ProviderError, WebhookError, type ProviderName } from '../billing/types.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { limitsReport, LimitsSchema } from '../billing/limits.js';
import { logEvent } from '../logs.js';
import { parse } from './util.js';

const PlanBody = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Clave: minúsculas, números, guion y guion bajo'),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(400).default(''),
  price: z.number().positive().max(10_000_000),
  currency: z.string().length(3).transform((c) => c.toUpperCase()).default('MXN'),
  stripe_price_id: z.string().max(120).default(''),
  active: z.boolean().default(true),
  sort_order: z.number().int().default(0),
  /** Límites del plan; vacío o ausente = sin límite. */
  limits: LimitsSchema.default({}),
});

const publicSub = (s: any) =>
  s && { provider: s.provider, plan_key: s.plan_key, status: s.status, current_period_end: s.current_period_end, cancel_at_period_end: s.cancel_at_period_end, past_due_since: s.past_due_since, can_portal: s.provider === 'stripe' && !!s.provider_customer_id };

const planOut = (p: any) => ({ ...p, price: p.price_cents / 100 });

/** Rutas públicas: los proveedores avisan aquí. La firma se verifica sobre el cuerpo original. */
export async function billingWebhooks(app: FastifyInstance) {
  for (const name of Object.keys(providers) as ProviderName[]) {
    app.post(`/webhook/billing/${name}`, async (req, reply) => {
      const provider = providers[name];
      if (!provider.enabled()) return reply.code(404).send({ error: 'No configurado' });
      try {
        const result = await provider.handleWebhook({ rawBody: req.rawBody ?? Buffer.alloc(0), headers: req.headers, query: req.query as Record<string, string | undefined>, plans: await listPlans(true) });
        if (!result) return { ok: true };
        const accountId = result.state ? await applyState(result.state) : null;
        await recordEvent(name, result.eventId, result.type, accountId);
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
      `INSERT INTO plans (key, name, description, price_cents, currency, stripe_price_id, active, sort_order, limits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (key) DO UPDATE SET name = $2, description = $3, price_cents = $4, currency = $5, stripe_price_id = $6, active = $7, sort_order = $8, limits = $9`,
      [b.key, b.name, b.description, cents, b.currency, b.stripe_price_id.trim(), b.active, b.sort_order, JSON.stringify(Object.fromEntries(Object.entries(b.limits).filter(([, v]) => v)))],
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
    await query(`DELETE FROM plans WHERE key = $1`, [req.params.key]);
    return { ok: true };
  });

  /** Resumen para el superadmin: qué está configurado, URLs de aviso y cuántas suscripciones hay. */
  api.get('/api/billing/overview', supers, async () => {
    const counts = await query<{ provider: string; status: string; n: number }>(`SELECT provider, status, count(*)::int AS n FROM subscriptions GROUP BY 1, 2`);
    const mrr = await query<{ currency: string; cents: string }>(
      `SELECT p.currency, sum(p.price_cents)::text AS cents FROM subscriptions s JOIN plans p ON p.key = s.plan_key WHERE s.status IN ('active', 'past_due') GROUP BY 1`,
    );
    return {
      providers: Object.values(providers).map((p) => ({ name: p.name, label: p.label, enabled: p.enabled(), webhook_url: `${config.publicBaseUrl}/webhook/billing/${p.name}` })),
      counts,
      monthly_revenue: mrr.map((m) => ({ currency: m.currency, amount: Number(m.cents) / 100 })),
      grace_days: config.billing.graceDays,
    };
  });

  /* ------------------------------ Cuenta ------------------------------ */
  api.get('/api/billing', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const [acc, plans, sub, limits] = await Promise.all([queryOne<any>(`SELECT status, plan, trial_ends_at FROM accounts WHERE id = $1`, [accountId]), listPlans(), getSubscription(accountId), limitsReport(accountId)]);
    const on = enabledProviders();
    return {
      account: acc,
      plans: plans.map((p) => ({ ...planOut(p), providers: on.filter((x) => x.supportsPlan(p)).map((x) => ({ name: x.name, label: x.label })) })),
      subscription: publicSub(sub),
      limits,
      grace_days: config.billing.graceDays,
      support_contact: config.signup.supportContact,
    };
  });

  api.post('/api/billing/checkout', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const b = parse(z.object({ plan: z.string().max(40), provider: z.enum(['stripe', 'mercadopago']) }), req.body);
    const provider = providers[b.provider];
    const plan = await getPlan(b.plan);
    if (!plan || !plan.active) throw new HttpError(404, 'Ese plan no está disponible');
    if (!provider.enabled() || !provider.supportsPlan(plan)) throw new HttpError(400, `Este plan no se puede pagar con ${provider.label}`);
    const sub = await getSubscription(accountId);
    if (sub && ['active', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end && sub.provider_subscription_id) throw new HttpError(409, 'Ya tienes un plan activo. Para cambiar la tarjeta o cancelar usa "Administrar pago".');
    try {
      const { url } = await provider.createCheckout({
        accountId, email: req.user.email, plan,
        successUrl: `${config.publicBaseUrl}/#/plan?pago=ok`, cancelUrl: `${config.publicBaseUrl}/#/plan?pago=cancelado`,
        customerId: sub?.provider === b.provider ? sub.provider_customer_id || undefined : undefined,
      });
      await beginCheckout(accountId, b.provider, plan.key);
      await logEvent({ level: 'info', source: 'admin', message: `Pago iniciado: plan ${plan.key} con ${b.provider}`, accountId });
      return { url };
    } catch (e: any) {
      if (e instanceof ProviderError) throw new HttpError(502, `${e.message}. Intenta de nuevo o escríbenos.`);
      throw e;
    }
  });

  /** Stripe: página para cambiar tarjeta, ver facturas y cancelar. */
  api.post('/api/billing/portal', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const sub = await getSubscription(accountId);
    const provider = sub && providers[sub.provider];
    if (!sub || !provider?.portal || !sub.provider_customer_id) throw new HttpError(400, 'Tu plan no tiene página de administración: cancélalo desde aquí.');
    try {
      return await provider.portal(sub.provider_customer_id, `${config.publicBaseUrl}/#/plan`);
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
