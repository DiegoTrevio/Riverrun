/**
 * Cálculo de una cotización. Función pura y en centavos enteros: los montos que ve el cliente salen siempre de aquí, nunca
 * de la IA. Cada concepto tiene un modo de precio (exacto, «desde», rango o por confirmar) y uno de IVA (se suma, ya viene
 * incluido o está exento); el resultado da un total mínimo y uno máximo, que coinciden cuando todo es exacto.
 */

export type PriceMode = 'exact' | 'from' | 'range' | 'tbd';
export type IvaMode = 'plus' | 'included' | 'exempt';

export const PRICE_MODES: readonly PriceMode[] = ['exact', 'from', 'range', 'tbd'];
export const IVA_MODES: readonly IvaMode[] = ['plus', 'included', 'exempt'];

/** Precio más alto aceptado por concepto (10 mil millones en centavos): mantiene las cuentas dentro de lo exacto. */
export const MAX_PRICE_CENTS = 1_000_000_000_000;
export const MAX_QTY = 10_000;
export const MAX_LINES = 100;

export interface LineInput {
  code?: string;
  name: string;
  description?: string;
  unit?: string;
  qty: number;
  price_mode: PriceMode;
  /** Centavos. Exacto y «desde» usan solo el mínimo; rango usa ambos; por confirmar, ninguno. */
  price_min: number | null;
  price_max: number | null;
  iva_mode: IvaMode;
}

export interface PricedLine extends LineInput {
  /** Importe antes de IVA (para «incluido», ya sin el IVA). `null` cuando el precio está por confirmar. */
  amount_min: number | null;
  amount_max: number | null;
}

export interface PricedQuote {
  lines: PricedLine[];
  subtotal_min: number;
  subtotal_max: number;
  iva_min: number;
  iva_max: number;
  total_min: number;
  total_max: number;
  /** Algún concepto es «desde»: el total no tiene tope. */
  open_ended: boolean;
  /** Algún concepto no tiene precio todavía. */
  has_tbd: boolean;
  /** Puede ser cotización final: hay conceptos y todos tienen precio exacto. */
  can_be_final: boolean;
}

export interface PricingSettings {
  /** Tasa de IVA, p. ej. 0.16. */
  iva_rate: number;
}

/** Revisa que un concepto sea coherente; devuelve el problema en palabras para el negocio o `null`. */
export function lineProblem(l: Pick<LineInput, 'qty' | 'price_mode' | 'price_min' | 'price_max' | 'iva_mode'>): string | null {
  if (!PRICE_MODES.includes(l.price_mode)) return 'Tipo de precio no válido';
  if (!IVA_MODES.includes(l.iva_mode)) return 'Tipo de IVA no válido';
  if (!Number.isFinite(l.qty) || l.qty <= 0 || l.qty > MAX_QTY) return `La cantidad debe ser mayor que 0 y hasta ${MAX_QTY}`;
  if (Math.round(l.qty * 1000) / 1000 !== l.qty) return 'La cantidad admite hasta 3 decimales';
  const ok = (v: number | null) => v !== null && Number.isSafeInteger(v) && v >= 0 && v <= MAX_PRICE_CENTS;
  switch (l.price_mode) {
    case 'tbd':
      return l.price_min === null && l.price_max === null ? null : 'Un precio por confirmar no lleva monto';
    case 'exact':
    case 'from':
      return ok(l.price_min) && l.price_max === null ? null : 'Falta el precio';
    case 'range':
      if (!ok(l.price_min) || !ok(l.price_max)) return 'Faltan el precio mínimo y el máximo';
      return l.price_min! < l.price_max! ? null : 'El precio mínimo debe ser menor que el máximo';
  }
}

/** precio × cantidad, redondeado al centavo (mitad hacia arriba). La cantidad admite 3 decimales. */
function times(priceCents: number, qty: number): bigint {
  const milli = BigInt(Math.round(qty * 1000));
  return (BigInt(priceCents) * milli + 500n) / 1000n;
}

const basisPoints = (rate: number) => BigInt(Math.round(rate * 10000));

/** Precio sin IVA de un precio que ya lo incluye, redondeado al centavo (mitad hacia arriba). */
function withoutIva(priceCents: bigint, rateBp: bigint): bigint {
  return (priceCents * 10000n + (10000n + rateBp) / 2n) / (10000n + rateBp);
}

/**
 * Precio unitario antes de IVA, el que se muestra en el desglose: para «IVA incluido» es el precio de lista sin su IVA;
 * para los demás, el mismo precio. Así cantidad × precio unitario = importe en cada renglón.
 */
export function unitBeforeIva(priceCents: number, mode: IvaMode, rate: number): number {
  const rateBp = basisPoints(rate);
  if (mode !== 'included' || rateBp === 0n) return priceCents;
  return Number(withoutIva(BigInt(priceCents), rateBp));
}

/**
 * Importe y su IVA de un renglón. Con «IVA incluido» el importe es cantidad × precio unitario sin IVA (lo que ve el
 * cliente en el renglón) y el IVA es lo que falta para llegar a cantidad × precio de lista: el total siempre es el precio
 * escrito y cada renglón cuadra.
 */
function lineAmounts(priceCents: number, qty: number, mode: IvaMode, rateBp: bigint): { base: bigint; iva: bigint } {
  const gross = times(priceCents, qty);
  if (mode === 'exempt' || mode === 'plus' || rateBp === 0n) return { base: gross, iva: 0n };
  const base = times(Number(withoutIva(BigInt(priceCents), rateBp)), qty);
  return { base, iva: gross - base };
}

export function priceQuote(input: LineInput[], settings: PricingSettings): PricedQuote {
  if (input.length > MAX_LINES) throw new Error(`Una cotización admite hasta ${MAX_LINES} conceptos`);
  const rateBp = basisPoints(settings.iva_rate);
  let subMin = 0n, subMax = 0n, ivaMin = 0n, ivaMax = 0n;
  // Los conceptos que «suman IVA» se juntan y el IVA se calcula una vez sobre su suma (subtotal × tasa, redondeado al
  // centavo), como lo escribe el negocio. Redondear el IVA de cada renglón y sumarlo podía dar un centavo de diferencia.
  let plusMin = 0n, plusMax = 0n;
  let openEnded = false, hasTbd = false;
  const lines: PricedLine[] = input.map((l) => {
    const problem = lineProblem(l);
    if (problem) throw new Error(`${l.name}: ${problem}`);
    if (l.price_mode === 'tbd') {
      hasTbd = true;
      return { ...l, amount_min: null, amount_max: null };
    }
    if (l.price_mode === 'from') openEnded = true;
    const lo = lineAmounts(l.price_min!, l.qty, l.iva_mode, rateBp);
    const hi = l.price_mode === 'range' ? lineAmounts(l.price_max!, l.qty, l.iva_mode, rateBp) : lo;
    subMin += lo.base;
    subMax += hi.base;
    if (l.iva_mode === 'plus') {
      plusMin += lo.base;
      plusMax += hi.base;
    } else {
      ivaMin += lo.iva;
      ivaMax += hi.iva;
    }
    return { ...l, amount_min: Number(lo.base), amount_max: Number(hi.base) };
  });
  ivaMin += (plusMin * rateBp + 5000n) / 10000n;
  ivaMax += (plusMax * rateBp + 5000n) / 10000n;
  return {
    lines,
    subtotal_min: Number(subMin),
    subtotal_max: Number(subMax),
    iva_min: Number(ivaMin),
    iva_max: Number(ivaMax),
    total_min: Number(subMin + ivaMin),
    total_max: Number(subMax + ivaMax),
    open_ended: openEnded,
    has_tbd: hasTbd,
    can_be_final: lines.length > 0 && lines.every((l) => l.price_mode === 'exact'),
  };
}
