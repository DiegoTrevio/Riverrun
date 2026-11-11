/** Cotización hecha por el equipo desde el panel: «Guardar cotización» la crea y «Generar PDF y marcar enviada» la deja enviada. */
import assert from 'node:assert/strict';
import type { AreaContext } from '../areas.mts';

export const checks = {
  'Nueva cotización sin conversación: «Guardar cotización» la crea con el cliente y «Generar PDF y marcar enviada» la deja enviada con su PDF': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'cotizaciones/historial?id=new');
    await page.getByLabel('Nombre del cliente', { exact: true }).fill('Cliente de mostrador');
    await page.getByRole('button', { name: '+ Concepto', exact: true }).click();
    await page.locator('dialog').getByRole('button', { name: 'Agregar', exact: true }).click();
    await page.getByLabel('Concepto 1', { exact: true }).fill('Instalación especial');
    await page.getByLabel('Precio de Concepto', { exact: true }).fill('1500');
    await page.getByRole('button', { name: 'Guardar cotización', exact: true }).click();
    await page.getByRole('button', { name: 'Generar PDF y marcar enviada', exact: true }).waitFor();
    const row = async () => (await pool.query(`SELECT id, status, source, pdf_path, total_min::int AS total FROM quotes WHERE account_id = $1 AND customer_snapshot->>'nombre' = 'Cliente de mostrador'`, [h.accountId])).rows[0];
    const created = await row();
    assert.equal(created?.status, 'draft', 'no se creó la cotización');
    assert.equal(created.source, 'panel');
    assert.equal(created.total, 174000, '$1,500 + IVA');

    await page.getByRole('button', { name: 'Generar PDF y marcar enviada', exact: true }).click();
    await page.locator('dialog').locator('button.primary').click();
    await page.getByText('Enviada', { exact: true }).first().waitFor();
    const sent = await row();
    assert.equal(sent.status, 'sent', 'no quedó enviada');
    assert.ok(sent.pdf_path, 'no se generó el PDF');
  },
};
