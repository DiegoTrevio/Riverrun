/** Página pública de precios: planes + IVA, enlace al registro con el plan, marca del dominio y textos escapados. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los proveedores simulados fijan claves y URLs antes de que el arnés cargue la configuración.
await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { pricingPage } = await import('../src/routes/pricing.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const page = async (host?: string) => h.app.inject({ method: 'GET', url: '/precios', headers: host ? { host } : {} });

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('sin planes: la página invita a escribir', async () => {
  const r = await page();
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-type']), /text\/html/);
  assert.match(r.body, /Pronto publicaremos nuestros planes/);
  assert.doesNotMatch(r.body, /class="plan"/);
});

t('muestra los planes activos con precio + IVA, total, límites y el botón al registro con ese plan', async () => {
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499, sort_order: 2, limits: { messages_per_month: 1000, channels: 1 } })).statusCode, 200);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'anual', name: 'Pro anual', price: 4990, interval: 'year', sort_order: 3 })).statusCode, 200);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'viejo', name: 'Plan viejo', price: 99, active: false })).statusCode, 200);
  const r = await page();
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<h2>Pro<\/h2>/);
  assert.match(r.body, /\$499<\/strong> <span>MXN \+ IVA \/ mes/);
  assert.match(r.body, /Total con IVA: \$578\.84 MXN al mes/);
  assert.match(r.body, /1,000 mensajes del asistente al mes/);
  assert.match(r.body, /1 canal \(WhatsApp/);
  assert.match(r.body, /\$4,990<\/strong> <span>MXN \+ IVA \/ año/);
  assert.match(r.body, /Sin límites de uso/);
  assert.match(r.body, /<a class="btn" href="\/#\/registro">Probar 14 días gratis<\/a>/, 'la prueba gratis va al registro sin plan');
  assert.match(r.body, /href="\/#\/registro\?plan=pro">Contratar<span class="sr"> el plan Pro/, 'contratar lleva al registro con el plan, que pasa al pago');
  assert.match(r.body, /href="\/#\/registro\?plan=anual">Contratar/);
  assert.doesNotMatch(r.body, /Plan viejo/, 'los planes desactivados no se publican');
  assert.ok(r.body.indexOf('<h2>Pro</h2>') < r.body.indexOf('<h2>Pro anual</h2>'), 'en el orden de los planes');
  assert.match(r.body, /¿Necesito tarjeta para probar\?/);
  assert.equal(r.headers['vary'], 'Host');
});

test('sin pago en línea, cada plan ofrece la prueba gratis; con el registro cerrado no hay botones', () => {
  const plan = { key: 'pro', name: 'Pro', description: '', price: 499, total: 578.84, tax_percent: 16, currency: 'MXN', billing_interval: 'month', limits: {}, providers: [] } as any;
  const base = { brand: { name: 'X', color: '', logo: null, support_email: '', brand_id: null }, plans: [plan], trialDays: 14, signup: true, support: 'hola@x.mx', terms: '', privacy: '' };
  const open = pricingPage(base);
  assert.match(open, /<a class="btn ghost" href="\/#\/registro">Empezar prueba gratis<\/a>/);
  assert.doesNotMatch(open, /registro\?plan=/);
  assert.match(open, /días gratis, sin tarjeta\./);
  const card = pricingPage({ ...base, cardRequired: true });
  assert.doesNotMatch(card, /sin tarjeta/, 'con cobro en línea la prueba pide tarjeta (3a)');
  assert.match(card, /no se cobra nada hasta que terminan/);
  assert.match(card, /Sí\. Tu prueba de 14 días empieza al agregar tu tarjeta/);
  const closed = pricingPage({ ...base, signup: false });
  assert.doesNotMatch(closed, /href="\/#\/registro/);
  assert.match(closed, /el registro está cerrado\. Escríbenos a <strong>hola@x\.mx<\/strong>/);
  const noTrial = pricingPage({ ...base, trialDays: 0 });
  assert.doesNotMatch(noTrial, /gratis/);
});

t('los textos del plan se escapan', async () => {
  assert.equal((await h.authed('PUT', '/api/plans/pro', { name: 'Pro <script>alert(1)</script>', description: '"comillas" & más', price: 499 })).statusCode, 200);
  const r = await page();
  assert.doesNotMatch(r.body, /<script>alert/);
  assert.match(r.body, /Pro &#60;script&#62;alert\(1\)&#60;\/script&#62;/);
  assert.match(r.body, /&#34;comillas&#34; &#38; más/);
});

t('en el dominio de una marca se ve su nombre, su color y su contacto', async () => {
  const b = await h.authed('POST', '/api/brands', { name: 'Mi Agencia', color: '#1a73e8', domain: 'precios.miagencia.com', support_email: 'ventas@miagencia.com' });
  assert.equal(b.statusCode, 200, b.body);
  const r = await page('precios.miagencia.com');
  assert.match(r.body, /<title>Precios — Mi Agencia<\/title>/);
  assert.match(r.body, /--accent: #1a73e8/);
  assert.match(r.body, /Contacto: ventas@miagencia\.com/);
  const main = await page();
  assert.doesNotMatch(main.body, /Mi Agencia/, 'el dominio principal no ve la marca');
});
