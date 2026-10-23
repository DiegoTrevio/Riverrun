/**
 * El asistente cotiza: la IA elige conceptos y cantidades, el sistema calcula, genera el PDF y lo envía con un mensaje
 * que dice si es APROXIMADA o FINAL. Las finales esperan la aprobación del equipo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';
const qstore = await import('../src/store/quotes.js');
const { signedQuoteUrl } = await import('../src/channels/media.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let phoneN = 0;
const nextPhone = () => `52155000${String(++phoneN).padStart(5, '0')}`;
const item = (code: string, name: string, o: Partial<qstore.PriceItemInput>) => qstore.createPriceItem(h.accountId, {
  code, name, description: '', unit: 'servicio', price_mode: 'exact', price_min: null, price_max: null, iva_mode: 'plus', active: true, sort: 0, ...o,
});
const prepare = (items: { item_code: string; qty: number; qty_quote?: string }[], wants_final = false) =>
  ({ action: 'prepare', items: items.map((i) => ({ qty_quote: '', ...i })), notes: '', wants_final });
const quotesOf = async (phone: string) => qstore.listQuotes(h.accountId, { conversationId: (await h.conversationFor(phone)).id });
const textsTo = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text).join('\n');
const say = async (text: string, phone: string) => {
  await h.webhook(text, { phone });
  await waitFor(async () => !!(await h.conversationFor(phone).catch(() => null)));
  await h.idle();
};
const setQuotes = async (patch: Record<string, unknown>) =>
  pool.query(`UPDATE chatbots SET ai = jsonb_set(ai, '{quotes}', (ai->'quotes') || $2::jsonb) WHERE id = $1`, [h.botId, JSON.stringify(patch)]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({
    data_fields: [{ key: 'fecha_evento', label: 'Fecha del evento', type: 'date' }],
    ai: { debounce_seconds: 0.1, quotes: { enabled: true, allow_final: true, required_fields: [], template_id: '' } },
  });
  // Alguien del equipo a quien avisar de las cotizaciones finales por aprobar.
  await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Dueña', email: 'duena@cotiza.test', password: 'clave-duena-1', role: 'admin' });
  await item('SALON', 'Renta de salón', { unit: 'evento', price_min: 1500000 });
  await item('PERSONA', 'Banquete por persona', { unit: 'persona', price_min: 25000 });
  await item('DECO', 'Decoración', { price_mode: 'range', price_min: 300000, price_max: 500000 });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('aproximada: el sistema calcula, envía el mensaje con el total y el PDF, y la deja como enviada', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['¡Claro! Te comparto la cotización con decoración.'], quote: prepare([{ item_code: 'salon', qty: 1 }, { item_code: 'PERSONA', qty: 80, qty_quote: '80 personas' }, { item_code: 'DECO', qty: 1 }]) }));
  await say('Hola, quiero cotizar el salón para 80 personas con decoración', phone);
  const sent = h.sent.filter((s) => s.to === phone);
  assert.deepEqual(sent.map((s) => s.kind), ['text', 'text', 'file'], JSON.stringify(sent));
  // 15,000 + 80 × 250 + (3,000 a 5,000) = 38,000 a 40,000, más IVA.
  assert.match(sent[1].text, /cotización APROXIMADA \(folio COT-0001\): total estimado \$44,080\.00 a \$46,400\.00 con IVA/);
  assert.match(sent[1].text, /el precio final puede cambiar/);
  assert.equal(sent[2].file, 'Cotizacion-COT-0001.pdf');
  assert.equal(sent[2].mime, 'application/pdf');
  const [q] = await quotesOf(phone);
  assert.equal(q.status, 'sent');
  assert.equal(q.kind, 'approximate');
  assert.equal(q.source, 'bot');
  const pdf = await h.app.inject({ method: 'GET', url: `/api/quotes/${q.id}/file`, headers: { cookie: h.cookie } });
  assert.match(pdf.body, /COTIZACIÓN APROXIMADA/);
  assert.match(pdf.body, /Banquete por persona/);
});

t('final con precios exactos: queda para aprobación, el cliente lo sabe y el equipo recibe el aviso', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Con gusto preparo tu cotización formal.'], quote: prepare([{ item_code: 'SALON', qty: 1 }], true) }));
  await say('Necesito la cotización final del salón para facturar', phone);
  const sent = h.sent.filter((s) => s.to === phone);
  assert.deepEqual(sent.map((s) => s.kind), ['text', 'text']);
  assert.match(sent[1].text, /cotización final la está revisando el equipo/);
  const [q] = await quotesOf(phone);
  assert.equal(q.kind, 'final');
  assert.equal(q.status, 'pending_approval');
  assert.equal(q.pdf_path, null, 'no se genera ni se envía hasta aprobarla');
  const n = await pool.query(`SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'duena@cotiza.test' AND n.title LIKE '%por aprobar%'`);
  assert.ok(n.rows.length >= 1);

  // Mientras está en revisión, no se prepara otra para la misma solicitud.
  h.reset();
  h.setScript(() => ({ messages: ['Te comparto otra cotización.'], quote: prepare([{ item_code: 'SALON', qty: 1 }]) }));
  await say('¿Me mandas la cotización otra vez?', phone);
  assert.equal((await quotesOf(phone)).length, 1);
  assert.match(textsTo(phone), /en revisión con el equipo/);
});

t('final con un precio aproximado: sale aproximada (y la IA no puede llamarla final)', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Te envío la cotización final.'], quote: prepare([{ item_code: 'DECO', qty: 1 }], true) }));
  await say('Quiero la cotización final de la decoración', phone);
  const [q] = await quotesOf(phone);
  assert.equal(q.kind, 'approximate');
  assert.doesNotMatch(textsTo(phone), /envío la cotización final/);
  assert.match(textsTo(phone), /cotización APROXIMADA/);
});

t('la IA no inventa: cantidad que el cliente no dio, concepto inexistente o total calculado por ella', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Te comparto la cotización.'], quote: prepare([{ item_code: 'PERSONA', qty: 120, qty_quote: '120 personas' }]) }));
  await say('Quiero cotizar el banquete para 80 personas', phone);
  assert.equal((await quotesOf(phone)).length, 0, 'el cliente dijo 80, no 120');
  assert.match(textsTo(phone), /me confirmas qué necesitas y en qué cantidad/);

  const other = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Listo.'], quote: prepare([{ item_code: 'MESA_VIP', qty: 1 }]) }));
  await say('Cotízame la mesa vip', other);
  assert.equal((await quotesOf(other)).length, 0);

  // Un total que escribió la IA no está en la información del negocio: se rechaza y se pide otra respuesta.
  const third = nextPhone();
  h.reset();
  let n = 0;
  h.setScript(() => (++n === 1
    ? { messages: ['El total es de $17,400 con IVA.'], quote: prepare([{ item_code: 'SALON', qty: 1 }]) }
    : { messages: ['Te comparto la cotización.'], quote: prepare([{ item_code: 'SALON', qty: 1 }]) }));
  await say('Cotízame el salón', third);
  const texts = h.sent.filter((s) => s.to === third).map((s) => s.text);
  assert.ok(!texts.includes('El total es de $17,400 con IVA.'), JSON.stringify(texts));
  assert.match(texts.join(' '), /cotización APROXIMADA \(folio COT-\d+\): total \$17,400\.00 con IVA/);
});

t('datos que pide antes de cotizar: sin ellos no hay cotización y se le piden', async () => {
  await setQuotes({ required_fields: ['fecha_evento'] });
  try {
    const phone = nextPhone();
    h.reset();
    h.setScript(() => ({ messages: ['Te comparto la cotización.'], quote: prepare([{ item_code: 'SALON', qty: 1 }]) }));
    await say('Quiero cotizar el salón', phone);
    assert.equal((await quotesOf(phone)).length, 0);
    assert.match(textsTo(phone), /necesito: Fecha del evento/);
    assert.match(h.calls.at(-1)!.messages[0].content as string, /Antes de cotizar necesitas: Fecha del evento \(faltan: Fecha del evento\)/);
  } finally {
    await setQuotes({ required_fields: [] });
  }
});

t('chat web (sin archivos): el cliente recibe un enlace firmado al PDF; alterado o de otra cotización no abre', async () => {
  const web = (await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'webchat', name: 'Web', chatbot_id: h.botId, config: {} })).json();
  const base = `/webchat/${web.webhook_token}`;
  const { session } = (await h.app.inject({ method: 'POST', url: `${base}/session` })).json();
  h.reset();
  h.setScript(() => ({ messages: ['Te comparto la cotización.'], quote: prepare([{ item_code: 'SALON', qty: 1 }]) }));
  await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'Cotízame el salón por favor' } });
  let msgs: any[] = [];
  await waitFor(async () => {
    msgs = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}` })).json().messages;
    return msgs.length >= 3;
  });
  await h.idle();
  const link = msgs.map((m) => m.text).join('\n').match(/https:\/\/bot\.test(\/q\/[^\s]+)/);
  assert.ok(link, JSON.stringify(msgs));
  const pdf = await h.app.inject({ method: 'GET', url: link[1] });
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.body, /COTIZACIÓN APROXIMADA/);
  assert.equal((await h.app.inject({ method: 'GET', url: link[1].replace(/s=[^&]+/, 's=abc') })).statusCode, 403);
  // Una cotización que no se ha enviado no se abre aunque la firma sea válida.
  const draft = await qstore.createQuote({ accountId: h.accountId, kind: 'final', status: 'pending_approval', source: 'panel', today: '2026-10-20', lines: [{ name: 'X', qty: 1, price_mode: 'exact', price_min: 1, price_max: null, iva_mode: 'plus' }] });
  const url = new URL(signedQuoteUrl(draft.id));
  assert.equal((await h.app.inject({ method: 'GET', url: url.pathname + url.search })).statusCode, 404);
});

t('Messenger e Instagram descargan el PDF de su enlace mientras se envía (antes respondía 404)', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Hola'] }));
  await say('Hola', phone);
  const conv = (await pool.query('SELECT * FROM conversations WHERE id = $1', [(await h.conversationFor(phone)).id])).rows[0];
  const contact = (await pool.query('SELECT * FROM contacts WHERE id = $1', [conv.contact_id])).rows[0];
  const bot = (await store.getChatbot(h.botId))!;
  const catalog = (await h.service.quotes.contextFor(conv, bot))!;
  const planned = { lines: [{ itemId: catalog.items.find((i) => i.code === 'SALON')!.id, code: 'SALON', qty: 1 }], notes: '', final: false };
  const ready = await h.service.quotes.prepare({ bot, conv, contact, planned, catalog, operation: 'op-meta-1' });
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') return;
  assert.equal(ready.quote.status, 'draft', 'todavía no se marca como enviada');
  const url = new URL(ready.file.url!);
  const pdf = await h.app.inject({ method: 'GET', url: url.pathname + url.search });
  assert.equal(pdf.statusCode, 200, 'la plataforma puede descargarla para enviarla');
  assert.equal(pdf.headers['content-type'], 'application/pdf');
});

t('reinicio a media respuesta: la misma operación reutiliza la cotización en vez de duplicarla', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Hola'] }));
  await say('Hola', phone);
  const conv = (await pool.query('SELECT * FROM conversations WHERE id = $1', [(await h.conversationFor(phone)).id])).rows[0];
  const contact = (await pool.query('SELECT * FROM contacts WHERE id = $1', [conv.contact_id])).rows[0];
  const bot = (await store.getChatbot(h.botId))!;
  const catalog = (await h.service.quotes.contextFor(conv, bot))!;
  const planned = { lines: [{ itemId: catalog.items.find((i) => i.code === 'SALON')!.id, code: 'SALON', qty: 1 }], notes: '', final: false };
  const a = await h.service.quotes.prepare({ bot, conv, contact, planned, catalog, operation: 'op-prueba-1' });
  const b = await h.service.quotes.prepare({ bot, conv, contact, planned, catalog, operation: 'op-prueba-1' });
  assert.equal(a.status, 'ready');
  assert.equal(b.status, 'ready');
  assert.equal((a as any).quote.id, (b as any).quote.id);
  assert.equal((await quotesOf(phone)).length, 1);
});

t('apagado: el asistente no cotiza y la IA no ve la sección de cotizaciones', async () => {
  await setQuotes({ enabled: false });
  try {
    const phone = nextPhone();
    h.reset();
    h.setScript(() => ({ messages: ['Con gusto te ayudo.'], quote: prepare([{ item_code: 'SALON', qty: 1 }]) }));
    await say('¿Me cotizas el salón?', phone);
    assert.equal((await quotesOf(phone)).length, 0);
    assert.doesNotMatch(h.calls.at(-1)!.messages[0].content as string, /## Cotizaciones/);
  } finally {
    await setQuotes({ enabled: true });
  }
});
