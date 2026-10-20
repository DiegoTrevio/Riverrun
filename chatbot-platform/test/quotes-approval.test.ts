/**
 * Cotizaciones finales: el equipo las revisa, corrige, aprueba (una sola vez aunque dos personas aprueben a la vez) o
 * rechaza. Las que no se pudieron generar se reintentan. Las reglas automáticas se enteran de cada paso.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
const qstore = await import('../src/store/quotes.js');
const { setPdfConverter } = await import('../src/quotes/pdf.js');
const { expireDueQuotes } = await import('../src/quotes/agent.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let agent: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
let phoneN = 0;
const nextPhone = () => `52155100${String(++phoneN).padStart(5, '0')}`;
const prepare = (code: string, wants_final: boolean) => ({ action: 'prepare', items: [{ item_code: code, qty: 1, qty_quote: '' }], notes: '', wants_final });
const quoteOf = async (phone: string) => (await qstore.listQuotes(h.accountId, { conversationId: (await h.conversationFor(phone)).id }))[0];
const textsTo = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text).join('\n');
const ask = async (phone: string, code: string, final: boolean) => {
  h.setScript(() => ({ messages: ['Con gusto.'], quote: prepare(code, final) }));
  await h.webhook('Quiero la cotización', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone).catch(() => null)));
  await h.idle();
  return (await qstore.getQuote(h.accountId, (await quoteOf(phone)).id))!;
};
const tags = async (phone: string) => (await pool.query('SELECT tags FROM contacts WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)', [(await h.conversationFor(phone)).id])).rows[0].tags as string[];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ ai: { debounce_seconds: 0.1, quotes: { enabled: true, allow_final: true, required_fields: [], template_id: '' } } });
  await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Agente', email: 'agente@aprueba.test', password: 'clave-agente-1', role: 'agent' });
  agent = await h.loginAs('agente@aprueba.test', 'clave-agente-1');
  for (const [code, name, o] of [['SALON', 'Renta de salón', { price_min: 1500000 }], ['DECO', 'Decoración', { price_mode: 'range', price_min: 300000, price_max: 500000 }]] as const) {
    await qstore.createPriceItem(h.accountId, { code, name, description: '', unit: 'servicio', price_mode: 'exact', price_min: null, price_max: null, iva_mode: 'plus', active: true, sort: 0, ...o } as qstore.PriceItemInput);
  }
  // Reglas: etiquetar a quien recibe, espera o le rechazan una cotización.
  for (const [type, tag] of [['quote_sent', 'cotizado'], ['quote_pending_approval', 'por-aprobar'], ['quote_rejected', 'rechazado']]) {
    const r = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: tag, trigger: { type }, actions: [{ type: 'add_tag', tag }], active: true });
    assert.equal(r.statusCode, 200, r.body);
  }
});
after(async () => {
  setPdfConverter(null);
  if (h) await h.app.close();
  await pool.end();
});

t('aprobar: el equipo corrige, aprueba y el cliente recibe la FINAL una sola vez', async () => {
  const phone = nextPhone();
  h.reset();
  const q = await ask(phone, 'SALON', true);
  assert.equal(q.status, 'pending_approval');
  await waitFor(async () => (await tags(phone)).includes('por-aprobar'));
  // La conversación muestra la cotización con sus conceptos para revisarla.
  const conv = (await h.authed('GET', `/api/conversations/${(await h.conversationFor(phone)).id}`)).json();
  assert.equal(conv.quotes[0].lines.length, 1);

  const line = { ...q.lines![0], qty: 2, price_min: 1400000 };
  const edit = await h.authed('PATCH', `/api/quotes/${q.id}`, { lines: [line], notes: 'Precio especial por fecha entre semana' });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().total_min, 2 * 1400000 * 1.16);
  assert.equal((await agent('POST', `/api/quotes/${q.id}/approve`)).statusCode, 403, 'solo un administrador aprueba');

  h.reset();
  const both = await Promise.all([h.authed('POST', `/api/quotes/${q.id}/approve`), h.authed('POST', `/api/quotes/${q.id}/approve`)]);
  assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 409], both.map((r) => r.body).join(' | '));
  const sent = h.sent.filter((s) => s.to === phone);
  assert.deepEqual(sent.map((s) => s.kind), ['text', 'file']);
  assert.match(sent[0].text, /cotización FINAL \(folio COT-\d+\) por \$32,480\.00 con IVA/);
  const done = (await qstore.getQuote(h.accountId, q.id))!;
  assert.equal(done.status, 'sent');
  assert.ok(done.approved_by);
  const pdf = await h.app.inject({ method: 'GET', url: `/api/quotes/${q.id}/file`, headers: { cookie: h.cookie } });
  assert.match(pdf.body, /COTIZACIÓN FINAL/);
  assert.match(pdf.body, /Precio especial por fecha entre semana/);
  await waitFor(async () => (await tags(phone)).includes('cotizado'));
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/approve`)).statusCode, 409, 'ya se envió');
  assert.equal((await h.authed('PATCH', `/api/quotes/${q.id}`, { lines: [line] })).statusCode, 409, 'ya no se edita');
  const events = (await qstore.listQuoteEvents(h.accountId, q.id)).map((e: any) => e.type);
  assert.deepEqual(events, ['created', 'edited', 'approved', 'sent']);
});

t('una final no puede llevar precios aproximados', async () => {
  const phone = nextPhone();
  const q = await ask(phone, 'SALON', true);
  const bad = await h.authed('PATCH', `/api/quotes/${q.id}`, { lines: [{ ...q.lines![0], price_mode: 'range', price_min: 100, price_max: 200 }] });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /precio exacto/);
  // Si el equipo decide que sea aproximada, sí.
  const approx = await h.authed('PATCH', `/api/quotes/${q.id}`, { kind: 'approximate', lines: [{ ...q.lines![0], price_mode: 'range', price_min: 100000, price_max: 200000 }] });
  assert.equal(approx.statusCode, 200, approx.body);
  h.reset();
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/approve`)).statusCode, 200);
  assert.match(textsTo(phone), /cotización APROXIMADA/);
});

t('rechazar: con motivo interno y, si se quiere, un mensaje al cliente', async () => {
  const phone = nextPhone();
  const q = await ask(phone, 'SALON', true);
  h.reset();
  const r = await h.authed('POST', `/api/quotes/${q.id}/reject`, { reason: 'Fecha no disponible', message: 'Esa fecha ya no la tenemos; te contactamos para revisar otra.' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'rejected');
  assert.equal(r.json().rejected_reason, 'Fecha no disponible');
  assert.match(textsTo(phone), /Esa fecha ya no la tenemos/);
  await waitFor(async () => (await tags(phone)).includes('rechazado'));
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/approve`)).statusCode, 409);
});

t('si el PDF no se puede generar: el cliente recibe un aviso, el equipo también, y luego se reintenta', async () => {
  const phone = nextPhone();
  setPdfConverter(async () => { throw new Error('LibreOffice no responde'); });
  h.reset();
  try {
    const q = await ask(phone, 'DECO', false);
    assert.equal(q.status, 'failed');
    assert.match(textsTo(phone), /Estamos preparando tu cotización/);
    assert.ok(!h.sent.some((s) => s.to === phone && s.kind === 'file'));
  } finally {
    setPdfConverter(null);
  }
  const q = await quoteOf(phone);
  h.reset();
  const retry = await h.authed('POST', `/api/quotes/${q.id}/approve`);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(h.sent.filter((s) => s.to === phone).map((s) => s.kind), ['text', 'file']);
  assert.match(textsTo(phone), /cotización APROXIMADA/);
});

t('vencimiento: las cotizaciones con la vigencia pasada se marcan vencidas', async () => {
  const phone = nextPhone();
  const q = await ask(phone, 'SALON', true);
  await pool.query(`UPDATE quotes SET valid_until = current_date - 2 WHERE id = $1`, [q.id]);
  assert.ok((await expireDueQuotes()) >= 1);
  assert.equal((await qstore.getQuote(h.accountId, q.id))!.status, 'expired');
  assert.equal((await h.authed('POST', `/api/quotes/${q.id}/approve`)).statusCode, 409);
});

t('privacidad: los datos del contacto incluyen sus cotizaciones; al borrarlo quedan folio y montos, sin sus datos ni archivos', async () => {
  const fs = await import('node:fs');
  const { attachmentAbsolutePath } = await import('../src/attachments.js');
  const phone = nextPhone();
  await ask(phone, 'DECO', false);
  const q = (await qstore.getQuote(h.accountId, (await quoteOf(phone)).id))!;
  assert.equal(q.status, 'sent');
  const pdfPath = attachmentAbsolutePath(q.pdf_path!);
  assert.ok(fs.existsSync(pdfPath));
  const contactId = q.contact_id!;
  const data = (await h.authed('GET', `/api/contacts/${contactId}/data`)).json();
  assert.equal(data.quotes[0].folio, q.folio);
  assert.equal(data.quotes[0].lines[0].concepto, 'Decoración');

  const csv = await h.app.inject({ method: 'GET', url: `/api/export/quotes.csv?account_id=${h.accountId}`, headers: { cookie: h.cookie } });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body, new RegExp(`${q.folio},aproximada,sent`));

  assert.equal((await h.authed('DELETE', `/api/contacts/${contactId}`)).statusCode, 200);
  const after = (await qstore.getQuote(h.accountId, q.id))!;
  assert.deepEqual(after.customer_snapshot, {});
  assert.equal(after.pdf_path, null);
  assert.equal(after.total_min, q.total_min, 'los montos se conservan');
  assert.ok(!fs.existsSync(pdfPath), 'el PDF con su nombre se borra');
});
