/**
 * Después de enviar la cotización: avisos de «por vencer» y «vencida» para las reglas (seguimiento), el cliente que la
 * acepta en el chat y la cotización que el equipo arma desde el panel.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
const qstore = await import('../src/store/quotes.js');
const { expireDueQuotes, remindExpiringQuotes } = await import('../src/quotes/agent.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let phoneN = 0;
const nextPhone = () => `52155200${String(++phoneN).padStart(5, '0')}`;
const TZ = 'America/Mexico_City';
const today = (offset = 0) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  return new Date(Date.parse(`${d}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
};
const tags = async (convId: string) => (await pool.query('SELECT tags FROM contacts WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)', [convId])).rows[0].tags as string[];
const events = async (quoteId: string, type: string) => (await pool.query('SELECT detail FROM quote_events WHERE quote_id = $1 AND type = $2 ORDER BY id', [quoteId, type])).rows.map((r) => r.detail);
const emitted: any[] = [];
const emit = (e: any) => { emitted.push(e); h.service.automator.emit(e); };

/** Una conversación con una cotización ya enviada que vence en `days` días. */
async function sentQuoteIn(days: number) {
  const phone = nextPhone();
  h.setScript(() => ({ messages: ['Hola, con gusto.'] }));
  await h.webhook('Hola', { phone });
  await h.idle();
  const conv = await h.conversationFor(phone);
  const q = await qstore.createQuote({
    accountId: h.accountId, kind: 'approximate', status: 'sent', source: 'panel', today: today(0), conversationId: conv.id, contactId: conv.contact_id,
    customer: { nombre: 'Ana' }, lines: [{ name: 'Renta de salón', qty: 1, price_mode: 'exact', price_min: 100000, price_max: null, iva_mode: 'plus' }],
  });
  await pool.query('UPDATE quotes SET valid_until = $2::date, sent_at = now() WHERE id = $1', [q.id, today(days)]);
  return { phone, conv, quote: q };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ ai: { debounce_seconds: 0.1, quotes: { enabled: true, allow_final: true, required_fields: [], template_id: '' } } });
  // Alguien del equipo a quien avisar.
  await h.addUser({ account_id: h.accountId, name: 'Dueña', email: 'duena@seguimiento.test', password: 'Pz-151-Qx-351-Kv', role: 'admin' });
  await qstore.createPriceItem(h.accountId, { code: 'SALON', name: 'Renta de salón', description: '', unit: 'servicio', price_mode: 'exact', price_min: 100000, price_max: null, iva_mode: 'plus', active: true, sort: 0 } as qstore.PriceItemInput);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('por vencer: la regla con «2 días antes» se dispara una sola vez, con los datos de la cotización', async () => {
  const rule = await h.authed('POST', '/api/automations', {
    account_id: h.accountId, name: 'Seguimiento', active: true, trigger: { type: 'quote_expiring', days: 2 },
    actions: [{ type: 'add_tag', tag: 'por-vencer' }, { type: 'send_message', text: 'Tu cotización {{cotizacion.folio}} vence el {{cotizacion.vigencia}}. ¿Te ayudo con algo?' }],
  });
  assert.equal(rule.statusCode, 200, rule.body);
  assert.equal(rule.json().trigger.days, 2);
  const soon = await sentQuoteIn(2);
  const later = await sentQuoteIn(5);
  h.reset();
  emitted.length = 0;
  assert.ok((await remindExpiringQuotes(emit)) >= 1);
  await waitFor(async () => (await tags(soon.conv.id)).includes('por-vencer'));
  await waitFor(async () => h.sent.some((s) => s.to === soon.phone && (s.text ?? '').includes(soon.quote.folio)));
  assert.ok(!emitted.some((e) => e.quote.id === later.quote.id), 'la que vence en 5 días todavía no');
  const ev = emitted.find((e) => e.quote.id === soon.quote.id);
  assert.equal(ev.type, 'quote_expiring');
  assert.equal(ev.daysLeft, 2);
  assert.deepEqual(await events(soon.quote.id, 'expiring'), [{ days_left: 2 }]);
  // Otra vuelta de la tarea (cada 6 horas) el mismo día: no se repite.
  emitted.length = 0;
  await remindExpiringQuotes(emit);
  assert.ok(!emitted.some((e) => e.quote.id === soon.quote.id));
  assert.equal((await events(soon.quote.id, 'expiring')).length, 1);
  // Una aceptada ya no recibe recordatorio.
  const accepted = await sentQuoteIn(2);
  await qstore.transitionQuote(h.accountId, accepted.quote.id, 'accepted', {});
  emitted.length = 0;
  await remindExpiringQuotes(emit);
  assert.ok(!emitted.some((e) => e.quote.id === accepted.quote.id));
  // Tampoco la que el cliente ya dijo en el chat que acepta (el equipo la está confirmando).
  const said = await sentQuoteIn(2);
  await qstore.markCustomerAccepted(h.accountId, said.quote.id, 'la acepto');
  emitted.length = 0;
  await remindExpiringQuotes(emit);
  assert.ok(!emitted.some((e) => e.quote.id === said.quote.id));
  await pool.query('UPDATE automations SET active = false WHERE id = $1', [rule.json().id]);
});

t('vencida: al pasar la vigencia la cotización vence y las reglas «cotización vencida» se enteran', async () => {
  const rule = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Vencida', active: true, trigger: { type: 'quote_expired' }, actions: [{ type: 'add_tag', tag: 'cotizacion-vencida' }] });
  assert.equal(rule.statusCode, 200, rule.body);
  const old = await sentQuoteIn(-1);
  emitted.length = 0;
  assert.ok((await expireDueQuotes(emit)) >= 1);
  assert.equal((await qstore.getQuote(h.accountId, old.quote.id))!.status, 'expired');
  assert.ok(emitted.some((e) => e.type === 'quote_expired' && e.quote.id === old.quote.id && e.conversationId === old.conv.id));
  await waitFor(async () => (await tags(old.conv.id)).includes('cotizacion-vencida'));
  // Una por aprobar que vence nunca la vio el cliente: vence, pero las reglas no le escriben.
  const pending = await sentQuoteIn(-2);
  await pool.query(`UPDATE quotes SET status = 'pending_approval', sent_at = NULL WHERE id = $1`, [pending.quote.id]);
  emitted.length = 0;
  await expireDueQuotes(emit);
  assert.equal((await qstore.getQuote(h.accountId, pending.quote.id))!.status, 'expired');
  assert.ok(!emitted.some((e) => e.quote.id === pending.quote.id));
  // Sin quién escuche, vencer sigue funcionando.
  const other = await sentQuoteIn(-3);
  await expireDueQuotes();
  assert.equal((await qstore.getQuote(h.accountId, other.quote.id))!.status, 'expired');
  await pool.query('UPDATE automations SET active = false WHERE id = $1', [rule.json().id]);
});

const notices = async (like: string) => (await pool.query(`SELECT title, body FROM notifications WHERE account_id = $1 AND title LIKE $2`, [h.accountId, like])).rows;
const accept = (words: string) => ({ action: 'accept', items: [], inputs: [], notes: '', wants_final: false, accept_quote: words });

t('el cliente acepta en el chat: se anota con sus palabras, el equipo recibe un aviso y la aceptación formal sigue siendo del equipo', async () => {
  const { phone, quote } = await sentQuoteIn(10);
  h.setScript(() => ({ messages: ['¡Excelente! Le aviso al equipo para confirmar el siguiente paso.'], quote: accept('va, la acepto') }));
  await h.webhook('Va, la acepto. ¿Cómo pago?', { phone });
  await h.idle();
  const q = (await qstore.getQuote(h.accountId, quote.id))!;
  assert.equal(q.status, 'sent', 'el equipo la confirma con su plan de cobro');
  assert.ok(q.customer_accepted_at);
  assert.equal(q.customer_accepted_text, 'va, la acepto');
  assert.deepEqual(await events(quote.id, 'customer_accepted'), [{ text: 'va, la acepto' }]);
  await waitFor(async () => (await notices(`%acepta la cotización ${quote.folio}%`)).length === 1);
  const [n] = await notices(`%acepta la cotización ${quote.folio}%`);
  assert.match(n.body, /va, la acepto/);
  assert.match(n.body, /El cliente aceptó/);
  // Lo repite: no se avisa dos veces.
  await h.webhook('Sí, la acepto', { phone });
  await h.idle();
  assert.equal((await notices(`%acepta la cotización ${quote.folio}%`)).length, 1);
  assert.equal((await events(quote.id, 'customer_accepted')).length, 1);
  // El equipo la confirma desde el panel, como siempre.
  const r = await h.authed('POST', `/api/quotes/${quote.id}/accept`, { plan: null });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().quote.status, 'accepted');
});

t('aceptar en el chat: no se anota con palabras que el cliente no escribió, ni una cotización vencida', async () => {
  const { phone, quote } = await sentQuoteIn(10);
  h.setScript(() => ({ messages: ['Claro, tómate tu tiempo.'], quote: accept('la acepto') }));
  await h.webhook('Déjame pensarlo', { phone });
  await h.idle();
  assert.equal((await qstore.getQuote(h.accountId, quote.id))!.customer_accepted_at, null);

  const old = await sentQuoteIn(-1);
  await expireDueQuotes();
  h.setScript(() => ({ messages: ['Gracias.'], quote: accept('la acepto') }));
  await h.webhook('Sí, la acepto', { phone: old.phone });
  await h.idle();
  const q = (await qstore.getQuote(h.accountId, old.quote.id))!;
  assert.equal(q.status, 'expired');
  assert.equal(q.customer_accepted_at, null);
  assert.equal((await notices(`%acepta la cotización ${old.quote.folio}%`)).length, 0);
});

const salon = { price_item_id: null, code: 'SALON', name: 'Renta de salón', description: '', unit: 'servicio', qty: 2, price_mode: 'exact', price_min: 100000, price_max: null, iva_mode: 'plus' };

t('desde el panel, sin conversación: el equipo la arma, genera el PDF y la marca enviada; luego se acepta como cualquiera', async () => {
  const r = await h.authed('POST', '/api/quotes', { account_id: h.accountId, customer: { nombre: 'Luis Pérez', telefono: '', correo: 'luis@cliente.test' }, lines: [salon], notes: 'Pedido por teléfono' });
  assert.equal(r.statusCode, 200, r.body);
  const q = r.json();
  assert.equal(q.status, 'draft');
  assert.equal(q.source, 'panel');
  assert.match(q.folio, /^COT-\d+$/);
  assert.equal(q.total_min, 232000);
  assert.equal(q.customer_snapshot.nombre, 'Luis Pérez');
  assert.equal(q.customer_snapshot.correo, 'luis@cliente.test');
  assert.equal((await events(q.id, 'created'))[0].source, 'panel');
  // Sin conceptos no se arma; con conversación de otra cuenta, tampoco.
  assert.equal((await h.authed('POST', '/api/quotes', { account_id: h.accountId, lines: [] })).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/quotes', { account_id: h.accountId, conversation_id: crypto.randomUUID(), lines: [salon] })).statusCode, 404);
  // Se corrige antes de enviar, como las del asistente.
  assert.equal((await h.authed('PATCH', `/api/quotes/${q.id}`, { lines: [{ ...salon, qty: 3 }] })).statusCode, 200);
  const sent = await h.authed('POST', `/api/quotes/${q.id}/mark-sent`);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().status, 'sent');
  assert.equal(sent.json().total_min, 348000);
  const pdf = await h.app.inject({ method: 'GET', url: `/api/quotes/${q.id}/file`, headers: { cookie: h.cookie } });
  assert.equal(pdf.statusCode, 200);
  assert.match(pdf.body, /Luis Pérez/);
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/mark-sent`)).statusCode, 409, 'ya se marcó');
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/accept`, { plan: null })).statusCode, 200);
});

t('desde el panel, en una conversación: toma los datos del contacto y se envía con «Aprobar y enviar»', async () => {
  const phone = nextPhone();
  h.setScript(() => ({ messages: ['Hola, con gusto.'] }));
  await h.webhook('Hola, me cotizan por favor', { phone });
  await h.idle();
  const conv = await h.conversationFor(phone);
  const r = await h.authed('POST', '/api/quotes', { account_id: h.accountId, conversation_id: conv.id, lines: [salon] });
  assert.equal(r.statusCode, 200, r.body);
  const q = r.json();
  assert.equal(q.conversation_id, conv.id);
  assert.equal(q.contact_id, conv.contact_id);
  assert.equal(q.customer_snapshot.telefono, `+${phone}`);
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/mark-sent`)).statusCode, 400, 'con conversación se envía por el chat');
  h.reset();
  const ap = await h.authed('POST', `/api/quotes/${q.id}/approve`);
  assert.equal(ap.statusCode, 200, ap.body);
  const out = h.sent.filter((s) => s.to === phone);
  assert.deepEqual(out.map((s) => s.kind), ['text', 'file']);
  assert.match(out[0].text, new RegExp(`cotización APROXIMADA \\(folio ${q.folio}\\)`));
  assert.equal((await qstore.getQuote(h.accountId, q.id))!.status, 'sent');
});

t('desde el panel: solo los administradores arman cotizaciones', async () => {
  await h.addUser({ account_id: h.accountId, name: 'Agente', email: 'agente@seguimiento.test', password: 'Pz-152-Qx-352-Kv', role: 'agent' });
  const agent = await h.loginAs('agente@seguimiento.test', 'Pz-152-Qx-352-Kv');
  assert.equal((await agent('POST', '/api/quotes', { account_id: h.accountId, lines: [salon] })).statusCode, 403);
});
