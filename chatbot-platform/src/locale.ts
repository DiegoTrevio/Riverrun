/**
 * Idioma del negocio con sus clientes: español (México) o inglés (Estados Unidos). Decide en qué idioma salen los
 * mensajes fijos que el sistema le manda al cliente (sin la IA), la moneda y el formato de montos y fechas, y los valores
 * de fábrica de un agente nuevo. El panel tiene su propio idioma por persona (public/js/i18n.js); este es el del negocio.
 */
import { AccountSettingsSchema, type AccountSettings } from './automation/types.js';
import { PersonalitySchema, RulesSchema } from './types.js';

export type Lang = 'es' | 'en';
export const LANGS: readonly Lang[] = ['es', 'en'];

export interface LocaleInfo { lang: Lang; locale: 'es-MX' | 'en-US'; currency: 'MXN' | 'USD' }

export function localeOf(lang: Lang | string | undefined | null): LocaleInfo {
  return lang === 'en' ? { lang: 'en', locale: 'en-US', currency: 'USD' } : { lang: 'es', locale: 'es-MX', currency: 'MXN' };
}

/** "en" si el texto (un Accept-Language, un `lang` del panel) prefiere inglés; si no, "es". */
export function langFrom(value: unknown): Lang {
  return typeof value === 'string' && /^en\b/i.test(value.trim()) ? 'en' : 'es';
}

/**
 * El idioma de quien visita una página pública o se registra: el que eligió en el panel (cookie «lang») o, si no,
 * el de su navegador.
 */
export function visitorLang(req: { cookies?: Record<string, string | undefined>; headers: Record<string, unknown> }): Lang {
  const chosen = req.cookies?.lang;
  if (chosen === 'es' || chosen === 'en') return chosen;
  return langFrom(req.headers['accept-language']);
}

/**
 * Los planes que ve cada idioma: en inglés, los que se cobran en dólares; en español, los demás. Solo cuenta un plan
 * que se puede pagar (con algún proveedor de cobro, si alguno lo tiene): si un idioma no tiene ninguno así, ve todos,
 * para no quedarse sin nada que contratar. El plan que la cuenta ya tiene siempre se queda en la lista.
 */
export function plansForLanguage<T extends { key: string; currency: string; providers?: readonly unknown[] }>(plans: T[], lang: Lang, keep = ''): T[] {
  const payable = plans.some((p) => p.providers?.length) ? (p: T) => !!p.providers?.length : () => true;
  const fits = (p: T) => payable(p) && (lang === 'en') === (p.currency.toUpperCase() === 'USD');
  return plans.some(fits) ? plans.filter((p) => fits(p) || p.key === keep) : plans;
}

/* ------------------------------ Agente nuevo ------------------------------ */

const ES_PERSONALITY = PersonalitySchema.parse({});
const ES_RULES = RulesSchema.parse({});

/** Lo que un agente trae de fábrica, en inglés (para un negocio de Estados Unidos). */
export const ENGLISH_AGENT = {
  personality: { language: 'English (United States)', tone: ['natural', 'friendly'] },
  rules: {
    fallback_message: "I don't have that confirmed yet. Let me check with the team and I'll get back to you.",
    unavailable_message: "Thanks for reaching out! We're running a little behind; we'll reply in a moment.",
    handoff_message: "Sure, I'll connect you with someone from our team. They'll be with you shortly.",
    keep_answering_message: "I can't help with that right now, but someone from our team will help you when they reach out.",
    handoff_rules: [
      'The customer explicitly asks to talk to a person',
      'The customer is upset or has a complaint',
      'The customer wants to confirm a payment, booking or purchase',
    ],
    handoff_keywords: ['agent', 'human', 'real person', 'representative', 'talk to someone'],
    banned_phrases: [
      'as a language model',
      'as an ai',
      'as an artificial intelligence',
      "i'm a virtual assistant",
      'is there anything else i can assist you with',
      "don't hesitate to contact us",
      'dear customer',
    ],
  },
} as const;

type AgentParts = { personality?: unknown; rules?: unknown };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Los mensajes fijos de fábrica de "usted" también son de fábrica (templates/business.ts). */
const USTED: Record<string, string> = {
  handoff_message: 'Claro, le comunico con alguien del equipo. En un momento le atienden.',
  fallback_message: 'Ese dato no lo tengo confirmado; permítame revisarlo con el equipo y le aviso.',
  keep_answering_message: 'En este momento no le puedo ayudar con eso, pero alguien del equipo le ayudará cuando se ponga en contacto con usted.',
};
const isSpanishFactory = (k: string, v: unknown) => typeof v === 'string' && USTED[k] === v;

/**
 * Pasa al inglés lo que el agente trae de fábrica en español (lo que falta o sigue igual que el valor de fábrica); lo que
 * el negocio escribió a mano no se toca.
 */
export function englishAgent<T extends AgentParts>(input: T): T {
  return agentForLanguage(input, 'en');
}

/** Igual, en los dos sentidos: al volver al español, lo de fábrica en inglés regresa al español. */
export function agentForLanguage<T extends AgentParts>(input: T, lang: Lang): T {
  const p = { ...((input.personality ?? {}) as Record<string, unknown>) };
  const r = { ...((input.rules ?? {}) as Record<string, unknown>) };
  const esP = ES_PERSONALITY as Record<string, unknown>;
  const esR = ES_RULES as Record<string, unknown>;
  for (const [k, en] of Object.entries(ENGLISH_AGENT.personality)) {
    if (lang === 'en' && (p[k] === undefined || same(p[k], esP[k]))) p[k] = en;
    if (lang === 'es' && same(p[k], en)) p[k] = esP[k];
  }
  for (const [k, en] of Object.entries(ENGLISH_AGENT.rules)) {
    if (lang === 'en' && (r[k] === undefined || same(r[k], esR[k]) || isSpanishFactory(k, r[k]))) r[k] = en;
    // De regreso al español, con el trato del agente: de usted vuelve a sus textos de usted.
    if (lang === 'es' && same(r[k], en)) r[k] = p.formality === 'usted' && USTED[k] ? USTED[k] : esR[k];
  }
  return { ...input, personality: p, rules: r };
}

/* ------------------------------ Ajustes de la cuenta ------------------------------ */

const ES_SETTINGS = AccountSettingsSchema.parse({});

/** Bajas y consentimiento en inglés: STOP/START es lo que se espera en Estados Unidos. */
export const ENGLISH_SETTINGS = {
  opt_out: {
    // Solo frases que no se dicen al contestar otra cosa: «cancel» o «end» pueden ser la respuesta a una cita.
    keywords: ['stop', 'unsubscribe', 'stop all'],
    confirm_message: "You're unsubscribed and won't receive promotional messages. Reply START to subscribe again.",
    resume_keywords: ['start', 'unstop', 'subscribe'],
    resume_message: "You're subscribed again. You'll receive our news and offers.",
    footer_text: 'Reply {{palabra_baja}} to stop receiving these messages.',
  },
  consent: {
    // Igual: «yes» contesta cualquier pregunta del asistente y no es aceptar promociones.
    opt_in_keywords: ['i agree', 'yes i agree', 'subscribe me'],
    opt_in_message: 'Thanks! We will send you news and offers. Reply STOP anytime to unsubscribe.',
  },
} as const;

const TEXTS = {
  es: { opt_out: ES_SETTINGS.opt_out as Record<string, unknown>, consent: ES_SETTINGS.consent as Record<string, unknown> },
  en: { opt_out: { ...ES_SETTINGS.opt_out, ...ENGLISH_SETTINGS.opt_out } as Record<string, unknown>, consent: { ...ES_SETTINGS.consent, ...ENGLISH_SETTINGS.consent } as Record<string, unknown> },
};

/** Ajustes al cambiar el idioma del negocio: los textos de fábrica pasan al otro idioma; los escritos a mano se quedan. */
export function settingsForLanguage(s: AccountSettings, lang: Lang): AccountSettings {
  const from = TEXTS[lang === 'en' ? 'es' : 'en'];
  const to = TEXTS[lang];
  const swap = <K extends 'opt_out' | 'consent'>(key: K): AccountSettings[K] => {
    const cur = { ...s[key] } as Record<string, unknown>;
    for (const [k, v] of Object.entries(to[key])) if (same(cur[k], from[key][k])) cur[k] = v;
    return cur as AccountSettings[K];
  };
  return { ...s, language: lang, opt_out: swap('opt_out'), consent: swap('consent') };
}

/* ------------------------------ Voz de los mensajes fijos ------------------------------ */

/** Cómo se le habla al cliente en un mensaje fijo: de tú, de usted o en inglés. */
export type Voice = 'tu' | 'usted' | 'en';

/** ¿El idioma del agente (texto libre de su personalidad) es inglés? «English (United States)», «inglés», «en-US». */
export const speaksEnglish = (language: string | undefined | null) => /^\s*(?:english|ingl[eé]s|en(?:[-_][a-z]{2})?\s*$)/i.test(language ?? '');

/** Los mensajes fijos salen en el idioma del agente (el mismo en que contesta la IA) y, en español, con su trato. */
export function voiceOf(p: { language?: string; formality?: 'tu' | 'usted' } | undefined | null): Voice {
  return speaksEnglish(p?.language) ? 'en' : p?.formality === 'usted' ? 'usted' : 'tu';
}

export const langOfVoice = (v: Voice): Lang => (v === 'en' ? 'en' : 'es');
