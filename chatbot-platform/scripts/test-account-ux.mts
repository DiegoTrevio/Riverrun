/**
 * Prueba en navegador de la cuenta: un administrador que no es dueño ve Mi plan sin botones y no toca al dueño; el dueño
 * invita a un administrador, que se une con el enlace, configura su 2FA y recibe la cuenta con «Hacer dueño»; cambiar el
 * correo desde Mi perfil y confirmarlo con el enlace; la confirmación de «Desactivar» dice qué se va; y el
 * superadministrador, dentro de la cuenta, ve los controles del dueño. Accesible (axe) y sin desbordarse en computadora
 * y en móvil.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import pg from 'pg';
import { chromium, type BrowserContext, type Page } from 'playwright';

const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Solo PostgreSQL local');
url.pathname = '/postgres';
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const name = 'account_ux_' + randomUUID().replaceAll('-', '');
await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname = '/' + name;
process.env.TEST_DATABASE_URL = url.href;

// Orden obligatorio: los proveedores simulados fijan claves y URLs antes de que el arnés cargue la configuración.
await import('../test/billing-fakes.js');
const { createHarness, pool } = await import('../test/harness.js');
const { currentStep, totpAt } = await import('../src/identity/totp.js');
const { outbox } = await import('../src/mailer.js');
const h = await createHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const errors: string[] = [];
const cspViolations: string[] = [];
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PASS = 'Pz-959-Qx-960-Kv';
const OWNER_ONLY = (owner: string) => `Solo el dueño de la cuenta (${owner}) puede hacer esto`;

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
/** El texto de un correo del buzón de pruebas (sale en segundo plano o al momento). */
async function mailTo(to: string, re: RegExp, since: number) {
  for (let i = 0; i < 50; i++) {
    const mail = outbox.slice(since).find((m) => m.to === to && re.test(m.text));
    if (mail) return mail.text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no llegó el correo a ${to}`);
}

try {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
  await h.createBot();
  // La primera administradora que acepta queda como dueña.
  await h.addUser({ account_id: h.accountId, name: 'Dueña', email: 'duena@cuenta-ux.mx', password: PASS, role: 'admin' });
  await h.addUser({ account_id: h.accountId, name: 'Beto', email: 'beto@cuenta-ux.mx', password: PASS, role: 'admin' });
  for (const email of ['duena@cuenta-ux.mx', 'beto@cuenta-ux.mx']) await h.loginAs(email, PASS); // ya configuraron su app
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499 })).statusCode, 200);

  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const open = async (): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
    context.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(`${m.location().url}: ${m.text()}`); });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page };
  };
  const enter = async (page: Page, email: string) => {
    await page.goto(`${base}/#/login`);
    await page.getByLabel('Correo').fill(email);
    await page.getByLabel('Contraseña').fill(PASS);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/#\/login\/codigo/);
    await page.getByLabel('Código de 6 dígitos').fill(await h.codeFor(email));
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.locator('.main h1').first().waitFor();
  };
  const go = async (page: Page, route: string, heading: string | RegExp) => {
    // Ir a la misma ruta no vuelve a dibujar la pantalla: entonces se recarga.
    const target = `${base}/#/${route}`;
    if (page.url() === target) await page.reload();
    else await page.goto(target);
    await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
  };
  const ownerButtons = (page: Page) => page.locator('main button').filter({ hasText: /^(Contratar con|Administrar pago|Cambiar tarjeta|Descargar todos mis datos|Borrar mi cuenta)/ });

  // Un administrador que no es dueño: Mi plan sin botones y el dueño fuera de su alcance.
  const beto = await open();
  await enter(beto.page, 'beto@cuenta-ux.mx');
  await go(beto.page, 'plan', 'Mi plan y pagos');
  await beto.page.getByText(OWNER_ONLY('Dueña')).first().waitFor();
  assert.equal(await ownerButtons(beto.page).count(), 0, 'quien no es dueño no ve los botones del dinero ni de la cuenta');
  await accessible(beto.page, 'Mi plan sin ser dueño');
  await go(beto.page, 'users', 'Usuarios y permisos');
  const ownerRow = beto.page.locator('tr', { hasText: 'duena@cuenta-ux.mx' });
  await ownerRow.getByText('Dueño', { exact: true }).waitFor();
  assert.equal(await ownerRow.getByRole('button').count(), 0, 'no tiene acciones sobre la dueña');
  await ownerRow.getByText(OWNER_ONLY('Dueña')).waitFor();
  assert.equal(await beto.page.getByRole('combobox', { name: 'Rol' }).locator('option[value="admin"]').count(), 0, 'no invita administradores');
  await accessible(beto.page, 'Equipo sin ser dueño');
  checks.push('Un administrador que no es dueño ve Mi plan sin botones y no toca al dueño ni invita administradores (accesible en móvil)');

  // La dueña invita a una administradora; ella se une con el enlace y configura su app.
  const duena = await open();
  await enter(duena.page, 'duena@cuenta-ux.mx');
  await go(duena.page, 'users', 'Usuarios y permisos');
  const card = duena.page.locator('section.card', { hasText: 'Invitar a tu equipo' });
  await card.getByLabel('Correo', { exact: true }).fill('nora@cuenta-ux.mx');
  await card.getByLabel('Nombre (opcional)', { exact: true }).fill('Nora');
  await card.getByRole('combobox', { name: 'Rol' }).selectOption('admin');
  const sent = outbox.length;
  await card.getByRole('button', { name: 'Enviar invitación' }).click();
  await duena.page.getByText('La invitación quedó guardada, pero no se pudo mandar el correo').first().waitFor(); // sin SMTP
  const token = decodeURIComponent(/#\/invitacion\/([^\s]+)/.exec(await mailTo('nora@cuenta-ux.mx', /#\/invitacion\//, sent))![1]);
  const nora = await open();
  await nora.page.goto(`${base}/#/invitacion/${token}`);
  await nora.page.getByRole('heading', { name: /^Únete a / }).waitFor();
  await accessible(nora.page, 'Unirse con la invitación');
  await nora.page.getByLabel('Elige tu contraseña').fill(PASS);
  await nora.page.getByLabel('Repítela').fill(PASS);
  await nora.page.getByRole('checkbox').first().check();
  await nora.page.getByRole('button', { name: 'Unirme al equipo' }).click();
  await nora.page.waitForURL(/#\/login\/configurar/);
  const secret = (await nora.page.locator('[data-totp-secret]').textContent())!.replace(/\s/g, '');
  h.totpSecrets.set('nora@cuenta-ux.mx', secret);
  await nora.page.getByLabel('Código de 6 dígitos').fill(totpAt(secret, currentStep()));
  await nora.page.getByRole('button', { name: 'Activar' }).click();
  await nora.page.getByLabel('Ya los guardé en un lugar seguro').check();
  await nora.page.getByRole('button', { name: 'Continuar' }).click();
  await nora.page.locator('.main h1').first().waitFor();
  checks.push('La dueña invita a una administradora; ella se une con el enlace (#/invitacion/<token>) y configura su app (accesible en móvil)');

  // La dueña le transfiere la cuenta; Nora ve los botones de Mi plan y Dueña ya no.
  await go(duena.page, 'users', 'Usuarios y permisos');
  await duena.page.locator('tr', { hasText: 'nora@cuenta-ux.mx' }).getByRole('button', { name: 'Hacer dueño' }).click();
  await duena.page.locator('dialog').getByText('Será el único que maneja el plan, los pagos y a los administradores. Tú quedas como administrador.').waitFor();
  await duena.page.locator('dialog').getByRole('button', { name: 'Transferir' }).click();
  await duena.page.getByText('Listo: Nora es el dueño de la cuenta').first().waitFor();
  await go(nora.page, 'plan', 'Mi plan y pagos');
  assert.ok((await ownerButtons(nora.page).count()) > 0, 'la nueva dueña ve los botones de Mi plan');
  assert.equal(await nora.page.getByText(OWNER_ONLY('Nora')).count(), 0);
  await go(duena.page, 'plan', 'Mi plan y pagos');
  await duena.page.getByText(OWNER_ONLY('Nora')).first().waitFor();
  assert.equal(await ownerButtons(duena.page).count(), 0, 'la anterior ya no maneja el dinero');
  checks.push('«Hacer dueño» con su confirmación: la nueva dueña ve los botones de Mi plan y la anterior ya no');

  // Cambiar el correo desde Mi perfil y confirmarlo con el enlace que llega al correo nuevo.
  await go(beto.page, 'password', 'Mi perfil');
  await beto.page.getByRole('button', { name: 'Cambiar correo' }).click();
  await beto.page.locator('dialog').getByLabel('Correo nuevo').fill('beto@nuevo-ux.mx');
  const before = outbox.length;
  await beto.page.locator('dialog').getByRole('button', { name: 'Guardar' }).click();
  await beto.page.getByText('Te mandamos un enlace a beto@nuevo-ux.mx. El cambio se aplica al abrirlo.').first().waitFor();
  const change = /#\/cambiar-correo\/([\w-]+)/.exec(await mailTo('beto@nuevo-ux.mx', /#\/cambiar-correo\//, before))![1];
  const link = await open();
  await link.page.goto(`${base}/#/cambiar-correo/${change}`);
  await link.page.getByText('Tu correo cambió. Entra con tu correo nuevo.').waitFor();
  await accessible(link.page, 'Correo cambiado');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'beto@nuevo-ux.mx' AND email_verified_at IS NOT NULL`)).rows[0].n, 1);
  checks.push('Cambiar el correo en Mi perfil: llega el enlace al correo nuevo y al abrirlo cambia (accesible en móvil)');

  // Desactivar a Beto dice qué se va con él (su llave y su webhook).
  h.totpSecrets.set('beto@nuevo-ux.mx', h.totpSecrets.get('beto@cuenta-ux.mx')!);
  const betoApi = await h.loginAs('beto@nuevo-ux.mx', PASS);
  assert.equal((await betoApi('POST', '/api/api-keys', { name: 'Llave de Beto', scope: 'read' })).statusCode, 200);
  assert.equal((await betoApi('POST', '/api/webhook-endpoints', { url: 'https://hooks.example.com/beto', events: ['*'] })).statusCode, 200);
  await go(nora.page, 'users', 'Usuarios y permisos');
  await nora.page.locator('tr', { hasText: 'beto@nuevo-ux.mx' }).getByRole('button', { name: 'Desactivar' }).click();
  await nora.page.locator('dialog').getByText('Se revocan 1 llaves de API y 0 invitaciones, y se pausan 1 webhooks que creó.', { exact: false }).waitFor();
  await nora.page.locator('dialog').getByRole('button', { name: 'Desactivar' }).click();
  await nora.page.getByText('Desactivado').first().waitFor();
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM api_keys WHERE name = 'Llave de Beto' AND revoked_at IS NULL`)).rows[0].n, 0);
  checks.push('La confirmación de «Desactivar» dice cuántas llaves y webhooks se van, y se van');

  // El superadministrador dentro de la cuenta ve los controles del dueño (Review Focus 5).
  const sa = await open();
  await sa.context.addInitScript((id: string) => { try { localStorage.setItem('cp-account', id); } catch { /* sin storage */ } }, h.accountId);
  await sa.page.goto(`${base}/#/login`);
  await sa.page.getByLabel('Correo').fill('admin@test.mx');
  await sa.page.getByLabel('Contraseña').fill('secreto123');
  await sa.page.getByRole('button', { name: 'Entrar' }).click();
  await sa.page.waitForURL(/#\/login\/codigo/);
  await sa.page.getByLabel('Código de 6 dígitos').fill(await h.codeFor('admin@test.mx'));
  await sa.page.getByRole('button', { name: 'Entrar' }).click();
  await sa.page.locator('.main h1').first().waitFor();
  await go(sa.page, 'users', 'Usuarios y permisos');
  await sa.page.locator('tr', { hasText: 'nora@cuenta-ux.mx' }).getByText('Dueño', { exact: true }).waitFor();
  await sa.page.locator('tr', { hasText: 'duena@cuenta-ux.mx' }).getByRole('button', { name: 'Hacer dueño' }).waitFor();
  await go(sa.page, 'plan', 'Mi plan y pagos');
  assert.equal(await sa.page.getByText(/Solo el dueño de la cuenta/).count(), 0, 'el superadministrador no ve el aviso de solo lectura');
  checks.push('El superadministrador, dentro de la cuenta, ve al dueño y sus controles');

  assert.deepEqual(errors, []);
  assert.deepEqual(cspViolations, [], 'La CSP bloqueó algo del panel');
  process.stdout.write(JSON.stringify({ checks, errors }, null, 2) + '\n');
} finally {
  await browser?.close();
  await h.app.close();
  await pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
