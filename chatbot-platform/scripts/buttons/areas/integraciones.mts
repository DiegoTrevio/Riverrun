/** Integraciones: un webhook de punta a punta (crear, enviar una prueba que llega, borrar) y una llave de la API (crear, revocar). */
import assert from 'node:assert/strict';
import { ext, waitFor } from '../../../test/harness.js';
import { toast, type AreaContext } from '../areas.mts';

export const checks = {
  'Crear webhook → Enviar prueba llega a la dirección → Borrar lo quita': async ({ h, pool, open, go }: AreaContext) => {
    const url = `${process.env.EVOLUTION_URL}/hook-auditoria`;
    const { page } = await open('admin');
    await go(page, 'integraciones');
    const form = page.locator('.card', { has: page.getByRole('button', { name: 'Crear webhook' }) });
    await form.getByLabel('Dirección (URL)').fill(url);
    await form.getByLabel('Descripción').fill('Webhook de la auditoría');
    await form.getByRole('checkbox').first().check();
    await form.getByRole('button', { name: 'Crear webhook' }).click();
    await page.waitForTimeout(400);
    const ep = (await pool.query(`SELECT id, events FROM webhook_endpoints WHERE account_id = $1 AND url = $2`, [h.accountId, url])).rows[0];
    assert.ok(ep, 'el webhook no se creó');
    const card = page.locator('.card, li, tr', { hasText: 'Webhook de la auditoría' }).last();
    await card.getByRole('button', { name: 'Enviar prueba' }).click();
    const before = ext.requests.filter((r: any) => r.path === '/hook-auditoria').length;
    await page.locator('dialog').getByRole('button', { name: 'Enviar' }).click();
    await waitFor(() => ext.requests.filter((r: any) => r.path === '/hook-auditoria').length > before, 8000);
    const sent = ext.requests.filter((r: any) => r.path === '/hook-auditoria').at(-1);
    assert.match(JSON.stringify(sent.body ?? {}), /"test":\s*true/, 'la prueba no va marcada "test": true');
    await card.getByRole('button', { name: 'Borrar' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await toast(page, 'Borrado');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM webhook_endpoints WHERE id = $1`, [ep.id])).rows[0].n, 0);
  },
  'Crear llave muestra la llave una vez; Revocar la desactiva': async ({ h, pool, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, 'integraciones');
    await page.getByLabel('Nombre de la llave').fill('Llave de la auditoría');
    await page.getByRole('button', { name: 'Crear llave' }).click();
    const shown = page.getByRole('dialog', { name: 'Tu llave nueva' });
    const key = await shown.locator('input').inputValue();
    assert.ok(key.length >= 20, `llave mostrada: «${key}»`);
    await shown.getByRole('button', { name: 'Ya la copié' }).click();
    const row = (await pool.query(`SELECT id, revoked_at FROM api_keys WHERE account_id = $1 AND name = 'Llave de la auditoría'`, [h.accountId])).rows[0];
    assert.ok(row && !row.revoked_at, 'la llave no quedó guardada');
    await page.locator('tr', { hasText: 'Llave de la auditoría' }).getByRole('button', { name: /Revocar/ }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await page.waitForTimeout(400);
    assert.ok((await pool.query(`SELECT revoked_at FROM api_keys WHERE id = $1`, [row.id])).rows[0].revoked_at, 'la llave sigue activa');
  },
};
