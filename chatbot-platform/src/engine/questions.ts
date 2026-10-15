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

/** ¿Se vuelve a preguntar en cada solicitud nueva? Por omisión sí, salvo nombre, correo y teléfono. */
export function repeatsEachRequest(q: Pick<Question, 'type' | 'per_request'>): boolean {
  return q.per_request ?? !['name', 'email', 'phone'].includes(q.type);
}

/**
 * Datos que se vuelven a pedir en cada solicitud (sus respuestas se archivan al empezar otra). Las preguntas, salvo
 * nombre, correo y teléfono. Los datos sin pregunta, solo fechas y cantidades (una segunda reserva no se cumple con las
 * fechas de la anterior); la dirección, la empresa o el RFC se conservan. `per_request` siempre manda.
 */
export function perRequestKeys(bot: Pick<Chatbot, 'data_fields'>): string[] {
  return bot.data_fields
    .filter((f) => (f.question.trim() ? repeatsEachRequest(f) : f.per_request ?? ['date', 'number'].includes(f.type)))
    .map((f) => f.key);
}

/**
 * Dato que corresponde al nombre del contacto: `nombre` si existe; si no, el primer dato de tipo nombre.
 * Otros datos de tipo nombre ("¿Cómo se llama el festejado?") son de otra persona y no tocan la ficha.
 */
export function contactNameKey(fields: Pick<DataField, 'key' | 'type'>[]): string {
  return fields.find((f) => f.key === 'nombre')?.key ?? fields.find((f) => f.type === 'name')?.key ?? 'nombre';
}

/** ¿El cliente ya respondió? El dato del nombre también cuenta si ya está en la ficha del contacto. */
export function isAnswered(q: Pick<Question, 'key'>, data: Record<string, string>, name?: string | null, nameKey = 'nombre'): boolean {
  if (String(data[q.key] ?? '').trim()) return true;
  return q.key === nameKey && !!name;
}

/** Camino que marca la respuesta a una pregunta de opción (null = sigue en orden). */
export function branchFor(q: Question, answer: string): string | null {
  const a = normalize(answer.trim());
  if (!a || q.type !== 'option') return null;
  return q.branches.find((b) => b.goto && normalize(b.option.trim()) === a)?.goto ?? null;
}

export interface QuestionProgress {
  answered: Question[];
  /** No aplican por las respuestas del cliente (un camino las saltó o terminó las preguntas): no se hacen. */
  notApplicable: Question[];
  /** La respuesta a esta pregunta pasa la conversación a una persona. */
  handoff: { question: Question; answer: string } | null;
  /** Opcionales que ya se preguntaron sin respuesta: se dejan pasar para no atorar el recorrido. */
  skipped: Question[];
  /** La que sigue (null = todas respondidas o saltadas). */
  next: Question | null;
  /** Obligatorias que aún no tienen respuesta. */
  missingRequired: Question[];
}

/**
 * Avance con los datos conocidos, siguiendo los caminos que marcan las respuestas. `asked` = cuántas veces se hizo cada
 * pregunta en el recorrido actual;
 * `askedEver`, en toda la conversación. Una obligatoria se sigue preguntando hasta tener respuesta; una opcional,
 * una sola vez (aunque la conversación se reabra después).
 */
export function questionProgress(
  questions: Question[],
  data: Record<string, string>,
  name?: string | null,
  asked: Record<string, number> = {},
  opts: { askedEver?: Record<string, number>; nameKey?: string } = {},
): QuestionProgress {
  const out: QuestionProgress = { answered: [], notApplicable: [], handoff: null, skipped: [], next: null, missingRequired: [] };
  const ever = opts.askedEver ?? asked;
  // Camino marcado por una respuesta: saltar hasta esa pregunta, o terminar (también al pasar con una persona).
  let jumpTo: string | null = null;
  let stopped = false;
  for (const [i, q] of questions.entries()) {
    if (stopped || (jumpTo && q.key !== jumpTo)) {
      out.notApplicable.push(q);
      continue;
    }
    jumpTo = null;
    if (isAnswered(q, data, name, opts.nameKey)) {
      out.answered.push(q);
      const route = branchFor(q, String(data[q.key] ?? ''));
      if (route === 'end') stopped = true;
      else if (route === 'handoff') {
        stopped = true;
        out.handoff = { question: q, answer: String(data[q.key]) };
      } else if (route && questions.slice(i + 1).some((x) => x.key === route)) jumpTo = route;
      continue;
    }
    if (q.required) out.missingRequired.push(q);
    else if (Math.max(asked[q.key] ?? 0, ever[q.key] ?? 0) >= 1) {
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
// Una oración que pregunta ("¿…?") o pide un dato ("Dime tu nombre", "¿Me compartes tu correo?").
const REQUEST_RE = /^(?:(?:por favor|oye|ok|va|perfecto|claro|listo|genial|gracias)[,.!]?\s+)*(?:dime|digame|comparte(?:me|nos)|compartame|compartanos|indica(?:me|nos)|indique(?:me|nos)|pasa(?:me|nos)|manda(?:me|nos)|escribe(?:me|nos)|confirma(?:me|nos)|cuenta(?:me|nos)|cuentanos|ayudame con|me (?:das|da|compartes|comparte|indicas|indica|pasas|pasa|confirmas|confirma|dices|dice)|nos (?:das|da|compartes|comparte|indicas|indica|pasas|pasa|confirmas|confirma|dices|dice))\b/;
const asking = (sentence: string) => /[?¿]/.test(sentence) || REQUEST_RE.test(normalize(sentence));
const splitSentences = (text: string) => text.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

/**
 * ¿El texto hace esta pregunta? Cuenta la pregunta exacta, o una oración que pregunta o pide algo con casi todas
 * sus palabras clave (la IA puede adaptarla un poco). Una afirmación ("Puedes reservar para esa fecha") no la hace.
 */
export function asksQuestion(text: string, q: Pick<Question, 'question'>): boolean {
  const want = clean(q.question);
  if (!want) return false;
  if (clean(text).includes(want)) return true;
  const words = keyWords(q.question);
  // Una pregunta muy corta solo se reconoce completa.
  if (words.length < 2) return false;
  return splitSentences(text).filter(asking).some((s) => {
    const got = new Set(keyWords(s));
    return words.filter((w) => got.has(w)).length / words.length >= 0.7;
  });
}

// El cliente no quiere seguir en este momento (no es baja formal: eso lo resuelve la automatización).
const DECLINE_RE = /\b(?:no me interesa|ya no (?:me interesa|quiero|gracias|necesito)|no,? gracias|no (?:me )?(?:escriban|escribas|contacten|contactes|molesten|molestes)|dejen de escribir(?:me)?|deja de escribir(?:me)?|adios|hasta luego|nos vemos|bye|lo (?:voy a )?pienso|lo voy a pensar|lo pensare|(?:luego|despues|mas tarde) (?:te|les) (?:escribo|aviso|confirmo)|en otra ocasion)\b/;

/** El cliente se despide o dice que no quiere continuar: no se le insiste con la pregunta pendiente en este turno. */
export function declines(text: string): boolean {
  return DECLINE_RE.test(normalize(text));
}

/** ¿El texto repite la pregunta tal cual? (para no volver a hacer una ya respondida; confirmar un dato sí se vale) */
export function repeatsQuestion(text: string, q: Pick<Question, 'question'>): boolean {
  const want = clean(q.question);
  return !!want && clean(text).includes(want);
}
