/**
 * «Datos de tus clientes»: los campos propios de cada negocio (fecha de cumpleaños, número de cliente, plan…), con su
 * etiqueta y su tipo. Los valores viven en contacts.data como texto; aquí solo está su definición. El asistente los
 * reconoce si el cliente los da, pero no los pide: lo que pide cada agente sigue en sus propios datos a recopilar.
 */
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import type { DataField } from '../types.js';

export const CONTACT_FIELD_TYPES = ['text', 'number', 'date', 'option', 'email', 'phone'] as const;
export type ContactFieldType = (typeof CONTACT_FIELD_TYPES)[number];

export interface ContactField {
  id: string;
  account_id: string;
  key: string;
  label: string;
  type: ContactFieldType;
  options: string[];
  sort: number;
  created_at: Date;
  updated_at: Date;
}

/** Claves que ya usa el contacto por su cuenta: un campo con ese nombre se confundiría con el nombre o el teléfono. */
const RESERVED = new Set(['nombre', 'name', 'telefono', 'phone', 'constructor', 'prototype', 'proto']);

const fields = {
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Solo minúsculas, números y guion bajo, empezando con una letra')
    .refine((k) => !RESERVED.has(k), 'Esa clave ya la usa el contacto (nombre o teléfono): elige otra'),
  label: z.string().trim().min(1, 'Escribe la etiqueta').max(80),
  type: z.enum(CONTACT_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(100)).max(50),
};
const optionsOk = (f: { type?: string; options?: string[] }) => f.type !== 'option' || (f.options?.length ?? 0) > 0;
const OPTIONS_MSG = { message: 'Una lista de opciones necesita al menos una opción', path: ['options'] };
export const ContactFieldBody = z.object({ ...fields, type: fields.type.default('text'), options: fields.options.default([]) }).refine(optionsOk, OPTIONS_MSG);
/** Al editar no cambia la clave: los valores guardados y las variables {{campo.clave}} dependen de ella. */
export const ContactFieldPatch = z.object({ label: fields.label, type: fields.type, options: fields.options }).partial();

const COLS = 'id, account_id, key, label, type, options, sort, created_at, updated_at';

export async function listContactFields(accountId: string): Promise<ContactField[]> {
  return query<ContactField>(`SELECT ${COLS} FROM contact_fields WHERE account_id = $1 ORDER BY sort, created_at`, [accountId]);
}

export async function getContactField(id: string): Promise<ContactField | null> {
  return queryOne<ContactField>(`SELECT ${COLS} FROM contact_fields WHERE id = $1`, [id]);
}

export async function createContactField(accountId: string, b: z.infer<typeof ContactFieldBody>): Promise<ContactField | null> {
  return queryOne<ContactField>(
    `INSERT INTO contact_fields (account_id, key, label, type, options, sort)
     VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(sort) + 1 FROM contact_fields WHERE account_id = $1), 0))
     ON CONFLICT (account_id, key) DO NOTHING RETURNING ${COLS}`,
    [accountId, b.key, b.label, b.type, JSON.stringify(b.type === 'option' ? b.options : [])],
  );
}

export async function updateContactField(f: ContactField, b: z.infer<typeof ContactFieldPatch>): Promise<ContactField> {
  const merged = { ...f, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as ContactField;
  return (await queryOne<ContactField>(
    `UPDATE contact_fields SET label = $2, type = $3, options = $4, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
    [f.id, merged.label, merged.type, JSON.stringify(merged.type === 'option' ? merged.options : [])],
  ))!;
}

export async function deleteContactField(id: string) {
  await query('DELETE FROM contact_fields WHERE id = $1', [id]);
}

/** Nuevo orden: los ids que no son de la cuenta se ignoran; los que faltan quedan al final en su orden actual. */
export async function reorderContactFields(accountId: string, ids: string[]) {
  await withTransaction(async (c) => {
    const current = (await c.query<{ id: string }>(`SELECT id FROM contact_fields WHERE account_id = $1 ORDER BY sort, created_at FOR UPDATE`, [accountId])).rows.map((r) => r.id);
    const order = [...ids.filter((id) => current.includes(id)), ...current.filter((id) => !ids.includes(id))];
    for (const [i, id] of [...new Set(order)].entries()) await c.query(`UPDATE contact_fields SET sort = $2, updated_at = now() WHERE id = $1`, [id, i]);
  });
}

/** El campo de la cuenta como un dato que el asistente entiende (para validar su tipo al guardarlo). */
export function asDataField(f: Pick<ContactField, 'key' | 'label' | 'type' | 'options'>): DataField {
  return { key: f.key, label: f.label, type: f.type, options: f.options, description: '', required: false, ask_when: '', question: '', branches: [] };
}

/** Valor que se escribe en el panel o se importa: se normaliza por su tipo. null = no es válido para ese tipo. */
export function cleanFieldValue(f: Pick<ContactField, 'type' | 'options'>, raw: string): string | null {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (!v) return '';
  if (v.length > 500) return null;
  switch (f.type) {
    case 'number': {
      const n = v.replace(/[\s,$]/g, '');
      return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
    }
    case 'date': {
      // AAAA-MM-DD, o DD/MM/AAAA como se escribe en México.
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const mx = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
      const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : mx ? [+mx[3], +mx[2], +mx[1]] : [0, 0, 0];
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (!y || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    case 'option': {
      const lower = v.toLocaleLowerCase('es');
      return f.options.find((o) => o.toLocaleLowerCase('es') === lower) ?? null;
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null;
    case 'phone': {
      const digits = v.replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15 ? v.replace(/[^\d+]/g, '') : null;
    }
    default:
      return v;
  }
}

/**
 * Cómo se lee el valor en un mensaje: la fecha en palabras y con su año («3 de noviembre de 1990»; sin día de la
 * semana, que en un cumpleaños sería el de aquel año); lo demás, tal cual.
 */
export function displayFieldValue(f: Pick<ContactField, 'type'> | undefined, value: string): string {
  if (f?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  return value;
}

export const TYPE_LABELS: Record<ContactFieldType, string> = { text: 'texto', number: 'número', date: 'fecha', option: 'opción', email: 'correo', phone: 'teléfono' };
