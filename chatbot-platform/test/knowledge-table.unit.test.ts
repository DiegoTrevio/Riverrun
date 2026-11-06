/** «Llena todo por mí» con una tabla: cada renglón con todas sus columnas (la IA se quedaba solo con el escalón A). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importKnowledge, tableCatalog } from '../src/knowledge-import.js';

const CSV = [
  'codigo,descripcion,A,B,C,D',
  'MM-C200,Panel Clásica 2.00 m,"1,050.00",1000,950,910.50',
  'MM-R200,Panel Recta 2.00 m,890,850,810,780',
  'MM-P16-250,Poste PTR 2x2 cal 16 2.50 m,470,450,430,415',
  'MM-ABR,Abrazadera,14,12,11,10.75',
].join('\n');

test('una lista de precios en CSV se copia completa: todos los escalones, sin IA', async () => {
  const t = tableCatalog(CSV)!;
  assert.equal(t.rows, 4);
  assert.equal(t.catalog.split('\n')[0], 'codigo: MM-C200 · descripcion: Panel Clásica 2.00 m · A: 1,050.00 · B: 1000 · C: 950 · D: 910.50');
  for (const p of ['1,050.00', '1000', '950', '910.50', '890', '850', '810', '780', '470', '450', '430', '415', '14', '12', '11', '10.75']) assert.ok(t.catalog.includes(p), p);
  const ai = { complete: async () => { throw new Error('no debe llamar a la IA'); } } as any;
  const r = await importKnowledge(ai, { kind: 'text', text: CSV, label: 'precios.csv' });
  assert.equal(r.sections.catalog, t.catalog);
  assert.equal(r.cost_usd, 0);
  // Separado por punto y coma (Excel en español) también.
  assert.equal(tableCatalog(CSV.replace(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ';'))?.rows, 4);
});

test('un texto que no es tabla sigue pasando por la IA', () => {
  assert.equal(tableCatalog('Somos una herrería en Monterrey.\nAbrimos de 9 a 6.\nHacemos rejas, portones y puertas.'), null);
  assert.equal(tableCatalog('nombre,comentario\nAna,muy bien\nLuis,excelente'), null, 'sin números no es una lista de precios');
});
