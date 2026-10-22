/** Regresión UX: PostgreSQL AISLADO, proveedor simulado y navegador real. El arnés reinicia public. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createHarness, pool, waitFor, evo, ext, zer } from '../test/harness.js';

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
  // Redes sociales (Zernio): una sin conectar y una conectada con su cuenta.
  const socialNew = (await h.authed('POST', '/api/channels', { account_id: h.accountId, chatbot_id: h.botId, name: 'Telegram del hotel', type: 'zernio', config: { platform: 'telegram' } })).json();
  // La conectada pasa por el flujo real: pedir la autorización y volver de Zernio con una cuenta del perfil del negocio.
  const socialOn = (await h.authed('POST', '/api/channels', { account_id: h.accountId, chatbot_id: h.botId, name: 'Instagram del hotel', type: 'zernio', config: { platform: 'instagram' } })).json();
  assert.equal((await h.authed('POST', `/api/channels/${socialOn.id}/zernio/connect`)).statusCode, 200);
  const onCfg = (await pool.query(`SELECT config FROM channels WHERE id = $1`, [socialOn.id])).rows[0].config;
  zer.accounts.set('acc_ux', { _id: 'acc_ux', platform: 'instagram', profileId: onCfg.profile_id, username: 'hotelpalmas', displayName: 'Hotel Palmas', isActive: true });
  assert.equal((await h.app.inject({ method: 'GET', url: `/zernio/callback/${socialOn.webhook_token}/${onCfg.connect_state}?accountId=acc_ux&username=hotelpalmas` })).statusCode, 302);
  // WhatsApp oficial con una plantilla aprobada y otra rechazada (pantalla de plantillas).
  const waSocial = (await pool.query(`INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name) VALUES ($1, 'acc_ux_wa', $2, 'whatsapp', '+52 81 1234 5678', 'Hotel Palmas WhatsApp') RETURNING id`, [h.accountId, onCfg.profile_id])).rows[0].id;
  await pool.query(`INSERT INTO wa_templates (account_id, social_account_id, name, language, category, status, components) VALUES ($1, $2, 'recordatorio_cita', 'es_MX', 'UTILITY', 'APPROVED', $3)`, [h.accountId, waSocial, JSON.stringify([{ type: 'BODY', text: 'Hola {{1}}, te esperamos el {{2}}.' }])]);
  await pool.query(`INSERT INTO wa_templates (account_id, social_account_id, name, language, category, status, rejection_reason, components) VALUES ($1, $2, 'promo_octubre', 'es_MX', 'MARKETING', 'REJECTED', 'El contenido parece engañoso', $3)`, [h.accountId, waSocial, JSON.stringify([{ type: 'BODY', text: '¡Gana un premio!' }])]);
  // Comentarios y reseñas: una publicación de Instagram con un comentario largo y una reseña de Google.
  const igSocial = (await pool.query(`INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name) VALUES ($1, 'acc_ux_ig', $2, 'instagram', 'hotelpalmas', 'Hotel Palmas') RETURNING id`, [h.accountId, onCfg.profile_id])).rows[0].id;
  const gbSocial = (await pool.query(`INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name) VALUES ($1, 'acc_ux_gb', $2, 'googlebusiness', '', 'Hotel Palmas Cancún') RETURNING id`, [h.accountId, onCfg.profile_id])).rows[0].id;
  const uxPost = (await pool.query(`INSERT INTO social_posts (account_id, social_account_id, platform_post_id, url, caption) VALUES ($1, $2, 'ux_post', 'https://instagram.test/p/ux', 'Nuestra suite con vista al mar y desayuno incluido para dos personas') RETURNING id`, [h.accountId, igSocial])).rows[0].id;
  await pool.query(`INSERT INTO social_comments (account_id, social_account_id, post_id, platform, platform_post_id, comment_id, author, text, created_at_platform, ai_suggestion, sentiment) VALUES ($1, $2, $3, 'instagram', 'ux_post', 'ux_c1', $4, $5, now(), '¡Hola Lucía! La suite está en $2,900 MXN por noche con desayuno.', 'positive')`,
    [h.accountId, igSocial, uxPost, JSON.stringify({ name: 'Lucía Hernández', username: 'lucia.hdz' }), '¿Cuánto cuesta la suite para el fin de semana largo de noviembre? Somos dos adultos y queremos llevar a nuestro perrito, ¿lo aceptan?']);
  await pool.query(`INSERT INTO social_reviews (account_id, social_account_id, platform, review_id, author, rating, text, created_at_platform) VALUES ($1, $2, 'googlebusiness', 'accounts/1/locations/2/reviews/ux', $3, 2, 'El cuarto estaba sucio y nadie contestó en recepción.', now())`,
    [h.accountId, gbSocial, JSON.stringify({ name: 'Mario' })]);
  // Publicaciones: una programada para mañana con dos redes y una que salió solo en una.
  const pubA = (await pool.query(`INSERT INTO social_publications (account_id, status, text, scheduled_for, timezone) VALUES ($1, 'programada', $2, now() + interval '1 day', 'America/Mexico_City') RETURNING id`,
    [h.accountId, 'Este fin de semana: brunch con música en vivo en la terraza. ¡Reserva tu mesa! #HotelPalmas #Cancún'])).rows[0].id;
  const pubB = (await pool.query(`INSERT INTO social_publications (account_id, status, text, published_at, timezone) VALUES ($1, 'parcial', $2, now() - interval '2 hours', 'America/Mexico_City') RETURNING id`,
    [h.accountId, 'Nueva suite con vista al mar'])).rows[0].id;
  for (const [pub, status, url, error] of [[pubA, 'pendiente', '', ''], [pubB, 'publicada', 'https://instagram.test/p/suite', '']]) {
    await pool.query(`INSERT INTO social_publication_targets (publication_id, account_id, social_account_id, zernio_account_id, platform, username, status, url, error) VALUES ($1, $2, $3, 'acc_ux_ig', 'instagram', 'hotelpalmas', $4, $5, $6)`,
      [pub, h.accountId, igSocial, status, url, error]);
  }
  await pool.query(`INSERT INTO social_publication_targets (publication_id, account_id, social_account_id, zernio_account_id, platform, username, status, error) VALUES ($1, $2, $3, 'acc_ux_gb', 'googlebusiness', '', 'fallida', 'La imagen no cumple el tamaño mínimo de Google')`,
    [pubB, h.accountId, gbSocial]);
  // Reportes → Redes sociales: 30 días de cifras de Instagram y de Google.
  await pool.query(`INSERT INTO social_account_stats (social_account_id, account_id, day, followers, impressions, reach, engagement, posts)
    SELECT $1, $2, (now() AT TIME ZONE 'UTC')::date - n, 1410 - n * 7, 800 + (n * 37) % 500, 500 + (n * 23) % 300, 40 + (n * 11) % 60, (n % 3 = 0)::int FROM generate_series(1, 30) n`, [igSocial, h.accountId]);
  await pool.query(`INSERT INTO social_account_stats (social_account_id, account_id, day, impressions, engagement)
    SELECT $1, $2, (now() AT TIME ZONE 'UTC')::date - n, 60 + (n * 13) % 40, 3 + n % 5 FROM generate_series(1, 30) n`, [gbSocial, h.accountId]);
  // Flujo con botones (editor, "enviar a un grupo") y su mensaje con botones en la conversación, con la opción elegida.
  const uxFlow = (await h.authed('POST', '/api/sequences', { account_id: h.accountId, name: 'Promoción de octubre', active: true, steps: [
    { delay_value: 0, delay_unit: 'minutes', text: 'Hola {{nombre}}, ¿te interesa la promoción de octubre?', buttons: [
      { label: 'Sí, me interesa', action: 'next', reply: '¡Genial! Te cuento más 👇' }, { label: 'No, gracias', action: 'end' },
      { label: 'Hablar con alguien', action: 'handoff' }, { label: 'Ver promoción', kind: 'url', url: 'https://hotel.test/promo' }], wait_for_choice: true },
    { delay_value: 1, delay_unit: 'days', text: 'Estos son los detalles de la promoción.' },
    { delay_value: 1, delay_unit: 'days', text: 'Último día de la promoción.' },
  ] })).json().id;
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, status, meta) VALUES ($1, 'out', 'bot', 'text', $2, 'ok', $3)`,
    [conv.id, 'Hola Ana, ¿te interesa la promoción de octubre?', JSON.stringify({ source: 'sequence', buttons: [{ kind: 'reply', label: 'Sí, me interesa', payload: 'rr:abcdef0123:1' }, { kind: 'reply', label: 'No, gracias', payload: 'rr:abcdef0123:2' }, { kind: 'url', label: 'Ver promoción', url: 'https://hotel.test/promo' }] })]);
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, status, processed, meta) VALUES ($1, 'in', 'customer', 'text', 'Sí, me interesa', 'ok', true, $2)`, [conv.id, JSON.stringify({ button: 'rr:abcdef0123:1', choice: 'Sí, me interesa' })]);
  const uxMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit' }).format(new Date());
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
  const routes = ['agentes', `bot/${h.botId}/instrucciones`, `bot/${h.botId}/preguntas`, `bot/${h.botId}/activacion`, `bot/${h.botId}/conocimiento`, `bot/${h.botId}/imagenes`, `bot/${h.botId}/conexiones`, `bot/${h.botId}/probar`, `bot/${h.botId}/conexiones/${h.channelId}`, `bot/${h.botId}/conexiones/${socialNew.id}`, `bot/${h.botId}/conexiones/${socialOn.id}`, 'conversations', `conversation/${conv.id}`, 'agenda', 'agenda/servicios', `agenda/servicios?id=${service.id}`, 'agenda/equipo', 'agenda/enlaces', 'automation/rules', 'automation/rules/new', 'automation/sequences', 'automation/sequences/new', `automation/sequences/${uxFlow}`, 'automation/campaigns', 'automation/campaigns/new', `automation/campaigns/new?flow=${uxFlow}`, 'automation/settings', 'pipeline', 'pipeline/editar/nuevo', 'ajustes', 'integraciones', 'redes', `redes/whatsapp/${waSocial}`, 'comentarios', 'comentarios?tipo=review', 'publicaciones', `publicaciones?vista=calendario&mes=${uxMonth}`, 'publicaciones/nueva', `publicaciones/${pubA}`, 'users', 'consumo', 'logs', 'plan', 'estadisticas', 'estadisticas/redes', 'notifications', 'password', 'inicio', 'agentes/nuevo', `bot/${h.botId}/empezar`];
  const helpScreens: Record<string, string> = { [`bot/${h.botId}/conocimiento`]: '01-importar.jpg', [`bot/${h.botId}/probar`]: '03-probar.jpg', [`conversation/${conv.id}`]: '05-conversacion.jpg', ajustes: '06-ajustes.jpg' };
  for (const role of ['admin', 'superadmin', 'agent']) {
    const context = await contextFor(role); const page = await context.newPage();
    page.on('pageerror', (error) => results.errors.push({ role, message: error.message }));
    const selected = role === 'admin' ? routes : role === 'agent' ? ['conversations', `conversation/${conv.id}`, 'agenda', 'notifications', 'pipeline', 'password'] : ['agentes', 'agentes/nuevo', 'accounts', 'planes', 'marcas', 'sistema', 'sistema/zernio', 'redes', 'users', 'ajustes', 'integraciones'];
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
    for (const route of ['agentes', 'agentes/nuevo', `bot/${h.botId}/empezar`, `bot/${h.botId}/instrucciones`, `conversation/${conv.id}`, 'conversations', 'automation/sequences/new', `automation/sequences/${uxFlow}`, `automation/campaigns/new?flow=${uxFlow}`, 'agenda', 'redes', `redes/whatsapp/${waSocial}`, 'comentarios', 'publicaciones', `publicaciones?vista=calendario&mes=${uxMonth}`, 'publicaciones/nueva', 'estadisticas/redes']) {
      await page.goto(`${base}/#/${route}`); await page.locator('.main h1').waitFor(); await page.waitForTimeout(80);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      results.responsive.push({ width, theme, route, overflow });
      assert.equal(overflow, false, `Desbordamiento en ${route} ${width} ${theme}`);
      if (width === 390 && theme === 'dark') await page.screenshot({ path: `${output}/${route.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'id').replace(/[^a-z0-9]+/gi, '-')}-mobile.png`, fullPage: true });
    }
    await context.close();
  }
  checked('60 escenarios adaptables sin desbordamiento');
  // Página pública para reservar: sin sesión, accesible y sin desbordamiento (celular y escritorio, claro y oscuro).
  const bookingLink = (await h.authed('POST', '/api/booking-links', { account_id: h.accountId, name: 'Agenda con nosotros' })).json();
  for (const width of [320, 390, 1024]) for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser!.newContext({ viewport: { width, height: 900 }, colorScheme: theme }); const pg = await ctx.newPage();
    pg.on('pageerror', (error) => results.errors.push({ role: 'público', message: error.message }));
    await pg.goto(bookingLink.url.replace('https://bot.test', base)); await pg.locator('main h2').first().waitFor();
    await pg.addScriptTag({ content: axe });
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
