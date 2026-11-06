/**
 * Cotizaciones → Calculadoras y lista de precios: plantilla por giro, probar con datos, apagar y encender, exportar,
 * importar, eliminar, copiar a otra cuenta (superadmin) y subir la lista de precios en CSV (revisar, confirmar, cancelar).
 */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

const DEF = {
  inputs: [{ key: 'm2', label: 'Metros cuadrados', type: 'number', min: 1 }, { key: 'acabado', label: 'Acabado', type: 'option', options: [{ value: 'mate', label: 'Mate' }, { value: 'satinado', label: 'Satinado' }] }],
  values: [{ key: 'litros', formula: 'redondear_arriba(m2 / 10)' }],
  lines: [{ label: 'Pintura {acabado}', family: 'pintura', match: { acabado: 'acabado' }, qty: 'litros' }],
  stops: [{ when: 'm2 > 500', message: 'Para más de 500 m² te atiende un asesor.' }],
  legend: 'Aproximada.',
};
const item = (code: string, acabado: string, pesos: number) => ({ code, name: `Pintura ${acabado}`, description: '', unit: 'litro', family: 'pintura', attributes: { acabado }, price_mode: 'exact', price_min: pesos * 100, price_max: null, iva_mode: 'plus', active: true, sort: 0 });
const FILE = { format: 'riverrun.quote-calculator', version: 2, name: 'Pintura (botones)', template_key: 'texto', source_text: 'Pintura por m²: mate $90, satinado $110 el litro.', definition: DEF, price_items: [item('BTNC-MATE', 'mate', 90), item('BTNC-SAT', 'satinado', 110)] };

export const checks = {
  'Plantilla por giro: llena el cuadro del cotizador, pidiendo confirmar si ya había texto': async ({ h, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/cotizaciones`);
    const box = page.getByLabel('Productos, precios y reglas', { exact: true });
    await box.fill('Mi texto a medias');
    await page.locator('.qb-templates').getByRole('button', { name: 'Salón y eventos', exact: true }).click();
    await page.locator('dialog').getByRole('button', { name: 'Cancelar' }).click();
    assert.equal(await box.inputValue(), 'Mi texto a medias', 'cancelar reemplazó el texto');
    await page.locator('.qb-templates').getByRole('button', { name: 'Salón y eventos', exact: true }).click();
    await page.locator('dialog').getByRole('button', { name: 'Reemplazar' }).click();
    assert.match(await box.inputValue(), /invitados/);
  },
  'Calculadoras: probar con datos, apagar y encender, exportar, importar (llega apagada) y eliminar': async ({ h, pool, open, go }: AreaContext) => {
    const calc = (await h.authed('POST', `/api/quote-calculators/import?account_id=${h.accountId}`, FILE)).json();
    try {
      const { page } = await open('admin');
      await go(page, 'cotizaciones/calculadoras');
      await page.getByRole('row').filter({ hasText: 'Pintura (botones)' }).first().click();
      await page.getByRole('heading', { name: 'Lo que pide al cliente' }).waitFor();
      await page.getByText('Probar con datos', { exact: true }).click();
      await page.getByLabel('Metros cuadrados', { exact: true }).fill('25');
      await page.getByLabel('Acabado', { exact: true }).selectOption('satinado');
      await page.getByRole('button', { name: 'Calcular', exact: true }).click();
      await page.getByText('$382.80', { exact: true }).waitFor(); // 3 litros × $110 + IVA
      // Llegó importada (apagada): encender y apagar.
      await page.getByRole('button', { name: 'Encender', exact: true }).click();
      await toast(page, 'Calculadora encendida');
      await page.getByRole('button', { name: 'Apagar', exact: true }).click();
      await toast(page, 'Calculadora apagada');
      assert.equal((await pool.query('SELECT active FROM quote_calculators WHERE id = $1', [calc.id])).rows[0].active, false);
      const download = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Exportar', exact: true }).click();
      assert.match((await download).suggestedFilename(), /calculadora-.*\.json/);

      // Importar desde la lista: un archivo que no es calculadora avisa; uno bueno abre su detalle.
      await go(page, 'cotizaciones/calculadoras');
      await page.locator('#calc-import').setInputFiles({ name: 'nada.json', mimeType: 'application/json', buffer: Buffer.from('no es json') });
      await toast(page, 'Ese archivo no es una calculadora exportada');
      await page.locator('#calc-import').setInputFiles({ name: 'calc.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...FILE, name: 'Pintura importada (botones)', price_items: [] })) });
      await page.getByRole('heading', { name: /Pintura importada \(botones\)/ }).waitFor();
      await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
      await page.locator('dialog').getByRole('button', { name: 'Cancelar' }).click();
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM quote_calculators WHERE name = 'Pintura importada (botones)'`)).rows[0].n, 1, 'cancelar eliminó');
      await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
      await page.locator('dialog').getByRole('button', { name: 'Eliminar' }).click();
      await toast(page, 'Calculadora eliminada');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM quote_calculators WHERE name = 'Pintura importada (botones)'`)).rows[0].n, 0);
    } finally {
      await pool.query('DELETE FROM price_items WHERE calculator_id = $1', [calc.id]);
      await pool.query('DELETE FROM quote_calculators WHERE id = $1', [calc.id]);
    }
  },
  'Copiar una calculadora a otra cuenta (superadmin): llega apagada y con sus precios': async ({ h, pool, open, go }: AreaContext) => {
    const calc = (await h.authed('POST', `/api/quote-calculators/import?account_id=${h.accountId}`, FILE)).json();
    const target = await h.addAccount({ name: 'Destino de la copia (botones)' });
    try {
      const { page } = await open('superadmin');
      await go(page, 'agentes');
      await page.locator('#profile-switch').selectOption(h.accountId);
      await go(page, `cotizaciones/calculadoras?id=${calc.id}`);
      await page.getByRole('button', { name: 'Copiar a otra cuenta', exact: true }).click();
      const dlg = page.locator('dialog');
      await dlg.getByLabel('Cuenta', { exact: true }).selectOption(target.id);
      await dlg.getByLabel('Copiar también sus precios').uncheck();
      await dlg.getByLabel('Copiar también sus precios').check();
      await dlg.getByRole('button', { name: 'Copiar', exact: true }).click();
      await toast(page, /Copiada a «Destino de la copia \(botones\)» \(apagada\)/);
      const copy = (await pool.query('SELECT id, active FROM quote_calculators WHERE account_id = $1', [target.id])).rows[0];
      assert.equal(copy?.active, false);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM price_items WHERE account_id = $1 AND calculator_id = $2', [target.id, copy.id])).rows[0].n, 2);
    } finally {
      await pool.query('DELETE FROM accounts WHERE id = $1', [target.id]);
      await pool.query('DELETE FROM price_items WHERE calculator_id = $1', [calc.id]);
      await pool.query('DELETE FROM quote_calculators WHERE id = $1', [calc.id]);
    }
  },
  'Lista de precios en CSV: revisar antes de guardar, cancelar, confirmar y errores por fila': async ({ h, pool, open, go }: AreaContext) => {
    const csv = 'clave,nombre,precio,familia\nBTN-CSV-1,Lámina,250,lamina\n';
    try {
      const { page } = await open('admin');
      await go(page, 'cotizaciones/precios');
      const upload = page.locator('input[id^="csv-"]');
      await upload.setInputFiles({ name: 'precios.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByText(/1 concepto nuevo y 0 actualizados/).waitFor();
      await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
      assert.equal(await page.getByText(/1 concepto nuevo/).count(), 0, 'cancelar no quitó el aviso');
      await upload.setInputFiles({ name: 'precios.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('button', { name: 'Confirmar importación' }).click();
      await toast(page, 'Lista de precios actualizada');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM price_items WHERE account_id = $1 AND code = 'BTN-CSV-1'`, [h.accountId])).rows[0].n, 1);
      await page.locator('input[id^="csv-"]').setInputFiles({ name: 'malo.csv', mimeType: 'text/csv', buffer: Buffer.from('clave,nombre,precio\nX,Algo,mucho\n') });
      await page.getByText(/Fila 2: «mucho» no es un precio/).waitFor();
    } finally {
      await pool.query(`DELETE FROM price_items WHERE account_id = $1 AND code = 'BTN-CSV-1'`, [h.accountId]);
    }
  },
};
