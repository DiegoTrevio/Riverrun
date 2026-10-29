/** Cobros: el equipo (también el agente) ve y registra lo que le deben los clientes. */
import assert from 'node:assert/strict';
import type { AreaContext } from '../areas.mts';

export const checks = {
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
