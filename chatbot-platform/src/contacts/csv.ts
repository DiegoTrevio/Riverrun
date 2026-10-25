/** Lector de CSV pequeño para importar contactos: comillas, comas o punto y coma, saltos de línea dentro de comillas y BOM. */

/** Separador del archivo: el que más aparece en la primera línea fuera de comillas (Excel en español guarda con «;»). */
function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return (n ? best : ',') as ',' | ';' | '\t';
}

/** Filas del archivo, cada una con sus celdas. Las filas vacías se omiten. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const sep = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/** Una celda que la exportación protegió contra fórmulas ('=…) vuelve a su texto original. */
export const unprotectCell = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
