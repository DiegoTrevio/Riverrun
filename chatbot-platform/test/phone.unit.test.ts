import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phoneVariants } from '../src/contacts/phone.js';

const MX = 'America/Mexico_City';

test('teléfono en cualquier formato: espacios, guiones, paréntesis, + y 00', () => {
  for (const raw of ['+52 1 (55) 8100-0001', '+5215581000001', '0052 1 55 8100 0001', 5215581000001, ' 521-558-100-0001 ']) {
    assert.equal(normalizePhone(raw, MX), '5215581000001', String(raw));
  }
  assert.equal(normalizePhone('+1 (415) 555-0100', MX), '14155550100', 'con + es la lada que trae, aunque la cuenta sea de México');
});

test('teléfono: 10 dígitos en una cuenta de México son locales (lada 52); 044/045 eran prefijos de celular', () => {
  assert.equal(normalizePhone('55 8100 0001', MX), '525581000001');
  assert.equal(normalizePhone('044 55 8100 0001', MX), '525581000001');
  assert.equal(normalizePhone('81 8100 0001', 'America/Monterrey'), '528181000001');
  assert.equal(normalizePhone('4155550100', 'America/Los_Angeles'), '4155550100', 'fuera de México no se adivina la lada');
});

test('teléfono: lo que no es un teléfono no pasa', () => {
  for (const raw of ['', '12', 'llámame', 'ana@correo.mx', '1234567890123456', null, undefined, {}, true]) {
    assert.equal(normalizePhone(raw as any, MX), null, String(raw));
  }
});

test('las dos formas de un celular de México (con y sin el 1); los demás, una sola', () => {
  assert.deepEqual(phoneVariants('525581000001'), ['525581000001', '5215581000001']);
  assert.deepEqual(phoneVariants('5215581000001'), ['5215581000001', '525581000001']);
  assert.deepEqual(phoneVariants('14155550100'), ['14155550100']);
  assert.deepEqual(phoneVariants('52558100'), ['52558100']);
});
