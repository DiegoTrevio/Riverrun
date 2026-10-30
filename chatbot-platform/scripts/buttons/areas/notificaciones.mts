/** Notificaciones: «Reintentar» un aviso que no llegó lo vuelve a mandar y dice cómo le fue. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Reintentar un aviso que no llegó lo vuelve a intentar y avisa el resultado': async ({ h, pool, open, go }: AreaContext) => {
    // Reintentar vuelve a empezar la cuenta de intentos de ese aviso (attempts = 0 y lo intenta otra vez).
    const receipts = async () => (await pool.query(`SELECT id, attempts, status FROM alert_receipts WHERE account_id = $1 AND channel = 'whatsapp' ORDER BY id`, [h.accountId])).rows.map((r: any) => JSON.stringify(r));
    const before = await receipts();
    const { page } = await open('admin');
    await go(page, 'notifications');
    await page.getByRole('button', { name: /^Reintentar el aviso «Posible emergencia»/ }).first().click();
    await toast(page, /Listo: el aviso llegó|Sigue sin llegar; se reintentará solo/);
    const after = await receipts();
    assert.notDeepEqual(after, before, 'ningún aviso se volvió a intentar');
  },
};
