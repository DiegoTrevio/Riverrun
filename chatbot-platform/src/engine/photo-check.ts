/**
 * Avisos de configuración de fotos para el panel: lo que el negocio escribió no coincide con cómo están sus fotos
 * (las instrucciones piden una foto desactivada, inexistente o que la IA no puede elegir, o una foto nunca se envía).
 */
import { imageSendWhen, type Chatbot, type ImageAsset, type ImageSendWhen } from '../types.js';
import { normalize } from './text.js';

/** ¿Tiene algún momento o condición para enviarse sola? */
export function hasMoment(w: ImageSendWhen): boolean {
  return !!(w.context || w.keywords.length || w.assistant_keywords.length || w.first_message || w.flow_steps.length || w.on_goal || w.on_booking);
}

// Oraciones que hablan de enviar o mostrar algo (ahí es donde se nombra una foto).
const PHOTO_SENTENCE = /(?<![\p{L}\p{N}])(?:fotos?|fotografias?|imagen|imagenes|envi\p{L}*|mand\p{L}*|compart\p{L}*|muestr\p{L}*|mostr\p{L}*|ensen\p{L}*)(?![\p{L}\p{N}])/u;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type BotTexts = Pick<Chatbot, 'personality' | 'rules' | 'flow' | 'saved_messages' | 'data_fields'>;

function photoSentences(bot: BotTexts): string[] {
  const texts = [bot.personality.prompt, bot.rules.image_rules, ...bot.rules.custom_rules, ...bot.flow.steps.map((s) => s.description), ...bot.saved_messages.map((m) => m.when)];
  return texts
    .join('\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => normalize(x))
    .filter((x) => PHOTO_SENTENCE.test(x));
}

/** ¿Las instrucciones nombran este ID de foto en una oración sobre enviar o mostrar? */
export function mentionsPhotoCode(bot: BotTexts, code: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(normalize(code))}(?![\\p{L}\\p{N}_-])`, 'u');
  return photoSentences(bot).some((x) => re.test(x));
}

export function photoWarnings(bot: BotTexts, images: ImageAsset[]): string[] {
  const out: string[] = [];
  for (const img of images) {
    const w = imageSendWhen(img);
    if (img.active && w.mode === 'rules' && !hasMoment(w)) {
      out.push(`La foto «${img.code}» está en «Solo en los momentos que marque aquí» sin ningún momento marcado: nunca se envía.`);
    }
  }
  for (const img of images) {
    if (!mentionsPhotoCode(bot, img.code)) continue;
    const w = imageSendWhen(img);
    if (!img.active) out.push(`Las instrucciones mencionan la foto «${img.code}», pero está desactivada: no se enviará.`);
    else if (w.mode === 'rules') {
      out.push(`Las instrucciones piden la foto «${img.code}», pero está en «Solo en los momentos que marque aquí»: la IA no puede enviarla por su cuenta. Para que la envíe cuando lo dicen las instrucciones, usa «La IA decide» o «Ambos».`);
    }
  }
  // IDs que no existen: `entre comillas invertidas` o con guion bajo después de "foto" (p. ej. tras cambiar el ID de una foto).
  const known = new Set([...images.map((i) => normalize(i.code)), ...bot.saved_messages.map((m) => m.code), ...bot.data_fields.map((f) => f.key)]);
  const unknown = new Set<string>();
  for (const x of photoSentences(bot)) {
    for (const m of x.matchAll(/`([a-z0-9_-]{2,40})`/g)) if (!known.has(m[1])) unknown.add(m[1]);
    for (const m of x.matchAll(/(?:foto|imagen)\s+(?:(?:de\s+(?:la|el|los|las)|del)\s+)?([a-z0-9]+[_-][a-z0-9_-]+)/g)) if (!known.has(m[1])) unknown.add(m[1]);
  }
  for (const c of unknown) out.push(`Las instrucciones mencionan la foto «${c}», que no existe en Fotos (¿cambió su ID?).`);
  return out;
}
