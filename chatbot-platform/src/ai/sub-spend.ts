/**
 * AI-9: lo que gastan en IA las llamadas que hace otra (el Copiloto edita instrucciones, diseña un flujo, importa…) cuenta
 * para el tope de quien las hizo. Quien llama abre un ámbito; cada llamada de IA que se liquida dentro de él (también en
 * las rutas que se llaman por `inject`, que corren en el mismo contexto asíncrono) suma su costo.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SubSpend { usd: number; calls: number }
const scope = new AsyncLocalStorage<SubSpend>();

export const trackSubSpend = <T>(acc: SubSpend, fn: () => Promise<T>): Promise<T> => scope.run(acc, fn);

/** Lo llama la liquidación de cada llamada de IA (`accountAi`). */
export function recordSubSpend(usd: number | null) {
  const acc = scope.getStore();
  if (!acc) return;
  acc.calls++;
  if (usd !== null && Number.isFinite(usd) && usd > 0) acc.usd += usd;
}
