/** Cobros: el equipo (también el agente) ve y registra lo que le deben los clientes. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Recordar ahora le manda el recordatorio al cliente; Cancelar (confirmando) deja de cobrarlo': async ({ h, f, pool, open, go }: AreaContext) => {
    const due = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const charge = (await h.authed('POST', `/api/receivables?account_id=${h.accountId}`, { contact_id: f.conv.contact_id, concept: 'Cobro de la auditoría', amount_cents: 50000, due_date: due })).json().receivable;
    const { page } = await open('admin');
    await go(page, 'cobros');
    const sent = h.sent.length;
    await page.getByRole('button', { name: 'Recordar ahora: Cobro de la auditoría' }).click();
    await toast(page, 'Recordatorio enviado');
    assert.ok(h.sent.slice(sent).some((m: any) => /Cobro de la auditoría|\$500/.test(m.text)), `no salió el recordatorio: ${JSON.stringify(h.sent.slice(sent))}`);
    await page.getByRole('button', { name: 'Cancelar: Cobro de la auditoría' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await toast(page, 'Cobro cancelado');
    assert.match((await pool.query('SELECT status FROM receivables WHERE id = $1', [charge.id])).rows[0].status, /^cancel/);
  },
  'El agente abre Cobros desde el menú y desde la ficha del cliente': async ({ f, open, go }: AreaContext) => {
    const { page } = await open('agent');
    await go(page, 'conversations');
    await page.locator('.sidebar').getByRole('link', { name: 'Cobros', exact: true }).click();
    await page.locator('.main h1').filter({ hasText: /^Cobros$/ }).waitFor({ timeout: 5000 }).catch(() => {});
    assert.equal(await page.locator('.main h1').first().innerText(), 'Cobros', `«Cobros» del menú llevó a ${await page.evaluate(() => location.hash)}`);
    await page.locator('tbody tr', { hasText: 'Reservación de octubre' }).waitFor();
    // Desde la ficha del cliente: «Ver sus cobros».
    await go(page, `contact/${f.conv.contact_id}`);
    await page.getByRole('link', { name: 'Ver sus cobros' }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.main h1').first().innerText(), 'Cobros', `«Ver sus cobros» llevó a ${await page.evaluate(() => location.hash)}`);
  },
};
