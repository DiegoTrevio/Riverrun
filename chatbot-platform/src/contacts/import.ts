/**
 * Importar contactos desde CSV (panel, solo administradores). Alta o actualización por teléfono en un canal de WhatsApp
 * (el mismo camino que POST /api/v1/contacts) o por correo en un canal de correo (una base para campañas de correo). Las
 * columnas de datos se reconocen por la clave o la etiqueta del campo de la cuenta, así un archivo exportado se puede
 * volver a importar. Una celda vacía no borra nada.
 *
 * No dispara reglas («dato capturado», «etiqueta agregada»): importar mil contactos no debe mandar mil mensajes.
 * Nunca quita una baja: quien se dio de baja, o cuyo correo rebotó o se quejó, sigue fuera aunque venga en el archivo.
 */
import { normalize } from '../engine/text.js';
import { query, queryOne } from '../db.js';
import { parseAddress } from '../channels/email-inbound.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { parseCsv, unprotectCell } from './csv.js';
import { cleanFieldValue, type ContactField, TYPE_LABELS } from './fields.js';

export const IMPORT_MAX_ROWS = 5000;

export interface ImportResult {
  created: number;
  updated: number;
  /** Correos que ya estaban dados de baja (o rebotaron o se quejaron): se importan, pero siguen sin recibir campañas. */
  suppressed: number;
  /** Filas que no se importaron (número de fila del archivo, contando el encabezado como la 1). */
  errors: { row: number; error: string }[];
  /** Encabezados que no corresponden a ningún campo. */
  ignored_columns: string[];
}

export const columnKey = (s: string) => normalize(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const key = columnKey;
const PHONE = new Set(['telefono', 'phone', 'celular', 'whatsapp', 'movil']);
const EMAIL = new Set(['correo', 'email', 'e_mail', 'correo_electronico', 'mail']);
const NAME = new Set(['nombre', 'name', 'nombre_completo', 'cliente']);
const TAGS = new Set(['etiquetas', 'tags', 'etiqueta']);
/** Encabezados que la importación lee como teléfono, nombre o etiquetas: un campo no puede llamarse así. */
export const isImportColumn = (s: string) => [PHONE, EMAIL, NAME, TAGS].some((set) => set.has(columnKey(s)));
// Columnas de la exportación que no se importan.
const EXPORT_ONLY = new Set(['id', 'nombre_en_el_canal', 'canal', 'tipo_de_canal', 'dado_de_baja', 'fecha_de_baja', 'conversaciones', 'ultimo_mensaje', 'creado', 'otros_datos', 'notas']);

export function importColumns(header: string[], fields: ContactField[]) {
  const byKey = new Map<string, ContactField>();
  for (const f of fields) { byKey.set(f.key, f); byKey.set(key(f.label), f); }
  const cols: ({ kind: 'phone' | 'email' | 'name' | 'tags' } | { kind: 'field'; field: ContactField } | null)[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const h of header) {
    const k = key(h);
    const f = byKey.get(k);
    const col = PHONE.has(k) ? { kind: 'phone' as const } : EMAIL.has(k) ? { kind: 'email' as const } : NAME.has(k) ? { kind: 'name' as const } : TAGS.has(k) ? { kind: 'tags' as const } : f ? { kind: 'field' as const, field: f } : null;
    const id = col ? (col.kind === 'field' ? `f:${col.field.key}` : col.kind) : '';
    // Una columna repetida se toma una vez (la primera).
    if (col && !seen.has(id)) { seen.add(id); cols.push(col); }
    else { cols.push(null); if (h.trim() && !EXPORT_ONLY.has(k) && !col) ignored.push(h.trim()); }
  }
  return { cols, ignored, hasPhone: seen.has('phone'), hasEmail: seen.has('email') };
}

/** Quién dice el negocio que aceptó recibir sus correos, y de dónde salió la base (queda en cada contacto). */
export interface ImportConsent {
  /** El negocio confirma que estas personas aceptaron recibir sus promociones. */
  confirmed: boolean;
  /** De dónde salió la base: «Formulario de mi sitio», «Clientes de la tienda 2025»… */
  source: string;
}

const CONSENT_SOURCE_MAX = 120;
/** Texto que queda en consent_source de cada contacto importado con consentimiento. */
export const importConsentSource = (source: string) => `importación: ${source.replace(/\s+/g, ' ').trim().slice(0, CONSENT_SOURCE_MAX)}`;

export async function importContacts(channel: Pick<Channel, 'id' | 'account_id'> & { type?: Channel['type'] }, csv: string, fields: ContactField[], consent?: ImportConsent): Promise<ImportResult> {
  const byEmail = channel.type === 'email';
  const rows = parseCsv(csv);
  if (!rows.length) throw new ImportError('El archivo está vacío');
  const { cols, ignored, hasPhone, hasEmail } = importColumns(rows[0], fields);
  if (byEmail && !hasEmail) throw new ImportError('Falta la columna «correo»');
  if (!byEmail && !hasPhone) throw new ImportError('Falta la columna «telefono»');
  if (byEmail && !consent?.source.trim()) throw new ImportError('Escribe de dónde salió esta base de correos');
  if (rows.length - 1 > IMPORT_MAX_ROWS) throw new ImportError(`Hasta ${IMPORT_MAX_ROWS.toLocaleString('es-MX')} contactos por archivo; divídelo en partes`);
  const result: ImportResult = { created: 0, updated: 0, suppressed: 0, errors: [], ignored_columns: ignored };
  const seenKeys = new Set<string>();
  for (const [i, cells] of rows.slice(1).entries()) {
    const rowNo = i + 2;
    let phone = '';
    let email = '';
    let name = '';
    let tags: string[] = [];
    const data: Record<string, string> = {};
    const problems: string[] = [];
    cols.forEach((col, j) => {
      const raw = unprotectCell((cells[j] ?? '').trim());
      if (!col || !raw) return;
      if (col.kind === 'phone') phone = raw.replace(/\D/g, '');
      else if (col.kind === 'email') email = raw;
      else if (col.kind === 'name') name = raw.slice(0, 100);
      else if (col.kind === 'tags') tags = raw.split(/[;|]/).map((t) => t.trim().slice(0, 60)).filter(Boolean);
      else if (col.kind === 'field') {
        const f = col.field;
        const clean = cleanFieldValue(f, raw);
        if (clean === null) problems.push(`«${f.label}» no es válido${f.type === 'option' ? ` (opciones: ${f.options.join(', ')})` : ` como ${TYPE_LABELS[f.type]}`}: ${raw.slice(0, 40)}`);
        else if (clean) data[f.key] = clean;
      }
    });
    const address = byEmail ? parseAddress(email).address : '';
    const badPhone = phone.length < 8 || phone.length > 15;
    const keyOf = byEmail ? address : phone;
    if (byEmail && !address) problems.unshift(email ? `Correo inválido: ${email.slice(0, 80)}` : 'Falta el correo');
    else if (!byEmail && badPhone) problems.unshift(phone ? `Teléfono inválido: ${phone} (con lada de país, p. ej. 5215512345678)` : 'Falta el teléfono');
    else if (seenKeys.has(keyOf)) problems.unshift(byEmail ? 'Correo repetido en el archivo' : 'Teléfono repetido en el archivo');
    if (problems.length) { result.errors.push({ row: rowNo, error: problems.join('; ') }); continue; }
    seenKeys.add(keyOf);
    const externalId = byEmail ? address : `${phone}@s.whatsapp.net`;
    const existed = await store.findContact(channel.id, externalId);
    // En un canal de correo el teléfono es un dato más (opcional): uno inválido no se guarda.
    const contact = await store.upsertContact(channel, externalId, byEmail && badPhone ? '' : phone, '');
    await store.getOrCreateConversation(channel as Channel, contact.id);
    if (name || tags.length) await store.updateContactFromPanel(contact.id, { name: name || undefined, tags: tags.length ? [...new Set([...contact.tags, ...tags])].slice(0, 50) : undefined });
    // Se combina en la base: un dato que la IA guarde en este momento no se pierde.
    if (Object.keys(data).length) await query(`UPDATE contacts SET data = data || $2::jsonb, updated_at = now() WHERE id = $1`, [contact.id, JSON.stringify(data)]);
    // Consentimiento: solo se agrega (nunca quita uno que ya tenía, ni cambia su fecha u origen).
    if (consent?.confirmed && consent.source.trim()) {
      await query(`UPDATE contacts SET consent_at = now(), consent_source = $2, updated_at = now() WHERE id = $1 AND consent_at IS NULL`, [contact.id, importConsentSource(consent.source)]);
    }
    if (byEmail && ((await suppressIfListed(channel.account_id, contact.id, address)) || contact.opted_out)) result.suppressed++;
    if (existed) result.updated++;
    else result.created++;
  }
  return result;
}

/** Si el correo está en la lista de bajas del negocio, el contacto queda dado de baja (aunque sea nuevo). */
async function suppressIfListed(accountId: string, contactId: string, address: string): Promise<boolean> {
  const listed = await queryOne(`SELECT 1 FROM email_suppressions WHERE account_id = $1 AND address = $2`, [accountId, address]);
  if (!listed) return false;
  await query(`UPDATE contacts SET opted_out = true, opted_out_at = COALESCE(opted_out_at, now()), updated_at = now() WHERE id = $1 AND NOT opted_out`, [contactId]);
  return true;
}

export class ImportError extends Error {}
