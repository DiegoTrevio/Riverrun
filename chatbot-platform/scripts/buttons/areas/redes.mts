/** Publicaciones en redes: guardar una como borrador (no sale a ninguna red) y lo que dice si falta algo. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Nueva publicación → «Guardar como borrador»: sin red lo dice claro; con red la guarda sin publicarla': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'publicaciones/nueva');
    await page.getByPlaceholder('¿Qué quieres publicar?').fill('Borrador de la auditoría: promoción de diciembre');
    await page.getByRole('radio', { name: 'Guardar como borrador' }).check();
    await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
    // Sin red elegida: el aviso y la lista dicen qué falta, sin la clave interna del campo ni repetido.
    await toast(page, 'Elige al menos una red');
    assert.equal((await page.locator('.main li', { hasText: 'Elige al menos una red' }).first().innerText()).trim(), 'Elige al menos una red');
    await page.getByRole('checkbox', { name: /Instagram · @hotelpalmas/ }).first().check();
    await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
    await toast(page, 'Borrador guardado');
    await page.waitForURL(/#\/publicaciones$/);
    const row = (await pool.query(`SELECT status FROM social_publications WHERE account_id = $1 AND text LIKE 'Borrador de la auditoría%'`, [h.accountId])).rows[0];
    assert.equal(row?.status, 'borrador');
  },
};
