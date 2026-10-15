import { Worker } from 'node:worker_threads';

/**
 * Vigilante del proceso: si se cuelga, sale para que Docker lo reinicie (restart: unless-stopped).
 *
 * - Bucles de trabajo (cola, recepciones, tareas programadas): cada uno marca `tick` al avanzar. Si uno deja de avanzar
 *   más de `stallMs` (por ejemplo, una consulta que nunca regresa), se registra y el proceso sale con código 1.
 * - Bucle de eventos bloqueado: un hilo aparte lo vigila; si el hilo principal no responde en `blockMs`, termina el
 *   proceso con SIGKILL (con `init: true` en docker-compose, node no es el PID 1 y la señal sí lo termina).
 */
const ticks = new Map<string, number>();

export function tick(name: string) {
  ticks.set(name, Date.now());
}

/** Bucles que llevan más de `stallMs` sin avanzar. */
export function stalledLoops(loops: string[], stallMs: number, now = Date.now()): { name: string; ms: number }[] {
  return loops.map((name) => ({ name, ms: now - (ticks.get(name) ?? now) })).filter((l) => l.ms > stallMs);
}

export interface WatchdogOptions {
  loops: string[];
  stallMs: number;
  blockMs: number;
  onStall: (loops: { name: string; ms: number }[]) => Promise<void> | void;
}

export function startWatchdog(o: WatchdogOptions) {
  const started = Date.now();
  for (const name of o.loops) if (!ticks.has(name)) ticks.set(name, started);
  let firing = false;
  const check = setInterval(() => {
    if (firing) return;
    const stalled = stalledLoops(o.loops, o.stallMs);
    if (!stalled.length) return;
    firing = true;
    void Promise.resolve(o.onStall(stalled)).catch(() => undefined);
  }, Math.min(30_000, Math.max(1000, Math.floor(o.stallMs / 4))));
  check.unref();

  // Latido del hilo principal en memoria compartida; el hilo vigilante lo lee aunque el principal esté bloqueado.
  const beat = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(beat, 0, BigInt(Date.now()));
  const pulse = setInterval(() => Atomics.store(beat, 0, BigInt(Date.now())), 1000);
  pulse.unref();
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const beat = new BigInt64Array(workerData.buffer);
    setInterval(() => {
      const idle = Date.now() - Number(Atomics.load(beat, 0));
      if (idle > workerData.blockMs) {
        // Directo al descriptor 2: process.stderr del hilo pasa por el hilo principal, que está bloqueado.
        require('node:fs').writeSync(2, '[vigilante] El proceso dejó de responder ' + Math.round(idle / 1000) + ' s: se termina para que Docker lo reinicie\\n');
        process.kill(process.pid, 'SIGKILL');
      }
    }, 5000);
  `, { eval: true, workerData: { buffer: beat.buffer, blockMs: o.blockMs } });
  worker.unref();
  return {
    stop() {
      clearInterval(check);
      clearInterval(pulse);
      void worker.terminate();
    },
  };
}
