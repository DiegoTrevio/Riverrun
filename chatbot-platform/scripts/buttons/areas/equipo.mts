/** Mi equipo y la agenda de cada persona: controles que guardan al cambiar. */
import assert from 'node:assert/strict';
import type { AreaContext } from '../areas.mts';

export const checks = {
  'Cambiar el rol de alguien: si el servidor falla, el selector vuelve al rol que tiene': async ({ pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'users');
    const role = page.getByRole('combobox', { name: 'Rol de agent@auditoria.test' });
    assert.equal(await role.inputValue(), 'agent');
    await page.route('**/api/users/*', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: 'Servidor no disponible' } }) : route.continue());
    await role.selectOption('admin');
    await page.getByText('Servidor no disponible').first().waitFor();
    assert.equal((await pool.query(`SELECT role FROM users WHERE email = 'agent@auditoria.test'`)).rows[0].role, 'agent');
    assert.equal(await role.inputValue(), 'agent', 'el selector dice «Administrador» aunque no se guardó');
  },
  'Bloquear con mis eventos ocupados: si el servidor falla, la casilla vuelve a como estaba': async ({ f, h, pool, open, go }: AreaContext) => {
    await pool.query(`INSERT INTO staff_calendars (user_id, account_id, provider, email, refresh_token, block_busy) VALUES ($1, $2, 'google', 'auditor@empresa.test', 'x', true) ON CONFLICT (user_id) DO UPDATE SET block_busy = true`, [f.auditor.id, h.accountId]);
    const { page } = await open('admin');
    await go(page, 'agenda/equipo');
    const box = page.getByRole('checkbox', { name: 'Mis eventos ocupados bloquean mis horarios' });
    assert.equal(await box.isChecked(), true);
    await page.route('**/api/me/calendar', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: 'Servidor no disponible' } }) : route.continue());
    await box.click();
    await page.getByText('Servidor no disponible').first().waitFor();
    assert.equal((await pool.query(`SELECT block_busy FROM staff_calendars WHERE user_id = $1`, [f.auditor.id])).rows[0].block_busy, true);
    assert.equal(await box.isChecked(), true, 'la casilla quedó desmarcada aunque no se guardó');
    await pool.query(`DELETE FROM staff_calendars WHERE user_id = $1`, [f.auditor.id]);
  },
};
