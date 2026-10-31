/** Cobro automático: planes (los define el superadmin), contratar, administrar el pago y avisos de Stripe / Mercado Pago. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ownerOnly, ownerStepUp } from '../identity/ownership.js';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { baseFor } from '../brands.js';
import { providers, applyState, changePlan, confirmCheckout, createCheckoutSession, enabledProviders, getPlan, getSubscription, listPlans, notePaymentAction, payable, claimEvent, finishEvent, releaseEvent, startReplacement } from '../billing/service.js';
import { cardCheckState, openCardCheck, trialDaysFor } from '../billing/card-check.js';
import { alertSuperadmins, applyDispute, recordMoney, RefundBeforePaymentError } from '../billing/ledger.js';
import { FiscalSchema, fiscalComplete, getFiscal, personaOf, REGIMES, saveFiscal, USES, usesFor } from '../billing/fiscal.js';
import { listPayments } from '../billing/payments.js';
import { cfdiCounts, cfdiForPayments, getCfdi, invoicer, onFiscalSaved } from '../billing/cfdi.js';
import { chargeCents, taxPercent } from '../billing/tax.js';
import { ProviderError, WebhookError, type Plan, type ProviderName } from '../billing/types.js';
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
  /** Gasto de IA al mes que incluye el plan, en USD (null = sin tope; sin el campo, no cambia). */
  ai_usd_per_month: z.number().finite().min(0).max(100000).nullable().optional(),
});

const publicSub = (s: any) =>
  s && { provider: s.provider, plan_key: s.plan_key, pending_plan_key: s.pending_plan_key ?? '', status: s.status, current_period_end: s.current_period_end, cancel_at_period_end: s.cancel_at_period_end, past_due_since: s.past_due_since, can_portal: s.provider === 'stripe' && !!s.provider_customer_id };

/** Plan para el panel: precio sin IVA, IVA y total que se cobra. */
const planOut = (p: any) => ({ ...p, price: p.price_cents / 100, interval: p.billing_interval, tax_percent: taxPercent(), total: chargeCents(p) / 100, ai_usd_per_month: p.ai_usd_per_month == null ? null : Number(p.ai_usd_per_month) });

const paymentOut = (p: any) => ({
  id: p.id, provider: p.provider, plan_key: p.plan_key, currency: p.currency, paid_at: p.paid_at, period_start: p.period_start, period_end: p.period_end, status: p.status,
  total: p.total_cents / 100, subtotal: p.subtotal_cents / 100, tax: p.tax_cents / 100, tax_percent: Number(p.tax_percent), refunded: p.refunded_cents / 100,
});

/** Límite de veces por hora y cuenta: estas rutas llaman al proveedor (y un ciclo en el panel no debe saturarlo). */
const tooMany = (reply: any, key: string, max: number) => {
  if (!rateLimited(key, max, 3600_000)) return false;
  reply.code(429).send({ error: 'Demasiados intentos, espera un momento y vuelve a intentar' });
  return true;
};

/** Planes que se pueden contratar, con los proveedores que los cobran (para "Mi plan" y el registro). */
export async function offeredPlans() {
  const on = enabledProviders();
  return (await listPlans()).map((p: Plan) => ({ ...planOut(p), providers: on.filter((x) => x.supportsPlan(p)).map((x) => ({ name: x.name, label: x.label })) }));
}

/** Cuánto se espera el cobro de un reembolso que llegó antes (el proveedor reintenta mientras tanto). */
const REFUND_WAIT_MS = 6 * 3600_000;

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
        // Primero se reserva el aviso: si ya se procesó, no se repite; si otro proceso lo atiende ahora, el proveedor
        // reintenta después. Solo se da por procesado al terminar: si el proceso muere a la mitad, el reintento lo retoma.
        const claim = await claimEvent(name, result.eventId, result.type);
        if (claim.status === 'done') return { ok: true };
        if (claim.status === 'busy') return reply.code(503).send({ error: 'Se está procesando, reintenta más tarde' });
        try {
          // El banco pide confirmar el cobro (3DS): se guarda antes, así el aviso de cobro fallido ya dice cómo resolverlo.
          if (result.actionUrl && result.state) await notePaymentAction(name, result.state.subscriptionId, result.actionUrl);
          const accountId = result.state ? await applyState(result.state) : null;
          await recordMoney(name, result, accountId);
          if (result.dispute) await applyDispute(name, result.dispute);
          await finishEvent(name, result.eventId, claim.token, accountId);
        } catch (e) {
          // Un reembolso cuyo cobro nunca llegó (de otro producto en la misma cuenta del proveedor, o anterior a la
          // plataforma): pasadas unas horas deja de pedir reintentos, para que el proveedor no dé el webhook por roto.
          if (e instanceof RefundBeforePaymentError && Date.now() - new Date(claim.receivedAt).getTime() > REFUND_WAIT_MS) {
            await finishEvent(name, result.eventId, claim.token, null);
            await alertSuperadmins(null, 'Reembolso sin su cobro', `${providers[name].label} avisó un reembolso (${result.eventId}) de un cobro que no está registrado aquí. Si es de una suscripción de la plataforma, revísalo en ${providers[name].label}.`);
            return { ok: true };
          }
          await releaseEvent(name, result.eventId, claim.token);
          throw e;
        }
        return { ok: true };
      } catch (e: any) {
        if (e instanceof WebhookError) return reply.code(400).send({ error: e.message });
        await logEvent({ level: e instanceof RefundBeforePaymentError ? 'warn' : 'error', source: 'system', message: `Aviso de cobro (${name}): ${e?.message ?? e}` });
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
      `INSERT INTO plans (key, name, description, price_cents, currency, stripe_price_id, active, sort_order, limits, billing_interval, ai_usd_per_month) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12)
       ON CONFLICT (key) DO UPDATE SET name = $2, description = $3, price_cents = $4, currency = $5, stripe_price_id = $6, active = $7, sort_order = $8, limits = $9, billing_interval = $10,
         ai_usd_per_month = CASE WHEN $11 THEN $12 ELSE plans.ai_usd_per_month END`,
      [b.key, b.name, b.description, cents, b.currency, b.stripe_price_id.trim(), b.active, b.sort_order, JSON.stringify(Object.fromEntries(Object.entries(b.limits).filter(([, v]) => v))), b.interval,
        b.ai_usd_per_month !== undefined, b.ai_usd_per_month ?? null],
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
    // Sin el plan, el cambio programado no podría empezar con su cobro (el cliente pagaría el plan nuevo con los límites del anterior).
    const waiting = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM subscriptions WHERE pending_plan_key = $1`, [req.params.key]);
    if (waiting?.n) throw new HttpError(409, `Hay ${waiting.n} cuentas con el cambio a este plan programado para su siguiente cobro: desactívalo en lugar de borrarlo.`);
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
      invoicing: { enabled: invoicer.enabled(), counts: await cfdiCounts() },
    };
  });

  /* ------------------------------ Cuenta ------------------------------ */
  api.get('/api/billing', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const [acc, plans, sub, limits, payments, fiscal] = await Promise.all([
      queryOne<any>(`SELECT status, plan, trial_ends_at FROM accounts WHERE id = $1`, [accountId]), offeredPlans(), getSubscription(accountId), limitsReport(accountId), listPayments(accountId), getFiscal(accountId),
    ]);
    const cfdi = await cfdiForPayments(payments.map((p) => p.id));
    return {
      account: acc,
      plans,
      subscription: publicSub(sub),
      payments: payments.map((p) => ({ ...paymentOut(p), cfdi: cfdi.get(p.id) })),
      invoicing: invoicer.enabled(),
      limits,
      grace_days: config.billing.graceDays,
      support_contact: config.signup.supportContact,
      fiscal: { wants_invoice: fiscal.wants_invoice, complete: fiscalComplete(fiscal) },
      card_check: await cardCheckState(accountId),
    };
  });

  /* ------------------------------ Datos fiscales ------------------------------ */
  const catalogs = {
    regimes: REGIMES.map((r) => ({ code: r.code, label: `${r.code} · ${r.label}`, for: r.for })),
    uses: USES.map((u) => ({ code: u.code, label: `${u.code} · ${u.label}` })),
    uses_by_regime: Object.fromEntries(REGIMES.map((r) => [r.code, usesFor(r.code)])),
  };

  api.get('/api/billing/fiscal', { ...admins, ...ownerOnly }, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const f = await getFiscal(accountId);
    const { account_id: _a, updated_at, ...data } = f as any;
    return { fiscal: data, complete: fiscalComplete(f), updated_at, ...catalogs };
  });

  api.put('/api/billing/fiscal', { ...admins, ...ownerStepUp }, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    if (tooMany(reply, `billing-fiscal:${accountId}`, 30)) return reply;
    const d = parse(FiscalSchema, req.body);
    const f = await saveFiscal(accountId, req.user.role === 'superadmin' ? null : req.user.id, d);
    await logEvent({ level: 'info', source: 'admin', message: d.wants_invoice ? `Datos de facturación guardados (RFC ${d.rfc}, ${personaOf(d.rfc) === 'moral' ? 'persona moral' : 'persona física'})` : 'Facturación: sin factura (público en general)', accountId });
    // Las facturas rechazadas por datos se reintentan con los nuevos; si ahora pide factura, sus pagos del mes la reciben.
    await onFiscalSaved(accountId);
    return { ok: true, complete: fiscalComplete(f), wants_invoice: f.wants_invoice };
  });

  /** PDF o XML de un CFDI: del administrador de su cuenta (la global, solo del superadmin). */
  api.get('/api/billing/invoices/:id/:format', { ...admins, ...ownerOnly }, async (req: any, reply) => {
    const { id, format } = req.params;
    if (!['pdf', 'xml'].includes(format) || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'No encontrado');
    const c = await getCfdi(id);
    const mine = c && (req.user.role === 'superadmin' || (c.account_id && c.account_id === (await targetAccount(req.user, req.query.account_id))));
    if (!c || !mine || c.status !== 'issued') throw new HttpError(404, 'No encontrado');
    if (tooMany(reply, `billing-invoice:${req.user.id}`, 120)) return reply;
    const file = await viaProvider(() => invoicer.download(c.provider_invoice_id, format));
    const name = `${c.series}${c.folio}` || c.sat_uuid;
    return reply
      .header('content-type', format === 'pdf' ? 'application/pdf' : 'application/xml')
      .header('content-disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '') || 'factura'}.${format}"`)
      .header('cache-control', 'private, no-store')
      .send(file);
  });

  api.post('/api/billing/checkout', { ...admins, ...ownerStepUp }, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    // `trial: false`: contratar ya, sin días gratis (p. ej. con la tarjeta que ya tuvo una prueba).
    const b = parse(z.object({ plan: z.string().max(40), provider: z.enum(['stripe', 'mercadopago']), trial: z.boolean().optional() }), req.body);
    const { plan, provider } = await payable(b.plan, b.provider);
    const sub = await getSubscription(accountId);
    if (sub && ['active', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end && sub.provider_subscription_id) throw new HttpError(409, 'Ya tienes un plan activo: para cambiarlo usa «Cambiar de plan» en Mi plan.');
    // Quien pidió factura necesita sus datos completos antes del primer cobro (su CFDI sale de cada pago).
    const fiscal = await getFiscal(accountId);
    if (fiscal.wants_invoice && !fiscalComplete(fiscal)) throw new HttpError(400, 'Completa tus datos de facturación antes de pagar (en «Facturación», en esta misma página), o elige «Sin factura».');
    try {
      // Volver a contratar con Mercado Pago tras cancelar: el primer cobro es al terminar lo ya pagado. Una cuenta que espera
      // tarjeta nunca pagó (la suscripción cancelada de una tarjeta repetida no deja periodo pagado).
      const waitingCard = !!(await queryOne(`SELECT 1 FROM accounts WHERE id = $1 AND status = 'paused' AND pause_reason = 'card'`, [accountId]));
      const paidUntil = !waitingCard && provider === 'mercadopago' && sub && (sub.status === 'canceled' || sub.cancel_at_period_end) && sub.current_period_end && sub.current_period_end > new Date() ? sub.current_period_end : undefined;
      // La verificación de tarjeta (también el pago de quien ya tiene cuenta): correo verificado, topes y sesión vigente.
      const trialDays = b.trial === false ? 0 : await trialDaysFor(accountId);
      const base = await baseFor(req);
      const url = await openCardCheck({ accountId, ip: req.ip, provider, planKey: plan.key, open: () => createCheckoutSession({ accountId, email: req.user.email, plan, provider, base, startAt: paidUntil, trialDays }) });
      return { url, trial: trialDays > 0 };
    } catch (e: any) {
      if (e instanceof ProviderError) throw new HttpError(502, `${e.message}. Intenta de nuevo o escríbenos.`);
      throw e;
    }
  });

  /** Al volver de la página de pago: se pregunta al proveedor por el pago iniciado y, si ya se cobró, la cuenta se activa. */
  api.post('/api/billing/confirm', { ...admins, ...ownerOnly }, async (req: any, reply) => {
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

  /**
   * El portal de Stripe deja probar tarjetas («actualizar método de pago») contra la cuenta de la plataforma: cuenta como
   * una página de tarjeta por sustitución, con los mismos topes, el freno y su registro en card_checks (PAY-18).
   */
  const stripePortal = async (accountId: string, ip: string, sub: NonNullable<Awaited<ReturnType<typeof getSubscription>>>, base: string) =>
    openCardCheck({ accountId, ip, provider: sub.provider, planKey: sub.plan_key, replacement: true,
      open: async () => ({ url: (await providers[sub.provider].portal!(sub.provider_customer_id, `${base}/#/plan`)).url, ref: '' }) });

  /** Stripe: página para cambiar tarjeta, ver facturas y cancelar. */
  api.post('/api/billing/portal', { ...admins, ...ownerStepUp }, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const sub = await getSubscription(accountId);
    const provider = sub && providers[sub.provider];
    if (!sub || !provider?.portal || !sub.provider_customer_id) throw new HttpError(400, 'Tu plan no tiene página de administración: cancélalo desde aquí.');
    const base = await baseFor(req);
    try {
      return { url: await stripePortal(accountId, req.ip, sub, base) };
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, e.message);
    }
  });

  /** Los errores del proveedor se informan como 502 con su mensaje. */
  const viaProvider = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e: any) {
      if (e instanceof ProviderError) throw new HttpError(502, `${e.message}. Intenta de nuevo o escríbenos.`);
      throw e;
    }
  };

  /** Cambiar de plan. Mercado Pago entre mensual y anual pasa por su página de pago: entonces responde `url`. */
  api.post('/api/billing/change', { ...admins, ...ownerStepUp }, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    if (tooMany(reply, `billing-change:${accountId}`, 10)) return reply;
    const { plan } = parse(z.object({ plan: z.string().max(40) }), req.body);
    const r = await viaProvider(async () => changePlan({ accountId, email: req.user.email, planKey: plan, base: await baseFor(req), ip: req.ip }));
    return { ok: true, ...r, subscription: publicSub(await getSubscription(accountId)) };
  });

  /** Cambiar la tarjeta. Stripe: su página de administración. Mercado Pago: una suscripción nueva desde el siguiente cobro. */
  api.post('/api/billing/payment-method', { ...admins, ...ownerStepUp }, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    if (tooMany(reply, `billing-payment-method:${accountId}`, 10)) return reply;
    const sub = await getSubscription(accountId);
    if (!sub?.provider_subscription_id || !['active', 'past_due'].includes(sub.status)) throw new HttpError(400, 'No tienes un plan activo');
    const base = await baseFor(req);
    if (sub.provider === 'stripe') {
      if (!sub.provider_customer_id) throw new HttpError(400, 'Tu plan no tiene página de administración');
      return viaProvider(async () => ({ url: await stripePortal(accountId, req.ip, sub, base) }));
    }
    // Con un cambio de plan programado, la tarjeta nueva lo conserva (empieza igual, con su primer cobro).
    const plan = await getPlan(sub.pending_plan_key || sub.plan_key);
    if (!plan?.active) throw new HttpError(409, 'Tu plan ya no se ofrece: elige otro para continuar.');
    return { url: await viaProvider(() => startReplacement({ accountId, email: req.user.email, plan, base, ip: req.ip })) };
  });

  api.post('/api/billing/cancel', { ...admins, ...ownerStepUp }, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    if (tooMany(reply, `billing-cancel:${accountId}`, 20)) return reply;
    const { resume } = parse(z.object({ resume: z.boolean().default(false) }), req.body);
    const sub = await getSubscription(accountId);
    // Mercado Pago no reanuda una suscripción cancelada: se contrata el mismo plan con el primer cobro al terminar lo pagado.
    if (resume && sub?.provider === 'mercadopago' && (sub.cancel_at_period_end || sub.status === 'canceled') && sub.current_period_end && sub.current_period_end > new Date()) {
      const plan = await getPlan(sub.pending_plan_key || sub.plan_key);
      if (!plan?.active) throw new HttpError(409, 'Tu plan ya no se ofrece: elige otro para continuar.');
      return { ok: true, url: await viaProvider(async () => startReplacement({ accountId, email: req.user.email, plan, base: await baseFor(req), ip: req.ip })) };
    }
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
