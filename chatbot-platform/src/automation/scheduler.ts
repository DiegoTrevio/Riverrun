import { logEvent } from '../logs.js';
import * as astore from './store.js';
import type { Job } from './store.js';

export type JobHandler = (payload: any, job: Job) => Promise<unknown>;

/**
 * Ejecuta las tareas programadas guardadas en PostgreSQL (sobreviven a reinicios).
 * Reintenta hasta 3 veces con espera creciente.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private handlers: Record<string, JobHandler>) {}

  start(intervalMs: number) {
    void astore.recoverStaleJobs();
    this.timer = setInterval(() => void this.runDue(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ejecuta todo lo vencido (también se usa en las pruebas). */
  async runDue(limit = 50): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      for (;;) {
        const jobs = await astore.claimDueJobs(limit);
        if (!jobs.length) break;
        total += jobs.length;
        for (const job of jobs) await this.execute(job);
        if (jobs.length < limit) break;
      }
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'system', message: `Programador de tareas: ${e?.message ?? e}`, details: e });
    } finally {
      this.running = false;
    }
    return total;
  }

  private async execute(job: Job) {
    const handler = this.handlers[job.type];
    if (!handler) return astore.finishJob(job.id, 'failed', `Tipo de tarea desconocido: ${job.type}`);
    try {
      await handler(job.payload, job);
      await astore.finishJob(job.id, 'done');
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (job.attempts < 3) {
        await astore.retryJob(job.id, new Date(Date.now() + 60_000 * job.attempts * job.attempts), msg);
      } else {
        await astore.finishJob(job.id, 'failed', msg);
        await logEvent({ level: 'error', source: 'system', message: `Tarea ${job.type} falló tras 3 intentos: ${msg}`, accountId: job.account_id, details: job.payload });
      }
    }
  }
}
