/**
 * Importar contactos desde CSV (panel, solo administradores). Alta o actualización por teléfono en un canal de WhatsApp:
 * el mismo camino que POST /api/v1/contacts. Las columnas de datos se reconocen por la clave o la etiqueta del campo de
 * la cuenta, así un archivo exportado se puede volver a importar. Una celda vacía no borra nada.
 *
 * No dispara reglas («dato capturado», «etiqueta agregada»): importar mil contactos no debe mandar mil mensajes.
 */
import { normalize } from '../engine/text.js';
import { query } from '../db.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { parseCsv, unprotectCell } from './csv.js';
import { cleanFieldValue, type ContactField, TYPE_LABELS } from './fields.js';

export const IMPORT_MAX_ROWS = 5000;

export interface ImportResult {
  created: number;
  updated: number;
  /** Filas que no se importaron (número de fila del archivo, contando el encabezado como la 1). */
  errors: { row: number; error: string }[];
  /** Encabezados que no corresponden a ningún campo. */
  ignored_columns: string[];
}

export const columnKey = (s: string) => normalize(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const key = columnKey;
const PHONE = new Set(['telefono', 'phone', 'celular', 'whatsapp', 'movil']);
const NAME = new Set(['nombre', 'name', 'nombre_completo', 'cliente']);
const TAGS = new Set(['etiquetas', 'tags', 'etiqueta']);
/** Encabezados que la importación lee como teléfono, nombre o etiquetas: un campo no puede llamarse así. */
export const isImportColumn = (s: string) => [PHONE, NAME, TAGS].some((set) => set.has(columnKey(s)));
// Columnas de la exportación que no se importan.
const EXPORT_ONLY = new Set(['id', 'nombre_en_el_canal', 'canal', 'tipo_de_canal', 'dado_de_baja', 'fecha_de_baja', 'conversaciones', 'ultimo_mensaje', 'creado', 'otros_datos', 'notas']);

export function importColumns(header: string[], fields: ContactField[]) {
  const byKey = new Map<string, ContactField>();
  for (const f of fields) { byKey.set(f.key, f); byKey.set(key(f.label), f); }
  const cols: ({ kind: 'phone' | 'name' | 'tags' } | { kind: 'field'; field: ContactField } | null)[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const h of header) {
    const k = key(h);
    const f = byKey.get(k);
    const col = PHONE.has(k) ? { kind: 'phone' as const } : NAME.has(k) ? { kind: 'name' as const } : TAGS.has(k) ? { kind: 'tags' as const } : f ? { kind: 'field' as const, field: f } : null;
    const id = col ? (col.kind === 'field' ? `f:${col.field.key}` : col.kind) : '';
    // Una columna repetida se toma una vez (la primera).
    if (col && !seen.has(id)) { seen.add(id); cols.push(col); }
    else { cols.push(null); if (h.trim() && !EXPORT_ONLY.has(k) && !col) ignored.push(h.trim()); }
  }
  return { cols, ignored, hasPhone: seen.has('phone') };
}

export async function importContacts(channel: Pick<Channel, 'id' | 'account_id'>, csv: string, fields: ContactField[]): Promise<ImportResult> {
  const rows = parseCsv(csv);
  if (!rows.length) throw new ImportError('El archivo está vacío');
  const { cols, ignored, hasPhone } = importColumns(rows[0], fields);
  if (!hasPhone) throw new ImportError('Falta la columna «telefono»');
  if (rows.length - 1 > IMPORT_MAX_ROWS) throw new ImportError(`Hasta ${IMPORT_MAX_ROWS.toLocaleString('es-MX')} contactos por archivo; divídelo en partes`);
  const result: ImportResult = { created: 0, updated: 0, errors: [], ignored_columns: ignored };
  const seenPhones = new Set<string>();
  for (const [i, cells] of rows.slice(1).entries()) {
    const rowNo = i + 2;
    let phone = '';
    let name = '';
    let tags: string[] = [];
    const data: Record<string, string> = {};
    const problems: string[] = [];
    cols.forEach((col, j) => {
      const raw = unprotectCell((cells[j] ?? '').trim());
      if (!col || !raw) return;
      if (col.kind === 'phone') phone = raw.replace(/\D/g, '');
      else if (col.kind === 'name') name = raw.slice(0, 100);
      else if (col.kind === 'tags') tags = raw.split(/[;|]/).map((t) => t.trim().slice(0, 60)).filter(Boolean);
      else if (col.kind === 'field') {
        const f = col.field;
        const clean = cleanFieldValue(f, raw);
        if (clean === null) problems.push(`«${f.label}» no es válido${f.type === 'option' ? ` (opciones: ${f.options.join(', ')})` : ` como ${TYPE_LABELS[f.type]}`}: ${raw.slice(0, 40)}`);
        else if (clean) data[f.key] = clean;
      }
    });
    if (phone.length < 8 || phone.length > 15) problems.unshift(phone ? `Teléfono inválido: ${phone} (con lada de país, p. ej. 5215512345678)` : 'Falta el teléfono');
    else if (seenPhones.has(phone)) problems.unshift('Teléfono repetido en el archivo');
    if (problems.length) { result.errors.push({ row: rowNo, error: problems.join('; ') }); continue; }
    seenPhones.add(phone);
    const externalId = `${phone}@s.whatsapp.net`;
    const existed = await store.findContact(channel.id, externalId);
    const contact = await store.upsertContact(channel, externalId, phone, '');
    await store.getOrCreateConversation(channel as Channel, contact.id);
    if (name || tags.length) await store.updateContactFromPanel(contact.id, { name: name || undefined, tags: tags.length ? [...new Set([...contact.tags, ...tags])].slice(0, 50) : undefined });
    // Se combina en la base: un dato que la IA guarde en este momento no se pierde.
    if (Object.keys(data).length) await query(`UPDATE contacts SET data = data || $2::jsonb, updated_at = now() WHERE id = $1`, [contact.id, JSON.stringify(data)]);
    if (existed) result.updated++;
    else result.created++;
  }
  return result;
}

export class ImportError extends Error {}
