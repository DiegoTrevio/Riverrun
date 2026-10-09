import { imagesAfterReply, imagesForAssistant, imagesForContext } from './images.js';
import { automaticField, customerProvided } from './customer-data.js';
import type { Chatbot, DataField, ImageAsset } from '../types.js';
import { DecisionSchema, type Action, type Decision } from './decision.js';
import { unsupportedClaims } from './claims.js';
import { asksQuestion, isAnswered, questionList, questionProgress, type QuestionProgress } from './questions.js';
import { cardNumbersIn, isSensitiveField } from './safety.js';
import { countEmojis, deepClean, FactCorpus, limitEmojis, normalize, stripEmojis, toWhatsappFormat } from './text.js';

/** Plan final ya validado que el backend ejecutará. */
export interface ExecutionPlan {
  action: Action;
  messages: string[];
  images: ImageAsset[];
  contextImages: ImageAsset[];
  saveData: Record<string, string>;
  contactName: string | null;
  remember: string[];
  handoffReason: string;
  infoNotFound: boolean;
  /** Intenciones detectadas (solo de la lista permitida). */
  intents: string[];
  /** Propuesta de agenda ya validada contra los horarios reales. */
  booking: { action: 'book'; serviceId: string; slot: string } | { action: 'cancel'; appointmentId: string } | null;
  /** Etapa del recorrido (0 = sin recorrido o sin cambio). */
  flowStep: number;
  /** Mensajes guardados (activos y existentes) que se envían tal cual, en el orden que propuso la IA. */
  savedCodes: string[];
  /** Pregunta de la lista que se hace en esta respuesta (para marcar el mensaje que la lleva). */
  question: { key: string; text: string } | null;
  /** En este turno se resolvió la última pregunta pendiente de la lista (respondida o, si es opcional, sin respuesta). */
  questionsCompleted: boolean;
  /** La IA marcó el objetivo como cumplido y el backend lo aceptó (hay objetivo y no faltan datos importantes). */
  goalCompleted: boolean;
}

export interface ValidationResult {
  plan: ExecutionPlan;
  /** Problemas que justifican pedir a la IA una nueva propuesta. */
  retryable: string[];
  /** Correcciones aplicadas automáticamente (se registran). */
  fixes: string[];
  /** true si entre los problemas hay datos no verificables (precios, links, teléfonos...). */
  factIssues: boolean;
  /** true si la propuesta de agenda no es válida (horario inexistente, cita ajena...). */
  bookingIssue: boolean;
}

/** Lo que el validador necesita saber de la agenda. */
export interface AgendaValidation {
  slots: Record<string, string[]>;
  appointmentIds: string[];
  /** Servicios para los que falta pedir teléfono antes de agendar. */
  needsPhoneFor: string[];
}

export interface ValidationInput {
  raw: unknown;
  bot: Chatbot;
  images: ImageAsset[];
  sentImageIds: string[];
  /** Fuentes del negocio: conocimiento, configuración, mensajes del bot/equipo. */
  groundingSources: string[];
  /** Solo lo que el negocio afirma (conocimiento, reglas, agenda y mensajes del equipo): respalda "sí tenemos X". */
  claimSources?: string[];
  /** Lo que escribió el cliente (vale para nombres, fechas o cantidades, pero no para precios). */
  customerSources?: string[];
  /** Mensajes originales del cliente para validar datos automáticos (sin resúmenes). */
  customerDataSources?: string[];
  /** Texto de los mensajes pendientes del cliente (para saber si pidió explícitamente una imagen). */
  customerText: string;
  /** Fotos que el sistema enviará en este turno (la IA puede mencionarlas sin incluirlas en image_ids). */
  scheduledImages?: ImageAsset[];
  automaticImages?: ImageAsset[];
  currentFlowStep?: number;
  goalAlreadyCompleted?: boolean;
  /**
   * Último intento: los problemas de estilo (frases prohibidas, promesas de foto, largo)
   * se corrigen automáticamente en lugar de pedir otra respuesta a la IA.
   */
  final?: boolean;
  allowedIntents?: string[];
  agenda?: AgendaValidation | null;
  /** El cliente ya tiene un teléfono registrado (o lo dio ahora). */
  hasPhone?: boolean;
  /** Datos del cliente ya guardados (para saber si faltan los importantes antes de cerrar el objetivo). */
  knownData?: Record<string, string>;
  /** Nombre confirmado del cliente (cuenta como el dato "nombre"). */
  knownName?: string;
  /** Últimos mensajes que el negocio envió en la conversación (para no repetir la misma respuesta). */
  recentBotTexts?: string[];
  /** El cliente repite exactamente su mensaje anterior: repetir la respuesta es lo esperado. */
  customerRepeats?: boolean;
  /** Preguntas de la lista en el recorrido actual: veces que se hizo cada una y si ya se terminaron. */
  questionJourney?: { asked: Record<string, number>; done: boolean };
}

const IMAGE_PROMISE_RE = /\b(te|le|les)\s+(env[ií]o|mando|comparto|paso|dejo|adjunto)\b[^.?!\n]{0,40}\b(foto|fotos|imagen|imagenes|imágenes|men[uú]|cat[aá]logo|flyer|folleto)\b|\b(aqu[ií]|ah[ií])\s+(te|le)?\s*(va|van|est[aá]n?|tienes?)\b[^.?!\n]{0,30}\b(foto|fotos|imagen|imágenes|imagenes)\b/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_FEW_EMOJIS = 2;

/** Caracteres aproximados por respuesta según "Largo de las respuestas" (detallada = sin límite). */
const LENGTH_BUDGET: Record<string, number> = { muy_corta: 220, corta: 480, media: 900, detallada: 0 };

// Formas inequívocas de tuteo (verbos en 2ª persona y pronombres) y de "usted".
// Límites de palabra con \p{L}: \b no reconoce letras acentuadas ("tú", "estás").
const word = (alts: string) => new RegExp(`(?<![\\p{L}])(?:${alts})(?![\\p{L}])`, 'giu');
const TU_RE = word(
  't[uú]|te|ti|contigo|tuy[oa]s?|tus|quieres|puedes|tienes|necesitas|prefieres|deseas|buscas|est[aá]s|eres|sabes|vienes|llegas|pagas|escr[ií]beme|av[ií]same|dime|cu[eé]ntame|conf[ií]rmame|mándame|mandame',
);
const USTED_RE = word('usted');

/**
 * ¿Es un nombre propio y no un pronombre? Palabras en mayúsculas ("TI") o con mayúscula a mitad de
 * oración ("paquete Tus Uñas", "salón Te Consiento") son nombres de productos o negocios.
 */
function looksLikeName(text: string, index: number, token: string) {
  if (token.length > 1 && token === token.toUpperCase()) return true;
  if (token[0] !== token[0].toUpperCase()) return false;
  const before = text.slice(0, index).replace(/[\s"“«(¿¡]+$/u, '');
  return before.length > 0 && !/[.!?…:\n]$/.test(before);
}

/** Devuelve la palabra que rompe el trato configurado (o null). */
export function registerMismatch(text: string, formality: 'tu' | 'usted'): string | null {
  // "té" (bebida) lleva acento y no coincide con "te"; las comillas pueden citar al cliente: se ignoran.
  const clean = text.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, (m) => ' '.repeat(m.length));
  const re = formality === 'usted' ? TU_RE : USTED_RE;
  re.lastIndex = 0;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (!looksLikeName(clean, m.index, m[0])) return m[0];
  }
  return null;
}

export function parseDecision(raw: unknown): { decision: Decision | null; error?: string } {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { decision: null, error: 'La respuesta no es JSON válido' };
    }
  }
  const r = DecisionSchema.safeParse(deepClean(obj));
  if (!r.success) return { decision: null, error: `JSON con formato inválido: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { decision: r.data };
}

export function validateFieldValue(field: DataField, value: string): string | null {
  let v = value.trim().replace(/\s+/g, ' ');
  if (!v || v.length > 300) return null;
  const lowered = normalize(v);
  if (['n/a', 'na', 'null', 'none', 'desconocido', 'no especificado', 'no proporcionado', '-'].includes(lowered)) return null;
  switch (field.type) {
    case 'email':
      v = v.toLowerCase();
      return EMAIL_RE.test(v) ? v : null;
    case 'phone': {
      const d = v.replace(/[^\d+]/g, '');
      return d.replace(/\D/g, '').length >= 8 && d.replace(/\D/g, '').length <= 15 ? d : null;
    }
    case 'name':
      if (/\d/.test(v) || v.length > 60) return null;
      return v
        .split(' ')
        .map((w) => (w.length > 2 ? w[0].toLocaleUpperCase('es') + w.slice(1) : w))
        .join(' ');
    case 'number': {
      const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m ? m[0] : null;
    }
    case 'option': {
      if (!field.options.length) return v;
      const hit = field.options.find((o) => normalize(o) === lowered) ?? field.options.find((o) => lowered.includes(normalize(o)) || normalize(o).includes(lowered));
      return hit ?? null;
    }
    default:
      return v;
  }
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

/** Agrupa piezas en bloques de hasta `max` caracteres. */
function pack(pieces: string[], max: number, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!cur) cur = p;
    else if ((cur + sep + p).length <= max) cur += sep + p;
    else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Divide un mensaje largo por párrafos y, si hace falta, por oraciones. */
export function splitLongMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const byParagraph = pack(text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean), max, '\n\n');
  return byParagraph.flatMap((p) => (p.length <= max ? [p] : pack(sentences(p), max, ' ')));
}

/** Quita las oraciones que cumplen `test`; devuelve los mensajes que aún tienen contenido. */
function dropSentences(messages: string[], test: (sentenceNorm: string, sentence: string) => boolean): string[] {
  return messages
    .map((m) => sentences(m).filter((x) => !test(normalize(x), x)).join(' ').trim())
    .filter((m) => /[\p{L}\p{N}]/u.test(m));
}

/**
 * Valida y sanea la propuesta de la IA. Nunca confía en ella:
 *  - Solo imágenes existentes y activas del chatbot.
 *  - Campos configurados o datos automáticos proporcionados por el cliente, con formato válido.
 *  - Precios, números, links, correos y teléfonos deben existir en el contexto.
 *  - Frases prohibidas, emojis, formato y longitud según configuración.
 */
export function validateDecision(input: ValidationInput): ValidationResult {
  const { bot } = input;
  const rules = bot.rules;
  const fixes: string[] = [];
  const retryable: string[] = [];
  let factIssues = false;
  let bookingIssue = false;

  const parsed = parseDecision(input.raw);
  if (!parsed.decision) {
    return {
      plan: emptyPlan('no_reply'),
      retryable: [parsed.error ?? 'Respuesta inválida'],
      fixes,
      factIssues: false,
      bookingIssue: false,
    };
  }
  const d = parsed.decision;
  let action: Action = d.action;

  // ---------- Mensajes guardados: solo códigos activos de este asistente ----------
  const savedByCode = new Map(bot.saved_messages.filter((m) => m.active).map((m) => [m.code, m]));
  const proposedCodes = [...new Set(d.saved_message_codes.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  const savedCodes = proposedCodes.filter((c) => savedByCode.has(c));
  if (proposedCodes.length > savedCodes.length) fixes.push('Mensajes guardados inexistentes o inactivos descartados');

  // Preguntas de la lista: su texto lo escribió el negocio (no cuenta como trato ni como repetición de la IA).
  const questions = questionList(bot);
  const asksAnyQuestion = (text: string) => questions.some((q) => asksQuestion(text, q));

  // ---------- Mensajes: formato, emojis, longitud ----------
  let messages = d.messages.map((m) => toWhatsappFormat(String(m ?? ''))).filter((m) => m.length > 0);
  if (bot.personality.emojis === 'none') {
    const before = messages.join('');
    messages = messages.map(stripEmojis).filter(Boolean);
    if (before !== messages.join('')) fixes.push('Se quitaron emojis (configuración: sin emojis)');
  } else if (bot.personality.emojis === 'few' && countEmojis(messages.join(' ')) > MAX_FEW_EMOJIS) {
    messages = limitEmojis(messages, MAX_FEW_EMOJIS);
    fixes.push(`Se dejaron solo ${MAX_FEW_EMOJIS} emojis (configuración: pocos)`);
  }
  const split: string[] = [];
  for (const m of messages) split.push(...splitLongMessage(m, bot.ai.max_chars_per_bubble));
  messages = split;
  if (messages.length > bot.ai.max_bubbles) {
    const head = messages.slice(0, bot.ai.max_bubbles - 1);
    const tail = messages.slice(bot.ai.max_bubbles - 1).join('\n\n');
    messages = [...head, tail];
    fixes.push(`Se agruparon mensajes para no exceder ${bot.ai.max_bubbles}`);
  }
  const soft = (issue: string, fix: () => void, fixNote: string) => {
    if (input.final) {
      fix();
      fixes.push(fixNote);
    } else retryable.push(issue);
  };
  const tooLong = messages.some((m) => m.length > bot.ai.max_chars_per_bubble * 1.6);
  if (tooLong && bot.personality.response_length !== 'detallada') {
    soft(`Un mensaje es demasiado largo; resume a menos de ${bot.ai.max_chars_per_bubble} caracteres por mensaje.`, () => undefined, 'Se aceptó un mensaje largo en el último intento');
  }
  // Largo total según "Largo de las respuestas" (con margen: listas de precios pueden pedirlo).
  const budget = LENGTH_BUDGET[bot.personality.response_length];
  const total = messages.join(' ').length;
  if (budget && total > budget * 1.3 && !tooLong) {
    soft(
      `La respuesta es demasiado larga para el estilo configurado (${total} caracteres; máximo ~${budget}). ${questions.length ? 'Resume: responde lo que preguntó el cliente y conserva la pregunta pendiente de la lista.' : 'Resume y responde solo lo que preguntó el cliente.'}`,
      () => undefined,
      `Se aceptó una respuesta larga (${total} caracteres) en el último intento`,
    );
  }

  // ---------- Trato: tú / usted ----------
  const ownText = questions.length ? dropSentences(messages, (_n, x) => asksAnyQuestion(x)).join(' ') : messages.join(' ');
  const register = registerMismatch(ownText, bot.personality.formality);
  if (register) {
    soft(
      bot.personality.formality === 'usted'
        ? `Trata al cliente de "usted", no de "tú" (encontré: ${register}). Ejemplo: "¿Le gustaría agendar?" en lugar de "¿Te gustaría agendar?".`
        : `Trata al cliente de "tú", no de "usted" (encontré: ${register}).`,
      () => undefined,
      `Revisar trato: la respuesta no usa "${bot.personality.formality === 'usted' ? 'usted' : 'tú'}" (${register})`,
    );
  }

  // ---------- Frases prohibidas ----------
  const bannedList = rules.banned_phrases.map((p) => normalize(p)).filter(Boolean);
  const banned = rules.banned_phrases.filter((p) => p.trim() && normalize(messages.join(' ')).includes(normalize(p)));
  if (banned.length) {
    soft(
      `No uses estas frases: ${banned.map((b) => `"${b}"`).join(', ')}.`,
      () => (messages = dropSentences(messages, (n) => bannedList.some((b) => n.includes(b)))),
      `Se quitaron oraciones con frases prohibidas: ${banned.join(', ')}`,
    );
  }
  // Temas prohibidos: el bot no puede sacarlos por su cuenta. Si el cliente los mencionó, sí puede
  // nombrarlos para declinar con amabilidad (se registra para revisión).
  const customerNorm = normalize(input.customerText);
  const forbiddenOut = rules.forbidden_topics.map((t) => t.trim()).filter((t) => t.length > 2 && normalize(messages.join(' ')).includes(normalize(t)));
  const unprompted = forbiddenOut.filter((t) => !customerNorm.includes(normalize(t)));
  if (unprompted.length) {
    soft(
      `No hables de estos temas: ${unprompted.map((t) => `"${t}"`).join(', ')}. El cliente no los mencionó; quítalos de la respuesta.`,
      () => (messages = dropSentences(messages, (n) => unprompted.some((t) => n.includes(normalize(t))))),
      `Se quitaron oraciones con temas prohibidos: ${unprompted.join(', ')}`,
    );
  }
  const declined = forbiddenOut.filter((t) => !unprompted.includes(t));
  if (declined.length) fixes.push(`Revisar: el cliente preguntó por un tema prohibido (${declined.join(', ')})`);

  // ---------- Datos sensibles: ni números de tarjeta en la respuesta ----------
  if (messages.some((m) => cardNumbersIn(m).length)) {
    soft(
      'Tu respuesta repite un número de tarjeta. No lo escribas: pide al cliente que no comparta datos de tarjetas por este chat.',
      () => {
        messages = dropSentences(messages, (_n, x) => cardNumbersIn(x).length > 0);
        if (!messages.length) messages = [rules.fallback_message];
      },
      'Se quitó de la respuesta un número de tarjeta',
    );
  }

  // ---------- Imágenes: solo del catálogo ----------
  const byCode = new Map(input.images.filter((i) => i.active).map((i) => [normalize(i.code), i]));
  const images: ImageAsset[] = [];
  const invalidIds: string[] = [];
  for (const id of d.image_ids) {
    const img = byCode.get(normalize(id));
    if (!img) {
      invalidIds.push(id);
      continue;
    }
    if (images.some((x) => x.id === img.id)) continue;
    const customerAsked = /\b(foto|fotos|imagen|imagenes|imágenes|men[uú]|cat[aá]logo|otra vez|de nuevo|reenv)/i.test(input.customerText);
    if (rules.avoid_repeating_images && input.sentImageIds.includes(img.id) && !customerAsked) {
      fixes.push(`Imagen "${img.code}" omitida: ya se había enviado`);
      continue;
    }
    images.push(img);
  }
  if (invalidIds.length) fixes.push(`IDs de imagen inexistentes descartados: ${invalidIds.join(', ')}`);
  if (images.length > rules.max_images_per_reply) {
    fixes.push(`Se limitaron las imágenes a ${rules.max_images_per_reply}`);
    images.splice(rules.max_images_per_reply);
  }
  if (action === 'reply_with_image' && !images.length) {
    if (invalidIds.length) soft(`Los IDs de imagen ${invalidIds.join(', ')} no existen. Usa solo IDs del catálogo o responde sin imagen.`, () => undefined, 'Se respondió sin imagen');
    action = 'reply';
  }
  if (images.length && action !== 'handoff') action = 'reply_with_image';


  // ---------- Verificación de hechos (cero invenciones) ----------
  if (rules.verify_facts && messages.length) {
    const trusted = new FactCorpus(input.groundingSources);
    const all = new FactCorpus([...input.groundingSources, ...(input.customerSources ?? [])]);
    const unverified = all.unverified(messages.join('\n'), trusted);
    if (unverified.length) {
      factIssues = true;
      retryable.push(
        `Mencionaste datos que no están en la información del negocio ni en la conversación: ${unverified.join(', ')}. Elimina o corrige esos datos; si no los tienes, dilo con naturalidad.`,
      );
    }
  }

  // ---------- Afirmaciones sin números ("sí tenemos alberca") ----------
  if (rules.verify_claims !== 'apagado' && messages.length && input.claimSources) {
    const claims = unsupportedClaims(messages.join('\n'), input.claimSources);
    if (claims.length) {
      factIssues = true;
      retryable.push(
        `Afirmaste que el negocio tiene u ofrece: ${claims.join(', ')}. Eso no aparece en la información del negocio. Quítalo, o di con naturalidad que lo confirmas con el equipo.`,
      );
    }
  }

  // ---------- Datos del cliente ----------
  const saveData: Record<string, string> = {};
  let contactName: string | null = null;
  for (const { field, value } of d.save_data.slice(0, 30)) {
    if (isSensitiveField(field) || cardNumbersIn(value).length) {
      fixes.push(`Dato sensible no guardado (${field}): no se guardan tarjetas, códigos ni contraseñas`);
      continue;
    }
    const configured = bot.data_fields.find((x) => x.key === field);
    const f = configured ?? automaticField(field);
    if (!f) {
      fixes.push(`Campo inválido ignorado: ${field}`);
      continue;
    }
    const clean = validateFieldValue(f, value);
    if (clean === null) {
      fixes.push(`Valor inválido para ${field}: "${value}"`);
      continue;
    }
    // Las respuestas libres a la lista de preguntas también deben salir de lo que escribió el cliente: si no, una
    // respuesta inventada daría la pregunta por contestada y se la saltaría.
    const freeAnswer = !!configured?.question.trim() && ['text', 'name', 'email', 'phone'].includes(f.type);
    if ((!configured || freeAnswer) && !customerProvided(f, clean, [input.customerText, ...(input.customerDataSources ?? input.customerSources ?? [])])) {
      fixes.push(`Dato no proporcionado por el cliente ignorado: ${f.key}`);
      continue;
    }
    if (!configured && !Object.hasOwn(input.knownData ?? {}, f.key) && Object.keys(input.knownData ?? {}).length + Object.keys(saveData).length >= 100) continue;
    if (f.type === 'name') contactName = clean;
    saveData[f.key] = clean;
  }

  // ---------- Una pregunta nunca se queda sin respuesta ----------
  if (action === 'no_reply' && /[?¿]/.test(input.customerText) && input.customerText.trim().length >= 12) {
    soft(
      'El cliente hizo una pregunta: respóndela (no_reply no aplica). Si no puedes contestarla con la información del negocio, dilo y di que el equipo lo revisa.',
      () => {
        action = 'handoff';
        messages = [];
      },
      'Pregunta sin respuesta: se pasó a una persona en lugar de quedarse callado',
    );
  }

  // ---------- Preguntas: la siguiente de la lista, en orden, una a la vez ----------
  let question: ExecutionPlan['question'] = null;
  let questionsCompleted = false;
  let questionsAfter: QuestionProgress | null = null;
  if (questions.length) {
    const journey = input.questionJourney ?? { asked: {}, done: false };
    const known = input.knownData ?? {};
    const data = { ...known, ...saveData };
    const name = contactName || input.knownName;
    questionsAfter = questionProgress(questions, data, name, journey.asked);
    const pending = questionsAfter.next;
    // Terminó en este turno: ya no queda ninguna pendiente, se había hecho alguna en este recorrido (o se contestó
    // una ahora) y no se avisó antes. Un cliente que vuelve con todo respondido no lo dispara.
    const answeredNow = questions.some((q) => isAnswered(q, data, name) && !isAnswered(q, known, input.knownName));
    const askedAny = Object.values(journey.asked).some((n) => n > 0);
    questionsCompleted = !pending && !journey.done && (askedAny || answeredNow) && action !== 'handoff';
    if (pending && action !== 'handoff') {
      const text = pending.question.trim();
      question = { key: pending.key, text };
      if (action === 'no_reply') {
        action = 'ask';
        messages = [];
        fixes.push('Había una pregunta pendiente de la lista: se hace en lugar de no responder');
      }
      // Preguntas de la lista que todavía no tocan: no se adelantan.
      const later = questions.filter((q) => q !== pending && !isAnswered(q, data, name) && !questionsAfter!.skipped.includes(q));
      const outOfOrder = (x: string) => later.some((q) => asksQuestion(x, q)) && !asksQuestion(x, pending);
      if (messages.some((m) => sentences(m).some(outOfOrder))) {
        soft(
          `Hiciste una pregunta de la lista que todavía no toca. Pregunta solo la siguiente: «${text}».`,
          () => (messages = dropSentences(messages, (_n, x) => outOfOrder(x))),
          'Se quitó una pregunta de la lista hecha fuera de orden',
        );
      }
      if (!messages.some((m) => asksQuestion(m, pending))) {
        soft(
          `Te faltó la siguiente pregunta de la lista. Atiende lo que dijo el cliente y termina con esta pregunta, tal cual: «${text}».`,
          () => (messages = appendQuestion(messages, text, bot.ai.max_bubbles)),
          `Se agregó la siguiente pregunta de la lista (${pending.key})`,
        );
      }
    }
  }

  // ---------- No repetir: la misma respuesta a un mensaje distinto ----------
  if (!input.customerRepeats && input.recentBotTexts?.length && messages.length) {
    const sent = new Set(input.recentBotTexts.map((x) => normalize(x)));
    // Volver a hacer una pregunta de la lista que sigue sin respuesta no es repetirse.
    if (messages.some((m) => m.length >= 25 && sent.has(normalize(m)) && !asksAnyQuestion(m))) {
      soft(
        'Repites un mensaje que ya enviaste, aunque el cliente preguntó otra cosa. Contesta lo nuevo sin copiar tu respuesta anterior.',
        () => undefined,
        'Se aceptó una respuesta repetida en el último intento',
      );
    }
  }

  // ---------- Coherencia de la acción ----------
  if (action === 'no_reply') {
    if (messages.length) fixes.push('Acción no_reply con mensajes: se descartaron los mensajes');
    messages = [];
  } else if (action !== 'handoff' && !messages.length && !savedCodes.length) {
    retryable.push('La acción requiere al menos un mensaje para el cliente.');
  }

  // ---------- Intenciones: solo las configuradas ----------
  const allowed = new Set((input.allowedIntents ?? []).map((x) => normalize(x)));
  const intents = [...new Set(d.intents.map((x) => normalize(x)).filter((x) => allowed.has(x)))];
  const unknownIntents = d.intents.filter((x) => !allowed.has(normalize(x)));
  if (unknownIntents.length) fixes.push(`Intenciones desconocidas ignoradas: ${unknownIntents.join(', ')}`);

  // ---------- Agenda: la IA solo elige horarios reales ----------
  let booking: ExecutionPlan['booking'] = null;
  const b = d.booking;
  if (b.action !== 'none') {
    const agenda = input.agenda;
    if (!agenda) {
      fixes.push('Propuesta de agenda ignorada: la agenda no está disponible');
    } else if (b.action === 'book') {
      const slots = agenda.slots[b.service_id];
      if (!slots) {
        bookingIssue = true;
        retryable.push(`El servicio "${b.service_id}" no existe. Usa el ID exacto de la sección Agenda.`);
      } else if (!slots.includes(b.slot)) {
        bookingIssue = true;
        retryable.push(`El horario "${b.slot}" no está disponible para ese servicio. Ofrece solo horarios de la lista y agenda únicamente cuando el cliente elija uno.`);
      } else if (agenda.needsPhoneFor.includes(b.service_id) && !input.hasPhone && !Object.keys(saveData).some((k) => k === 'telefono' || bot.data_fields.find((f) => f.key === k)?.type === 'phone')) {
        bookingIssue = true;
        retryable.push('Para agendar la llamada primero pide el número de teléfono del cliente (no agendes todavía).');
      } else {
        booking = { action: 'book', serviceId: b.service_id, slot: b.slot };
      }
    } else if (b.action === 'cancel') {
      if (!agenda.appointmentIds.includes(b.appointment_id)) {
        bookingIssue = true;
        retryable.push('Esa cita no existe o no es de este cliente. Solo puedes cancelar citas de la lista "Citas del cliente".');
      } else {
        booking = { action: 'cancel', appointmentId: b.appointment_id };
      }
    }
  }

  // ---------- Recorrido: etapa y objetivo ----------
  const flow = bot.flow;
  const flowStep = flow.steps.length ? Math.min(Math.max(0, Math.trunc(d.flow_step)), flow.steps.length) : 0;
  if (flow.steps.length && d.flow_step > flow.steps.length) fixes.push(`Etapa ${d.flow_step} inexistente: se usó la ${flowStep}`);
  let goalCompleted = false;
  if (d.goal_completed) {
    if (!flow.goal.trim()) {
      fixes.push('Objetivo marcado como cumplido, pero el recorrido no tiene objetivo: se ignoró');
    } else {
      const have = { ...(input.knownData ?? {}), ...saveData };
      const missing = bot.data_fields.filter((f) => f.required && !have[f.key] && !(f.type === 'name' && (contactName || input.knownName)));
      const pendingQuestions = questionsAfter?.missingRequired ?? [];
      if (missing.length) fixes.push(`El objetivo aún no se cumple: faltan datos importantes (${missing.map((f) => f.label).join(', ')})`);
      else if (pendingQuestions.length) fixes.push(`El objetivo aún no se cumple: faltan preguntas obligatorias (${pendingQuestions.map((q) => q.key).join(', ')})`);
      else if (action === 'no_reply') fixes.push('Objetivo marcado como cumplido sin responder: se ignoró');
      else goalCompleted = true;
    }
  }

  const contextual = action !== 'handoff' && action !== 'no_reply'
    ? imagesForContext(input.automaticImages ?? [], d.context_image_ids, input.sentImageIds) : [];
  if (d.context_image_ids.length > contextual.length) fixes.push('Fotos de contexto inválidas, repetidas o no permitidas descartadas');
  const scheduled = rules.max_images_per_reply > 0 && action !== 'handoff' ? [
    ...(input.scheduledImages ?? []),
    ...contextual.map(x => x.image),
    ...imagesForAssistant(input.automaticImages ?? [], messages.join(' '), input.sentImageIds).map(x => x.image),
    ...imagesAfterReply(input.automaticImages ?? [], {
      stepReached: flowStep !== (input.currentFlowStep ?? 0) ? flowStep : 0,
      goalReached: goalCompleted && !input.goalAlreadyCompleted, booked: booking?.action === 'book', sentIds: input.sentImageIds, skip: [],
    }).map(x => x.image),
  ] : [];
  const savedWithImage = savedCodes.some((c) => savedByCode.get(c)?.image_id);
  if (!images.length && !scheduled.length && !savedWithImage && IMAGE_PROMISE_RE.test(messages.join(' '))) {
    soft(
      'Dices que envías una imagen pero no incluiste ningún ID válido en image_ids. Incluye el ID correcto del catálogo o no menciones que envías imagen.',
      () => (messages = dropSentences(messages, (_n, x) => IMAGE_PROMISE_RE.test(x))),
      'Se quitó la promesa de enviar una imagen inexistente',
    );
  }

  const remember = d.remember
    .map((x) => x.trim())
    .filter((x) => x.length > 2 && x.length < 200)
    .slice(0, 5);

  return {
    plan: {
      action,
      messages,
      images: action === 'reply_with_image' ? images : [],
      contextImages: contextual.map(x => x.image),
      saveData,
      contactName,
      remember,
      handoffReason: d.handoff_reason.trim(),
      infoNotFound: d.info_not_found,
      intents,
      booking,
      flowStep,
      goalCompleted,
      savedCodes: action === 'handoff' || action === 'no_reply' ? [] : savedCodes,
      question: action === 'handoff' || action === 'no_reply' ? null : question,
      questionsCompleted,
    },
    retryable,
    fixes,
    factIssues,
    bookingIssue,
  };
}

export function emptyPlan(action: Action): ExecutionPlan {
  return { action, messages: [], images: [], contextImages: [], saveData: {}, contactName: null, remember: [], handoffReason: '', infoNotFound: false, intents: [], booking: null, flowStep: 0, goalCompleted: false, savedCodes: [], question: null, questionsCompleted: false };
}

/** Agrega la pregunta como último mensaje (o al final del último, si ya se llegó al máximo de mensajes). */
function appendQuestion(messages: string[], text: string, maxBubbles: number): string[] {
  if (messages.length < Math.max(1, maxBubbles)) return [...messages, text];
  return [...messages.slice(0, -1), `${messages[messages.length - 1]}\n\n${text}`];
}
