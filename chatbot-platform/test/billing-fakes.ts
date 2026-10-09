/** Stripe y Mercado Pago simulados. Se importa ANTES del arnés para fijar las URLs y claves de la configuración. */
import crypto from 'node:crypto';
import http from 'node:http';

export const fake = {
  stripe: { requests: [] as { method: string; path: string; body: URLSearchParams }[], subs: {} as Record<string, any>, fail: false },
  mp: { requests: [] as { method: string; path: string; body: any }[], preapprovals: {} as Record<string, any>, payments: {} as Record<string, any> },
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
  const path = req.url!.split('?')[0];
  const body = new URLSearchParams(raw);
  fake.stripe.requests.push({ method: req.method!, path, body });
  if (fake.stripe.fail) return json(res, 402, { error: { message: 'Tu tarjeta fue rechazada' } });
  if (path === '/v1/checkout/sessions') return json(res, 200, { id: 'cs_1', url: 'https://checkout.stripe.test/c/cs_1' });
  if (path === '/v1/billing_portal/sessions') return json(res, 200, { url: 'https://billing.stripe.test/p/1' });
  const m = path.match(/^\/v1\/subscriptions\/([\w-]+)$/);
  if (m) {
    const sub = fake.stripe.subs[m[1]];
    if (!sub) return json(res, 404, { error: { message: 'No such subscription' } });
    if (req.method === 'POST') sub.cancel_at_period_end = body.get('cancel_at_period_end') === 'true';
    return json(res, 200, sub);
  }
  json(res, 404, { error: { message: 'ruta desconocida' } });
});
const mpUrl = await serve((req, raw, res) => {
  const path = req.url!.split('?')[0];
  const body = raw ? JSON.parse(raw) : undefined;
  fake.mp.requests.push({ method: req.method!, path, body });
  if (path === '/preapproval' && req.method === 'POST') return json(res, 201, { id: 'pre_new', init_point: 'https://mp.test/checkout/pre_new' });
  let m = path.match(/^\/preapproval\/([\w-]+)$/);
  if (m) {
    const p = fake.mp.preapprovals[m[1]];
    if (!p) return json(res, 404, { message: 'not found' });
    if (req.method === 'PUT') p.status = body.status;
    return json(res, 200, p);
  }
  m = path.match(/^\/authorized_payments\/([\w-]+)$/);
  if (m && fake.mp.payments[m[1]]) return json(res, 200, fake.mp.payments[m[1]]);
  json(res, 404, { message: 'ruta desconocida' });
});

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

export const stripeSub = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at_period_end: false,
  metadata: { account_id: '', plan_key: 'pro' }, items: { data: [{ price: { id: 'price_pro' } }] }, ...over,
});
