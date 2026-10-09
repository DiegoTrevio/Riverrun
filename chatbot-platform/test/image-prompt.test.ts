/**
 * Fotos que se envían según el prompt y el contexto: las promesas de foto se cumplen o se quitan, la foto que elige la
 * IA sale (o se reintenta), las automáticas no se pierden ni se repiten, y el panel avisa de lo que no cuadra.
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
// El arnés va primero: define las variables de entorno antes de que se cargue la configuración.
import { createHarness, dbAvailable, pool, sleep, store } from './harness.js';
const { validateDecision } = await import('../src/engine/validator.js');
const { buildSystemPrompt } = await import('../src/engine/context.js');
const { asksAgain, imagesBeforeReply } = await import('../src/engine/images.js');
const { photoWarnings } = await import('../src/engine/photo-check.js');
const { instagramAdapter, messengerAdapter, splitByBytes } = await import('../src/channels/meta.js');
const { config } = await import('../src/config.js');
const { hydrateChatbot } = await import('../src/types.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);

/* ------------------------------ Reglas puras (sin base de datos) ------------------------------ */

const bot = (patch: Record<string, unknown> = {}) =>
  hydrateChatbot({ id: 'b', account_id: 'a', name: 'Hotel', active: true, personality: {}, rules: {}, flow: {}, ai: {}, saved_messages: [], data_fields: [], created_at: new Date(), updated_at: new Date(), ...patch } as any);
const img = (code: string, name: string, sendWhen: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id: `id-${code}`, chatbot_id: 'b', code, name, description: '', usage_rule: '', caption: '', file_path: '', mime_type: 'image/png', size_bytes: 1, active: true, send_when: { mode: 'ai', ...sendWhen }, ...extra }) as any;
const menu = img('menu', 'Menú del día');
const alberca = img('alberca', 'Alberca');
const suite = img('suite', 'Suite', { mode: 'rules', keywords: ['suite'] });
const bienvenida = img('bienvenida', 'Bienvenida', { mode: 'rules', first_message: true });
const ALL = [menu, alberca, suite, bienvenida];
const decide = (messages: string[], o: Record<string, any> = {}) =>
  validateDecision({
    bot: o.bot ?? bot(),
    images: o.images ?? [menu, alberca],
    automaticImages: o.all ?? ALL,
    sentImageIds: o.sent ?? [],
    groundingSources: [],
    customerText: o.customer ?? 'hola',
    scheduledImages: o.scheduled ?? [],
    activeImageIds: (o.all ?? ALL).map((i: any) => i.id),
    final: o.final ?? false,
    raw: { action: o.action ?? (o.ids?.length ? 'reply_with_image' : 'reply'), messages, image_ids: o.ids ?? [], saved_message_codes: o.saved ?? [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, intents: [] },
  });

test('promesas de foto: se reconocen con acentos y en las formas comunes; un menú en texto no es promesa', () => {
  for (const m of ['Claro, te comparto el menú.', 'Aquí está la foto.', 'Te voy a mandar la foto de la alberca.', 'Te muestro la foto de la alberca.', 'Te mandaré las fotos en un momento.', 'Te paso una fotografía de la alberca.']) {
    const v = decide([m], { customer: '¿me mandas una foto?' });
    assert.ok(v.retryable.some((x) => /Dices que envías/.test(x)), `${m} → ${v.retryable.join(' | ')}`);
  }
  // "Te la mando" solo es promesa de foto si el cliente habla de una foto.
  assert.ok(decide(['Claro, te la mando.'], { customer: '¿me pasas la foto?' }).retryable.length);
  assert.deepEqual(decide(['Claro, te la mando por correo.'], { customer: '¿me pasas la cotización?' }).retryable, []);
  // Sin foto de menú en el catálogo, "te paso el menú: …" es texto y no se toca.
  const text = decide(['Te paso el menú: tacos y quesadillas.'], { images: [alberca], all: [alberca], final: true });
  assert.deepEqual(text.plan.messages, ['Te paso el menú: tacos y quesadillas.']);
});

test('último intento: si quitar la promesa deja la respuesta vacía, sale el mensaje de respaldo (nunca nada)', () => {
  const v = decide(['Te comparto la foto de la suite presidencial 😊'], { ids: ['suite_presidencial'], final: true });
  assert.deepEqual(v.plan.messages, [bot().rules.fallback_message]);
  assert.ok(v.fixes.some((f) => /quedó vacía/.test(f)));
});

test('la foto que nombra la promesa debe ser la que sale: otra foto automática no la cumple', () => {
  const v = decide(['¡Hola! Te comparto la foto del menú.'], { scheduled: [bienvenida] });
  assert.ok(v.retryable.some((x) => /«menu»/.test(x)), v.retryable.join(' | '));
  // La que sí sale en este turno (por palabra) se puede anunciar, aunque la IA la ponga en image_ids.
  const ok2 = decide(['Te comparto la foto de la suite.'], { ids: ['suite'], scheduled: [suite], customer: 'suite' });
  assert.deepEqual(ok2.retryable, []);
  assert.ok(!ok2.fixes.some((f) => /inexistentes/.test(f)), 'una foto automática no es "inexistente"');
});

test('al pasar con una persona no se envían fotos: la promesa se corrige', () => {
  const v = decide(['Te paso con un asesor y te envío la foto del menú.'], { ids: ['menu'], action: 'handoff' });
  assert.ok(v.retryable.some((x) => /no se envía al pasar con una persona/.test(x)), v.retryable.join(' | '));
  const last = decide(['Te paso con un asesor y te envío la foto del menú.'], { ids: ['menu'], action: 'handoff', final: true });
  assert.equal(last.plan.action, 'handoff');
  assert.deepEqual(last.plan.messages, []);
});

test('reenviar una foto: "no me llegó, ¿me la vuelves a mandar?" sí; pedir el menú no reenvía otra foto ya enviada', () => {
  const again = decide(['Claro, aquí la tienes de nuevo.'], { ids: ['alberca'], sent: ['id-alberca'], customer: 'No me llegó, ¿me la puedes volver a mandar?' });
  assert.deepEqual(again.plan.images.map((i) => i.code), ['alberca']);
  const onlyMenu = decide(['Aquí está el menú.'], { ids: ['menu', 'alberca'], sent: ['id-menu', 'id-alberca'], customer: '¿me pasas el menú?' });
  assert.deepEqual(onlyMenu.plan.images.map((i) => i.code), ['menu']);
  // Sin pedirla, una foto ya enviada no se repite, y si se anunció, la corrección lo explica.
  const repeat = decide(['Te envío otra vez la foto de la alberca.'], { ids: ['alberca'], sent: ['id-alberca'], customer: '¿y cuánto cuesta?' });
  assert.ok(repeat.retryable.some((x) => /ya se envió y el cliente no pidió/.test(x)), repeat.retryable.join(' | '));
});

test('mensajes guardados con foto: ocupan su lugar en el máximo y la misma foto en dos mensajes sale una vez', () => {
  const doble = img('doble', 'Habitación doble');
  const b = bot({
    rules: { max_images_per_reply: 1 },
    saved_messages: [
      { code: 'precios', text: 'Tarifas en la foto.', image_id: 'id-doble', active: true },
      { code: 'promo', text: '', image_id: 'id-doble', active: true },
    ],
  });
  // La IA también eligió la alberca, pero el mensaje guardado ya ocupa el único lugar: no se promete.
  const v = decide(['Te paso precios y te comparto la foto de la alberca.'], { bot: b, ids: ['alberca'], saved: ['precios'], all: [...ALL, doble] });
  assert.ok(v.retryable.some((x) => /no cabe/.test(x)), v.retryable.join(' | '));
  // El segundo mensaje con la misma foto (y sin texto) no se envía.
  const dup = decide(['Claro.'], { bot: b, saved: ['precios', 'promo'], all: [...ALL, doble] });
  assert.deepEqual(dup.plan.savedCodes, ['precios']);
});

test('prompt: cada foto aparece una vez y con instrucciones que no se contradicen', () => {
  const mapa = img('mapa', 'Mapa', { mode: 'both', on_booking: true, context: 'Cuando pregunten cómo llegar' }, { usage_rule: 'Cuando pidan la ubicación' });
  const ctxOnly = img('comparar', 'Comparativa', { mode: 'rules', context: 'Cuando quiera comparar habitaciones' });
  const b = bot({ personality: { prompt: 'Si piden la ubicación, envía la foto mapa.' }, saved_messages: [{ code: 'precios', text: 'Tarifas', image_id: 'id-alberca', active: true }] });
  const { prompt } = buildSystemPrompt({
    bot: b, knowledge: [], images: [menu, alberca, mapa], contact: { data: {}, name: '', phone: '', notes: [] } as any, conversation: { flow_step: 0, summary: '' } as any,
    history: [], pending: [], sentImageIds: [], imagesById: new Map([menu, alberca, mapa, suite].map((i) => [i.id, i])),
    autoImages: [{ image: suite, when: 'el cliente escribe "suite"' }, { image: mapa, when: 'al agendar una cita' }], contextImages: [mapa, ctxOnly], imagesNow: [],
  } as any, []);
  const catalog = prompt.slice(prompt.indexOf('# Catálogo de imágenes'), prompt.indexOf('# Mensajes guardados'));
  assert.match(catalog, /solo en sus momentos \(NO las pongas en image_ids\):\n- `suite` \| Suite: el cliente escribe "suite"/);
  assert.match(catalog, /Si las instrucciones del negocio piden enviar una de estas fotos, no la pongas en image_ids/);
  // "Ambos": solo en el catálogo de la IA, con su condición de contexto y sus momentos automáticos.
  assert.match(catalog, /- ID: `mapa` \| Mapa \| enviar cuando: Cuando pidan la ubicación \| también cuando: Cuando pregunten cómo llegar \| además el sistema la envía sola al agendar una cita/);
  assert.equal(catalog.split('`mapa`').length - 1, 1, 'mapa aparece una sola vez');
  assert.match(catalog, /ID de contexto: `comparar`/);
  assert.match(catalog, /Máximo 2 por turno, contando las fotos de los mensajes guardados/);
  assert.match(catalog, /Al pasar con una persona no se envían fotos/);
  // Con máximo 0 las fotos de mensajes guardados no se ofrecen.
  const zero = buildSystemPrompt({
    bot: bot({ rules: { max_images_per_reply: 0 }, saved_messages: [{ code: 'precios', text: 'Tarifas', image_id: 'id-alberca', active: true }] }), knowledge: [], images: [], contact: { data: {}, name: '', phone: '', notes: [] } as any,
    conversation: { flow_step: 0, summary: '' } as any, history: [], pending: [], sentImageIds: [], imagesById: new Map([[alberca.id, alberca]]),
  } as any, []).prompt;
  assert.match(zero, /No hay imágenes disponibles/);
  assert.match(zero, /`precios`[^\n]*solo texto/);
});

test('palabra clave: mencionarla al agradecer no reenvía la foto; pedirla de nuevo sí', () => {
  assert.equal(asksAgain('Perfecto, gracias, me quedo con la doble 👍'), false);
  assert.equal(asksAgain('menú'), true);
  assert.equal(asksAgain('¿me pasas otra vez el menú?'), true);
  const doble = img('doble', 'Doble', { mode: 'rules', keywords: ['doble'] });
  assert.deepEqual(imagesBeforeReply([doble], { text: 'gracias, me quedo con la doble', firstReply: false, sentIds: ['id-doble'] }), []);
  assert.equal(imagesBeforeReply([doble], { text: '¿me mandas otra vez la doble?', firstReply: false, sentIds: ['id-doble'] }).length, 1);
  assert.equal(imagesBeforeReply([doble], { text: 'me quedo con la doble', firstReply: false, sentIds: [] }).length, 1, 'la primera vez sí sale');
});

test('avisos de fotos: momento faltante, foto desactivada o solo automática en las instrucciones, e ID inexistente', () => {
  const b = bot({ personality: { prompt: 'Cuando pregunten por la suite, envía la foto suite. Si piden el menú manda la foto `menu_viejo`. Envía la foto menu cuando pidan precios.' } });
  const fachada = img('fachada', 'Fachada', { mode: 'rules' });
  const off = img('menu', 'Menú', {}, { active: false });
  const w = photoWarnings(b, [suite, fachada, off]);
  assert.ok(w.some((x) => /«fachada».*sin ningún momento/.test(x)), w.join(' | '));
  assert.ok(w.some((x) => /«suite».*Solo en los momentos/.test(x)), w.join(' | '));
  assert.ok(w.some((x) => /«menu», pero está desactivada/.test(x)), w.join(' | '));
  assert.ok(w.some((x) => /«menu_viejo», que no existe/.test(x)), w.join(' | '));
  assert.deepEqual(photoWarnings(bot({ personality: { prompt: 'Envía la foto alberca cuando pregunten.' } }), [alberca]), []);
});

test('Instagram: un texto de más de 1000 bytes se divide; un pie de foto que falla no hace fallar la foto', async () => {
  const long = 'Habitación con vista al mar ☀️ '.repeat(40);
  const parts = splitByBytes(long, 1000);
  assert.ok(parts.length > 1 && parts.every((p) => Buffer.byteLength(p) <= 1000));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim().replace(/\s+/g, ' '));

  const realFetch = globalThis.fetch;
  const prevBase = config.publicBaseUrl;
  config.publicBaseUrl = 'https://bot.test';
  const calls: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body.message);
    // Meta rechaza el texto (p. ej. límite de envíos), pero la foto ya se entregó.
    if (body.message?.text) return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 400 });
    return new Response(JSON.stringify({ message_id: 'mid.foto' }), { status: 200 });
  }) as any;
  try {
    const channel = { id: 'c', type: 'messenger', config: { page_access_token: 'tok' } } as any;
    const tr = messengerAdapter.transport(channel, { external_id: 'psid' } as any);
    assert.equal(await tr.sendImage(img('suite', 'Suite'), 'Suite con vista al mar', 0), 'mid.foto');
    assert.ok(calls[0].attachment && calls[1].text, 'primero la foto, después su texto');
    calls.length = 0;
    globalThis.fetch = (async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body).message);
      return new Response(JSON.stringify({ message_id: `mid.${calls.length}` }), { status: 200 });
    }) as any;
    const ig = instagramAdapter.transport({ ...channel, type: 'instagram' }, { external_id: 'igsid' } as any);
    assert.equal(await ig.sendText(long, 0), 'mid.1');
    assert.equal(calls.length, parts.length);
  } finally {
    globalThis.fetch = realFetch;
    config.publicBaseUrl = prevBase;
  }
});

/* ------------------------------ De extremo a extremo (servidor y base de datos) ------------------------------ */

let h: Awaited<ReturnType<typeof createHarness>>;
const IDS: Record<string, string> = {};
const PRICES = 'Tarifas: habitación doble $1,650 MXN por noche, desayuno incluido.';
const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(400);
  await h.idle();
};
const to = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => (s.kind === 'image' ? `[FOTO ${s.image}]` : s.text));
const photos = (phone: string) => h.sent.filter((s) => s.to === phone && s.kind === 'image').map((s) => s.image);
const convOf = async (phone: string) => (await pool.query(`SELECT c.* FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.phone = $1`, [phone])).rows[0];
const setRules = (rules: Record<string, unknown>) => h.authed('PUT', `/api/chatbots/${h.botId}`, { rules });

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ flow: { goal: 'Que el cliente reserve', steps: [{ title: 'Saludo' }, { title: 'Fechas' }, { title: 'Cierre' }] } });
  const up = async (code: string, name: string, sw: Record<string, unknown>, extra: Record<string, string> = {}) => { IDS[code] = (await h.uploadImage(code, name, sw, extra)).id; };
  await up('suite', 'Suite', {}, { usage_rule: 'Cuando pregunten por la suite' });
  await up('doble', 'Habitación doble', { mode: 'rules', keywords: ['doble'] });
  await up('gracias', 'Gracias por reservar', { mode: 'rules', on_goal: true });
  await up('mapa', 'Mapa', { mode: 'rules', flow_steps: [3] });
  await up('menu', 'Menú', { mode: 'rules', keywords: ['menú'] });
  await up('bienvenida', 'Bienvenida', { mode: 'rules', first_message: true }, { active: 'false' });
  const r = await h.authed('PUT', `/api/chatbots/${h.botId}`, {
    saved_messages: [
      { code: 'precios', title: 'Precios', text: PRICES, image_id: IDS.doble, when: 'Cuando pregunten precios' },
      { code: 'promo', title: 'Promo', text: 'Promoción: 10% en tres noches en habitación doble.', image_id: IDS.doble, when: 'Cuando pregunten promociones' },
      { code: 'horario', title: 'Horario', text: 'Recepción abierta de 9:00 a 18:00 h.', when: 'Cuando pregunten el horario' },
    ],
  });
  assert.equal(r.statusCode, 200, r.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});
afterEach(async () => {
  if (!ok) return;
  await setRules({ max_images_per_reply: 2, activation: { off_on_goal: false, off_keywords: [], off_action: 'pause', off_message: '', mode: 'always', on_keywords: [] } });
});

t('la foto que eligió la IA (y anunció) sale en la respuesta; la automática que no cabe llega enseguida', async () => {
  await h.authed('PUT', `/api/images/${IDS.bienvenida}`, { active: true });
  await setRules({ max_images_per_reply: 1 });
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['¡Hola! Te comparto una foto de la suite.'], image_ids: ['suite'] }));
  const phone = '5215560000001';
  await say('Hola, ¿cómo es la suite?', phone);
  assert.deepEqual(to(phone), ['¡Hola! Te comparto una foto de la suite.', '[FOTO suite]']);
  await h.fastForward();
  assert.deepEqual(photos(phone), ['suite', 'bienvenida']);
  await h.authed('PUT', `/api/images/${IDS.bienvenida}`, { active: false });
});

t('una foto que no cabe porque la ocupa un mensaje guardado no se promete', async () => {
  await setRules({ max_images_per_reply: 1 });
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Te paso los precios y aquí te va la foto de la suite.'], image_ids: ['suite'], saved_message_codes: ['precios'] }));
  const phone = '5215560000002';
  await say('¿Qué precios tienen? ¿y cómo es la suite?', phone);
  assert.equal(h.calls.length, 2, 'se pidió otra respuesta');
  assert.deepEqual(to(phone), ['[FOTO doble]']);
  assert.equal(h.sent.find((s) => s.to === phone)!.text, PRICES);
});

t('respuesta de respaldo o cita que no se pudo agendar: no salen fotos de objetivo ni de etapa, y el objetivo no se marca', async () => {
  // Dato no verificable dos veces: sale el mensaje de respaldo, sin la foto de "gracias por reservar".
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['¡Listo! Tu reserva queda confirmada por $9,999 la noche.'], goal_completed: true, flow_step: 3 }));
  const phone = '5215560000003';
  await say('Va, la quiero reservar', phone);
  assert.deepEqual(photos(phone), []);
  let c = await convOf(phone);
  assert.equal(c.goal_completed_at, null);
  assert.equal(c.flow_step, 0);

  // El horario se ocupa mientras la IA piensa.
  const s = await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Visita guiada', kind: 'appointment', duration_minutes: 60, min_notice_minutes: 0, max_days_ahead: 5, location: 'Recepción' });
  assert.equal(s.statusCode, 200, s.body);
  const serviceId = s.json().id;
  await setRules({ booking_enabled: true });
  h.reset();
  h.setScript(async (req: any) => {
    const prompt = req.messages[0].content as string;
    const slot = [...prompt.matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)].at(-1)![1];
    const taken = await h.authed('POST', '/api/appointments', { service_id: serviceId, slot, customer_name: 'Otro cliente' });
    assert.equal(taken.statusCode, 200, taken.body);
    return { action: 'reply', messages: ['¡Listo! Quedó agendada tu visita.'], booking: { action: 'book', service_id: serviceId, slot, appointment_id: '' }, goal_completed: true, flow_step: 3 };
  });
  const phone2 = '5215560000004';
  await say('Quiero agendar la visita guiada en el último horario', phone2);
  assert.match(to(phone2)[0], /se acaba de ocupar/);
  assert.deepEqual(photos(phone2), []);
  c = await convOf(phone2);
  assert.equal(c.goal_completed_at, null);
  assert.equal(c.flow_step, 0);
});

t('si una persona toma la conversación mientras se envía la respuesta, el asistente no se despide ni manda fotos pendientes', async () => {
  await setRules({ max_images_per_reply: 1, activation: { off_on_goal: true, off_action: 'close', off_message: 'Gracias, hasta pronto.' } });
  const phone = '5215560000005';
  const ext = (h.service.engine as any).ext;
  const orig = ext.onOutbound;
  let done = false;
  ext.onOutbound = async (conv: any, msg: any) => {
    await orig(conv, msg);
    if (!done && msg.sender === 'bot' && msg.type === 'text' && msg.content.startsWith('Perfecto')) {
      done = true;
      assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/takeover`)).statusCode, 200);
      assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/send`, { text: 'Hola, soy Laura, yo te atiendo.' })).statusCode, 200);
    }
  };
  try {
    h.reset();
    h.setScript(() => ({ action: 'reply', messages: ['Perfecto, quedó registrada tu solicitud.', 'En breve te confirmamos los detalles.'], goal_completed: true, flow_step: 3 }));
    await say('Sí, resérvame del 3 al 5 de mayo', phone);
    await h.fastForward();
    assert.ok(!to(phone).includes('Gracias, hasta pronto.'), JSON.stringify(to(phone)));
    assert.deepEqual(photos(phone), [], 'las fotos de objetivo/etapa no salen después del mensaje de la persona');
    assert.equal((await convOf(phone)).status, 'human', 'no se cierra una conversación que tomó una persona');
  } finally {
    ext.onOutbound = orig;
  }
});

t('último intento sin nada que enviar: el cliente recibe el mensaje de respaldo y no un silencio', async () => {
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Te comparto la foto de la suite presidencial 😊'], image_ids: ['suite_presidencial'] }));
  const phone = '5215560000006';
  await say('¿Cómo es la suite presidencial?', phone);
  assert.equal(h.calls.length, 2);
  const out = to(phone);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0], /foto/);
});

t('un envío programado con etapa cuenta su foto como enviada: la IA no la repite', async () => {
  const phone = '5215560000007';
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['¡Hola! ¿En qué te ayudo?'] }));
  await say('Hola', phone);
  const c = await convOf(phone);
  const r = await h.service.outbound.send(c.id, { text: 'Conoce nuestra suite con vista al mar', imageId: IDS.suite, source: 'automation', flowStep: 2 });
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.ok((await store.sentImageIds(c.id)).includes(IDS.suite));
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Así es la suite.'], image_ids: ['suite'] }));
  await say('Se ve bien, ¿cuánto cuesta?', phone);
  assert.match(String(h.calls[0].messages[0].content), /Imágenes ya enviadas[^\n]*suite/);
  assert.deepEqual(photos(phone), []);
});

t('fotos rechazadas por la plataforma: la que eligió la IA y la de un mensaje guardado se reintentan', async () => {
  h.reset();
  h.setScript(() => ({ action: 'reply_with_image', messages: ['¡Claro! Te mando la foto de la suite 👇'], image_ids: ['suite'] }));
  h.failNext.image = 1;
  const phone = '5215560000008';
  await say('¿Cómo es la suite?', phone);
  assert.deepEqual(photos(phone), []);
  await h.fastForward();
  assert.deepEqual(photos(phone), ['suite']);

  // La foto de "precios" también la pide la regla de la palabra "doble": si se rechaza, se reintenta.
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['Claro, te paso las tarifas.'], saved_message_codes: ['precios'] }));
  h.failNext.image = 1;
  const phone2 = '5215560000009';
  await say('¿Cuánto cuesta la doble?', phone2);
  await h.fastForward();
  assert.deepEqual(photos(phone2), ['doble']);
});

t('reenvío por palabra: si no cabe o se rechaza, llega después; mencionarla al agradecer no la repite', async () => {
  const phone = '5215560000010';
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['Claro.'] }));
  await say('¿me pasas el menú?', phone);
  assert.deepEqual(photos(phone), ['menu']);
  h.setScript(() => ({ action: 'no_reply', messages: [] }));
  await say('Perfecto, gracias por el menú 👍', phone);
  assert.deepEqual(photos(phone), ['menu'], 'no se reenvía sola');
  // La vuelve a pedir y la plataforma la rechaza: se reintenta aunque ya se hubiera enviado antes.
  h.setScript(() => ({ action: 'reply', messages: ['Va de nuevo.'] }));
  h.failNext.image = 1;
  await say('no me llegó, mándame otra vez el menú', phone);
  await h.fastForward();
  assert.deepEqual(photos(phone), ['menu', 'menu']);
});

t('dos mensajes guardados con la misma foto: la foto sale una vez', async () => {
  const phone = '5215560000011';
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['Claro.'], saved_message_codes: ['precios', 'promo'] }));
  await say('¿Precios y promociones?', phone);
  assert.deepEqual(photos(phone), ['doble']);
  assert.ok(to(phone).includes('Promoción: 10% en tres noches en habitación doble.'));
});

t('máximo de fotos en 0: no sale ninguna foto, ni automática ni después', async () => {
  await setRules({ max_images_per_reply: 0 });
  const phone = '5215560000012';
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['Claro, aquí tienes la información.'] }));
  await say('¿me pasas el menú?', phone);
  await h.fastForward();
  assert.deepEqual(photos(phone), []);
  assert.match(String(h.calls[0].messages[0].content), /No hay imágenes disponibles/);
});

t('una foto pendiente no sale si el cliente pausó al asistente', async () => {
  await setRules({ activation: { off_keywords: ['silencio'], off_action: 'pause', off_message: 'Entendido.' } });
  const phone = '5215560000013';
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['Es una habitación con dos camas.'] }));
  h.failNext.image = 1;
  await say('¿Cómo es la doble?', phone);
  await say('silencio', phone);
  await h.fastForward();
  assert.deepEqual(photos(phone), []);
});

t('bienvenida con palabras de activación: sale con la primera respuesta del asistente', async () => {
  await h.authed('PUT', `/api/images/${IDS.bienvenida}`, { active: true });
  await setRules({ activation: { mode: 'keywords', on_keywords: ['info'] } });
  const phone = '5215560000014';
  h.reset();
  h.setScript(() => ({ action: 'reply', messages: ['¡Hola! Bienvenido.'] }));
  await say('buenas tardes', phone);
  assert.deepEqual(to(phone), []);
  await say('info', phone);
  assert.deepEqual(photos(phone), ['bienvenida']);
  await h.authed('PUT', `/api/images/${IDS.bienvenida}`, { active: false });
});

t('panel: avisos de fotos, aviso al cambiar un ID que piden las instrucciones y etapas que siguen a sus fotos', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { personality: { prompt: 'Cuando pregunten por la suite, envía la foto suite. Para precios envía la foto doble.' } });
  const detail = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  assert.ok(detail.photo_warnings.some((w: string) => /«doble».*Solo en los momentos/.test(w)), detail.photo_warnings.join(' | '));
  assert.ok(!detail.photo_warnings.some((w: string) => /«suite»/.test(w)), 'la suite está en "La IA decide"');
  const renamed = await h.authed('PUT', `/api/images/${IDS.suite}`, { code: 'suite_deluxe' });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.match(renamed.json().warning, /todavía mencionan «suite»/);
  await h.authed('PUT', `/api/images/${IDS.suite}`, { code: 'suite' });

  // Se quita la etapa 1: la foto de la etapa 3 pasa a la 2 y el mensaje guardado de la etapa 2 pasa a la 1.
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { saved_messages: [{ code: 'horario', text: 'Recepción abierta de 9:00 a 18:00 h.', flow_step: 2 }] });
  const r = await h.authed('PUT', `/api/chatbots/${h.botId}`, { flow: { goal: 'Que el cliente reserve', steps: [{ title: 'Fechas' }, { title: 'Cierre' }] }, flow_step_map: [0, 1, 2] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(((await store.getImage(IDS.mapa))!.send_when as any).flow_steps, [2]);
  assert.equal(r.json().saved_messages[0].flow_step, 1);
});

t('borrar una foto usada en una regla automática la quita de la regla (que se puede seguir guardando y desactivando)', async () => {
  const promo = (await h.uploadImage('promo', 'Promo', {})).id;
  const rule = await h.authed('POST', '/api/automations', {
    account_id: h.accountId, name: 'Palabra → promo', active: true,
    trigger: { type: 'message_received', match: 'keywords', keywords: ['promo'] }, actions: [{ type: 'send_message', text: 'Mira la promo', image_id: promo }],
  });
  assert.equal(rule.statusCode, 200, rule.body);
  const del = await h.authed('DELETE', `/api/images/${promo}`);
  assert.match(del.json().warning, /regla «Palabra → promo»/);
  const off = await h.authed('PUT', `/api/automations/${rule.json().id}`, { active: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().actions[0].image_id, '');
});
