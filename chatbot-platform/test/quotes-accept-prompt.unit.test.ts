/** Lo que el asistente sabe para que el cliente acepte en el chat la cotización que ya recibió. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteSection } from '../src/engine/context.js';

const settings = { currency: 'MXN', iva_rate: 0.16 } as any;
const item = { id: 'i1', code: 'SALON', name: 'Renta de salón', description: '', unit: 'servicio', price_mode: 'exact', price_min: 100000, price_max: null, iva_mode: 'plus' } as any;
const sent = (o: Record<string, unknown> = {}) => ({
  id: 'q1', folio: 'COT-0007', kind: 'approximate', status: 'sent', currency: 'MXN', lines: [], subtotal_min: 100000, subtotal_max: 100000,
  iva_min: 16000, iva_max: 16000, total_min: 116000, total_max: 116000, open_ended: false, has_tbd: false, valid_until: '2026-12-01', ...o,
}) as any;
const catalog = (lastSent: any) => ({ settings, items: [item], requiredFields: [], allowFinal: false, templateId: null, requestId: null, open: null, lastSent, calculator: null, sendSummary: false, sendPdf: true });

test('con una cotización enviada, el asistente sabe cómo marcar que el cliente la acepta', () => {
  const s = quoteSection(catalog(sent()));
  assert.match(s, /ACEPTA la cotización COT-0007/);
  assert.match(s, /quote\.action = "accept"/);
  assert.match(s, /no confirmes pagos, fechas ni apartados/);
});

test('si ya dijo que la acepta, no se vuelve a marcar; vencida o sin cotización, no se ofrece', () => {
  const s = quoteSection(catalog(sent({ customer_accepted_at: new Date() })));
  assert.match(s, /ya dijo que acepta la cotización COT-0007/);
  assert.doesNotMatch(s, /quote\.action = "accept"/);
  assert.doesNotMatch(quoteSection(catalog(sent({ status: 'expired' }))), /"accept"/);
  assert.doesNotMatch(quoteSection(catalog(null)), /"accept"/);
});

test('aceptar en el chat: palabras completas que el cliente escribió y no en negativo', async () => {
  const { acceptedIn } = await import('../src/engine/validator.js');
  assert.equal(acceptedIn('va la acepto como pago', 'va la acepto'), true);
  assert.equal(acceptedIn('si', 'si'), true);
  assert.equal(acceptedIn('casi lo tengo', 'si'), false, 'dentro de otra palabra');
  assert.equal(acceptedIn('no la acepto', 'la acepto'), false);
  assert.equal(acceptedIn('todavia no la acepto', 'la acepto'), false);
  assert.equal(acceptedIn('no hay problema la acepto', 'la acepto'), true);
  assert.equal(acceptedIn('dejame pensarlo', 'la acepto'), false);
  assert.equal(acceptedIn('no la acepto', 'no la acepto'), false);
  assert.equal(acceptedIn('si', ''), false);
});
