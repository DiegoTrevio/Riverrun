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
const { createHarness, pool, waitFor } = await import('../test/harness.js');
const { outbox } = await import('../src/mailer.js');
const mailsTo = (email: string) => outbox.filter((m) => String(m.to).includes(email)).length;
const h = await createHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const errors: string[] = [];
const cspViolations: string[] = [];
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

try {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499 })).statusCode, 200);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'anual', name: 'Pro anual', price: 4990, interval: 'year' })).statusCode, 200);

  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  // La CSP no debe bloquear nada del panel ni de las páginas públicas: Chrome lo anota en la consola («Refused to…»).
  const newContext = browser.newContext.bind(browser);
  browser.newContext = (async (...args: Parameters<typeof newContext>) => {
    const ctx = await newContext(...args);
    ctx.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(`${m.location().url}: ${m.text()}`); });
    return ctx;
  }) as typeof newContext;
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  // Primera vez con Google: termina su registro aceptando los términos (con el pase firmado que deja Google).
  {
    const { googleSignupPass } = await import('../src/signup-guard.js');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const g = await ctx.newPage();
    g.on('pageerror', (e) => errors.push(e.message));
    await g.goto(`${base}/#/registro-google?token=${encodeURIComponent(googleSignupPass('gema@estudio.mx', 'Gema'))}`);
    await g.getByRole('heading', { name: 'Termina tu registro' }).waitFor();
    await g.getByText('gema@estudio.mx').waitFor();
    await g.evaluate(axe);
    const violations = await g.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], 'Registro con Google');
    assert.ok(await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Registro con Google sin desbordamiento');
    await g.getByLabel('Nombre de tu negocio').fill('Estudio Gema');
    await g.getByRole('button', { name: 'Crear mi cuenta' }).click();
    await g.getByText('Acepta los términos para continuar').waitFor();
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'gema@estudio.mx'`)).rows[0].n, 0);
    await g.getByRole('checkbox').check();
    await g.getByRole('button', { name: 'Crear mi cuenta' }).click();
    await g.waitForURL(/#\/agentes\/nuevo/);
    const terms = (await pool.query(`SELECT t.source FROM terms_acceptances t JOIN users u ON u.id = t.user_id WHERE u.email = 'gema@estudio.mx'`)).rows;
    assert.deepEqual(terms, [{ source: 'google' }]);
    await ctx.close();
    checks.push('Registro con Google: acepta términos antes de crear la cuenta (accesible en móvil)');
  }
  // Página pública de precios: accesible y sin desbordarse; cada plan lleva al registro con ese plan elegido.
  for (const width of [1366, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/precios`);
    await page.getByRole('heading', { name: 'Precios', exact: true }).waitFor();
    await page.evaluate(axe);
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

  // Tarjeta «Para empezar»: lo que le falta, con el plan porque hay cobro en línea; accesible y sin desbordarse.
  for (const width of [1366, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#/agentes`);
    await page.getByRole('heading', { name: 'Para empezar' }).waitFor();
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `Para empezar a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Para empezar sin desbordamiento a ${width}`);
  }
  const card = page.getByRole('region', { name: 'Para empezar' });
  await card.getByText('0 de 6 pasos listos').first().waitFor();
  await card.getByText('Elige tu plan').waitFor();
  await card.getByRole('link', { name: 'Crear agente' }).waitFor();
  // «Reenviar correo»: recién registrada pide esperar un minuto; después manda otra vez el correo para confirmar la cuenta.
  await card.getByRole('button', { name: 'Reenviar correo' }).click();
  await page.getByText('Espera un minuto antes de pedir otro correo').first().waitFor();
  await pool.query(`UPDATE auth_tokens SET created_at = now() - interval '2 minutes' WHERE kind = 'verify_email'`);
  const verifyMails = mailsTo('ana@estudio.mx');
  await card.getByRole('button', { name: 'Reenviar correo' }).click();
  await waitFor(() => mailsTo('ana@estudio.mx') > verifyMails, 5000);
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = 'ana@estudio.mx'`);
  await page.reload();
  await card.getByText('1 de 6 pasos listos').first().waitFor();
  await card.getByRole('button', { name: 'Ocultar' }).click();
  await card.waitFor({ state: 'detached' });
  await page.reload();
  await page.getByRole('heading', { name: 'Agentes' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Para empezar' }).count(), 0, 'oculta se queda oculta');
  checks.push('«Para empezar»: pasos con plan, avance al confirmar el correo, «Ocultar» y accesible en móvil');

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
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `Mi plan a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Mi plan sin desbordamiento a ${width}`);
  }
  checks.push('«Mi plan» accesible en computadora, tableta y móvil');

  // Cambiar de plan: Pro mensual → Pro anual, con la confirmación que explica el cobro.
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.goto(`${base}/#/plan`);
  const change = page.getByRole('region', { name: 'Cambiar de plan' });
  await change.getByRole('button', { name: 'Cambiar a Pro anual' }).click();
  const dlg = page.locator('dialog');
  // El anual sale más barato al mes: lo ya pagado queda a favor.
  await dlg.getByText(/Lo que ya pagaste del plan actual se descuenta de tu siguiente cobro/).waitFor();
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await page.getByText('Listo: ahora tienes el plan Pro anual').waitFor();
  await page.getByRole('heading', { name: /Plan Pro anual/ }).waitFor();
  assert.equal((await pool.query(`SELECT plan_key FROM subscriptions WHERE account_id = $1`, [accountId])).rows[0].plan_key, 'anual');
  checks.push('Cambiar de plan desde «Mi plan» con la confirmación del cobro');

  // Cobro fallido: la franja «Actualiza tu pago» aparece en todo el panel (accesible y sin desbordarse en móvil).
  await pool.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = now() WHERE account_id = $1`, [accountId]);
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#/agentes`);
    await page.getByText('No pudimos cobrar tu plan.').waitFor();
    await page.getByRole('link', { name: 'Actualizar pago' }).waitFor();
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `Franja de pago pendiente a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Franja de pago pendiente sin desbordamiento a ${width}`);
  }
  await page.getByRole('link', { name: 'Actualizar pago' }).click();
  await page.getByRole('heading', { name: 'Mi plan y pagos' }).waitFor();
  checks.push('Cobro fallido: franja «Actualiza tu pago» en todo el panel, también en móvil');

  // Facturación: con factura a su nombre; un RFC mal escrito se marca en su campo y uno válido se guarda.
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`${base}/#/plan`);
  const fiscal = page.getByRole('region', { name: 'Facturación' });
  await fiscal.getByLabel('Con factura a mi nombre').check();
  await fiscal.getByLabel('RFC').fill('EKU9003173C8');
  await fiscal.getByLabel('Nombre o razón social').fill('Escuela Kemper Urgate S.A. de C.V.');
  await fiscal.getByLabel('Régimen fiscal').selectOption('601');
  await fiscal.getByLabel('Código postal fiscal').fill('42501');
  await fiscal.getByRole('button', { name: 'Guardar' }).click();
  await fiscal.getByText(/revisa la homoclave/).waitFor();
  assert.equal(await fiscal.getByLabel('RFC').getAttribute('aria-invalid'), 'true');
  await page.evaluate(axe);
  const fiscalViolations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
    .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
  assert.deepEqual(fiscalViolations, [], 'Facturación a 390');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Facturación sin desbordamiento a 390');
  await fiscal.getByLabel('RFC').fill('EKU9003173C9');
  await fiscal.getByRole('button', { name: 'Guardar' }).click();
  await page.getByText('Datos de facturación guardados').waitFor();
  const fiscalRow = (await pool.query(`SELECT wants_invoice, rfc, legal_name, cfdi_use FROM account_fiscal WHERE account_id = $1`, [accountId])).rows[0];
  assert.deepEqual(fiscalRow, { wants_invoice: true, rfc: 'EKU9003173C9', legal_name: 'ESCUELA KEMPER URGATE', cfdi_use: 'G03' });
  checks.push('Facturación: con factura, error del RFC en su campo y datos guardados (accesible en móvil)');

  // Al pedir factura, el pago del mes recibe su CFDI: aparece en «Tus pagos» con su PDF y XML.
  const { processCfdi } = await import('../src/billing/cfdi.js');
  assert.equal(await processCfdi(), 1);
  await page.reload();
  await page.getByRole('heading', { name: 'Tus pagos' }).waitFor();
  await page.getByRole('columnheader', { name: 'Factura' }).waitFor();
  const pdfLink = page.getByRole('link', { name: /: PDF$/ }).first();
  await pdfLink.waitFor();
  const pdf = await page.request.get(new URL((await pdfLink.getAttribute('href'))!, base).href);
  assert.equal(pdf.status(), 200);
  assert.equal(pdf.headers()['content-type'], 'application/pdf');
  await page.evaluate(axe);
  const cfdiViolations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
    .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
  assert.deepEqual(cfdiViolations, [], 'Factura en el historial a 390');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Historial con factura sin desbordamiento a 390');
  checks.push('Factura (CFDI) del pago descargable en «Tus pagos» (accesible en móvil)');

  // Equipo: el dueño invita por correo desde «Mi equipo»; la persona abre el enlace, elige su contraseña y entra.
  await page.goto(`${base}/#/users`);
  const invite = page.getByRole('region', { name: 'Invitar a tu equipo' });
  await invite.getByLabel('Correo').fill('rita@estudio.mx');
  await invite.getByLabel('Nombre (opcional)').fill('Rita');
  await invite.getByRole('button', { name: 'Enviar invitación' }).click();
  await page.getByText('Invitación enviada a rita@estudio.mx').waitFor();
  // «Reenviar invitación» le manda el correo otra vez.
  const inviteMails = mailsTo('rita@estudio.mx');
  await invite.getByRole('button', { name: 'Reenviar invitación a rita@estudio.mx' }).click();
  await waitFor(() => mailsTo('rita@estudio.mx') > inviteMails, 5000);
  await page.evaluate(axe);
  const teamViolations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
    .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
  assert.deepEqual(teamViolations, [], 'Mi equipo a 390');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mi equipo sin desbordamiento a 390');
  const { outbox } = await import('../src/mailer.js');
  const inviteMail = [...outbox].reverse().find((m) => m.to === 'rita@estudio.mx')!;
  const inviteLink = /(http\S+#\/invitacion\?token=\S+)/.exec(inviteMail.text)![1];
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const g = await ctx.newPage();
    g.on('pageerror', (e) => errors.push(e.message));
    await g.goto(`${base}/#/invitacion?token=${new URL(inviteLink.replace('#/', '')).searchParams.get('token')}`);
    await g.getByRole('heading', { name: /^Únete a / }).waitFor();
    await g.getByText('rita@estudio.mx').waitFor();
    await g.evaluate(axe);
    const v = await g.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((x: any) => ['serious', 'critical'].includes(x.impact)).map((x: any) => x.id));
    assert.deepEqual(v, [], 'Invitación a 390');
    assert.ok(await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Invitación sin desbordamiento a 390');
    await g.getByLabel('Elige tu contraseña').fill('clave-de-rita');
    await g.getByLabel('Repítela').fill('clave-de-rita');
    await g.getByRole('checkbox').check();
    await g.getByRole('button', { name: 'Unirme al equipo' }).click();
    await g.waitForURL((u) => !u.hash.startsWith('#/invitacion'));
    // Ya entró con su sesión (no la manda a iniciar sesión).
    const me = await g.request.get(`${base}/api/me`);
    assert.equal(me.status(), 200);
    assert.equal((await me.json()).user.email, 'rita@estudio.mx');
    assert.ok(!(await g.evaluate(() => location.hash)).startsWith('#/login'));
    const rita = (await pool.query(`SELECT account_id, role FROM users WHERE email = 'rita@estudio.mx'`)).rows[0];
    assert.deepEqual([rita.account_id, rita.role], [accountId, 'agent']);
    await ctx.close();
  }
  checks.push('Invitar a tu equipo desde «Mi equipo» y unirse con el enlace eligiendo contraseña (accesible en móvil)');

  // «Tus datos»: el dueño descarga su cuenta y pide borrarla; con el borrado programado, la franja y «Cancelar el borrado».
  const accName = (await pool.query(`SELECT name FROM accounts WHERE id = $1`, [accountId])).rows[0].name as string;
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`${base}/#/plan`);
  const data = page.getByRole('region', { name: 'Tus datos' });
  // «Descargar todos mis datos (ZIP)» baja un archivo con contenido.
  const [zip] = await Promise.all([page.waitForEvent('download'), data.getByRole('link', { name: 'Descargar todos mis datos (ZIP)' }).click()]);
  assert.match(zip.suggestedFilename(), /\.zip$/, `descargó ${zip.suggestedFilename()}`);
  assert.ok(fs.statSync((await zip.path())!).size > 100, 'el ZIP vino vacío');
  await data.getByLabel(/Para confirmar, escribe el nombre de tu cuenta/).fill(accName);
  await data.getByRole('button', { name: 'Borrar mi cuenta' }).click();
  await page.getByText('Te enviamos un correo a ana@estudio.mx para confirmar el borrado').waitFor();
  await pool.query(`UPDATE accounts SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '7 days' WHERE id = $1`, [accountId]);
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#/agentes`);
    await page.getByText('Tu cuenta se va a borrar.').waitFor();
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `Franja de borrado a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Franja de borrado sin desbordamiento a ${width}`);
  }
  await page.getByRole('link', { name: 'Cancelar el borrado' }).click();
  await page.getByRole('heading', { name: 'Mi plan y pagos' }).waitFor();
  await page.evaluate(axe);
  const dataViolations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
    .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
  assert.deepEqual(dataViolations, [], 'Tarjeta «Tus datos» a 390');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Tarjeta «Tus datos» sin desbordamiento a 390');
  await page.getByRole('region', { name: 'Tus datos' }).getByRole('button', { name: 'Cancelar el borrado' }).click();
  await page.getByText('Listo: tu cuenta ya no se borrará').waitFor();
  assert.equal((await pool.query(`SELECT deletion_scheduled_for FROM accounts WHERE id = $1`, [accountId])).rows[0].deletion_scheduled_for, null);
  checks.push('Tus datos: descargar, pedir el borrado, la franja en todo el panel y cancelar el borrado (accesible en móvil)');

  // Topar un límite: en lugar de "revisa el formulario", qué se topó y un botón al plan que alcanza (del mismo periodo).
  await pool.query(`UPDATE plans SET limits = '{"users": 2}' WHERE key = 'anual'`);
  assert.equal((await h.authed('POST', '/api/plans', { key: 'equipo-anual', name: 'Equipo anual', price: 9990, interval: 'year', limits: { users: 10 } })).statusCode, 200);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`${base}/#/users`);
  await page.reload();
  await invite.getByLabel('Correo').fill('luz@estudio.mx');
  await invite.getByRole('button', { name: 'Enviar invitación', exact: true }).click();
  await invite.getByText('Llegaste al límite de usuarios de tu plan').waitFor();
  assert.equal(await invite.getByText('Revisa los datos del formulario').count(), 0, 'un límite no es un error del formulario');
  const up = invite.getByRole('link', { name: 'Subir a Equipo anual' });
  await up.waitFor();
  await page.evaluate(axe);
  const limitViolations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
    .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
  assert.deepEqual(limitViolations, [], 'Límite del plan a 390');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Límite del plan sin desbordamiento a 390');
  await up.click();
  await page.waitForURL((u) => u.hash === '#/plan?subir=equipo-anual');
  const chosen = page.locator('.card.chosen');
  await chosen.getByRole('heading', { name: 'Equipo anual' }).waitFor();
  const upNow = chosen.getByRole('button', { name: 'Subir ahora a Equipo anual' });
  await upNow.waitFor();
  assert.ok(await upNow.evaluate((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }), 'el botón para subir queda a la vista');
  // «Subir ahora» va a Stripe (su página de pago se simula aquí: nada sale de la máquina).
  await page.route(/^https:\/\/[a-z]+\.stripe\.test\//, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stripe</title><h1>Pago</h1>' }));
  const stripeCalls = fake.stripe.requests.length;
  await upNow.click();
  const confirm = page.locator('dialog[open]').getByRole('button', { name: /^(Continuar|Confirmar|Subir)/ });
  if (await confirm.count()) await confirm.first().click();
  await waitFor(() => fake.stripe.requests.length > stripeCalls, 5000);
  await page.unrouteAll({ behavior: 'wait' });
  checks.push('Topar el límite de usuarios: «Subir a …» lleva a Mi plan con el plan sugerido elegido (accesible en móvil)');

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

  // «Tu negocio»: el tablero del superadmin, desde el menú de Ajustes, accesible y sin desbordarse en móvil.
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#/negocio`);
    await page.getByRole('heading', { name: 'Tu negocio', level: 1 }).waitFor();
    await page.getByText('Ingreso mensual recurrente (MRR)').waitFor();
    await page.getByRole('heading', { name: 'Para cobrar de verdad' }).waitFor();
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `Tu negocio a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Tu negocio sin desbordamiento a ${width}`);
  }
  await page.goto(`${base}/#/ajustes`);
  await page.getByRole('link', { name: 'Tu negocio' }).first().click();
  await page.getByRole('heading', { name: 'Tu negocio', level: 1 }).waitFor();
  checks.push('Tu negocio: tablero del superadmin con ingresos, clientes, cobro y lo que falta para cobrar (accesible en móvil)');

  assert.deepEqual(errors, []);
  assert.deepEqual(cspViolations, [], 'La CSP bloqueó algo del panel o de una página pública');
  process.stdout.write(JSON.stringify({ checks, errors }, null, 2) + '\n');
} finally {
  await browser?.close();
  await h.app.close();
  await pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
