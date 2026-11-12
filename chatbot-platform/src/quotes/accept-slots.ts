import { HttpError } from '../access.js';

/**
 * Cuántas aceptaciones de cotización corren a la vez en este proceso. Cada una retiene una conexión de la base para su
 * candado mientras usa otras para crear los cobros: sin tope, unas cuantas aceptaciones simultáneas (de cualquier
 * cuenta) se quedaban con todas las conexiones y la plataforma entera esperaba a la base hasta 30 s.
 */
export const MAX_CONCURRENT_ACCEPTS = 2;
let running = 0;

export async function withAcceptSlot<T>(fn: () => Promise<T>, max = MAX_CONCURRENT_ACCEPTS): Promise<T> {
  if (running >= max) throw new HttpError(429, 'Se están aceptando otras cotizaciones en este momento. Intenta de nuevo en unos segundos.');
  running++;
  try {
    return await fn();
  } finally {
    running--;
  }
}
