/**
 * Apartado "Preguntas": datos con una pregunta exacta que el asistente hace en orden, una a la vez.
 * El sistema (no la IA) sabe cuál sigue, la hace cumplir y detecta cuándo se terminaron.
 */
import type { Chatbot, DataField } from '../types.js';
import { normalize } from './text.js';

export type Question = DataField;

/** Preguntas del asistente, en el orden configurado (los datos sin pregunta no cuentan). */
export function questionList(bot: Pick<Chatbot, 'data_fields'>): Question[] {
  return bot.data_fields.filter((f) => !!f.question.trim());
}

/** ¿El cliente ya respondió? El nombre también cuenta si ya está en la ficha del contacto. */
export function isAnswered(q: Pick<Question, 'key' | 'type'>, data: Record<string, string>, name?: string | null): boolean {
  if (String(data[q.key] ?? '').trim()) return true;
  return q.type === 'name' && !!name;
}

export interface QuestionProgress {
  answered: Question[];
  /** Opcionales que ya se preguntaron sin respuesta: se dejan pasar para no atorar el recorrido. */
  skipped: Question[];
  /** La que sigue (null = todas respondidas o saltadas). */
  next: Question | null;
  /** Obligatorias que aún no tienen respuesta. */
  missingRequired: Question[];
}

/**
 * Avance con los datos conocidos. `asked` = cuántas veces se hizo cada pregunta en el recorrido actual.
 * Una obligatoria se sigue preguntando hasta tener respuesta; una opcional, una sola vez.
 */
export function questionProgress(questions: Question[], data: Record<string, string>, name?: string | null, asked: Record<string, number> = {}): QuestionProgress {
  const out: QuestionProgress = { answered: [], skipped: [], next: null, missingRequired: [] };
  for (const q of questions) {
    if (isAnswered(q, data, name)) {
      out.answered.push(q);
      continue;
    }
    if (q.required) out.missingRequired.push(q);
    else if ((asked[q.key] ?? 0) >= 1) {
      out.skipped.push(q);
      continue;
    }
    out.next ??= q;
  }
  return out;
}

// Palabras que no distinguen una pregunta de otra.
const STOP = new Set(['que', 'cual', 'cuales', 'como', 'cuando', 'donde', 'quien', 'para', 'por', 'con', 'sin', 'una', 'uno', 'unos', 'unas', 'los', 'las', 'del', 'tus', 'sus', 'nos', 'les', 'tiene', 'tienes', 'esta', 'este', 'estas', 'esto', 'eso', 'hay', 'mas', 'muy', 'pero', 'porque', 'puedes', 'puede', 'podrias', 'podria', 'gustaria', 'favor', 'quieres', 'quiere']);
const clean = (s: string) => normalize(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const keyWords = (s: string) => [...new Set(clean(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))];

/** ¿El texto hace esta pregunta? Cuenta la pregunta exacta o casi todas sus palabras clave (la IA puede adaptarla un poco). */
export function asksQuestion(text: string, q: Pick<Question, 'question'>): boolean {
  const want = clean(q.question);
  if (!want) return false;
  const have = clean(text);
  if (have.includes(want)) return true;
  const words = keyWords(q.question);
  // Una pregunta muy corta solo se reconoce completa.
  if (words.length < 2) return false;
  const got = new Set(keyWords(text));
  return words.filter((w) => got.has(w)).length / words.length >= 0.7;
}
