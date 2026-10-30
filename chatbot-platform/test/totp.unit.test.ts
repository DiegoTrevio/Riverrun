/** Verificación en dos pasos: códigos TOTP (RFC 6238), su URI para la app, el QR y el cifrado del secreto con una llave dada. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, currentStep, matchTotp, newTotpSecret, otpauthUri, totpAt } from '../src/identity/totp.js';
import { qrDataUri } from '../src/identity/qr.js';
import { decryptSecret, encryptSecret } from '../src/secret.js';

const rfc = base32Encode(Buffer.from('12345678901234567890'));

test('vectores del RFC 6238 (SHA-1, últimos 6 dígitos)', () => {
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']] as const) {
    assert.equal(totpAt(rfc, Math.floor(t / 30)), code, `t=${t}`);
  }
});

test('reloj desfasado: un paso antes o después entra; dos pasos no', () => {
  const now = 1234567890_000;
  const s = currentStep(now);
  assert.equal(matchTotp(rfc, totpAt(rfc, s), now), s);
  assert.equal(matchTotp(rfc, totpAt(rfc, s - 1), now), s - 1);
  assert.equal(matchTotp(rfc, totpAt(rfc, s + 1), now), s + 1);
  assert.equal(matchTotp(rfc, totpAt(rfc, s - 2), now), null);
});

test('el código se acepta con espacios o guiones; incompleto no', () => {
  const now = 1234567890_000;
  const c = totpAt(rfc, currentStep(now));
  assert.notEqual(matchTotp(rfc, `${c.slice(0, 3)} ${c.slice(3)}`, now), null);
  assert.notEqual(matchTotp(rfc, `${c.slice(0, 3)}-${c.slice(3)}`, now), null);
  assert.equal(matchTotp(rfc, '12345', now), null);
  assert.equal(matchTotp(rfc, '', now), null);
});

test('base32 ida y vuelta; el secreto nuevo tiene 20 bytes', () => {
  const s = newTotpSecret();
  assert.equal(base32Decode(s).length, 20);
  assert.equal(base32Encode(base32Decode(s.toLowerCase())), s);
  assert.notEqual(newTotpSecret(), s);
});

test('otpauth y QR', () => {
  const uri = otpauthUri({ issuer: 'Mi Agencia', account: 'ana@negocio.mx', secret: 'ABC' });
  assert.equal(uri, 'otpauth://totp/Mi%20Agencia:ana%40negocio.mx?secret=ABC&issuer=Mi%20Agencia&algorithm=SHA1&digits=6&period=30');
  const qr = qrDataUri(uri);
  assert.match(qr, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(qr.split(',')[1], 'base64').toString(), /^<svg/);
});

test('cifrar con una llave dada', () => {
  const packed = encryptSecret('hola', 'llave-a');
  assert.equal(decryptSecret(packed, 'llave-a'), 'hola');
  assert.equal(decryptSecret(packed, 'llave-b'), null);
});
