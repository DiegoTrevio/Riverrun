/** Agentes: encender y pausar, duplicar, eliminar (escribiendo su nombre) y reiniciar sus conversaciones. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

const advanced = async (page: any) => {
  await page.getByText('Opciones avanzadas', { exact: true }).click();
  await page.getByText('Duplicar, reiniciar o eliminar', { exact: true }).click();
};

export const checks = {
  'Crear un agente: el horario viene elegido y cada opción muestra u oculta «Abre» y «Cierra»': async ({ h, pool, open, go }: AreaContext) => {
    await pool.query(`UPDATE accounts SET settings = settings - 'business_hours', onboarding = onboarding - 'hours' WHERE id = $1`, [h.accountId]);
    const { page } = await open('admin');
    await page.route('**/api/onboarding/import**', (route: any) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ description: 'Café en el centro.', sections: { catalog: 'Café americano — $40\nPastel de chocolate — $60\nCapuchino — $55', hours: '', location: '', faq: '', other: '' }, source: 'lo que escribiste', truncated: false, hours: null }) }));
    await go(page, 'agentes/nuevo');
    await page.getByText('Lo escribo yo', { exact: true }).click();
    await page.getByLabel('Tu información').fill('Café en el centro. Café americano $40, pastel $60.');
    await page.getByRole('button', { name: 'Siguiente →' }).click(); await page.waitForURL('**/#/agentes/nuevo?paso=2');
    const opens = page.getByLabel('Abre', { exact: true });
    for (const [name, times] of [[/^Lunes a viernes/, true], [/^Las 24 horas/, false], [/^Todos los días/, true], [/^Lo ajusto después/, false], [/^Lunes a sábado/, true]] as const) {
      await page.getByRole('radio', { name }).check();
      assert.equal(await opens.isVisible(), times, `${name}: abre y cierra ${times ? 'visibles' : 'ocultos'}`);
    }
    await page.unrouteAll({ behavior: 'wait' });
  },
  '«Para atender mejor»: Ocultar lo quita y sigue oculto al volver': async ({ h, pool, open, go }: AreaContext) => {
    // Solo aparece cuando el agente ya atiende: encendido y con su WhatsApp conectado. Al terminar, todo como estaba.
    const before = (await pool.query(`SELECT b.active, (SELECT json_agg(json_build_object('id', id, 'state', connection_state)) FROM channels WHERE chatbot_id = b.id AND type = 'whatsapp') AS wa FROM chatbots b WHERE b.id = $1`, [h.botId])).rows[0];
    await pool.query(`UPDATE chatbots SET active = true WHERE id = $1`, [h.botId]);
    await pool.query(`UPDATE channels SET connection_state = 'open' WHERE chatbot_id = $1 AND type = 'whatsapp'`, [h.botId]);
    try {
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/instrucciones`);
    const box = page.getByLabel('Para atender mejor (opcional)');
    await box.waitFor();
    await page.getByRole('button', { name: 'Ocultar sugerencias para atender mejor' }).click();
    await box.waitFor({ state: 'detached' });
    await go(page, `bot/${h.botId}/conocimiento`);
    await page.locator('.main h1').waitFor();
    assert.equal(await box.count(), 0, 'sigue oculto');
    } finally {
      await pool.query(`UPDATE chatbots SET active = $2 WHERE id = $1`, [h.botId, before.active]);
      for (const c of before.wa || []) await pool.query(`UPDATE channels SET connection_state = $2 WHERE id = $1`, [c.id, c.state]);
    }
  },
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
    await toast(page, 'Chatbot duplicado');
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
    await toast(page, 'Eliminado');
    assert.equal(await count(), n);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chatbots WHERE id = $1', [copy])).rows[0].n, 0);
  },
  '«Quitar archivo» aparece solo con un archivo elegido y lo quita': async ({ h, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/conocimiento`);
    const card = page.locator('.import-card').first();
    await card.waitFor();
    const remove = card.getByRole('button', { name: 'Quitar archivo' });
    assert.equal(await remove.isVisible(), false, '«Quitar archivo» se ve sin ningún archivo elegido (y no hace nada)');
    await card.locator('input[type=file]').setInputFiles({ name: 'menu.txt', mimeType: 'text/plain', buffer: Buffer.from('Menú del día: sopa y guisado.') });
    await card.getByText('menu.txt').waitFor();
    await remove.click();
    assert.equal(await card.getByText('menu.txt').count(), 0, 'el archivo sigue elegido');
    assert.equal(await remove.isVisible(), false);
  },
  'iPhone y Android dicen cuál está elegido': async ({ h, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/conexiones/${h.channelId}`);
    await page.locator('.wa-connect').waitFor();
    const iphone = page.getByRole('button', { name: 'iPhone', exact: true });
    const android = page.getByRole('button', { name: 'Android', exact: true });
    await iphone.click();
    assert.equal(await page.getByRole('button', { name: 'iPhone', exact: true }).getAttribute('aria-pressed'), 'true', 'iPhone elegido no lo dice (aria-pressed)');
    assert.equal(await android.getAttribute('aria-pressed'), 'false');
    await android.click();
    assert.equal(await page.getByRole('button', { name: 'Android', exact: true }).getAttribute('aria-pressed'), 'true');
  },
  'Reiniciar conversaciones avisa cuántas reinició': async ({ h, open, go }: AreaContext) => {
    const { page } = await open('admin');
    await go(page, `bot/${h.botId}/instrucciones`);
    await advanced(page);
    await page.getByRole('button', { name: 'Reiniciar conversaciones' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Continuar' }).click();
    await toast(page, /conversaci(ón|ones) reiniciadas?/);
  },
};
