/**
 * Calculadora de cotizaciones: la configuración (en datos, por cuenta) que convierte lo que dijo el cliente en conceptos
 * con cantidad y precio. Es igual para cualquier giro: cercas por metro lineal, superficies por m², eventos por persona,
 * servicios por hora o productos con mayoreo. Seis bloques:
 *
 * 1. Datos que pide el asistente (`inputs`): número, opción, sí/no o texto corto.
 * 2. Cálculos (`values`), en orden: una fórmula o un escalón («según metros: menos de 15 → A, …»).
 * 3. Conceptos (`lines`): de qué familia de la lista de precios, buscado por qué atributos, con qué cantidad y cuándo.
 * 4. Reglas para pasar con un asesor (`stops`): cuándo no se cotiza solo.
 * 5. La leyenda y el tipo de cotización (aproximada o final).
 *
 * `evaluateCalculator` es pura y determinista: con los mismos datos y la misma lista de precios da siempre lo mismo. Los
 * montos salen de `priceQuote` (centavos enteros); la IA solo junta los datos.
 */
import { z } from 'zod';
import { compile, evaluate, FormulaError, normalizeText, numericValue, sameValue, valueText, type Compiled, type Value } from './formula.js';
import { MAX_LINES, MAX_QTY, priceQuote, type LineInput, type PricedQuote, type PricingSettings } from './pricing.js';
import type { PriceItem } from '../store/quotes.js';

/* ------------------------------ Definición ------------------------------ */

const KEY_RE = /^[a-z_][a-z0-9_]{0,39}$/;
const Key = z.string().regex(KEY_RE, 'Usa minúsculas, números y guion bajo, empezando con letra (p. ej. metros_lineales)');
const Formula = z.string().trim().min(1, 'Escribe la fórmula').max(500);
const OptionalFormula = z.string().trim().max(500).default('');

const InputDef = z.object({
  key: Key,
  label: z.string().trim().min(1, 'Escribe cómo se llama el dato').max(80),
  /** Cómo lo pregunta el asistente o qué aclarar (opcional). */
  help: z.string().trim().max(200).default(''),
  type: z.enum(['number', 'option', 'boolean', 'text']),
  unit: z.string().trim().max(30).default(''),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  decimals: z.number().int().min(0).max(3).default(2),
  options: z.array(z.object({
    value: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(80),
  })).max(50).default([]),
  /** Obligatorio: sin él no se cotiza. Si no, se usa `default` cuando el cliente no lo menciona. */
  required: z.boolean().default(true),
  default: z.union([z.number(), z.string(), z.boolean()]).optional(),
});

const TierStep = z.object({
  /** El escalón aplica si el valor es menor que esto. */
  below: z.number().finite(),
  value: z.string().trim().min(1).max(40),
});

const ValueDef = z.object({
  key: Key,
  label: z.string().trim().max(80).default(''),
  formula: z.string().trim().max(500).optional(),
  tiers: z.object({
    of: Formula,
    steps: z.array(TierStep).min(1).max(20),
    /** Lo que pasa desde el último escalón: otro valor o pasar con un asesor (con este mensaje). */
    otherwise: z.object({
      value: z.string().trim().max(40).optional(),
      stop: z.string().trim().max(300).optional(),
    }).default({}),
  }).optional(),
});

const LineDef = z.object({
  /** Nombre del concepto en la cotización; puede usar {dato} (vacío = el nombre de la lista de precios). */
  label: z.string().trim().max(200).default(''),
  family: z.string().trim().min(1, 'Escribe la familia de la lista de precios').max(60),
  /** Atributo de la lista de precios → fórmula con el valor que debe tener. */
  match: z.record(z.string().regex(KEY_RE, 'Atributo no válido'), Formula).default({}),
  qty: Formula,
  /** Condición: el concepto solo va si se cumple (vacío = siempre). */
  when: OptionalFormula,
});

const StopDef = z.object({
  when: Formula,
  message: z.string().trim().min(1, 'Escribe qué le dice el asistente al cliente').max(300),
});

export const CalculatorDefinition = z.object({
  inputs: z.array(InputDef).min(1, 'Agrega al menos un dato').max(30),
  values: z.array(ValueDef).max(60).default([]),
  lines: z.array(LineDef).min(1, 'Agrega al menos un concepto').max(60),
  stops: z.array(StopDef).max(30).default([]),
  /** Leyenda de la cotización (aproximada, vigencia, qué no incluye). */
  legend: z.string().trim().max(500).default(''),
  kind: z.enum(['approximate', 'final']).default('approximate'),
});

export type CalculatorDefinition = z.infer<typeof CalculatorDefinition>;
export type InputDef = z.infer<typeof InputDef>;

const RESERVED = new Set(['si', 'y', 'o', 'no', 'and', 'or', 'not', 'verdadero', 'falso', 'true', 'false', 'redondear', 'redondear_arriba', 'redondear_abajo', 'min', 'max', 'abs']);

interface CompiledCalculator {
  def: CalculatorDefinition;
  values: { key: string; formula?: Compiled; tiers?: { of: Compiled; steps: { below: number; value: string }[]; otherwise: { value?: string; stop?: string } } }[];
  lines: { def: CalculatorDefinition['lines'][number]; qty: Compiled; when: Compiled | null; match: [string, Compiled][] }[];
  stops: { when: Compiled; message: string }[];
}

export class CalculatorError extends Error {}

/** Error de una fórmula con el lugar donde está, en palabras para el negocio. */
function at(place: string, fn: () => Compiled): Compiled {
  try { return fn(); } catch (e: any) {
    if (e instanceof FormulaError) throw new CalculatorError(`${place}: ${e.message}`);
    throw e;
  }
}

/** Revisa la definición completa y deja listas las fórmulas. Lanza `CalculatorError` con el primer problema. */
export function prepareCalculator(raw: unknown): CompiledCalculator {
  const parsed = CalculatorDefinition.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CalculatorError(`${placeOf(issue.path)}${issue.message}`);
  }
  const def = parsed.data;
  const known = new Set<string>();
  const add = (key: string, place: string) => {
    if (RESERVED.has(key)) throw new CalculatorError(`${place}: «${key}» es una palabra reservada; usa otro nombre`);
    if (known.has(key)) throw new CalculatorError(`${place}: ya hay otro dato o cálculo llamado «${key}»`);
    known.add(key);
  };

  def.inputs.forEach((d, i) => {
    const place = `Dato ${i + 1} (${d.label})`;
    add(d.key, place);
    if (d.type === 'option') {
      if (d.options.length < 2) throw new CalculatorError(`${place}: una opción necesita al menos dos valores`);
      const seen = new Set<string>();
      for (const o of d.options) {
        const k = normalizeText(o.value);
        if (seen.has(k)) throw new CalculatorError(`${place}: el valor «${o.value}» está repetido`);
        seen.add(k);
      }
    }
    if (d.min !== undefined && d.max !== undefined && d.min > d.max) throw new CalculatorError(`${place}: el mínimo es mayor que el máximo`);
    if (!d.required && d.default === undefined && d.type !== 'boolean' && d.type !== 'text') {
      throw new CalculatorError(`${place}: un dato opcional necesita un valor cuando el cliente no lo dice`);
    }
  });

  const values: CompiledCalculator['values'] = def.values.map((v, i) => {
    const place = `Cálculo ${i + 1} (${v.label || v.key})`;
    if (!!v.formula === !!v.tiers) throw new CalculatorError(`${place}: lleva una fórmula o escalones (uno de los dos)`);
    let out: CompiledCalculator['values'][number];
    if (v.formula) out = { key: v.key, formula: at(place, () => compile(v.formula!, known)) };
    else {
      const t = v.tiers!;
      for (let s = 1; s < t.steps.length; s++) {
        if (!(t.steps[s].below > t.steps[s - 1].below)) throw new CalculatorError(`${place}: los escalones deben ir de menor a mayor`);
      }
      if (!t.otherwise.value && !t.otherwise.stop) throw new CalculatorError(`${place}: di qué pasa desde el último escalón (otro valor o pasar con un asesor)`);
      out = { key: v.key, tiers: { of: at(`${place}, según`, () => compile(t.of, known)), steps: t.steps, otherwise: t.otherwise } };
    }
    add(v.key, place);
    return out;
  });

  const lines: CompiledCalculator['lines'] = def.lines.map((l, i) => {
    const place = `Concepto ${i + 1} (${l.label || l.family})`;
    return {
      def: l,
      qty: at(`${place}, cantidad`, () => compile(l.qty, known)),
      when: l.when ? at(`${place}, condición`, () => compile(l.when, known)) : null,
      match: Object.entries(l.match).map(([attr, f]) => [attr, at(`${place}, ${attr}`, () => compile(f, known))] as [string, Compiled]),
    };
  });
  for (const [i, l] of def.lines.entries()) {
    for (const name of [...l.label.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)].map((m) => m[1])) {
      if (!known.has(name)) throw new CalculatorError(`Concepto ${i + 1} (${l.label}): el nombre usa {${name}}, que no existe`);
    }
  }

  const stops = def.stops.map((s, i) => ({ when: at(`Regla para pasar con un asesor ${i + 1}`, () => compile(s.when, known)), message: s.message }));
  return { def, values, lines, stops };
}

/** El primer problema de una definición, o `null` si está bien. */
export function calculatorProblem(raw: unknown): string | null {
  try { prepareCalculator(raw); return null; } catch (e: any) {
    if (e instanceof CalculatorError) return e.message;
    throw e;
  }
}

function placeOf(path: readonly PropertyKey[]): string {
  const names: Record<string, string> = { inputs: 'Dato', values: 'Cálculo', lines: 'Concepto', stops: 'Regla para pasar con un asesor' };
  const [section, index] = path;
  if (typeof section === 'string' && names[section] && typeof index === 'number') return `${names[section]} ${index + 1}: `;
  return '';
}

/* ------------------------------ Datos del cliente ------------------------------ */

/** Un número escrito por una persona: «40», «40.5», «40,5», «1,250», «2 m». */
export function parseHumanNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/\s+/g, '').replace(/[a-záéíóúñ²³]+\.?$/i, '');
  if (!s) return null;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}

const YES = new Set(['si', 'sí', 'true', '1', 'yes', 'verdadero']);
const NO = new Set(['no', 'false', '0', 'falso']);

export interface InputCheck {
  values: Record<string, Value>;
  /** Datos obligatorios que faltan (en orden de pregunta). */
  missing: InputDef[];
  /** Datos con un valor que no sirve, con el motivo. */
  invalid: { key: string; label: string; message: string }[];
}

/** Revisa los datos que juntó el asistente contra la definición. */
export function checkInputs(def: CalculatorDefinition, raw: Record<string, unknown>): InputCheck {
  const values: Record<string, Value> = {};
  const missing: InputDef[] = [];
  const invalid: InputCheck['invalid'] = [];
  for (const d of def.inputs) {
    const given = raw[d.key];
    const empty = given === undefined || given === null || (typeof given === 'string' && !given.trim());
    if (empty) {
      if (d.required) missing.push(d);
      else values[d.key] = d.default ?? (d.type === 'boolean' ? false : d.type === 'text' ? '' : 0);
      continue;
    }
    const bad = (message: string) => invalid.push({ key: d.key, label: d.label, message });
    switch (d.type) {
      case 'number': {
        const n = parseHumanNumber(given);
        if (n === null) { bad('no es un número'); break; }
        if (d.min !== undefined && n < d.min) { bad(`debe ser al menos ${valueText(d.min)}`); break; }
        if (d.max !== undefined && n > d.max) { bad(`debe ser a lo más ${valueText(d.max)}`); break; }
        const f = 10 ** d.decimals;
        if (Math.abs(Math.round(n * f) - n * f) > 1e-6) { bad(d.decimals ? `admite hasta ${d.decimals} decimales` : 'debe ser un número entero'); break; }
        values[d.key] = n;
        break;
      }
      case 'option': {
        const text = String(given);
        const found = d.options.find((o) => sameValue(o.value, text) || normalizeText(o.label) === normalizeText(text));
        if (!found) { bad(`no está entre las opciones (${d.options.map((o) => o.label).join(', ')})`); break; }
        values[d.key] = found.value;
        break;
      }
      case 'boolean': {
        if (typeof given === 'boolean') { values[d.key] = given; break; }
        const t = normalizeText(String(given));
        if (YES.has(t)) values[d.key] = true;
        else if (NO.has(t)) values[d.key] = false;
        else bad('se responde con sí o no');
        break;
      }
      case 'text': {
        const t = String(given).trim();
        if (t.length > 120) { bad('admite hasta 120 caracteres'); break; }
        values[d.key] = t;
        break;
      }
    }
  }
  return { values, missing, invalid };
}

/* ------------------------------ Evaluación ------------------------------ */

export interface CalculatedLine extends LineInput {
  price_item_id: string;
}

export type CalculatorResult =
  | {
      ok: true;
      lines: CalculatedLine[];
      priced: PricedQuote;
      /** Datos y cálculos con los que salió (para guardarlos con la cotización y mostrarlos al probar). */
      scope: Record<string, Value>;
      kind: CalculatorDefinition['kind'];
      legend: string;
    }
  /** Faltan datos obligatorios: el asistente los pregunta, uno a la vez, en este orden. */
  | { ok: false; reason: 'missing'; missing: { key: string; label: string; help: string }[]; message: string }
  /** Un dato no sirve (fuera de rango, opción que no existe): el asistente lo vuelve a preguntar. */
  | { ok: false; reason: 'invalid'; invalid: InputCheck['invalid']; message: string }
  /** Una regla del negocio dice que esto lo ve un asesor. `message` es para el cliente. */
  | { ok: false; reason: 'stop'; message: string; scope: Record<string, Value> }
  /** Falta un precio en la lista (o hay más de uno que coincide): lo ve un asesor y el negocio debe completar su lista. */
  | { ok: false; reason: 'price'; message: string; detail: string; scope: Record<string, Value> }
  /** Error de la configuración al evaluar (p. ej. una cuenta que no da número). Para el negocio; al cliente, un asesor. */
  | { ok: false; reason: 'error'; message: string; detail: string };

/** Lo que el asistente le dice al cliente cuando la calculadora no puede cotizar sola. */
export const ADVISOR_MESSAGE = 'Para cotizar esto con precisión, uno de nuestros asesores lo revisa y te contacta.';

function attrMatches(item: PriceItem, attr: string, wanted: Value): boolean {
  const have = item.attributes?.[attr];
  if (have === undefined || have === null || have === '') return false;
  return sameValue(String(have), wanted);
}

function interpolate(template: string, scope: Record<string, Value>): string {
  return template.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, k: string) => (k in scope ? valueText(scope[k]) : `{${k}}`));
}

/**
 * Cotiza con la calculadora: revisa los datos, calcula, aplica las reglas para pasar con un asesor, arma los conceptos
 * con la lista de precios (solo los activos) y los pasa por `priceQuote`.
 */
export function evaluateCalculator(
  raw: unknown,
  inputs: Record<string, unknown>,
  items: readonly PriceItem[],
  settings: PricingSettings,
): CalculatorResult {
  let calc: CompiledCalculator;
  try { calc = prepareCalculator(raw); } catch (e: any) {
    if (e instanceof CalculatorError) return { ok: false, reason: 'error', message: ADVISOR_MESSAGE, detail: e.message };
    throw e;
  }
  const { def } = calc;
  const check = checkInputs(def, inputs);
  if (check.invalid.length) {
    const first = check.invalid[0];
    return { ok: false, reason: 'invalid', invalid: check.invalid, message: `${first.label}: ${first.message}` };
  }
  if (check.missing.length) {
    // Con lo que ya dijo el cliente quizá basta para saber que lo atiende un asesor (p. ej. 150 metros cuando el
    // límite es 100): no tiene caso seguir pidiendo datos.
    const early = earlyStop(calc, check.values);
    if (early) return { ok: false, reason: 'stop', message: early, scope: check.values };
    return {
      ok: false,
      reason: 'missing',
      missing: check.missing.map((d) => ({ key: d.key, label: d.label, help: d.help })),
      message: `Falta: ${check.missing.map((d) => d.label).join(', ')}`,
    };
  }

  const scope: Record<string, Value> = { ...check.values };
  const fail = (detail: string) => ({ ok: false as const, reason: 'error' as const, message: ADVISOR_MESSAGE, detail });
  try {
    for (const [i, v] of calc.values.entries()) {
      const place = `Cálculo ${i + 1} (${def.values[i].label || v.key})`;
      if (v.formula) {
        scope[v.key] = evalAt(place, v.formula, scope);
        continue;
      }
      const t = v.tiers!;
      const n = numericValue(evalAt(place, t.of, scope));
      if (n === null) return fail(`${place}: el valor para elegir el escalón no es un número`);
      const step = t.steps.find((s) => n < s.below - 1e-9);
      if (step) scope[v.key] = step.value;
      else if (t.otherwise.stop) return { ok: false, reason: 'stop', message: t.otherwise.stop, scope };
      else scope[v.key] = t.otherwise.value!;
    }

    for (const [i, s] of calc.stops.entries()) {
      if (asBool(`Regla para pasar con un asesor ${i + 1}`, evalAt(`Regla para pasar con un asesor ${i + 1}`, s.when, scope))) {
        return { ok: false, reason: 'stop', message: s.message, scope };
      }
    }

    const active = items.filter((it) => it.active);
    const lines: CalculatedLine[] = [];
    for (const [i, l] of calc.lines.entries()) {
      const place = `Concepto ${i + 1} (${l.def.label || l.def.family})`;
      if (l.when && !asBool(`${place}, condición`, evalAt(`${place}, condición`, l.when, scope))) continue;
      const q = numericValue(evalAt(`${place}, cantidad`, l.qty, scope));
      if (q === null) return fail(`${place}: la cantidad no es un número`);
      const qty = Math.round(q * 1000) / 1000;
      if (qty <= 0) continue; // p. ej. «placas» cuando la fijación no las lleva
      if (qty > MAX_QTY) return { ok: false, reason: 'stop', message: ADVISOR_MESSAGE, scope };

      const wanted = l.match.map(([attr, f]) => [attr, evalAt(`${place}, ${attr}`, f, scope)] as [string, Value]);
      const family = normalizeText(l.def.family);
      const found = active.filter((it) => normalizeText(it.family ?? '') === family && wanted.every(([a, w]) => attrMatches(it, a, w)));
      const what = `«${l.def.family}»${wanted.length ? ` con ${wanted.map(([a, w]) => `${a} = ${valueText(w)}`).join(', ')}` : ''}`;
      if (found.length === 0) return { ok: false, reason: 'price', message: ADVISOR_MESSAGE, detail: `Falta en la lista de precios: ${what}`, scope };
      if (found.length > 1) {
        return { ok: false, reason: 'price', message: ADVISOR_MESSAGE, detail: `Hay ${found.length} precios para ${what} (${found.map((f) => f.code).join(', ')}): deja uno o agrega el atributo que los distingue`, scope };
      }
      const item = found[0];
      lines.push({
        price_item_id: item.id,
        code: item.code,
        name: l.def.label ? interpolate(l.def.label, scope).slice(0, 200) : item.name,
        description: item.description,
        unit: item.unit,
        qty,
        price_mode: item.price_mode,
        price_min: item.price_min,
        price_max: item.price_max,
        iva_mode: item.iva_mode,
      });
    }
    if (!lines.length) return fail('Ningún concepto aplica con estos datos');
    if (lines.length > MAX_LINES) return fail(`La cotización admite hasta ${MAX_LINES} conceptos`);
    const priced = priceQuote(lines, settings);
    return { ok: true, lines, priced, scope, kind: def.kind, legend: interpolate(def.legend, scope) };
  } catch (e: any) {
    if (e instanceof CalculatorError) return fail(e.message);
    throw e;
  }
}

/**
 * Las reglas para pasar con un asesor que ya se pueden decidir con datos incompletos: solo los cálculos y reglas cuyas
 * fórmulas usan datos que ya se tienen. El mensaje de la primera que aplique, o `null`.
 */
function earlyStop(calc: CompiledCalculator, known: Record<string, Value>): string | null {
  const scope: Record<string, Value> = { ...known };
  const ready = (f: Compiled) => f.refs.every((r) => r in scope);
  try {
    for (const v of calc.values) {
      if (v.formula) {
        if (ready(v.formula)) scope[v.key] = evaluate(v.formula.ast, scope);
        continue;
      }
      const t = v.tiers!;
      if (!ready(t.of)) continue;
      const n = numericValue(evaluate(t.of.ast, scope));
      if (n === null) continue;
      const step = t.steps.find((s) => n < s.below - 1e-9);
      if (step) scope[v.key] = step.value;
      else if (t.otherwise.stop) return t.otherwise.stop;
      else scope[v.key] = t.otherwise.value!;
    }
    for (const s of calc.stops) {
      if (ready(s.when) && evaluate(s.when.ast, scope) === true) return s.message;
    }
  } catch {
    // Una fórmula que no se puede evaluar aún: se piden los datos que faltan.
  }
  return null;
}

function evalAt(place: string, f: Compiled, scope: Record<string, Value>): Value {
  try { return evaluate(f.ast, scope); } catch (e: any) {
    if (e instanceof FormulaError) throw new CalculatorError(`${place}: ${e.message}`);
    throw e;
  }
}

function asBool(place: string, v: Value): boolean {
  if (typeof v !== 'boolean') throw new CalculatorError(`${place}: la condición debe dar verdadero o falso`);
  return v;
}
