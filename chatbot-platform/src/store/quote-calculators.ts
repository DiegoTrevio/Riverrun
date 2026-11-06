/**
 * Calculadoras de cotización de cada cuenta. La definición se revisa entera antes de guardarse (`calculatorProblem`) y su
 * versión sube con cada cambio: la cotización guarda con cuál salió. Todo se consulta con la cuenta.
 */
import type { PoolClient } from 'pg';
import { query, queryOne } from '../db.js';
import { CalculatorDefinition, calculatorProblem } from '../quotes/calculator.js';

export interface QuoteCalculator {
  id: string;
  account_id: string;
  name: string;
  description: string;
  template_key: string;
  definition: CalculatorDefinition;
  version: number;
  active: boolean;
  /** Texto de productos, precios y reglas del que salió (cotizador escrito); vacío si se armó a mano. */
  source_text: string;
  created_at: Date;
  updated_at: Date;
}

export interface CalculatorInput {
  name: string;
  description?: string;
  template_key?: string;
  definition: unknown;
  active?: boolean;
}

/** Tope por cuenta: una calculadora por giro o línea de producto es lo normal. */
export const MAX_CALCULATORS_PER_ACCOUNT = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inputProblem(i: CalculatorInput): string | null {
  if (typeof i.name !== 'string' || !i.name.trim() || i.name.length > 120) return 'Escribe el nombre de la calculadora (hasta 120 caracteres)';
  if (i.description !== undefined && (typeof i.description !== 'string' || i.description.length > 500)) return 'La descripción admite hasta 500 caracteres';
  return calculatorProblem(i.definition);
}

/** La definición ya revisada, con sus valores por omisión puestos. */
const normalized = (definition: unknown) => CalculatorDefinition.parse(definition);

export async function listCalculators(accountId: string): Promise<QuoteCalculator[]> {
  return query<QuoteCalculator>('SELECT * FROM quote_calculators WHERE account_id = $1 ORDER BY name, created_at', [accountId]);
}

export async function getCalculator(accountId: string, id: string): Promise<QuoteCalculator | null> {
  if (!UUID.test(id)) return null;
  return queryOne<QuoteCalculator>('SELECT * FROM quote_calculators WHERE account_id = $1 AND id = $2', [accountId, id]);
}

/** Solo por id (la ruta luego verifica que sea de la cuenta de quien pregunta). */
export async function findCalculator(id: string): Promise<QuoteCalculator | null> {
  if (!UUID.test(id)) return null;
  return queryOne<QuoteCalculator>('SELECT * FROM quote_calculators WHERE id = $1', [id]);
}

export async function createCalculator(accountId: string, input: CalculatorInput): Promise<QuoteCalculator> {
  const problem = inputProblem(input);
  if (problem) throw new Error(problem);
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM quote_calculators WHERE account_id = $1', [accountId]);
  if (n >= MAX_CALCULATORS_PER_ACCOUNT) throw new Error(`Una cuenta admite hasta ${MAX_CALCULATORS_PER_ACCOUNT} calculadoras`);
  return (await queryOne<QuoteCalculator>(
    `INSERT INTO quote_calculators (account_id, name, description, template_key, definition, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [accountId, input.name.trim(), input.description?.trim() ?? '', input.template_key ?? '', JSON.stringify(normalized(input.definition)), input.active ?? true],
  ))!;
}

/** Cambia la calculadora; la versión sube solo si cambió la definición. */
export async function updateCalculator(accountId: string, id: string, input: CalculatorInput): Promise<QuoteCalculator | null> {
  const problem = inputProblem(input);
  if (problem) throw new Error(problem);
  return queryOne<QuoteCalculator>(
    `UPDATE quote_calculators
        SET name = $3, description = $4, active = $5,
            version = version + CASE WHEN definition = $6::jsonb THEN 0 ELSE 1 END,
            definition = $6::jsonb, updated_at = now()
      WHERE account_id = $1 AND id = $2 RETURNING *`,
    [accountId, id, input.name.trim(), input.description?.trim() ?? '', input.active ?? true, JSON.stringify(normalized(input.definition))],
  );
}

/**
 * Guarda el cotizador escrito dentro de una transacción: actualiza la calculadora del agente si salió de un texto (una
 * armada a mano no se pisa) o crea una nueva, con el texto del que salió. La versión sube solo si cambió la definición.
 */
export async function saveFromText(client: PoolClient, accountId: string, o: { calculatorId: string | null; name: string; text: string; definition: unknown }): Promise<QuoteCalculator> {
  const problem = calculatorProblem(o.definition);
  if (problem) throw new Error(problem);
  const definition = JSON.stringify(normalized(o.definition));
  if (o.calculatorId && UUID.test(o.calculatorId)) {
    const { rows } = await client.query<QuoteCalculator>(
      `UPDATE quote_calculators
          SET source_text = $3, active = true,
              version = version + CASE WHEN definition = $4::jsonb THEN 0 ELSE 1 END,
              definition = $4::jsonb, updated_at = now()
        WHERE account_id = $1 AND id = $2 AND template_key = 'texto' RETURNING *`,
      [accountId, o.calculatorId, o.text, definition],
    );
    if (rows[0]) return rows[0];
  }
  const { rows: [{ n }] } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM quote_calculators WHERE account_id = $1', [accountId]);
  if (n >= MAX_CALCULATORS_PER_ACCOUNT) throw new Error(`Una cuenta admite hasta ${MAX_CALCULATORS_PER_ACCOUNT} calculadoras`);
  const { rows } = await client.query<QuoteCalculator>(
    `INSERT INTO quote_calculators (account_id, name, description, template_key, definition, active, source_text)
     VALUES ($1, $2, '', 'texto', $3, true, $4) RETURNING *`,
    [accountId, o.name.trim().slice(0, 120), definition, o.text],
  );
  return rows[0];
}

/** Borrarla no altera las cotizaciones hechas: guardan sus conceptos y sus datos. */
export async function deleteCalculator(accountId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  return (await query('DELETE FROM quote_calculators WHERE account_id = $1 AND id = $2 RETURNING id', [accountId, id])).length > 0;
}

/** Para exportar o copiar a otra cuenta: solo lo que define la calculadora, sin ids ni fechas. */
export const portable = (c: QuoteCalculator) => ({
  format: 'riverrun.quote-calculator',
  version: 1,
  name: c.name,
  description: c.description,
  template_key: c.template_key,
  definition: c.definition,
});
