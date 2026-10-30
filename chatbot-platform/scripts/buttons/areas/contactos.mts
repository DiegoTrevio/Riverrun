/** Contactos: las vistas guardadas (abrir una y borrarla con «Eliminar vista seleccionada»). */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Abrir una vista guardada la deja elegida y «Eliminar vista seleccionada» la borra': async ({ f, pool, open, go }: AreaContext) => {
    const created = await f.login.admin('POST', '/api/contact-views', { name: 'Vista de la auditoría', filters: { view: 'all', tag: 'vip' } });
    assert.ok(created.statusCode < 300, created.body);
    const id = created.json().id;
    const { page } = await open('admin');
    await go(page, 'contacts');
    const remove = page.getByRole('button', { name: 'Eliminar vista seleccionada' });
    assert.equal(await remove.isDisabled(), true, 'sin vista elegida, «Eliminar vista seleccionada» no hace nada y debería estar deshabilitado');
    await page.getByRole('combobox', { name: 'Vista de contactos guardada' }).selectOption(id);
    await page.waitForURL(/tag=vip/);
    await page.locator('.main h1').waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Vista de contactos guardada' }).inputValue(), id, 'la vista abierta no queda elegida');
    await page.getByRole('button', { name: 'Eliminar vista seleccionada' }).click();
    await toast(page, 'Vista eliminada');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM contact_views WHERE id = $1', [id])).rows[0].n, 0, 'la vista no se borró');
  },
};
