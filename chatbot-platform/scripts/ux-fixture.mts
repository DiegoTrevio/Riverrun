/**
 * Datos de prueba de las auditorías en el navegador (test:ux y test:buttons): un negocio con su agente, conversación,
 * redes, plantillas, flujos, cobros, avisos y usuarios de cada rol, todo contra los servicios simulados del arnés.
 */
import assert from 'node:assert/strict';
import { pool, waitFor, zer } from '../test/harness.js';

type Harness = Awaited<ReturnType<typeof import('../test/harness.js').createHarness>>;

export async function seedUxFixture(h: Harness) {
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
  // Lienzo de flujos: un inicio por palabra, un mensaje con botones (uno lleva a otra rama), una espera, una nota y una etiqueta.
  const uxBoard = (await h.authed('POST', '/api/flow-boards', { account_id: h.accountId, name: 'Promo de octubre en el lienzo', board: {
    nodes: [
      { id: 't1', type: 'trigger', x: 0, y: 0, data: { trigger: { type: 'message_received', match: 'keywords', keywords: ['promo'] }, stop_ai: true } },
      { id: 'm1', type: 'message', x: 0, y: 200, data: { text: 'Hola {{nombre}}, ¿te interesa la promoción de octubre?', buttons: [{ id: 'b1', label: 'Sí, me interesa' }, { id: 'b2', label: 'Hablar con alguien' }] } },
      { id: 'w1', type: 'wait', x: 0, y: 520, data: { value: 1, unit: 'days' } },
      { id: 'm2', type: 'message', x: 0, y: 660, data: { text: 'Estos son los detalles de la promoción.' } },
      { id: 'a1', type: 'action', x: 380, y: 200, data: { action: 'handoff' } },
      { id: 'n1', type: 'note', x: -320, y: 0, data: { text: 'Revisar precios con el equipo', color: 'sky' } },
    ],
    edges: [{ id: 'e1', from: 't1', port: 'out', to: 'm1' }, { id: 'e2', from: 'm1', port: 'out', to: 'w1' }, { id: 'e3', from: 'w1', port: 'out', to: 'm2' }, { id: 'e4', from: 'm1', port: 'b:b2', to: 'a1' }],
  } })).json().id;
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, status, meta) VALUES ($1, 'out', 'bot', 'text', $2, 'ok', $3)`,
    [conv.id, 'Hola Ana, ¿te interesa la promoción de octubre?', JSON.stringify({ source: 'sequence', buttons: [{ kind: 'reply', label: 'Sí, me interesa', payload: 'rr:abcdef0123:1' }, { kind: 'reply', label: 'No, gracias', payload: 'rr:abcdef0123:2' }, { kind: 'url', label: 'Ver promoción', url: 'https://hotel.test/promo' }] })]);
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, status, processed, meta) VALUES ($1, 'in', 'customer', 'text', 'Sí, me interesa', 'ok', true, $2)`, [conv.id, JSON.stringify({ button: 'rr:abcdef0123:1', choice: 'Sí, me interesa' })]);
  // Un cobro pendiente del cliente (Cobros y su recordatorio de pago).
  const uxDue = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  await h.authed('PUT', `/api/receivables/settings?account_id=${h.accountId}`, { payment_instructions: 'Transferencia a la CLABE 012180001234567890.' });
  const uxCharge = (await h.authed('POST', `/api/receivables?account_id=${h.accountId}`, { contact_id: conv.contact_id, concept: 'Reservación de octubre', amount_cents: 180000, due_date: uxDue })).json().receivable;
  // «Datos de tus clientes»: un campo de fecha que la ficha muestra con su control.
  assert.equal((await h.authed('POST', `/api/contact-fields?account_id=${h.accountId}`, { label: 'Cumpleaños', key: 'cumpleanos', type: 'date' })).statusCode, 201);
  const uxMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit' }).format(new Date());
  const login: Record<string, any> = { superadmin: h.authed };
  // Con qué entra cada rol (p. ej. para abrir una sesión nueva por navegador).
  const credentials: Record<string, [string, string]> = { superadmin: ['admin@test.mx', 'secreto123'] };
  for (const role of ['admin', 'agent']) {
    const user = (await h.authed('POST', '/api/users', { account_id: h.accountId, name: `Auditor ${role}`, email: `${role}@auditoria.test`, password: 'Pz-100-Qx-300-Kv', role })).json();
    credentials[role] = [`${role}@auditoria.test`, 'Pz-100-Qx-300-Kv'];
    login[role] = await h.loginAs(...credentials[role]);
    if (role === 'agent') await h.authed('PUT', `/api/conversations/${conv.id}/assign`, { user_id: user.id });
  }
  // Un aviso urgente cuyo WhatsApp no llegó y salió por correo, y WhatsApp que siguen fallando (Notificaciones).
  const auditor = (await pool.query(`SELECT id, email FROM users WHERE email = 'admin@auditoria.test'`)).rows[0];
  const uxNotice = (await pool.query(`INSERT INTO notifications (account_id, user_id, title, body, link, kind) VALUES ($1, $2, '🚨 Posible emergencia', 'Un cliente pidió ayuda urgente.', $3, 'safety') RETURNING id`, [h.accountId, auditor.id, `#/conversation/${conv.id}`])).rows[0].id;
  const uxReceipt = (channel: string, destination: string, status: string, error: string, fallbackOf: string | null = null, notice: string | null = uxNotice) => pool.query(
    `INSERT INTO alert_receipts (account_id, notification_id, user_id, alert_key, kind, channel, destination, payload, status, attempts, last_error, fallback_of)
     VALUES ($1, $2, $3, '00000000-0000-4000-8000-000000000001', 'safety', $4, $5, $6, $7, 4, $8, $9) RETURNING id`,
    [h.accountId, notice, auditor.id, channel, destination, JSON.stringify({ title: '🚨 Posible emergencia', body: 'Un cliente pidió ayuda urgente.' }), status, error, fallbackOf]);
  const uxWa = (await uxReceipt('whatsapp', '5215511112222', 'failed', 'El WhatsApp del negocio está desconectado')).rows[0].id;
  await uxReceipt('email', auditor.email, 'sent', '', uxWa);
  for (let i = 0; i < 2; i++) await uxReceipt('whatsapp', '5215511112222', 'failed', 'Evolution sendText → HTTP 500', null, null);

  // Pantallas de cada rol con estos datos.
  const admin = ['agentes', `bot/${h.botId}/instrucciones`, `bot/${h.botId}/preguntas`, `bot/${h.botId}/activacion`, `bot/${h.botId}/conocimiento`, `bot/${h.botId}/imagenes`, `bot/${h.botId}/conexiones`, `bot/${h.botId}/probar`, `bot/${h.botId}/conexiones/${h.channelId}`, `bot/${h.botId}/conexiones/${socialNew.id}`, `bot/${h.botId}/conexiones/${socialOn.id}`, 'conversations', `conversation/${conv.id}`, 'agenda', 'agenda/servicios', `agenda/servicios?id=${service.id}`, 'agenda/equipo', 'agenda/enlaces', 'automation/lienzo', `automation/lienzo/${uxBoard}`, 'automation/rules', 'automation/rules/new', 'automation/sequences', 'automation/sequences/new', `automation/sequences/${uxFlow}`, 'automation/campaigns', 'automation/campaigns/new', `automation/campaigns/new?flow=${uxFlow}`, 'automation/settings', 'pipeline', 'pipeline/editar/nuevo', 'ajustes', 'integraciones', 'redes', `redes/whatsapp/${waSocial}`, 'comentarios', 'comentarios?tipo=review', 'publicaciones', `publicaciones?vista=calendario&mes=${uxMonth}`, 'publicaciones/nueva', `publicaciones/${pubA}`, 'users', 'consumo', 'logs', 'plan', 'cobros', 'cobros?tab=recurrentes', 'cobros?tab=ajustes', 'datos-clientes', 'contacts', 'estadisticas', 'estadisticas/redes', 'notifications', 'notifications?grupo=handoff', 'password', 'inicio', 'agentes/nuevo', `bot/${h.botId}/empezar`];
  const agent = ['conversations', `conversation/${conv.id}`, 'agenda', 'cobros', 'cobros?tab=recurrentes', 'datos-clientes', 'notifications', 'pipeline', 'password'];
  const superadmin = ['agentes', 'agentes/nuevo', 'accounts', 'planes', 'marcas', 'sistema', 'sistema/zernio', 'redes', 'users', 'ajustes', 'integraciones'];
  return { conv, service, socialNew, socialOn, onCfg, waSocial, igSocial, gbSocial, uxPost, pubA, pubB, uxFlow, uxBoard, uxDue, uxCharge, uxMonth, login, credentials, auditor, uxNotice, routes: { admin, agent, superadmin } };
}
