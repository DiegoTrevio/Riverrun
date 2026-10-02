import type { Chatbot, DataField, ImageAsset } from '../types.js';
import { DecisionSchema, type Action, type Decision } from './decision.js';
import { countEmojis, FactCorpus, limitEmojis, normalize, stripEmojis, toWhatsappFormat } from './text.js';

/** Plan final ya validado que el backend ejecutará. */
export interface ExecutionPlan {
  action: Action;
  messages: string[];
  images: ImageAsset[];
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
  /** Lo que escribió el cliente (vale para nombres, fechas o cantidades, pero no para precios). */
  customerSources?: string[];
  /** Texto de los mensajes pendientes del cliente (para saber si pidió explícitamente una imagen). */
  customerText: string;
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
}

const IMAGE_PROMISE_RE = /\b(te|le|les)\s+(env[ií]o|mando|comparto|paso|dejo|adjunto)\b[^.?!\n]{0,40}\b(foto|fotos|imagen|imagenes|imágenes|men[uú]|cat[aá]logo|flyer|folleto)\b|\b(aqu[ií]|ah[ií])\s+(te|le)?\s*(va|van|est[aá]n?|tienes?)\b[^.?!\n]{0,30}\b(foto|fotos|imagen|imágenes|imagenes)\b/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_FEW_EMOJIS = 2;

/** Caracteres aproximados por respuesta según "Largo de las respuestas" (detallada = sin límite). */
const LENGTH_BUDGET: Record<string, number> = { muy_corta: 220, corta: 480, media: 900, detallada: 0 };

// Formas inequívocas de tuteo (verbos en 2ª persona y pronombres) y de "usted".
// Límites de palabra con \p{L}: \b no reconoce letras acentuadas ("tú", "estás").
const word = (alts: string) => new RegExp(`(?<![\\p{L}])(?:${alts})(?![\\p{L}])`, 'iu');
const TU_RE = word(
  't[uú]|te|ti|contigo|tuy[oa]s?|tus|quieres|puedes|tienes|necesitas|prefieres|deseas|buscas|est[aá]s|eres|sabes|vienes|llegas|pagas|escr[ií]beme|av[ií]same|dime|cu[eé]ntame|conf[ií]rmame|mándame|mandame',
);
const USTED_RE = word('usted');

/** Devuelve la palabra que rompe el trato configurado (o null). */
export function registerMismatch(text: string, formality: 'tu' | 'usted'): string | null {
  // "té" (bebida) lleva acento y no coincide con "te"; las comillas pueden citar al cliente: se ignoran.
  const clean = text.replace(/"[^"]*"|“[^”]*”/g, ' ');
  const m = (formality === 'usted' ? TU_RE : USTED_RE).exec(clean);
  return m ? m[0] : null;
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
  const r = DecisionSchema.safeParse(obj);
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
 *  - Solo campos de datos configurados y con formato válido.
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
      `La respuesta es demasiado larga para el estilo configurado (${total} caracteres; máximo ~${budget}). Resume y responde solo lo que preguntó el cliente.`,
      () => undefined,
      `Se aceptó una respuesta larga (${total} caracteres) en el último intento`,
    );
  }

  // ---------- Trato: tú / usted ----------
  const register = registerMismatch(messages.join(' '), bot.personality.formality);
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
  if (!images.length && IMAGE_PROMISE_RE.test(messages.join(' '))) {
    soft(
      'Dices que envías una imagen pero no incluiste ningún ID válido en image_ids. Incluye el ID correcto del catálogo o no menciones que envías imagen.',
      () => (messages = dropSentences(messages, (_n, x) => IMAGE_PROMISE_RE.test(x))),
      'Se quitó la promesa de enviar una imagen inexistente',
    );
  }

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

  // ---------- Datos del cliente ----------
  const saveData: Record<string, string> = {};
  let contactName: string | null = null;
  for (const { field, value } of d.save_data) {
    const f = bot.data_fields.find((x) => x.key === field) ?? (['nombre', 'name'].includes(field) ? ({ key: field, label: 'Nombre', type: 'name', options: [], description: '', required: false, ask_when: '' } as DataField) : undefined);
    if (!f) {
      fixes.push(`Campo desconocido ignorado: ${field}`);
      continue;
    }
    const clean = validateFieldValue(f, value);
    if (clean === null) {
      fixes.push(`Valor inválido para ${field}: "${value}"`);
      continue;
    }
    if (f.type === 'name') contactName = clean;
    if (bot.data_fields.some((x) => x.key === f.key)) saveData[f.key] = clean;
  }

  // ---------- Coherencia de la acción ----------
  if (action === 'no_reply') {
    if (messages.length) fixes.push('Acción no_reply con mensajes: se descartaron los mensajes');
    messages = [];
  } else if (action !== 'handoff' && !messages.length) {
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
      } else if (agenda.needsPhoneFor.includes(b.service_id) && !input.hasPhone && !Object.keys(saveData).some((k) => bot.data_fields.find((f) => f.key === k)?.type === 'phone')) {
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
      if (missing.length) fixes.push(`El objetivo aún no se cumple: faltan datos importantes (${missing.map((f) => f.label).join(', ')})`);
      else if (action === 'no_reply') fixes.push('Objetivo marcado como cumplido sin responder: se ignoró');
      else goalCompleted = true;
    }
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
      saveData,
      contactName,
      remember,
      handoffReason: d.handoff_reason.trim(),
      infoNotFound: d.info_not_found,
      intents,
      booking,
      flowStep,
      goalCompleted,
    },
    retryable,
    fixes,
    factIssues,
    bookingIssue,
  };
}

export function emptyPlan(action: Action): ExecutionPlan {
  return { action, messages: [], images: [], saveData: {}, contactName: null, remember: [], handoffReason: '', infoNotFound: false, intents: [], booking: null, flowStep: 0, goalCompleted: false };
}
