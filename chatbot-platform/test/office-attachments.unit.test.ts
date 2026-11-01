/** Adjuntos de Office: un ZIP de verdad del formato, sin macros (bajos de la 4′). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
const { identifyAttachment } = await import('../src/attachments.js');
const { exampleTemplate } = await import('../src/quotes/template.js');

const zipWith = (files: Record<string, string>) => {
  const z = new PizZip();
  for (const [name, body] of Object.entries(files)) z.file(name, body);
  return z.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
};

test('un Word real pasa', () => {
  assert.equal(identifyAttachment(exampleTemplate(), 'formato.docx')?.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('con macros (vbaProject.bin), sin [Content_Types].xml o sin la carpeta del formato, no', () => {
  assert.equal(identifyAttachment(zipWith({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<w/>', 'word/vbaProject.bin': 'MZ' }), 'f.docx'), null);
  assert.equal(identifyAttachment(zipWith({ 'word/document.xml': '<w/>' }), 'f.docx'), null);
  assert.equal(identifyAttachment(zipWith({ '[Content_Types].xml': '<x/>', 'xl/workbook.xml': '<w/>' }), 'f.docx'), null, 'un Excel con nombre de Word');
  assert.ok(identifyAttachment(zipWith({ '[Content_Types].xml': '<x/>', 'xl/workbook.xml': '<w/>' }), 'f.xlsx'));
  assert.equal(identifyAttachment(Buffer.from('PK\x03\x04basura'), 'f.docx'), null);
});
