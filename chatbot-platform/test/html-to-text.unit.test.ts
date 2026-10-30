/** htmlToText: convierte correos y páginas en texto en tiempo lineal (un HTML hostil no congela el proceso). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/knowledge-import.js';

/** 1 MB de lo mismo: con expresiones que retroceden, cada una tardaba minutos (crece al cuadrado). */
const hostile = (piece: string) => piece.repeat(Math.ceil((1024 * 1024) / piece.length));

for (const [name, piece] of [
  ['etiquetas <head sin cierre', '<head'],
  ['<script sin cierre', '<script x'],
  ['comentarios sin cierre', '<!--'],
  ['signos < sueltos', '<'],
  ['celdas sin cierre', '<td a'],
  ['JSON-LD sin cierre', '<script type="application/ld+json">'],
] as const) {
  test(`un correo de 1 MB con ${name} se convierte en menos de un segundo`, () => {
    const started = performance.now();
    htmlToText(hostile(piece));
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `tardó ${Math.round(ms)} ms`);
  });
}

test('quita scripts, estilos, comentarios y el encabezado, y conserva el texto', () => {
  const html = `<html><head><title>Clínica</title><style>.x{color:red}</style></head><!-- oculto -->
<body><SCRIPT>alert('no')</SCRIPT><h1>Clínica Sonrisa</h1><p>Limpieza dental &mdash; $650</p><p>Abrimos de lunes a viernes</p></body></html>`;
  assert.equal(htmlToText(html), 'Clínica Sonrisa\nLimpieza dental — $650\nAbrimos de lunes a viernes');
});

test('saltos de línea en párrafos y <br>, y celdas separadas', () => {
  assert.equal(htmlToText('Hola<br>Ana<br/>¿Cómo estás?<br class="x">Bien'), 'Hola\nAna\n¿Cómo estás?\nBien');
  assert.equal(htmlToText('<table><tr><td>Corte</td><td>$200</td></tr><tr><th>Tinte</th><td>$500</td></tr></table>'), '| Corte | $200\n| Tinte | $500');
});

for (const [name, piece] of [
  ['etiquetas <head> cerradas sin </head>', '<head>'],
  ['cierres parecidos a </head>', '<head></headx>'],
] as const) {
  test(`un correo de 1 MB con ${name} se convierte en menos de un segundo`, () => {
    const started = performance.now();
    htmlToText(hostile(piece));
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `tardó ${Math.round(ms)} ms`);
  });
}

test('un encabezado o un script sin cierre no se come el resto del correo', () => {
  assert.equal(htmlToText('<html><head><title>x</title><body><p>Quiero una cita</p>'), 'Quiero una cita');
  assert.equal(htmlToText('<head><p>Hola, quiero una cita</p>'), 'Hola, quiero una cita', 'sin </head> ni <body>, el texto se conserva');
  assert.match(htmlToText('<p>Hola</p><script>sin cerrar'), /^Hola/);
});

test('un comentario o una etiqueta sin cerrar no se comen el resto del texto', () => {
  assert.equal(htmlToText('<p>Hola</p><!-- sin cerrar <p>Quiero una cita</p>'), 'Hola\nsin cerrar Quiero una cita');
  assert.equal(htmlToText('<p>Hola</p><p>Quiero cita <b'), 'Hola\nQuiero cita <b');
});

test('los datos estructurados dentro de <head> también se conservan', () => {
  assert.equal(htmlToText('<html><head><title>x</title><script type="application/ld+json">{"@type":"Dentist"}</script></head><body><p>Hola</p></body></html>'),
    'Hola\n\nDatos estructurados de la página:\n{"@type":"Dentist"}');
});

test('el cierre de <header> no cierra un <head>', () => {
  // Si </header> cerrara el encabezado, «Menú» se perdería con él.
  assert.equal(htmlToText('<head><title>x</title><body><header>Menú</header><p>Hola</p>'), 'Menú\nHola');
});

test('los datos estructurados (JSON-LD) se agregan al final', () => {
  const text = htmlToText('<p>Menú</p><script type="application/ld+json"> {"@type":"Restaurant"} </script>');
  assert.equal(text, 'Menú\n\nDatos estructurados de la página:\n{"@type":"Restaurant"}');
});

test('un < que no abre etiqueta se conserva como texto', () => {
  assert.equal(htmlToText('<p>Precio < $100 y 3 <4</p>'), 'Precio < $100 y 3 <4');
});
