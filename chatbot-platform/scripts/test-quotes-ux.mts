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

  // El cliente la aceptó: desde la conversación, en el celular, se crean 3 parcialidades con sus recordatorios.
  // Una página nueva a 390 px (la sesión es la misma): así se acomoda como en un celular.
  const phone = await page.context().newPage();
  await phone.setViewportSize({ width: 390, height: 900 });
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.goto(`${base}/#/conversation/${conv.id}`);
  await phone.locator('#conversation-quotes summary').click();
  await phone.locator('#conversation-quotes').getByRole('button', { name: 'El cliente aceptó' }).click();
  const acceptDialog = phone.getByRole('dialog');
  await acceptDialog.getByLabel('Crear cobro').selectOption('installments');
  await acceptDialog.getByText(/Pago 3 de 3: \$/).waitFor();
  await phone.evaluate(axe);
  const dialogViolations = await phone.evaluate(async () => (await (window as any).axe.run(document.querySelector('dialog[open]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
    .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
  assert.deepEqual(dialogViolations, [], 'diálogo «El cliente aceptó»');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'diálogo sin desbordamiento a 390');
  await acceptDialog.getByRole('button', { name: 'Marcar aceptada' }).click();
  await phone.getByText(/Cotización aceptada: 3 cobro\(s\) creado\(s\)/).waitFor();
  const charges = (await pool.query(`SELECT amount_cents::int AS c, installment FROM receivables WHERE source = 'quote' AND source_id LIKE $1 ORDER BY source_id`, [`${final.id}:%`])).rows;
  assert.deepEqual(charges.map((x) => x.installment), ['1 de 3', '2 de 3', '3 de 3']);
  assert.equal(charges.reduce((sum, x) => sum + x.c, 0), final.total_min);
  assert.equal((await qstore.findQuote(final.id))!.status, 'accepted');
  await phone.close();
  checks.push('El cliente aceptó: la cotización se marca y se crean sus parcialidades desde el celular');

  // Cotizador escrito: escribir productos, precios y reglas → armar (ejemplos calculados por el sistema) → activar.
  const tiers = (o: Record<string, unknown> = {}) => ({ of: '', steps: [], otherwise_value: '', otherwise_stop: '', ...o });
  const litro = (code: string, acabado: string, escalon: string, price: number) => ({ code, name: `Pintura ${acabado}`, unit: 'litro', family: 'pintura', attributes: [{ key: 'acabado', value: acabado }, { key: 'escalon', value: escalon }], price, price_max: null, price_mode: 'exact', iva_mode: 'default' });
  const built = {
    summary: 'Pintura por m², con precio de menudeo y mayoreo.',
    price_items: [litro('PM-MEN', 'mate', 'menudeo', 90), litro('PM-MAY', 'mate', 'mayoreo', 80), litro('PS-MEN', 'satinado', 'menudeo', 110), litro('PS-MAY', 'satinado', 'mayoreo', 95)],
    inputs: [
      { key: 'largo', label: 'Largo', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
      { key: 'ancho', label: 'Ancho', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
      { key: 'acabado', label: 'Acabado', help: '', type: 'option', unit: '', min: null, max: null, decimals: 0, options: [{ value: 'mate', label: 'Mate' }, { value: 'satinado', label: 'Satinado' }], required: true, default: '' },
    ],
    values: [
      { key: 'area', label: 'Área', formula: 'redondear(largo * ancho, 2)', tiers: tiers() },
      { key: 'litros', label: 'Litros', formula: 'redondear_arriba(area / 10)', tiers: tiers() },
      { key: 'escalon', label: 'Escalón', formula: '', tiers: tiers({ of: 'area', steps: [{ below: 50, value: 'menudeo' }], otherwise_value: 'mayoreo' }) },
    ],
    lines: [{ label: 'Pintura {acabado}', family: 'pintura', match: [{ attribute: 'acabado', formula: 'acabado' }, { attribute: 'escalon', formula: 'escalon' }], qty: 'litros', when: '' }],
    stops: [{ when: 'area > 500', message: 'Para más de 500 m² te atiende un asesor.' }],
    legend: 'Precio aproximado.',
    examples: [{ description: 'Cuarto de 5 × 4 m en mate', inputs: [{ key: 'largo', value: '5' }, { key: 'ancho', value: '4' }, { key: 'acabado', value: 'mate' }] }],
    unclear: [],
  };
  h.setScript((req) => (req.json_schema?.name === 'quote_builder' ? JSON.stringify(built) : { messages: ['Ok'] }));
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.goto(`${base}/#/bot/${h.botId}/cotizaciones`);
  await page.getByLabel('Productos, precios y reglas', { exact: true }).fill('Pintura por m². Litros = m² ÷ 10. Mate $90 menudeo / $80 mayoreo; satinado $110 / $95. Mayoreo desde 50 m².');
  await page.getByRole('button', { name: 'Armar cotizador' }).click();
  await page.getByText('Así lo entendí').waitFor();
  await page.getByText('Cuarto de 5 × 4 m en mate').waitFor();
  await page.locator('.qb-example').getByText('$208.80', { exact: true }).waitFor();
  assert.equal(await page.getByRole('listitem').filter({ hasText: 'Para más de 500 m² te atiende un asesor.' }).count(), 1);
  await page.evaluate(axe);
  const builderViolations = await page.evaluate(async () => (await (window as any).axe.run(document.querySelector('.quote-builder'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
    .violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => v.id));
  assert.deepEqual(builderViolations, [], 'cotizador escrito');
  if (process.env.QUOTES_UX_SHOT) await page.locator('.quote-builder').screenshot({ path: process.env.QUOTES_UX_SHOT });
  await page.getByRole('button', { name: 'Activar en este agente' }).click();
  await page.getByRole('button', { name: 'Volver a armar' }).waitFor();
  const activeBot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.ok(activeBot.ai.quotes.enabled && activeBot.ai.quotes.calculator_id, 'el agente cotiza con la calculadora del texto');
  assert.match(await page.getByLabel('Productos, precios y reglas', { exact: true }).inputValue(), /Pintura por m²/, 'el texto queda guardado para editarlo');
  checks.push('Cotizador escrito: armar desde texto con ejemplos calculados y activarlo en el agente');

  for (const route of ['cotizaciones/precios', 'cotizaciones/precios?id=new', 'cotizaciones/formatos', 'cotizaciones/ajustes', 'cotizaciones/historial', `cotizaciones/historial?id=${q.id}`, `bot/${h.botId}/cotizaciones`]) {
    for (const width of [1366, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/#/${route}`);
      await page.locator('.main h1').waitFor();
      await page.locator('.main [aria-busy="true"]').waitFor({ state: 'hidden' }).catch(() => undefined);
      await page.evaluate(axe);
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
