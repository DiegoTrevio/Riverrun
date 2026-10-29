/** Conversación abierta: pendientes, panel lateral y lo que el sondeo de 5 s vuelve a dibujar. */
import assert from 'node:assert/strict';
import type { AreaContext } from '../areas.mts';

export const checks = {
  'Marcar un pendiente como hecho: si el servidor falla, la casilla vuelve a como estaba': async ({ h, f, pool, open, go }: AreaContext) => {
    await h.authed('POST', `/api/contacts/${f.conv.contact_id}/tasks`, { kind: 'pendiente', body: 'Confirmar la fecha del evento' });
    const { page } = await open('admin');
    await go(page, `conversation/${f.conv.id}`);
    const box = page.getByRole('checkbox', { name: 'Hecho: Confirmar la fecha del evento' });
    await page.route('**/api/tasks/*', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { error: 'Servidor no disponible' } }) : route.continue());
    await box.check({ force: true }).catch(() => {});
    await page.getByText('Servidor no disponible').first().waitFor();
    assert.equal(await box.isChecked(), false, 'la casilla sigue marcada aunque no se guardó');
    assert.equal((await pool.query(`SELECT status FROM contact_tasks WHERE body = 'Confirmar la fecha del evento'`)).rows[0].status, 'abierta');
    await page.unrouteAll({ behavior: 'wait' });
    // Y cuando el servidor responde, queda hecho de verdad.
    await box.check();
    await page.locator('.task-row.done', { hasText: 'Confirmar la fecha del evento' }).waitFor();
    assert.equal((await pool.query(`SELECT status FROM contact_tasks WHERE body = 'Confirmar la fecha del evento'`)).rows[0].status, 'hecha');
  },
  'El panel lateral no cierra lo que abriste cuando se actualiza solo': async ({ f, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `conversation/${f.conv.id}`);
    const privacy = page.locator('details', { has: page.locator('summary', { hasText: 'Privacidad de este cliente' }) });
    await privacy.locator('summary').click();
    assert.equal(await privacy.evaluate((d: HTMLDetailsElement) => d.open), true);
    // Se escribe en el cuadro de mensajes (el foco sale del panel) y pasa más de un ciclo del sondeo (5 s).
    await page.locator('.composer textarea').focus();
    await page.waitForTimeout(6000);
    assert.equal(await page.locator('details', { has: page.locator('summary', { hasText: 'Privacidad de este cliente' }) }).evaluate((d: HTMLDetailsElement) => d.open), true, 'el sondeo cerró «Privacidad de este cliente»');
  },
};
