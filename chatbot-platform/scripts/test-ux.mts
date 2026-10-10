/** Regresión UX: PostgreSQL AISLADO, proveedor simulado y navegador real. El arnés reinicia public. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createHarness, pool, waitFor, evo } from '../test/harness.js';

assert.ok(process.env.TEST_DATABASE_URL, 'Define TEST_DATABASE_URL para una base de pruebas aislada; el arnés reinicia public.');
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const output = path.resolve('data/ux-test-results'); fs.mkdirSync(output, { recursive: true });
const h = await createHarness(); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: any = { screens: [], responsive: [], regressions: [], errors: [] };
const checked = (name: string) => { results.regressions.push(name); console.log('UX ✓', name); };
try {
  await h.createBot({ name: 'Ventas y reservas', personality: { prompt: 'Atiende pedidos y pregunta el nombre y la dirección.' }, data_fields: [] });
  await h.uploadImage('ux_foto', 'Foto de prueba UX', { mode: 'ai' });
  await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { category: 'general', title: 'Información de prueba UX', content: 'Atendemos de lunes a viernes. Consulta la disponibilidad de citas.' });
  h.setScript(() => ({ messages: ['¿Cuál es tu dirección?'], save_data: [{ field: 'nombre', value: 'Ana' }] }));
  await h.webhook('Soy Ana'); await waitFor(() => h.sent.length > 0); await h.idle();
  const conv = await h.conversationFor();
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { active: false });
  const service = (await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Consulta inicial' })).json();
  const login: any = { superadmin: h.authed };
  for (const role of ['admin', 'agent']) {
    const user = (await h.authed('POST', '/api/users', { account_id: h.accountId, name: `Auditor ${role}`, email: `${role}@auditoria.test`, password: 'auditoria123', role })).json();
    login[role] = await h.loginAs(`${role}@auditoria.test`, 'auditoria123');
    if (role === 'agent') await h.authed('PUT', `/api/conversations/${conv.id}/assign`, { user_id: user.id });
  }
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address: any = h.app.server.address(); const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const contextFor = async (role: string, options: any = {}) => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
    const cookie = login[role].cookie; const ix = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, ix), value: cookie.slice(ix + 1), url: base }]);
    if (role === 'superadmin') await context.addInitScript((id: string) => localStorage.setItem('cp-account', id), h.accountId);
    return context;
  };
  const routes = ['agentes', `bot/${h.botId}/instrucciones`, `bot/${h.botId}/preguntas`, `bot/${h.botId}/activacion`, `bot/${h.botId}/conocimiento`, `bot/${h.botId}/imagenes`, `bot/${h.botId}/conexiones`, `bot/${h.botId}/probar`, `bot/${h.botId}/conexiones/${h.channelId}`, 'conversations', `conversation/${conv.id}`, 'agenda', 'agenda/servicios', `agenda/servicios?id=${service.id}`, 'automation/rules', 'automation/rules/new', 'automation/sequences', 'automation/sequences/new', 'automation/campaigns', 'automation/campaigns/new', 'automation/settings', 'ajustes', 'integraciones', 'users', 'consumo', 'logs', 'plan', 'estadisticas', 'notifications', 'password', 'inicio'];
  const helpScreens: Record<string, string> = { [`bot/${h.botId}/conocimiento`]: '01-importar.jpg', [`bot/${h.botId}/probar`]: '03-probar.jpg', [`conversation/${conv.id}`]: '05-conversacion.jpg', ajustes: '06-ajustes.jpg' };
  for (const role of ['admin', 'superadmin', 'agent']) {
    const context = await contextFor(role); const page = await context.newPage();
    page.on('pageerror', (error) => results.errors.push({ role, message: error.message }));
    const selected = role === 'admin' ? routes : role === 'agent' ? ['conversations', `conversation/${conv.id}`, 'agenda', 'notifications', 'password'] : ['agentes', 'accounts', 'planes', 'marcas', 'sistema', 'users', 'ajustes', 'integraciones'];
    for (const route of selected) {
      await page.goto(`${base}/#/${route}`); await page.locator('.main h1').waitFor(); await page.locator('.main [aria-busy="true"]').waitFor({ state: 'hidden' }); await page.waitForTimeout(100);
      await page.addScriptTag({ content: axe });
      const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } })).violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary })) })));
      results.screens.push({ role, route, violations });
      if (role === 'admin' && helpScreens[route]) await page.screenshot({ path: `${output}/${helpScreens[route]}`, type: 'jpeg', quality: 85, fullPage: true });
    }
    await context.close();
  }
  console.log('Pantallas examinadas:', results.screens.length);
  for (const width of [320, 390, 768, 1024, 1440]) for (const theme of ['light', 'dark'] as const) {
    const context = await contextFor('admin', { viewport: { width, height: 900 }, colorScheme: theme }); const page = await context.newPage();
    for (const route of ['agentes', `bot/${h.botId}/instrucciones`, `conversation/${conv.id}`, 'conversations', 'automation/sequences/new', 'agenda']) {
      await page.goto(`${base}/#/${route}`); await page.locator('.main h1').waitFor(); await page.waitForTimeout(80);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      results.responsive.push({ width, theme, route, overflow });
      assert.equal(overflow, false, `Desbordamiento en ${route} ${width} ${theme}`);
      if (width === 390 && theme === 'dark') await page.screenshot({ path: `${output}/${route.split('/')[0]}-mobile.png`, fullPage: true });
    }
    await context.close();
  }
  checked('60 escenarios adaptables sin desbordamiento');
  const context = await contextFor('admin'); const page = await context.newPage(); page.setDefaultTimeout(10000);
  const go = async (route: string) => { await page.goto(`${base}/#/${route}`); await page.locator('.main h1').waitFor(); await page.locator('.main [aria-busy="true"]').waitFor({ state: 'hidden' }); };
  await go(`bot/${h.botId}/instrucciones`);
  const instructions = page.getByLabel('Cómo debe atender', { exact: true });
  await instructions.fill('BORRADOR_CONSERVADO');
  await page.getByRole('link', { name: 'Preguntas', exact: true }).first().click();
  await page.getByRole('link', { name: 'Instrucciones', exact: true }).click();
  assert.equal(await instructions.inputValue(), 'BORRADOR_CONSERVADO');
  await page.reload(); assert.equal(await instructions.inputValue(), 'BORRADOR_CONSERVADO');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).first().click();
  await page.waitForTimeout(200);
  assert.equal((await h.authed('GET', `/api/chatbots/${h.botId}`)).json().personality.prompt, 'BORRADOR_CONSERVADO');
  checked('Borrador recuperable entre secciones y recarga; guardado real');
  await go(`bot/${h.botId}/conocimiento`);
  const knowledge = page.locator('.list-item[data-search]').first();
  await knowledge.getByRole('button', { name: 'Editar', exact: true }).click();
  await knowledge.getByLabel('Título', { exact: true }).fill('Borrador de conocimiento UX');
  await knowledge.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await knowledge.getByRole('button', { name: 'Editar', exact: true }).click();
  assert.equal(await knowledge.getByLabel('Título', { exact: true }).inputValue(), 'Información de prueba UX');
  checked('Cancelar conocimiento descarta la edición también al volver a abrir');
  await go(`conversation/${conv.id}`);
  const name = page.getByLabel('Nombre', { exact: true }); await name.fill('Borrador del cliente');
  await page.locator('.composer textarea').focus(); await page.waitForTimeout(5600);
  assert.equal(await name.inputValue(), 'Borrador del cliente');
  const clientStorage = await page.evaluate(() => JSON.stringify(localStorage)); assert.ok(!clientStorage.includes('Borrador del cliente'));
  checked('Polling conserva cambios del contacto sin persistir información personal en localStorage');
  const contactId = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().contact.id;
  assert.equal((await h.authed('PUT', `/api/contacts/${contactId}`, { name: 'Dato actualizado del cliente', data: { direccion: 'Calle nueva' } })).statusCode, 200);
  await page.getByRole('button', { name: 'Guardar datos', exact: true }).click();
  await page.getByRole('button', { name: 'Revisar cambios del cliente', exact: true }).click();
  await page.locator('dialog').getByRole('button', { name: 'Guardar cambios revisados', exact: true }).click();
  await page.waitForTimeout(200);
  const mergedContact = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().contact;
  assert.equal(mergedContact.name, 'Dato actualizado del cliente'); assert.equal(mergedContact.data.direccion, 'Calle nueva');
  checked('Conflicto del contacto revisado conserva datos nuevos del cliente');
  await page.getByLabel('Pendiente o nota', { exact: true }).fill('Nota conservada entre actualizaciones');
  await page.locator('.composer textarea').focus(); await page.waitForTimeout(5500);
  assert.equal(await page.getByLabel('Pendiente o nota', { exact: true }).inputValue(), 'Nota conservada entre actualizaciones');
  await page.getByRole('button', { name: 'Agregar', exact: true }).click();
  await page.locator('.task-text').filter({ hasText: 'Nota conservada entre actualizaciones' }).waitFor();
  checked('Notas conservan borrador y muestran el guardado real');
  await pool.query('UPDATE contacts SET consent_at = now() WHERE id = $1', [contactId]);
  const campaign = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, name: 'Campaña de revisión UX', channel_id: h.channelId, message: 'Mensaje anterior', scheduled_local: '2027-01-12T10:00' })).json();
  assert.equal((await h.authed('POST', `/api/campaigns/${campaign.id}/launch`)).statusCode, 200);
  await go(`automation/campaigns/${campaign.id}`);
  await page.getByLabel('Mensaje', { exact: true }).fill('Mensaje revisado');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await page.locator('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
  let actualCampaign = (await h.authed('GET', `/api/campaigns?account_id=${h.accountId}`)).json().find((c: any) => c.id === campaign.id);
  assert.equal(actualCampaign.message, 'Mensaje anterior');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await page.locator('dialog').getByRole('button', { name: 'Confirmar programación', exact: true }).click();
  await page.waitForTimeout(250);
  actualCampaign = (await h.authed('GET', `/api/campaigns?account_id=${h.accountId}`)).json().find((c: any) => c.id === campaign.id);
  assert.equal(actualCampaign.message, 'Mensaje revisado');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'campaign_id' = $1 AND status = 'pending'", [campaign.id])).rows[0].n, 1);
  checked('Campaña programada exige revisión, cancelar no modifica y confirmar programa una sola vez');
  await go(`conversation/${conv.id}`);

  for (const kind of ['manual', 'simulator']) {
    if (kind === 'simulator') await go(`bot/${h.botId}/probar`);
    let requests = 0;
    const target = kind === 'manual' ? `**/api/conversations/${conv.id}/send` : `**/api/chatbots/${h.botId}/playground`;
    await page.route(target, async (route) => { requests++; await new Promise((r) => setTimeout(r, 300)); await route.fulfill({ status: 503, json: { error: 'Fallo controlado' } }); });
    const input = page.locator('.composer textarea'); await input.fill('Mensaje conservado'); await input.press('Enter'); await input.press('Enter'); await page.waitForTimeout(500);
    assert.equal(requests, 1); assert.equal(await input.inputValue(), 'Mensaje conservado'); await page.unrouteAll({ behavior: 'wait' });
    checked(`${kind}: un envío pendiente por doble Enter y texto retenido ante fallo`);
  }
  await go(`bot/${h.botId}/instrucciones`);
  await page.getByText('Opciones avanzadas', { exact: true }).click(); await page.getByText('Canales y administración', { exact: true }).click();
  await page.route(`**/api/chatbots/${h.botId}`, (route) => route.request().method() === 'DELETE' ? route.fulfill({ status: 503, json: { error: 'No se pudo eliminar' } }) : route.continue());
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click(); await page.locator('dialog input').fill('Ventas y reservas'); await page.locator('dialog').getByRole('button', { name: 'Guardar', exact: true }).click();
  await page.waitForTimeout(200); assert.ok(page.url().includes(`/bot/${h.botId}/`)); await page.unrouteAll({ behavior: 'wait' });
  checked('Borrado fallido conserva la ficha');
  await go('agentes'); let sessions = 0;
  await page.route('**/api/me', async (route) => { if (++sessions === 1) await new Promise((r) => setTimeout(r, 500)); await route.continue(); });
  await page.evaluate((id: string) => { location.hash = `#/bot/${id}/instrucciones`; setTimeout(() => { location.hash = '#/agentes'; }, 60); }, h.botId);
  await page.waitForTimeout(900); assert.equal(await page.locator('.main h1').innerText(), 'Agentes'); await page.unrouteAll({ behavior: 'wait' });
  checked('Respuestas antiguas no cambian la última ruta');
  await page.route('**/api/me', (route) => route.fulfill({ status: 503, json: { error: 'Servidor no disponible' } }));
  await page.evaluate(() => { location.hash = '#/conversations'; }); await page.getByRole('button', { name: 'Reintentar', exact: true }).waitFor();
  await page.unrouteAll({ behavior: 'wait' }); await page.getByRole('button', { name: 'Reintentar', exact: true }).click(); await page.getByRole('heading', { name: 'Conversaciones', exact: true }).waitFor();
  checked('Fallo de sesión visible y recuperable');
  await go(`bot/${h.botId}/conexiones/${h.channelId}`); await page.locator('.wa-connect').waitFor();
  await page.getByRole('button', { name: 'iPhone', exact: true }).focus(); await page.waitForTimeout(3300);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'iPhone');
  evo.instances.get('palmas')!.state = 'open'; await page.getByText('¡WhatsApp conectado!', { exact: true }).waitFor();
  assert.equal(await page.getByText('Desde ahora tu asistente responde los mensajes que lleguen a este número.', { exact: true }).count(), 0);
  checked('QR conserva foco y diferencia conexión de atención encendida');
  const telegram = (await h.authed('POST', '/api/channels', { account_id: h.accountId, chatbot_id: h.botId, name: 'Telegram UX', type: 'telegram' })).json();
  await page.route(`**/api/channels/${telegram.id}/status`, (route) => route.fulfill({ json: { state: 'open' } }));
  await go(`bot/${h.botId}/conexiones/${telegram.id}`);
  await page.getByLabel('Token del bot', { exact: true }).fill('TOKEN_FICTICIO_UX');
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('TOKEN_FICTICIO_UX'));
  let setups = 0;
  await page.route(`**/api/channels/${telegram.id}/setup`, async (route) => {
    setups++;
    const stored = (await pool.query("SELECT config->>'bot_token' AS token FROM channels WHERE id = $1", [telegram.id])).rows[0];
    assert.equal(stored.token, 'TOKEN_FICTICIO_UX');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ json: { ok: true, message: 'Conexión simulada verificada' } });
  });
  await page.getByRole('button', { name: 'Guardar y conectar con Telegram', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar y conectar con Telegram', exact: true }).click();
  await page.getByText('Conexión simulada verificada').waitFor();
  assert.equal(setups, 1);
  await page.getByLabel('Token del bot', { exact: true }).fill('SEGUNDO_TOKEN_FICTICIO_UX');
  await page.locator(`a[href="#/bot/${h.botId}/conexiones"]`).first().click();
  await page.locator(`a[href="#/bot/${h.botId}/conexiones/${telegram.id}"]`).first().click();
  await page.getByLabel('Token del bot', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Token del bot', { exact: true }).inputValue(), 'SEGUNDO_TOKEN_FICTICIO_UX');
  await page.unrouteAll({ behavior: 'wait' });
  checked('Conectar guarda antes de verificar, evita duplicados y conserva credenciales solo en memoria');
  await go('agentes');
  await page.evaluate(async () => { const { applyBrand } = await import('/js/brand.js'); applyBrand({ color: '#ffffff' }); });
  const brandColors = await page.locator('.primary').first().evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  assert.notEqual(brandColors.color, brandColors.background);
  await context.close(); checked('Marca blanca mantiene el texto de la acción visible');
  assert.equal(results.errors.length, 0, JSON.stringify(results.errors));
  const serious = results.screens.flatMap((screen: any) => screen.violations.filter((v: any) => ['critical', 'serious'].includes(v.impact)).map((v: any) => ({ role: screen.role, route: screen.route, ...v })));
  results.serious = serious;
  fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
  assert.equal(serious.length, 0, JSON.stringify(serious, null, 2));
  console.log(`UX OK: ${results.regressions.length} comprobaciones, ${results.screens.length} pantallas y ${results.responsive.length} escenarios adaptables.`);
} finally {
  fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
  await browser?.close(); await h.app.close(); await pool.end();
}
