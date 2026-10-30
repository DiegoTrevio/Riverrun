/**
 * Prueba en navegador de la verificación en dos pasos: configurar la app (QR, código, códigos de recuperación), entrar con
 * el código o con un código de recuperación, la verificación reciente, Mi perfil (códigos nuevos, olvidar un dispositivo),
 * restablecer el 2FA de alguien del equipo, el reto vencido y el registro con plan que abre el pago al terminar.
 * Accesible (axe) y sin desbordarse en computadora y en móvil.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import pg from 'pg';
import { chromium, type Page } from 'playwright';

const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Solo PostgreSQL local');
url.pathname = '/postgres';
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const name = 'identity_ux_' + randomUUID().replaceAll('-', '');
await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname = '/' + name;
process.env.TEST_DATABASE_URL = url.href;

// Orden obligatorio: los proveedores simulados fijan claves y URLs antes de que el arnés cargue la configuración.
await import('../test/billing-fakes.js');
const { createHarness, pool } = await import('../test/harness.js');
const { currentStep, totpAt } = await import('../src/identity/totp.js');
const h = await createHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const errors: string[] = [];
const cspViolations: string[] = [];
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PASS = 'Pz-961-Qx-962-Kv';

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

try {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
  await h.createBot();
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Nuria', email: 'nuria@identidad.mx', password: PASS, role: 'admin' })).statusCode, 200);
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Tomás', email: 'tomas@identidad.mx', password: PASS, role: 'agent' })).statusCode, 200);
  await h.loginAs('tomas@identidad.mx', PASS); // ya configuró su app
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', description: 'Todo incluido', price: 499 })).statusCode, 200);

  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  context.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(`${m.location().url}: ${m.text()}`); });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const enter = async (email: string, password: string) => {
    await page.goto(`${base}/#/login`);
    await page.getByLabel('Correo').fill(email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
  };

  // Primera vez: configurar la app.
  await enter('nuria@identidad.mx', PASS);
  await page.waitForURL(/#\/login\/configurar/);
  await page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }).waitFor();
  await page.getByText('Escanea este código con tu app de autenticación').waitFor();
  await page.getByRole('img', { name: 'Código QR para tu app de autenticación' }).waitFor();
  await accessible(page, 'Configurar la verificación');
  const secret = (await page.locator('[data-totp-secret]').textContent())!.replace(/\s/g, '');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  await page.getByLabel('Código de 6 dígitos').fill('000000');
  await page.getByRole('button', { name: 'Activar' }).click();
  await page.getByText('El código no es correcto').first().waitFor();
  await page.getByLabel('Código de 6 dígitos').fill(totpAt(secret, currentStep()));
  await page.getByRole('button', { name: 'Activar' }).click();
  await page.getByRole('heading', { name: 'Guarda tus códigos de recuperación' }).waitFor();
  let codes = await page.locator('.recovery-codes li').allTextContents();
  assert.equal(codes.length, 10);
  const proceed = page.getByRole('button', { name: 'Continuar' });
  assert.equal(await proceed.isDisabled(), true, 'no avanza sin confirmar que los guardó');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar .txt' }).click();
  assert.equal((await download).suggestedFilename(), 'codigos-de-recuperacion.txt');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.getByRole('button', { name: 'Copiar' }).click();
  await page.getByText('Códigos copiados').first().waitFor();
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes(codes[0]), 'copia los códigos');
  await accessible(page, 'Códigos de recuperación');
  await page.getByLabel('Ya los guardé en un lugar seguro').check();
  await proceed.click();
  await page.locator('.main h1').first().waitFor();
  assert.doesNotMatch(page.url(), /#\/login/);
  checks.push('Configurar la app: QR con su clave, código malo con su error, 10 códigos que se copian y se descargan, y no se avanza sin guardarlos (accesible en móvil)');

  // Las siguientes veces: el código.
  await context.clearCookies();
  await pool.query(`UPDATE users SET totp_last_step = 0 WHERE email = 'nuria@identidad.mx'`);
  await enter('nuria@identidad.mx', PASS);
  await page.waitForURL(/#\/login\/codigo/);
  await page.getByRole('heading', { name: 'Verificación en dos pasos' }).waitFor();
  await page.getByLabel('Recordar este dispositivo 30 días').waitFor();
  await accessible(page, 'Escribir el código');
  await page.getByLabel('Código de 6 dígitos').fill(totpAt(secret, currentStep()));
  await page.getByLabel('Recordar este dispositivo 30 días').check();
  const bell = page.waitForRequest((r) => r.url().includes('/api/notifications?limit=1'));
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('.main h1').first().waitFor();
  assert.equal((await bell).headers()['x-panel-background'], '1', 'la campana no cuenta como uso de la sesión');
  checks.push('Entrar con el código de la app (accesible en móvil); la campana va marcada como consulta del panel');

  // Acción delicada sin verificación reciente: pide el código y la repite.
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes' WHERE user_id = (SELECT id FROM users WHERE email = 'nuria@identidad.mx')`);
  await page.goto(`${base}/#/integraciones`);
  await page.getByLabel('Nombre de la llave').fill('Mi CRM');
  await page.getByRole('button', { name: 'Crear llave' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirma que eres tú' });
  await confirm.waitFor();
  await accessible(page, 'Confirma que eres tú');
  await pool.query(`UPDATE users SET totp_last_step = 0 WHERE email = 'nuria@identidad.mx'`);
  await confirm.getByLabel('Código de 6 dígitos').fill(totpAt(secret, currentStep()));
  await confirm.getByRole('button', { name: 'Confirmar' }).click();
  await page.getByRole('dialog', { name: 'Tu llave nueva' }).waitFor();
  await page.getByRole('button', { name: 'Ya la copié' }).click();
  assert.equal((await pool.query(`SELECT count(*)::int n FROM api_keys WHERE name = 'Mi CRM'`)).rows[0].n, 1);
  checks.push('Acción delicada sin verificación reciente: pide el código y la termina (accesible en móvil)');

  // Mi perfil → Verificación en dos pasos: códigos nuevos (con verificación reciente) y olvidar el dispositivo recordado.
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes' WHERE user_id = (SELECT id FROM users WHERE email = 'nuria@identidad.mx')`);
  await page.goto(`${base}/#/password`);
  const security = page.getByRole('region', { name: 'Verificación en dos pasos' });
  await security.getByText('Te quedan 10 códigos de recuperación.').waitFor();
  await security.getByRole('cell', { name: 'Chrome en Linux', exact: true }).waitFor();
  await accessible(page, 'Mi perfil → verificación en dos pasos');
  await security.getByRole('button', { name: 'Generar códigos nuevos' }).click();
  await page.getByRole('dialog', { name: 'Generar códigos nuevos' }).getByRole('button', { name: 'Generar códigos nuevos' }).click();
  const again = page.getByRole('dialog', { name: 'Confirma que eres tú' });
  await again.waitFor();
  await pool.query(`UPDATE users SET totp_last_step = 0 WHERE email = 'nuria@identidad.mx'`);
  await again.getByLabel('Código de 6 dígitos').fill(totpAt(secret, currentStep()));
  await again.getByRole('button', { name: 'Confirmar' }).click();
  const fresh = page.getByRole('dialog', { name: 'Tus códigos nuevos' });
  await fresh.waitFor();
  const newCodes = await fresh.locator('.recovery-codes li').allTextContents();
  assert.equal(newCodes.length, 10);
  assert.notDeepEqual(newCodes, codes);
  codes = newCodes;
  await accessible(page, 'Tus códigos nuevos');
  await fresh.getByRole('button', { name: 'Ya los guardé' }).click();
  await security.getByRole('button', { name: 'Olvidar Chrome en Linux' }).click();
  await security.getByText(/^Ninguno\./).waitFor();
  assert.equal((await pool.query(`SELECT count(*)::int n FROM user_devices d JOIN users u ON u.id = d.user_id WHERE u.email = 'nuria@identidad.mx' AND d.trusted_until > now()`)).rows[0].n, 0);
  checks.push('Mi perfil: códigos nuevos con verificación reciente y olvidar el dispositivo recordado (accesible en móvil)');

  // Equipo: restablecer el 2FA de un agente.
  await page.goto(`${base}/#/users`);
  const tomas = page.getByRole('row').filter({ hasText: 'tomas@identidad.mx' });
  await tomas.getByText('2FA activo').waitFor();
  await tomas.getByRole('button', { name: 'Restablecer 2FA de tomas@identidad.mx' }).click();
  const reset = page.getByRole('dialog', { name: 'Restablecer 2FA de Tomás' });
  await reset.getByText('Su verificación en dos pasos se borra, se cierran sus sesiones y la configura otra vez al entrar.').waitFor();
  await accessible(page, 'Restablecer 2FA');
  await reset.getByRole('button', { name: 'Restablecer 2FA' }).click();
  await page.getByRole('row').filter({ hasText: 'tomas@identidad.mx' }).getByText('2FA pendiente').waitFor();
  assert.equal((await pool.query(`SELECT totp_enabled_at FROM users WHERE email = 'tomas@identidad.mx'`)).rows[0].totp_enabled_at, null);
  checks.push('Equipo: «Restablecer 2FA» de un agente con su confirmación; queda «2FA pendiente» (accesible en móvil)');

  // Con un código de recuperación.
  await context.clearCookies();
  await enter('nuria@identidad.mx', PASS);
  await page.waitForURL(/#\/login\/codigo/);
  await page.getByRole('button', { name: 'Usar un código de recuperación' }).click();
  await page.getByLabel('Código de recuperación').fill(codes[1].toUpperCase());
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('.main h1').first().waitFor();
  await page.getByText(/Te quedan 9 códigos de recuperación/).first().waitFor();
  // El panel le pide configurar su app otra vez: lo lleva a Mi perfil con el aviso fijo.
  await page.waitForURL(/#\/password$/);
  const reconfigure = page.getByRole('region', { name: 'Verificación en dos pasos' });
  await reconfigure.getByText('Entraste con un código de recuperación. Si perdiste tu teléfono, pulsa «Cambiar de app» para configurar la app en el nuevo.').waitFor();
  await accessible(page, 'Mi perfil después de un código de recuperación');
  checks.push('Entrar con un código de recuperación (en mayúsculas): ve cuántos quedan y el panel le pide configurar su app otra vez');

  // El reto venció (o se borró): vuelve a pedir la contraseña con el aviso.
  await context.clearCookies();
  await enter('nuria@identidad.mx', PASS);
  await page.waitForURL(/#\/login\/codigo/);
  await context.clearCookies();
  await page.getByLabel('Código de 6 dígitos').fill('123456');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/#\/login$/);
  await page.getByText('Vuelve a escribir tu contraseña para continuar').first().waitFor();
  checks.push('Reto vencido: vuelve a entrar con su contraseña y el aviso');

  // El superadministrador no puede recordar el dispositivo.
  await context.clearCookies();
  await enter('admin@test.mx', 'secreto123');
  await page.waitForURL(/#\/login\/codigo/);
  await page.getByLabel('Código de 6 dígitos').waitFor();
  assert.equal(await page.getByLabel('Recordar este dispositivo 30 días').count(), 0, 'el superadmin siempre escribe el código');
  await page.getByLabel('Código de 6 dígitos').fill(await h.codeFor('admin@test.mx'));
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('.main h1').first().waitFor();
  checks.push('El superadmin entra con código y sin «Recordar este dispositivo»');

  // Registro con plan: primero configura la verificación y después abre el pago.
  await context.clearCookies();
  await page.route(/^https:\/\/[a-z]+\.stripe\.test\//, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stripe</title><h1>Pago</h1>' }));
  await page.goto(`${base}/#/registro?plan=pro`);
  await page.getByLabel('Tu nombre').fill('Oscar');
  await page.getByLabel('Nombre de tu negocio').fill('Taller Oscar');
  await page.getByLabel('Correo').fill('oscar@taller.mx');
  await page.getByLabel('Contraseña').fill(PASS);
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Crear mi cuenta y pagar' }).click();
  await page.waitForURL(/#\/login\/configurar/);
  const s2 = (await page.locator('[data-totp-secret]').textContent())!.replace(/\s/g, '');
  await page.getByLabel('Código de 6 dígitos').fill(totpAt(s2, currentStep()));
  await page.getByRole('button', { name: 'Activar' }).click();
  await page.getByLabel('Ya los guardé en un lugar seguro').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.waitForURL(/stripe\.test/);
  checks.push('Registro con plan: configura la verificación y después abre el pago');

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
