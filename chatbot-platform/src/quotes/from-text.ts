/**
 * Cotizador escrito: el negocio escribe sus productos, precios y reglas como texto y la IA lo convierte, una sola vez,
 * en la lista de precios y la calculadora. Las cuentas de cada cotización las sigue haciendo el sistema (determinista):
 * la IA solo traduce las reglas. Todo lo que propone se revisa aquí y se prueba con ejemplos antes de activarse; lo que
 * no pudo expresar se convierte en «pasar con un asesor» y se le dice al negocio.
 */
import { z } from 'zod';
import { HttpError } from '../access.js';
import type { AiProvider, ChatMessage, CompletionResult } from '../ai/provider.js';
import { config } from '../config.js';
import { calculatorProblem, CalculatorDefinition, evaluateCalculator, type CalculatorResult } from './calculator.js';
import { FUNCTION_NAMES } from './formula.js';
import { formatTotals, formatLineAmount, formatQty, formatUnitPrice } from './format.js';
import { MAX_PRICE_CENTS, type IvaMode, type PriceMode } from './pricing.js';
import { priceItemProblem, type PriceItem, type PriceItemInput, type QuoteSettings } from '../store/quotes.js';

export const SOURCE_TEXT_MAX = 20_000;
export const MAX_BUILT_ITEMS = 500;

/* ------------------------------ Lo que devuelve la IA (esquema estricto) ------------------------------ */

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const numOrNull = { type: ['number', 'null'] } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });
const keyValue = obj({ key: str, value: str });

export const BUILDER_SCHEMA = obj({
  summary: { type: 'string', description: 'En 1-3 frases, qué cotiza este negocio y cómo (para que el dueño confirme que se entendió).' },
  price_items: arr(obj({
    code: { type: 'string', description: 'Clave corta y única en MAYÚSCULAS con letras, números o guiones (p. ej. PAN-CL-200-A).' },
    name: { type: 'string', description: 'Nombre del concepto como lo verá el cliente.' },
    unit: { type: 'string', description: 'Unidad: pieza, metro, m², servicio, hora, persona…' },
    family: { type: 'string', description: 'Grupo en minúsculas sin acentos (panel, poste, flete…). Los conceptos de la calculadora buscan su precio por familia y atributos.' },
    attributes: arr(keyValue, 'Atributos que distinguen este precio dentro de su familia (producto, altura, escalon, zona…). Claves en minúsculas con guion bajo; valores tal cual los da la calculadora.'),
    price: { ...numOrNull, description: 'Precio en pesos (sin IVA si el texto no dice lo contrario). null solo si el texto dice que se confirma después.' },
    price_max: { ...numOrNull, description: 'Solo si el precio es un rango: el máximo; si no, null.' },
    price_mode: { type: 'string', enum: ['exact', 'from', 'range', 'tbd'] },
    iva_mode: { type: 'string', enum: ['default', 'plus', 'included', 'exempt'], description: '"default" si el texto no dice nada del IVA de este concepto.' },
  }), 'TODOS los precios del texto. Nunca inventes precios ni completes huecos.'),
  inputs: arr(obj({
    key: { type: 'string', description: 'Clave en minúsculas con guion bajo (p. ej. metros_lineales).' },
    label: str,
    help: { type: 'string', description: 'Cómo preguntarlo o qué aclarar; vacío si no hace falta.' },
    type: { type: 'string', enum: ['number', 'option', 'boolean', 'text'] },
    unit: str,
    min: numOrNull,
    max: numOrNull,
    decimals: { type: 'integer', description: '0 para piezas o personas; 2 para medidas.' },
    options: arr(obj({ value: str, label: str }), 'Solo para type "option": al menos 2.'),
    required: { type: 'boolean', description: 'true si sin este dato no se puede cotizar.' },
    default: { type: 'string', description: 'Para un dato opcional: el valor cuando el cliente no lo dice ("0", "no", el valor de una opción). Vacío si es obligatorio.' },
  }), 'Datos que el asistente le pide al cliente, en el orden en que los pregunta.'),
  values: arr(obj({
    key: str,
    label: str,
    formula: { type: 'string', description: 'Fórmula. Vacía si usas escalones (tiers).' },
    tiers: obj({
      of: { type: 'string', description: 'Fórmula o dato del que dependen los escalones; vacío si no hay escalones.' },
      steps: arr(obj({ below: num, value: str }), 'El escalón aplica si el valor es MENOR que below. De menor a mayor.'),
      otherwise_value: { type: 'string', description: 'Valor desde el último escalón; vacío si en ese caso se pasa con un asesor.' },
      otherwise_stop: { type: 'string', description: 'Mensaje para el cliente si desde el último escalón lo atiende un asesor; vacío si no.' },
    }),
  }), 'Cálculos con nombre, en orden (cada uno puede usar datos y cálculos anteriores).'),
  lines: arr(obj({
    label: { type: 'string', description: 'Nombre en la cotización; puede usar {dato}. Vacío = el nombre de la lista de precios.' },
    family: str,
    match: arr(obj({ attribute: str, formula: str }), 'Atributo del precio → fórmula con el valor que debe tener.'),
    qty: { type: 'string', description: 'Fórmula de la cantidad.' },
    when: { type: 'string', description: 'Condición para que vaya este concepto; vacío = siempre.' },
  }), 'Conceptos de la cotización.'),
  stops: arr(obj({ when: str, message: { type: 'string', description: 'Lo que el asistente le dice al cliente.' } }), 'Casos que atiende un asesor en vez de cotizar.'),
  legend: { type: 'string', description: 'Leyenda de la cotización (aproximada, vigencia, qué no incluye) si el texto la da; si no, vacío.' },
  examples: arr(obj({ description: str, inputs: arr(keyValue) }), '3 o 4 casos de ejemplo con datos válidos y distintos (incluye uno que pase con un asesor si hay reglas para eso).'),
  unclear: arr(str, 'Reglas o precios del texto que no pudiste expresar o que son ambiguos, en palabras del negocio. Vacío si todo quedó claro.'),
});

const KV = z.object({ key: z.string(), value: z.string() });
const BuilderOutput = z.object({
  summary: z.string().catch(''),
  price_items: z.array(z.object({
    code: z.string(), name: z.string(), unit: z.string().catch('pieza'), family: z.string().catch(''),
    attributes: z.array(KV).catch([]), price: z.number().nullable().catch(null), price_max: z.number().nullable().catch(null),
    price_mode: z.enum(['exact', 'from', 'range', 'tbd']).catch('exact'), iva_mode: z.enum(['default', 'plus', 'included', 'exempt']).catch('default'),
  })).catch([]),
  inputs: z.array(z.object({
    key: z.string(), label: z.string(), help: z.string().catch(''), type: z.enum(['number', 'option', 'boolean', 'text']),
    unit: z.string().catch(''), min: z.number().nullable().catch(null), max: z.number().nullable().catch(null),
    decimals: z.number().int().catch(2), options: z.array(z.object({ value: z.string(), label: z.string() })).catch([]),
    required: z.boolean().catch(true), default: z.string().catch(''),
  })).catch([]),
  values: z.array(z.object({
    key: z.string(), label: z.string().catch(''), formula: z.string().catch(''),
    tiers: z.object({ of: z.string().catch(''), steps: z.array(z.object({ below: z.number(), value: z.string() })).catch([]), otherwise_value: z.string().catch(''), otherwise_stop: z.string().catch('') })
      .catch({ of: '', steps: [], otherwise_value: '', otherwise_stop: '' }),
  })).catch([]),
  lines: z.array(z.object({ label: z.string().catch(''), family: z.string(), match: z.array(z.object({ attribute: z.string(), formula: z.string() })).catch([]), qty: z.string(), when: z.string().catch('') })).catch([]),
  stops: z.array(z.object({ when: z.string(), message: z.string() })).catch([]),
  legend: z.string().catch(''),
  examples: z.array(z.object({ description: z.string().catch(''), inputs: z.array(KV).catch([]) })).catch([]),
  unclear: z.array(z.string()).catch([]),
});
export type BuilderOutput = z.infer<typeof BuilderOutput>;

/* ------------------------------ Borrador ------------------------------ */

/** Lo que se activa: precios y calculadora. El servidor lo vuelve a revisar al activarlo. */
export interface QuoteDraft {
  price_items: PriceItemInput[];
  definition: unknown;
}

const slugKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 40);
const cleanCode = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const toCents = (pesos: number | null) => (pesos === null || !Number.isFinite(pesos) ? null : Math.round(pesos * 100));

/** Convierte la salida de la IA en precios (centavos) y una definición de calculadora. */
export function toDraft(out: BuilderOutput, settings: Pick<QuoteSettings, 'prices_include_iva'>): QuoteDraft {
  const defaultIva: IvaMode = settings.prices_include_iva ? 'included' : 'plus';
  const price_items: PriceItemInput[] = out.price_items.map((p, i) => {
    const mode: PriceMode = p.price === null ? 'tbd' : p.price_mode;
    return {
      code: cleanCode(p.code) || `P-${i + 1}`,
      name: p.name.trim().slice(0, 200),
      description: '',
      unit: p.unit.trim().slice(0, 40) || 'pieza',
      family: slugKey(p.family),
      attributes: Object.fromEntries(p.attributes.filter((a) => a.key.trim()).map((a) => [slugKey(a.key), a.value.trim().slice(0, 60)])),
      price_mode: mode,
      price_min: mode === 'tbd' ? null : toCents(p.price),
      price_max: mode === 'range' ? toCents(p.price_max) : null,
      iva_mode: p.iva_mode === 'default' ? defaultIva : p.iva_mode,
      active: true,
      sort: i,
    };
  });
  const definition = {
    inputs: out.inputs.map((d) => {
      const def: Record<string, unknown> = {
        key: slugKey(d.key), label: d.label.trim(), help: d.help.trim(), type: d.type, unit: d.unit.trim(),
        decimals: Math.min(3, Math.max(0, d.decimals)), required: d.required,
        options: d.type === 'option' ? d.options.map((o) => ({ value: o.value.trim(), label: o.label.trim() || o.value.trim() })) : [],
      };
      if (d.min !== null) def.min = d.min;
      if (d.max !== null) def.max = d.max;
      const raw = d.default.trim();
      if (!d.required && raw) {
        if (d.type === 'number') { const n = Number(raw.replace(',', '.')); if (Number.isFinite(n)) def.default = n; }
        else if (d.type === 'boolean') def.default = /^(s[ií]|true|1|yes)$/i.test(raw);
        else def.default = raw;
      } else if (!d.required && d.type === 'number') def.default = 0;
      return def;
    }),
    values: out.values.map((v) => (v.tiers.steps.length
      ? { key: slugKey(v.key), label: v.label.trim(), tiers: { of: v.tiers.of.trim() || v.formula.trim(), steps: v.tiers.steps, otherwise: v.tiers.otherwise_stop.trim() ? { stop: v.tiers.otherwise_stop.trim() } : { value: v.tiers.otherwise_value.trim() } } }
      : { key: slugKey(v.key), label: v.label.trim(), formula: v.formula.trim() })),
    lines: out.lines.map((l) => ({
      label: l.label.trim(), family: slugKey(l.family), qty: l.qty.trim(), when: l.when.trim(),
      match: Object.fromEntries(l.match.filter((m) => m.attribute.trim() && m.formula.trim()).map((m) => [slugKey(m.attribute), m.formula.trim()])),
    })),
    stops: out.stops.filter((s) => s.when.trim()).map((s) => ({ when: s.when.trim(), message: s.message.trim() || 'Uno de nuestros asesores te contacta para cotizarlo.' })),
    legend: out.legend.trim().slice(0, 500),
    kind: 'approximate',
  };
  return { price_items, definition };
}

/** Problemas que impiden activar el borrador (en palabras del negocio). Vacío = se puede activar. */
export function validateDraft(draft: QuoteDraft): string[] {
  const problems: string[] = [];
  const calc = calculatorProblem(draft.definition);
  if (calc) problems.push(`Calculadora: ${calc}`);
  if (!Array.isArray(draft.price_items) || !draft.price_items.length) problems.push('No hay ningún precio: escribe los productos con su precio.');
  const items = Array.isArray(draft.price_items) ? draft.price_items : [];
  if (items.length > MAX_BUILT_ITEMS) problems.push(`Hay ${items.length} precios; el máximo es ${MAX_BUILT_ITEMS}.`);
  const seen = new Set<string>();
  for (const item of items) {
    const p = priceItemProblem(item);
    if (p) problems.push(`Precio «${item?.name || item?.code}»: ${p}`);
    else if ((item.price_min ?? 0) > MAX_PRICE_CENTS) problems.push(`Precio «${item.name}»: es demasiado grande`);
    const key = String(item?.code ?? '').toUpperCase();
    if (seen.has(key)) problems.push(`La clave «${item.code}» está repetida: cada precio necesita una clave distinta.`);
    seen.add(key);
  }
  if (!calc) {
    const families = new Set(items.map((i) => i.family));
    const def = CalculatorDefinition.parse(draft.definition);
    for (const l of def.lines) if (!families.has(l.family)) problems.push(`El concepto «${l.label || l.family}» busca precios de la familia «${l.family}», pero no hay ninguno.`);
  }
  return problems.slice(0, 20);
}

/** Los precios del borrador como si ya estuvieran guardados (para cotizar los ejemplos sin guardar nada). */
export function draftItems(draft: QuoteDraft): PriceItem[] {
  return draft.price_items.map((p, i) => ({ ...p, id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, account_id: '' }));
}

/** Una cotización de ejemplo, lista para mostrar. */
export interface DraftExample {
  description: string;
  inputs: Record<string, string>;
  ok: boolean;
  /** Si no cotiza: por qué (pasa con un asesor, falta un dato o un precio). */
  message?: string;
  detail?: string;
  lines?: { name: string; qty: string; unit_price: string; amount: string }[];
  totals?: { subtotal: string; iva: string; total: string };
  total_cents?: number;
}

export function runExample(definition: unknown, items: PriceItem[], ivaRate: number, currency: string, description: string, inputs: Record<string, unknown>): DraftExample {
  const r: CalculatorResult = evaluateCalculator(definition, inputs, items, { iva_rate: ivaRate });
  const shown = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)]));
  if (!r.ok) return { description, inputs: shown, ok: false, message: r.message, ...('detail' in r ? { detail: r.detail } : {}) };
  return {
    description, inputs: shown, ok: true,
    lines: r.priced.lines.map((l) => ({ name: l.name, qty: formatQty(l.qty), unit_price: formatUnitPrice(l, currency), amount: formatLineAmount(l, currency) })),
    totals: formatTotals(r.priced, currency),
    total_cents: r.priced.total_min,
  };
}

/**
 * Prueba combinaciones de los datos (opciones × un número dentro de cada escalón) y junta los precios que faltan, para
 * que el negocio los complete antes de que un cliente los pida.
 */
export function coverageCheck(definition: unknown, items: PriceItem[], ivaRate: number, limit = 60): string[] {
  let def: CalculatorDefinition;
  try { def = CalculatorDefinition.parse(definition); } catch { return []; }
  const tierPoints = (key: string): number[] => {
    const points = new Set<number>();
    for (const v of def.values) {
      if (!v.tiers || v.tiers.of.trim() !== key) continue;
      let prev = 0;
      for (const s of v.tiers.steps) { points.add(prev + (s.below - prev) / 2); prev = s.below; }
      if (v.tiers.otherwise.value) points.add(prev + 1);
    }
    return [...points];
  };
  const choices = def.inputs.map((d): unknown[] => {
    if (d.type === 'option') return d.options.map((o) => o.value);
    if (d.type === 'boolean') return [false, true];
    if (d.type === 'text') return ['x'];
    const round = (n: number) => (d.decimals ? Math.round(n * 10 ** d.decimals) / 10 ** d.decimals : Math.max(1, Math.round(n)));
    const inRange = (n: number) => (d.min === undefined || n >= d.min) && (d.max === undefined || n <= d.max);
    const pts = tierPoints(d.key).map(round).filter(inRange);
    if (pts.length) return pts;
    // El escalón sale de un cálculo (p. ej. área = largo × ancho): se prueban varios tamaños.
    const sizes = [...new Set([d.min ?? 1, 3, 10, 40].map(round))].filter(inRange);
    return sizes.length ? sizes : [d.min ?? 10];
  });
  const total = choices.reduce((n, c) => n * Math.max(1, c.length), 1);
  const step = Math.max(1, Math.floor(total / limit));
  const missing = new Set<string>();
  for (let idx = 0, tried = 0; idx < total && tried < limit; idx += step, tried++) {
    let rest = idx;
    const inputs: Record<string, unknown> = {};
    def.inputs.forEach((d, i) => { const c = choices[i]; inputs[d.key] = c[rest % c.length]; rest = Math.floor(rest / c.length); });
    const r = evaluateCalculator(def, inputs, items, { iva_rate: ivaRate });
    if (!r.ok && (r.reason === 'price' || r.reason === 'error')) missing.add(r.detail);
    if (missing.size >= 10) break;
  }
  return [...missing];
}

/* ------------------------------ La IA ------------------------------ */

const SYSTEM = `Conviertes las reglas de cotización que escribe un negocio en una configuración que un sistema ejecuta de forma exacta. Tú NO cotizas: describes cómo cotizar. El sistema calcula cada cotización con esto.

Bloques:
1. price_items: la lista de precios. Cada precio del texto es un concepto con su familia (grupo, p. ej. "panel") y atributos que lo distinguen (p. ej. producto=clasica, altura=2, escalon=B). Precios en pesos, tal cual el texto. Nunca inventes un precio ni completes uno que falta.
2. inputs: los datos que el asistente le pide al cliente (medidas, opciones, sí/no). Solo lo necesario para cotizar. Las opciones llevan value corto (sin acentos) y label como lo dice el negocio.
3. values: cálculos con nombre (cantidades derivadas) o escalones (tiers) según un valor: el escalón aplica si el valor es MENOR que below; otherwise_value desde el último, u otherwise_stop si ahí lo atiende un asesor.
4. lines: conceptos de la cotización. Cada uno busca su precio por family + match (atributo → fórmula cuyo resultado debe ser igual al atributo del precio), con qty (fórmula) y when (condición, vacío = siempre).
5. stops: casos que el texto dice que atiende un asesor (when = condición).

Fórmulas: números, textos entre comillas simples ('placa'), datos y cálculos por su key, + - * /, paréntesis, comparaciones == != < <= > >=, y / o / no, si(condición, a, b), condición ? a : b, y las funciones ${FUNCTION_NAMES.join(', ')} (redondear_arriba(x) sube al entero; redondear_arriba(x, 0.5) al múltiplo; redondear(x, 2) a 2 decimales). Una opción con value numérico ("2", "1.5") se compara como número. No existe "=" sola: usa "==".

Ejemplo (otro negocio). Texto: «Pintura por m²: pide largo, ancho y acabado (mate o satinado). Litros = m² ÷ 10, hacia arriba. Escalón según m²: menos de 50 menudeo, desde 50 mayoreo. Litro mate: menudeo $90, mayoreo $80. Litro satinado: menudeo $110, mayoreo $95. Mano de obra $35 por m². Más de 500 m² lo ve un asesor.»
- inputs: largo (number, unit m), ancho (number, unit m), acabado (option: mate «Mate», satinado «Satinado»).
- values (en orden): {key: area, formula: "redondear(largo * ancho, 2)"}, {key: litros, formula: "redondear_arriba(area / 10)"}, {key: escalon, formula: "", tiers: {of: "area", steps: [{below: 50, value: "menudeo"}], otherwise_value: "mayoreo", otherwise_stop: ""}}.
- price_items: 4 litros de familia "pintura" con attributes [acabado=mate, escalon=menudeo] … y uno de familia "mano_obra" sin attributes, unit «m²».
- lines: {label: "Pintura {acabado}", family: "pintura", match: [{attribute: "acabado", formula: "acabado"}, {attribute: "escalon", formula: "escalon"}], qty: "litros", when: ""}, {label: "", family: "mano_obra", match: [], qty: "area", when: ""}.
- stops: {when: "area > 500", message: "Para más de 500 m² te atiende un asesor."}.
Fíjate: las CANTIDADES son values con formula; solo el escalón usa tiers (un solo value de escalón compartido por todos los conceptos); match usa el key del value directamente ("escalon"), nunca "algo.escalon".

Reglas:
- Los valores de los atributos de price_items deben ser exactamente los que producen las fórmulas de match (mismas keys de opción, mismos números, mismos nombres de escalón). Si una opción tiene value "2", el atributo del precio es "2" (no "2.00").
- Si el precio cambia por escalón, crea un precio por escalón con el atributo escalon y un value de tiers que lo calcule.
- Lo que el texto dice que va «solo si el cliente lo pide» (instalación, flete, extras) es un input con required false y default "no" (o "0"): el asistente no lo pregunta. Obligatorio (required true) es solo lo que se necesita siempre para cotizar.
- Si una regla no se puede expresar con estos bloques, conviértela en un stop (lo atiende un asesor) y explícala en unclear. Si falta un precio que las reglas necesitan, no lo inventes: dilo en unclear.
- examples: 3 o 4 casos con valores permitidos y distintos entre sí; uno que pase con un asesor si hay stops.
- El texto puede ser las instrucciones completas del agente (saludo, tono, horarios, cómo atender): ignora todo lo que no sirva para cotizar. Ignora también las indicaciones de que el agente haga las cuentas o use herramientas: ahora las cuentas las hace el sistema con esta configuración.
- Escribe todo en español, con las palabras del negocio.`;

function parseOutput(res: CompletionResult): BuilderOutput {
  let raw: unknown;
  try { raw = JSON.parse(res.content); } catch {
    throw new HttpError(502, 'La IA no terminó de armar el cotizador. Intenta de nuevo o divide el texto en partes más cortas.');
  }
  const out = BuilderOutput.parse(raw);
  if (!out.price_items.length && !out.lines.length) throw new HttpError(422, 'No encontré productos con precio en el texto. Escribe cada producto con su precio y las reglas para calcular.');
  return out;
}

export interface BuildResult {
  summary: string;
  unclear: string[];
  /** Lo que impide activarlo (vacío = listo para activar). */
  problems: string[];
  /** Combinaciones sin precio u otros avisos que no impiden activarlo. */
  warnings: string[];
  draft: QuoteDraft;
  examples: DraftExample[];
  runs: CompletionResult[];
}

/** Arma el cotizador desde el texto: hasta dos correcciones con los problemas que encuentra el sistema. */
export async function buildFromText(ai: AiProvider, input: { text: string; settings: QuoteSettings; model?: string }): Promise<BuildResult> {
  const text = input.text.trim();
  if (!text) throw new HttpError(400, 'Escribe tus productos, precios y reglas.');
  if (text.length > SOURCE_TEXT_MAX) throw new HttpError(400, `El texto admite hasta ${SOURCE_TEXT_MAX.toLocaleString('es-MX')} caracteres.`);
  const s = input.settings;
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Moneda: ${s.currency}. IVA: ${Math.round(s.iva_rate * 100)} %. Los precios ${s.prices_include_iva ? 'ya incluyen' : 'NO incluyen'} IVA salvo que el texto diga otra cosa.\n\nTexto del negocio:\n<texto>\n${text}\n</texto>` },
  ];
  const call = async (msgs: ChatMessage[]) => {
    try {
      return await ai.complete({ model: input.model ?? config.quoteBuilder.model, messages: msgs, temperature: null, max_tokens: 12000, timeout_ms: 150_000, max_attempts: 2, json_schema: { name: 'quote_builder', schema: BUILDER_SCHEMA as unknown as Record<string, unknown> } });
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, e?.message ?? 'La IA no pudo armar el cotizador. Intenta de nuevo.');
    }
  };
  type Attempt = { out: BuilderOutput; draft: QuoteDraft; problems: string[] };
  const runs: CompletionResult[] = [];
  let best: Attempt | null = null;
  let history = messages;
  let lastError: unknown = null;
  // Primera versión y hasta dos correcciones con los problemas que encuentra el sistema; se queda la que tenga menos.
  for (let round = 0; round < 3; round++) {
    let res: CompletionResult;
    let attempt: Attempt;
    try {
      res = await call(history);
      runs.push(res);
      const out = parseOutput(res);
      const draft = toDraft(out, s);
      attempt = { out, draft, problems: validateDraft(draft) };
    } catch (e) {
      lastError = e;
      if (best) break;
      continue;
    }
    if (!best || attempt.problems.length < best.problems.length) best = attempt;
    if (!attempt.problems.length) break;
    history = [...messages, { role: 'assistant', content: res.content }, {
      role: 'user',
      content: `Al revisar la configuración el sistema encontró esto:\n${attempt.problems.map((p) => `- ${p}`).join('\n')}\n\nCorrígelo siguiendo las reglas y devuelve la configuración completa.`,
    }];
  }
  if (!best) {
    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(502, 'La IA no terminó de armar el cotizador. Intenta de nuevo.');
  }
  const chosen: Attempt = best;
  const items = draftItems(chosen.draft);
  const ready = !chosen.problems.length;
  const examples = ready ? chosen.out.examples.slice(0, 5).map((ex) =>
    runExample(chosen.draft.definition, items, s.iva_rate, s.currency, ex.description.trim(), Object.fromEntries(ex.inputs.map((kv) => [slugKey(kv.key), kv.value])))) : [];
  return {
    summary: chosen.out.summary.trim().slice(0, 600),
    unclear: chosen.out.unclear.map((u) => u.trim()).filter(Boolean).slice(0, 10),
    problems: chosen.problems,
    warnings: ready ? coverageCheck(chosen.draft.definition, items, s.iva_rate) : [],
    draft: chosen.draft,
    examples,
    runs,
  };
}
