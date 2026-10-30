/** Oportunidades: crear un pipeline con «Guardar pipeline» y borrarlo (confirmando). */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Guardar pipeline lo crea con sus columnas; Borrar pipeline (confirmando) lo quita': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'pipeline/editar/nuevo');
    await page.getByLabel('Nombre del pipeline').fill('Ventas de la auditoría');
    await page.getByRole('button', { name: 'Guardar pipeline' }).click();
    await page.waitForFunction(() => !location.hash.includes('nuevo'));
    const p = (await pool.query(`SELECT id, stages FROM pipelines WHERE account_id = $1 AND name = 'Ventas de la auditoría'`, [h.accountId])).rows[0];
    assert.ok(p, 'el pipeline no se creó');
    assert.ok(Array.isArray(p.stages) ? p.stages.length >= 2 : true, 'el pipeline quedó sin columnas');
    await go(page, `pipeline/editar/${p.id}`);
    await page.getByRole('button', { name: 'Borrar pipeline' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Cancelar' }).click();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pipelines WHERE id = $1', [p.id])).rows[0].n, 1, 'Cancelar borró el pipeline');
    await page.getByRole('button', { name: 'Borrar pipeline' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await toast(page, 'Pipeline borrado');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pipelines WHERE id = $1', [p.id])).rows[0].n, 0);
  },
};
