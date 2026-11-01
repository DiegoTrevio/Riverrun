/**
 * Formato de cotización en Word (.docx): el negocio diseña su documento y escribe marcas como {{cliente.nombre}} o
 * {{total}}; el sistema solo las reemplaza. Aquí se revisa que el archivo sea seguro (sin macros, sin contenido externo,
 * sin ZIP desproporcionado), se listan sus marcas y se llena.
 */
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { checkZip } from '../zip-limits.js';

export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 300;
/** Medidos descomprimiendo de verdad (con tope), no lo que el archivo dice pesar. */
const MAX_PART = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED = 30 * 1024 * 1024;
/** Más marcas que esto no es un formato de cotización: compilarlas llena la memoria. */
const MAX_TAGS = 2000;
/** El texto de una cotización con su tabla cabe de sobra; las imágenes van en otras partes. */
const MAX_TEXT_PART = 4 * 1024 * 1024;
const DELIMITERS = { start: '{{', end: '}}' };

/** Marcas que el sistema sabe llenar. `cliente.<dato>` acepta cualquier dato del agente. */
export const KNOWN_TAGS = [
  'folio', 'fecha', 'vigencia', 'moneda', 'notas', 'tipo', 'leyenda', 'subtotal', 'iva', 'total', 'tasa_iva',
  'nombre', 'telefono', 'correo',
  'negocio.nombre', 'negocio.telefono', 'negocio.correo', 'negocio.direccion',
  'es_aproximada', 'es_final', 'conceptos',
] as const;
export const LINE_TAGS = ['concepto', 'clave', 'descripcion', 'cantidad', 'unidad', 'precio_unitario', 'importe'] as const;
/** Sin estas el archivo podría no decir si es aproximada o final, ni cuánto cuesta. */
export const REQUIRED_TAGS = ['tipo', 'leyenda', 'total'] as const;

export interface TemplateReport {
  /** Problemas que impiden usar el archivo. */
  errors: string[];
  /** Marcas encontradas (sin llaves). */
  found: string[];
  /** Marcas que el sistema no conoce: quedarían vacías. */
  unknown: string[];
  missingRequired: string[];
}

const known = (tag: string) => (KNOWN_TAGS as readonly string[]).includes(tag) || /^cliente\.[\p{L}\p{N}_]{1,60}$/u.test(tag);

/** Lee `a.b.c` dentro de los datos; docxtemplater busca en el renglón y luego en el documento. */
const parser = (tag: string) => ({
  get(scope: any) {
    if (tag === '.') return scope;
    return tag.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), scope);
  },
});

const COMPILE_ERRORS: Record<string, string> = {
  unopened_tag: 'Hay una marca que cierra «}}» sin abrir «{{»',
  unclosed_tag: 'Hay una marca que abre «{{» y no se cierra',
  duplicate_open_tag: 'Hay una marca con «{{» repetido',
  duplicate_close_tag: 'Hay una marca con «}}» repetido',
  unopened_loop: 'Hay un «{{/…}}» sin su «{{#…}}»',
  unclosed_loop: 'Hay un «{{#…}}» sin su «{{/…}}»',
  closing_tag_does_not_match_opening_tag: 'Un «{{/…}}» no coincide con su «{{#…}}»',
  unbalanced_loop_tags: 'Las marcas de la tabla de conceptos no están en el mismo renglón',
};

function compileErrors(e: any): string[] {
  const list: any[] = e?.properties?.errors ?? [e];
  return [...new Set(list.map((x) => {
    const id = x?.properties?.id;
    const tag = x?.properties?.xtag ? ` (cerca de «${String(x.properties.xtag).slice(0, 40)}»)` : '';
    return (COMPILE_ERRORS[id] ?? 'El archivo tiene marcas mal escritas') + tag;
  }))].slice(0, 10);
}

/** Abre el ZIP con límites de tamaño, sin extraerlo a disco. */
function openZip(buffer: Buffer): { zip?: PizZip; errors: string[] } {
  if (buffer.length > TEMPLATE_MAX_BYTES) return { errors: ['El archivo supera 5 MB'] };
  if (buffer.subarray(0, 4).toString('latin1') !== 'PK\u0003\u0004') return { errors: ['El archivo no es un Word (.docx)'] };
  const problem = checkZip(buffer, { maxEntries: MAX_ENTRIES, maxEntryBytes: MAX_PART, maxTotalBytes: MAX_UNCOMPRESSED });
  if (problem) return { errors: [problem] };
  let zip: PizZip;
  try { zip = new PizZip(buffer); } catch { return { errors: ['El archivo está dañado o no es un Word (.docx)'] }; }
  // Segunda revisión, ya abierto: las partes que de verdad leyó PizZip.
  if (Object.keys(zip.files).length > MAX_ENTRIES) return { errors: ['El archivo tiene demasiadas partes internas'] };
  const names = Object.keys(zip.files);
  if (!zip.file('word/document.xml')) return { errors: ['El archivo no es un documento de Word (.docx)'] };
  const errors: string[] = [];
  const contentTypes = zip.file('[Content_Types].xml')?.asText() ?? '';
  if (names.some((n) => /vbaProject\.bin$|vbaData\.xml$/i.test(n)) || /macroEnabled/i.test(contentTypes)) errors.push('El archivo tiene macros: guárdalo como «Documento de Word (.docx)»');
  if (names.some((n) => /activeX/i.test(n))) errors.push('El archivo tiene controles ActiveX: quítalos');
  if (names.some((n) => /(^|\/)embeddings\//i.test(n))) errors.push('El archivo tiene objetos incrustados (otros archivos dentro): quítalos');
  // Imágenes, plantillas u objetos que se cargan de internet: LibreOffice los descargaría al generar el PDF.
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const rels = zip.file(n)?.asText() ?? '';
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (/TargetMode="External"/i.test(m[0]) && !/\/hyperlink"/i.test(m[0])) {
        errors.push('El archivo carga contenido de internet (imágenes o plantillas vinculadas): insértalo dentro del documento');
        break;
      }
    }
  }
  return { zip, errors: [...new Set(errors)] };
}

const xmlText = (xml: string) => xml.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Partes del documento que pueden llevar marcas: el cuerpo, encabezados y pies de página. */
const textParts = (zip: PizZip) => Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));

/** Revisa un formato antes de guardarlo: seguridad, marcas mal escritas, marcas desconocidas y obligatorias. */
export function inspectTemplate(buffer: Buffer): TemplateReport {
  const { zip, errors } = openZip(buffer);
  if (!zip) return { errors, found: [], unknown: [], missingRequired: [...REQUIRED_TAGS] };
  // Lo que compila docxtemplater (cuerpo, encabezados y pies) cuesta memoria al doble de su tamaño y más con cada marca.
  const texts = textParts(zip).map((part) => zip.file(part)!.asText());
  if (texts.some((x) => x.length > MAX_TEXT_PART)) return { errors: [...errors, 'El archivo descomprimido es demasiado grande'], found: [], unknown: [], missingRequired: [] };
  const tags = texts.reduce((n, x) => n + (x.match(/\{\{/g)?.length ?? 0), 0);
  if (tags > MAX_TAGS) return { errors: [...errors, 'El formato tiene demasiadas marcas (máximo 2 000)'], found: [], unknown: [], missingRequired: [] };
  try {
    new Docxtemplater(zip, { delimiters: DELIMITERS, paragraphLoop: true, linebreaks: true, errorLogging: false, parser });
  } catch (e) {
    return { errors: [...errors, ...compileErrors(e)], found: [], unknown: [], missingRequired: [] };
  }
  // Ya compiló sin errores: las marcas están bien cerradas y se pueden leer del texto.
  const found = new Set<string>();
  const unknown = new Set<string>();
  for (const part of textParts(zip)) {
    const stack: string[] = [];
    for (const m of xmlText(zip.file(part)!.asText()).matchAll(/\{\{\s*([#^/]?)\s*([^{}]*?)\s*\}\}/g)) {
      const [, kind, tag] = m;
      if (kind === '/') { stack.pop(); continue; }
      const loop = stack[stack.length - 1];
      if (kind) stack.push(tag);
      if (loop === 'conceptos' && !kind) {
        found.add(`conceptos.${tag}`);
        if (!(LINE_TAGS as readonly string[]).includes(tag) && !known(tag)) unknown.add(`conceptos.${tag}`);
        continue;
      }
      found.add(tag);
      if (!known(tag)) unknown.add(tag);
    }
  }
  const missingRequired = REQUIRED_TAGS.filter((t) => !found.has(t));
  if (missingRequired.length) errors.push(`Faltan marcas obligatorias: ${missingRequired.map((t) => `{{${t}}}`).join(', ')}`);
  return { errors, found: [...found], unknown: [...unknown], missingRequired };
}

/** Datos con que se llena el formato (todo ya en texto). */
export interface TemplateData {
  folio: string;
  fecha: string;
  vigencia: string;
  moneda: string;
  notas: string;
  tipo: string;
  leyenda: string;
  subtotal: string;
  iva: string;
  total: string;
  tasa_iva: string;
  nombre: string;
  telefono: string;
  correo: string;
  es_aproximada: boolean;
  es_final: boolean;
  cliente: Record<string, string>;
  negocio: Record<string, string>;
  conceptos: Record<(typeof LINE_TAGS)[number], string>[];
}

/** Llena el formato. Lo que el cliente escribió se inserta como texto (docxtemplater lo escapa). */
export function fillTemplate(buffer: Buffer, data: TemplateData): Buffer {
  const { zip, errors } = openZip(buffer);
  if (!zip || errors.length) throw new Error(errors[0] ?? 'Formato no válido');
  const doc = new Docxtemplater(zip, { delimiters: DELIMITERS, paragraphLoop: true, linebreaks: true, errorLogging: false, parser, nullGetter: () => '' });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

/** Texto plano de un .docx (para pruebas y para el convertidor de prueba). */
export function docxText(buffer: Buffer): string {
  const xml = new PizZip(buffer).file('word/document.xml')?.asText() ?? '';
  return xmlText(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t'));
}

/* ------------------------------ Formato de ejemplo ------------------------------ */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
  `<w:r><w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.color ? `<w:color w:val="${opts.color}"/>` : ''}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (runs: string, align?: 'right' | 'center') => `<w:p>${align ? `<w:pPr><w:jc w:val="${align}"/></w:pPr>` : ''}${runs}</w:p>`;
const WIDTHS = [3600, 1200, 1300, 1700, 1700];
const cell = (content: string, width: number, header: boolean) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF4"/>' : ''}</w:tcPr>${para(content)}</w:tc>`;
const row = (cells: string[], header = false) => `<w:tr>${cells.map((c, i) => cell(run(c, { bold: header }), WIDTHS[i], header)).join('')}</w:tr>`;

/** Un formato sencillo con todas las marcas, para descargar y adaptar en Word. */
export function exampleTemplate(): Buffer {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('');
  const body = [
    para(run('{{negocio.nombre}}', { bold: true, size: 32 })),
    para(run('{{negocio.direccion}} · {{negocio.telefono}}', { size: 18, color: '555555' })),
    para(run('{{tipo}}', { bold: true, size: 28, color: '1F4E79' }), 'right'),
    para(run('Folio: ', { bold: true }) + run('{{folio}}') + run('    Fecha: ', { bold: true }) + run('{{fecha}}'), 'right'),
    para(run('Cliente: ', { bold: true }) + run('{{nombre}}')),
    para(run('Teléfono: ', { bold: true }) + run('{{telefono}}') + run('    Correo: ', { bold: true }) + run('{{correo}}')),
    `<w:tbl><w:tblPr><w:tblW w:w="9500" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>`
      + `<w:tblGrid>${WIDTHS.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
      + row(['Concepto', 'Cantidad', 'Unidad', 'Precio', 'Importe'], true)
      + row(['{{#conceptos}}{{concepto}}', '{{cantidad}}', '{{unidad}}', '{{precio_unitario}}', '{{importe}}{{/conceptos}}'])
      + '</w:tbl>',
    para(run('Subtotal: ', { bold: true }) + run('{{subtotal}}'), 'right'),
    para(run('IVA ({{tasa_iva}}): ', { bold: true }) + run('{{iva}}'), 'right'),
    para(run('Total: ', { bold: true, size: 26 }) + run('{{total}}', { bold: true, size: 26 }), 'right'),
    para(run('Vigencia: ', { bold: true }) + run('{{vigencia}}')),
    para(run('{{notas}}')),
    para(run('{{leyenda}}', { size: 18, color: '7F6000' })),
  ].join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
