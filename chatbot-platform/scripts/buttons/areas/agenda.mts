/** Agenda: crear una cita desde el panel, abrirla y cancelarla; crear y eliminar un servicio. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Nueva cita → Agendar la guarda; abrirla → Cancelar cita la cancela con su motivo': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'agenda');
    await page.getByRole('button', { name: '+ Nueva cita' }).click();
    await page.getByLabel('Horario disponible').waitFor();
    await page.getByLabel('Nombre del cliente').fill('Cliente de la auditoría');
    await page.getByLabel('Teléfono').fill('5215598765432');
    await page.getByRole('button', { name: 'Agendar', exact: true }).click();
    await toast(page, 'Agendada');
    const appt = (await pool.query(`SELECT id, status FROM appointments WHERE account_id = $1 AND customer_name = 'Cliente de la auditoría'`, [h.accountId])).rows[0];
    assert.equal(appt?.status, 'confirmed', 'la cita no quedó guardada');
    // Se busca en el calendario (vista de lista si hace falta) y se abre.
    const event = page.getByRole('button', { name: /Cliente de la auditoría/ }).first();
    if (!(await event.count())) await page.getByRole('button', { name: 'Lista', exact: true }).click().catch(() => {});
    await event.click();
    const panel = page.getByRole('dialog', { name: /Cita de Cliente de la auditoría/ });
    await panel.getByRole('button', { name: 'Cancelar cita' }).click();
    await page.getByRole('dialog', { name: /Completa la información/ }).getByRole('button', { name: 'Guardar' }).click();
    await toast(page, 'Cancelada');
    const after = (await pool.query(`SELECT status, cancel_reason FROM appointments WHERE id = $1`, [appt.id])).rows[0];
    assert.equal(after.status, 'cancelled');
    assert.equal(after.cancel_reason, 'Cancelada por el negocio');
  },
  'Nuevo servicio → Guardar lo crea; Eliminar (confirmando) lo quita': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'agenda/servicios');
    await page.getByRole('link', { name: '+ Nuevo servicio' }).click();
    await page.getByLabel('Nombre', { exact: true }).first().fill('Servicio de la auditoría');
    await page.getByRole('button', { name: /^Guardar/ }).first().click();
    await page.waitForFunction(() => !location.hash.includes('id=new'));
    const svc = (await pool.query(`SELECT id, active FROM services WHERE account_id = $1 AND name = 'Servicio de la auditoría'`, [h.accountId])).rows[0];
    assert.ok(svc, 'el servicio no se creó');
    await go(page, `agenda/servicios?id=${svc.id}`);
    await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await page.waitForFunction(() => !location.hash.includes('id='));
    const gone = (await pool.query(`SELECT count(*)::int AS n FROM services WHERE id = $1 AND active`, [svc.id])).rows[0].n;
    assert.equal(gone, 0, 'el servicio sigue activo después de eliminarlo');
  },
};
