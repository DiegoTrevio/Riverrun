/** Exportación a CSV: escritura segura (Excel/Sheets), en bloques y con protección contra inyección de fórmulas. */
import { Readable } from 'node:stream';

const BOM = '﻿';

/**
 * Una celda de CSV. Los textos que empiezan con = + - @ (o tabulador/retorno) se interpretarían como fórmulas en Excel
 * y Google Sheets: un cliente podría escribir "=HYPERLINK(...)" como nombre o mensaje, así que se neutralizan con un apóstrofo.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n';

/**
 * Flujo CSV: escribe el encabezado y pide filas en bloques (`next` devuelve las siguientes o [] al terminar),
 * así una cuenta grande no se carga completa en memoria. `maxRows` pone un tope.
 */
export function csvStream<T>(header: string[], next: (cursor: T | null) => Promise<{ rows: unknown[][]; cursor: T | null }>, maxRows = 500_000): Readable {
  async function* gen() {
    yield BOM + csvRow(header);
    let cursor: T | null = null;
    let total = 0;
    for (;;) {
      const batch = await next(cursor);
      if (!batch.rows.length) break;
      for (const r of batch.rows) {
        if (total++ >= maxRows) return;
        yield csvRow(r);
      }
      if (!batch.cursor) break;
      cursor = batch.cursor;
    }
  }
  return Readable.from(gen());
}

export const exportFilename = (kind: string, now = new Date()) => `${kind}-${now.toISOString().slice(0, 10)}.csv`;
