/** Mi equipo y la agenda de cada persona: controles que guardan al cambiar. */
import assert from 'node:assert/strict';
import { outbox } from '../../../src/mailer.js';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Invitar a alguien: le llega el enlace, elige su contraseña y entra; Eliminar (confirmando) lo quita': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'users');
    const card = page.locator('section.card', { hasText: 'Invitar a tu equipo' });
    await card.getByLabel('Correo', { exact: true }).fill('nueva@auditoria.test');
    await card.getByLabel('Nombre (opcional)', { exact: true }).fill('Persona nueva');
    const before = outbox.length;
    await card.getByRole('button', { name: 'Enviar invitación', exact: true }).click();
    // Sin SMTP en las pruebas: queda guardada y el panel avisa que el correo no salió (el buzón de pruebas sí lo tiene).
    await toast(page, 'La invitación quedó guardada, pero no se pudo mandar el correo');
    const mail = outbox.slice(before).find((m: any) => m.to === 'nueva@auditoria.test');
    assert.ok(mail, 'no llegó la invitación');
    const token = decodeURIComponent(/#\/invitacion\/([^\s]+)/.exec(mail.text)![1]);
    const accepted = await h.app.inject({ method: 'POST', url: '/api/invitation/accept', remoteAddress: '10.99.0.1', payload: { token, name: 'Persona nueva', password: 'Pz-100-Qx-300-Kv', accept_terms: true } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'nueva@auditoria.test', password: 'Pz-100-Qx-300-Kv' } });
    assert.equal(login.statusCode, 200, 'la persona invitada no puede entrar');
    await go(page, 'users');
    await page.locator('tr', { hasText: 'nueva@auditoria.test' }).getByRole('button', { name: 'Eliminar', exact: true }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await toast(page, 'Eliminado');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'nueva@auditoria.test' AND active`)).rows[0].n, 0, 'la persona sigue activa');
  },
  'Hacer dueño (confirmando): la cuenta pasa a esa persona; luego vuelve': async ({ h, pool, open, go }: AreaContext) => {
    // Solo a un administrador con su correo verificado y su 2FA (entra una vez para configurarla).
    const heir = await h.addUser({ account_id: h.accountId, name: 'Heredera', email: 'heredera@auditoria.test', password: 'Pz-100-Qx-300-Kv', role: 'admin' });
    await h.loginAs('heredera@auditoria.test', 'Pz-100-Qx-300-Kv');
    const ownerBefore = (await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [h.accountId])).rows[0].owner_user_id;
    try {
      const { page } = await open('admin');
      await go(page, 'users');
      await page.locator('tr', { hasText: 'heredera@auditoria.test' }).getByRole('button', { name: 'Hacer dueño', exact: true }).click();
      await page.locator('dialog').getByRole('button', { name: 'Transferir' }).click();
      await toast(page, 'Listo: Heredera es el dueño de la cuenta');
      assert.equal((await pool.query(`SELECT owner_user_id FROM accounts WHERE id = $1`, [h.accountId])).rows[0].owner_user_id, heir.id, 'la cuenta no cambió de dueño');
    } finally {
      // La auditoría sigue con su dueño de siempre.
      await pool.query(`UPDATE accounts SET owner_user_id = $2 WHERE id = $1`, [h.accountId, ownerBefore]);
      await pool.query(`UPDATE users SET active = false WHERE id = $1`, [heir.id]);
    }
  },
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
  'Restablecer 2FA (confirmando): borra su verificación, cierra sus sesiones y queda «2FA pendiente»': async ({ f, h, pool, open, go }: AreaContext) => {
    await h.addUser({ account_id: h.accountId, name: 'Sin teléfono', email: 'sin-telefono@auditoria.test', password: 'Pz-100-Qx-300-Kv', role: 'agent' });
    const session = await h.loginAs('sin-telefono@auditoria.test', 'Pz-100-Qx-300-Kv'); // ya configuró su app
    const { page } = await open('admin');
    await go(page, 'users');
    const row = () => page.locator('tr', { hasText: 'sin-telefono@auditoria.test' });
    await row().getByText('2FA activo').waitFor();
    await row().getByRole('button', { name: 'Restablecer 2FA de sin-telefono@auditoria.test' }).click();
    await page.locator('dialog').getByText('Su verificación en dos pasos se borra, se cierran sus sesiones y la configura otra vez al entrar.').waitFor();
    await page.locator('dialog').getByRole('button', { name: 'Restablecer 2FA', exact: true }).click();
    await toast(page, 'Verificación en dos pasos restablecida');
    await row().getByText('2FA pendiente').waitFor();
    assert.equal((await pool.query(`SELECT totp_enabled_at FROM users WHERE email = 'sin-telefono@auditoria.test'`)).rows[0].totp_enabled_at, null, 'su verificación sigue activa');
    assert.equal((await session('GET', '/api/me')).statusCode, 401, 'sus sesiones siguen abiertas');
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
