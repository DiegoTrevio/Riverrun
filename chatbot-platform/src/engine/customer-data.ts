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
  return { key, label: key.replace(/_/g, ' '), type, options: [], description: '', required: false, ask_when: '' };
}

/** An automatic value must occur in a customer's message, never just the bot's proposal. */
export function customerProvided(field: DataField, value: string, sources: string[]): boolean {
  if (field.type === 'phone') {
    const digits = value.replace(/\D/g, '');
    return sources.some((s) => (s.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []).some((p) => p.replace(/\D/g, '') === digits));
  }
  const escaped = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
  return sources.some((s) => pattern.test(normalize(s)));
}
