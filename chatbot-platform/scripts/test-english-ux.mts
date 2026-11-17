/**
 * Panel en inglés en un navegador real: cada pantalla de cada rol se abre con el idioma en inglés y no debe quedar
 * texto del panel en español (lo que escribió la gente, como el nombre del negocio o los mensajes, no cuenta). También
 * revisa que quepa en un teléfono, la accesibilidad básica y que el selector cambie de idioma y lo recuerde.
 * PostgreSQL AISLADO (TEST_DATABASE_URL): el arnés reinicia public.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createHarness, pool } from '../test/harness.js';
import { seedUxFixture } from './ux-fixture.mts';

assert.ok(process.env.TEST_DATABASE_URL, 'Define TEST_DATABASE_URL para una base de pruebas aislada; el arnés reinicia public.');
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const root = path.resolve(import.meta.dirname, '..');

// Un texto que quedó en español y que está escrito en el código (panel o servidor) es texto del panel sin traducir;
// lo que solo existe en los datos de prueba (scripts/ux-fixture.mts) es contenido del negocio.
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|ts)$/.test(e.name) ? [path.join(d, e.name)] : []));
const source = [...walk(path.join(root, 'public', 'js')), ...walk(path.join(root, 'src'))].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const SPANISH = /[¿¡ñáéíóú]|\b(de|del|las|los|para|que|con|una|por|tus|sus|está|más|aquí|sin|también|todavía)\b/i;
const inCode = (text: string) => source.includes(text) || source.includes(text.replace(/"/g, '\\"'));

const h = await createHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const leftovers = new Map<string, Set<string>>();
const errors: string[] = [];
const checks: string[] = [];
try {
  const f = await seedUxFixture(h);
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address: any = h.app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const contextFor = async (role: string, options: any = {}) => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', ...options });
    const cookie = f.login[role].cookie;
    const ix = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, ix), value: cookie.slice(ix + 1), url: base }]);
    if (role === 'superadmin') await context.addInitScript((id: string) => localStorage.setItem('cp-account', id), h.accountId);
    return context;
  };
  const spanishLeft = (page: any) => page.evaluate((pattern: string) => {
    const re = new RegExp(pattern, 'i');
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      const text = (n.nodeValue || '').trim();
      if (!el || !text || el.closest('[translate="no"],script,style,textarea,code,pre,option') || !((el as HTMLElement).offsetParent || getComputedStyle(el).position === 'fixed')) continue;
      if (re.test(text)) out.push(text);
    }
    document.querySelectorAll('[aria-label],[title]').forEach((el) => {
      if (el.closest('[translate="no"]')) return;
      for (const name of ['aria-label', 'title']) { const v = el.getAttribute(name); if (v && re.test(v)) out.push(v); }
    });
    return out;
  }, SPANISH.source);

  // 1. Por omisión, un navegador en inglés ve el panel en inglés (pantalla de entrada, sin sesión).
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.EN_SCREENSHOT_SCALE || 1) });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`login: ${e.message}`));
    await page.goto(`${base}/#/login`);
    await page.getByRole('heading', { name: 'Sign in to your account' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    fs.mkdirSync(path.resolve('data/ux-test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve('data/ux-test-results/en-entrada.png') });
    // Cambiar a español desde la misma pantalla: se recuerda al volver a entrar.
    await page.getByRole('link', { name: 'Español' }).click();
    await page.getByRole('heading', { name: 'Entra a tu cuenta' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Entra a tu cuenta' }).waitFor();
    await page.getByRole('link', { name: 'English' }).click();
    await page.getByRole('heading', { name: 'Sign in to your account' }).waitFor();
    checks.push('La entrada sigue el idioma del navegador y el selector Español/English lo cambia y lo recuerda');
    await context.close();
  }

  // 2. Cada pantalla de cada rol, en inglés: sin texto del panel en español y sin errores.
  for (const role of ['admin', 'superadmin', 'agent']) {
    const context = await contextFor(role);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${role}: ${e.message}`));
    const routes = role === 'admin' ? f.routes.admin : role === 'agent' ? f.routes.agent : f.routes.superadmin;
    for (const route of routes) {
      await page.goto(`${base}/#/${route}`);
      await page.locator('.main h1').waitFor();
      await page.locator('.main [aria-busy="true"]').waitFor({ state: 'hidden' });
      await page.waitForTimeout(120);
      for (const text of await spanishLeft(page)) if (inCode(text)) {
        if (!leftovers.has(text)) leftovers.set(text, new Set());
        leftovers.get(text)!.add(route);
      }
    }
    await context.close();
  }
  checks.push(`${f.routes.admin.length + f.routes.agent.length + f.routes.superadmin.length} pantallas revisadas en inglés`);

  // Capturas en inglés para revisar a ojo (data/ux-test-results/en-*.png).
  {
    const output = path.resolve('data/ux-test-results');
    fs.mkdirSync(output, { recursive: true });
    const context = await contextFor('admin', { deviceScaleFactor: Number(process.env.EN_SCREENSHOT_SCALE || 1) });
    const page = await context.newPage();
    for (const [name, route] of [['agentes', 'agentes'], ['conversacion', `conversation/${f.conv.id}`], ['agenda', 'agenda'], ['cobros', 'cobros'], ['perfil', 'password']]) {
      await page.goto(`${base}/#/${route}`);
      await page.locator('.main h1').waitFor();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${output}/en-${name}.png` });
    }
    await context.close();
  }

  // 3. En un teléfono, las palabras en inglés caben (sin desbordar) y la accesibilidad sigue sin fallas graves.
  {
    const context = await contextFor('admin', { viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    for (const route of ['agentes', 'conversations', `conversation/${f.conv.id}`, 'agenda', 'cobros', 'automation/sequences/new', 'password', 'contacts']) {
      await page.goto(`${base}/#/${route}`);
      await page.locator('.main h1').waitFor();
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Desbordamiento en inglés: ${route}`);
      await page.evaluate(axe);
      const serious = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
      assert.deepEqual(serious, [], `Accesibilidad en inglés: ${route}`);
    }
    // El perfil tiene el selector de idioma; volver a español deja todo como siempre.
    await page.goto(`${base}/#/password`);
    await page.getByRole('heading', { name: 'Language' }).waitFor();
    await page.getByRole('button', { name: 'Español' }).click();
    await page.getByRole('heading', { name: 'Idioma' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es');
    checks.push('En inglés cabe en el teléfono, sin fallas graves de accesibilidad, y se puede volver a español desde Mi perfil');
    await context.close();
  }

  assert.deepEqual(errors, [], 'Errores de JavaScript en el panel en inglés');
  const report = [...leftovers].map(([text, routes]) => `  ${JSON.stringify(text)}  (${[...routes].slice(0, 2).join(', ')})`);
  assert.equal(report.length, 0, `Texto del panel que quedó en español (agrega su traducción en public/i18n/en.json):\n${report.join('\n')}`);
  for (const c of checks) console.log('EN ✓', c);
} finally {
  await browser?.close();
  await h.app.close();
  await pool.end();
}
