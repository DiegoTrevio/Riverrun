/**
 * Prueba en navegador del registro con tarjeta: registrarse con captcha (simulado) → configurar 2FA → panel en
 * preparación (aviso «Falta verificar tu correo», IA deshabilitada con su motivo) → confirmar el correo → «Agregar
 * tarjeta» → completar en el Stripe simulado → «Periodo de prueba: quedan 14 días» y la IA disponible. El mismo correo
 * con `+etiqueta` en otra cuenta ve «Ya usaste tu prueba gratis»; el superadministrador ve «Esperando tarjeta», usa
 * «Activar sin tarjeta» y «Quitar freno». Accesible (axe) y sin desbordarse en computadora y en teléfono.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import pg from 'pg';
import { chromium, type BrowserContext, type Page } from 'playwright';

const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Solo PostgreSQL local');
url.pathname = '/postgres';
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const name = 'signup_ux_' + randomUUID().replaceAll('-', '');
await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname = '/' + name;
process.env.TEST_DATABASE_URL = url.href;

// Orden obligatorio: los proveedores simulados fijan claves y URLs antes de que el arnés cargue la configuración.
const { fake, stripeSub } = await import('../test/billing-fakes.js');
const { createHarness, pool } = await import('../test/harness.js');
const { currentStep, totpAt } = await import('../src/identity/totp.js');
const { outbox } = await import('../src/mailer.js');
const { config } = await import('../src/config.js');
const h = await createHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const errors: string[] = [];
const cspViolations: string[] = [];
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PASS = 'Pz-191-Qx-391-Kv';

// Turnstile simulado: el verificador acepta solo «tok-ok» y el widget es un botón «No soy un robot».
const verifier = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: new URLSearchParams(body).get('response') === 'tok-ok' })); });
});
await new Promise<void>((r) => verifier.listen(0, '127.0.0.1', () => r()));
Object.assign(config.signup.turnstile, { siteKey: 'sitio-ux', secretKey: 'secreto-ux', verifyUrl: `http://127.0.0.1:${(verifier.address() as any).port}` });
const FAKE_TURNSTILE = `window.turnstile = { render(box, o) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'No soy un robot';
  b.addEventListener('click', () => { b.textContent = 'Listo: no eres un robot'; o.callback('tok-ok'); });
  box.append(b);
} };`;

async function accessible(page: Page, label: string) {
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
      .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
    assert.deepEqual(violations, [], `${label} a ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label} sin desbordamiento a ${width}`);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
}
/** El texto del último correo que coincide en el buzón de pruebas (sale en segundo plano o al momento). */
async function mailTo(to: string, re: RegExp) {
  for (let i = 0; i < 50; i++) {
    const mail = outbox.filter((m) => m.to === to && re.test(m.text)).at(-1);
    if (mail) return mail.text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no llegó el correo a ${to}`);
}

try {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499 })).statusCode, 200);

  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const open = async (): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
    context.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(`${m.location().url}: ${m.text()}`); });
    // Nada sale de la máquina: el widget de Turnstile y la página de pago de Stripe se simulan aquí.
    await context.route(/^https:\/\/challenges\.cloudflare\.com\//, (route) => route.fulfill({ contentType: 'application/javascript', body: FAKE_TURNSTILE }));
    await context.route(/^https:\/\/[a-z]+\.stripe\.test\//, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="es"><title>Stripe</title><h1>Pago</h1></html>' }));
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page };
  };
  /** Una sesión del arnés puesta en un navegador nuevo (la cuenta ya pasó su 2FA). */
  const withSession = async (cookie: string) => {
    const s = await open();
    const ix = cookie.indexOf('=');
    await s.context.addCookies([{ name: cookie.slice(0, ix), value: cookie.slice(ix + 1), url: base }]);
    return s;
  };
  const signupApi = (email: string, company: string, ip: string) => h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: ip,
    payload: { name: 'Prueba', company, business_type: 'otro', email, password: PASS, accept_terms: true, turnstile_token: 'tok-ok' } });

  // 1) Registro con captcha y 2FA: termina en Mi plan, esperando la tarjeta.
  const tere = await open();
  const page = tere.page;
  await page.goto(`${base}/#/registro`);
  await page.getByRole('heading', { name: 'Crea tu asistente' }).waitFor();
  await page.getByText(/Agregas tu tarjeta en tu panel y no se cobra nada hasta que termine la prueba/).waitFor();
  await page.getByRole('button', { name: 'No soy un robot' }).waitFor();
  await accessible(page, 'Registro');
  await page.getByLabel('Tu nombre').fill('Tere');
  await page.getByLabel('Nombre de tu negocio').fill('Taller Tere');
  await page.getByLabel('Correo', { exact: true }).fill('tere@registro-ux.mx');
  await page.getByLabel('Contraseña', { exact: true }).fill(PASS);
  await page.locator('input[name="signup-plan"][value="pro"]').check();
  await page.getByLabel(/Acepto los términos/).check();
  await page.getByRole('button', { name: 'Crear mi cuenta', exact: true }).click();
  // Sin el captcha no se crea.
  await page.getByText('Confirma que no eres un robot').or(page.getByText(/captcha/i)).first().waitFor();
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'tere@registro-ux.mx'`)).rows[0].n, 0);
  await page.getByRole('button', { name: 'No soy un robot' }).click();
  await page.getByRole('button', { name: 'Crear mi cuenta', exact: true }).click();
  await page.waitForURL(/#\/login\/configurar/);
  const secret = (await page.locator('[data-totp-secret]').textContent())!.replace(/\s/g, '');
  await page.getByLabel('Código de 6 dígitos').fill(totpAt(secret, currentStep()));
  await page.getByRole('button', { name: 'Activar' }).click();
  await page.getByLabel('Ya los guardé en un lugar seguro').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.waitForURL(/#\/plan/);
  const account = (await pool.query(`SELECT a.id, a.status, a.pause_reason, a.signup_plan FROM accounts a JOIN users u ON u.account_id = a.id WHERE u.email = 'tere@registro-ux.mx'`)).rows[0];
  assert.deepEqual([account.status, account.pause_reason, account.signup_plan], ['paused', 'card', 'pro']);
  checks.push('Registro con captcha y 2FA: la cuenta espera su tarjeta con el plan elegido (accesible en móvil)');

  // 2) Panel en preparación: falta el correo; los botones de pago esperan; la IA, deshabilitada con su motivo.
  await page.getByRole('heading', { name: 'Activa tu prueba gratis de 14 días' }).waitFor();
  await page.getByText('Falta verificar tu correo.').waitFor();
  // «Reenviar» del aviso de arriba: recién registrada pide esperar un minuto; el de los pasos de Mi plan, ya pasado, lo manda.
  await page.locator('.banner').getByRole('button', { name: 'Reenviar' }).click();
  await page.getByText('Espera un minuto antes de pedir otro correo').first().waitFor();
  await pool.query(`UPDATE auth_tokens SET created_at = now() - interval '2 minutes' WHERE kind = 'verify_email'`);
  const verifyMails = outbox.filter((m) => m.to === 'tere@registro-ux.mx').length;
  await page.locator('ul.checklist').getByRole('button', { name: 'Reenviar' }).click();
  await page.getByText('Te enviamos un nuevo enlace').first().waitFor();
  assert.ok(outbox.filter((m) => m.to === 'tere@registro-ux.mx').length > verifyMails, 'llegó otro enlace');
  await page.getByText('Al registrarte elegiste el plan Pro.').waitFor();
  assert.ok(await page.getByRole('button', { name: 'Agregar tarjeta con Stripe' }).isDisabled(), 'sin el correo verificado no se abre el pago');
  await accessible(page, 'Mi plan esperando el correo');
  const cookie = (await tere.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/chatbots', headers: { cookie }, payload: { name: 'Asistente de Tere' } })).statusCode, 200);
  await page.goto(`${base}/#/asistente`);
  const read = page.getByRole('button', { name: 'Leer mi información' });
  await read.waitFor();
  assert.ok(await read.isDisabled(), 'la IA no se usa esperando la tarjeta');
  await page.getByText('Activa tu prueba para usar la IA').first().waitFor();
  assert.equal(await read.getAttribute('title'), 'Activa tu prueba para usar la IA');
  await accessible(page, 'Conocimiento con la IA deshabilitada');
  checks.push('Panel en preparación: «Falta verificar tu correo» con «Reenviar», el pago espera y la IA se ve deshabilitada con su motivo');

  // 3) Confirma el correo y agrega su tarjeta: empieza la prueba de 14 días.
  const link = (await mailTo('tere@registro-ux.mx', /verificar/)).match(/https?:\/\/\S+/)![0];
  await page.goto(`${base}/${new URL(link).hash}`);
  await page.getByText('Tu correo quedó confirmado.').waitFor();
  await page.goto(`${base}/#/agentes`);
  await page.getByText(/^Activa tu prueba gratis de 14 días: agrega tu tarjeta\./).waitFor();
  await page.getByText(/No se cobra nada hasta el/).first().waitFor();
  await page.getByRole('link', { name: 'Agregar tarjeta' }).click();
  await page.waitForURL(/#\/plan/);
  await page.getByRole('button', { name: 'Agregar tarjeta con Stripe' }).click();
  await page.waitForURL(/stripe\.test/);
  const check = (await pool.query(`SELECT ref FROM card_checks WHERE account_id = $1 ORDER BY opened_at DESC LIMIT 1`, [account.id])).rows[0];
  const end = Math.floor(Date.now() / 1000) + 14 * 86400;
  fake.stripe.subs.sub_tere = stripeSub({ id: 'sub_tere', customer: 'cus_tere', status: 'trialing', trial_end: end, default_payment_method: { id: 'pm_tere', card: { fingerprint: 'fp_tere' } }, metadata: { account_id: account.id, plan_key: 'pro' } });
  Object.assign(fake.stripe.sessions[check.ref], { status: 'complete', subscription: 'sub_tere' });
  await page.goto(`${base}/#/plan?pago=ok`);
  await page.getByText(/Periodo de prueba: quedan 14 días/).waitFor();
  assert.equal((await pool.query(`SELECT status FROM accounts WHERE id = $1`, [account.id])).rows[0].status, 'trial');
  await page.goto(`${base}/#/asistente`);
  assert.ok(!(await page.getByRole('button', { name: 'Leer mi información' }).isDisabled()), 'con la prueba la IA vuelve');
  checks.push('Confirma el correo, «Agregar tarjeta» en Stripe y empieza la prueba de 14 días (la IA vuelve)');

  // 4) El mismo correo con +etiqueta en otra cuenta: ya no hay prueba.
  {
    const r = await signupApi('tere+otra@registro-ux.mx', 'Taller Tere Dos', '10.9.0.2');
    assert.equal(r.statusCode, 200, r.body);
    await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = 'tere+otra@registro-ux.mx'`);
    const s = await withSession(await h.sessionFrom(r));
    await s.page.goto(`${base}/#/agentes`);
    await s.page.getByText('Ya usaste tu prueba gratis.').waitFor();
    await s.page.getByRole('link', { name: 'Contratar' }).waitFor();
    await s.page.goto(`${base}/#/plan`);
    await s.page.getByText('Ya usaste tu prueba gratis con este correo').waitFor();
    await s.page.getByRole('button', { name: 'Contratar con Tarjeta (Stripe)' }).waitFor();
    await accessible(s.page, 'Mi plan sin prueba');
    await s.context.close();
    checks.push('El mismo correo con +etiqueta ve «Ya usaste tu prueba gratis» y «Contratar» (accesible en móvil)');
  }

  // 5) El superadministrador: «Esperando tarjeta», «Activar sin tarjeta» y «Quitar freno».
  {
    const r = await signupApi('luis@registro-ux.mx', 'Taller Luis', '10.9.0.3');
    assert.equal(r.statusCode, 200, r.body);
    const sa = await open();
    await sa.page.goto(`${base}/#/login`);
    await sa.page.getByLabel('Correo').fill('admin@test.mx');
    await sa.page.getByLabel('Contraseña').fill('secreto123');
    await sa.page.getByRole('button', { name: 'Entrar' }).click();
    await sa.page.waitForURL(/#\/login\/codigo/);
    await sa.page.getByLabel('Código de 6 dígitos').fill(await h.codeFor('admin@test.mx'));
    await sa.page.getByRole('button', { name: 'Entrar' }).click();
    await sa.page.locator('.main h1').first().waitFor();
    await pool.query(`INSERT INTO rate_limits (key, hits, expires_at) VALUES ('card-check-brake', 1, now() + interval '1 hour') ON CONFLICT (key) DO UPDATE SET hits = 1, expires_at = now() + interval '1 hour'`);
    await sa.page.goto(`${base}/#/accounts`);
    await sa.page.getByRole('heading', { name: 'Perfiles de negocio' }).waitFor();
    const row = sa.page.locator('tr', { hasText: 'Taller Luis' });
    await row.getByText('Esperando tarjeta').waitFor();
    await sa.page.getByText('Freno a las verificaciones de tarjeta.').waitFor();
    await accessible(sa.page, 'Cuentas con el freno puesto');
    await row.getByRole('button', { name: 'Activar sin tarjeta' }).click();
    await sa.page.locator('dialog[open]').getByText(/sin tarjeta\? Úsalo solo en excepciones reales/).waitFor();
    await sa.page.locator('dialog[open]').getByRole('button', { name: 'Continuar' }).click();
    await sa.page.getByText('Prueba activada sin tarjeta').waitFor();
    await sa.page.locator('tr', { hasText: 'Taller Luis' }).getByText(/prueba · 1[34] d/).waitFor();
    await sa.page.getByRole('button', { name: 'Quitar freno' }).click();
    await sa.page.locator('dialog[open]').getByRole('button', { name: 'Continuar' }).click();
    await sa.page.getByText('Freno quitado').waitFor();
    await sa.page.getByText('Freno a las verificaciones de tarjeta.').waitFor({ state: 'detached' });
    await sa.context.close();
    checks.push('Cuentas: «Esperando tarjeta», «Activar sin tarjeta» con confirmación y «Quitar freno» (accesible en móvil)');
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(cspViolations, [], 'La CSP bloqueó algo del panel');
  process.stdout.write(JSON.stringify({ checks, errors }, null, 2) + '\n');
} finally {
  await browser?.close();
  verifier.close();
  await h.app.close();
  await pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
