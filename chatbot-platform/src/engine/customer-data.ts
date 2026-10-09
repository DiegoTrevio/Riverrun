import type { DataField } from '../types.js';
import { normalize } from './text.js';

const ALIASES: Record<string, string> = {
  name: 'nombre', nombre_cliente: 'nombre', nombre_completo: 'nombre',
  email: 'correo', correo_electronico: 'correo',
  phone: 'telefono', celular: 'telefono', numero_telefono: 'telefono',
};

/** Cómo se llama al cliente en los avisos al equipo. */
export function customerLabel(c: { name?: string; push_name?: string; phone?: string }): string {
  return c.name || c.push_name || c.phone || 'Un cliente';
}

/** Stable keys for answers discovered by the assistant, without a field editor. */
export function automaticField(label: string): DataField | null {
  const raw = normalize(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const key = Object.hasOwn(ALIASES, raw) ? ALIASES[raw] : raw;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', 'proto'].includes(key)) return null;
  const type = key === 'nombre' ? 'name' : key === 'correo' ? 'email' : key === 'telefono' ? 'phone' : 'text';
  return { key, label: key.replace(/_/g, ' '), type, options: [], description: '', required: false, ask_when: '', question: '' };
}

/** Palabras de un texto, sin mayúsculas, acentos ni puntuación ("Col. Centro," → col, centro). */
const words = (s: string) => normalize(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Un valor automático debe salir de lo que escribió el cliente: cada una de sus palabras aparece en algún mensaje suyo. */
export function customerProvided(field: DataField, value: string, sources: string[]): boolean {
  if (field.type === 'phone') {
    const digits = value.replace(/\D/g, '');
    // La IA puede agregar la lada del país ("55 1234 5678" → "525512345678"): basta con que coincidan los últimos 8+ dígitos.
    const same = (p: string) => p === digits || (Math.min(p.length, digits.length) >= 8 && (p.endsWith(digits) || digits.endsWith(p)));
    return sources.some((s) => (s.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []).some((p) => same(p.replace(/\D/g, ''))));
  }
  const wanted = words(value);
  if (!wanted.length) return false;
  return sources.some((s) => {
    const have = new Set(words(s));
    return wanted.every((w) => have.has(w));
  });
}
