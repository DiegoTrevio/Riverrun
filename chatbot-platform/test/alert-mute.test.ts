import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMuted, parseAlertMute } from '../src/alert-mute.js';

test('ALERT_MUTE sin fecha: silencia sin vencimiento y se marca como permanente', () => {
  const p = parseAlertMute('backup, disk');
  assert.deepEqual(p.mutes, [{ name: 'backup', until: null }, { name: 'disk', until: null }]);
  assert.deepEqual(p.forever, ['backup', 'disk']);
  assert.deepEqual(p.invalid, []);
  assert.equal(isMuted(p.mutes, 'backup', Date.parse('2030-01-01T00:00:00Z')), true, 'sigue silenciado mucho después');
});

test('ALERT_MUTE con fecha: silencia hasta el instante exacto y después los avisos vuelven solos', () => {
  const p = parseAlertMute('backup=2026-10-12T18:00:00Z');
  const fin = Date.parse('2026-10-12T18:00:00Z');
  assert.equal(isMuted(p.mutes, 'backup', fin - 1), true);
  assert.equal(isMuted(p.mutes, 'backup', fin), false, 'en el instante de vencer, el aviso vuelve');
  assert.deepEqual(p.forever, []);
});

test('ALERT_MUTE: las entradas inválidas no silencian nada y se cuentan', () => {
  const p = parseAlertMute('backup=mañana,=2026-10-12,disk=2026-10-12T00:00:00Z');
  assert.equal(p.invalid.length, 2);
  assert.equal(isMuted(p.mutes, 'backup'), false, 'una fecha que no se entiende no silencia');
  assert.equal(isMuted(p.mutes, 'disk', Date.parse('2026-10-11T00:00:00Z')), true);
});

test('ALERT_MUTE vacío: nada silenciado', () => {
  const p = parseAlertMute('');
  assert.deepEqual(p.mutes, []);
  assert.equal(isMuted(p.mutes, 'whatsapp'), false);
});
