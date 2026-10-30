/** ipKey: la clave de una conexión para los límites (una IPv6 cuenta por su /64, no dirección por dirección). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipKey } from '../src/auth.js';

test('una IPv4 (también escrita como IPv6) es su propia clave', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
});

test('las direcciones del mismo /64 comparten clave; otro /64 no', () => {
  const a = ipKey('2001:db8:abcd:12:1::5');
  assert.equal(a, '2001:db8:abcd:12::/64');
  assert.equal(ipKey('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff'), a, 'otra dirección del mismo bloque');
  assert.equal(ipKey('2001:DB8:ABCD:12::1'), a, 'mayúsculas y forma corta');
  assert.notEqual(ipKey('2001:db8:abcd:13::1'), a);
});

test('formas cortas al inicio o al final', () => {
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::'), 'fe80:0:0:0::/64');
});

test('lo que no es una IP se usa tal cual', () => {
  assert.equal(ipKey(''), '');
  assert.equal(ipKey('desconocida'), 'desconocida');
});
