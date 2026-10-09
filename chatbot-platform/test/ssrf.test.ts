/** Direcciones que nunca deben alcanzarse desde webhooks o el canal de correo (incluidas las escrituras IPv6 alternativas). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { isPrivateIp } = await import('../src/automation/automator.js');

test('se bloquean redes internas en IPv4 e IPv6, también las escrituras con IPv4 incrustada', () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '198.18.0.1', '::1', '::', '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:ac10:1', '0:0:0:0:0:ffff:7f00:1', 'fe80::1', 'fec0::1', 'fd00::1', '64:ff9b::7f00:1', '2002:7f00:1::', '::7f00:1', 'ff02::1', 'no-es-ip']) {
    assert.equal(isPrivateIp(ip), true, `${ip} debe bloquearse`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:808:808', '172.32.0.1', '100.63.0.1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} es público`);
  }
});
