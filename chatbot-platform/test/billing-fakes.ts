/** Stripe y Mercado Pago simulados. Se importa ANTES del arnés para fijar las URLs y claves de la configuración. */
import crypto from 'node:crypto';
import http from 'node:http';

export const fake = {
  stripe: {
    requests: [] as { method: string; path: string; body: URLSearchParams }[],
    subs: {} as Record<string, any>,
    sessions: {} as Record<string, any>,
    products: {} as Record<string, any>,
    /** Tarjetas guardadas por cliente (GET /v1/payment_methods?customer=…&type=card). */
    paymentMethods: {} as Record<string, any[]>,
    /** Facturas que devuelve GET /v1/invoices (cobros de las suscripciones). */
    invoices: [] as any[],
    /** Reembolsos pedidos (POST /v1/refunds). */
    refunds: [] as { charge: string; payment_intent: string }[],
    /** Disputas (GET /v1/disputes/:id: se releen en cada aviso) y alertas tempranas de fraude. */
    disputes: {} as Record<string, any>,
    fraudWarnings: {} as Record<string, any>,
    /** El proveedor rechaza los reembolsos y las cancelaciones. */
    refundFail: false,
    fail: false,
    /** Corta la conexión sin responder (red caída). */
    drop: false,
    n: 0,
  },
  /** payments = pagos autorizados de la suscripción; charges = pagos (para reembolsos). */
  mp: {
    requests: [] as { method: string; path: string; body: any }[], preapprovals: {} as Record<string, any>, payments: {} as Record<string, any>, charges: {} as Record<string, any>,
    /** Tarjetas guardadas de los clientes (GET /v1/customers/:id/cards/:card). */
    cards: {} as Record<string, any>,
    /** Pagos reembolsados (POST /v1/payments/:id/refunds). */
    refunds: [] as string[],
    /** Contracargos (GET /v1/chargebacks/:id). */
    chargebacks: {} as Record<string, any>,
    /** Id de la próxima suscripción que se cree (por omisión, "pre_new"). */
    nextId: '',
  },
  /** PAC: invoices = CFDI timbrados. fail5xx = el servicio falla; reject = rechaza los datos (400) con ese mensaje. */
  facturapi: {
    requests: [] as { method: string; path: string; body: any }[],
    invoices: [] as any[],
    fail5xx: false,
    reject: '',
    /** Timbra y corta la conexión sin responder (la respuesta se pierde). */
    drop: false,
  },
};
export const SECRETS = { stripe: 'whsec_prueba', mp: 'mp_secreto_prueba' };

function serve(handler: (req: http.IncomingMessage, raw: string, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  return new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(`http://127.0.0.1:${(server.address() as any).port}`); }));
}
const json = (res: http.ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

const stripeUrl = await serve((req, raw, res) => {
  const [path, qs] = req.url!.split('?');
  const body = new URLSearchParams(raw);
  fake.stripe.requests.push({ method: req.method!, path, body });
  if (fake.stripe.drop) return void req.socket.destroy();
  if (fake.stripe.fail) return json(res, 402, { error: { message: 'Tu tarjeta fue rechazada' } });
  if (path === '/v1/invoices' && req.method === 'GET') {
    const q = new URLSearchParams(qs);
    const since = Number(q.get('created[gte]') ?? 0);
    return json(res, 200, { data: fake.stripe.invoices.filter((i) => i.subscription === q.get('subscription') && (i.created ?? 0) >= since && (!q.get('status') || i.status === q.get('status'))) });
  }
  if (path === '/v1/refunds' && req.method === 'POST') {
    if (fake.stripe.refundFail) return json(res, 500, { error: { message: 'Error interno' } });
    const charge = body.get('charge') ?? '';
    const pi = body.get('payment_intent') ?? '';
    if (fake.stripe.refunds.some((r) => (charge && r.charge === charge) || (pi && r.payment_intent === pi))) return json(res, 400, { error: { message: 'Charge already refunded', code: 'charge_already_refunded' } });
    fake.stripe.refunds.push({ charge, payment_intent: pi });
    return json(res, 200, { id: `re_${++fake.stripe.n}`, status: 'succeeded' });
  }
  if (path === '/v1/checkout/sessions' && req.method === 'POST') {
    const id = `cs_${++fake.stripe.n}`;
    fake.stripe.sessions[id] = { id, url: `https://checkout.stripe.test/c/${id}`, status: 'open', subscription: null, client_reference_id: body.get('client_reference_id') };
    return json(res, 200, fake.stripe.sessions[id]);
  }
  const cs = path.match(/^\/v1\/checkout\/sessions\/([\w-]+)$/);
  if (cs) return fake.stripe.sessions[cs[1]] ? json(res, 200, fake.stripe.sessions[cs[1]]) : json(res, 404, { error: { message: 'No such checkout.session' } });
  if (path === '/v1/billing_portal/sessions') return json(res, 200, { url: 'https://billing.stripe.test/p/1' });
  const customer = path.match(/^\/v1\/customers\/([\w-]+)$/);
  if (customer) return json(res, 200, { id: customer[1], invoice_settings: { default_payment_method: null } });
  if (path === '/v1/payment_methods' && req.method === 'GET') {
    const q = new URLSearchParams(req.url!.split('?')[1] ?? '');
    return json(res, 200, { data: fake.stripe.paymentMethods[q.get('customer') ?? ''] ?? [] });
  }
  if (path === '/v1/products' && req.method === 'POST') {
    const id = body.get('id')!;
    if (fake.stripe.products[id]) return json(res, 400, { error: { message: `Product already exists: ${id}` } });
    fake.stripe.products[id] = { id, name: body.get('name'), active: true, metadata: { plan_key: body.get('metadata[plan_key]') } };
    return json(res, 200, fake.stripe.products[id]);
  }
  const prod = path.match(/^\/v1\/products\/([\w-]+)$/);
  if (prod) {
    const p = fake.stripe.products[prod[1]];
    if (!p) return json(res, 404, { error: { message: 'No such product' } });
    if (req.method === 'POST') Object.assign(p, { name: body.get('name') ?? p.name, active: body.get('active') !== 'false' });
    return json(res, 200, p);
  }
  const dp = path.match(/^\/v1\/disputes\/([\w-]+)$/);
  if (dp) return fake.stripe.disputes[dp[1]] ? json(res, 200, fake.stripe.disputes[dp[1]]) : json(res, 404, { error: { message: 'No such dispute', code: 'resource_missing' } });
  const efw = path.match(/^\/v1\/radar\/early_fraud_warnings\/([\w-]+)$/);
  if (efw) return fake.stripe.fraudWarnings[efw[1]] ? json(res, 200, fake.stripe.fraudWarnings[efw[1]]) : json(res, 404, { error: { message: 'No such warning', code: 'resource_missing' } });
  const m = path.match(/^\/v1\/subscriptions\/([\w-]+)$/);
  if (m) {
    const sub = fake.stripe.subs[m[1]];
    if (!sub) return json(res, 404, { error: { message: 'No such subscription', code: 'resource_missing' } });
    if (req.method === 'DELETE') {
      if (fake.stripe.refundFail) return json(res, 500, { error: { message: 'Error interno' } });
      sub.status = 'canceled';
      return json(res, 200, sub);
    }
    if (req.method === 'POST') {
      if (body.has('cancel_at_period_end')) sub.cancel_at_period_end = body.get('cancel_at_period_end') === 'true';
      if (body.has('pause_collection[behavior]')) sub.pause_collection = { behavior: body.get('pause_collection[behavior]') };
      else if (body.has('pause_collection')) sub.pause_collection = null;
      // Terminar la prueba ya (tarjeta que ya tuvo una): Stripe cobra al momento y la suscripción queda activa.
      if (body.get('trial_end') === 'now') { sub.status = 'active'; delete sub.trial_end; }
      // Cambio de plan: el renglón toma el nuevo precio (por ID o armado con price_data).
      if (body.has('items[0][id]')) {
        const item = sub.items.data[0];
        item.price = body.get('items[0][price]')
          ? { id: body.get('items[0][price]') }
          : { id: `price_${++fake.stripe.n}`, unit_amount: Number(body.get('items[0][price_data][unit_amount]')), recurring: { interval: body.get('items[0][price_data][recurring][interval]') }, product: body.get('items[0][price_data][product]') };
      }
      if (body.has('metadata[plan_key]')) sub.metadata = { ...sub.metadata, plan_key: body.get('metadata[plan_key]') };
    }
    return json(res, 200, sub);
  }
  json(res, 404, { error: { message: 'ruta desconocida' } });
});
const mpUrl = await serve((req, raw, res) => {
  const [path, qs] = req.url!.split('?');
  const body = raw ? JSON.parse(raw) : undefined;
  fake.mp.requests.push({ method: req.method!, path, body });
  if (path === '/authorized_payments/search') {
    const pre = new URLSearchParams(qs).get('preapproval_id');
    return json(res, 200, { results: Object.values(fake.mp.payments).filter((p: any) => p.preapproval_id === pre) });
  }
  const rf = path.match(/^\/v1\/payments\/([\w-]+)\/refunds$/);
  if (rf && req.method === 'POST') {
    fake.mp.refunds.push(rf[1]);
    if (fake.mp.charges[rf[1]]) fake.mp.charges[rf[1]].status = 'refunded';
    return json(res, 201, { id: Date.now(), payment_id: rf[1], status: 'approved' });
  }
  if (path === '/preapproval' && req.method === 'POST') {
    const id = fake.mp.nextId || 'pre_new';
    return json(res, 201, { id, init_point: `https://mp.test/checkout/${id}` });
  }
  const card = path.match(/^\/v1\/customers\/([\w-]+)\/cards\/([\w-]+)$/);
  if (card) return fake.mp.cards[card[2]] ? json(res, 200, fake.mp.cards[card[2]]) : json(res, 404, { message: 'not found' });
  let m = path.match(/^\/preapproval\/([\w-]+)$/);
  if (m) {
    const p = fake.mp.preapprovals[m[1]];
    if (!p) return json(res, 404, { message: 'not found' });
    if (req.method === 'PUT') {
      if (body.status) p.status = body.status;
      if (body.reason) p.reason = body.reason;
      if (body.external_reference) p.external_reference = body.external_reference;
      if (body.auto_recurring) p.auto_recurring = { ...p.auto_recurring, ...body.auto_recurring };
    }
    return json(res, 200, p);
  }
  m = path.match(/^\/authorized_payments\/([\w-]+)$/);
  if (m && fake.mp.payments[m[1]]) return json(res, 200, fake.mp.payments[m[1]]);
  m = path.match(/^\/v1\/chargebacks\/([\w-]+)$/);
  if (m) return fake.mp.chargebacks[m[1]] ? json(res, 200, fake.mp.chargebacks[m[1]]) : json(res, 404, { message: 'not found' });
  m = path.match(/^\/v1\/payments\/([\w-]+)$/);
  if (m && fake.mp.charges[m[1]]) return json(res, 200, fake.mp.charges[m[1]]);
  json(res, 404, { message: 'ruta desconocida' });
});

const facturapiUrl = await serve((req, raw, res) => {
  const [path, qs] = req.url!.split('?');
  const body = raw ? JSON.parse(raw) : undefined;
  const f = fake.facturapi;
  f.requests.push({ method: req.method!, path, body });
  if (req.headers.authorization !== 'Bearer sk_test_facturapi') return json(res, 401, { message: 'Clave inválida' });
  if (f.fail5xx) return json(res, 503, { message: 'Servicio no disponible' });
  if (path === '/v2/invoices' && req.method === 'POST') {
    if (f.reject) return json(res, 400, { message: f.reject });
    const missing = ['type', 'customer', 'items', 'payment_form', 'use'].filter((k) => body?.[k] === undefined);
    if (missing.length || !body.customer.tax_id || !body.customer.address?.zip) return json(res, 400, { message: `Faltan campos: ${missing.join(', ') || 'customer'}` });
    const n = f.invoices.length + 1;
    const total = Math.round(body.items.reduce((s: number, i: any) => s + i.product.price * i.quantity, 0) * 100) / 100;
    const inv = { id: `fac_${n}`, uuid: `UUID-${n}`, series: 'A', folio_number: n, status: 'valid', total, ...body };
    f.invoices.push(inv);
    if (f.drop) return void req.socket.destroy();
    return json(res, 200, inv);
  }
  if (path === '/v2/invoices' && req.method === 'GET') {
    const ext = new URLSearchParams(qs).get('external_id');
    return json(res, 200, { data: f.invoices.filter((i) => !ext || i.external_id === ext), page: 1, total_pages: 1 });
  }
  const m = path.match(/^\/v2\/invoices\/([\w-]+)\/(pdf|xml)$/);
  if (m) {
    if (!f.invoices.some((i) => i.id === m[1])) return json(res, 404, { message: 'No encontrada' });
    res.writeHead(200, { 'content-type': m[2] === 'pdf' ? 'application/pdf' : 'application/xml' });
    return void res.end(m[2] === 'pdf' ? `%PDF-${m[1]}` : `<cfdi:Comprobante Folio="${m[1]}"/>`);
  }
  json(res, 404, { message: 'ruta desconocida' });
});

process.env.FACTURAPI_API_KEY = 'sk_test_facturapi';
process.env.FACTURAPI_API_URL = `${facturapiUrl}/v2`;
process.env.CFDI_ISSUER_ZIP = '64000';
process.env.STRIPE_SECRET_KEY = 'sk_test_prueba';
process.env.STRIPE_WEBHOOK_SECRET = SECRETS.stripe;
process.env.STRIPE_API_URL = stripeUrl;
process.env.MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-prueba';
process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRETS.mp;
process.env.MERCADOPAGO_API_URL = mpUrl;
process.env.BILLING_GRACE_DAYS = '5';

/** Aviso de Stripe firmado como lo hace Stripe. */
export function stripeEvent(type: string, object: unknown, id = `evt_${crypto.randomUUID()}`, t = Math.floor(Date.now() / 1000), secret = SECRETS.stripe) {
  const payload = JSON.stringify({ id, type, data: { object } });
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return { payload, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } };
}

/** Aviso de Mercado Pago firmado como lo hace Mercado Pago. */
export function mpEvent(type: string, dataId: string, secret = SECRETS.mp, ts = Date.now()) {
  const requestId = crypto.randomUUID();
  const sig = crypto.createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  return { url: `/webhook/billing/mercadopago?data.id=${dataId}&type=${type}`, payload: JSON.stringify({ type, data: { id: dataId } }), headers: { 'content-type': 'application/json', 'x-signature': `ts=${ts},v1=${sig}`, 'x-request-id': requestId } };
}

/** Suscripción simulada: su precio es del producto `riverrun_<plan>` (de ahí sale el plan, PAY-7). */
export const stripeSub = (over: Record<string, any> = {}) => {
  const plan = over.metadata?.plan_key ?? 'pro';
  return {
    id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at_period_end: false,
    metadata: { account_id: '', plan_key: 'pro' }, items: { data: [{ id: 'si_1', price: { id: `price_${plan}`, product: `riverrun_${plan}` } }] }, ...over,
  };
};
