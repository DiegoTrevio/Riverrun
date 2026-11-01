/** Descargas de archivos de clientes: extensión del tipo detectado y sin caracteres que invierten el texto (bajos de la 4′). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { downloadName, safeFileName } = await import('../src/channels/media.js');

test('la extensión sale del tipo detectado, no del nombre', () => {
  assert.equal(downloadName('foto.jpg.exe', 'image/jpeg'), 'foto.jpg.jpg');
  assert.equal(downloadName('factura.pdf', 'application/octet-stream'), 'factura.bin');
  assert.equal(downloadName('pagina.html', 'application/octet-stream'), 'pagina.bin');
  assert.equal(downloadName('contrato.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'contrato.docx');
  assert.equal(downloadName('', 'application/pdf'), 'archivo.pdf');
});

test('sin U+202A–202E ni U+2066–2069', () => {
  const name = 'factura‮fdp.exe';
  assert.doesNotMatch(safeFileName(name), /[‪-‮⁦-⁩]/);
  assert.doesNotMatch(downloadName('a⁦b⁩.pdf', 'application/pdf'), /[⁦-⁩]/);
});
