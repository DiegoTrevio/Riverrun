import type { DataField } from '../types.js';
import { normalize, spokenNumbers } from './text.js';

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

// Palabras que dan una fecha: un día de la semana, un mes o "hoy / mañana / la próxima semana".
const DATE_CUES = new Set([
  'hoy', 'manana', 'pasado', 'finde', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'semana', 'mes',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre',
  'noviembre', 'diciembre', 'proximo', 'proxima', 'siguiente', 'quincena', 'navidad',
]);
// "Esta noche", "ese día", "ahorita" también dan una fecha; "buen día" o "buenas noches" son un saludo.
const SOFT_DATE_CUES = new Set(['dia', 'dias', 'noche', 'tarde', 'ahora', 'ahorita', 'temprano', 'madrugada']);
const GREETING = new Set(['buen', 'buena', 'buenas', 'buenos']);
const YES = new Set(['si', 'claro', 'correcto', 'exacto', 'ok', 'va', 'dale', 'afirmativo', 'sip', 'obvio', 'perfecto', 'sale', 'confirmo', 'esa', 'ese']);
const NO = new Set(['no', 'nunca', 'tampoco', 'ninguno', 'ninguna', 'negativo', 'jamas', 'nop', 'nel']);
const ORDINALS: Record<string, number> = { primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5, ultima: -1, ultimo: -1 };

/** ¿El cliente dijo que sí? ("sí", "claro, esa", "ok perfecto"). */
export const affirms = (text: string) => words(text).some((w) => YES.has(w)) && !words(text).some((w) => NO.has(w));

/**
 * ¿El cliente dio este dato? Para los obligatorios: la IA no puede inventarlos para cumplir el objetivo, pero sí
 * normalizarlos ("el 1 de noviembre" → 2026-11-01, "somos dos" → 2, "nunca he venido" → No).
 */
export function customerGave(field: DataField, value: string, sources: string[]): boolean {
  if (customerProvided(field, value, sources)) return true;
  const said = sources.map(words);
  switch (field.type) {
    case 'number': {
      // Una cifra que dijo, o la suma de las que dijo en un mensaje ("2 adultos y 1 niño" → 3; en "una habitación para
      // 2 adultos y 1 niño" también se suman solo las cifras).
      const n = Number(value);
      const sum = (ns: number[]) => ns.length > 1 && ns.reduce((a, b) => a + b, 0) === n;
      return Number.isFinite(n) && sources.some((s) => {
        const ns = spokenNumbers(s);
        return ns.includes(n) || sum(ns) || sum((normalize(s).replace(/(\d)[.,](?=\d{3}(?!\d))/g, '$1').match(/\d+/g) ?? []).map(Number));
      });
    }
    case 'date':
      // Las fechas se escriben de muchas formas ("mañana", "el 1 de noviembre", "15/11"): basta con que el cliente
      // haya dicho alguna fecha (una cifra o un día, mes o "mañana"); si no dijo ninguna, la IA la inventó.
      return said.some((ws) => ws.some((w, i) => /\d/.test(w) || DATE_CUES.has(w) || (SOFT_DATE_CUES.has(w) && !GREETING.has(ws[i - 1]))));
    case 'option': {
      // Opciones de sí o no ("Sí, quiero factura", "No"): basta con el sí o el no del cliente.
      const first = words(value)[0];
      if ((first === 'si' || first === 'no') && said.some((ws) => ws.some((w) => (first === 'si' ? YES : NO).has(w)))) return true;
      // Por su número u orden en la lista ("la segunda", "opción 2").
      const index = field.options.findIndex((o) => normalize(o) === normalize(value)) + 1;
      if (index > 0 && field.options.length > 1 && said.some((ws) => ws.some((w) => {
        const o = ORDINALS[w];
        return (o === -1 ? field.options.length : o) === index || (/^\d+$/.test(w) && Number(w) === index);
      }))) return true;
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

/**
 * Para un texto libre que la IA resume con sus palabras ("quiero reservar una doble" → "Reservación de habitación doble"):
 * basta con que una palabra con significado (4+ letras o una cifra) salga de lo que escribió el cliente. Un valor
 * inventado no comparte ninguna.
 */
export function customerMentioned(value: string, sources: string[]): boolean {
  const key = words(value).filter((w) => w.length >= 4 || /\d/.test(w));
  const said = sources.map(words);
  const stem = (w: string) => w.slice(0, Math.max(4, w.length - 3));
  return key.some((k) => said.some((ws) => ws.some((w) => (/\d/.test(k) ? w === k : w.length >= 4 && (w.startsWith(stem(k)) || k.startsWith(stem(w)))))));
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
