import { logEvent } from '../logs.js';
import * as astore from './store.js';
import type { Job } from './store.js';
import { assertOwnership, coordinated, DeliveryUncertain, interruptedOperation, operationScope } from '../engine/coordination.js';

export type JobHandler = (payload: any, job: Job) => Promise<unknown>;

/**
 * Ejecuta las tareas programadas guardadas en PostgreSQL (sobreviven a reinicios).
 * Reintenta hasta 3 veces con espera creciente.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private closing = false;
  private draining?: Promise<number>;

  constructor(private handlers: Record<string, JobHandler>) {}

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
      for (let i=0; i<limit && !this.closing; i++) {
        await assertOwnership();
        const jobs = await astore.claimDueJobs(1);
        if (!jobs.length) break;
        total += jobs.length;
        for (const job of jobs) await operationScope(`job:${job.id}`,()=>this.execute(job));
      }
      });
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
      await handler(job.payload, job);
      await astore.finishJob(job.id, 'done');
    } catch (e: any) {
      const msg = e instanceof DeliveryUncertain ? 'delivery_uncertain' : 'job_execution_failed';
      if (!(e instanceof DeliveryUncertain) && job.attempts < 3) {
        await astore.retryJob(job.id, new Date(Date.now() + 60_000 * 2 ** (job.attempts-1)), msg);
      } else {
        await astore.finishJob(job.id, 'failed', msg);
        await logEvent({ level: 'error', source: 'system', message: 'job_failed', accountId: job.account_id, details: {type:job.type,reason:msg,job_id:job.id} });
      }
    }
  }
}
