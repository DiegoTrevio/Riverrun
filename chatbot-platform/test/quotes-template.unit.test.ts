/** Formatos de Word: marcas encontradas y obligatorias, archivos peligrosos, llenado seguro y conversión real a PDF. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import { docxText, exampleTemplate, fillTemplate, inspectTemplate, type TemplateData } from '../src/quotes/template.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** Un .docx mínimo con el cuerpo dado (párrafos con `runs` partidos como los guarda Word). */
function docx(body: string, extra: Record<string, string> = {}, contentTypes = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'): Buffer {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${contentTypes}"/></Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  for (const [k, v] of Object.entries(extra)) zip.file(k, v);
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}
const p = (...runs: string[]) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join('')}</w:p>`;
const REQUIRED = p('{{tipo}}') + p('{{total}}') + p('{{leyenda}}');

const DATA: TemplateData = {
  folio: 'COT-0007', fecha: '20 de octubre de 2026', vigencia: '4 de noviembre de 2026', moneda: 'MXN', notas: '', tipo: 'COTIZACIÓN FINAL',
  leyenda: 'Precios respetados', subtotal: '$100.00', iva: '$16.00', total: '$116.00', tasa_iva: '16 %', nombre: 'Ana <b>&"', telefono: '55', correo: '',
  es_aproximada: false, es_final: true, cliente: { nombre: 'Ana <b>&"', evento: 'Boda' }, negocio: { nombre: 'Salón' },
  conceptos: [{ concepto: 'Renta', clave: 'R', descripcion: '', cantidad: '1', unidad: 'evento', precio_unitario: '$100.00', importe: '$100.00' }],
};

test('formato: el de ejemplo trae todas las marcas obligatorias y ninguna desconocida', () => {
  const r = inspectTemplate(exampleTemplate());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.unknown, []);
  for (const t of ['tipo', 'total', 'leyenda', 'folio', 'conceptos', 'conceptos.precio_unitario']) assert.ok(r.found.includes(t), t);
});

test('formato: marcas partidas por Word, datos del cliente, desconocidas y obligatorias faltantes', () => {
  // Word suele partir «{{cliente.evento}}» en varios fragmentos al corregir ortografía.
  const r = inspectTemplate(docx(REQUIRED + p('{{clie', 'nte.evento}}') + p('{{descuento}}') + p('{{#es_final}}', 'Precio final', '{{/es_final}}')));
  assert.deepEqual(r.errors, []);
  assert.ok(r.found.includes('cliente.evento'));
  assert.deepEqual(r.unknown, ['descuento']);
  const missing = inspectTemplate(docx(p('{{total}}')));
  assert.deepEqual(missing.missingRequired, ['tipo', 'leyenda']);
  assert.match(missing.errors.join(), /Faltan marcas obligatorias: \{\{tipo\}\}, \{\{leyenda\}\}/);
  const broken = inspectTemplate(docx(REQUIRED + p('{{folio')));
  assert.match(broken.errors.join(), /no se cierra/);
});

test('formato: se rechazan macros, ActiveX, objetos incrustados, contenido de internet y lo que no es Word', () => {
  assert.match(inspectTemplate(docx(REQUIRED, { 'word/vbaProject.bin': 'x' })).errors.join(), /macros/);
  assert.match(inspectTemplate(docx(REQUIRED, {}, 'application/vnd.ms-word.document.macroEnabled.main+xml')).errors.join(), /macros/);
  assert.match(inspectTemplate(docx(REQUIRED, { 'word/activeX/activeX1.xml': '<x/>' })).errors.join(), /ActiveX/);
  assert.match(inspectTemplate(docx(REQUIRED, { 'word/embeddings/oleObject1.bin': 'x' })).errors.join(), /incrustados/);
  const external = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://169.254.169.254/x.png" TargetMode="External"/></Relationships>';
  assert.match(inspectTemplate(docx(REQUIRED, { 'word/_rels/document.xml.rels': external })).errors.join(), /internet/);
  const link = external.replace('/image"', '/hyperlink"');
  assert.deepEqual(inspectTemplate(docx(REQUIRED, { 'word/_rels/document.xml.rels': link })).errors, [], 'un hipervínculo sí se permite');
  assert.match(inspectTemplate(Buffer.from('%PDF-1.4')).errors.join(), /no es un Word/);
  const many: Record<string, string> = {};
  for (let i = 0; i < 310; i++) many[`word/media/x${i}.txt`] = 'x';
  assert.match(inspectTemplate(docx(REQUIRED, many)).errors.join(), /demasiadas partes/);
  const bomb = new PizZip();
  bomb.file('word/document.xml', 'a'.repeat(31 * 1024 * 1024));
  assert.match(inspectTemplate(bomb.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer).errors.join(), /demasiado grande/);
});

test('formato: se llena con los datos (escapados), la tabla de conceptos y las secciones de aproximada/final', () => {
  const body = REQUIRED + p('{{cliente.nombre}} — {{cliente.evento}}') + p('{{#conceptos}}', '{{concepto}}: {{importe}}', '{{/conceptos}}')
    + p('{{#es_aproximada}}', 'PUEDE CAMBIAR', '{{/es_aproximada}}') + p('{{#es_final}}', 'PRECIO FIRME', '{{/es_final}}') + p('[{{no_existe}}]');
  const out = docxText(fillTemplate(docx(body), DATA));
  assert.match(out, /COTIZACIÓN FINAL/);
  assert.match(out, /Ana <b>&" — Boda/);
  assert.match(out, /Renta: \$100\.00/);
  assert.match(out, /PRECIO FIRME/);
  assert.doesNotMatch(out, /PUEDE CAMBIAR/);
  assert.match(out, /\[\]/, 'una marca desconocida queda vacía');
  const xml = new PizZip(fillTemplate(docx(body), DATA)).file('word/document.xml')!.asText();
  assert.ok(xml.includes('Ana &lt;b&gt;&amp;'), 'el texto del cliente nunca se inserta como XML');
});

test('formato: conversión real a PDF con LibreOffice (si está instalado)', async (t) => {
  const { config } = await import('../src/config.js');
  const { docxToPdf, sofficeAvailable } = await import('../src/quotes/pdf.js');
  if (!(await sofficeAvailable())) return t.skip('LibreOffice no está instalado');
  const before = config.quotes.pdfBackend;
  config.quotes.pdfBackend = 'soffice';
  try {
    const pdf = await docxToPdf(fillTemplate(exampleTemplate(), DATA));
    assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF');
    assert.ok(pdf.length > 5000);
  } finally { config.quotes.pdfBackend = before; }
});
