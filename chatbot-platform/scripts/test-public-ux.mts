/**
 * Accesibilidad de lo público (auditoría A2, A4 y A6): páginas del servidor, ayuda, inicio de sesión y registro, la página
 * para reservar de punta a punta y el widget de chat en el sitio de un cliente. PostgreSQL AISLADO y navegador real.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createHarness, pool } from '../test/harness.js';

assert.ok(process.env.TEST_DATABASE_URL, 'Define TEST_DATABASE_URL para una base de pruebas aislada; el arnés reinicia public.');
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const output = path.resolve('data/ux-test-results'); fs.mkdirSync(output, { recursive: true });
const h = await createHarness(); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: any = { screens: [], responsive: [], regressions: [], errors: [] };
const checked = (name: string) => { results.regressions.push(name); console.log('UX ✓', name); };
const { deletionToken } = await import('../src/accounts/self-service.js');
const { unsubscribeSig } = await import('../src/onboarding-checklist.js');

try {
  await h.createBot({ name: 'Recepción', personality: { prompt: 'Saluda y ayuda.' }, data_fields: [] });
  // Reservar: una llamada con una persona a elegir, para recorrer persona → día y hora → datos → listo.
  const ana = (await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'ana@publico.test', password: 'Pz-921-Qx-922-Kv', name: 'Ana', role: 'agent' })).json();
  const svc = (await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Llamada de diagnóstico', kind: 'call', duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 14, assigned_user_ids: [ana.id], customer_choice: true })).json();
  const link = (await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Agenda una llamada', service_ids: [svc.id] })).json();
  // Widget: un canal de chat web con un color de marca pálido (el contraste se corrige solo).
  const web = (await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'webchat', name: 'Chat del sitio', chatbot_id: h.botId, config: { title: 'Hotel Palmas', color: '#7dd3fc', welcome_message: 'Hola, ¿en qué te ayudo?' } })).json();
  h.setScript(() => ({ messages: ['Con gusto te ayudo con tu reservación.'] }));

  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address: any = h.app.server.address(); const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const audit = async (page: any, route: string, extra: Record<string, unknown> = {}) => {
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } })).violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary })) })));
    results.screens.push({ route, ...extra, violations });
  };

  // 1. Páginas del servidor, ayuda, inicio de sesión y registro: axe y sin desbordes, en claro y oscuro.
  const pages: [string, string][] = [
    ['precios', '/precios'], ['estado', '/estado'], ['contacto', '/contacto'], ['privacidad', '/privacidad'],
    ['borrar-cuenta', `/borrar-cuenta?t=${encodeURIComponent(deletionToken(h.accountId))}`],
    ['baja-recordatorios', `/baja-recordatorios?c=${h.accountId}&s=${unsubscribeSig(h.accountId)}`],
    ['ayuda', '/ayuda.html'], ['login', '/#/login'], ['registro', '/#/registro'],
  ];
  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme }); const page = await ctx.newPage();
    page.on('pageerror', (error) => results.errors.push({ route: page.url(), message: error.message }));
    for (const [name, url] of pages) {
      await page.goto(base + url); await page.locator('h1').first().waitFor(); await page.waitForTimeout(60);
      await audit(page, name, { width, theme });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      results.responsive.push({ width, theme, route: name, overflow });
      assert.equal(overflow, false, `Desbordamiento en ${name} ${width} ${theme}`);
      if (!url.startsWith('/#')) assert.equal(await page.evaluate(() => !!document.querySelector('main footer')), false, `${name}: el pie va fuera de <main>`);
    }
    await ctx.close();
  }
  checked('Páginas públicas, ayuda, inicio de sesión y registro sin hallazgos serios ni desbordes (320, 390 y 1440, claro y oscuro)');

  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } }); const page = await ctx.newPage();
    // Contacto: el campo que falla se marca y su mensaje se asocia (validación del servidor).
    await page.goto(`${base}/contacto`);
    await page.evaluate(() => document.querySelector('form')!.setAttribute('novalidate', ''));
    await page.getByLabel('Tu nombre').fill('Lucía');
    await page.getByLabel('Tu correo').fill('no-es-correo');
    await page.getByLabel('Mensaje').fill('Quiero saber más de los planes.');
    await page.getByRole('button', { name: 'Enviar mensaje' }).click();
    await page.locator('h1', { hasText: 'Contacto' }).waitFor();
    const email = page.getByLabel('Tu correo');
    assert.equal(await email.getAttribute('aria-invalid'), 'true');
    assert.match((await page.locator(`#${await email.getAttribute('aria-describedby')}`).textContent()) || '', /correo válido/);
    assert.equal(await page.getByLabel('Tu nombre').getAttribute('aria-invalid'), null, 'el nombre estaba bien');
    // Ayuda: imprimir es un botón, sin enlaces javascript:.
    await page.goto(`${base}/ayuda.html`);
    await page.getByRole('button', { name: 'Imprimir esta guía' }).waitFor();
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    await ctx.close();
  }
  checked('Contacto marca el campo que falla y la ayuda imprime con un botón');

  // 2. Reservar de punta a punta: el foco va al título de cada paso y nada se relee entero.
  for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: theme }); const page = await ctx.newPage();
    page.on('pageerror', (error) => results.errors.push({ route: 'reservar', message: error.message }));
    await page.goto(link.url.replace('https://bot.test', base));
    await page.getByRole('heading', { name: '¿Con quién?' }).waitFor();
    assert.equal(await page.locator('main').getAttribute('aria-live'), null, '<main> ya no es región en vivo');
    await audit(page, 'reservar · persona', { theme });
    await page.getByRole('button', { name: 'Ana' }).click();
    await page.getByRole('heading', { name: 'Llamada de diagnóstico' }).waitFor();
    await page.locator('[data-day]').first().waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
    const day = page.locator('[data-day]').nth(1);
    const visible = (await day.evaluate((b: any) => b.firstChild.textContent)).trim();
    assert.ok(((await day.textContent()) || '').startsWith(visible), 'el nombre del día empieza con su texto visible');
    assert.equal(await day.getAttribute('aria-label'), null);
    const chosen = await day.getAttribute('data-day');
    await day.click();
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.day || ''), chosen, 'el foco sigue en el día elegido');
    assert.equal(await page.locator('[data-day][aria-pressed="true"]').getAttribute('data-day'), chosen);
    await audit(page, 'reservar · horarios', { theme });
    await page.locator('.times').nth(1).getByRole('button').first().click();
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2' && /Llamada de diagnóstico:/.test(document.activeElement.textContent || ''));
    // Sin teléfono (la llamada lo pide): el error se dice y se asocia a su campo, que recibe el foco.
    await page.getByLabel('Tu nombre').fill('Lucía Pérez');
    await page.getByLabel(/Tu correo/).fill('lucia@cliente.mx');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await page.locator('#form-error').waitFor();
    const phone = page.getByLabel(/Tu teléfono/);
    assert.equal(await phone.getAttribute('aria-invalid'), 'true');
    assert.equal(await phone.getAttribute('aria-describedby'), 'form-error');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'f-phone');
    await audit(page, 'reservar · datos con error', { theme });
    await phone.fill('+52 55 1234 5678');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await page.getByRole('heading', { name: '¡Listo! Quedó agendada.' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '¡Listo! Quedó agendada.');
    await audit(page, 'reservar · listo', { theme });
    await ctx.close();
  }
  checked('Reservar: foco al título de cada paso, días con su texto visible, error en su campo y confirmación (claro y oscuro)');

  // 3. Widget en el sitio de un cliente (otra página, otro idioma): español, registro que anuncia y quién habla.
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } }); const page = await ctx.newPage();
    page.on('pageerror', (error) => results.errors.push({ route: 'widget', message: error.message }));
    await page.route(`${base}/sitio-del-cliente`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Hotel Palmas</title></head><body><main><h1>Hotel Palmas</h1><p>Welcome.</p></main><script src="/widget.js" data-channel="${web.webhook_token}" async></script></body></html>` }));
    await page.goto(`${base}/sitio-del-cliente`);
    const launcher = page.getByRole('button', { name: /Chatea con nosotros/ });
    await launcher.click();
    const log = page.getByRole('log', { name: 'Conversación' });
    await log.waitFor();
    assert.equal(await log.evaluate((l: any) => l.closest('[lang]')?.getAttribute('lang')), 'es');
    assert.match(await log.locator('.msg').first().innerText(), /^Hotel Palmas:/);
    // Abrir el chat lleva el foco al campo: con teclado se ve su contorno.
    const box = page.getByRole('textbox', { name: 'Mensaje' });
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    assert.notEqual(await box.evaluate((el: any) => getComputedStyle(el).outlineStyle), 'none', 'el campo enfocado tiene contorno');
    await box.fill('Quiero reservar una habitación');
    await page.getByRole('button', { name: 'Enviar' }).click();
    await log.getByText('Quiero reservar una habitación').waitFor();
    assert.match(await log.locator('.msg.me').last().innerText(), /^Tú:/);
    await log.getByText('Con gusto te ayudo con tu reservación.').waitFor({ timeout: 15000 });
    await audit(page, 'widget', { width });
    await ctx.close();
  }
  checked('Widget: en español, la conversación se anuncia con quién habla y el campo muestra su foco');

  // 4. Modo de color del widget: automático sigue al dispositivo; claro y oscuro lo fijan. Contraste y foco en cada uno.
  const panelBg = async (theme: string, scheme: 'light' | 'dark') => {
    await h.authed('PUT', `/api/channels/${web.id}`, { config: { title: 'Hotel Palmas', color: '#7dd3fc', welcome_message: 'Hola, ¿en qué te ayudo?', theme } });
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 900 }, colorScheme: scheme }); const page = await ctx.newPage();
    page.on('pageerror', (error) => results.errors.push({ route: 'widget', message: error.message }));
    await page.route(`${base}/sitio-del-cliente`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Hotel Palmas</title></head><body><main><h1>Hotel Palmas</h1></main><script src="/widget.js" data-channel="${web.webhook_token}" async></script></body></html>` }));
    await page.goto(`${base}/sitio-del-cliente`);
    await page.getByRole('button', { name: /Chatea con nosotros/ }).click();
    await page.getByRole('log', { name: 'Conversación' }).locator('.msg').first().waitFor();
    await audit(page, `widget · ${theme} · sistema ${scheme}`, { theme: scheme });
    const box = page.getByRole('textbox', { name: 'Mensaje' });
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    assert.notEqual(await box.evaluate((el: any) => getComputedStyle(el).outlineStyle), 'none', `contorno del campo (${theme}, ${scheme})`);
    const bg = await page.getByRole('log', { name: 'Conversación' }).evaluate((l: any) => getComputedStyle(l.closest('.panel')).backgroundColor);
    await ctx.close();
    return bg;
  };
  const DARK_PANEL = 'rgb(22, 27, 38)';
  assert.equal(await panelBg('auto', 'dark'), DARK_PANEL, 'automático + dispositivo oscuro = oscuro');
  assert.notEqual(await panelBg('auto', 'light'), DARK_PANEL, 'automático + dispositivo claro = claro');
  assert.notEqual(await panelBg('light', 'dark'), DARK_PANEL, 'fijo en claro aunque el dispositivo esté oscuro');
  assert.equal(await panelBg('dark', 'light'), DARK_PANEL, 'fijo en oscuro aunque el dispositivo esté claro');
  checked('Widget: modo de color automático, claro y oscuro, cada uno sin hallazgos serios y con el foco visible');

  assert.equal(results.errors.length, 0, JSON.stringify(results.errors));
  const serious = results.screens.flatMap((s: any) => s.violations.filter((v: any) => ['critical', 'serious'].includes(v.impact)).map((v: any) => ({ route: s.route, width: s.width, theme: s.theme, ...v })));
  results.serious = serious;
  assert.equal(serious.length, 0, JSON.stringify(serious, null, 2));
  console.log(`UX público OK: ${results.regressions.length} comprobaciones, ${results.screens.length} pantallas y ${results.responsive.length} escenarios adaptables.`);
} finally {
  fs.writeFileSync(`${output}/public-results.json`, JSON.stringify(results, null, 2));
  await browser?.close(); await h.app.close(); await pool.end();
}
