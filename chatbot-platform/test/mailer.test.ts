/** Sin SMTP el correo queda en la bitácora: sin los tokens de sus enlaces (la bitácora la leen más personas). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, migrate, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { deliverMail, outbox, redactTokens } = await import('../src/mailer.js');

before(async () => {
  if (!ok) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
});
after(async () => {
  await pool.end();
});

t('redactTokens oculta el token de cada enlace y deja lo demás', async () => {
  const text = [
    'Verifica: https://p.mx/#/verificar?token=abc123DEF',
    'Restablece: https://p.mx/#/restablecer?token=x_y-z&otro=1',
    'Borrar: https://p.mx/borrar-cuenta?t=eyJhIjoxfQ.firma',
    'Únete: https://p.mx/#/invitacion/AbC_d-1',
    'Correo: https://p.mx/#/cambiar-correo/QQ_9',
    'Google: https://p.mx/#/registro-google/eyJ.sig',
  ].join('\n');
  const out = redactTokens(text);
  for (const secret of ['abc123DEF', 'x_y-z', 'eyJhIjoxfQ.firma', 'AbC_d-1', 'QQ_9', 'eyJ.sig']) assert.ok(!out.includes(secret), `${secret} sigue en: ${out}`);
  assert.match(out, /#\/verificar\?token=\[oculto\]/);
  assert.match(out, /&otro=1/, 'lo que sigue al token se queda');
  assert.match(out, /borrar-cuenta\?t=\[oculto\]/);
  assert.match(out, /#\/invitacion\/\[oculto\]/);
  assert.match(out, /#\/cambiar-correo\/\[oculto\]/);
  assert.match(out, /#\/registro-google\/\[oculto\]/);
});

t('sin SMTP, la bitácora no guarda el cuerpo del correo (INF-13); el buzón de pruebas sí', async () => {
  await deliverMail({ to: 'ana@bitacora.mx', subject: 'Restablece tu contraseña', text: 'Hola Ana López, tu pedido 4471. Abre https://p.mx/#/restablecer?token=SECRETO-123 (vence en 1 hora)' });
  const row = (await pool.query(`SELECT details FROM event_logs WHERE message = 'Correo (sin SMTP) para ana@bitacora.mx: Restablece tu contraseña' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.ok(row, 'quedó en la bitácora');
  assert.doesNotMatch(JSON.stringify(row.details), /SECRETO-123|pedido 4471|Ana López/);
  assert.ok(row.details.chars > 0);
  assert.match(outbox.at(-1)!.text, /SECRETO-123/);
});

t('el asunto es una sola línea: sin saltos ni caracteres de control y con largo razonable', async () => {
  await deliverMail({ to: 'ana@bitacora.mx', subject: 'Hola\r\nBcc: todos@victima.mx\u0007  y más', text: 'x' });
  assert.equal(outbox.at(-1)!.subject, 'Hola Bcc: todos@victima.mx y más');
  await deliverMail({ to: 'ana@bitacora.mx', subject: 'a'.repeat(400), text: 'x' });
  assert.equal(outbox.at(-1)!.subject.length, 150);
});
