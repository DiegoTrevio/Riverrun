/** Conversación abierta: pendientes, panel lateral y lo que el sondeo de 5 s vuelve a dibujar. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

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
  'Tomar conversación, Devolver al bot y Cerrar cambian quién atiende': async ({ f, pool, open, go }: AreaContext) => {
    const status = async () => (await pool.query('SELECT status FROM conversations WHERE id = $1', [f.conv.id])).rows[0].status;
    const { page } = await open('admin');
    await go(page, `conversation/${f.conv.id}`);
    const header = page.locator('.main');
    await header.getByRole('button', { name: 'Tomar conversación' }).click();
    await toast(page, 'Tomaste la conversación');
    assert.equal(await status(), 'human');
    await header.getByRole('button', { name: 'Devolver al bot' }).click();
    await toast(page, 'El bot vuelve a responder');
    assert.equal(await status(), 'bot');
    await header.getByRole('button', { name: 'Cerrar', exact: true }).first().click();
    await toast(page, 'Cerrada');
    assert.equal(await status(), 'closed');
  },
  'El agente que suelta su conversación («Quitar asignación») vuelve a su bandeja sin errores': async ({ h, f, pool, open, go }: AreaContext) => {
    const agent = (await pool.query(`SELECT id FROM users WHERE email = 'agent@auditoria.test'`)).rows[0].id;
    await h.authed('PUT', `/api/conversations/${f.conv.id}/assign`, { user_id: agent });
    const { page } = await open('agent');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await go(page, `conversation/${f.conv.id}`);
    await page.getByRole('combobox', { name: 'Asignar conversación' }).selectOption('none');
    await toast(page, 'Sin asignar');
    await page.waitForURL(/#\/conversations$/, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    try {
      assert.equal((await pool.query('SELECT assigned_user_id FROM conversations WHERE id = $1', [f.conv.id])).rows[0].assigned_user_id, null);
      assert.deepEqual(errors, [], 'error de JavaScript al soltar la conversación');
      assert.match(page.url(), /#\/conversations$/, 'se quedó en una conversación que ya no puede ver');
    } finally {
      // Se deja como estaba: la conversación de los datos de prueba es del agente.
      await h.authed('PUT', `/api/conversations/${f.conv.id}/assign`, { user_id: agent });
    }
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
