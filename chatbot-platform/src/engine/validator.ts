import type { Chatbot, DataField, ImageAsset } from '../types.js';
import { DecisionSchema, type Action, type Decision } from './decision.js';
import { countEmojis, FactCorpus, normalize, stripEmojis, toWhatsappFormat } from './text.js';

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
}

export interface ValidationResult {
  plan: ExecutionPlan;
  /** Problemas que justifican pedir a la IA una nueva propuesta. */
  retryable: string[];
  /** Correcciones aplicadas automáticamente (se registran). */
  fixes: string[];
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
}

const IMAGE_PROMISE_RE = /\b(te|le|les)\s+(env[ií]o|mando|comparto|paso|dejo|adjunto)\b[^.?!\n]{0,40}\b(foto|fotos|imagen|imagenes|imágenes|men[uú]|cat[aá]logo|flyer|folleto)\b|\b(aqu[ií]|ah[ií])\s+(te|le)?\s*(va|van|est[aá]n?|tienes?)\b[^.?!\n]{0,30}\b(foto|fotos|imagen|imágenes|imagenes)\b/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

function splitLongMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let cur = '';
  for (const p of paragraphs) {
    if ((cur + '\n\n' + p).trim().length <= max) cur = (cur ? cur + '\n\n' : '') + p;
    else {
      if (cur) parts.push(cur);
      cur = p;
    }
  }
  if (cur) parts.push(cur);
  return parts;
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

  const parsed = parseDecision(input.raw);
  if (!parsed.decision) {
    return {
      plan: emptyPlan('no_reply'),
      retryable: [parsed.error ?? 'Respuesta inválida'],
      fixes,
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
  } else if (bot.personality.emojis === 'few' && countEmojis(messages.join(' ')) > 2) {
    fixes.push('Demasiados emojis para la configuración "pocos"');
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
  const tooLong = messages.some((m) => m.length > bot.ai.max_chars_per_bubble * 1.6);
  if (tooLong && bot.personality.response_length !== 'detallada') retryable.push(`Un mensaje es demasiado largo; resume a menos de ${bot.ai.max_chars_per_bubble} caracteres por mensaje.`);

  // ---------- Frases prohibidas ----------
  const joinedNorm = normalize(messages.join(' '));
  const banned = rules.banned_phrases.filter((p) => p.trim() && joinedNorm.includes(normalize(p)));
  if (banned.length) retryable.push(`No uses estas frases: ${banned.map((b) => `"${b}"`).join(', ')}.`);
  const forbiddenOut = rules.forbidden_topics.filter((t) => t.trim().length > 3 && joinedNorm.includes(normalize(t)));
  if (forbiddenOut.length) retryable.push(`Tu respuesta menciona temas prohibidos (${forbiddenOut.join(', ')}). No hables de ellos.`);

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
    if (invalidIds.length) retryable.push(`Los IDs de imagen ${invalidIds.join(', ')} no existen. Usa solo IDs del catálogo o responde sin imagen.`);
    action = 'reply';
  }
  if (images.length && action !== 'handoff') action = 'reply_with_image';
  if (!images.length && IMAGE_PROMISE_RE.test(messages.join(' '))) {
    retryable.push('Dices que envías una imagen pero no incluiste ningún ID válido en image_ids. Incluye el ID correcto del catálogo o no menciones que envías imagen.');
  }

  // ---------- Verificación de hechos (cero invenciones) ----------
  if (rules.verify_facts && messages.length) {
    const trusted = new FactCorpus(input.groundingSources);
    const all = new FactCorpus([...input.groundingSources, ...(input.customerSources ?? [])]);
    const unverified = all.unverified(messages.join('\n'), trusted);
    if (unverified.length) {
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
    },
    retryable,
    fixes,
  };
}

export function emptyPlan(action: Action): ExecutionPlan {
  return { action, messages: [], images: [], saveData: {}, contactName: null, remember: [], handoffReason: '', infoNotFound: false };
}
