/**
 * Cuentas que escribe la IA al cotizar con las instrucciones del agente (sin calculadora armada): «40 ÷ 2.50 = 16 paneles
 * × $1,000 = $16,000», «Subtotal», «IVA (16%)» y «Total». El sistema revisa cada operación y corrige el resultado si la IA
 * se equivocó, así la suma y la multiplicación salen bien aunque la IA no las haga bien.
 *
 * Una operación cuenta solo si cada número sale de un lugar confiable:
 * - un precio ($) del negocio o un resultado ya revisado de la misma respuesta;
 * - un porcentaje del negocio (el IVA);
 * - una cantidad que dijo el cliente, solo multiplicando (el cliente no dicta precios, descuentos ni divisores);
 * - en cuentas de cantidades sin dinero («16 + 1 = 17 postes»), también los números de las reglas del negocio.
 * Si un número no cumple, la operación no se toma en cuenta y el monto pasa por la verificación normal (cero invenciones).
 */
import { canonicalNumber, type FactCorpus } from './text.js';

type Op = '×' | '÷' | '+' | '-' | '=';
type Tok = {
  start: number;
  end: number;
  raw: string;
  value: number;
  money: boolean;
  percent: boolean;
  commas: boolean;
  decimals: boolean;
  /** Resultado de una operación revisada en esta respuesta. */
  derived: boolean;
  /** El sistema cambió la cifra: se reescribe en el texto. */
  rewritten: boolean;
};

export type ArithmeticResult = {
  /** Los mensajes con las cuentas corregidas. */
  messages: string[];
  /** Qué se corrigió («$6,900 → $6,800»), para la bitácora. */
  corrections: string[];
  /** Resultados revisados (cifra canónica, p. ej. "16000", "3830.4"): ya no cuentan como inventados. */
  derived: Set<string>;
};

const TOKEN_RE = /(US\$|\$)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?%)?/g;
const MONEY_AFTER_RE = /^\s?(?:mxn|pesos|m\.?n\.?|usd)(?![\p{L}])/iu;
/** Entre dos números: lo que corta una operación (fin de oración, dos puntos, paréntesis, coma con espacio). */
const BREAK_RE = /[.;:!?()\n[\]]|,\s/;
const SUBTOTAL_RE = /sub\s?-?total/;
const IVA_RE = /(^|[^\p{L}])iva([^\p{L}]|$)/u;
const TOTAL_RE = /(^|[^\p{L}])total([^\p{L}]|$)/u;
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const round2 = (n: number) => Math.round(n * 100) / 100;
const same = (a: number, b: number) => Math.abs(a - b) < 0.011;
const canon = (n: number) => String(round2(n));

function opIn(gap: string): Op | null {
  if (gap.length > 40 || BREAK_RE.test(gap)) return null;
  const g = gap.trim().toLowerCase();
  if (g === '-' || g === '−' || g === '–') return '-';
  if (g === '/') return '÷';
  if (g === '*') return '×';
  const found: Op[] = [];
  for (const ch of g) {
    if (ch === '×' || ch === '·') found.push('×');
    else if (ch === '÷') found.push('÷');
    else if (ch === '+') found.push('+');
    else if (ch === '=') found.push('=');
  }
  if (/(^|\s)x(\s|$)/.test(g)) found.push('×');
  return found.length === 1 ? found[0] : null;
}

function tokensOf(line: string): Tok[] {
  const out: Tok[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    const num = m[2];
    const start = m.index! + (m[0].length - m[0].trimStart().length);
    const end = m.index! + m[0].length;
    const money = !!m[1] || MONEY_AFTER_RE.test(line.slice(end));
    const percent = !!m[3] && !money;
    const v = Number(num.replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    out.push({ start, end, raw: m[0].trim(), value: percent ? v / 100 : v, money, percent, commas: num.includes(','), decimals: /\.\d+$/.test(num), derived: false, rewritten: false });
  }
  return out;
}

function format(t: Tok, v: number): string {
  const r = round2(v);
  let s = t.decimals || !Number.isInteger(r) ? r.toFixed(2) : String(r);
  if (t.commas || (t.money && Math.abs(r) >= 1000)) {
    const [i, d] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? `.${d}` : '');
  }
  const prefix = /^US\$/.test(t.raw) ? 'US$' : t.raw.startsWith('$') ? '$' : '';
  return prefix + s;
}

function rewrite(t: Tok, v: number, corrections: string[], why = '') {
  const to = format(t, v);
  corrections.push(`${t.raw} → ${to}${why}`);
  t.raw = to;
  t.value = round2(v);
  t.decimals = t.decimals || !Number.isInteger(t.value);
  t.rewritten = true;
}

/** Evalúa con × y ÷ antes que + y −. */
function evaluate(vals: number[], ops: Op[]): number {
  const terms = [vals[0]];
  const signs: Op[] = [];
  for (let i = 0; i < ops.length; i++) {
    const x = vals[i + 1];
    if (ops[i] === '×') terms[terms.length - 1] *= x;
    else if (ops[i] === '÷') terms[terms.length - 1] /= x;
    else { signs.push(ops[i]); terms.push(x); }
  }
  return terms.slice(1).reduce((acc, x, i) => (signs[i] === '+' ? acc + x : acc - x), terms[0]);
}

/**
 * Revisa y corrige las cuentas de la respuesta. `trusted` = información del negocio; `customer` = lo que dijo el cliente.
 * Los mensajes se revisan en orden y comparten lo calculado (una cotización puede venir en varias burbujas).
 */
export function fixArithmetic(messages: string[], trusted: FactCorpus, customer?: FactCorpus): ArithmeticResult {
  const corrections: string[] = [];
  const derived = new Set<string>();
  /**
   * Importe de cada renglón (el último monto de cada cadena de operaciones). `sum`: salió de sumar otros renglones
   * («Subtotal materiales: $8,500 + $4,950 = $13,450»), así que también puede ser la base del IVA.
   */
  let items: { v: number; sum: boolean }[] = [];
  /** Montos sueltos ya verificados fuera de las operaciones (un flete o una instalación de la lista de precios). */
  let loose: number[] = [];
  /** Hubo un monto suelto sin respaldo: el sistema ya no sabe de qué sale el total. */
  let unknownLoose = false;
  let subtotal: number | null = null;
  let iva: { v: number; base: number } | null = null;
  const reset = () => { items = []; loose = []; unknownLoose = false; subtotal = null; iva = null; };

  const ivaRate = trusted.ivaRate();
  /** ¿Es el IVA (con la tasa del negocio) de un precio del negocio o de un resultado ya revisado? */
  const isIvaOf = (v: number) => {
    if (ivaRate === null || v <= 0) return false;
    const base = round2(v / ivaRate);
    return [base, base - 0.01, base + 0.01].some((b) => same(round2(b * ivaRate), v) && (derived.has(canon(b)) || trusted.hasMoney(canon(b))));
  };

  const known = (t: Tok, ops: (Op | null)[], j: number, hasMoney: boolean) => {
    // Un resultado ya revisado en esta respuesta, aunque se use en otro renglón («16 paneles» y luego «16 × $1,000»).
    if (t.derived || (!t.percent && derived.has(canon(t.value)))) return true;
    const c = canonicalNumber(t.raw.replace(/^(US\$|\$)\s?/, '').replace(/\s?%$/, ''));
    if (t.money) return trusted.hasMoney(c) || isIvaOf(t.value);
    if (t.percent) return trusted.hasPercent(c);
    if (!hasMoney) return c.length === 1 || trusted.hasNumber(c) || !!customer?.hasNumber(c);
    // «× 0.16» o «× 1.16»: el IVA (u otro porcentaje del negocio) escrito como decimal.
    const mult = [ops[j], ops[j + 1]].every((o) => !o || o === '×' || o === '=');
    if (mult && !Number.isInteger(t.value) && (trusted.hasPercent(canon(t.value * 100)) || trusted.hasPercent(canon((t.value - 1) * 100)))) return true;
    // Con dinero, un número sin $ solo puede ser una cantidad entera del cliente que multiplica: «0.5» o «0.9» serían un
    // descuento dictado por el cliente.
    return Number.isInteger(t.value) && t.value > 0 && !!customer?.hasNumber(c) && [ops[j], ops[j + 1]].every((o) => !o || o === '×' || o === '=');
  };

  const line = (text: string): string => {
    // «17 postes × 4 (para 2.00 m de altura) = 68»: un comentario entre paréntesis sin "=" no corta la operación. Se tapa
    // con espacios del mismo largo (las posiciones no cambian) y se deja «(16%)» para leer la tasa del IVA.
    const plain = text.replace(/\([^()=]*\)/g, (m) => (/^\(\s*\d+(?:[.,]\d+)?\s?%\s*\)$/.test(m) ? m : ' '.repeat(m.length)));
    const toks = tokensOf(plain);
    if (!toks.length) return text;
    const ops: (Op | null)[] = toks.map((t, i) => (i ? opIn(plain.slice(toks[i - 1].end, t.start)) : null));
    let chainMoney: { v: number; sum: boolean } | null = null;
    let usedChain = false;
    let segStart = 0;
    // Cadenas: números unidos por operaciones; cada "=" cierra una operación y su resultado abre la siguiente.
    for (let i = 1; i <= toks.length; i++) {
      const op = i < toks.length ? ops[i] : null;
      if (op === null) {
        if (chainMoney !== null) items.push(chainMoney);
        chainMoney = null;
        segStart = i;
        continue;
      }
      if (op !== '=') continue;
      usedChain = true;
      const expr = toks.slice(segStart, i);
      const exprOps: (Op | null)[] = [null, ...ops.slice(segStart + 1, i), '='];
      const res = toks[i];
      segStart = i;
      if (expr.length < 2) continue;
      const hasMoney = expr.some((t) => t.money) || res.money;
      if (!expr.every((t, j) => known(t, exprOps, j, hasMoney))) continue;
      // «$1,000 - 10%» se lee de varias formas: solo se revisan porcentajes que multiplican («$22,800 × 16%»).
      if (expr.some((t, j) => t.percent && [exprOps[j], exprOps[j + 1]].some((o) => o === '+' || o === '-' || o === '÷'))) continue;
      const value = evaluate(expr.map((t) => t.value), exprOps.slice(1, -1) as Op[]);
      // Un resultado negativo no es una cuenta de cotización (p. ej. un rango «$20 - $30»).
      if (!Number.isFinite(value) || value < 0 || res.percent) continue;
      const division = exprOps.includes('÷');
      // Una división puede redondearse a entero (p. ej. «paneles = metros ÷ 2.50 hacia arriba»).
      const rounded = division && (res.value === Math.ceil(value - 1e-9) || res.value === Math.floor(value + 1e-9));
      if (!same(res.value, value) && !rounded) {
        const to = division && !hasMoney && !Number.isInteger(round2(value)) ? Math.ceil(value) : value;
        rewrite(res, to, corrections, ` (${expr.map((t) => t.raw).join(' · ')})`);
      }
      res.derived = true;
      derived.add(canon(res.value));
      for (const t of expr) if (!t.percent) derived.add(canon(t.value));
      if (hasMoney) {
        // Una suma de importes ya contados («$16,000 + $7,650 = $23,650») los reemplaza: no se cuentan dos veces.
        const isSum = exprOps.slice(1, -1).every((o) => o === '+');
        if (isSum) {
          for (const t of expr) {
            const k = items.findIndex((x) => same(x.v, t.value));
            if (k >= 0) items.splice(k, 1);
            else {
              const l = loose.findIndex((x) => same(x, t.value));
              if (l >= 0) loose.splice(l, 1);
            }
          }
        }
        chainMoney = { v: res.value, sum: isSum };
      }
    }

    // Subtotal, IVA y total sin operación escrita. Se aceptan si salen de una base razonable (todos los renglones, el último
    // subtotal o eso más los montos sueltos de la lista, como el flete). Solo se corrigen si la base es una sola, sin dudas:
    // la IA puede calcular el IVA solo de los materiales y sumar la instalación aparte, y eso no es un error.
    const money = toks.filter((t) => t.money);
    if (!usedChain && money.length) {
      const f = fold(plain);
      const isSubtotal = SUBTOTAL_RE.test(f);
      const isTotal = TOTAL_RE.test(f) && !isSubtotal;
      const isIva = IVA_RE.test(f) && !isSubtotal && !isTotal;
      if (!isSubtotal && !isTotal && !isIva) {
        if (items.length) {
          for (const t of money) {
            const c = canonicalNumber(t.raw.replace(/^(US\$|\$)\s?/, ''));
            if (derived.has(canon(t.value)) || trusted.hasMoney(c) || isIvaOf(t.value)) loose.push(t.value);
            else unknownLoose = true;
          }
        }
      } else if (money.length === 1 && items.length) {
        const t = money[0];
        const sumItems = round2(items.reduce((a, b) => a + b.v, 0));
        const sumLoose = round2(loose.reduce((a, b) => a + b, 0));
        const bases = new Set<number>(subtotal !== null ? [subtotal] : [sumItems]);
        if (subtotal === null) {
          if (loose.length) bases.add(round2(sumItems + sumLoose));
          const last = items.at(-1)!;
          if (last.sum) bases.add(last.v);
        }
        // Base → resultado esperado.
        const cands = new Map<number, number>();
        if (isSubtotal) for (const b of bases) cands.set(b, b);
        else if (isIva) {
          const pcts = toks.filter((x) => x.percent);
          // El porcentaje del renglón debe ser del negocio; si no dice cuál, el de la información.
          const rate = pcts.length === 1 && trusted.hasPercent(canon(pcts[0].value * 100)) ? pcts[0].value : pcts.length ? null : ivaRate;
          if (rate !== null) for (const b of bases) cands.set(b, round2(b * rate));
        } else if (iva) {
          cands.set(iva.base, round2(iva.base + iva.v));
          if (loose.length) cands.set(iva.base + sumLoose, round2(iva.base + iva.v + sumLoose));
        } else if (!IVA_RE.test(f)) {
          // «Total con IVA» sin el renglón del IVA: no se sabe si los precios ya lo incluyen; no se rehace.
          for (const b of bases) cands.set(b, b);
        }
        const hit = [...cands].find(([, v]) => same(t.value, v));
        const values = new Set([...cands.values()]);
        let base: number | null = null;
        if (hit) base = hit[0];
        else if (values.size === 1 && !loose.length && !unknownLoose) {
          const [[b, v]] = [...cands];
          rewrite(t, v, corrections);
          base = b;
        }
        if (base !== null) {
          derived.add(canon(t.value));
          if (isSubtotal) subtotal = t.value;
          if (isIva) iva = { v: t.value, base };
        }
      }
      if (isTotal) reset();
    }

    let out = text;
    for (const t of [...toks].reverse()) if (t.rewritten) out = out.slice(0, t.start) + t.raw + out.slice(t.end);
    return out;
  };

  const fixed = messages.map((m) => m.split('\n').map(line).join('\n'));
  return { messages: fixed, corrections, derived };
}
