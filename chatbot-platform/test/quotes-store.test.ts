/** Cotizaciones en la base de datos: folios sin repetirse, precios guardados al cotizar, estados y una abierta por solicitud. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';
const store = await import('../src/store/quotes.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const TODAY = '2026-10-20';
const item = (o: Partial<store.PriceItemInput> = {}): store.PriceItemInput => ({
  code: 'RENTA', name: 'Renta de salón', description: '', unit: 'evento', price_mode: 'exact', price_min: 1500000, price_max: null,
  iva_mode: 'plus', active: true, sort: 0, ...o,
});
const RENTA = { name: 'Renta', qty: 1, price_mode: 'exact' as const, price_min: 100000, price_max: null, iva_mode: 'plus' as const };
const otherAccount = async (): Promise<string> => (await pool.query(`INSERT INTO accounts (name) VALUES ('Otra cuenta') RETURNING id`)).rows[0].id;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({});
  h.setScript(() => ({ messages: ['Hola, ¿qué evento planeas?'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('lista de precios: alta, cambios, clave única y modos coherentes', async () => {
  const a = await store.createPriceItem(h.accountId, item());
  assert.equal(a.price_min, 1500000);
  await assert.rejects(store.createPriceItem(h.accountId, item()), /Ya hay un concepto con esa clave/);
  await assert.rejects(store.createPriceItem(h.accountId, item({ code: 'X', price_mode: 'range', price_max: 10 })), /mínimo debe ser menor/);
  await assert.rejects(store.createPriceItem(h.accountId, item({ code: 'con espacio' })), /clave/);
  const b = await store.updatePriceItem(h.accountId, a.id, item({ price_mode: 'from', price_min: 1200000 }));
  assert.equal(b?.price_mode, 'from');
  const other = await otherAccount();
  assert.equal(await store.updatePriceItem(other, a.id, item()), null, 'otra cuenta no puede cambiarlo');
  assert.equal(await store.deletePriceItem(other, a.id), false);
  assert.equal((await store.listPriceItems(other)).length, 0);
  assert.equal((await store.listPriceItems(h.accountId)).length, 1);
});

t('ajustes: valores iniciales y validación', async () => {
  const s = await store.getQuoteSettings(h.accountId);
  assert.equal(s.iva_rate, 0.16);
  assert.equal(s.validity_days, 15);
  await assert.rejects(store.updateQuoteSettings(h.accountId, { iva_rate: 1.5 }), /IVA/);
  await assert.rejects(store.updateQuoteSettings(h.accountId, { currency: 'pesos' }), /moneda/);
  const u = await store.updateQuoteSettings(h.accountId, { validity_days: 30, folio_prefix: 'SAL-' });
  assert.equal(u.validity_days, 30);
});

t('cotización: folio consecutivo aun creando varias a la vez, vigencia y precios guardados', async () => {
  const made = await Promise.all(Array.from({ length: 6 }, () =>
    store.createQuote({ accountId: h.accountId, kind: 'approximate', status: 'sent', source: 'panel', lines: [RENTA], today: TODAY })));
  assert.deepEqual(made.map((q) => q.folio).sort(), ['SAL-0001', 'SAL-0002', 'SAL-0003', 'SAL-0004', 'SAL-0005', 'SAL-0006']);
  const q = made[0];
  assert.equal(q.valid_until, '2026-11-19');
  assert.equal(q.total_min, 116000);
  assert.equal(q.lines?.[0].amount_min, 100000);
  assert.equal((await store.getQuote(h.accountId, q.id))?.lines?.length, 1);
  assert.equal(await store.getQuote(await otherAccount(), q.id), null);
  assert.equal((await store.listQuotes(h.accountId, { search: 'SAL-0003' })).length, 1);
});

t('cotización final: necesita precios exactos', async () => {
  await assert.rejects(store.createQuote({
    accountId: h.accountId, kind: 'final', status: 'pending_approval', source: 'bot', today: TODAY,
    lines: [{ ...RENTA, name: 'Decoración', price_mode: 'range', price_min: 100, price_max: 200 }],
  }), /precio exacto/);
});

t('estados: aprobar una sola vez, editar recalcula y una abierta por solicitud', async () => {
  await h.webhook('Hola, quiero cotizar un evento');
  await h.idle();
  const conv = await h.conversationFor();
  const reqId = Number((await pool.query(
    `SELECT id FROM conversation_requests WHERE conversation_id = $1 ORDER BY number DESC LIMIT 1`, [conv.id])).rows[0]?.id
    ?? (await pool.query(`INSERT INTO conversation_requests (conversation_id, number) VALUES ($1, 1) RETURNING id`, [conv.id])).rows[0].id);
  const base = { accountId: h.accountId, source: 'bot' as const, today: TODAY, requestId: reqId, conversationId: conv.id, lines: [RENTA] };
  const q = await store.createQuote({ ...base, kind: 'final', status: 'pending_approval' });
  await assert.rejects(store.createQuote({ ...base, kind: 'approximate', status: 'draft' }), /quotes_open_request_uq/);
  assert.equal((await store.openQuoteForRequest(h.accountId, reqId))?.id, q.id);

  const edited = await store.replaceQuoteLines(h.accountId, q.id, [{ ...RENTA, qty: 2 }], { notes: 'Incluye montaje' });
  assert.equal(edited?.total_min, 232000);
  assert.equal(edited?.lines?.[0].edited_by_team, true);
  assert.equal(edited?.notes, 'Incluye montaje');

  const both = await Promise.all([
    store.transitionQuote(h.accountId, q.id, 'sent'),
    store.transitionQuote(h.accountId, q.id, 'sent'),
  ]);
  assert.equal(both.filter(Boolean).length, 1, 'solo una aprobación gana');
  assert.equal(await store.transitionQuote(h.accountId, q.id, 'rejected'), null, 'una enviada ya no se rechaza');
  assert.deepEqual((await store.listQuoteEvents(h.accountId, q.id)).map((e: any) => e.type), ['created', 'edited', 'sent']);
  // Enviada, deja de estar abierta: la solicitud puede tener otra.
  await store.createQuote({ ...base, kind: 'approximate', status: 'sent' });
  assert.equal((await store.listQuotes(h.accountId, { conversationId: conv.id })).length, 2);

  assert.equal(await store.expireQuotes('2026-11-01'), 0);
  assert.ok((await store.expireQuotes('2027-01-01')) >= 2);
  assert.equal((await store.getQuote(h.accountId, q.id))?.status, 'expired');
});
