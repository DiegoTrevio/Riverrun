/** Regresión UX: PostgreSQL AISLADO, proveedor simulado y navegador real. El arnés reinicia public. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createHarness, pool, waitFor, evo, ext, zer } from '../test/harness.js';
import { seedUxFixture } from './ux-fixture.mts';

assert.ok(process.env.TEST_DATABASE_URL, 'Define TEST_DATABASE_URL para una base de pruebas aislada; el arnés reinicia public.');
const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const output = path.resolve('data/ux-test-results'); fs.mkdirSync(output, { recursive: true });
const h = await createHarness(); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: any = { screens: [], responsive: [], regressions: [], errors: [] };
const cspViolations: string[] = [];
const checked = (name: string) => { results.regressions.push(name); console.log('UX ✓', name); };
try {
  const f = await seedUxFixture(h);
  const { conv, socialNew, socialOn, waSocial, uxFlow, uxBoard, uxCharge, uxMonth, login } = f;
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address: any = h.app.server.address(); const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  // La CSP no debe bloquear nada del panel ni de las páginas públicas: Chrome lo anota en la consola («Refused to…»).
  const newContext = browser.newContext.bind(browser);
  browser.newContext = (async (...args: Parameters<typeof newContext>) => {
    const ctx = await newContext(...args);
    ctx.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(`${m.location().url}: ${m.text()}`); });
    return ctx;
  }) as typeof newContext;
  const contextFor = async (role: string, options: any = {}) => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
    const cookie = login[role].cookie; const ix = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, ix), value: cookie.slice(ix + 1), url: base }]);
    if (role === 'superadmin') await context.addInitScript((id: string) => localStorage.setItem('cp-account', id), h.accountId);
    return context;
  };
  const routes = f.routes.admin;
  const helpScreens: Record<string, string> = { [`bot/${h.botId}/conocimiento`]: '01-importar.jpg', [`bot/${h.botId}/probar`]: '03-probar.jpg', [`conversation/${conv.id}`]: '05-conversacion.jpg', ajustes: '06-ajustes.jpg' };
  for (const role of ['admin', 'superadmin', 'agent']) {
    const context = await contextFor(role); const page = await context.newPage();
    page.on('pageerror', (error) => results.errors.push({ role, message: error.message }));
    const selected = role === 'admin' ? routes : role === 'agent' ? f.routes.agent : f.routes.superadmin;
    for (const route of selected) {
      await page.goto(`${base}/#/${route}`); await page.locator('.main h1').waitFor(); await page.locator('.main [aria-busy="true"]').waitFor({ state: 'hidden' }); await page.waitForTimeout(100);
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } })).violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary })) })));
      results.screens.push({ role, route, violations });
      // Nombres de controles: nada de «Dato 1» ni llaves en inglés (call_mode), y en un grupo no se repite el nombre genérico.
      const badNames = await page.evaluate(() => {
        const bad: string[] = [];
        document.querySelectorAll('.sr-only').forEach((s) => { if (/^Dato \d+$/.test(s.textContent || '')) bad.push(s.textContent!); });
        document.querySelectorAll('[aria-label]').forEach((el) => { const v = el.getAttribute('aria-label') || ''; if (/^[a-z]+([ _][a-z]+)*$/.test(v) && /(^| )(id|mode|type|status|role|key)$/.test(v)) bad.push(v); });
        document.querySelectorAll('fieldset.field').forEach((fs) => {
          const generic = [...fs.querySelectorAll(':scope > .sr-only[data-generic]')].map((s) => s.textContent);
          if (new Set(generic).size < generic.length) bad.push(`${fs.querySelector('legend')?.textContent}: ${generic.join(', ')}`);
        });
        return bad;
      });
      for (const name of badNames) (results.badNames ||= []).push({ role, route, name });
      if (role === 'admin' && helpScreens[route]) await page.screenshot({ path: `${output}/${helpScreens[route]}`, type: 'jpeg', quality: 85, fullPage: true });
    }
    await context.close();
  }
  console.log('Pantallas examinadas:', results.screens.length);
  for (const width of [320, 390, 768, 1024, 1440]) for (const theme of ['light', 'dark'] as const) {
    const context = await contextFor('admin', { viewport: { width, height: 900 }, colorScheme: theme }); const page = await context.newPage();
    for (const route of ['agentes', 'agentes/nuevo', `bot/${h.botId}/empezar`, `bot/${h.botId}/instrucciones`, `conversation/${conv.id}`, 'conversations', 'automation/lienzo', `automation/lienzo/${uxBoard}`, 'automation/sequences/new', `automation/sequences/${uxFlow}`, `automation/campaigns/new?flow=${uxFlow}`, 'agenda', 'redes', `redes/whatsapp/${waSocial}`, 'comentarios', 'publicaciones', `publicaciones?vista=calendario&mes=${uxMonth}`, 'publicaciones/nueva', 'estadisticas/redes', 'password', 'notifications?grupo=errors', 'automation/settings', 'cobros', 'cobros?tab=recurrentes', 'cobros?tab=ajustes', 'datos-clientes', 'contacts']) {
      await page.goto(`${base}/#/${route}`); await page.locator('.main h1').waitFor(); await page.waitForTimeout(80);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      results.responsive.push({ width, theme, route, overflow });
      assert.equal(overflow, false, `Desbordamiento en ${route} ${width} ${theme}`);
      if (width === 390 && theme === 'dark') await page.screenshot({ path: `${output}/${route.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'id').replace(/[^a-z0-9]+/gi, '-')}-mobile.png`, fullPage: true });
    }
    await context.close();
  }
  checked(`${results.responsive.length} escenarios adaptables sin desbordamiento`);
  {
    // Notificaciones: por dónde llegó cada aviso, los que no llegaron con «Reintentar» y la franja de WhatsApp que falla.
    const phone = await contextFor('admin', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await phone.newPage(); p.setDefaultTimeout(10000);
    await p.goto(`${base}/#/notifications`); await p.locator('.main h1').waitFor();
    await p.getByText('WhatsApp: no llegó', { exact: true }).first().waitFor();
    await p.getByText('Correo: entregado', { exact: true }).waitFor();
    await p.getByRole('heading', { name: /Avisos que no llegaron \(7 días\): 3/ }).waitFor();
    await p.getByText(/Tus últimos avisos por WhatsApp no llegaron/).waitFor();
    await p.getByRole('button', { name: 'Reintentar el aviso «Posible emergencia» para Auditor admin por WhatsApp' }).first().waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Notificaciones sin desbordamiento a 390 px');
    await phone.close();
  }
  checked('Notificaciones muestra por dónde llegó cada aviso y los que no llegaron, con «Reintentar»');
  // Página pública para reservar: sin sesión, accesible y sin desbordamiento (celular y escritorio, claro y oscuro).
  const bookingLink = (await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Agenda con nosotros' })).json();
  for (const width of [320, 390, 1024]) for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser!.newContext({ viewport: { width, height: 900 }, colorScheme: theme }); const pg = await ctx.newPage();
    pg.on('pageerror', (error) => results.errors.push({ role: 'público', message: error.message }));
    await pg.goto(bookingLink.url.replace('https://bot.test', base)); await pg.locator('main h2').first().waitFor();
    await pg.evaluate(axe);
    const violations = await pg.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } })).violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary })) })));
    if (width === 390 && theme === 'light') results.screens.push({ role: 'público', route: 'reservar', violations });
    const overflow = await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    results.responsive.push({ width, theme, route: 'reservar', overflow });
    assert.equal(overflow, false, `Desbordamiento en la página para reservar ${width} ${theme}`);
    if (width === 390 && theme === 'dark') await pg.screenshot({ path: `${output}/reservar-mobile.png`, fullPage: true });
    await ctx.close();
  }
  checked('Página pública para reservar accesible y sin desbordamiento');
  const context = await contextFor('admin'); const page = await context.newPage(); page.setDefaultTimeout(10000);
  const go = async (route: string) => { await page.goto(`${base}/#/${route}`); await page.locator('.main h1').waitFor(); await page.locator('.main [aria-busy="true"]').waitFor({ state: 'hidden' }); };
  await go(`bot/${h.botId}/instrucciones`);
  const instructions = page.getByLabel('Cómo debe atender', { exact: true });
  await instructions.fill('BORRADOR_CONSERVADO');
  await page.getByRole('link', { name: 'Más ajustes', exact: true }).first().click();
  await page.getByRole('link', { name: 'Instrucciones', exact: true }).click();
  assert.equal(await instructions.inputValue(), 'BORRADOR_CONSERVADO');
  await page.reload(); assert.equal(await instructions.inputValue(), 'BORRADOR_CONSERVADO');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).first().click();
  await page.getByText('Cambios guardados', { exact: true }).waitFor();
  // Guardar = aplicar: el agente usa el cambio de inmediato y queda en el historial.
  assert.equal((await h.authed('GET', `/api/chatbots/${h.botId}`)).json().personality.prompt, 'BORRADOR_CONSERVADO');
  assert.ok((await h.authed('GET', `/api/chatbots/${h.botId}/versions`)).json().releases.length >= 1);
  checked('Cambios sin guardar se conservan entre secciones y recarga; guardar los aplica de inmediato');
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
  // Se espera la respuesta del guardado (que cambia el mensaje y vuelve a programar): un tiempo fijo no alcanza en una
  // máquina lenta y la cuenta de tareas se haría a medio guardar.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/campaigns/${campaign.id}`) && r.request().method() === 'PUT'),
    page.locator('dialog').getByRole('button', { name: 'Confirmar programación', exact: true }).click(),
  ]);
  actualCampaign = (await h.authed('GET', `/api/campaigns?account_id=${h.accountId}`)).json().find((c: any) => c.id === campaign.id);
  assert.equal(actualCampaign.message, 'Mensaje revisado');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'campaign_id' = $1 AND status = 'pending'", [campaign.id])).rows[0].n, 1);
  checked('Campaña programada exige revisión, cancelar no modifica y confirmar programa una sola vez');
  // Flujo con botones en el simulador: el cliente toca "Sí, me interesa", recibe la respuesta del botón y el mensaje
  // siguiente al momento, y la IA no contesta el toque.
  const playgroundPost = (r: any) => r.url().includes(`/api/chatbots/${h.botId}/playground`) && r.request().method() === 'POST';
  await go(`bot/${h.botId}/probar`);
  await Promise.all([page.waitForResponse(playgroundPost), (async () => { const i = page.locator('.composer textarea'); await i.fill('hola, quiero información'); await i.press('Enter'); })()]);
  const pgConv = (await pool.query(`SELECT c.id, c.contact_id FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE ch.chatbot_id = $1 AND ch.type = 'playground' ORDER BY c.created_at DESC LIMIT 1`, [h.botId])).rows[0];
  await pool.query('UPDATE contacts SET consent_at = now() WHERE id = $1', [pgConv.contact_id]);
  assert.equal((await h.authed('POST', `/api/conversations/${pgConv.id}/sequences`, { sequence_id: uxFlow })).statusCode, 200);
  await h.fastForward();
  // Misma ruta: se recarga para ver el mensaje que envió el flujo.
  await page.reload(); await page.locator('.main h1').waitFor();
  const chip = page.locator('.chat').getByRole('button', { name: 'Sí, me interesa', exact: true });
  await chip.waitFor();
  assert.equal(await page.locator('.chat').getByRole('link', { name: 'Ver promoción', exact: true }).getAttribute('href'), 'https://hotel.test/promo');
  const aiCalls = h.calls.length;
  await Promise.all([page.waitForResponse(playgroundPost), chip.click()]);
  await page.locator('.chat').getByText('¡Genial! Te cuento más 👇').waitFor();
  await page.locator('.chat').getByText('Estos son los detalles de la promoción.').waitFor();
  assert.equal(h.calls.length, aiCalls, 'la IA no contesta el toque');
  assert.equal(await page.locator('.chat button.chip').count(), 0, 'los botones de un mensaje anterior ya no se tocan');
  const pgEnrollment = (await pool.query(`SELECT status, choice, current_step FROM sequence_enrollments WHERE conversation_id = $1`, [pgConv.id])).rows[0];
  assert.deepEqual([pgEnrollment.status, pgEnrollment.choice, pgEnrollment.current_step], ['active', 'Sí, me interesa', 2]);
  checked('Flujo con botones: tocar en el simulador sigue el flujo al momento y la IA no contesta');
  // Enviar el flujo a un grupo desde el panel: la revisión dice cuántos mensajes son por persona; "Detener el flujo"
  // lo detiene para todos y la campaña sigue como enviada.
  await go(`automation/campaigns/new?flow=${uxFlow}`);
  assert.equal(await page.getByLabel('Nombre', { exact: true }).inputValue(), 'Flujo: Promoción de octubre');
  assert.ok(await page.getByRole('radio', { name: 'Un flujo (varios mensajes, con botones)' }).isChecked());
  await page.getByLabel('Canal', { exact: true }).selectOption(h.channelId);
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/campaigns') && r.request().method() === 'POST'), page.getByRole('button', { name: 'Guardar cambios', exact: true }).click()]);
  await page.getByRole('button', { name: 'Revisar y enviar', exact: true }).click();
  await page.locator('dialog').getByText(/Flujo "Promoción de octubre": 3 mensajes por persona/).waitFor();
  const flowCampaignId = page.url().split('/').pop()!;
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/campaigns/${flowCampaignId}/launch`)),
    page.locator('dialog').getByRole('button', { name: 'Confirmar envío ahora', exact: true }).click(),
  ]);
  await h.fastForward();
  const groupEnrollment = (await pool.query(`SELECT status FROM sequence_enrollments WHERE campaign_id = $1 AND conversation_id = $2`, [flowCampaignId, conv.id])).rows[0];
  assert.equal(groupEnrollment?.status, 'active', 'Ana entró al flujo');
  // (El nombre del contacto cambió en una prueba anterior: se revisa el resto del mensaje.)
  assert.ok(h.sent.some((x) => x.text.includes('¿te interesa la promoción de octubre?\n\n1. Sí, me interesa\n2. No, gracias\n3. Hablar con alguien\n\n🔗 Ver promoción: https://hotel.test/promo\n\nResponde con el número de tu opción.')), `WhatsApp con QR: botones numerados (${JSON.stringify(h.sent.slice(-2))})`);
  // Ya está en la campaña: se recarga para verla enviada.
  await page.reload(); await page.locator('.main h1').waitFor();
  await page.getByRole('button', { name: 'Detener el flujo', exact: true }).click();
  await Promise.all([page.waitForResponse((r) => r.url().includes(`/api/campaigns/${flowCampaignId}/cancel`)), page.locator('dialog').getByRole('button', { name: 'Continuar', exact: true }).click()]);
  assert.equal((await pool.query(`SELECT status FROM sequence_enrollments WHERE campaign_id = $1 AND conversation_id = $2`, [flowCampaignId, conv.id])).rows[0].status, 'stopped');
  assert.equal((await h.authed('GET', `/api/campaigns?account_id=${h.accountId}`)).json().find((x: any) => x.id === flowCampaignId).status, 'sent');
  checked('Flujo enviado a un grupo desde el panel: revisión por persona, botones numerados en WhatsApp y "Detener el flujo"');
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
  await page.getByText('Opciones avanzadas', { exact: true }).click(); await page.getByText('Duplicar, reiniciar o eliminar', { exact: true }).click();
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
  // El teléfono vinculado se cae y Evolution lo reconecta solo: el panel no pide escanear (ni ofrece pestañas de QR).
  evo.instances.get('palmas')!.state = 'connecting'; evo.stuck.add('palmas');
  assert.equal((await h.app.inject({ method: 'POST', url: `/webhook/${h.token}`, payload: { instance: 'palmas', event: 'connection.update', data: { state: 'connecting' } } })).statusCode, 200);
  await go(`bot/${h.botId}/conexiones/${h.channelId}`);
  await page.getByText('Tu WhatsApp se está reconectando solo.', { exact: true }).waitFor();
  assert.equal(await page.locator('.wa-tab').count(), 0, 'sin pestañas de QR mientras se reconecta');
  assert.equal(await page.locator('img.qr').count(), 0);
  await page.getByText('Reconectando', { exact: true }).waitFor();
  // "Vincular de nuevo" (con confirmación) descarta esa sesión y muestra un QR nuevo.
  await page.getByRole('button', { name: 'Vincular de nuevo', exact: true }).click();
  await page.locator('dialog').getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.locator('img.qr').waitFor();
  assert.ok(ext.requests.some((x) => x.path === '/instance/delete/palmas'), 'la sesión anterior se descartó a pedido');
  evo.stuck.delete('palmas'); evo.instances.get('palmas')!.state = 'open';
  await page.getByText('¡WhatsApp conectado!', { exact: true }).waitFor();
  checked('Un WhatsApp que se reconecta solo no pide escanear y ofrece "Vincular de nuevo"');
  {
    // En un celular no se puede escanear la propia pantalla: el conector abre con el código por número.
    const phone = await contextFor('admin', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await phone.newPage(); p.setDefaultTimeout(10000);
    const fresh = (await h.authed('POST', '/api/channels', { account_id: h.accountId, chatbot_id: h.botId, type: 'whatsapp', name: 'WhatsApp desde el celular' })).json();
    await p.goto(`${base}/#/bot/${h.botId}/conexiones/${fresh.id}`); await p.locator('.wa-connect').waitFor();
    assert.equal(await p.getByRole('button', { name: /Con mi número/ }).getAttribute('aria-pressed'), 'true');
    await p.getByLabel('Tu número de WhatsApp').fill('81 1111 2222');
    await p.getByRole('button', { name: 'Obtener código', exact: true }).click();
    await p.getByText('NEWC-0DE1', { exact: true }).waitFor();
    assert.equal(evo.instances.get(fresh.config.instance)?.number, '528111112222', 'la instancia vincula con ese número');
    await phone.close();
    await h.authed('DELETE', `/api/channels/${fresh.id}`);
  }
  checked('En el celular, el conector abre con "Con mi número" y entrega el código al primer toque');
  await go(`bot/${h.botId}/conexiones/${socialOn.id}`);
  await page.locator('.main .badge.green', { hasText: /^Conectado$/ }).first().waitFor();
  await page.getByText('Instagram · @hotelpalmas', { exact: true }).waitFor();
  await go(`bot/${h.botId}/conexiones/${socialNew.id}`);
  await page.getByRole('button', { name: 'Obtener código de Telegram', exact: true }).click();
  await page.getByText(/ZRN-\d+/).first().waitFor({ timeout: 10000 }).catch(async () => { throw new Error(`Sin código de Telegram: ${await page.locator('.main').innerText()}`); });
  const code = (await page.locator('.social-connect').innerText()).match(/ZRN-\d+/)![0];
  zer.telegram.get(code)!.status = 'connected';
  await page.locator('.main .badge.green', { hasText: /^Conectado$/ }).first().waitFor({ timeout: 10000 });
  checked('Redes sociales: cuenta conectada visible y Telegram se conecta con código desde el panel');
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
  {
    // Crear un agente en 3 pantallas: aprende, elige qué hará, se prueba y se enciende solo al conectar su WhatsApp.
    const context = await contextFor('admin'); const page = await context.newPage();
    page.on('pageerror', (error) => results.errors.push({ role: 'admin', message: error.message }));
    await page.route('**/api/onboarding/import**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ description: 'Hotel boutique en Mazatlán frente al mar.', sections: { catalog: 'Habitación doble — $1,800 por noche', hours: 'Recepción 24 horas', location: 'Av. del Mar 100, Mazatlán', faq: '', other: '' }, source: 'hotelpalmas.mx', truncated: false }) }));
    await page.goto(`${base}/#/agentes?new=1`); await page.waitForURL('**/#/agentes/nuevo');
    await page.getByRole('heading', { name: 'Crea tu agente' }).waitFor();
    await page.getByText('Lo escribo yo', { exact: true }).click();
    await page.getByLabel('Tu información').fill('Hotel boutique en Mazatlán. Habitación doble $1,800 por noche. Recepción 24 horas.');
    await page.getByRole('button', { name: 'Siguiente →' }).click(); await page.waitForURL('**/#/agentes/nuevo?paso=2');
    await page.getByRole('heading', { name: /Esto aprendió de/ }).waitFor();
    await page.locator('label.plan-option', { hasText: 'Agendar citas' }).click();
    await page.getByRole('button', { name: 'Crear mi agente' }).click(); await page.waitForURL(/#\/bot\/[0-9a-f-]+\/empezar$/);
    const created = page.url().split('/bot/')[1].split('/')[0];
    await page.locator('.composer textarea').waitFor();
    assert.deepEqual((await pool.query(`SELECT active, start_on_connect FROM chatbots WHERE id = $1`, [created])).rows[0], { active: false, start_on_connect: true });
    await page.getByRole('button', { name: 'Conectar mi WhatsApp', exact: true }).click(); await page.locator('.wa-connect').waitFor();
    const instance = (await pool.query(`SELECT config->>'instance' AS i FROM channels WHERE chatbot_id = $1 AND type = 'whatsapp'`, [created])).rows[0].i;
    await waitFor(() => evo.instances.has(instance), 10000); evo.instances.get(instance)!.state = 'open';
    await page.getByRole('heading', { name: '¡Listo! Tu agente ya responde en tu WhatsApp' }).waitFor({ timeout: 20000 });
    assert.deepEqual((await pool.query(`SELECT active, start_on_connect FROM chatbots WHERE id = $1`, [created])).rows[0], { active: true, start_on_connect: false });
    await context.close(); checked('Crear un agente en 3 pantallas y se enciende solo al conectar su WhatsApp');
  }
  {
    // Cobros: el cobro del cliente aparece con su monto y se marca pagado (ya no se le recuerda).
    const context = await contextFor('admin', { viewport: { width: 390, height: 900 } }); const page = await context.newPage();
    page.on('pageerror', (error) => results.errors.push({ role: 'admin', message: error.message }));
    await page.goto(`${base}/#/cobros`); await page.getByRole('heading', { name: 'Cobros', level: 1 }).waitFor();
    await page.locator('tbody tr', { hasText: 'Reservación de octubre' }).waitFor();
    await page.getByText('$1,800.00').first().waitFor();
    await page.getByRole('button', { name: 'Marcar pagado: Reservación de octubre' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Marcar pagado' }).click();
    await page.getByText('Cobro marcado como pagado').waitFor();
    assert.equal((await pool.query(`SELECT status FROM receivables WHERE id = $1`, [uxCharge.id])).rows[0].status, 'paid');
    // «Nuevo cobro» desde el formulario: buscar al cliente, llenar y registrar; aparece en la lista con sus recordatorios.
    await page.getByText('Nuevo cobro', { exact: true }).click();
    await page.getByLabel('Cliente').fill('Dato actualizado');
    await page.getByRole('button', { name: /^Dato actualizado del cliente/ }).click();
    await page.getByText(/^Cliente: Dato actualizado del cliente/).waitFor();
    await page.getByLabel('Concepto').fill('Anticipo de evento');
    await page.getByLabel('Monto').fill('950.50');
    await page.getByLabel('Vence').fill(new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Registrar cobro' }).click();
    await page.getByText(/^Cobro registrado: \d recordatorio/).waitFor();
    await page.locator('tbody tr', { hasText: 'Anticipo de evento' }).getByText('$950.50').waitFor();
    assert.equal((await pool.query(`SELECT amount_cents::int AS c FROM receivables WHERE concept = 'Anticipo de evento'`)).rows[0]?.c, 95050);
    // «Nuevo pago recurrente»: una mensualidad que se cobra sola cada mes.
    await page.goto(`${base}/#/cobros?tab=recurrentes`); await page.getByRole('heading', { name: 'Cobros', level: 1 }).waitFor();
    await page.getByText('Nuevo pago recurrente', { exact: true }).click();
    await page.getByLabel('Cliente').fill('Dato actualizado');
    await page.getByRole('button', { name: /^Dato actualizado del cliente/ }).click();
    await page.getByLabel('Concepto').fill('Mensualidad de clases');
    await page.getByLabel('Monto').fill('1200');
    await page.getByLabel('Día del mes').fill('15');
    await page.getByRole('button', { name: 'Registrar pago recurrente' }).click();
    await page.getByText(/^Pago recurrente registrado/).waitFor();
    await page.locator('tbody tr', { hasText: 'Mensualidad de clases' }).getByText('Cada mes, el día 15').waitFor();
    assert.equal((await pool.query(`SELECT amount_cents::int AS c, frequency, day FROM receivable_plans WHERE concept = 'Mensualidad de clases'`)).rows[0]?.c, 120000);
    await context.close(); checked('Cobros: ver el cobro del cliente, marcarlo pagado y registrar uno nuevo y un pago recurrente desde el celular');
  }
  {
    // Datos de tus clientes: agregar un dato con opciones, editar la fecha en la ficha, insertar la variable con un clic e importar un CSV.
    const context = await contextFor('admin', { viewport: { width: 390, height: 900 } }); const page = await context.newPage();
    page.on('pageerror', (error) => results.errors.push({ role: 'admin', message: error.message }));
    await page.goto(`${base}/#/datos-clientes`); await page.getByRole('heading', { name: 'Datos de tus clientes', level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Agregar dato' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Etiqueta').fill('Plan contratado');
    assert.equal(await dlg.getByLabel('Clave').inputValue(), 'plan_contratado', 'la clave sale de la etiqueta');
    await dlg.getByLabel('Tipo').selectOption('option');
    await dlg.getByLabel('Opciones').fill('Básico\nPremium');
    await dlg.getByRole('button', { name: 'Agregar' }).click();
    await page.getByText('Campo agregado').waitFor();
    await page.locator('tbody tr', { hasText: 'Plan contratado' }).getByText('{{campo.plan_contratado}}').waitFor();
    // La ficha: la fecha con su control de fecha y la opción con su lista.
    await page.goto(`${base}/#/conversation/${conv.id}`);
    const card = page.locator('#customer-data'); await card.waitFor();
    const birthday = card.getByLabel('Cumpleaños');
    assert.equal(await birthday.getAttribute('type'), 'date');
    await birthday.fill('1990-05-15');
    await card.getByLabel('Plan contratado').selectOption('Premium');
    await card.getByRole('button', { name: 'Guardar datos' }).click();
    await page.getByText('Datos guardados', { exact: true }).waitFor();
    const saved = (await pool.query(`SELECT data FROM contacts WHERE id = $1`, [conv.contact_id])).rows[0].data;
    assert.deepEqual([saved.cumpleanos, saved.plan_contratado], ['1990-05-15', 'Premium']);
    // La ayuda de variables de un mensaje: un clic inserta {{campo.cumpleanos}} donde está el cursor.
    await page.goto(`${base}/#/automation/sequences/new`);
    const message = page.getByLabel('Mensaje', { exact: true }).first(); await message.waitFor();
    await message.fill('Feliz cumpleaños ');
    await page.getByText('Variables (clic para insertar)').first().click();
    await page.getByRole('button', { name: 'Insertar {{campo.cumpleanos}}: Cumpleaños' }).first().click();
    assert.equal(await message.inputValue(), 'Feliz cumpleaños {{campo.cumpleanos}}');
    // Importar contactos desde CSV: el resumen dice cuántos se crearon y qué filas no entraron.
    await page.goto(`${base}/#/contacts`); await page.getByRole('heading', { name: 'Contactos', level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Importar contactos' }).click();
    await page.getByRole('dialog').getByLabel('Archivo').setInputFiles({ name: 'clientes.csv', mimeType: 'text/csv', buffer: Buffer.from('telefono,nombre,Cumpleaños\n5215599990001,Ximena,03/11/1985\n5215599990002,Yael,31/02/1990\n') });
    await page.getByRole('dialog').getByRole('button', { name: 'Importar' }).click();
    const summary = page.getByRole('dialog', { name: 'Importación terminada' });
    await summary.getByText('1 contacto nuevo y 0 actualizados.').waitFor();
    await summary.getByText(/Fila 3: «Cumpleaños» no es válido/).waitFor();
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } })).violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary })) })));
    results.screens.push({ role: 'admin', route: 'contacts (resumen de importación)', violations });
    await summary.getByRole('button', { name: 'Listo' }).click();
    assert.equal((await pool.query(`SELECT data->>'cumpleanos' AS d FROM contacts WHERE phone = '5215599990001'`)).rows[0]?.d, '1985-11-03');
    await context.close(); checked('Datos de tus clientes: agregar un dato, editarlo en la ficha con su control, insertarlo como variable e importar contactos por CSV desde el celular');
  }
  {
    // Teclado y lector de pantalla en el panel (auditoría A1, A2, A3, A5 y medios).
    const context = await contextFor('admin'); const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => results.errors.push({ role: 'admin', message: error.message }));
    await page.clock.install();
    // A1: la bandeja se vuelve a dibujar cada 10 s y el foco sigue en la misma conversación; los filtros dicen cuál está puesto.
    for (const n of ['5215500000101', '5215500000102']) { await h.webhook('Hola', { phone: n }); }
    await h.idle();
    await page.goto(`${base}/#/conversations`); await page.locator('.inbox-items a').nth(1).waitFor();
    const target = page.locator('.inbox-items a').nth(1);
    const href = await target.getAttribute('href');
    await target.focus();
    await h.webhook('Sigo aquí', { phone: '5215500000101' }); await h.idle();
    await page.clock.runFor(11000); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), href, 'el foco sigue en la conversación tras el sondeo');
    assert.equal(await page.getByRole('group', { name: 'Filtrar conversaciones' }).getByRole('button', { name: 'Todas' }).getAttribute('aria-pressed'), 'true');
    // A2: los mensajes son un registro; uno nuevo se agrega sin reconstruir los demás y dice quién habla.
    await page.goto(`${base}/#/conversation/${conv.id}`);
    const log = page.getByRole('log', { name: 'Mensajes de la conversación' }); await log.locator('.bubble').first().waitFor();
    await log.locator('.bubble').first().evaluate((b: any) => { b.__marcado = true; });
    await h.webhook('Mensaje nuevo para el lector');
    await h.idle(); await page.clock.runFor(6000);
    await log.getByText('Mensaje nuevo para el lector').waitFor();
    assert.equal(await log.locator('.bubble').first().evaluate((b: any) => b.__marcado === true), true, 'la burbuja anterior es el mismo nodo');
    assert.match(await log.locator('.bubble', { hasText: 'Mensaje nuevo para el lector' }).innerText(), /^Cliente:/);
    // Saltar al contenido, título de la pestaña y foco en el título.
    await page.goto(`${base}/#/agentes`); await page.locator('.main h1').waitFor();
    assert.match(await page.title(), /^Agentes · /);
    // Desde el inicio del documento (como al abrir la página), el primer Tab llega a «Saltar al contenido».
    await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Saltar al contenido');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'contenido');
    // A5: el error del servidor va junto a su campo, con su ayuda, el foco en él y un solo aviso.
    await page.goto(`${base}/#/users`); await page.locator('.main h1').waitFor();
    const create = page.locator('details.card', { hasText: 'Crear usuario con contraseña inicial' });
    await create.locator('summary').click();
    const phone = create.getByLabel('WhatsApp para alertas (opcional)');
    await create.getByLabel('Nombre', { exact: true }).fill('Persona sin lada');
    await create.getByLabel('Correo', { exact: true }).fill('sinlada@auditoria.test');
    await create.getByLabel('Contraseña inicial', { exact: true }).fill('Pz-100-Qx-300-Kv');
    await phone.fill('5512345678');
    await page.getByRole('button', { name: 'Crear usuario', exact: true }).click();
    await page.getByText(/Incluye la lada del país/).first().waitFor();
    assert.equal(await phone.getAttribute('aria-invalid'), 'true');
    const describedBy = (await phone.getAttribute('aria-describedby')) || '';
    assert.match(await page.evaluate((ids) => ids.split(' ').map((id) => document.getElementById(id)?.textContent).join(' | '), describedBy), /Incluye la lada del país/);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'phone', 'el foco va al campo con el error');
    assert.equal(await page.locator('#toast-alert').textContent(), '', 'sin repetir el error en el aviso emergente');
    await phone.fill('5215512345678');
    assert.equal(await phone.getAttribute('aria-invalid'), null, 'al corregir se quita la marca');
    // Un aviso con un diálogo abierto queda dentro del diálogo, a la vista.
    await page.evaluate(async () => {
      const core = await import('/js/core.js');
      core.dialog('Prueba', core.h('p', {}, 'Diálogo abierto'));
      core.toast('Aviso sobre el diálogo');
    });
    await page.getByRole('dialog').getByText('Aviso sobre el diálogo').waitFor();
    assert.equal(await page.evaluate(() => { const t = document.getElementById('toast')!; const r = t.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#toast') !== null; }), true, 'el aviso se ve encima del diálogo');
    await page.keyboard.press('Escape');
    // Menú de la cuenta con teclado.
    await page.getByRole('button', { name: /menú de tu cuenta$/ }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Mi perfil');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cerrar sesión');
    await page.keyboard.press('Escape');
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || ''), /menú de tu cuenta$/);
    assert.equal(await page.getByRole('menu').count(), 0, 'el menú se cerró');
    // Contraste calculado: borde de los campos (3:1) y botón rojo sólido (4.5:1), en claro y oscuro.
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate('window.__name = (f) => f'); // tsx nombra las funciones con __name, que la página no tiene
      const ratios = await page.evaluate(() => {
        const rgb = (c: string) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = (c: string) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const input = document.createElement('input'); document.querySelector('.main')!.append(input);
        const danger = document.createElement('button'); danger.className = 'danger solid'; danger.textContent = 'Borrar'; document.querySelector('.main')!.append(danger);
        const surface = getComputedStyle(input).backgroundColor;
        const out = { border: ratio(getComputedStyle(input).borderTopColor, surface), danger: ratio(getComputedStyle(danger).color, getComputedStyle(danger).backgroundColor) };
        input.remove(); danger.remove();
        return out;
      });
      assert.ok(ratios.border >= 3, `borde de campos ${scheme}: ${ratios.border.toFixed(2)}:1`);
      assert.ok(ratios.danger >= 4.5, `botón rojo ${scheme}: ${ratios.danger.toFixed(2)}:1`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    // Borrar un pendiente pide confirmación.
    assert.equal((await h.authed('POST', `/api/contacts/${conv.contact_id}/tasks`, { kind: 'pendiente', body: 'Llamar para confirmar la reservación' })).statusCode < 300, true);
    await page.goto(`${base}/#/conversation/${conv.id}`);
    await page.getByRole('button', { name: 'Borrar pendiente: Llamar para confirmar la reservación' }).click();
    await page.getByRole('dialog', { name: 'Confirma la acción' }).getByText('¿Borrar el pendiente «Llamar para confirmar la reservación»?').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM contact_tasks WHERE body = 'Llamar para confirmar la reservación'`)).rows[0].n, 1);
    await context.close();
    // A3: en el celular, el menú lateral se abre con el foco dentro, deja el resto inerte y Escape lo cierra.
    const phoneCtx = await contextFor('admin', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await phoneCtx.newPage(); p.setDefaultTimeout(10000);
    await p.goto(`${base}/#/agentes`); await p.locator('.main h1').waitFor();
    const toggle = p.getByRole('button', { name: 'Abrir el menú' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await p.waitForFunction(() => !!document.activeElement?.closest('#menu-principal'));
    assert.equal(await p.evaluate(() => document.querySelector('.content')?.hasAttribute('inert')), true, 'el resto queda inerte');
    await p.keyboard.press('Escape');
    assert.equal(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Abrir el menú', 'el foco vuelve al botón');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    // Sin teclado (lector en el celular) se cierra con su botón, y el foco vuelve igual al botón del menú.
    await toggle.click();
    await p.getByRole('button', { name: 'Cerrar el menú' }).click();
    assert.equal(await p.evaluate(() => document.querySelector('.content')?.hasAttribute('inert')), false);
    assert.equal(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Abrir el menú');
    // Las páginas públicas también tienen <main> y su título enfocado.
    await p.context().clearCookies();
    await p.goto(`${base}/#/olvide`); await p.locator('main h1').waitFor();
    assert.equal(await p.evaluate(() => document.activeElement?.tagName), 'H1');
    assert.match(await p.title(), / · /);
    await phoneCtx.close();
  }
  checked('Teclado: la bandeja conserva el foco, los mensajes se anuncian, saltar al contenido, errores en su campo, avisos sobre diálogos, menús, contraste y confirmar al borrar');
  {
    // Copiloto: pedir, ver la tarjeta, deshacer, «Cambiar esto» y confirmar un mensaje; el panel sigue abierto al navegar.
    await pool.query(`UPDATE accounts SET copilot_enabled = true WHERE id = $1`, [h.accountId]);
    h.setCopilotScript((req) => {
      const last: any = req.messages[req.messages.length - 1];
      if (last.role === 'tool') return /pendiente_de_confirmacion/.test(last.content) ? 'Revisa el mensaje y confírmalo en la tarjeta.' : 'Listo. Puedes **deshacerlo** desde la tarjeta.';
      if (/vip/i.test(String(last.content))) return { tool_calls: [{ name: 'etiquetar', arguments: { contacto_ids: [conv.contact_id], agregar: ['vip'] } }] };
      return { tool_calls: [{ name: 'enviar_mensaje', arguments: { conversacion_id: conv.id, texto: 'Te esperamos el sábado a las 11.' } }] };
    });
    const context = await contextFor('admin'); const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => results.errors.push({ role: 'admin', message: error.message }));
    await page.goto(`${base}/#/contact/${conv.contact_id}`); await page.locator('.main h1').waitFor();
    const launcher = page.locator('.sidebar [data-copilot-launcher]');
    await launcher.click();
    const panel = page.locator('#copilot');
    await panel.getByText('En esta página:').waitFor();
    assert.equal(await launcher.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'copilot-input', 'el foco va al cuadro de texto');
    const input = panel.getByLabel('Qué necesitas del Copiloto');
    await input.fill('Etiqueta a este contacto como VIP'); await input.press('Enter');
    const done = panel.locator('.cp-card.is-done'); await done.waitFor();
    await panel.locator('.cp-msg.is-copilot', { hasText: 'Listo.' }).waitFor();
    assert.ok((await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [conv.contact_id])).rows[0].tags.includes('vip'));
    await panel.getByRole('button', { name: 'Actualizar vista' }).click();
    await page.locator('.main').getByText('vip', { exact: true }).first().waitFor();
    await done.getByRole('button', { name: /^Deshacer/ }).click();
    await panel.locator('.cp-card.is-undone').waitFor();
    assert.ok(!(await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [conv.contact_id])).rows[0].tags.includes('vip'));
    await panel.locator('.cp-card.is-undone').getByRole('button', { name: /^Cambiar esto/ }).click();
    await panel.locator('.cp-chip.ref').waitFor();
    await panel.locator('.cp-chip.ref').getByRole('button').click();
    const before = h.sent.length;
    await input.fill('Avísale que la esperamos el sábado'); await input.press('Enter');
    const proposal = panel.locator('.cp-card.is-proposed'); await proposal.waitFor();
    await panel.locator('.cp-msg.is-copilot', { hasText: 'confírmalo' }).waitFor();
    assert.equal(h.sent.length, before, 'nada sale antes de confirmar');
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } })).violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary })) })));
    results.screens.push({ role: 'admin', route: 'copiloto (propuesta)', violations });
    await proposal.getByRole('button', { name: /^Confirmar: Enviar mensaje/ }).click();
    await panel.locator('.cp-event', { hasText: 'Confirmaste' }).waitFor();
    await waitFor(() => h.sent.some((m: any) => JSON.stringify(m).includes('Te esperamos el sábado a las 11.')), 8000);
    await page.goto(`${base}/#/contacts`); await page.locator('.main h1').waitFor();
    await panel.getByText('En esta página: Contactos').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await input.press('Escape');
    assert.equal(await panel.isHidden(), true, 'Escape cierra el Copiloto');
    await context.close();
    // Ancho a ancho, claro y oscuro: abierto sin desbordar; en el celular es un diálogo y Escape devuelve el foco.
    for (const width of [320, 390, 768, 1024, 1440]) for (const theme of ['light', 'dark'] as const) {
      const ctx = await contextFor('admin', { viewport: { width, height: 900 }, colorScheme: theme, ...(width <= 390 ? { isMobile: true, hasTouch: true } : {}) });
      const p = await ctx.newPage(); p.setDefaultTimeout(10000);
      p.on('pageerror', (error) => results.errors.push({ role: 'admin', message: error.message }));
      await p.goto(`${base}/#/contact/${conv.contact_id}`); await p.locator('.main h1').waitFor();
      await p.locator('[data-copilot-launcher]:visible').click();
      await p.locator('#copilot .cp-chip').first().waitFor();
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      results.responsive.push({ width, theme, route: 'copiloto', overflow });
      assert.equal(overflow, false, `Desbordamiento del Copiloto ${width} ${theme}`);
      if (width <= 768) {
        assert.equal(await p.locator('#copilot').getAttribute('aria-modal'), 'true');
        assert.equal(await p.evaluate(() => document.getElementById('app')?.hasAttribute('inert')), true, 'el resto queda inerte');
        await p.keyboard.press('Escape');
        assert.equal(await p.evaluate(() => document.activeElement?.hasAttribute('data-copilot-launcher')), true, 'el foco vuelve al botón del Copiloto');
      }
      if (width === 390 && theme === 'dark') await p.screenshot({ path: `${output}/copiloto-mobile.png` });
      await ctx.close();
    }
    // El agente lo usa con ejemplos de su rol.
    const agentCtx = await contextFor('agent'); const ap = await agentCtx.newPage(); ap.setDefaultTimeout(10000);
    await ap.goto(`${base}/#/conversations`); await ap.locator('.main h1').waitFor();
    await ap.locator('.sidebar [data-copilot-launcher]').click();
    await ap.locator('#copilot').getByText('¿Qué conversaciones tengo sin responder?').waitFor();
    await agentCtx.close();
  }
  checked('Copiloto: pedir, deshacer, «Cambiar esto», confirmar un mensaje, navegar con el panel abierto, en cada ancho y para el agente');
  assert.deepEqual(results.badNames || [], [], 'Controles con nombre genérico o una llave en inglés');
  assert.equal(results.errors.length, 0, JSON.stringify(results.errors));
  assert.deepEqual(cspViolations, [], 'La CSP bloqueó algo del panel o de una página pública');
  const serious = results.screens.flatMap((screen: any) => screen.violations.filter((v: any) => ['critical', 'serious'].includes(v.impact)).map((v: any) => ({ role: screen.role, route: screen.route, ...v })));
  results.serious = serious;
  fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
  assert.equal(serious.length, 0, JSON.stringify(serious, null, 2));
  console.log(`UX OK: ${results.regressions.length} comprobaciones, ${results.screens.length} pantallas y ${results.responsive.length} escenarios adaptables.`);
} finally {
  fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
  await browser?.close(); await h.app.close(); await pool.end();
}
