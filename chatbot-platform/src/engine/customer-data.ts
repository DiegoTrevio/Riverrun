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
  return { key, label: key.replace(/_/g, ' '), type, options: [], description: '', required: false, ask_when: '', question: '', branches: [] };
}

/** Palabras de un texto, sin mayúsculas, acentos ni puntuación ("Col. Centro," → col, centro). */
const words = (s: string) => normalize(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const NUMBER_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, par: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100,
};
const DATE_CUES = new Set([
  'hoy', 'manana', 'pasado', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'semana', 'mes',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre',
  'noviembre', 'diciembre', 'proximo', 'proxima', 'siguiente', 'quincena', 'navidad',
]);
const YES = new Set(['si', 'claro', 'correcto', 'exacto', 'ok', 'va', 'dale', 'afirmativo', 'sip', 'obvio', 'perfecto', 'sale']);
const NO = new Set(['no', 'nunca', 'tampoco', 'ninguno', 'ninguna', 'negativo', 'jamas', 'nop', 'nel']);

/**
 * ¿El cliente dio este dato? Para los obligatorios: la IA no puede inventarlos para cumplir el objetivo, pero sí
 * normalizarlos ("el 1 de noviembre" → 2026-11-01, "somos dos" → 2, "nunca he venido" → No).
 */
export function customerGave(field: DataField, value: string, sources: string[]): boolean {
  if (customerProvided(field, value, sources)) return true;
  const said = sources.map(words);
  switch (field.type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) && said.some((ws) => ws.some((w) => (/^\d+(?:\.\d+)?$/.test(w) && Number(w) === n) || NUMBER_WORDS[w] === n));
    }
    case 'date':
      // Las fechas se escriben de muchas formas ("mañana", "el 1 de noviembre", "15/11"): basta con que el cliente
      // haya dicho alguna fecha; si no dijo ninguna, la IA la inventó.
      return said.some((ws) => ws.some((w) => /\d/.test(w) || DATE_CUES.has(w)));
    case 'option': {
      const kind = normalize(value);
      if (kind === 'si' || kind === 'no') return said.some((ws) => ws.some((w) => (kind === 'si' ? YES : NO).has(w)));
      return sameMeaning(value, said);
    }
    case 'phone':
      return false;
    default:
      return sameMeaning(value, said);
  }
}

/**
 * Al menos la mitad de las palabras con significado del valor aparecen en un mensaje del cliente: por su raíz
 * ("doble" ↔ "dobles"), abreviadas por el cliente ("nov" ↔ "noviembre") o, si son cifras, iguales ("1 al 3").
 */
function sameMeaning(value: string, said: string[][]): boolean {
  const key = words(value).filter((w) => w.length >= 3 || /\d/.test(w));
  if (!key.length) return false;
  const stem = (w: string) => w.slice(0, Math.max(3, w.length - 2));
  const matches = (k: string, w: string) => (/\d/.test(k) ? w === k : w.startsWith(stem(k)) || (w.length >= 3 && k.startsWith(w)));
  return said.some((ws) => key.filter((k) => ws.some((w) => matches(k, w))).length * 2 >= key.length);
}

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
