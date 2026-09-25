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

const EMOJI_RE = /(\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|‍|️)/gu;

export function stripEmojis(s: string) {
  return s.replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
}

export function countEmojis(s: string) {
  return (s.match(/\p{Extended_Pictographic}/gu) || []).length;
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

/* ---------------- Extracción de "hechos verificables" ---------------- */

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')]+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|mx|net|org|io|co|app|site|online|store|shop|info|biz|es|us|link|ly|me|travel|lat|tv)\b(?:\/[^\s<>"')]*)?)/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

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
  return s.replace(/,/g, '.');
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
  const numbers = (rest.match(NUMBER_RE) || []).map(canonicalNumber);
  return { urls, emails, phones, numbers };
}

const MONEY_RE = /\$\s?\d[\d.,]*|\d[\d.,]*\s?(?:pesos|mxn|usd|d[oó]lares|euros|eur)\b/gi;

/** Montos de dinero mencionados ("$1,650", "350 pesos"), en forma canónica. */
export function extractMoney(text: string): string[] {
  return (text.match(MONEY_RE) || []).map((m) => canonicalNumber((m.match(/\d[\d.,]*/) || [''])[0].replace(/[.,]$/, ''))).filter(Boolean);
}

/** Corpus contra el cual se verifican los hechos de una respuesta. */
export class FactCorpus {
  private text: string;
  private digitsJoined: string;
  private numbers: Set<string>;
  private urls: string[];
  private emails: Set<string>;

  constructor(sources: string[]) {
    const all = sources.join('\n');
    this.text = all.toLowerCase();
    const f = extractFacts(all);
    this.urls = f.urls;
    this.emails = new Set(f.emails);
    this.numbers = new Set(f.numbers);
    for (const p of f.phones) this.numbers.add(p);
    this.digitsJoined = '|' + [...f.phones, ...f.numbers.map((n) => n.replace(/\D/g, ''))].join('|') + '|';
  }

  hasNumber(n: string) {
    if (n.replace(/\D/g, '').length < 2) return true; // un dígito suelto no se verifica
    if (this.numbers.has(n)) return true;
    const d = n.replace(/\D/g, '');
    return d.length >= 3 && this.digitsJoined.includes(d);
  }

  hasPhone(p: string) {
    if (this.numbers.has(p)) return true;
    // Permitir variantes con/sin lada de país (52, 521)
    for (const known of this.numbers) {
      if (known.length >= 8 && (known.endsWith(p) || p.endsWith(known))) return true;
    }
    return false;
  }

  hasUrl(u: string) {
    return this.urls.some((k) => k === u || k.startsWith(u) || u.startsWith(k)) || this.text.includes(u);
  }

  hasEmail(e: string) {
    return this.emails.has(e);
  }

  /**
   * Devuelve los hechos de `reply` que no aparecen en el corpus.
   * Si se pasa `trusted`, los montos de dinero deben venir de ahí (fuentes del negocio),
   * para que el cliente no pueda "dictar" un precio.
   */
  unverified(reply: string, trusted?: FactCorpus): string[] {
    const f = extractFacts(reply);
    const bad: string[] = [];
    if (trusted) for (const m of extractMoney(reply)) if (!trusted.hasNumber(m)) bad.push(m);
    for (const u of f.urls) if (!this.hasUrl(u)) bad.push(u);
    for (const e of f.emails) if (!this.hasEmail(e)) bad.push(e);
    for (const p of f.phones) if (!this.hasPhone(p)) bad.push(p);
    for (const n of f.numbers) if (!this.hasNumber(n)) bad.push(n);
    return [...new Set(bad)];
  }
}
