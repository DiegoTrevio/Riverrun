/** Utilidades de texto: normalización, extracción de datos verificables, formato WhatsApp. */

export function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  'a al algo alguna alguno algunos ante antes asi aun bien cada como con contra cual cuales cuando de del desde donde dos el ella ellas ellos en entre era es esa ese eso esta estan este esto estos fue ha hay la las le les lo los mas me mi mis mucho muy nada ni no nos o otra otro para pero poco por porque que quien se sea si sin sobre solo su sus tal tambien te tengo ti tiene tu tus un una uno unos y ya yo hola buenas buenos dias tardes noches gracias favor quiero quisiera saber puedo puede podria info informacion'.split(' '),
);

export function keywords(s: string): string[] {
  return normalize(s)
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stem);
}

/** Stemming muy simple para español (plural/género). */
function stem(w: string) {
  if (w.length > 5 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && (w.endsWith('s') || w.endsWith('a') || w.endsWith('o'))) return w.slice(0, -1);
  return w;
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, par: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100,
};

/** Números que dice un texto: cifras (sin separadores de miles), palabras ("dos", "docena") y "mil". */
export function spokenNumbers(text: string): number[] {
  const ws = normalize(text).replace(/(\d)[.,](?=\d{3}(?!\d))/g, '$1').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out: number[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w === 'docena') {
      // "media docena" = 6, "dos docenas" = 24, "docena" = 12.
      const prev = NUMBER_WORDS[ws[i - 1]];
      if (prev !== undefined && out.length) out.pop();
      out.push(ws[i - 1] === 'media' ? 6 : (prev ?? 1) * 12);
      continue;
    }
    let n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
    if (n === undefined) continue;
    if (ws[i + 1] === 'mil') n *= 1000;
    out.push(n);
  }
  return out;
}

const EMOJI_RE = /(\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|‍|️)/gu;

export function stripEmojis(s: string) {
  return s.replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
}

const graphemes = new Intl.Segmenter('es', { granularity: 'grapheme' });

export function countEmojis(s: string) {
  let n = 0;
  for (const { segment } of graphemes.segment(s)) if (/\p{Extended_Pictographic}/u.test(segment)) n++;
  return n;
}


/** Deja solo los primeros `max` emojis del conjunto de mensajes (cuenta 👍🏽 o 👨‍👩‍👧 como uno). */
export function limitEmojis(messages: string[], max: number): string[] {
  let seen = 0;
  return messages
    .map((m) => {
      let out = '';
      for (const { segment } of graphemes.segment(m)) {
        if (/\p{Extended_Pictographic}/u.test(segment) && ++seen > max) continue;
        out += segment;
      }
      return out.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
    })
    .filter(Boolean);
}

/** Convierte Markdown típico de LLM al formato de WhatsApp. */
export function toWhatsappFormat(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Texto plano para plataformas sin formato (Telegram sin parse_mode, Messenger, Instagram, chat web). */
export function toPlainText(s: string): string {
  return s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1$2').replace(/(^|\s)~([^~\n]+)~(?=\s|$)/g, '$1$2');
}

/* ---------------- Extracción de "hechos verificables" ---------------- */

// Cualquier terminación de 2 a 24 letras (mpago.la, linktr.ee, forms.gle): con una lista fija, un enlace con otra
// terminación no se reconocía como enlace y pasaba sin revisarse.
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')]+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/[^\s<>"')]*)?)/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
/** "15 mil", "15k", "2 millones": la cifra completa (15000), para que no se verifique solo el 15. */
const SCALED_RE = /(\d+(?:[.,]\d+)?)\s?(mil|k|mill[oó]n|millones)(?![\p{L}\d])/giu;
const scaled = (n: string, unit: string) => {
  const v = Number(canonicalNumber(n)) * (/^(?:mil|k)$/i.test(unit) ? 1000 : 1_000_000);
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : n;
};

export interface Facts {
  urls: string[];
  emails: string[];
  phones: string[];
  numbers: string[];
}

function cleanUrl(u: string) {
  return u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,;:!?]+$/, '').replace(/\/$/, '');
}

/** Número canónico: "1,500.00" -> "1500"; "10:00" se trata como "10" y "00". */
export function canonicalNumber(n: string) {
  let s = n.replace(/[.,]0{1,2}$/, ''); // quita decimales .00 / ,0
  s = s.replace(/[.,](?=\d{3}(\D|$))/g, ''); // separadores de miles
  s = s.replace(/,/g, '.');
  // "99.50" y "99.5" son la misma cifra.
  return s.includes('.') ? s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : s;
}

export function extractFacts(text: string): Facts {
  let rest = text;
  const emails = (rest.match(EMAIL_RE) || []).map((e) => e.toLowerCase());
  rest = rest.replace(EMAIL_RE, ' ');
  const urls = (rest.match(URL_RE) || []).map(cleanUrl);
  rest = rest.replace(URL_RE, ' ');
  const phones: string[] = [];
  rest = rest.replace(PHONE_RE, (m) => {
    const d = m.replace(/\D/g, '');
    // Solo tratar como teléfono si tiene 8+ dígitos y no parece precio con separadores de miles
    if (d.length >= 8 && !/^\d{1,3}([.,]\d{3})+([.,]\d{2})?$/.test(m.trim())) {
      phones.push(d);
      return ' ';
    }
    return m;
  });
  rest = rest.replace(SCALED_RE, (_m, n: string, unit: string) => scaled(n, unit));
  const numbers = (rest.match(NUMBER_RE) || []).map(canonicalNumber);
  return { urls, emails, phones, numbers };
}

/** Minúsculas y sin acentos, conservando saltos de línea y signos (para buscar frases y separar oraciones). */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Moneda antes ("$", "US$", "USD", "MXN", "€", "EUR") o después ("pesos", "dlls", "MN", "varos"…) de la cifra; la cifra
// puede venir abreviada ("15 mil", "15k").
const AMOUNT = String.raw`\d[\d.,]*(?:\s?(?:mil|k|mill[oó]n|millones)(?![\p{L}\d]))?`;
const MONEY_RE = new RegExp(
  String.raw`(?<![\p{L}\d])(?:us\$|\$|usd|mxn|eur|€)\s?${AMOUNT}|${AMOUNT}\s?(?:pesos|mxn|m\.?\s?n\.?|usd|d[oó]lares|dlls?\.?|dls\.?|varos|euros|eur|€)(?![\p{L}])`,
  'giu',
);

/** Montos de dinero mencionados ("$1,650", "350 pesos", "USD 1200", "15 mil pesos"), en forma canónica. */
export function extractMoney(text: string): string[] {
  return (text.match(MONEY_RE) || []).map((m) => {
    const n = canonicalNumber((m.match(/\d[\d.,]*/) || [''])[0].replace(/[.,]$/, ''));
    const unit = /\d\s?(mil|k|mill[oó]n|millones)(?![\p{L}\d])/iu.exec(m);
    return unit && n ? scaled(n, unit[1]) : n;
  }).filter(Boolean);
}

const MONTHS = '(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
/** Números que no son un precio: fechas, horas, porcentajes y cantidades con unidad ("3 noches", "20 min"). */
const NOT_PRICE_RE = new RegExp(
  String.raw`(?<![\d.,])(?:${[
    String.raw`\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2})?)?`,
    // "15/10", "15/10/2026", "15-10-2026"; no "$20-30" (un rango de precios).
    String.raw`\d{1,2}/\d{1,2}(?:/\d{2,4})?(?!\d)`,
    String.raw`\d{1,2}-\d{1,2}-\d{2,4}(?!\d)`,
    String.raw`\d{1,2}[:h]\d{2}(?::\d{2})?(?!\d)`,
    String.raw`\d{1,2}\s+de\s+${MONTHS}(?:\s+(?:de|del)\s+\d{4})?`,
    String.raw`${MONTHS}\s+(?:de\s+|del\s+)?\d{4}`,
    String.raw`\d+(?:[.,]\d+)?\s?(?:%|por\s?ciento)`,
    String.raw`\d+\s?(?:personas?|pax|adultos?|ninos?|noches?|dias?|horas?|hrs?|min(?:utos)?|anos?|meses|semanas?|km|kms|metros?|m2|kg|kilos?|gr|ml|lts?|litros?|piezas?|pzas?|estrellas?)(?![\p{L}])`,
  ].join('|')})`,
  'giu',
);

/** Porcentajes ("15%", "15 por ciento"). */
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s?(?:%|por\s?ciento)/giu;
const percentsIn = (folded: string) => [...folded.matchAll(PERCENT_RE)].map((m) => canonicalNumber(m[1]));

/** Promociones "2x1", "3 x 2", "2 por 1", "dos por uno" (la primera cifra mayor: no son medidas como "4x4"). */
// Al final puede ir un punto o una coma ("2x1."), pero no una cifra ("2x1.5", "3x2:30") ni un porcentaje.
const PROMO_RE = /(?<![\d.,$])([2-9])\s?(?:x|×|por)\s?([1-8])(?!\d|[.,:]\d|\s?%)(?!\s?(?:m|cm|mts?|metros|pulgadas)(?![\p{L}]))|(?<![\p{L}])(dos|tres|cuatro)\s+por\s+(uno|dos|tres)(?![\p{L}])/giu;
const SMALL: Record<string, number> = { uno: 1, dos: 2, tres: 3, cuatro: 4 };
function promosIn(folded: string): string[] {
  const out: string[] = [];
  for (const m of folded.matchAll(PROMO_RE)) {
    const a = m[1] ? Number(m[1]) : SMALL[m[3]];
    const b = m[2] ? Number(m[2]) : SMALL[m[4]];
    if (a > b) out.push(`${a}x${b}`);
  }
  return out;
}

/** Algo "sin costo": "gratis", "de cortesía", "no se cobra", "no tiene costo"… En la información también cuenta "incluido". */
const GIFT = String.raw`gratis|gratuit[oa]s?|sin\s+(?:ningun\s+)?(?:costo|cargo)(?:\s+(?:extra|adicional))?|libre\s+de\s+(?:costo|cargo)|de\s+cortesia|cortesia|de\s+regalo|obsequi(?:o|os|a|amos)|regalamos|te\s+regalo|le\s+regalo|bonificacion(?:es)?|bonificamos`;
const FREE_NO = String.raw`no\s+(?:se\s+)?(?:paga|pagas|pagan|cobra|cobran|cobramos|cuesta|cuestan|tiene\s+costo|tienen\s+costo)`;
const GIFT_RE = new RegExp(String.raw`(?<![\p{L}])(?:${GIFT}|${FREE_NO})(?![\p{L}])`, 'u');
const GIFT_G = new RegExp(GIFT_RE.source, 'gu');
/** "No se cobra" dice que algo es gratis: no es una negación de la oferta. */
const FREE_NO_G = new RegExp(String.raw`(?<![\p{L}])${FREE_NO}(?![\p{L}])`, 'gu');
const GIFT_SOURCE_RE = new RegExp(String.raw`(?<![\p{L}])(?:${GIFT}|${FREE_NO}|incluid[oa]s?|incluye|incluyen)(?![\p{L}])`, 'u');
/** Las palabras de una misma familia ("envío", "envíos"; "reservar", "reservación") se comparan por sus primeras letras. */
const giftKey = (w: string) => w.slice(0, 4);
/** Palabras de relleno que no dicen QUÉ es gratis ("hoy", "aprovecha", "también"). */
const GIFT_FILLER = new Set(
  keywords('hoy mañana ahora aprovecha aprovechar también además siempre todo toda todos todas completamente totalmente claro queda quedan sale salen aplica aplican tienes tiene tienen puedes puede pueden hay son está están será sería serían vez parte nuestro nuestra nuestros nuestras usted ustedes cliente clientes'),
);

/**
 * Cláusulas: lo que se niega en una ("no manejamos 2x1", "ese 20% no lo tenemos") no es una oferta, ni lo que una regla
 * prohíbe ("nunca prometas envío gratis"). Solo cuenta un "no" pegado a tener, haber, ofrecer, aplicar, ser…: en
 * "no olvides que tienes 30%" sí hay una oferta.
 */
const CLAUSE_SPLIT = /[;!?¿¡\n()]+|[.:,](?=\s|$)|\s(?:y|e|o|u|pero|aunque|mientras|sino)\s/;
const NEG_VERBS = 'tenemos|tengo|tiene|tienen|manejamos|maneja|manejan|hay|habra|aplica|aplican|aplicamos|ofrecemos|ofrece|ofrecen|damos|da|dan|incluye|incluyen|es|son|esta|estan|contamos|cuenta|cuentan|existe|existen|prometas|prometer|prometemos|ofrezcas|des|dar|menciones|mencionar|digas|decir|inventes|inventar|uses|usar|regales|regalar';
const NEGATION_RE = new RegExp(String.raw`(?<![\p{L}])(?:(?:no|nunca|tampoco|jamas)\s+(?:\p{L}+\s+){0,2}(?:${NEG_VERBS})|ni)(?![\p{L}])`, 'u');
const negated = (clause: string) => NEGATION_RE.test(clause.replace(FREE_NO_G, ' '));

/** Montos escritos con palabras ("mil quinientos pesos", "diez por ciento"): no se pueden comparar con la información. */
const NUM_WORD = String.raw`(?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\p{L}+|veinte|veinti\p{L}+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|mil|millon|millones|medio)`;
const WORD_AMOUNT_RE = new RegExp(
  // No después de una cifra: "15 mil pesos" ya se revisa como 15000.
  String.raw`(?<![\p{L}\d])(?<!\d\s)${NUM_WORD}(?:\s+(?:y\s+)?${NUM_WORD})*\s+(?:de\s+)?(?:pesos?|dolar(?:es)?|dlls?|euros?|varos|por\s?ciento)(?![\p{L}])`,
  'gu',
);

/**
 * Horas que menciona un texto, como "h:mm" en 12 horas (a las 6 = 18:00: "de 9 a 6" no dice si es de la tarde).
 * Reconoce "10:30", "7 pm", "a las 7", "de las 9 a las 6" y "de 9 a 6" (este último solo si habla de un horario o lleva
 * am/pm, y no "de 2 a 4 personas"). `loose` también toma "17 hrs" (solo para las fuentes: ahí cuenta de más, no de menos).
 */
const TIME_NEXT_OK = new Set(['am', 'pm', 'a', 'hrs', 'hr', 'h', 'horas', 'hora', 'de', 'del', 'y', 'o', 'u', 'e', 'en', 'para', 'por', 'los', 'las', 'todos', 'todas', 'diario', 'hasta', 'que', 'con', 'al', 'como', 'cuando', 'mas', 'aprox', 'te', 'le', 'les', 'nos', 'lo', 'la', 'ya', 'sin', 'se', 'es', 'son', 'pero', 'aunque', 'si']);
const SCHEDULE_CUE = /(?<![\p{L}])(?:abr\p{L}*|cerr\p{L}*|cierr\p{L}*|horarios?|atend\p{L}*|atencion|abiert[oa]s?|lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|diario|entre semana)(?![\p{L}])/u;
const MERIDIEM = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)`;
/** Cuándo abre o cierra el negocio: esa hora solo puede salir de su horario, nunca de la que propuso el cliente. */
const OPEN_CUE = /(?<![\p{L}])(?:abr\p{L}*|cerr\p{L}*|cierr\p{L}*|horarios?|abiert[oa]s?)(?![\p{L}])/u;
/** "9 a 18 hrs", "de 9:00 a 18:00", "9-14 h", "de las 9 a las 6 pm" (en la información del negocio). */
const RANGE_RE = new RegExp(String.raw`(?<![\d:.,$])(\d{1,2})(?:[:h]([0-5]\d))?\s*(?:a|-|–|hasta)\s*(?:las?\s+)?(\d{1,2})(?:[:h]([0-5]\d))?(?![\d:])(?:\s?(hrs?|horas|h)\.?(?![\p{L}])|\s?${MERIDIEM}(?![\p{L}]))?`, 'gu');
/** Texto de la cláusula alrededor de una posición (hasta la coma, el punto o el salto de línea más cercanos). */
function clauseAround(t: string, start: number, end: number) {
  const from = Math.max(...[',', ';', '.', '!', '?', '\n'].map((c) => t.lastIndexOf(c, start - 1))) + 1;
  const rest = t.slice(end).search(/[,;.!?\n]/);
  return t.slice(from, rest < 0 ? t.length : end + rest);
}
interface TimeMention { key: string; label: string; hour: string; min: string; open: boolean }
function timesIn(text: string, loose = false): TimeMention[] {
  const t = fold(text);
  const out: TimeMention[] = [];
  const add = (h: string, mm: string | undefined, half: string | undefined, start: number, end: number) => {
    const hour = Number(h);
    const min = mm ?? (half === 'media' ? '30' : half === 'cuarto' ? '15' : '00');
    const key = `${hour % 12}:${min}`;
    if (hour > 24) return;
    const open = OPEN_CUE.test(clauseAround(t, start, end));
    const seen = out.find((x) => x.key === key);
    if (seen) seen.open ||= open;
    // `hour` y `min` como los saca extractFacts, para no volver a revisar esas cifras como números sueltos.
    else out.push({ key, label: `${hour}:${min} h`, hour: canonicalNumber(h), min: canonicalNumber(min), open });
  };
  const nextOk = (end: number) => {
    const next = /^\s*([\p{L}]+)/u.exec(t.slice(end));
    return !next || TIME_NEXT_OK.has(next[1].replace(/\./g, ''));
  };
  const span = (m: RegExpMatchArray) => [m.index!, m.index! + m[0].length] as const;
  for (const m of t.matchAll(/(?<![\d:.,$])(\d{1,2})[:h]([0-5]\d)(?!\d)/gu)) add(m[1], m[2], undefined, ...span(m));
  for (const m of t.matchAll(new RegExp(String.raw`(?<![\d:.,$])(\d{1,2})(?::([0-5]\d))?\s?${MERIDIEM}(?![\p{L}])`, 'gu'))) add(m[1], m[2], undefined, ...span(m));
  for (const m of t.matchAll(/(?<![\p{L}])(?:a|de|desde|hasta|para|entre|y|antes de|despues de)\s+las?\s+(\d{1,2})(?:[:h]([0-5]\d)|\s+y\s+(media|cuarto))?(?![\d:])/gu)) {
    if (loose || nextOk(m.index! + m[0].length)) add(m[1], m[2], m[3], ...span(m));
  }
  if (loose) {
    // En la información: un rango "9 a 18 hrs" aunque no lleve "de", si dice la unidad, los minutos o habla de horario.
    for (const m of t.matchAll(RANGE_RE)) {
      const line = t.slice(t.lastIndexOf('\n', m.index!) + 1, t.indexOf('\n', m.index!) < 0 ? t.length : t.indexOf('\n', m.index!));
      const afterDe = /(?:^|[^\p{L}])de\s*$/u.test(t.slice(Math.max(0, m.index! - 4), m.index!));
      if (!(m[2] || m[4] || m[5] || m[6] || afterDe || SCHEDULE_CUE.test(line))) continue;
      add(m[1], m[2], undefined, ...span(m));
      add(m[3], m[4], undefined, ...span(m));
    }
    for (const m of t.matchAll(/(?<![\d:.,$])(\d{1,2})\s?(?:hrs?|h)\.?(?![\p{L}\d])/gu)) add(m[1], undefined, undefined, ...span(m));
  } else {
    for (const m of t.matchAll(new RegExp(String.raw`(?<![\p{L}])de\s+(\d{1,2})(?:[:h]([0-5]\d))?\s*(?:a|-|–)\s*(\d{1,2})(?:[:h]([0-5]\d))?(?![\d:])(\s?${MERIDIEM})?`, 'gu'))) {
      const end = m.index! + m[0].length;
      const sentence = t.slice(t.lastIndexOf('\n', m.index!) + 1, end);
      if ((m[5] || SCHEDULE_CUE.test(sentence)) && nextOk(end)) {
        add(m[1], m[2], undefined, ...span(m));
        add(m[3], m[4], undefined, ...span(m));
      }
    }
  }
  return out;
}

/** Corpus contra el cual se verifican los hechos de una respuesta. */
export class FactCorpus {
  private text: string;
  /** El mismo texto sin acentos (para buscar frases). */
  private folded: string;
  private digitsJoined: string;
  private phoneDigits: string[];
  /**
   * Cifras que sirven de precio: las escritas como dinero y los números sueltos que no son fecha, hora, porcentaje ni
   * cantidad con unidad. Así "$21" no se valida por el 21 de octubre, ni "$15" por el check-in de las 15:00.
   */
  private priceNumbers: Set<string>;
  /** Cifras escritas como dinero ("$1,650", "1650 MXN"): las únicas que sirven de precio base en una cotización. */
  private moneyAmounts: Set<string>;
  private numbers: Set<string>;
  private urls: string[];
  private emails: Set<string>;
  private percents: Set<string>;
  private promos: Set<string>;
  private times: Set<string>;
  /** Palabras clave de cada oración que dice que algo no cuesta ("envío gratis", "desayuno incluido"). */
  private giftSentences: Set<string>[];
  /**
   * Cantidades dichas: cifras y palabras ("somos dos"), la suma de las de un mismo texto ("2 adultos y 1 niño") y la
   * diferencia entre dos seguidas ("del 20 al 23" = 3 noches).
   */
  private quantities: Set<number>;

  constructor(sources: string[]) {
    const all = sources.join('\n');
    this.text = all.toLowerCase();
    this.folded = fold(all);
    const f = extractFacts(all);
    this.urls = f.urls;
    this.emails = new Set(f.emails);
    this.numbers = new Set(f.numbers);
    for (const p of f.phones) this.numbers.add(p);
    this.digitsJoined = '|' + [...f.phones, ...f.numbers.map((n) => n.replace(/\D/g, ''))].join('|') + '|';
    this.phoneDigits = f.phones;
    this.moneyAmounts = new Set(extractMoney(all));
    // Los teléfonos, correos y enlaces ya se quitaron en extractFacts: "$234" no se valida por el número del cliente.
    const plain = extractFacts(fold(all).replace(NOT_PRICE_RE, ' ')).numbers;
    this.priceNumbers = new Set([...this.moneyAmounts, ...plain]);
    // Ofertas de la información, sin lo que se niega o prohíbe ("nunca prometas envío gratis", "ni descuentos del 20%").
    const offered = this.folded.split(/[.!?\n;]+/).map((s) => s.split(CLAUSE_SPLIT).filter((c) => c && !negated(c)).join(' '));
    this.percents = new Set(offered.flatMap(percentsIn));
    this.promos = new Set(offered.flatMap(promosIn));
    this.times = new Set(timesIn(all, true).map((x) => x.key));
    this.giftSentences = offered.filter((s) => GIFT_SOURCE_RE.test(s)).map((s) => new Set(keywords(s).map(giftKey)));
    this.quantities = new Set();
    for (const s of sources) {
      const ns = spokenNumbers(s).filter((n) => n > 0 && n <= 1000);
      ns.forEach((n, i) => {
        this.quantities.add(n);
        if (i) this.quantities.add(Math.abs(n - ns[i - 1]));
      });
      if (ns.length > 1) this.quantities.add(ns.reduce((a, b) => a + b, 0));
      // "2 habitaciones por 3 noches" = 6: el producto de dos cantidades de un mismo mensaje.
      const few = ns.slice(0, 8);
      for (let i = 0; i < few.length; i++) for (let j = i + 1; j < few.length; j++) if (few[i] * few[j] <= 60) this.quantities.add(few[i] * few[j]);
    }
  }

  /**
   * Un número debe aparecer completo en las fuentes: "650" no se valida porque exista "1,650" ni porque esté dentro
   * de un teléfono o de la fecha. Única excepción: el número local de un teléfono conocido (7+ dígitos, sin lada).
   */
  hasNumber(n: string) {
    const d = n.replace(/\D/g, '');
    if (d.length < 2) return true; // un dígito suelto no se verifica
    if (this.numbers.has(n) || this.digitsJoined.includes(`|${d}|`)) return true;
    return d.length >= 7 && this.phoneDigits.some((p) => p.endsWith(d));
  }

  /**
   * Montos de dinero: siempre se verifican y deben ser la misma cifra que un precio del negocio (no parte de otra, ni
   * una fecha, una hora o una cantidad).
   */
  hasMoney(n: string) {
    return this.priceNumbers.has(n);
  }

  /**
   * ¿`amount` = precio base × k, con k entre 2 y 60 y k aceptado por `quantityOk`? Los precios base son `bases` (o, sin
   * ella, las cifras del corpus escritas como dinero): con cualquier número, la fecha y la hora de hoy (15:20 → 15 × 20)
   * validarían un "$300" inventado.
   */
  isProductOf(amount: string, quantityOk: (k: number) => boolean, bases: Iterable<string> = this.moneyAmounts): boolean {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return false;
    for (const n of bases) {
      const base = Number(n);
      if (!Number.isFinite(base) || base <= 0) continue;
      const k = a / base;
      if (Number.isInteger(k) && k >= 2 && k <= 60 && quantityOk(k)) return true;
    }
    return false;
  }

  hasPhone(p: string) {
    if (this.numbers.has(p)) return true;
    // Sin la lada de México (52, o 521 en celulares) es el mismo número; con otra lada ("+1") ya es otro.
    const local = (x: string) => x.replace(/^521?(?=\d{10}$)/, '');
    for (const known of this.numbers) {
      if (known.length < 8) continue;
      // Sin lada (10 dígitos o menos) basta con que termine igual; con lada, debe ser el mismo número.
      if (p.length <= 10 ? known.endsWith(p) : local(known) === local(p)) return true;
    }
    return false;
  }

  /**
   * Un enlace debe estar en las fuentes, o ser una parte de uno de ellos (el dominio de una página conocida). No se
   * acepta una ruta inventada sobre un dominio real ("hotel.mx/promo-50") ni un dominio que solo empieza o termina igual.
   */
  hasUrl(u: string) {
    if (this.urls.some((k) => k === u || ['/', '?', '#'].some((c) => k.startsWith(`${u}${c}`)))) return true;
    const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9.@-])(?:https?://)?(?:www\\.)?${esc}(?=$|[/?#\\s"'<>)\\]]|[.,;:!?](?:\\s|$))`).test(this.text);
  }

  hasEmail(e: string) {
    return this.emails.has(e);
  }

  /**
   * Ofertas de la respuesta que la información del negocio no tiene: porcentajes, promociones "2x1", algo gratis y montos
   * escritos con palabras. Lo que la respuesta niega ("no manejamos 2x1") no es una oferta.
   */
  private unsupportedOffers(reply: string): string[] {
    const bad: string[] = [];
    for (const clause of fold(reply).split(CLAUSE_SPLIT)) {
      if (!clause?.trim() || negated(clause)) continue;
      for (const p of percentsIn(clause)) if (!this.percents.has(p)) bad.push(`${p}%`);
      for (const p of promosIn(clause)) if (!this.promos.has(p)) bad.push(p);
      const gift = GIFT_RE.exec(clause);
      if (gift) {
        // Qué es gratis: una oración del negocio debe decir que eso no cuesta. Si la respuesta no dice qué ("¡es gratis!"),
        // basta con que el negocio ofrezca algo sin costo.
        const what = keywords(clause.replace(GIFT_G, ' ')).filter((w) => !GIFT_FILLER.has(w)).map(giftKey);
        const ok = what.length ? this.giftSentences.some((s) => what.some((w) => s.has(w))) : this.giftSentences.length > 0;
        if (!ok) bad.push(`«${clause.trim().slice(0, 60)}»`);
      }
    }
    for (const m of fold(reply).matchAll(WORD_AMOUNT_RE)) {
      if (this.folded.includes(m[0])) continue;
      // "cien por ciento", "diez por ciento": un porcentaje como cualquier otro (el 100% también debe estar en la información).
      const percent = /por\s?ciento$/.test(m[0]) ? spokenNumbers(m[0]).reduce((a, b) => a + b, 0) : 0;
      if (percent) {
        if (!this.percents.has(String(percent))) bad.push(`${percent}%`);
      } else bad.push(`«${m[0]}» (escribe la cantidad con cifras)`);
    }
    return bad;
  }

  /**
   * Devuelve los hechos de `reply` que no aparecen en el corpus.
   * Si se pasa `trusted` (las fuentes del negocio), además: los montos de dinero, las ofertas, las horas y los enlaces
   * deben venir de ahí, para que el cliente no pueda "dictar" un precio, un descuento o un enlace "del negocio".
   * `customer` (lo que dijo el cliente) sirve para la cantidad de una cotización y para la hora que propuso.
   * `plainNumbers: false` no revisa los números sueltos (un plazo como "en 24 horas" en un pendiente del reporte).
   */
  unverified(reply: string, trusted?: FactCorpus, customer?: FactCorpus, opts: { plainNumbers?: boolean } = {}): string[] {
    const f = extractFacts(reply);
    const bad: string[] = [];
    const computed = new Set<string>();
    if (trusted) {
      const money = extractMoney(reply);
      // Precios del negocio que la respuesta muestra: los únicos que sirven de base para una cotización.
      const shown = new Set(money.filter((m) => trusted.hasMoney(m)));
      for (const m of money) {
        if (trusted.hasMoney(m)) {
          computed.add(m);
          continue;
        }
        // Cotización: un precio del negocio que aparece en la misma respuesta × una cantidad que dijo el cliente. Ni la
        // cantidad sale de la propia respuesta ("$3,300 por noche (2 adultos)") ni el precio unitario se queda sin decir.
        if (trusted.isProductOf(m, (k) => !!customer?.quantities.has(k), shown)) computed.add(m);
        else bad.push(m);
      }
      bad.push(...trusted.unsupportedOffers(reply));
      for (const p of percentsIn(fold(reply))) computed.add(p);
      // Horas: del negocio (horario, agenda, la hora actual) o la que propuso el cliente. Cuándo abre o cierra, solo del
      // horario: "¿abren a las 7?" no hace verdad "sí, abrimos a las 7".
      for (const t of timesIn(reply)) {
        if (!trusted.times.has(t.key) && (t.open || !customer?.times.has(t.key))) bad.push(t.label);
        computed.add(t.hour);
        computed.add(t.min);
      }
    }
    // Un enlace solo puede ser del negocio: el que escribió el cliente no se presenta como si fuera del negocio.
    for (const u of f.urls) if (!(trusted ?? this).hasUrl(u)) bad.push(u);
    for (const e of f.emails) if (!this.hasEmail(e)) bad.push(e);
    for (const p of f.phones) if (!this.hasPhone(p)) bad.push(p);
    // El número local de un teléfono conocido escrito con separadores ("123-4567") se separa en dos números: se valida junto.
    for (const m of reply.matchAll(/(?<![\d])\d{2,4}(?:[\s.-]\d{2,4}){1,2}(?![\d])/g)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length >= 7 && this.phoneDigits.some((p) => p.endsWith(d))) for (const part of m[0].split(/[\s.-]/)) computed.add(canonicalNumber(part));
    }
    if (opts.plainNumbers !== false) for (const n of f.numbers) if (!computed.has(n) && !this.hasNumber(n)) bad.push(n);
    return [...new Set(bad)];
  }
}

/**
 * PostgreSQL no admite el carácter NUL (\u0000) en texto ni en jsonb, y un "surrogate" suelto no es texto válido.
 * Se guardan como texto visible en vez de romper la inserción (y con ella, el mensaje).
 */
export function cleanText(s: string): string {
  return s.replace(/\u0000/g, '\\u0000').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** Limpia recursivamente todas las cadenas de un valor (también las claves de los objetos). */
export function deepClean<T>(v: T): T {
  if (typeof v === 'string') return cleanText(v) as T;
  if (Array.isArray(v)) return v.map((x) => deepClean(x)) as T;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [cleanText(k), deepClean(x)])) as T;
  }
  return v;
}

/** Recorta por caracteres, no por unidades de código: nunca parte un emoji en dos. */
export function truncateChars(s: string, max: number): string {
  return Array.from(s).slice(0, max).join('');
}
