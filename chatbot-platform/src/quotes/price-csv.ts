/**
 * Lista de precios en CSV: cualquier negocio sube su tabla de Excel y la baja para editarla. Las columnas conocidas
 * (clave, nombre, familia, precio, IVA…) se leen como tales; cualquier otra columna es un atributo para la calculadora
 * (producto, altura, escalón, zona…). Los precios van en pesos («1,250.50», «$1250», «1.250,50»).
 */
import { parseCsv, unprotectCell } from '../contacts/csv.js';
import { csvRow } from '../export.js';
import { normalizeText } from './formula.js';
import { MAX_PRICE_CENTS, type IvaMode, type PriceMode } from './pricing.js';
import { priceItemProblem, type PriceItem, type PriceItemInput } from '../store/quotes.js';

export const PRICE_CSV_MAX_ROWS = 5000;

type Field = 'code' | 'name' | 'description' | 'unit' | 'family' | 'price' | 'price_max' | 'mode' | 'iva' | 'active' | 'sort';

/** Encabezados aceptados (sin acentos, minúsculas, espacios como «_»). */
const HEADERS: Record<string, Field> = {
  clave: 'code', codigo: 'code', code: 'code', sku: 'code',
  nombre: 'name', concepto: 'name', name: 'name',
  descripcion: 'description', description: 'description',
  unidad: 'unit', unit: 'unit',
  familia: 'family', family: 'family',
  precio: 'price', precio_unitario: 'price', price: 'price', precio_min: 'price', precio_minimo: 'price', desde: 'price',
  precio_max: 'price_max', precio_maximo: 'price_max', hasta: 'price_max',
  modo: 'mode', tipo_de_precio: 'mode', price_mode: 'mode',
  iva: 'iva', iva_mode: 'iva',
  activo: 'active', active: 'active',
  orden: 'sort', sort: 'sort',
};

const MODES: Record<string, PriceMode> = { exacto: 'exact', exact: 'exact', desde: 'from', from: 'from', rango: 'range', range: 'range', por_confirmar: 'tbd', tbd: 'tbd' };
const IVAS: Record<string, IvaMode> = { mas: 'plus', mas_iva: 'plus', plus: 'plus', incluido: 'included', included: 'included', exento: 'exempt', exempt: 'exempt' };
const MODE_WORD: Record<PriceMode, string> = { exact: 'exacto', from: 'desde', range: 'rango', tbd: 'por confirmar' };
const IVA_WORD: Record<IvaMode, string> = { plus: 'mas', included: 'incluido', exempt: 'exento' };

const slug = (s: string) => normalizeText(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Pesos escritos por una persona → centavos. `null` si está vacío; lanza si no es un monto. */
export function parsePesos(raw: string): number | null {
  let s = raw.trim().replace(/[$\s]|mxn|pesos/gi, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // El separador que va al final es el decimal: «1,250.50» o «1.250,50».
    s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    s = /,\d{1,2}$/.test(s) && (s.match(/,/g)!.length === 1) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`«${raw.trim()}» no es un precio (usa por ejemplo 1250.50)`);
  const [int, frac = ''] = s.split('.');
  const cents = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_PRICE_CENTS) throw new Error(`«${raw.trim()}» es demasiado grande`);
  return cents;
}

export interface PriceCsvResult {
  items: PriceItemInput[];
  errors: { row: number; message: string }[];
}

/** Lee el CSV. `defaults` da el IVA de los conceptos que no lo dicen. Nunca escribe nada: solo revisa. */
export function parsePriceCsv(text: string, defaults: { iva_mode: IvaMode }): PriceCsvResult {
  const rows = parseCsv(text);
  const errors: PriceCsvResult['errors'] = [];
  if (rows.length < 2) return { items: [], errors: [{ row: 1, message: 'El archivo no tiene filas de precios (la primera fila son los nombres de las columnas)' }] };
  if (rows.length - 1 > PRICE_CSV_MAX_ROWS) return { items: [], errors: [{ row: 1, message: `El archivo admite hasta ${PRICE_CSV_MAX_ROWS} precios` }] };

  const columns = rows[0].map((h) => {
    const key = slug(unprotectCell(h));
    return HEADERS[key] ? { field: HEADERS[key] } : { attribute: key, header: h.trim() };
  });
  const fields = new Set(columns.flatMap((c) => ('field' in c ? [c.field] : [])));
  for (const need of ['code', 'name'] as const) {
    if (!fields.has(need)) errors.push({ row: 1, message: `Falta la columna «${need === 'code' ? 'clave' : 'nombre'}»` });
  }
  for (const c of columns) {
    if ('attribute' in c && c.attribute !== undefined) {
      if (!c.attribute) errors.push({ row: 1, message: 'Hay una columna sin nombre' });
      else if (!/^[a-z_][a-z0-9_]{0,39}$/.test(c.attribute)) errors.push({ row: 1, message: `La columna «${c.header}» no sirve como atributo: usa letras, números o guion bajo, empezando con letra` });
    }
  }
  if (errors.length) return { items: [], errors };

  const items: PriceItemInput[] = [];
  const seen = new Map<string, number>();
  rows.slice(1).forEach((cells, i) => {
    const row = i + 2;
    const get = (f: Field) => {
      const idx = columns.findIndex((c) => 'field' in c && c.field === f);
      return idx >= 0 ? unprotectCell(cells[idx] ?? '').trim() : '';
    };
    try {
      const attributes: Record<string, string> = {};
      columns.forEach((c, idx) => {
        if ('attribute' in c && c.attribute) {
          const v = unprotectCell(cells[idx] ?? '').trim();
          if (v) attributes[c.attribute] = v;
        }
      });
      const min = parsePesos(get('price'));
      const max = parsePesos(get('price_max'));
      const modeWord = slug(get('mode'));
      let price_mode: PriceMode;
      if (modeWord) {
        if (!MODES[modeWord]) throw new Error(`El modo «${get('mode')}» no existe (usa exacto, desde, rango o por confirmar)`);
        price_mode = MODES[modeWord];
      } else price_mode = min === null ? 'tbd' : max !== null ? 'range' : 'exact';
      const ivaWord = slug(get('iva'));
      if (ivaWord && !IVAS[ivaWord]) throw new Error(`El IVA «${get('iva')}» no existe (usa mas, incluido o exento)`);
      const activeWord = slug(get('active'));
      const sortText = get('sort');
      const item: PriceItemInput = {
        code: get('code'),
        name: get('name'),
        description: get('description'),
        unit: get('unit') || 'pieza',
        family: get('family'),
        attributes,
        price_mode,
        price_min: price_mode === 'tbd' ? null : min,
        price_max: price_mode === 'range' ? max : null,
        iva_mode: ivaWord ? IVAS[ivaWord] : defaults.iva_mode,
        active: !activeWord || !['no', 'false', '0', 'inactivo'].includes(activeWord),
        sort: sortText ? Number(sortText) : i,
      };
      if (!Number.isInteger(item.sort) || item.sort < 0 || item.sort > 100000) throw new Error('El orden debe ser un número entero');
      const problem = priceItemProblem(item);
      if (problem) throw new Error(problem);
      const key = item.code.toLowerCase();
      if (seen.has(key)) throw new Error(`La clave «${item.code}» ya está en la fila ${seen.get(key)}`);
      seen.set(key, row);
      items.push(item);
    } catch (e: any) {
      if (errors.length < 50) errors.push({ row, message: e?.message || 'Fila no válida' });
    }
  });
  return { items, errors };
}

/** La lista de precios como CSV (con BOM para Excel), con una columna por atributo. */
export function priceItemsCsv(items: readonly PriceItem[]): string {
  const attrs = [...new Set(items.flatMap((i) => Object.keys(i.attributes ?? {})))].sort();
  const pesos = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2));
  let out = '﻿' + csvRow(['clave', 'nombre', 'familia', 'descripcion', 'unidad', 'modo', 'precio', 'precio_max', 'iva', 'activo', 'orden', ...attrs]);
  for (const i of items) {
    out += csvRow([
      i.code, i.name, i.family, i.description, i.unit, MODE_WORD[i.price_mode], pesos(i.price_min), pesos(i.price_max),
      IVA_WORD[i.iva_mode], i.active ? 'si' : 'no', i.sort, ...attrs.map((a) => i.attributes?.[a] ?? ''),
    ]);
  }
  return out;
}
