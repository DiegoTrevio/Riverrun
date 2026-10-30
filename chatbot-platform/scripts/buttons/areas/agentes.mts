/** Agentes: encender y pausar, duplicar, eliminar (escribiendo su nombre) y reiniciar sus conversaciones. */
import assert from 'node:assert/strict';
import type { AreaContext } from '../areas.mts';

const advanced = async (page: any) => {
  await page.getByText('Opciones avanzadas', { exact: true }).click();
  await page.getByText('Duplicar, reiniciar o eliminar', { exact: true }).click();
};

export const checks = {
  'Encender y pausar el agente cambia si responde, y pausar pide confirmación': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/instrucciones`);
    const active = async () => (await pool.query('SELECT active FROM chatbots WHERE id = $1', [h.botId])).rows[0].active;
    const before = await active();
    const toggle = page.getByRole('switch').first();
    if (before) {
      await toggle.click(); await page.locator('dialog').getByRole('button', { name: 'Cancelar' }).click();
      assert.equal(await active(), true, 'Cancelar no pausa');
    }
    await toggle.click();
    if (before) await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await page.getByText(before ? 'Agente en pausa' : 'Agente encendido').first().waitFor();
    assert.equal(await active(), !before);
    assert.equal(await page.getByRole('switch').first().getAttribute('aria-checked'), String(!before));
    // Y de vuelta como estaba.
    await page.getByRole('switch').first().click();
    if (!before) await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await page.getByText(before ? 'Agente encendido' : 'Agente en pausa').first().waitFor();
    assert.equal(await active(), before);
  },
  'Duplicar crea una copia y la abre; Eliminar (escribiendo su nombre) la borra': async ({ h, pool, open, go }: AreaContext) => {
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM chatbots WHERE account_id = $1', [h.accountId])).rows[0].n;
    const n = await count();
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/instrucciones`);
    await advanced(page);
    await page.getByRole('button', { name: 'Duplicar', exact: true }).click();
    await page.getByText('Chatbot duplicado').first().waitFor();
    await page.waitForURL((u) => !u.hash.includes(h.botId) && /#\/bot\/[0-9a-f-]{36}\//.test(u.hash));
    assert.equal(await count(), n + 1);
    const copy = page.url().split('/bot/')[1].split('/')[0];
    const name = (await pool.query('SELECT name FROM chatbots WHERE id = $1', [copy])).rows[0].name;
    await page.locator('.main h1').waitFor();
    await advanced(page);
    // Un nombre equivocado no borra nada.
    await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await page.locator('dialog input').fill('otro nombre');
    await page.locator('dialog').getByRole('button', { name: 'Guardar' }).click();
    await page.waitForTimeout(300);
    assert.equal(await count(), n + 1, 'un nombre equivocado no elimina');
    await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await page.locator('dialog input').fill(name);
    await page.locator('dialog').getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Eliminado').first().waitFor();
    assert.equal(await count(), n);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chatbots WHERE id = $1', [copy])).rows[0].n, 0);
  },
  'Reiniciar conversaciones avisa cuántas reinició': async ({ h, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/instrucciones`);
    await advanced(page);
    await page.getByRole('button', { name: 'Reiniciar conversaciones' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await page.getByText(/conversaci(ón|ones) reiniciadas?/).first().waitFor();
  },
};
