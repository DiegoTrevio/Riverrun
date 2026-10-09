/**
 * Fotos que el sistema envía solo, en los momentos que el negocio eligió (no dependen de la IA):
 * palabras del cliente, bienvenida, etapa del recorrido, objetivo cumplido o cita agendada.
 */
import { imageSendWhen, type ImageAsset } from '../types.js';
import { matchKeyword } from './engine.js';
import { normalize } from './text.js';

// El cliente pide (o vuelve a pedir) algo: una pregunta, un verbo de pedir o ver, "foto", "otra vez"…
const ASKS_RE = /[?¿]|(?<![\p{L}\p{N}])(?:otra\s+vez|de\s+nuevo|reenv\p{L}*|vuelv\p{L}*|volver|mand\p{L}*|envi\p{L}*|pasa\p{L}*|muestr\p{L}*|mostr\p{L}*|ensen\p{L}*|compart\p{L}*|ver|fotos?|fotografias?|imagen\p{L}*|no\s+(?:me\s+)?(?:llego|abrio|abre|cargo|carga|se\s+ve))(?![\p{L}\p{N}])/u;

/**
 * ¿El mensaje vuelve a pedir la foto? Una palabra suelta ("menú") o una petición sí; mencionarla al agradecer
 * ("gracias, me quedo con la doble 👍") no.
 */
export function asksAgain(text: string): boolean {
  const t = normalize(text);
  return ASKS_RE.test(t) || t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length <= 3;
}

export interface ScheduledImage {
  image: ImageAsset;
  /** Por qué se envía (para Registros y el probador). */
  reason: string;
}

const scheduled = (img: ImageAsset) => imageSendWhen(img).mode !== 'ai';

/** Fotos que la IA puede elegir por su cuenta (las de "solo en estos momentos" no). */
export function aiSelectableImages(images: ImageAsset[]) {
  return images.filter((i) => imageSendWhen(i).mode !== 'rules');
}

/** Explicit semantic conditions are available even in rules-only mode. */
export function contextualImages(images: ImageAsset[]) {
  return images.filter(img => scheduled(img) && imageSendWhen(img).context);
}

export function imagesForContext(images: ImageAsset[], selectedCodes: string[], sentIds: string[]): ScheduledImage[] {
  const selected = new Set(selectedCodes.map(code => code.trim().toLowerCase()));
  return contextualImages(images).filter(img => selected.has(img.code.toLowerCase()) && !(imageSendWhen(img).once && sentIds.includes(img.id)))
    .map(image => ({image, reason: `contexto: ${imageSendWhen(image).context}`}));
}

/** Fotos con envío automático, con la descripción de cuándo salen (para avisarle a la IA). */
export function automaticImages(images: ImageAsset[], stepTitles: string[] = []) {
  return images.filter(scheduled).flatMap((img) => {
    const w = imageSendWhen(img);
    const when = [
      w.keywords.length ? `el cliente escribe ${w.keywords.map((k) => `"${k}"`).join(' o ')}` : '',
      w.assistant_keywords.length ? `el asistente dice o pregunta ${w.assistant_keywords.map(k => `"${k}"`).join(' o ')}` : '',
      w.first_message ? 'en la bienvenida' : '',
      ...w.flow_steps.map((n) => `al llegar a la etapa ${n}${stepTitles[n - 1] ? ` (${stepTitles[n - 1]})` : ''}`),
      w.on_goal ? 'al cumplirse el objetivo' : '',
      w.on_booking ? 'al agendar una cita' : '',
    ].filter(Boolean);
    return when.length ? [{ image: img, when: when.join(', ') }] : [];
  });
}

/** Antes de la IA: palabras del cliente y bienvenida (así la IA sabe que la foto sale en este turno). */
export function imagesBeforeReply(images: ImageAsset[], o: { text: string; firstReply: boolean; sentIds: string[] }): ScheduledImage[] {
  const out: ScheduledImage[] = [];
  for (const img of images.filter(scheduled)) {
    const w = imageSendWhen(img);
    // Si el cliente la pide con la palabra, se envía aunque ya se haya mandado antes (si solo la menciona, una vez basta).
    const kw = matchKeyword(o.text, w.keywords);
    if (kw && (!w.once || !o.sentIds.includes(img.id) || asksAgain(o.text))) out.push({ image: img, reason: `el cliente escribió "${kw}"` });
    else if (w.first_message && o.firstReply && !(w.once && o.sentIds.includes(img.id))) out.push({ image: img, reason: 'bienvenida' });
  }
  return out;
}

export function imagesForAssistant(images: ImageAsset[], text: string, sentIds: string[]): ScheduledImage[] {
  return images.filter(scheduled).flatMap(image => {
    const w = imageSendWhen(image);
    if (w.once && sentIds.includes(image.id)) return [];
    const phrase = matchKeyword(text, w.assistant_keywords);
    return phrase ? [{image, reason: `el asistente dijo o preguntó "${phrase}"`}] : [];
  });
}

/** Después de la decisión de la IA: etapa alcanzada, objetivo cumplido o cita agendada. */
export function imagesAfterReply(
  images: ImageAsset[],
  o: { stepReached: number; goalReached: boolean; booked: boolean; sentIds: string[]; skip: string[] },
): ScheduledImage[] {
  const out: ScheduledImage[] = [];
  for (const img of images.filter(scheduled)) {
    if (o.skip.includes(img.id)) continue;
    const w = imageSendWhen(img);
    if (w.once && o.sentIds.includes(img.id)) continue;
    const reason =
      o.stepReached && w.flow_steps.includes(o.stepReached) ? `se llegó a la etapa ${o.stepReached}`
      : w.on_goal && o.goalReached ? 'se cumplió el objetivo'
      : w.on_booking && o.booked ? 'el cliente agendó una cita'
      : '';
    if (reason) out.push({ image: img, reason });
  }
  return out;
}
