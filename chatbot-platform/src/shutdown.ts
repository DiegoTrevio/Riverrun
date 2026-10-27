/**
 * Apagado ordenado con plazo: corre los pasos en orden (terminar lo que está en curso, cerrar la base) y sale con 0. Si un
 * paso falla o el plazo se vence, sale con 1 y dice qué faltó: nunca se queda colgado hasta que Docker lo mate. Una
 * segunda señal mientras se apaga solo lo avisa.
 */
export interface ShutdownStep { name: string; run: () => Promise<unknown> | unknown }

export function gracefulShutdown(o: { steps: ShutdownStep[]; timeoutMs: number; exit: (code: number) => void; log?: (msg: string) => void }) {
  const log = o.log ?? ((m: string) => console.log(m));
  let running = false;
  const shutdown = async (signal = 'SIGTERM') => {
    if (running) {
      log(`Ya se está cerrando (${signal} ignorado).`);
      return;
    }
    running = true;
    log(`Cerrando (${signal})...`);
    let current = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`El cierre tardó más de ${Math.round(o.timeoutMs / 1000)} s (pendiente: ${current || 'desconocido'}): se sale sin terminar.`);
      o.exit(1);
    }, o.timeoutMs);
    let code = 0;
    for (const step of o.steps) {
      current = step.name;
      try {
        await step.run();
      } catch (e: any) {
        log(`Error al cerrar ${step.name}: ${e?.message ?? e}`);
        code = 1;
      }
    }
    clearTimeout(timer);
    if (!timedOut) o.exit(code);
  };
  /** Ya empezó a cerrarse: quien sigue arrancando debe detenerse. */
  return Object.assign(shutdown, { get started() { return running; } });
}
