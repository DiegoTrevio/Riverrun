// Idioma del panel. El código está escrito en español; en inglés, cada texto que aparece en la pantalla se cambia por
// su traducción del diccionario public/i18n/en.json (llave: el texto en español tal cual; {0}, {1}… son las partes
// que cambian, como un nombre o un número). Así el español queda exactamente como siempre y el inglés no obliga a
// tocar cada pantalla. Lo que escribe la gente (mensajes, nombres, instrucciones) va dentro de translate="no" y no se
// toca. Este módulo no importa nada: lo carga app.js antes que el resto del panel.

const STORAGE_KEY = 'riverrun-lang';
export const LANGS = [['es', 'Español'], ['en', 'English']];
const SUPPORTED = new Set(LANGS.map(([code]) => code));

/** Idioma elegido: el que la persona guardó; si no eligió, el de su navegador (el primero que tengamos; si ninguno, español). */
export function pickLang(saved, browserLangs = []) {
  if (SUPPORTED.has(saved)) return saved;
  for (const tag of browserLangs) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (SUPPORTED.has(base)) return base;
  }
  return 'es';
}

function readSaved() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

let lang = 'es';
export const currentLang = () => lang;

/** Guarda el idioma (también en una cookie, para que el servidor lo sepa) y recarga para dibujar todo en ese idioma. */
export function setLang(next) {
  if (!SUPPORTED.has(next)) return;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* sin storage: queda la cookie */ }
  document.cookie = `lang=${next}; path=/; max-age=31536000; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
  location.reload();
}

/* ------------------------------ Diccionario ------------------------------ */

const PLACEHOLDER = /\{(\d+)\}/g;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Prepara el diccionario: los textos fijos van a un Map (búsqueda directa) y los que llevan {0}… se vuelven
 * expresiones regulares, agrupadas por cómo empiezan o terminan para no probarlas todas con cada texto.
 */
export function compile(dict) {
  const exact = new Map();
  const byStart = new Map();
  const byEnd = new Map();
  const loose = [];
  for (const [key, value] of Object.entries(dict)) {
    const k = key.replace(/\s+/g, ' ').trim();
    if (typeof value !== 'string' || !value.trim() || !k) continue;
    if (!/\{\d+\}/.test(k)) { exact.set(k, value.trim()); continue; }
    const pieces = k.split(PLACEHOLDER);
    const literal = pieces.filter((_, i) => i % 2 === 0).join('');
    if (!/\p{L}{2}/u.test(literal)) continue; // «{0} {1}» no dice nada que traducir
    const order = [];
    const source = pieces.map((piece, i) => {
      if (i % 2 === 0) return escapeRegex(piece);
      order.push(Number(piece));
      return '([\\s\\S]+?)';
    }).join('');
    const rule = { re: new RegExp(`^${source}$`), order, value: value.trim(), weight: literal.length };
    const head = pieces[0];
    const tail = pieces[pieces.length - 1];
    if (head.length >= 3) push(byStart, head.slice(0, 3), rule);
    else if (tail.length >= 3) push(byEnd, tail.slice(-3), rule);
    else loose.push(rule);
  }
  for (const list of [...byStart.values(), ...byEnd.values(), loose]) list.sort((a, b) => b.weight - a.weight);
  return { exact, byStart, byEnd, loose, cache: new Map() };
}

function push(map, key, rule) {
  const list = map.get(key);
  if (list) list.push(rule);
  else map.set(key, [rule]);
}

/**
 * Traduce un texto ya sin espacios a los lados. Devuelve null si no está en el diccionario. Las partes que cambian
 * ({0}…) también se traducen si son textos conocidos (por ejemplo, el nombre de un rol dentro de una frase).
 */
export function translateText(text, compiled, depth = 0) {
  if (!text || !compiled) return null;
  const direct = compiled.exact.get(text);
  if (direct !== undefined) return direct;
  if (depth > 2 || text.length > MAX_RULE_TEXT || !/\p{L}/u.test(text)) return null;
  // Lo ya resuelto (también lo que no tiene traducción) no se vuelve a buscar: una tabla grande repite muchos textos.
  if (depth === 0 && compiled.cache?.has(text)) return compiled.cache.get(text);
  const done = translateByRules(text, compiled, depth);
  if (depth === 0 && compiled.cache) {
    if (compiled.cache.size >= CACHE_SIZE) compiled.cache.clear();
    compiled.cache.set(text, done);
  }
  return done;
}

/** Las frases con partes que cambian no pasan de este largo; un texto más largo es contenido, no una frase del panel. */
const MAX_RULE_TEXT = 600;
const CACHE_SIZE = 5000;

function translateByRules(text, compiled, depth) {
  const normalized = text.replace(/\s+/g, ' ');
  if (normalized !== text && compiled.exact.has(normalized)) return compiled.exact.get(normalized);
  // La regla más específica (más texto fijo) gana, venga del grupo que venga.
  const candidates = [
    ...(compiled.byStart.get(normalized.slice(0, 3)) || []),
    ...(compiled.byEnd.get(normalized.slice(-3)) || []),
    ...compiled.loose,
  ].sort((a, b) => b.weight - a.weight);
  for (const rule of candidates) {
    const m = rule.re.exec(normalized);
    if (!m) continue;
    const parts = [];
    rule.order.forEach((index, i) => {
      const raw = m[i + 1];
      const core = raw.trim();
      const inner = core ? translateText(core, compiled, depth + 1) : null;
      parts[index] = inner === null ? raw : raw.replace(core, () => inner);
    });
    return rule.value.replace(PLACEHOLDER, (_, n) => parts[Number(n)] ?? '');
  }
  return depth <= 1 ? translatePieces(normalized, compiled, depth) : null;
}

const SEPARATORS = [' · ', ': ', ' — ', ' | '];

/**
 * Último intento para textos armados con piezas sin una frase propia: «📥 Te asignaron una conversación» (un símbolo
 * delante) o «WhatsApp: no llegó · Correo: entregado» (piezas unidas con «·» o «:»). Traduce cada pieza conocida.
 */
function translatePieces(text, compiled, depth) {
  const lead = /^([^\p{L}\p{N}¿¡«"“(]+)(\p{L}[\s\S]*)$/u.exec(text);
  if (lead) {
    const rest = translateText(lead[2], compiled, depth + 1);
    if (rest !== null) return lead[1] + rest;
  }
  for (const sep of SEPARATORS) {
    if (!text.includes(sep)) continue;
    let changed = false;
    const pieces = text.split(sep).map((piece) => {
      const done = translateText(piece.trim(), compiled, depth + 1);
      if (done === null) return piece;
      changed = true;
      return piece.replace(piece.trim(), () => done);
    });
    if (changed) return pieces.join(sep);
  }
  return null;
}

/** Traduce conservando los espacios de los lados (los textos que van junto a un enlace o una negrita los llevan). */
export function translateSpaced(text, compiled) {
  const core = text.trim();
  if (!core) return null;
  const done = translateText(core, compiled);
  if (done === null || done === core) return null;
  const at = text.indexOf(core);
  return text.slice(0, at) + done + text.slice(at + core.length);
}

/* ------------------------------ En la página ------------------------------ */

let dictionary = null;
/** Para los textos que no pasan por la pantalla (confirm, prompt, un archivo descargado): t('Guardar'). */
export function t(text) {
  if (!dictionary) return text;
  return translateSpaced(String(text), dictionary) ?? text;
}

const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'aria-description', 'aria-roledescription', 'alt', 'data-label', 'data-tip'];
// Lo que escribió la gente no se toca. En un campo de texto o un bloque de código se traducen su nombre y su ejemplo
// (aria-label, placeholder) pero no su contenido.
const NO_TRANSLATE = '[translate="no"],[contenteditable=""],[contenteditable="true"]';
const SKIP = `script,style,textarea,code,pre,${NO_TRANSLATE}`;

const skipped = (el) => !el || !!el.closest(SKIP);
const attributesSkipped = (el) => !el || !!el.closest(NO_TRANSLATE);

function translateAttributes(el) {
  for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const done = translateSpaced(value, dictionary);
    if (done !== null) el.setAttribute(name, done);
  }
  if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type) && el.value) {
    const done = translateSpaced(el.value, dictionary);
    if (done !== null) el.value = done;
  }
}

function translateTextNode(node) {
  const done = translateSpaced(node.nodeValue, dictionary);
  if (done !== null) node.nodeValue = done;
}

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (!skipped(node.parentElement)) translateTextNode(node);
    return;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (!attributesSkipped(node)) translateAttributes(node);
    if (skipped(node)) return;
  } else if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== Node.ELEMENT_NODE || !n.matches(SKIP)) return NodeFilter.FILTER_ACCEPT;
      if (!n.matches(NO_TRANSLATE)) translateAttributes(n); // textarea, code…: su nombre sí, su contenido no
      return NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
    else translateAttributes(n);
  }
}

function translateTitle() {
  const done = translateSpaced(document.title, dictionary);
  if (done !== null) document.title = done;
}

/** Traduce lo que ya está en la página y lo que se vaya agregando (antes de que el navegador lo pinte). */
export function watch(root = document.documentElement) {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(translateNode);
      else if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes' && !attributesSkipped(r.target)) translateAttributes(r.target);
    }
    translateTitle();
    observer.takeRecords(); // lo que cambió el propio traductor no se vuelve a revisar
  });
  translateNode(root);
  translateTitle();
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  return observer;
}

/** Los avisos del navegador (confirm, alert, prompt) también salen traducidos. */
function wrapDialogs() {
  for (const name of ['alert', 'confirm', 'prompt']) {
    const original = window[name].bind(window);
    window[name] = (message, ...rest) => original(message === undefined ? message : t(message), ...rest);
  }
}

/** Arranque: decide el idioma, marca la página y, en inglés, carga el diccionario y empieza a traducir. */
export async function initI18n({ url = '/i18n/en.json' } = {}) {
  lang = pickLang(readSaved(), navigator.languages?.length ? navigator.languages : [navigator.language]);
  document.documentElement.lang = lang;
  if (lang === 'es') return lang;
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dictionary = compile(await response.json());
  } catch (error) {
    // Sin diccionario el panel funciona en español: mejor eso que una pantalla en blanco.
    console.warn('No se pudo cargar la traducción al inglés; el panel sigue en español.', error);
    lang = 'es';
    document.documentElement.lang = 'es';
    return lang;
  }
  wrapDialogs();
  watch();
  return lang;
}
