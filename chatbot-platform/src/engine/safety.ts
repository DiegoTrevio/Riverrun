/**
 * Reglas de seguridad que no dependen de la IA ni de la configuración del negocio:
 *  - Emergencias y riesgo para la vida: una persona atiende de inmediato, con un mensaje fijo.
 *  - Mensajes automáticos (contestadores, respuestas de ausencia): no se contestan.
 *  - Bucles: el mismo texto repetido por el cliente pausa al asistente y avisa al equipo.
 *  - Datos sensibles: los números de tarjeta se enmascaran al guardarlos y nunca se guardan como datos del cliente.
 * Los patrones se aplican al texto normalizado (minúsculas, sin acentos).
 */
import { normalize } from './text.js';

export type RiskKind = 'selfharm' | 'danger';
export interface RiskHit {
  kind: RiskKind;
  lang: 'es' | 'en';
  match: string;
}

// Frases claras. Los modismos ("me quiero morir de la risa", "me da un infarto ver el precio") se excluyen a propósito.
const IDIOM = '(?! de (?!tristeza|dolor|angustia|miedo|desesperacion))';
const RISKS: { kind: RiskKind; lang: 'es' | 'en'; re: RegExp }[] = [
  {
    kind: 'selfharm',
    lang: 'es',
    re: new RegExp(
      `\\bme quiero (matar|morir|suicidar)\\b${IDIOM}|\\bquiero (matarme|morirme|suicidarme)\\b${IDIOM}|\\bme voy a (matar|suicidar)\\b${IDIOM}|\\bsuicid(ar|arme|arse|io|a)\\b|\\bquitarme la vida\\b|\\bacabar con mi vida\\b|\\b(ya no|no) quiero (seguir )?vivir(?! (en|aqui|ahi|alla|cerca|lejos|con|sin|por|donde|asi|de)\\b)|\\bno quiero seguir viviendo\\b|\\bhacerme dano\\b|\\bme quiero hacer dano\\b`,
    ),
  },
  {
    kind: 'danger',
    lang: 'es',
    re: /\bme (estan|quieren) (matar|secuestrar|golpear|violar|abusar|amenazar)\b|\bme (estan|tienen) (amenazando|secuestrando|golpeando|abusando)\b|\bme secuestraron\b|\bno puedo respirar\b|\b(me (esta|estoy) dando|estoy teniendo|creo que tengo|tengo) un infarto\b|\b(tengo|estoy en|es) una emergencia\b|\bhay un incendio\b/,
  },
  { kind: 'selfharm', lang: 'en', re: /\bkill myself(?! laughing)\b|\bend my life\b|\bwant to die(?! laughing)\b|\bhurt myself\b|\bsuicid/ },
  { kind: 'danger', lang: 'en', re: /\bcan.?t breathe(?! (from )?laughing)\b|\b(i'?m|i am|i think i'?m|i think i am) having a heart attack\b|\b(i'?m|i am) being (threatened|kidnapped|attacked)\b|\bthey (are|re) going to kill me\b|\bmedical emergency\b/ },
];

/** Mensajes fijos: no dependen de la IA. Línea de la Vida y 911 son de México; el negocio puede estar en otro país. */
export const SAFETY_MESSAGES: Record<RiskKind, Record<'es' | 'en', string>> = {
  selfharm: {
    es: 'Lamento mucho que estés pasando por esto. Si estás en peligro o piensas en hacerte daño, llama al 911 (en México) o a la Línea de la Vida (800 911 2000) ahora mismo. Ya avisé a alguien del equipo para que te atienda.',
    en: "I'm really sorry you're going through this. If you're in danger or thinking about hurting yourself, call your local emergency number (911 in the US and Mexico) right away. I've alerted someone from the team to reach out to you.",
  },
  danger: {
    es: 'Lamento mucho lo que estás viviendo. Si estás en peligro o es una emergencia, llama al 911 (en México) o a los servicios de emergencia de tu zona ahora mismo. Ya avisé a alguien del equipo para que te atienda.',
    en: "I'm sorry you're dealing with this. If you're in danger or this is an emergency, call your local emergency number (911 in the US and Mexico) right away. I've alerted someone from the team to reach out to you.",
  },
};

export function detectRisk(text: string): RiskHit | null {
  const t = normalize(text);
  for (const r of RISKS) {
    const m = r.re.exec(t);
    if (m) return { kind: r.kind, lang: r.lang, match: m[0] };
  }
  return null;
}

const AUTOMATIC_RE = /\brespuesta automatica\b|\bmensaje automatico\b|\bcorreo automatico\b|\bgenerad[oa] automaticamente\b|\bauto-?repl(y|ied)\b|\bautoreply\b|\bautomatic (reply|response)\b|\bout of (the )?office\b/;

/** Contestador o respuesta de ausencia, solo con marcas inequívocas ("respuesta automática"). Una pregunta siempre es de una persona. */
export function isAutomatedMessage(text: string): boolean {
  if (/[?¿]/.test(text)) return false;
  return AUTOMATIC_RE.test(normalize(text));
}

/** El mismo texto (largo) repetido varias veces entre los últimos mensajes del cliente. Devuelve el texto repetido. */
export function repeatedCustomerText(inbound: string[], { times = 3, window = 6, minChars = 15 } = {}): string | null {
  const counts = new Map<string, number>();
  for (const t of inbound.slice(-window).map((x) => normalize(x)).filter((x) => x.length >= minChars)) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, n] of counts) if (n >= times) return t;
  return null;
}

/** Promesa de que el equipo dará seguimiento ("lo reviso con el equipo", "te aviso en breve"). */
const FOLLOW_UP_RE = /\b(revis|consult|verific|pregunt|chec)\w*\b[^.?!\n]{0,40}\bequipo\b|\bte (aviso|avisamos|escribimos|contactamos|confirmamos) (en breve|pronto|mas tarde|despues|cuando)\b|\bdar(te|le)? seguimiento\b/;

export function promisesFollowUp(text: string): boolean {
  return FOLLOW_UP_RE.test(normalize(text));
}

/**
 * Número de tarjeta: 15 o 16 dígitos, agrupados como en la tarjeta (4-4-4-4 o 4-6-5) o seguidos, que pasan la
 * verificación de Luhn. No se usan rangos largos de dígitos seguidos: un número de WhatsApp (13 dígitos) pasaría
 * Luhn una de cada diez veces y se corrompería.
 */
const CARD_RE = /\b(?:\d{4}([ -]?)\d{4}\1\d{4}\1\d{4}|\d{4}([ -]?)\d{6}\2\d{5}|\d{15,16})\b/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Tarjeta: prefijo de emisor conocido (Amex: 15 dígitos que empiezan con 34 o 37; Visa, Mastercard, Discover y JCB:
 * 16 dígitos) y Luhn. Un IMEI de 15 dígitos o un número de pedido que pasa Luhn por azar no es una tarjeta.
 */
function cardDigits(s: string): string | null {
  const d = s.replace(/\D/g, '');
  const amex = d.length === 15 && /^3[47]/.test(d);
  const other = d.length === 16 && /^(4|5[1-5]|2[2-7]|6011|65|35)/.test(d);
  return (amex || other) && luhnValid(d) ? d : null;
}

export function cardNumbersIn(text: string): string[] {
  return [...text.matchAll(CARD_RE)].map((m) => m[0]).filter((m) => cardDigits(m) !== null);
}

/** Deja solo los últimos 4 dígitos de las tarjetas y oculta códigos de seguridad (CVV). */
export function maskSensitive(text: string): string {
  return text
    .replace(CARD_RE, (m) => {
      const d = cardDigits(m);
      return d ? `•••• ${d.slice(-4)}` : m;
    })
    .replace(/\b(cvv2?|cvc|c[oó]digo de seguridad)(\s*[:=]?\s*)\d{3,4}\b/gi, (_m, label: string, sep: string) => `${label}${sep}***`);
}

/** Campos que nunca se guardan como dato del cliente (tarjetas, códigos, contraseñas, NIP). */
const SENSITIVE_FIELD_RE = /tarjeta|card|cvv|cvc|contrase|password|passwd|\bnip\b|\bpin\b|clave de acceso/;

export function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD_RE.test(normalize(key).replace(/[_-]+/g, ' '));
}
