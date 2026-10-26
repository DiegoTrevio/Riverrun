import { config } from '../config.js';
import { logEvent } from '../logs.js';
import { tick } from '../watchdog.js';
import * as astore from './store.js';
import type { Job } from './store.js';
import { assertOwnership, coordinated, DeliveryUncertain, interruptedOperation, operationScope } from '../engine/coordination.js';

export type JobHandler = (payload: any, job: Job) => Promise<unknown>;

class JobTimeout extends Error { constructor() { super('job_timeout'); } }

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JobTimeout()), ms); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Ejecuta las tareas programadas guardadas en PostgreSQL (sobreviven a reinicios).
 * Reintenta hasta 3 veces con espera creciente.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private closing = false;
  private draining?: Promise<number>;

  constructor(private handlers: Record<string, JobHandler>,private settle?:()=>Promise<void>) {}

  start(intervalMs: number) {
    this.timer = setInterval(() => void this.runDue(), intervalMs);
    this.timer.unref();
  }

  async stop() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining;
  }

  /** Ejecuta todo lo vencido (también se usa en las pruebas). */
  async runDue(limit = 50): Promise<number> {
    if (this.running || this.closing) return 0;
    this.draining = this.drain(limit);
    return this.draining;
  }

  private async drain(limit: number): Promise<number> {
    this.running = true;
    let total = 0;
    try {
      const result=await coordinated('scheduler','scheduler',async()=>{
      await astore.recoverStaleJobs();
      tick('scheduler');
      for (let i=0; i<limit && !this.closing; i++) {
        await assertOwnership();
        const jobs = await astore.claimDueJobs(1);
        if (!jobs.length) break;
        total += jobs.length;
        for (const job of jobs) { await operationScope(`job:${job.id}:attempt:${job.attempts}`,()=>this.execute(job)); tick('scheduler'); }
      }
      });
      tick('scheduler');
      if(!result.acquired) return 0;
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'system', message: 'scheduler_error',details:{reason:'database_or_execution'} }).catch(()=>undefined);
    } finally {
      this.running = false;
    }
    return total;
  }

  private async execute(job: Job) {
    const handler = this.handlers[job.type];
    if (!handler) return astore.finishJob(job.id, 'failed', `Tipo de tarea desconocido: ${job.type}`);
    try {
      await assertOwnership();
      if(await interruptedOperation(`job:${job.id}`)) throw new DeliveryUncertain();
      // Una tarea colgada no detiene a las demás: se corta y se reintenta. Si alcanzó a enviar algo, el reintento lo
      // detecta (operación interrumpida) y no lo duplica; la tarea original pierde el permiso al cerrarse la sesión.
      await withTimeout(handler(job.payload, job), config.jobTimeoutMs);
      await this.settle?.();
      await astore.finishJob(job.id, 'done');
    } catch (e: any) {
      const code = e instanceof DeliveryUncertain ? 'delivery_uncertain' : e instanceof JobTimeout ? 'job_timeout' : 'job_execution_failed';
      // El mensaje del error queda en la tarea y en la bitácora: sin él no hay forma de saber qué falló.
      const error = String(e?.message ?? e ?? '').slice(0, 500);
      const msg = code === 'job_execution_failed' && error ? `${code}: ${error}` : code;
      if (!(e instanceof DeliveryUncertain) && job.attempts < 3) {
        await astore.retryJob(job.id, new Date(Date.now() + 60_000 * 2 ** (job.attempts-1)), msg);
      } else {
        await astore.finishJob(job.id, 'failed', msg);
        await logEvent({ level: 'error', source: 'system', message: 'job_failed', accountId: job.account_id, details: {type:job.type,reason:code,error,job_id:job.id} });
      }
    }
  }
}
