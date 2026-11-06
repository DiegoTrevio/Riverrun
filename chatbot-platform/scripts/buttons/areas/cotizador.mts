/** Cotizador escrito: armar desde texto, probar el borrador con otros datos, descartarlo y activarlo en el agente. */
import assert from 'node:assert/strict';
import type { AreaContext } from '../areas.mts';

const tiers = (o: Record<string, unknown> = {}) => ({ of: '', steps: [], otherwise_value: '', otherwise_stop: '', ...o });
const litro = (code: string, acabado: string, escalon: string, price: number) => ({ code, name: `Pintura ${acabado}`, unit: 'litro', family: 'pintura', attributes: [{ key: 'acabado', value: acabado }, { key: 'escalon', value: escalon }], price, price_max: null, price_mode: 'exact', iva_mode: 'default' });
/** Lo que devolvería la IA al leer el texto (la prueba no gasta IA real). */
const BUILT = {
  summary: 'Pintura por m², con menudeo y mayoreo.',
  price_items: [litro('BTN-PM-MEN', 'mate', 'menudeo', 90), litro('BTN-PM-MAY', 'mate', 'mayoreo', 80), litro('BTN-PS-MEN', 'satinado', 'menudeo', 110), litro('BTN-PS-MAY', 'satinado', 'mayoreo', 95)],
  inputs: [
    { key: 'metros2', label: 'Metros cuadrados', help: '', type: 'number', unit: 'm²', min: 1, max: null, decimals: 2, options: [], required: true, default: '' },
    { key: 'acabado', label: 'Acabado', help: '', type: 'option', unit: '', min: null, max: null, decimals: 0, options: [{ value: 'mate', label: 'Mate' }, { value: 'satinado', label: 'Satinado' }], required: true, default: '' },
  ],
  values: [
    { key: 'litros', label: 'Litros', formula: 'redondear_arriba(metros2 / 10)', tiers: tiers() },
    { key: 'escalon', label: 'Escalón', formula: '', tiers: tiers({ of: 'metros2', steps: [{ below: 50, value: 'menudeo' }], otherwise_value: 'mayoreo' }) },
  ],
  lines: [{ label: 'Pintura {acabado}', family: 'pintura', match: [{ attribute: 'acabado', formula: 'acabado' }, { attribute: 'escalon', formula: 'escalon' }], qty: 'litros', when: '' }],
  stops: [],
  legend: 'Precio aproximado.',
  examples: [{ description: '20 m² mate', inputs: [{ key: 'metros2', value: '20' }, { key: 'acabado', value: 'mate' }] }],
  unclear: [],
};
const TEXT = 'Pintura por m². Litros = m² ÷ 10 hacia arriba. Mate $90 (menos de 50 m²) o $80; satinado $110 o $95.';

export const checks = {
  'Cotizador escrito: armar muestra ejemplos; «Calcular» prueba otros datos; «Descartar» no guarda; «Activar» lo conecta al agente': async ({ h, pool, open, go }: AreaContext) => {
    h.setScript((req: any) => (req.json_schema?.name === 'quote_builder' ? JSON.stringify(BUILT) : { messages: ['Ok'] }));
    try {
      const { page } = await open('admin');
      await go(page, `bot/${h.botId}/cotizaciones`);
      const card = page.locator('.quote-builder');
      const box = page.getByLabel('Productos, precios y reglas', { exact: true });
      await box.fill(TEXT);
      await card.getByRole('button', { name: /Armar cotizador|Volver a armar/ }).click();
      await card.getByText('Así lo entendí').waitFor();
      await card.locator('.qb-example').getByText('$208.80', { exact: true }).waitFor();

      // Probar con otros datos: 60 m² satinado → mayoreo: 6 litros × $95 = $570 + IVA = $661.20.
      await card.getByText('Probar con otros datos', { exact: true }).click();
      await card.getByLabel('Metros cuadrados (m²)', { exact: true }).fill('60');
      await card.getByLabel('Acabado', { exact: true }).selectOption('satinado');
      await card.getByRole('button', { name: 'Calcular', exact: true }).click();
      await card.getByText('$661.20', { exact: true }).waitFor();

      const saved = async () => (await pool.query(`SELECT count(*)::int AS n FROM price_items WHERE account_id = $1 AND code LIKE 'BTN-%'`, [h.accountId])).rows[0].n;
      await card.getByRole('button', { name: 'Descartar', exact: true }).click();
      await card.getByText('Descartado. No se guardó nada.').waitFor();
      assert.equal(await card.getByText('Así lo entendí').count(), 0, 'el borrador sigue a la vista');
      assert.equal(await saved(), 0, 'descartar guardó precios');

      await card.getByRole('button', { name: /Armar cotizador|Volver a armar/ }).click();
      await card.getByText('Así lo entendí').waitFor();
      await card.getByRole('button', { name: 'Activar en este agente', exact: true }).click();
      await page.locator('.quote-builder').getByRole('button', { name: 'Volver a armar' }).waitFor();
      assert.equal(await saved(), 4, 'activar no guardó los precios');
      const quotes = (await pool.query(`SELECT ai->'quotes' AS q FROM chatbots WHERE id = $1`, [h.botId])).rows[0].q;
      assert.equal(quotes.enabled, true);
      const calc = (await pool.query('SELECT source_text FROM quote_calculators WHERE id = $1 AND account_id = $2', [quotes.calculator_id, h.accountId])).rows[0];
      assert.equal(calc?.source_text, TEXT, 'el agente no quedó con la calculadora del texto');
    } finally {
      h.setScript(() => ({ messages: ['Ok'] }));
    }
  },
};
