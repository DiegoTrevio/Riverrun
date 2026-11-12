/**
 * Fórmulas de la calculadora de cotizaciones. Analizador propio, sin `eval` ni `Function`: solo números, textos, nombres
 * de datos o cálculos, operaciones (+ - * /), comparaciones, «y», «o», «no», «cond ? a : b» y unas cuantas funciones
 * (si, redondear_arriba, redondear_abajo, redondear, min, max, abs). Lo escribe el negocio en el panel, así que todo tiene
 * topes y los errores dicen dónde están, en palabras.
 *
 * Los textos que parecen número («2», «1.5») cuentan como número en las cuentas y en las comparaciones: así una opción
 * «altura» con valor «1.5» se compara con 1.5 y se suma a 0.5 sin convertir nada a mano.
 */

export type Value = number | string | boolean;

export class FormulaError extends Error {
  constructor(message: string, readonly pos = 0) {
    super(message);
  }
}

export const FORMULA_MAX_LENGTH = 500;
const MAX_TOKENS = 300;
const MAX_DEPTH = 40;
const EPS = 1e-9;

type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'id'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'eof'; pos: number };

export type Node =
  | { k: 'lit'; v: Value }
  | { k: 'var'; name: string; pos: number }
  | { k: 'un'; op: '-' | '!'; e: Node; pos: number }
  | { k: 'bin'; op: string; l: Node; r: Node; pos: number }
  | { k: 'cond'; c: Node; a: Node; b: Node; pos: number }
  | { k: 'call'; fn: string; args: Node[]; pos: number };

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '(', ')', ',', '!', '?', ':'];
// En español y, por si alguien (o la IA que traduce las reglas) las escribe en inglés, también and / or / not.
const WORD_OPS: Record<string, string> = { y: '&&', o: '||', no: '!', and: '&&', or: '||', not: '!' };
const LITERALS: Record<string, boolean> = { verdadero: true, falso: false, true: true, false: false };
const ID_START = /[A-Za-z_À-ɏ]/;
const ID_PART = /[A-Za-z0-9_À-ɏ]/;

function tokenize(src: string): Token[] {
  if (src.length > FORMULA_MAX_LENGTH) throw new FormulaError(`La fórmula admite hasta ${FORMULA_MAX_LENGTH} caracteres`);
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (out.length >= MAX_TOKENS) throw new FormulaError('La fórmula es demasiado larga', i);
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+|^[0-9]+/.exec(src.slice(i))!;
      const v = Number(m[0]);
      // 9 repetido 400 veces es Infinity: una cantidad infinita omitía el concepto sin avisar.
      if (!Number.isFinite(v)) throw new FormulaError('El número es demasiado grande', i);
      out.push({ t: 'num', v, pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new FormulaError('Falta cerrar las comillas', i);
      if (end - i - 1 > 200) throw new FormulaError('Un texto entre comillas admite hasta 200 caracteres', i);
      out.push({ t: 'str', v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      if (lower in WORD_OPS) out.push({ t: 'op', v: WORD_OPS[lower], pos: i });
      else out.push({ t: 'id', v: word, pos: i });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op, pos: i });
      i += op.length;
      continue;
    }
    // «=» suelto suele ser un «==» mal escrito: se dice así.
    throw new FormulaError(ch === '=' ? 'Para comparar usa «==» (dos signos de igual)' : `No se entiende «${ch}»`, i);
  }
  out.push({ t: 'eof', pos: src.length });
  return out;
}

/** Funciones disponibles y cuántos argumentos aceptan. */
const FUNCTIONS: Record<string, { min: number; max: number }> = {
  si: { min: 3, max: 3 },
  redondear_arriba: { min: 1, max: 2 },
  redondear_abajo: { min: 1, max: 2 },
  redondear: { min: 1, max: 2 },
  min: { min: 1, max: 20 },
  max: { min: 1, max: 20 },
  abs: { min: 1, max: 1 },
};
export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly toks: Token[]) {}

  private peek() { return this.toks[this.i]; }
  private next() { return this.toks[this.i++]; }
  private isOp(v: string) { const t = this.peek(); return t.t === 'op' && t.v === v; }
  private expectOp(v: string, what: string) {
    const t = this.next();
    if (t.t !== 'op' || t.v !== v) throw new FormulaError(`Falta ${what}`, t.pos);
  }

  parse(): Node {
    if (this.peek().t === 'eof') throw new FormulaError('La fórmula está vacía');
    const n = this.ternary();
    const t = this.peek();
    if (t.t !== 'eof') throw new FormulaError('Sobra algo al final de la fórmula', t.pos);
    return n;
  }

  private enter(pos: number) {
    if (++this.depth > MAX_DEPTH) throw new FormulaError('La fórmula tiene demasiados niveles', pos);
  }

  private ternary(): Node {
    const start = this.peek().pos;
    this.enter(start);
    const c = this.binary(0);
    let out = c;
    if (this.isOp('?')) {
      this.next();
      const a = this.ternary();
      this.expectOp(':', '«:» después de «?»');
      const b = this.ternary();
      out = { k: 'cond', c, a, b, pos: start };
    }
    this.depth--;
    return out;
  }

  private static LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/']];

  private binary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.unary();
    let l = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !Parser.LEVELS[level].includes(t.v)) return l;
      this.next();
      const r = this.binary(level + 1);
      l = { k: 'bin', op: t.v, l, r, pos: t.pos };
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '!')) {
      this.next();
      this.enter(t.pos);
      const e = this.unary();
      this.depth--;
      return { k: 'un', op: t.v, e, pos: t.pos };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.next();
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = this.ternary();
      this.expectOp(')', '«)» para cerrar el paréntesis');
      return e;
    }
    if (t.t === 'id') {
      const lower = t.v.toLowerCase();
      if (lower in LITERALS && !this.isOp('(')) return { k: 'lit', v: LITERALS[lower] };
      if (this.isOp('(')) {
        this.next();
        const fn = FUNCTIONS[lower];
        if (!fn) throw new FormulaError(`No existe la función «${t.v}» (usa: ${FUNCTION_NAMES.join(', ')})`, t.pos);
        const args: Node[] = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.ternary());
            if (this.isOp(',')) { this.next(); continue; }
            break;
          }
        }
        this.expectOp(')', `«)» para cerrar «${t.v}(»`);
        if (args.length < fn.min || args.length > fn.max) {
          const n = fn.min === fn.max ? `${fn.min}` : `de ${fn.min} a ${fn.max}`;
          throw new FormulaError(`«${lower}» lleva ${n} valor${fn.max === 1 ? '' : 'es'} entre paréntesis`, t.pos);
        }
        return { k: 'call', fn: lower, args, pos: t.pos };
      }
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (t.t === 'eof') throw new FormulaError('La fórmula termina antes de tiempo', t.pos);
    throw new FormulaError(`No se esperaba «${t.v}»`, t.pos);
  }
}

export interface Compiled {
  source: string;
  ast: Node;
  /** Nombres de datos o cálculos que usa la fórmula. */
  refs: string[];
}

function collectRefs(n: Node, out: Set<string>) {
  switch (n.k) {
    case 'var': out.add(n.name); break;
    case 'un': collectRefs(n.e, out); break;
    case 'bin': collectRefs(n.l, out); collectRefs(n.r, out); break;
    case 'cond': collectRefs(n.c, out); collectRefs(n.a, out); collectRefs(n.b, out); break;
    case 'call': n.args.forEach((a) => collectRefs(a, out)); break;
  }
}

/** Revisa y prepara una fórmula. Con `known`, cada nombre que use tiene que existir (si no, dice cuál falta). */
export function compile(source: string, known?: ReadonlySet<string>): Compiled {
  const ast = new Parser(tokenize(source)).parse();
  const refs = new Set<string>();
  collectRefs(ast, refs);
  if (known) {
    for (const name of refs) {
      if (!known.has(name)) throw new FormulaError(`No existe el dato o cálculo «${name}»`, source.indexOf(name));
    }
  }
  return { source, ast, refs: [...refs] };
}

/* ------------------------------ Evaluación ------------------------------ */

const NUMERIC = /^\s*-?(?:\d+\.?\d*|\.\d+)\s*$/;

/** El número de un valor, si lo es (los textos numéricos cuentan como número). */
export function numericValue(v: Value): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUMERIC.test(v)) return Number(v);
  return null;
}

/** Texto para comparar o para buscar en la lista de precios: sin acentos, en minúsculas y sin espacios de sobra. */
export const normalizeText = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

/** Un número como texto, sin ceros de sobra (2 → «2», 2.5 → «2.5», 1/3 → «0.333»). */
export const formatNumber = (n: number) => String(Math.round(n * 1000) / 1000);

export const valueText = (v: Value) => (typeof v === 'number' ? formatNumber(v) : typeof v === 'boolean' ? (v ? 'sí' : 'no') : v);

/** ¿Son iguales? Números (o textos numéricos) por su valor; textos sin importar acentos ni mayúsculas. */
export function sameValue(a: Value, b: Value): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < EPS;
  return normalizeText(String(a)) === normalizeText(String(b));
}

function describe(v: Value) {
  return typeof v === 'string' ? `«${v}»` : typeof v === 'boolean' ? (v ? 'verdadero' : 'falso') : formatNumber(v);
}

function num(v: Value, pos: number): number {
  const n = numericValue(v);
  if (n === null) throw new FormulaError(`${describe(v)} no es un número`, pos);
  return n;
}

function bool(v: Value, pos: number): boolean {
  if (typeof v !== 'boolean') throw new FormulaError(`Se esperaba una condición (verdadero o falso) y salió ${describe(v)}`, pos);
  return v;
}

function finite(n: number, pos: number): number {
  if (!Number.isFinite(n)) throw new FormulaError('El resultado no es un número válido', pos);
  return n;
}

export function evaluate(n: Node, scope: Readonly<Record<string, Value>>): Value {
  switch (n.k) {
    case 'lit': return n.v;
    case 'var': {
      if (!Object.prototype.hasOwnProperty.call(scope, n.name)) throw new FormulaError(`No existe el dato o cálculo «${n.name}»`, n.pos);
      return scope[n.name];
    }
    case 'un': {
      const v = evaluate(n.e, scope);
      return n.op === '-' ? -num(v, n.pos) : !bool(v, n.pos);
    }
    case 'cond': return bool(evaluate(n.c, scope), n.pos) ? evaluate(n.a, scope) : evaluate(n.b, scope);
    case 'bin': {
      if (n.op === '&&') return bool(evaluate(n.l, scope), n.pos) && bool(evaluate(n.r, scope), n.pos);
      if (n.op === '||') return bool(evaluate(n.l, scope), n.pos) || bool(evaluate(n.r, scope), n.pos);
      const l = evaluate(n.l, scope);
      const r = evaluate(n.r, scope);
      switch (n.op) {
        case '==': return sameValue(l, r);
        case '!=': return !sameValue(l, r);
        case '<': return num(l, n.pos) < num(r, n.pos) - EPS;
        case '<=': return num(l, n.pos) <= num(r, n.pos) + EPS;
        case '>': return num(l, n.pos) > num(r, n.pos) + EPS;
        case '>=': return num(l, n.pos) >= num(r, n.pos) - EPS;
        case '+': {
          const nl = numericValue(l);
          const nr = numericValue(r);
          if (nl !== null && nr !== null) return finite(nl + nr, n.pos);
          if (typeof l === 'boolean' || typeof r === 'boolean') throw new FormulaError('No se puede sumar una condición', n.pos);
          return `${valueText(l)}${valueText(r)}`;
        }
        case '-': return finite(num(l, n.pos) - num(r, n.pos), n.pos);
        case '*': return finite(num(l, n.pos) * num(r, n.pos), n.pos);
        case '/': {
          const d = num(r, n.pos);
          if (Math.abs(d) < EPS) throw new FormulaError('División entre cero', n.pos);
          return finite(num(l, n.pos) / d, n.pos);
        }
      }
      throw new FormulaError(`Operación desconocida «${n.op}»`, n.pos);
    }
    case 'call': {
      if (n.fn === 'si') return bool(evaluate(n.args[0], scope), n.pos) ? evaluate(n.args[1], scope) : evaluate(n.args[2], scope);
      const args = n.args.map((a) => num(evaluate(a, scope), n.pos));
      switch (n.fn) {
        case 'redondear_arriba':
        case 'redondear_abajo': {
          const step = args[1] ?? 1;
          if (step <= 0) throw new FormulaError('El paso para redondear debe ser mayor que 0', n.pos);
          const q = args[0] / step;
          // Un margen mínimo: 37.5 / 2.5 da 15 exacto y no 15.000000000000002 → 16.
          const r = n.fn === 'redondear_arriba' ? Math.ceil(q - EPS) : Math.floor(q + EPS);
          return finite(r * step, n.pos);
        }
        case 'redondear': {
          const d = args[1] ?? 0;
          if (!Number.isInteger(d) || d < 0 || d > 6) throw new FormulaError('Los decimales para redondear van de 0 a 6', n.pos);
          const f = 10 ** d;
          return finite(Math.round((args[0] + Math.sign(args[0]) * EPS) * f) / f, n.pos);
        }
        case 'min': return finite(Math.min(...args), n.pos);
        case 'max': return finite(Math.max(...args), n.pos);
        case 'abs': return finite(Math.abs(args[0]), n.pos);
      }
      throw new FormulaError(`No existe la función «${n.fn}»`, n.pos);
    }
  }
}

/** Compila y evalúa en un paso (para probar una fórmula suelta). */
export function run(source: string, scope: Readonly<Record<string, Value>>): Value {
  return evaluate(compile(source, new Set(Object.keys(scope))).ast, scope);
}
