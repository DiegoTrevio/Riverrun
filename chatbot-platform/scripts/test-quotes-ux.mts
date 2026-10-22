/** Prueba en navegador del panel de cotizaciones: lista de precios, ajustes, historial y accesibilidad. */
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
const name = 'quotes_ux_' + randomUUID().replaceAll('-', '');
await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname = '/' + name;
process.env.TEST_DATABASE_URL = url.href;

const { createHarness, pool } = await import('../test/harness.js');
const qstore = await import('../src/store/quotes.js');
const { createQuote } = qstore;
const { exampleTemplate } = await import('../src/quotes/template.js');
const h = await createHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const errors: string[] = [];
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

try {
  await h.createBot({ ai: { debounce_seconds: 0.1 } });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const ix = h.cookie.indexOf('=');
  await context.addCookies([{ name: h.cookie.slice(0, ix), value: h.cookie.slice(ix + 1), url: base }]);
  await context.addInitScript((id) => localStorage.setItem('cp-account', id), h.accountId);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  // Lista de precios: un concepto exacto y uno con rango, desde el formulario.
  await page.goto(`${base}/#/cotizaciones`);
  await page.getByRole('heading', { name: 'Cotizaciones', exact: true }).waitFor();
  await page.getByRole('link', { name: '+ Nuevo concepto' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill('Renta de salón');
  await page.getByLabel('Unidad', { exact: true }).fill('evento');
  await page.getByLabel('Precio (MXN)', { exact: true }).fill('15000');
  await page.getByRole('button', { name: 'Guardar concepto' }).click();
  await page.getByRole('cell', { name: '$15,000.00 / evento' }).waitFor();
  checks.push('Alta de concepto con precio exacto; la clave se genera sola');

  await page.getByRole('link', { name: '+ Nuevo concepto' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill('Decoración');
  await page.getByLabel('Tipo de precio', { exact: true }).selectOption('range');
  await page.getByLabel('Mínimo (MXN)', { exact: true }).fill('5000');
  await page.getByLabel('Máximo (MXN)', { exact: true }).fill('3000');
  await page.getByRole('button', { name: 'Guardar concepto' }).click();
  await page.getByText(/mínimo debe ser menor/).first().waitFor();
  await page.getByLabel('Máximo (MXN)', { exact: true }).fill('8000');
  await page.getByRole('button', { name: 'Guardar concepto' }).click();
  await page.getByRole('cell', { name: '$5,000.00 a $8,000.00 / servicio' }).waitFor();
  const items = (await h.authed('GET', `/api/price-items?account_id=${h.accountId}`)).json();
  assert.deepEqual(items.map((i: any) => [i.code, i.price_min, i.price_max]).sort(), [['DECORACION', 500000, 800000], ['RENTA-DE-SALON', 1500000, null]]);
  checks.push('Rango con error explicado y corrección en el mismo formulario; montos guardados en centavos');

  // Ajustes.
  await page.goto(`${base}/#/cotizaciones/ajustes`);
  await page.getByLabel('Vigencia (días)', { exact: true }).fill('30');
  await page.getByLabel('Prefijo del folio', { exact: true }).fill('SAL-');
  await page.getByRole('button', { name: 'Guardar ajustes' }).click();
  await page.getByText('Ajustes guardados', { exact: true }).waitFor();
  const settings = (await h.authed('GET', `/api/quote-settings?account_id=${h.accountId}`)).json();
  assert.deepEqual([settings.validity_days, settings.folio_prefix], [30, 'SAL-']);
  checks.push('Ajustes de vigencia y folio guardados');

  // Formatos: subir el de ejemplo con una marca que el sistema no conoce; se guarda y se avisa.
  const PizZip = (await import('pizzip')).default;
  const zip = new PizZip(exampleTemplate());
  zip.file('word/document.xml', zip.file('word/document.xml')!.asText().replace('{{notas}}', '{{notas}} {{descuento}}'));
  await page.goto(`${base}/#/cotizaciones/formatos`);
  await page.getByLabel('Nombre del formato', { exact: true }).fill('Membrete');
  await page.getByLabel('Archivo de Word (.docx)', { exact: true }).setInputFiles({ name: 'membrete.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: zip.generate({ type: 'nodebuffer' }) as Buffer });
  await page.getByRole('button', { name: 'Subir formato' }).click();
  await page.getByText('{{descuento}}', { exact: true }).waitFor();
  await page.getByRole('cell', { name: 'Membrete', exact: true }).waitFor();
  const preview = await page.request.get(await page.getByRole('link', { name: 'Vista previa de Membrete versión 1' }).getAttribute('href').then((href) => `${base}${href}`));
  assert.equal(preview.headers()['content-type'], 'application/pdf');
  assert.match(await preview.text(), /COTIZACIÓN APROXIMADA/);
  checks.push('Formato de Word subido desde el panel, con aviso de marcas desconocidas y vista previa en PDF');

  // Historial y detalle.
  const q = await createQuote({ accountId: h.accountId, kind: 'approximate', status: 'sent', source: 'bot', today: '2026-10-20',
    customer: { nombre: 'Ana López' }, lines: [{ name: 'Decoración', qty: 1, price_mode: 'range', price_min: 500000, price_max: 800000, iva_mode: 'plus' }] });
  await page.goto(`${base}/#/cotizaciones/historial`);
  await page.getByRole('cell', { name: 'SAL-0001' }).click();
  await page.getByRole('heading', { name: /Cotización SAL-0001/ }).waitFor();
  await page.getByText('Total: $5,800.00 a $9,280.00').waitFor();
  checks.push('Historial con detalle, tipo aproximada y total en rango');

  // El agente: encender las cotizaciones desde su pestaña (guardar = aplicar).
  await page.goto(`${base}/#/bot/${h.botId}/cotizaciones`);
  await page.getByLabel('Preparar y enviar cotizaciones en PDF').check();
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await page.getByText('Cambios guardados', { exact: true }).waitFor();
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.equal(bot.ai.quotes.enabled, true);
  assert.equal(bot.ai.quotes.allow_final, true);
  checks.push('Cotizaciones encendidas desde la pestaña del agente');

  // Una final por aprobar: el equipo cambia la cantidad, aprueba y el cliente recibe el PDF.
  await qstore.createPriceItem(h.accountId, { code: 'MESERO', name: 'Mesero', description: '', unit: 'persona', price_mode: 'exact', price_min: 50000, price_max: null, iva_mode: 'plus', active: true, sort: 0 });
  h.setScript(() => ({ messages: ['Con gusto, la reviso con el equipo.'], quote: { action: 'prepare', items: [{ item_code: 'MESERO', qty: 1, qty_quote: '' }], notes: '', wants_final: true } }));
  await h.webhook('Quiero la cotización final de un mesero');
  await h.idle();
  const conv = await h.conversationFor();
  await page.goto(`${base}/#/conversation/${conv.id}`);
  const card = page.locator('#conversation-quotes');
  await card.getByText('Por aprobar').waitFor();
  await card.getByLabel('Cantidad de Mesero').fill('3');
  await card.getByRole('button', { name: 'Aprobar y enviar' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
  await page.getByText('Cotización enviada al cliente', { exact: true }).waitFor();
  const final = (await qstore.listQuotes(h.accountId, { conversationId: conv.id }))[0];
  assert.equal(final.status, 'sent');
  assert.equal(final.total_min, 3 * 50000 * 1.16);
  assert.ok(h.sent.some((x) => x.kind === 'file' && x.file === `Cotizacion-${final.folio}.pdf`));
  assert.ok(h.sent.some((x) => /cotización FINAL/.test(x.text)));
  checks.push('Cotización final corregida, aprobada y enviada desde la conversación');

  for (const route of ['cotizaciones/precios', 'cotizaciones/precios?id=new', 'cotizaciones/formatos', 'cotizaciones/ajustes', 'cotizaciones/historial', `cotizaciones/historial?id=${q.id}`, `bot/${h.botId}/cotizaciones`]) {
    for (const width of [1366, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/#/${route}`);
      await page.locator('.main h1').waitFor();
      await page.locator('.main [aria-busy="true"]').waitFor({ state: 'hidden' }).catch(() => undefined);
      await page.addScriptTag({ content: axe });
      const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
        .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
      assert.deepEqual(violations, [], `${route} a ${width}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} sin desbordamiento a ${width}`);
    }
  }
  checks.push('Cotizaciones accesibles en computadora, tableta y móvil');
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ checks, errors }, null, 2) + '\n');
} finally {
  await browser?.close();
  await h.app.close();
  await pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
