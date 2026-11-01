/** Automatización: una regla desde plantilla (desactivada) que se activa, y publicar el lienzo de un flujo. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Plantilla rápida crea la regla desactivada; Activar la enciende y Desactivar la apaga': async ({ h, pool, open, go }: AreaContext) => {
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM automations WHERE account_id = $1', [h.accountId])).rows[0].n;
    const n = await count();
    const { page } = await open('admin');
    await go(page, 'automation/rules');
    await page.locator('.card', { has: page.getByRole('heading', { name: 'Plantillas rápidas' }) }).getByRole('button').first().click();
    await toast(page, /^Regla creada \(desactivada\)/);
    await page.waitForURL(/#\/automation\/rules\/[0-9a-f-]{36}/);
    assert.equal(await count(), n + 1);
    const id = page.url().split('/rules/')[1];
    assert.equal((await pool.query('SELECT active FROM automations WHERE id = $1', [id])).rows[0].active, false);
    await go(page, 'automation/rules');
    const row = page.locator('tr', { has: page.locator(`a[href="#/automation/rules/${id}"]`) });
    await row.getByRole('button', { name: 'Activar' }).click();
    await toast(page, 'Activada');
    assert.equal((await pool.query('SELECT active FROM automations WHERE id = $1', [id])).rows[0].active, true);
    await page.locator('tr', { has: page.locator(`a[href="#/automation/rules/${id}"]`) }).getByRole('button', { name: 'Desactivar' }).click();
    await toast(page, 'Desactivada');
    assert.equal((await pool.query('SELECT active FROM automations WHERE id = $1', [id])).rows[0].active, false);
  },
  'Ajustes → Privacidad: «Cancelar el borrado programado» deja la retención como estaba': async ({ h, pool, open, go }: AreaContext) => {
    const pending = { messages_days: 90, inactive_contacts_days: 0, effective_at: new Date(Date.now() + 7 * 86400_000).toISOString() };
    await pool.query(`UPDATE accounts SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retention}', $2::jsonb) WHERE id = $1`, [h.accountId, JSON.stringify({ messages_days: 0, inactive_contacts_days: 0, pending })]);
    const { page } = await open('admin');
    await go(page, 'automation/settings');
    await page.getByText(/Programado para el .*: borrar los mensajes con más de 90 días/).waitFor();
    await page.getByRole('button', { name: 'Cancelar el borrado programado' }).click();
    await toast(page, 'Borrado programado cancelado');
    const r = (await pool.query(`SELECT settings->'retention' AS r FROM accounts WHERE id = $1`, [h.accountId])).rows[0].r;
    assert.deepEqual([r.messages_days, r.pending], [0, null]);
  },
  'Publicar el lienzo deja la versión publicada y lo dice': async ({ f, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `automation/lienzo/${f.uxBoard}`);
    await page.getByRole('button', { name: /^Publicar/ }).click();
    await page.getByRole('dialog', { name: 'Flujo publicado' }).waitFor();
    // La primera versión publicada es la 0.
    const board = (await pool.query('SELECT published_revision, published_at FROM flow_boards WHERE id = $1', [f.uxBoard])).rows[0];
    assert.ok(board.published_revision !== null && board.published_at, 'el lienzo no quedó publicado');
  },
};
