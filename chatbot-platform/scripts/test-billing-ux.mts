/** Prueba en navegador del cobro: precios + IVA en el registro y en «Mi plan», historial de pagos, editor de planes y accesibilidad. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import pg from 'pg';
import { chromium } from 'playwright';

const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Solo PostgreSQL local');
url.pathname = '/postgres';
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const name = 'billing_ux_' + randomUUID().replaceAll('-', '');
await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname = '/' + name;
process.env.TEST_DATABASE_URL = url.href;

// Orden obligatorio: los proveedores simulados fijan claves y URLs antes de que el arnés cargue la configuración.
const { fake, stripeEvent, stripeSub } = await import('../test/billing-fakes.js');
const { createHarness, pool } = await import('../test/harness.js');
const h = await createHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const errors: string[] = [];
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

try {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499 })).statusCode, 200);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'anual', name: 'Pro anual', price: 4990, interval: 'year' })).statusCode, 200);

  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  // Página pública de precios: accesible y sin desbordarse; cada plan lleva al registro con ese plan elegido.
  for (const width of [1366, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/precios`);
    await page.getByRole('heading', { name: 'Precios', exact: true }).waitFor();
    await page.addScriptTag({ content: axe });
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `Precios a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Precios sin desbordamiento a ${width}`);
  }
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.getByText('Total con IVA: $578.84 MXN al mes').waitFor();
  await page.getByRole('link', { name: 'Contratar el plan Pro', exact: true }).click();
  await page.getByRole('button', { name: 'Crear mi cuenta y pagar' }).waitFor();
  assert.ok(await page.locator('input[name="signup-plan"][value="pro"]').isChecked(), 'el plan elegido llega marcado');
  await page.goto(`${base}/precios`);
  await page.getByRole('link', { name: 'Probar 14 días gratis' }).click();
  await page.getByRole('button', { name: 'Crear mi cuenta', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Ver precios y planes' }).waitFor();
  checks.push('Página de precios accesible; «Contratar» llega al registro con el plan y «Probar gratis» sin plan');

  // Registro: los planes se ven "+ IVA", con el total que se cobra.
  await page.goto(`${base}/#/registro`);
  await page.getByText('$499 MXN + IVA / mes').waitFor();
  await page.getByText(/Total con IVA \(16 %\): \$578\.84 MXN al mes/).first().waitFor();
  await page.getByText('$4,990 MXN + IVA / año').waitFor();
  checks.push('El registro muestra los precios + IVA, el total y los planes anuales');

  // Una cuenta nueva (en prueba) ve las tarjetas de plan con el total con IVA.
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.8.8.8',
    payload: { name: 'Ana', company: 'Estudio Ana', business_type: 'servicios', email: 'ana@estudio.mx', password: 'clave-segura-1', accept_terms: true } });
  assert.equal(r.statusCode, 200, r.body);
  const accountId = r.json().user.account_id as string;
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const ix = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, ix), value: cookie.slice(ix + 1), url: base }]);
  await page.goto(`${base}/#/plan`);
  await page.getByRole('heading', { name: 'Mi plan y pagos' }).waitFor();
  await page.getByText('Total con IVA (16 %): $578.84 MXN al mes').waitFor();
  await page.getByText(/Los precios no incluyen IVA/).waitFor();
  checks.push('«Mi plan» en prueba: tarjetas con precio + IVA y total');

  // Se cobra la suscripción: el pago aparece en el historial con su IVA desglosado.
  fake.stripe.subs.sub_ux = stripeSub({ id: 'sub_ux', customer: 'cus_ux', metadata: { account_id: accountId, plan_key: 'pro' } });
  const now = Math.floor(Date.now() / 1000);
  const e = stripeEvent('invoice.paid', { id: 'in_ux', status: 'paid', subscription: 'sub_ux', amount_paid: 57884, currency: 'mxn', charge: 'ch_ux', status_transitions: { paid_at: now }, lines: { data: [{ period: { start: now, end: now + 30 * 86400 } }] } });
  assert.equal((await h.app.inject({ method: 'POST', url: '/webhook/billing/stripe', payload: e.payload, headers: e.headers })).statusCode, 200);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM billing_payments WHERE account_id = $1`, [accountId])).rows[0].n, 1);
  await page.reload();
  await page.getByRole('heading', { name: 'Tus pagos' }).waitFor();
  const row = page.locator('tbody tr').first();
  await row.getByText('Plan Pro').waitFor();
  for (const v of ['$499.00 MXN', '$79.84 MXN', '$578.84 MXN', 'Pagado']) await row.getByText(v, { exact: true }).waitFor();
  await page.getByText('$499 MXN + IVA / mes').waitFor();
  checks.push('Historial de pagos con subtotal, IVA y total');

  for (const width of [1366, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#/plan`);
    await page.getByRole('heading', { name: 'Tus pagos' }).waitFor();
    await page.addScriptTag({ content: axe });
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `Mi plan a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Mi plan sin desbordamiento a ${width}`);
  }
  checks.push('«Mi plan» accesible en computadora, tableta y móvil');

  // El superadmin captura precios sin IVA y elige el periodo. La última tarjeta es la de "Agregar plan".
  await context.clearCookies();
  const sx = h.cookie.indexOf('=');
  await context.addCookies([{ name: h.cookie.slice(0, sx), value: h.cookie.slice(sx + 1), url: base }]);
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.goto(`${base}/#/planes`);
  await page.getByRole('heading', { name: 'Planes y cobro' }).waitFor();
  await page.getByText('Se publica "+ IVA" y se cobra el precio más 16 % de IVA.').first().waitFor();
  const editor = page.locator('.card').last();
  await editor.getByLabel('Clave (minúsculas, sin espacios)').fill('basico');
  await editor.getByLabel('Nombre', { exact: true }).fill('Básico anual');
  await editor.getByLabel('Precio sin IVA').fill('1990');
  await editor.getByLabel('Se cobra').selectOption('year');
  await editor.getByRole('button', { name: 'Guardar' }).click();
  await page.getByText('Plan guardado').waitFor();
  const saved = (await pool.query(`SELECT price_cents, billing_interval FROM plans WHERE key = 'basico'`)).rows[0];
  assert.deepEqual([saved.price_cents, saved.billing_interval], [199000, 'year']);
  checks.push('El superadmin crea un plan anual con precio sin IVA');

  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ checks, errors }, null, 2) + '\n');
} finally {
  await browser?.close();
  await h.app.close();
  await pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
